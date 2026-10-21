# 独立通关评测体系

> 目标：证明沃心在玩家零干预下独立通关 Minecraft。本文只定义评测、注入与门槛；评测脚本属于 M0 交付，脚本未交付前，任何“看起来能通关”的演示都不算证据。

## 0. 现状与缺口

| 能力 | 现状（写入时快照） | 评测要求 | 缺口 |
| --- | --- | --- | --- |
| 阶段推进 | `src/voxkin/agent/progress.py` 仅有 S0-S6 背包判定 | 每阶段有世界侧完成条件 | 无 TaskRunner、无 runner 接口 |
| 动作取消 | `actions.py` 只有 `dispatch`；桥接的 `attack_nearest`/`stop` 可打断当前动作 | 抢占、超时后清场、step 级取消 | 无 Core 侧 `cancel`，无 step 进度 |
| 技能覆盖 | `bridge/minecraft_bridge.js` 12 个动作；顶层直接连 Core 与建 bot | craft/smelt/chest/sleep/trade/portal/bow | 均未实现；技能函数不可单测 |
| 死亡恢复 | `death` 事件停跟随与闲逛（`bridge:1071`） | 自动重生、续做、回收掉落 | 无 `respawn`、无掉落物回收 |
| 状态帧 | 5 秒一帧（`bridge:1027`），无背包字段 | 每步可追溯 | 无序号、无 `state_age`、无背包 |
| 轨迹 | `MetricsStore` 环形 200 条 | JSONL 全量、可回放 | 无 JSONL、无世界快照 |
| 测试世界 | `work/mc/server` 为 easy、`allow-nether=false`、种子为空 | 固定种子与规则 | 无测试世界、无重置脚本 |
| 审计 | 无 | 人工干预必须为 0 | 无检测器 |

现有 90 个测试覆盖语音、协议与阶段表，没有一条能证明零干预通关。评测底座先于 TaskRunner 建成。

## 1. 测试分层

| 层 | 被测对象 | 替身/环境 | 运行方式 | 耗时 | 通过标准 |
| --- | --- | --- | --- | --- | --- |
| L0 技能单元 | schema、参数校验、重试、超时、取消、verifier 规则 | 假 bot（纯 JS 对象）、假桥接（WS）、`tests/support.py` 的 `ToneTTS` | `pytest tests -q`；`node --test tests/js` | < 30 秒 | 每个技能正常、可恢复失败、不可恢复失败各 1 例；不连真实 MC |
| L1 场景测试 | 单技能在固定世界的真实效果 | `eval-scenario` 世界、预置箱子 | `run_scenario.py --scenario collect_oak` | 3–10 分钟/例 | 世界侧断言通过，背包与世界方块同时变化 |
| L2 阶段验收 | S0-S6 的阶段完成条件 | `eval-scenario`，快照重置 | `run_stage.py --stage S3` | 20 分钟–5 小时/阶段 | 该阶段全部硬条件 + 指标门槛 |
| L3 全流程演练 | 从空背包到末影龙 | `eval-full`，真实 LLM/TTS | `run_full.py --profile rehearsal` | 8–24 小时 | M8 门槛；允许观察，不允许操作 |
| L4 长时稳定 | 断线、重启、限流、内存与日志增长 | `eval-soak`，注入调度 | `soak.ps1 -Hours 24` | 24 小时 | 无崩溃、可用率与增长阈值达标 |

```powershell
# L0：当前仓库可直接执行
.\.venv\Scripts\python.exe -m pytest tests -q
node --check bridge\minecraft_bridge.js
# L1-L4：M0 交付的 CLI 契约；脚本缺失时该层记为未执行，不得用人工操作补证
powershell -File scripts\eval\prepare_world.ps1 -Seed 20261021 -Profile scenario
.\.venv\Scripts\python.exe scripts\eval\run_scenario.py --scenario collect_oak --seconds 600
.\.venv\Scripts\python.exe scripts\eval\run_stage.py --stage S3 --out work\eval\runs\S3-001
.\.venv\Scripts\python.exe scripts\eval\run_full.py --profile rehearsal --max-hours 24
powershell -File scripts\eval\soak.ps1 -Hours 24 -FaultEvery 20m
```

