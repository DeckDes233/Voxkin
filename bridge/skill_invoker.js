export function createSkillInvoker(skills, buildContext, initialStack = [], maxDepth = 8) {
  async function invoke(skillId, args = {}, callStack = initialStack) {
    const id = String(skillId || '').trim();
    if (!id) throw new Error('嵌套技能缺少 skill_id');
    if (callStack.includes(id)) {
      throw new Error(`嵌套技能出现循环调用：${[...callStack, id].join(' -> ')}`);
    }
    if (callStack.length >= maxDepth) {
      throw new Error(`嵌套技能超过最大深度 ${maxDepth}`);
    }
    const skill = skills[id];
    if (!skill || typeof skill.handler !== 'function') {
      throw new Error(`未知嵌套技能 ${id}`);
    }

    const nextStack = [...callStack, id];
    const context = buildContext((nestedId, nestedArgs = {}) =>
      invoke(nestedId, nestedArgs, nextStack));
    if (context.interrupted) throw new Error(`嵌套技能 ${id} 被当前动作打断`);
    return skill.handler(args && typeof args === 'object' ? args : {}, context);
  }

  const context = buildContext((skillId, args = {}) =>
    invoke(skillId, args, initialStack));
  return { context };
}
