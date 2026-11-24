// 把 bridge/skills/labels.js 的方块中文名导出成 labels.json，
// 让 Python 侧解析中文方块名时用的是同一份对照表。
// 用法：node scripts/dump_labels.js
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'bridge', 'skills', 'labels.js');
const OUTPUT_PATH = path.join(ROOT, 'bridge', 'skills', 'labels.json');
const NEWLINE = String.fromCharCode(10);

async function main() {
  const module = await import(pathToFileURL(SOURCE_PATH).href);
  const blocks = module.BLOCK_NAMES;
  if (!blocks || typeof blocks !== 'object' || !Object.keys(blocks).length) {
    throw new Error('labels.js 没有导出 BLOCK_NAMES');
  }
  const payload = {
    version: 1,
    source: 'bridge/skills/labels.js',
    blocks,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + NEWLINE, 'utf8');
  console.log('已写出 ' + OUTPUT_PATH);
  console.log('方块条目 ' + Object.keys(blocks).length);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