## 2. 固定世界

| 世界 | 用途 | 种子 | 初始状态 | 预置箱子 | 难度 |
| --- | --- | --- | --- | --- | --- |
| `eval-scenario` | L1/L2 | 20261021 | 空背包，出生点平台 | 有，按阶段配给 | normal |
| `eval-full` | L3/M8 正式 | 20261021 | 空背包，仅出生点平台 | 无 | hard |
| `eval-soak` | L4 | 20261021 | 同 `eval-full` | 无 | hard |

- 出生点：`/setworldspawn 0 72 0`；平台 `/fill -8 70 -8 8 70 8 stone`，`/fill -8 71 -8 8 76 8 air`。
- 结构坐标：在 Paper 1.21.1-133 上用种子 20261021 实测，y 以实际生成/进入时为准，评测比较 x、z 与容差；实测值写入 `tests/eval/world_manifest.json`（`seed`、`spawn`、`village`、`fortress`、`stronghold`、`portal_room`、`end_spawn`），脚本启动时校验，禁止重新生成；换种子等同换评测集。

| 结构 | 实测坐标 | 定位命令 | 容差 |
| --- | --- | --- | --- |
| 村庄 | `(272, ~, 320)` | `/locate structure minecraft:village_plains` | 64 格 |
| 下界要塞 | `(144, ~, 144)`（下界） | `/execute in minecraft:the_nether run locate structure minecraft:fortress` | 96 格 |
| 要塞 | `(-2112, ~, -976)` | `/locate structure minecraft:stronghold` | 32 格 |
| 末地入口 | `(100, ~, 0)`（Java 版固定） | 首次进入时核对 | — |
| 出生点 | `(0, 72, 0)` | `/setworldspawn 0 72 0` | 0 |

| 规则项 | 正式世界 | 测试世界 | 理由 |
| --- | --- | --- | --- |
| `level-seed` | 20261021 | 20261021 | 结构与地形可复现 |
| `difficulty` | hard | normal | 正式验收按默认难度；测试降低噪声 |
| `allow-nether` | true | true | S5 必需；当前配置为 false |
| `online-mode` | false | false | 离线 bot；仅限本机 |
| `spawn-protection` | 0 | 0 | 否则出生点无法挖放 |
| `view-distance` / `simulation-distance` | 6 / 6 | 6 / 6 | 减少区块未加载误判 |
| `keepInventory` | false | false | 死亡必须有代价 |
| `mobGriefing` | true | true | 苦力怕可炸床、炸传送门 |
| `doDaylightCycle` | true | true | 夜晚是验收内容 |
| `doWeatherCycle` | false | false | 排除雷雨随机性 |
| `doFireTick` | false | false | 火焰蔓延不可控；岩浆伤害保留 |
| `naturalRegeneration` | true | true | 默认机制 |
| `playersSleepingPercentage` | 100 | 100 | 单人可睡 |
| `doImmediateRespawn` | false | false | 保留 death 事件供审计 |
| `announceAdvancements` | false | false | 减少聊天噪声 |

预置箱子只存在于 `eval-scenario`，坐标固定：`(2,71,2)` 阶段物资、`(-2,71,2)` 恢复物资、`(2,71,-2)` 空箱（背包满用）。阶段箱只放上一阶段产物（例如 S3 放 8 个铁矿石、8 个煤、1 个熔炉），用来隔离测试目标。恢复箱放 `water_bucket`、`flint_and_steel`、`obsidian 10`、`cooked_beef 8`、`bed`、`diamond_pickaxe`、`oak_planks 16`。正式世界不放评测箱；读取自然生成的箱子属于正常玩法，计入资源日志；只有读取模板预置坐标的箱子才判失败。

