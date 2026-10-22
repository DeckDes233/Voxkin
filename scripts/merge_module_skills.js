// 把 bridge/skills/ 下的模块技能登记进 manifest.js。
// 模块文件是技能定义的来源，manifest.js 是清单的来源，两者在这里对齐。
// 用法：node scripts/merge_module_skills.js
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'bridge', 'skills', 'manifest.js');
const REGISTRY_PATH = path.join(ROOT, 'bridge', 'skills', 'registry.js');
const BEGIN_MARK = '// >>> 模块技能（由 scripts/merge_module_skills.js 生成，勿手改）';
const END_MARK = '// <<< 模块技能结束';

// skill_id 到中文短名的映射，用来生成意图示例。
const LABELS = {
  mine_collect: '按工具挖方块并收料',
  strip_mine: '挖主巷道与分支',
  deep_mine: '下深层矿道',
  find_diamond: '找钻石矿',
  smelt_batch: '批量冶炼',
  craft_tool_set: '成套装合成工具',
  craft_torch: '做火把并布光',
  craft_bed: '做床',
  hunt_animal: '狩猎取肉',
  fight_blaze: '打烈焰人',
  hunt_enderman: '猎末影人',
  break_crystal: '破坏末地水晶',
  end_break_crystal: '破坏末地水晶',
  equip_shield: '装备盾牌',
  eat_if_hungry: '饿了自动进食',
  make_shelter: '搭庇护所',
  sleep_safe: '安全过夜',
  wait_for_day: '守到天亮',
  leave_shelter: '挖开庇护所出口',
  flee_low_health: '低血撤退',
  swim_out: '落水脱困',
  store_items: '把物品存进箱子',
  withdraw_items: '从箱子取回物品',
  checkpoint_stock: '按清单分箱存放',
  list_chest: '查看箱子内容',
  safe_descend: '安全下降',
  swim_out_movement: '落水脱困',
  safe_travel: '避障长距离移动',
  parkour_safe: '受控跳跃',
  make_nether_portal: '造下界门',
  nether_travel: '下界坐标换算',
  raid_fortress: '搜堡垒',
  collect_blaze_rods: '收烈焰棒',
  throw_eye: '投掷末影之眼',
  activate_end_portal: '激活末地门',
  fight_dragon: '打末影龙',
  return_home: '回主世界',
};

// 需要更长预算的技能。桥接把单个动作的超时上限压在 300 秒。
const TIMEOUTS = {
  smelt_batch: 300,
  craft_tool_set: 180,
  craft_torch: 180,
  craft_bed: 120,
  strip_mine: 240,
  deep_mine: 240,
  make_shelter: 180,
  sleep_safe: 120,
  wait_for_day: 300,
  leave_shelter: 120,
  raid_fortress: 240,
  make_nether_portal: 180,
  activate_end_portal: 240,
  fight_dragon: 300,
  end_break_crystal: 240,
  return_home: 180,
  throw_eye: 180,
  hunt_animal: 180,
  hunt_enderman: 180,
  fight_blaze: 240,
  checkpoint_stock: 120,
};

// 只读或查询类技能的动作类型。
const SENSE_IDS = new Set(['list_chest', 'find_diamond']);

function intentExamples(skillId, label) {
  return [`执行${label}`, `需要${label}时调用`, `用${label}推进当前任务`];
}

function executionSteps(description) {
  const parts = description
    .split('；')
    .map((part) => part.trim())
    .filter(Boolean);
  const steps = [];
  for (const part of parts) {
    const colon = part.indexOf('：');
    steps.push(colon >= 0 ? part.slice(colon + 1).trim() : part);
  }
  return steps.length ? steps : [description];
}

