/** Local production preview with the real Go auth/API, never a deployed server. */
import { createServer as createHTTPS } from 'node:https';
import { request as requestHTTP, get } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, realpath, lstat, cp } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultFixture = (port = 4443) => `/tmp/asher-blog-private-${process.getuid?.() ?? 'user'}-${port}.json`;

/** Local browser sessions represent independent clients while retaining Go's real per-IP limits. */
export function localClientAddress(cookieHeader, fallback = '127.0.0.1') {
  const token = typeof cookieHeader === 'string' ? cookieHeader.match(/(?:^|;\s*)__Host-asher_session=([^;]+)/)?.[1] : undefined;
  if (!token) return fallback;
  const address = 'fd' + createHash('sha256').update(token).digest('hex').slice(0, 30);
  return address.match(/.{4}/g).join(':');
}

async function availablePort() {
  const server = createTCPServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = server.address().port;
  await new Promise(yes => server.close(yes));
  return port;
}

export async function readLocalCredentials(origin, fixture = process.env.BLOG_TEST_LOCAL_FIXTURE) {
  if (!fixture || !fixture.startsWith('/tmp/')) throw new Error('Local QA fixture must be in /tmp.');
  const stat = await lstat(fixture);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Local QA fixture permissions are invalid.');
  const value = JSON.parse(await readFile(fixture, 'utf8'));
  if (value.origin !== origin || new URL(origin).protocol !== 'https:' || new URL(origin).hostname !== '127.0.0.1' ||
      typeof value.username !== 'string' || typeof value.password !== 'string') throw new Error('Local QA fixture origin is invalid.');
  return value;
}

export async function startPrivateServer(options = {}) {
  const port = Number(options.port ?? process.env.BLOG_TEST_LOCAL_PORT ?? 4443);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local HTTPS port.');
  const origin = `https://127.0.0.1:${port}`;
  const fixture = options.fixture ?? process.env.BLOG_TEST_LOCAL_FIXTURE ?? defaultFixture(port);
  if (!fixture.startsWith('/tmp/') || await realpath(dirname(fixture)) !== await realpath('/tmp')) throw new Error('Local fixture must be directly inside /tmp.');
  const temporary = await mkdtemp('/tmp/asher-blog-private-');
  const children = [];
  let server;
  let stopping;
  let ownsFixture = false;
  const stop = () => stopping ??= (async () => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await Promise.all(children.map(child => new Promise(done => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', done); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
    })));
    if (ownsFixture) await rm(fixture, { force: true });
    await rm(temporary, { recursive: true, force: true });
  })();
  const onSignal = async () => { await stop(); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
  const launch = (command, args, env = {}) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Do not pipe child logs or request details into test artifacts.
    child.once('error', () => {});
    child.stdout.resume(); child.stderr.resume(); children.push(child);
    return child;
  };
  const waitReady = async (address, child) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Local QA upstream failed to start.');
      const ready = await new Promise(done => { const req = get(address, response => { response.resume(); done(true); }); req.once('error', () => done(false)); req.setTimeout(1000, () => req.destroy()); });
      if (ready) return;
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error('Local QA upstream startup timed out.');
  };
  try {
    const username = `qa-${randomBytes(12).toString('hex')}`;
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(32);
    await writeFile(join(temporary, 'auth.json'), JSON.stringify({ origin, username, salt: salt.toString('base64'), password_hash: pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64'), iterations: 600000 }), { mode: 0o600 });
    await writeFile(fixture, JSON.stringify({ origin, username, password }), { mode: 0o600, flag: 'wx' });
    ownsFixture = true;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const authPort = await availablePort();
    let previewPort = await availablePort();
    while (previewPort === authPort) previewPort = await availablePort();
    const compiled = spawn('go', ['build', '-o', join(temporary, 'auth-service'), '.'], { cwd: join(root, 'auth'), env: { ...process.env, GOCACHE: '/tmp/asher-go-build', GOMODCACHE: '/tmp/asher-go-mod' }, stdio: 'ignore' });
    children.push(compiled);
    if (await new Promise((done, fail) => { compiled.once('exit', done); compiled.once('error', () => fail(new Error('Go 1.26+ is required for local QA.'))); }) !== 0) throw new Error('Local Go service build failed.');
    const auth = launch(join(temporary, 'auth-service'), [], { AUTH_CONFIG: join(temporary, 'auth.json'), AUTH_DATA_DIR: join(temporary, 'content'), AUTH_LISTEN: `127.0.0.1:${authPort}` });
    const previewArgs = [join(root, 'node_modules/astro/bin/astro.mjs'), 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--ignore-lock'];
    // Freeze the built files for this run so a later build cannot replace active assets.
    const snapshot = join(temporary, 'site');
    await cp(resolve(options.dist ?? process.env.BLOG_TEST_LOCAL_DIST ?? join(root, 'dist')), snapshot, { recursive: true });
    const config = join(temporary, 'astro.config.mjs');
    await writeFile(config, `export default { outDir: ${JSON.stringify(snapshot + '/')} };`);
    previewArgs.push('--config', relative(root, config));
    const preview = launch(process.execPath, previewArgs, { ASTRO_TELEMETRY_DISABLED: '1' });
    await Promise.all([waitReady(`http://127.0.0.1:${authPort}/healthz`, auth), waitReady(`http://127.0.0.1:${previewPort}/login/`, preview)]);
    const upstream = (req, res, upstreamPort, path = req.url) => {
      const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}`, 'x-forwarded-uri': req.url, 'x-forwarded-proto': 'https', 'x-forwarded-for': localClientAddress(req.headers.cookie, req.socket.remoteAddress) };
      delete headers.authorization;
      const proxy = requestHTTP({ host: '127.0.0.1', port: upstreamPort, path, method: req.method, headers }, response => {
        res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
        response.pipe(res);
      });
      proxy.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(proxy);
    };
    server = createHTTPS({ key: await readFile(join(temporary, 'key.pem')), cert: await readFile(join(temporary, 'cert.pem')) }, (req, res) => {
      const path = new URL(req.url, origin).pathname;
      if (path.startsWith('/auth/') || path.startsWith('/api/')) return upstream(req, res, authPort);
      if (['/login', '/login/', '/login-assets/login.css', '/login-assets/login.js', '/favicon.svg'].includes(path)) return upstream(req, res, previewPort);
      const verify = requestHTTP({ host: '127.0.0.1', port: authPort, path: '/auth/verify', headers: { cookie: req.headers.cookie ?? '', 'x-forwarded-uri': req.url } }, response => {
        response.resume();
        if (response.statusCode === 204) return upstream(req, res, previewPort, /^\/articles\/[a-f0-9]{32}\/?$/.test(path) ? '/reader/' : req.url);
        res.writeHead(response.statusCode ?? 502, { ...response.headers, 'cache-control': 'no-store' }); res.end();
      });
      verify.once('error', () => { res.writeHead(502); res.end(); }); verify.end();
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
    return { origin, fixture, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await startPrivateServer();
  console.log(`Local private QA ready at ${service.origin}`);
}
