# Bridge 技能模块

更新于 2026-10-28。`bridge/skills/` 保存 46 项模块技能；加上 `minecraft_bridge.js` 的 21 项内建动作，当前清单共 67 项。用户向功能介绍、阶段目标和完整列表见 [技能总表](../../docs/SKILLS.md)。

## 注册与事实来源

- [`registry.js`](registry.js) 在启动时扫描本目录的 `.js` 文件，跳过 `registry.js`、`manifest.js`、`labels.js`，合并导出的 `skills` 映射；它不提供运行时热重载。
- [`manifest.js`](manifest.js) 保存技能 ID、参数、分类、超时、取消能力和验收描述；[`manifest.json`](manifest.json) 是供 Core 读取的导出文件。
- [`minecraft_bridge.js`](../minecraft_bridge.js) 的 `buildSkillContext` 提供实际执行上下文，内建动作由其分支处理，模块动作走注册表。
- [`skill_invoker.js`](../skill_invoker.js) 和 [`execution_controller.js`](../execution_controller.js) 管理调用与执行上下文；Core 的 [`tools.py`](../../src/voxkin/agent/tools.py) 由清单生成模型工具，排除 `chat`。

## 模块布局

| 文件 | 导出的技能 |
| --- | --- |
| [combat.js](combat.js) | `shear_sheep`, `hunt_animal`, `hunt_material`, `fight_blaze`, `hunt_enderman`, `break_crystal`, `equip_shield` |
| [craft.js](craft.js) | `smelt_batch`, `craft_tool_set`, `prepare_bow_arrows`, `craft_torch`, `craft_bed` |
| [end.js](end.js) | `throw_eye`, `activate_end_portal`, `fight_dragon`, `return_home` |
| [gather.js](gather.js) | `fill_water_bucket`, `collect_obsidian`, `collect_flint`, `mine_collect`, `strip_mine`, `deep_mine`, `find_diamond` |
| [golem.js](golem.js) | `harvest_iron_golem` |
| [exploration.js](exploration.js) | `explore_mining_site` |
| [movement.js](movement.js) | `safe_descend`, `swim_escape`, `safe_travel`, `parkour_safe` |
| [nether.js](nether.js) | `make_nether_portal`, `nether_travel`, `raid_fortress`, `collect_blaze_rods` |
| [scavenge.js](scavenge.js) | `loot_village` |
| [storage.js](storage.js) | `store_items`, `withdraw_items`, `checkpoint_stock`, `list_chest` |
| [survival.js](survival.js) | `equip_armor`, `eat_if_hungry`, `make_shelter`, `sleep_safe`, `wait_for_day`, `leave_shelter`, `flee_low_health`, `swim_out` |

共用机制位于上一级：`resource_search.js` 负责有界资源搜索，`resource_sites.js` 观察床、箱子、干草与铁傀儡，`combat_encounter.js` 评估群怪，`window_sync.js` 处理容器确认。阶段资源储备属于 Core `resource_policy.py`，不在每个技能内重复编排。

## 新增或修改技能

模块是 ESM，导出 `skills` 映射；每项包含中文描述、参数和 `handler(args, ctx)`。例如只读查询：

```js
export const skills = {
  inspect_health: {
    description: '读取当前血量。',
    parameters: [],
    handler: async (args, ctx) => ({
      status: 'succeeded',
      detail: `当前血量 ${ctx.bot.health}`,
      data: { health: ctx.bot.health },
    }),
  },
};
```

示例 ID 不在当前清单中。加入实际技能时，同步登记 `manifest.js`，再用 `node scripts/dump_manifest.js` 从仓库根目录导出 JSON；检查差异，保留已有的专用参数和验收描述。`scripts/merge_module_skills.js` 可生成模块条目，使用后也需核对元数据。

上下文字段以 `buildSkillContext` 为准。跨技能复用通过 `ctx.runSkill(skillId, args)`，不要另建动作队列、重置预算或持久化阶段任务。模块契约见 [SKILL_MODULE_CONTRACT.md](../../docs/plans/SKILL_MODULE_CONTRACT.md)，其中早期字段列表需与当前源码核对。

## 执行约定

- 验证真实位置、库存、容器、方块或维度后再报告 `succeeded`；只有部分完成时返回 `partial` 和实际缺口。
- 搜索无目标、候选不可达或被采空时，沿用有界探索和已访问记录；不得无条件无限游荡或把未加载区块当作已搜索为空。
- 循环中检查取消与安全状态，最终释放本次持有的输入和窗口。未知窗口状态或未确认动作需要上层对账，不能吞掉后继续写世界。
- 战斗复用群怪评估、实际装备与撤退逻辑；指定实体的技能不得把击杀别的目标或撤退当成完成。铁傀儡使用独立 `harvest_iron_golem`，不加入常规敌对列表。
- `mine_collect.minimum_count` 是最低库存门槛；储备目标未满时必须如实回报。村庄技能从真实窗口取物，床须重新核查占用和保护区。
- 阶段最终验收属于 Core `goals.py::GOALS`，不在技能里另造一套通关条件。

## 验证

从仓库根目录执行离线定向检查（Node 需已在 PATH）：

```powershell
node --test bridge/tests/scavenge.test.js bridge/tests/golem.test.js bridge/tests/resource_sites.test.js
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
.\.venv\Scripts\python.exe -m pytest --assert=plain -p pytest_asyncio.plugin tests/test_skill_manifest.py tests/test_tools.py tests/test_resource_policy.py -q
git diff --check
```

2026-10-28 已记录的全量结果为 Bridge 273 项、Python 507 项通过；测试使用确定性替身，实机状态及 Windows 原生崩溃限制见 [验证记录](../../docs/evidence/RESOURCE_VILLAGE_GOLEM_20261028.md)。启动 Minecraft 前必须先按 [AGENTS.md](../../AGENTS.md) 读取活动 marker；本模块测试通过不解除运行阻塞。
