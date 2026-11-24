// 技能注册表：扫描同目录下的模块文件，合并它们导出的 skills 映射。
// 新增技能只需要新建一个模块文件，桥接会自动发现，无需改动 runAction 分支。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKIP_FILES = new Set(['registry.js', 'manifest.js', 'labels.js']);

export async function loadSkills() {
  const merged = {};
  const failures = [];
  const files = fs
    .readdirSync(SKILL_DIR)
    .filter((name) => name.endsWith('.js') && !SKIP_FILES.has(name))
    .sort();
  for (const name of files) {
    let module;
    try {
      // Windows 上必须用 file URL，直接给绝对路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
      module = await import(pathToFileURL(path.join(SKILL_DIR, name)).href);
    } catch (error) {
      // 一个模块写坏了不能拖垮整个桥接，记录下来继续加载其余模块。
      failures.push(`${name}: ${error.message}`);
      continue;
    }
    const skills = module && module.skills;
    if (!skills || typeof skills !== 'object') continue;
    for (const [id, entry] of Object.entries(skills)) {
      if (merged[id]) {
        failures.push(`${name}: 技能 ${id} 与其它模块重名，本模块的这条被跳过`);
        continue;
      }
      merged[id] = entry;
    }
  }
  if (failures.length) {
    console.error('[skills] 以下模块加载失败：\n' + failures.join('\n'));
  }
  return merged;
}
