# Minecraft 桥接

`minecraft_bridge.js` 让 Mineflayer 机器人进入 Minecraft Java 1.21.1 世界，将聊天和世界观察发送给 Voxkin Core，并执行带验收回执的动作。当前清单共 68 项技能，覆盖采集、合成、生存、群怪战斗、村庄补给、铁傀儡取铁、下界和末地；完整介绍见 [技能总表](../docs/SKILLS.md)，开发方式见 [模块说明](skills/README.md)。

## 安装与启动

```powershell
cd bridge
npm install
$env:MC_HOST = "127.0.0.1"
$env:MC_PORT = "25565"
$env:MC_VERSION = "1.21.1"     # 留空则自动协商
$env:MC_USERNAME = "Voxkin"
$env:MC_AUTH = "offline"       # 正版账号改成 microsoft
$env:VOXKIN_WS = "ws://127.0.0.1:8765/ws/bridge"
$env:VOXKIN_INDEPENDENT = "0"  # 玩家互动；独立通关评测改为 1
node minecraft_bridge.js
```

Core 必须先启动（`python -m voxkin serve`）。连接恢复后仍需等待世界就绪与新鲜观察，才能准入普通动作；未确认动作由 Core 对账，不直接重放。实机启动前先按 [AGENTS.md](../AGENTS.md) 检查本地活动 marker，当前 Windows 环境的阻塞状态见 [运行环境复核](../docs/evidence/S0_S4_RUNTIME_CHECK_20261028.md)。

## 来源

跟随、挖掘、放置、战斗等动作与自主行为的设计参考了 [MindCraft](https://github.com/mindcraft-bots/mindcraft)（MIT）。桥接没有引入它的运行时代码与 agent 循环，按函数重写并保留这份声明。

## 协议

所有消息都是 JSON 文本帧。

桥接 → Core：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `bridge`, `protocol` | 连接后立即发送 |
| `chat` | `player`, `text` | 游戏内聊天 |
| `state` | `data.session_id`、`revision`、`ready`、`executor`、`position`、`health`、`food`、`dimension`、`inventory`、`resource_sites` 等 | 周期性世界观察，也用于动作准入和结果对账 |
| `action_progress` | `action_id`、`skill_id`、`status`、`detail`、可选 `data` | 部分动作的执行进度，不能代替终态回执 |
| `action_result` | `action_id`, `ok`, `status`, `skill_id`, `detail`, 可选 `data` | 动作结果，必须与 `action_id` 对应；`data` 可携带机器可读的结果事件与证据 |
| `action_status_result` | `action_id` 及查询结果 | 对账指定动作的当前状态或已保存回执 |
| `world_unavailable` | `reason` | 世界连接不可用，阻止继续使用旧观察派发 |

Core → 桥接：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `welcome` | `name` | 握手确认 |
| `action` | `action_id`, `tool`, `arguments`, `timeout_s`，以及观察版本元数据 | 执行动作；Bridge 核对 session 和 revision |
| `action_cancel` | `action_id` 等取消字段 | 取消排队或在途动作 |
| `action_status` | `action_id` | 查询动作以便恢复对账 |
| `error` | `error` | 已有其他桥接连接等错误 |

## 常用动作入口

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `chat` | `text` | 在游戏内发言 |
| `stop` | 无 | 停止移动并清除控制状态 |
| `goto` | `x`, `y`, `z` | 用 pathfinder 走到目标附近 2 格，返回实际距离 |
| `collect_blocks` | `block`, `count` | 寻找 32 格内最近的方块，逐个走到并挖掘，返回实际挖到的数量 |
| `look_at_player` | `player` | 转向指定玩家 |
| `mine_collect` | `block`, `count`, 可选 `minimum_count` | 采集并移动搜索，按实际库存核对最低需求与储备目标 |
| `loot_village` | `targets`, `bed_count`, `food_target` 等 | 检查村庄床、箱子与干草，按缺口补给 |
| `harvest_iron_golem` | `entity_id` | 靠近指定铁傀儡、搭三格柱并在安全条件下攻击，核实铁锭增量 |
| `attack_nearest` | 见技能清单 | 按群怪威胁选择自动目标，苦力怕引爆或战力不足时撤退 |

上表是常用入口；全部参数与超时以 [manifest.json](skills/manifest.json) 为准。世界动作通过 `ExecutionController` 管理，安全反射和取消可中断当前动作。实际只完成部分工作时返回 `partial` 与缺口；技能结果仍需由阶段监督器结合新鲜观察验收。

## 已知限制

- 最新运行状态统一见 [STATUS](../docs/STATUS.md)：S0–S2 已有新世界通过记录，S2 仅白天准备；S3 恢复续测仍遇 Bridge/V8 异常，S4–S6 尚无实机通过记录。历史 Terra 运行和新增补给技能的测试不能替代后续验收。
- Minecraft 1.21.1 运行日志曾出现 `PartialReadError`（`ArmorTrimMaterial`）；其与原生崩溃的因果关系尚未确定，不能据短时连接成功判定运行稳定。
- 资源与实体只基于已加载世界观察。村庄线索不提供箱子所有权信息；已知庇护所保护范围外的玩家箱子无法仅凭方块区分。
- 状态观察现已包含背包、空位、玩家、庇护所和资源线索；完整字段见 [world_observation.js](world_observation.js)。
- 2026-10-28 资源补给修复时离线 Bridge 273 项测试通过（历史快照），详细边界见 [验证记录](../docs/evidence/RESOURCE_VILLAGE_GOLEM_20261028.md)。