```powershell
# 模板只生成一次；每个 run 前重置，删除前校验路径
powershell -File scripts\eval\prepare_world.ps1 -Seed 20261021 -Profile official -Out work\eval\templates\official
powershell -File scripts\eval\reset_world.ps1 -Template work\eval\templates\official -RunDir work\eval\runs\cert-001
$target = (Resolve-Path "work\eval\runs\cert-001\world").Path; if ($target -notlike "*\work\eval\runs\*") { throw "拒绝删除 $target" }
Remove-Item $target -Recurse -Force; Copy-Item work\eval\templates\official\world $target -Recurse
```

## 3. 指标

| 指标 | 定义 | 采集点 | 门槛（首轮） |
| --- | --- | --- | --- |
| 阶段耗时 | `stage_start` 到 `stage_complete` 的单调时钟差 | JSONL | M1 ≤25 分钟，M2 ≤45 分钟，M3 ≤2 小时，M4 ≤3 小时，M5 ≤5 小时，M6 ≤2 小时，M7 ≤1.5 小时，M8 ≤24 小时 |
| 死亡次数 | `death` 事件数；另记每次重生到恢复任务的秒数 | 桥接 + 服务端日志 | M8 ≤30；单次恢复 ≤5 分钟；同点 10 分钟内 3 次死亡判死亡循环 |
| 卡住次数 | 任务进行中 90 秒位移 <2 格且 verifier 无进展 | 状态帧 + verifier | M8 ≤20；单次 ≤15 分钟 |
| 重规划次数 | 失败触发的 planner 调用，按 `plan_id` 去重 | JSONL | M8 ≤60；同一 `(stage, step)` 连续 3 次相同计划判规划错误 |
| LLM 调用与 token | 调用次数、prompt/completion token；按阶段汇总 | LLM 响应 usage | M8 ≤300 次/小时、≤12M token、单请求 ≤32k 上下文 |
| 无效工具调用率 | schema 非法、未知工具、缺参、60 秒内重复且状态无变化的调用 / 总调用 | JSONL | M1-M4 ≤5%；M8 ≤3% |
| 资源效率 | 关键物品产出/消耗；任务物品因死亡或丢弃的损失率 | 背包快照 | 损失率 ≤10%；blaze rod、ender pearl 单独计数 |
| 人工干预次数 | 见下方五条判定 | 审计器 | 必须为 0 |
| 墙钟时间 | `run_start` 到 `dragon_dead`，含等待与恢复 | JSONL | M8 ≤24 小时；目标 12 小时 |
| 桥接可用率 | 桥接 WS 在线时长 / 运行时长 | 心跳 | ≥99% |
| 状态新鲜度 | `state_age_ms` 的 p95 与最大值 | 状态帧 | p95 ≤6 秒，最大 ≤30 秒 |
| 动作超时率 | `ActionError` 超时 / 总动作 | JSONL | ≤2%；smelt 等长动作单独设超时 |

人工干预的五条判定：非 bot 玩家在聊天中发出任何被 pipeline 当作指令的文本；`run_start` 后服务端控制台执行 give/tp/setblock/time/weather/effect/gamerule/difficulty/kill/summon 等写命令（计划内 `inject=true` 的注入除外）；手动启停 Core、桥接或服务端（supervisor 自动重启除外）；直接改存档、玩家数据或物品栏；观察者离开 spectator 或与 bot 交互。任一条命中即该 run 作废。

## 4. 日志与回放

每次 run 一个目录：`work/eval/runs/<run_id>/`，内含 `run.jsonl`、`summary.json`、`world_manifest.json`、`snapshots/`、`server.log`、`bridge.log`。`run.jsonl` 每步一行，记录 state、plan、tool、result、verifier 证据；`summary.json` 是审计入口，固定字段：run_id、seed、manifest_hash、起止时间、各阶段耗时、死亡与恢复耗时、卡住与重规划、LLM 调用与 token、无效调用率、资源损失率、人工干预计数、桥接可用率、RSS 峰值、JSONL 与 SQLite 大小、回放抽样结果、`pass/fail` 结论与失败分类计数。

    {"ts":"2026-10-22T01:02:03.456+08:00","run_id":"cert-001","seq":842,"event":"verify","stage":"S3","plan_id":"p17","step":3,"state":{"pos":[12.5,64.0,-3.2],"dim":"overworld","health":18.0,"food":14.0,"time":18000,"day":3,"inv":{"iron_ore":5},"state_age_ms":120,"tps":19.8},"plan":{"goal":"smelt 3 iron_ingot","done_when":"inventory.iron_ingot>=3"},"tool":{"name":"smelt","args":{"item":"iron_ingot","count":3}},"result":{"ok":true,"detail":"烧出 3 个铁锭"},"verifier":{"rule":"inventory_delta","pass":true,"evidence":{"before":{"iron_ingot":0},"after":{"iron_ingot":3}}},"llm":{"calls":1,"prompt_tokens":812,"completion_tokens":44},"wall_ms":91234}