function buildEntry(skillId, skill) {
  const label = LABELS[skillId] || skillId;
  const description = String(skill.description || '').trim();
  const parameters = (skill.parameters || []).map((parameter) => ({
    name: parameter.name,
    type: parameter.type || 'string',
    required: Boolean(parameter.required),
    default: parameter.default === undefined ? null : parameter.default,
    description: String(parameter.description || ''),
  }));
  return {
    skill_id: skillId,
    group: '专精类',
    type: SENSE_IDS.has(skillId) ? 'sense' : 'act',
    description,
    intent_examples: intentExamples(skillId, label),
    parameters,
    preconditions: '桥接已连接且 bot 已进入世界。',
    observations: '读取背包、位置、朝向、附近方块与实体状态。',
    execution_steps: executionSteps(description),
    postconditions: '动作完成，返回中文结果描述。',
    failure_conditions: [
      '前置材料、装备或位置不满足时中止，并在错误里说明缺什么。',
      '目标在当前维度找不到时中止，并报告搜索范围。',
    ],
    recovery_strategy: '补齐材料或换位置后重试，也可以拆成更小的步骤分别调用。',
    timeout_s: TIMEOUTS[skillId] || 120,
    cancellable: true,
    verifies: '返回文本里带出实际数量、坐标或状态，且与背包或世界状态一致。',
  };
}

function renderEntry(entry) {
  const lines = [];
  const literal = (items) => '[' + items.map((item) => JSON.stringify(item)).join(', ') + ']';
  lines.push('    {');
  lines.push(`      skill_id: '${entry.skill_id}',`);
  lines.push(`      group: '${entry.group}',`);
  lines.push(`      type: '${entry.type}',`);
  lines.push(`      description: ${JSON.stringify(entry.description)},`);
  lines.push(`      intent_examples: ${literal(entry.intent_examples)},`);
  if (!entry.parameters.length) {
    lines.push('      parameters: [],');
  } else {
    lines.push('      parameters: [');
    for (const parameter of entry.parameters) {
      lines.push('        {');
      lines.push(`          name: '${parameter.name}',`);
      lines.push(`          type: '${parameter.type}',`);
      lines.push(`          required: ${parameter.required},`);
      lines.push(`          default: ${JSON.stringify(parameter.default)},`);
      lines.push(`          description: ${JSON.stringify(parameter.description)},`);
      lines.push('        },');
    }
    lines.push('      ],');
  }
  lines.push(`      preconditions: ${JSON.stringify(entry.preconditions)},`);
  lines.push(`      observations: ${JSON.stringify(entry.observations)},`);
  lines.push(`      execution_steps: ${literal(entry.execution_steps)},`);
  lines.push(`      postconditions: ${JSON.stringify(entry.postconditions)},`);
  lines.push('      failure_conditions: [');
  for (const condition of entry.failure_conditions) {
    lines.push(`        ${JSON.stringify(condition)},`);
  }
  lines.push('      ],');
  lines.push(`      recovery_strategy: ${JSON.stringify(entry.recovery_strategy)},`);
  lines.push(`      timeout_s: ${entry.timeout_s},`);
  lines.push(`      cancellable: ${entry.cancellable},`);
  lines.push(`      verifies: ${JSON.stringify(entry.verifies)},`);
  lines.push('    },');
  return lines.join('\n');
}

async function main() {
  const registry = await import(pathToFileURL(REGISTRY_PATH).href);
  const skills = await registry.loadSkills();
  const source = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const beginIndex = source.indexOf(BEGIN_MARK);
  const endIndex = source.indexOf(END_MARK);
  if (beginIndex < 0 || endIndex < 0) {
    throw new Error('manifest.js 里找不到模块技能标记区间');
  }
  const head = source.slice(0, beginIndex);
  const tail = source.slice(endIndex + END_MARK.length);
  const entries = Object.keys(skills)
    .sort()
    .map((skillId) => buildEntry(skillId, skills[skillId]))
    .map(renderEntry)
    .join('\n');
  const block = `${BEGIN_MARK}\n${entries}\n${END_MARK}`;
  fs.writeFileSync(MANIFEST_PATH, head + block + tail, 'utf8');
  console.log('已登记模块技能 ' + Object.keys(skills).length + ' 个');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
