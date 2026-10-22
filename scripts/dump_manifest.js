const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MANIFEST_PATH = path.join(__dirname, '..', 'bridge', 'skills', 'manifest.js');
const OUTPUT_PATH = path.join(__dirname, '..', 'bridge', 'skills', 'manifest.json');
const NEWLINE = String.fromCharCode(10);

const GROUPS = new Set(['基础类', '实用类', '专精类']);
const TYPES = new Set(['sense', 'act', 'path', 'wait', 'voice', 'plan']);
const SKILL_FIELDS = [
  'skill_id',
  'group',
  'type',
  'description',
  'intent_examples',
  'parameters',
  'preconditions',
  'observations',
  'execution_steps',
  'postconditions',
  'failure_conditions',
  'recovery_strategy',
  'timeout_s',
  'cancellable',
  'verifies',
];

// bridge/package.json 声明了 type 为 module，同目录下的 .js 会按 ES module 解析，
// 直接 require 清单会报 module is not defined in ES module scope。
// 这里用 vm 在 CommonJS 作用域里执行清单源文件，让 manifest.js 保持 CommonJS 写法。
function loadCommonJsModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const moduleObject = { exports: {} };
  const sandbox = {
    module: moduleObject,
    exports: moduleObject.exports,
    require,
    console,
    __filename: filePath,
    __dirname: path.dirname(filePath),
  };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return moduleObject.exports;
}

function fail(message) {
  throw new Error(message);
}

function validateParameters(skillId, parameters) {
  if (!Array.isArray(parameters)) {
    fail(skillId + ' 的 parameters 必须是数组');
  }
  for (const parameter of parameters) {
    for (const field of ['name', 'type', 'required', 'description']) {
      if (!(field in parameter)) {
        fail(skillId + ' 的参数 ' + (parameter.name || '(未命名)') + ' 缺少字段 ' + field);
      }
    }
    if (!('range' in parameter) && !('default' in parameter)) {
      fail(skillId + ' 的参数 ' + parameter.name + ' 必须有 range 或 default');
    }
  }
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.skills)) {
    fail('manifest.js 必须导出 skills 数组');
  }
  const seen = new Set();
  for (const skill of manifest.skills) {
    for (const field of SKILL_FIELDS) {
      if (!(field in skill)) {
        fail((skill.skill_id || '(未命名)') + ' 缺少字段 ' + field);
      }
    }
    if (seen.has(skill.skill_id)) {
      fail('skill_id 重复：' + skill.skill_id);
    }
    seen.add(skill.skill_id);
    if (!GROUPS.has(skill.group)) {
      fail(skill.skill_id + ' 的 group 不合法：' + skill.group);
    }
    if (!TYPES.has(skill.type)) {
      fail(skill.skill_id + ' 的 type 不合法：' + skill.type);
    }
    if (!Array.isArray(skill.intent_examples) || skill.intent_examples.length < 3) {
      fail(skill.skill_id + ' 的 intent_examples 至少要 3 条');
    }
    if (!Array.isArray(skill.execution_steps) || skill.execution_steps.length === 0) {
      fail(skill.skill_id + ' 的 execution_steps 不能为空');
    }
    if (!Array.isArray(skill.failure_conditions)) {
      fail(skill.skill_id + ' 的 failure_conditions 必须是数组');
    }
    if (typeof skill.timeout_s !== 'number' || skill.timeout_s <= 0) {
      fail(skill.skill_id + ' 的 timeout_s 必须是正数');
    }
    if (typeof skill.cancellable !== 'boolean') {
      fail(skill.skill_id + ' 的 cancellable 必须是布尔值');
    }
    validateParameters(skill.skill_id, skill.parameters);
  }
}

const manifest = loadCommonJsModule(MANIFEST_PATH);
validateManifest(manifest);

const json = JSON.stringify(manifest, null, 2) + NEWLINE;
fs.writeFileSync(OUTPUT_PATH, json, 'utf8');

const byGroup = {};
const byType = {};
for (const skill of manifest.skills) {
  byGroup[skill.group] = (byGroup[skill.group] || 0) + 1;
  byType[skill.type] = (byType[skill.type] || 0) + 1;
}

console.log('已写出 ' + OUTPUT_PATH);
console.log('技能总数 ' + manifest.skills.length);
console.log('按 group：' + JSON.stringify(byGroup));
console.log('按 type：' + JSON.stringify(byType));