| 事件 | 必填字段 | 用途 |
| --- | --- | --- |
| `run_start` / `run_end` | run_id、seed、manifest_hash、版本、摘要 hash | 封存证据 |
| `stage_start` / `stage_complete` | stage、inventory、耗时 | 阶段验收 |
| `plan` | plan_id、goal、done_when、steps | 规划追溯 |
| `tool_call` / `tool_result` | tool、args、ok、detail、超时 | 技能归因 |
| `verify` | rule、pass、before/after、来源（bot 或服务端） | 成功判定 |
| `recovery` | fault_id、动作序列、结果 | 恢复归因 |
| `death` | 坐标、维度、掉落、重生耗时 | 死亡统计 |
| `fault` | 类型、注入命令、`inject=true` | 区分人为与自然故障 |

回放一次失败：`summary.json` 找 `first_fail_seq`；取不晚于它的最近快照（阶段开始与每 300 步各一份）；用该快照恢复世界，无快照时用模板从头重放；按 seq 重放 `tool_call` 的 args，跳过 LLM，逐条比较 verifier；结果不一致时把差异归到感知或环境类，并标记 `nondeterministic`。每次失败在 `summary.json` 写 `class`、`signal`、`evidence_seq`、`owner`；归因顺序为 verifier 失败类型 → 最近 20 步回放 → 状态与服务器真值对比。

```powershell
.\.venv\Scripts\python.exe scripts\eval\replay.py --run work\eval\runs\cert-001 --seq 842 --compare verifier
.\.venv\Scripts\python.exe scripts\eval\audit.py --run work\eval\runs\cert-001 --require-zero-intervention
```

## 5. 故障注入清单

| 故障 | 注入方法与命令 | 预期恢复 | 判定与超时 | 正式 run 允许 |
| --- | --- | --- | --- | --- |
| 掉线 | 断开桥接 WS（重启 Core）；或按 PID 结束桥接进程 | WS 断开后 3 秒重连 Core；进程被结束时 supervisor 30 秒内拉起 | 60 秒内恢复；无重复扣物品 | 是（自然发生） |
| 服务器重启 | 按 PID 停服务端，等待 5 秒后重启 | 桥接 5 秒重连 MC，bot 重生，从 checkpoint 续做 | 180 秒内继续；无重复物品 | 是 |
| 区块未加载 | 在未探索方向 3000 格外放目标方块并下发 `goto`；或临时把 `view-distance` 降到 2 | `waitForChunksToLoad` 最多 5 秒，超时算技能错误并换点 | 60 秒内恢复寻路 | 是 |
| 岩浆 | `/execute at Voxkin run setblock ~ ~ ~ lava` | 立即跳离；有水桶就放水；低血先吃 | 2 秒内离开岩浆；60 秒内恢复 | 是 |
| 仙人掌 | `/execute at Voxkin run fill ~ ~ ~ ~3 ~2 ~3 cactus` 生成通道 | pathfinder 避让；受伤后后撤，不反复穿越 | 30 秒内绕开；同类伤害 ≤2 次 | 是 |
| 苦力怕爆炸 | `/execute at Voxkin run summon creeper ~3 ~ ~3`，靠自然引信 | 后撤 ≥8 格；爆炸破坏床或门后重建 | 60 秒内脱离；建筑损失可修 | 是 |
| 背包满 | 遍历 `hotbar.0-8` 与 `inventory.0-26`：`/item replace entity Voxkin <slot> with cobblestone 64` | 丢低价值物或存箱；保留工具、食物、任务物品 | 120 秒内空出 ≥1 格 | 是（自然发生） |
| 工具损坏 | `/item replace entity Voxkin weapon.mainhand with minecraft:stone_pickaxe[minecraft:damage=130]`（1 点耐久） | 换备用工具；无备用则降级重做 | 120 秒内继续挖掘 | 是（自然发生） |
| 夜晚 | `/time set midnight` | 找床睡觉；无床则封闭空间等待 | 10 分钟内进入安全状态；夜间死亡 0 | 是 |
| 饥饿 | `/effect give Voxkin minecraft:hunger 120 4` | food ≤6 停战并进食；无食物则回基地 | 5 分钟内进食；不饿死 | 是 |
| 床被破坏 | 夜里 `/setblock <bed_x> <bed_y> <bed_z> air` | 重新合成床；无羊毛则挖洞过夜 | 10 分钟内恢复安全 | 是 |
| 传送门被拆 | 拆掉 2 格黑曜石；`/setblock <x> <y> <z> air` | 用打火石重开；无打火石则重做 | 15 分钟内回到主世界或下界 | 是 |
| 末影龙回血 | 留一块末地水晶不拆，或 `/summon end_crystal <portal_top>` | 先拆水晶再打龙；龙回血 >20% 触发重规划 | 10 分钟内水晶清空；龙血不再回满 | 是 |

