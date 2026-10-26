/** Build and verify the examples-disabled artifact, then restore the normal build. */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp('/tmp/asher-blog-examples-disabled-');
const snapshot = join(temporary, 'dist');
const restoreExamples = process.env.BLOG_INCLUDE_EXAMPLES ?? '1';
let activeChild;
let interruption;
let restoring = false;

const handleSignal = signal => {
  interruption ??= new Error(`Examples-disabled verification interrupted by ${signal}.`);
  if (!restoring && activeChild?.exitCode === null && activeChild.signalCode === null) activeChild.kill(signal);
};
const onInterrupt = () => handleSignal('SIGINT');
const onTerminate = () => handleSignal('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

function run(command, args, env) {
  if (interruption && !restoring) return Promise.reject(interruption);
  return new Promise((resolveRun, rejectRun) => {
    const childEnvironment = { ...process.env, ...env };
    for (const [key, value] of Object.entries(childEnvironment)) {
      if (value === undefined) delete childEnvironment[key];
    }
    const child = spawn(command, args, {
      cwd: root,
      env: childEnvironment,
      stdio: 'inherit',
    });
    activeChild = child;
    child.once('error', error => {
      if (activeChild === child) activeChild = undefined;
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (interruption && !restoring) rejectRun(interruption);
      else if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} failed (${signal || code}).`));
    });
  });
}

const build = includeExamples => run('npm', ['run', 'build'], {
  BLOG_INCLUDE_EXAMPLES: includeExamples,
});
const combineFailure = (current, next, message) => current
  ? new AggregateError([current, next], message)
  : next;

let failure;
try {
  await build('0');
  await cp(join(root, 'dist'), snapshot, { recursive: true });
  await run('npm', ['run', 'test:e2e', '--', '--config', 'playwright.examples.config.ts'], {
    BLOG_TEST_LOCAL_AUTH: '1',
    BLOG_TEST_LOCAL_DIST: snapshot,
    BLOG_TEST_LOCAL_PORT: '4443',
    BLOG_TEST_LOCAL_FIXTURE: undefined,
    BLOG_TEST_BASE_URL: undefined,
    BLOG_TEST_SSH_TARGET: undefined,
    BLOG_TEST_STATIC_ONLY: undefined,
  });
} catch (error) {
  failure = error;
} finally {
  try {
    await rm(temporary, { recursive: true, force: true });
  } catch (cleanupError) {
    failure = combineFailure(failure, cleanupError, 'Examples-disabled verification and temporary cleanup both failed.');
  }
  try {
    restoring = true;
    await build(restoreExamples);
  } catch (restoreError) {
    failure = combineFailure(failure, restoreError, 'Examples-disabled verification and original-build restoration both failed.');
  } finally {
    restoring = false;
  }
}

process.removeListener('SIGINT', onInterrupt);
process.removeListener('SIGTERM', onTerminate);
if (interruption && failure !== interruption) {
  failure = combineFailure(failure, interruption, 'Examples-disabled verification was interrupted and another operation failed.');
}
if (failure) throw failure;
