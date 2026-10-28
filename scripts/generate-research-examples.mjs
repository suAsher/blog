import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = fileURLToPath(new URL('../', import.meta.url));
const bundle = path.join(repo, 'examples/research/import-bundle');
const images = path.join(bundle, 'images');
const titles = [
  '演示 · 把推理延迟拆成可讨论的预算',
  '演示 · 可复现实验不是只存一条命令',
  '演示 · 源码阅读要留下可回查的证据',
  '演示 · 把复盘结论写成可撤回的运行手册',
  '演示 · 轮值交接便笺',
];

function illustration(title, subtitle, nodes, footer) {
  const boxes = nodes.map((node, index) => {
    const x = 75 + index * 330;
    const arrow = index < nodes.length - 1
      ? `<path d="M${x + 270} 370h55m-12-10 12 10-12 10" fill="none" stroke="#64768f" stroke-width="3"/>`
      : '';
    return `<rect x="${x}" y="255" width="270" height="235" rx="22" fill="#13253c" stroke="#42617f"/>
      <rect x="${x + 22}" y="278" width="50" height="7" rx="3" fill="#82edca"/>
      <text x="${x + 25}" y="330" class="label">${node[0]}</text>
      <text x="${x + 25}" y="390" class="number">${node[1]}</text>
      <text x="${x + 25}" y="443" class="small">${node[2]}</text>${arrow}`;
  }).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800" viewBox="0 0 1400 800">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0a1424"/><stop offset="1" stop-color="#1b3149"/></linearGradient></defs>
    <style>text{font-family:sans-serif;fill:#e9f3ff}.title{font-size:42px;font-weight:700}.sub{font-size:21px;fill:#acc0d8}.label{font-size:25px}.number{font-size:36px;font-weight:700;fill:#82edca}.small{font-size:17px;fill:#acc0d8}</style>
    <rect width="1400" height="800" fill="url(#bg)"/>
    <circle cx="1230" cy="80" r="200" fill="#82edca" opacity=".035"/>
    <text x="75" y="88" class="small" letter-spacing="4">GENERATED DEMO / NO REAL MEASUREMENTS</text>
    <text x="75" y="155" class="title">${title}</text>
    <text x="75" y="200" class="sub">${subtitle}</text>${boxes}
    <path d="M75 570h1250" stroke="#42617f"/>
    <text x="75" y="630" class="sub">${footer}</text>
    <text x="75" y="700" class="small">Original illustration authored for the research import bundle.</text>
    <text x="75" y="736" class="small">All values and scenarios are synthetic examples, not benchmarks.</text>
  </svg>`);
}

async function check() {
  const files = [];
  for (const folder of ['articles', 'notes']) {
    for (const name of await readdir(path.join(bundle, folder))) files.push(path.join(folder, name));
  }
  assert.equal(files.filter(file => file.endsWith('.md')).length, 4);
  assert.equal(files.filter(file => file.endsWith('.txt')).length, 1);
  const actualTitles = [];
  for (const file of files) {
    const source = await readFile(path.join(bundle, file), 'utf8');
    assert(source.includes('生成演示材料'), `Missing demo banner: ${file}`);
    const title = file.endsWith('.md') ? /^title: "(.+)"$/m.exec(source)?.[1] : /^# (.+)$/m.exec(source)?.[1];
    assert(title?.startsWith('演示 ·'), `Missing demo title: ${file}`);
    actualTitles.push(title);
    assert(!/^category:/m.test(source), 'Examples must not impose a category.');
    for (const link of source.matchAll(/\[\[([^\]]+)\]\]/g)) assert(titles.includes(link[1]), `Unknown wiki target: ${link[1]}`);
    for (const image of source.matchAll(/(?:!\[[^\]]*\]\(([^)]+)\)|^cover: "([^"]+)")/gm)) {
      const relative = image[1] || image[2];
      const resolved = path.resolve(bundle, path.dirname(file), relative);
      assert(resolved.startsWith(bundle + path.sep), 'Image escaped the bundle.');
      const bytes = await readFile(resolved);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert(bytes.length < 8 * 1024 * 1024);
    }
    for (const chart of source.matchAll(/```chart\n([\s\S]*?)\n```/g)) {
      const value = JSON.parse(chart[1]);
      assert(value.title.includes('演示'));
      assert(['line', 'bar'].includes(value.type));
      assert(value.series.every(series => series.values.length === value.labels.length && series.values.every(Number.isFinite)));
    }
  }
  assert.deepEqual(actualTitles.sort(), [...titles].sort());
  const longArticle = await readFile(path.join(bundle, 'articles/01-latency-budget.md'), 'utf8');
  const chineseCharacters = (longArticle.match(/\p{Script=Han}/gu) || []).length;
  assert(chineseCharacters >= 1500 && chineseCharacters <= 2500, `Long article has ${chineseCharacters} Chinese characters.`);
  console.log(`Validated ${files.length} generated demo documents, 2 PNG illustrations; long article: ${chineseCharacters} Chinese characters.`);
}

if (!process.argv.includes('--check')) {
  await mkdir(images, { recursive: true });
  await writeFile(path.join(images, 'latency-budget.png'), await sharp(illustration(
    'Give each stage a clear boundary', 'Synthetic request path / values are illustrative only',
    [['INGRESS', '20 ms', 'receive to validate'], ['QUEUE', '60 ms', 'enqueue to execute'], ['INPUT', '100 ms', 'execute to input done'], ['FIRST CHUNK', '40 ms', 'input done to visible']],
    'A budget is a map for the next experiment.'
  )).png().toBuffer());
  await writeFile(path.join(images, 'evidence-loop.png'), await sharp(illustration(
    'Keep the evidence close to the question', 'Synthetic research workflow / not a production trace',
    [['QUESTION', 'Define', 'make a falsifiable claim'], ['CONDITIONS', 'Record', 'inputs and boundaries'], ['OBSERVATION', 'Compare', 'facts before inference'], ['HANDOFF', 'Review', 'scope and stop conditions']],
    'A useful note tells the next reader what is still missing.'
  )).png().toBuffer());
}
await check();