注入调度由 `scripts/eval/inject.ps1` 执行，尖括号坐标从最近一次 `place_block` 记录填入，每条注入在 JSONL 写 `fault` 事件。正式 run 只允许自然发生或已声明的注入；认证 run 至少覆盖掉线、服务器重启、区块未加载、岩浆、仙人掌、苦力怕、背包满、工具损坏、夜晚、饥饿、床被破坏、传送门被拆、末影龙回血各一次。

## 6. 失败分类

| 类别 | 判定信号 | 归因方法 | 处置 |
| --- | --- | --- | --- |
| 规划错误 | 计划引用当前阶段拿不到的材料；同一 `(stage, step)` 连续 3 次相同计划；2 次尝试后 `missing_items` 不变 | 对照 `progress.py` 前置条件与背包；检查 `done_when` 是否可机器验证 | 阶段降级、换配方、记录 plan_id |
| 技能错误 | 工具返回 `ok=false`，或 `ok=true` 但 verifier 失败；桥接报未知动作/超时 | 回放该动作；对照桥接日志与方块/背包变化 | 重试一次换参数；连续 2 次回 Planner |
| 感知错误 | `state_age_ms` >30 秒；bot 背包与 `/data get entity` 不一致；目标方块不存在 | 对比状态帧、服务端查询与截图；检查维度与坐标换算 | 刷新状态、重新定位、禁止用旧坐标行动 |
| 恢复错误 | 同一故障恢复动作连续 2 次无进展；重生后 60 秒内再次死亡；恢复耗时超预算 | 读 `recovery` 段与死亡前后 20 步；检查 resume point 是否失效 | 升级恢复策略；放弃该资源，改走替代路线 |
| 环境不可控 | TPS <15、ping >500ms、模型 5xx 比例 >10%、结构缺失、断电 | 主机与服务器指标；`locate` 结果；时间窗比对 | 不计入 Agent 分数；超预算则本次 run 作废 |

## 7. 验收门槛

| 里程碑 | 范围 | 必须通过 | 上限 |
| --- | --- | --- | --- |
| M0 评测底座 | 无游戏进度 | 当前 90 个测试通过；JSONL schema 校验器可用；假桥接覆盖全部已注册工具（当前 12 个）；世界模板与重置脚本可用；零干预检测器对正反样例判定正确；回放 3/3 复现 | 1 天 |
| M1 木石 | S0-S1 | 空背包做出 `wooden_pickaxe`、`crafting_table`、`stone_pickaxe`、`stone_sword`、`furnace`；死亡 ≤1；卡住 ≤3；重规划 ≤6 | 25 分钟 |
| M2 食物与过夜 | S2 | 食物 ≥8；床放下并睡过一夜；庇护所可验证；死亡 ≤3；夜间死亡 0 | 45 分钟 |
| M3 铁装 | S3 | `iron_pickaxe`、`iron_sword`、`shield`；铁锭 ≥6；岩浆死亡 ≤1；死亡 ≤4 | 2 小时 |
| M4 钻石 | S4 | `diamond_pickaxe`、`enchanting_table`；钻石 ≥3；死亡 ≤6；无效调用 ≤5% | 3 小时 |
| M5 下界 | S5 | 下界门建成并使用；烈焰棒 ≥7；末影珍珠 ≥16；回到主世界；传送门被拆可恢复；死亡 ≤10 | 5 小时 |
| M6 要塞与末地门 | S6 前半 | 要塞定位；末地门激活；进入末地；死亡 ≤3 | 2 小时 |
| M7 末影龙 | S6 后半 | 水晶清空；末影龙死亡；龙回血事件被处理；战斗死亡 ≤4 | 1.5 小时 |
| M8 全流程 | S0-S6 | 单个 run_id 完成全部阶段；人工干预 0；死亡 ≤30；卡住 ≤20；重规划 ≤60；无效调用 ≤3%；token ≤12M；桥接可用率 ≥99%；状态 p95 ≤6 秒；动作超时 ≤2%；资源损失 ≤10%；1% 步数回放一致 | 24 小时 |

最终通关的最低标准，缺一不可：

1. 零干预：人工干预计数为 0，审计器与录屏一致；观察者全程 spectator，不聊天、不交易、不放置方块。
2. 连续运行：一个 `run_id` 从空背包到末影龙死亡；自动重启算同一 run，手动重启作废。
3. 可恢复中断：在前期、中期、末期各注入一次进程或服务器中断，10 分钟内继续，且任务物品不重复、不丢失。
4. 可复现失败：至少 1% 的步数做回放，verifier 结论一致；不一致的步必须归因到感知或环境类。
5. 证据封存：`summary.json` 与 `run.jsonl` 记录 SHA-256；原始日志保留 90 天；报告写明 LLM 是本地测试服务还是真实 API。

## 8. 长时运行

| 风险 | 观测 | 阈值与动作 |
| --- | --- | --- |
| Core 内存 | 每 60 秒 RSS、任务数、GC 后基线 | 24 小时增长 >200MB 或 >20% 触发重启；重启后自动续跑 |
| JSONL 膨胀 | 目录大小、每步字节数 | 2 秒一步约 4.3 万行/天、100–200MB；单文件 256MB 轮转并 gzip，保留 7 天 |
| SQLite 增长 | `page_count * page_size`、WAL 大小 | 开 `wal_autocheckpoint=1000`、`journal_size_limit=64MB`；每月归档并 `VACUUM` |
| 桥接重连 | 重连次数、成功耗时、未决动作数 | 当前固定 3 秒/5 秒；改为 1→30 秒指数退避加抖动，20 次失败后由 supervisor 重启 |
| TTS 崩溃 | 9880 健康检查、失败回合数 | 30 秒内自动重启；TTS 不可用时 `announce` 只写日志，不阻塞游戏动作 |
| 模型限流 | 429/5xx 比例、首 token、token 预算 | 2→60 秒退避，最多 6 次；持续 15 分钟降级到规则 Planner，暂停高风险任务 |

24 小时 soak：`eval-soak` 世界，脚本按 20 分钟间隔注入一次故障，循环执行“采集→合成→移动→过夜”；指标每 60 秒写 `soak.jsonl`。通过条件：无崩溃；桥接可用率 ≥99%；RSS 增长 ≤20%；SQLite 完整性检查通过；注入恢复率 100%；日志无孤儿动作。

```powershell
powershell -File scripts\eval\soak.ps1 -Hours 24 -FaultEvery 20m -Out work\eval\soak\soak-001
.\.venv\Scripts\python.exe scripts\eval\audit.py --run work\eval\soak\soak-001 --profile soak
```
