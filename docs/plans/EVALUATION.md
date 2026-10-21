# 独立通关评测体系

> 目标：证明沃心在玩家零干预下独立通关 Minecraft。本文定义评测、注入与门槛；M0-M8 与 G1 的交付顺序以 `docs/plans/INDEPENDENT_RUN_ROADMAP.md` 为准，架构以 `AUTONOMOUS_RUN_ARCHITECTURE.md` 为准。

## 0. 现状与缺口
| 能力 | 现状（写入时快照） | 评测要求 | 缺口 |
| --- | --- | --- | --- |
| 阶段推进 | `src/voxkin/agent/progress.py` 只有 S0-S6 背包判定；`agent/tasks.py` 有 TaskStore 三张表 | 阶段与任务持久化 | 无 TaskRunner、无 `/api/run/*` |
| 动作取消 | `actions.py` 只有 `dispatch`；桥接的 `attack_nearest`/`stop` 可打断当前动作 | 抢占、超时后清场、step 级取消 | 无 Core 侧 `cancel`，无 step 进度 |
| 技能覆盖 | `bridge/minecraft_bridge.js` 12 个动作；顶层直接连 Core 与建 bot | craft/smelt/chest/sleep/trade/portal/bow | 均未实现；技能函数不可单测 |
| 死亡恢复 | `death` 事件停跟随与闲逛（`bridge:1071`）；重生依赖 mineflayer 默认行为 | 5 秒重生、续做、回收掉落 | 无显式 `respawn`、无任务恢复 |
| 状态帧 | 5 秒一帧（`bridge:1027`），无背包与耐久 | 每步可追溯 | 无 `runlog`、无 `state_age` |
| 轨迹 | `MetricsStore` 环形 200 条 | JSONL 全量、checkpoint | 无 `runlog`、无世界快照 |
| 测试世界 | `work/mc/server` 为 easy、`allow-nether=false`、种子为空 | 固定种子与模板 | 无 `world_template`、无重置脚本 |
| 审计 | 无 | 人工干预必须为 0 | 无检测器 |

现有 92 个测试（含 TaskStore 2 个）覆盖语音、协议与阶段表，没有一条能证明零干预通关。

## 1. 测试分层

| 层 | 被测对象 | 替身/环境 | 运行方式 | 耗时 | 通过标准 |
| --- | --- | --- | --- | --- | --- |
| L0 技能单元 | schema、参数、重试、超时、取消、verifier 规则 | 假 bot（`bridge/skills` 纯函数）、假桥接（WS）、`ToneTTS` | `pytest tests -q`；`node --test bridge/skills` | < 30 秒 | 每个技能正常、可恢复失败、不可恢复失败各 1 例；不连真实 MC |
| L1 场景测试 | 单技能在固定世界的真实效果 | `scenario` 模板、预置箱子 | `run_stage.py --scenario collect_oak` | 3–10 分钟/例 | 世界侧断言通过，背包与世界方块同时变化 |
| L2 阶段验收 | M2-M8 的阶段完成条件 | `scenario`，模板重置 | `run_stage.py --stage S0 --runs 10` | 10 分钟–2 小时/阶段 | 该阶段全部硬条件 + 指标门槛 |
| L3 全流程演练 | G1 从空背包到末影龙 | `g1` 模板、真实 LLM/TTS | `POST /api/run/start` | 8–12 小时 | G1 门槛；允许观察，不允许操作 |
| L4 长时稳定 | 断线、重启、限流、内存与日志增长 | `soak` 模板、注入调度 | `soak.ps1 -Hours 24` | 24 小时 | 无崩溃、可用率与增长阈值达标 |

```powershell
# L0：当前仓库可直接执行
.\.venv\Scripts\python.exe -m pytest tests -q
node --check bridge\minecraft_bridge.js
# L1-L4：M0/M1 交付的 CLI；脚本缺失时该层记为未执行，不得用人工操作补证
powershell -File scripts\mc_reset.ps1 -Template work\mc\world_template
.\.venv\Scripts\python.exe scripts\run_stage.py --stage S0 --runs 10
Invoke-RestMethod -Method Post http://127.0.0.1:8765/api/run/start -ContentType 'application/json' -Body '{"objective":"独立通关 Minecraft"}'
Invoke-RestMethod http://127.0.0.1:8765/api/run/status
powershell -File scripts\soak.ps1 -Hours 24 -FaultEvery 20m
```

## 2. 固定世界

| 模板 | 用途 | 种子 | 初始状态 | 预置箱子 | 难度 |
| --- | --- | --- | --- | --- | --- |
| `scenario` | L1/L2/M2-M8 | 20261021 | 空背包，出生点平台 | 有，按阶段配给 | normal |
| `g1` | G1 正式 | 20261021 | 空背包，仅出生点平台 | 无 | normal |
| `soak` | L4 | 20261021 | 同 `g1` | 无 | normal |

- 出生点：`/setworldspawn 0 72 0`；平台 `/fill -8 70 -8 8 70 8 stone`，`/fill -8 71 -8 8 76 8 air`。
- 结构坐标：Paper 1.21.1-133、种子 20261021 实测；y 以实际生成/进入为准，评测比较 x、z 与容差，实测值写入 `work/mc/world_manifest.json`。
- **可见性边界**：manifest 只给 Verifier 与审计，不进入 Planner/Executor 上下文；G1 禁止 `/locate`、禁止把坐标写进提示词，也不预置村庄或结构。

| 结构 | 实测坐标 | 定位命令（仅场景脚本） | 容差 |
| --- | --- | --- | --- |
| 村庄 | `(272, ~, 320)` | `/locate structure minecraft:village_plains` | 64 格 |
| 下界要塞 | `(144, ~, 144)`（下界） | `/execute in minecraft:the_nether run locate structure minecraft:fortress` | 96 格 |
| 要塞 | `(-2112, ~, -976)` | `/locate structure minecraft:stronghold` | 32 格 |
| 末地入口 | `(100, ~, 0)`（Java 版固定） | 首次进入时核对 | — |
| 出生点 | `(0, 72, 0)` | `/setworldspawn 0 72 0` | 0 |

| 规则项 | `g1` | `scenario` | 理由 |
| --- | --- | --- | --- |
| `level-seed` | 20261021 | 20261021 | 结构与地形可复现 |
| `difficulty` | normal | normal | 与路线图 G1 一致 |
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

预置箱子只存在于 `scenario`，坐标固定：`(2,71,2)` 阶段物资、`(-2,71,2)` 恢复物资、`(2,71,-2)` 空箱（背包满用）。阶段箱只放上一阶段产物（例如 S3 放 8 个铁矿石、8 个煤、1 个熔炉），用来隔离测试目标；恢复箱放 `water_bucket`、`flint_and_steel`、`obsidian 10`、`cooked_beef 8`、`bed`、`diamond_pickaxe`、`oak_planks 16`。`g1` 不放任何评测箱；读取自然生成的箱子属于正常玩法，计入资源日志；只有读取模板预置坐标的箱子才判失败。

```powershell
# 模板只生成一次；每次 run 前重置
powershell -File scripts\mc_reset.ps1 -Template work\mc\world_template -World work\mc\server\world
# 手工兜底：停服后复制模板；删除前校验绝对路径
$target = (Resolve-Path "work\mc\server\world").Path; if ($target -notlike "*\work\mc\server\world") { throw "拒绝删除 $target" }
Remove-Item $target -Recurse -Force; Copy-Item work\mc\world_template $target -Recurse
```

## 3. 指标

| 指标 | 定义 | 采集点 | 门槛（首轮） |
| --- | --- | --- | --- |
| 阶段耗时 | `stage_start` 到 `stage_complete` 的单调时钟差 | `stages.json` | M2 ≤10 分钟，M3 ≤15 分钟，M4 3 游戏日，M5 ≤20 分钟，M6 ≤25 分钟，M7 烈焰棒 ≤40 分钟/珍珠 ≤90 分钟，M8 龙 ≤60 分钟，G1 ≤12 小时（软目标 8 小时） |
| 死亡次数 | `death` 事件数；另记重生到恢复任务的秒数 | `deaths.json` | M2/M3 0，M4 ≤1，M5 ≤1，M6 岩浆死 0，M7 ≤2，M8 ≤2，G1 ≤20；单次恢复 ≤5 分钟；同点 10 分钟内 3 次判死亡循环 |
| 卡住次数 | 同一 step 90 秒位移 <2 格且 verifier 无进展 | 状态帧 + verifier | 同一 step ≤5 次，G1 总卡住 ≤30；单次 ≤15 分钟 |
| 重规划次数 | 失败触发的 Planner 调用，按 `plan_id` 去重 | `actions.jsonl` | ≤3 次/阶段，G1 ≤21；同一 `(stage, step)` 连续 3 次相同计划判规划错误 |
| LLM 调用与 token | Planner/Executor 调用次数与 token；按阶段汇总 | LLM usage | Planner ≤3/阶段、≤60/小时；Executor ≤40/小时；G1 ≤2M token、单请求 ≤32k 上下文 |
| 无效工具调用率 | schema 非法、未知工具、缺参、60 秒内重复且状态无变化的调用 / 总调用 | `actions.jsonl` | M2-M8 ≤5%；G1 ≤3% |
| 资源效率 | 关键物品产出/消耗；任务物品因死亡或丢弃的损失率 | 背包快照 | 损失率 ≤10%；blaze rod、ender pearl 单独计数 |
| 人工干预次数 | 见下方五条判定 | 审计器 | 必须为 0 |
| 墙钟时间 | `/api/run/start` 到 `dragon_dead` 且回到主世界 | `report.json` | G1 ≤12 小时（硬超时），软目标 8 小时 |
| 桥接可用率 | 桥接 WS 在线时长 / 运行时长 | 心跳 | ≥99% |
| 状态新鲜度 | `state_age_ms` 的 p95 与最大值 | 状态帧 | p95 ≤6 秒，最大 ≤30 秒 |
| 检查点恢复 | 中断到续跑首个 verified step 的耗时；重复动作数 | checkpoint + 日志 | ≤5 分钟；重复动作 ≤1 |

人工干预的五条判定：非 bot 玩家在聊天中发出任何被 pipeline 当作指令的文本；`run_start` 后服务端控制台执行 give/tp/setblock/time/weather/effect/gamerule/difficulty/kill/summon 等写命令（计划内 `inject=true` 的注入除外）；手动启停 Core、桥接或服务端（supervisor 自动重启除外）；直接改存档、玩家数据或物品栏；观察者离开 spectator 或与 bot 交互。任一条命中即该 run 作废。

## 4. 日志与回放

每次 run 一个目录：`runs/<run_id>/`，含 `state.jsonl`（5 秒采样）、`actions.jsonl`（每动作一行）、`stages.json`、`deaths.json`、`checkpoint.json`、`report.json`、`video/`。`runlog.py` 负责写入；`report.json` 是审计入口，固定字段：run_id、seed、manifest_hash、起止时间、各阶段耗时、死亡与恢复、卡住与重规划、LLM 调用与 token、无效调用率、资源损失率、人工干预计数、桥接可用率、RSS 峰值、日志与 SQLite 大小、回放抽样、`pass/fail` 与失败分类计数。

    {"ts":"2026-10-22T01:02:03.456+08:00","run_id":"g1-01","seq":842,"event":"verify","stage":"S3","plan_id":"p17","step":3,"state":{"pos":[12.5,64.0,-3.2],"dim":"overworld","health":18.0,"food":14.0,"time":18000,"day":3,"inv":{"iron_ore":5},"state_age_ms":120,"tps":19.8},"plan":{"goal":"smelt 3 iron_ingot","done_when":"inventory.iron_ingot>=3"},"tool":{"name":"smelt","args":{"item":"iron_ingot","count":3}},"result":{"ok":true,"detail":"烧出 3 个铁锭"},"verifier":{"rule":"inv_delta","pass":true,"evidence":{"before":{"iron_ingot":0},"after":{"iron_ingot":3}}},"llm":{"calls":1,"prompt_tokens":812,"completion_tokens":44},"wall_ms":91234}

| 事件 | 必填字段 | 用途 |
| --- | --- | --- |
| `run_start` / `run_end` | run_id、seed、manifest_hash、版本、摘要 hash | 封存证据 |
| `stage_start` / `stage_complete` | stage、inventory、耗时 | 阶段验收 |
| `plan` | plan_id、goal、done_when、steps | 规划追溯 |
| `tool_call` / `tool_result` | tool、args、ok、detail、超时 | 技能归因 |
| `verify` | rule、pass、before/after、来源（observe 或服务端） | 成功判定 |
| `recovery` | fault_id、动作序列、结果 | 恢复归因 |
| `death` | 坐标、维度、掉落、重生耗时 | 死亡统计 |
| `fault` | 类型、注入命令、`inject=true` | 区分人为与自然故障 |

回放一次失败：`report.json` 找 `first_fail_seq`；取不晚于它的最近阶段快照（阶段开始各一份，另每 300 步一份）；用快照副本恢复世界，无快照时从 `world_template` 重放；按 seq 重放 `tool_call` 的 args，跳过 LLM，逐条比较 verifier；不一致的步归到感知或环境类并标记 `nondeterministic`。每次失败在 `report.json` 写 `class`、`signal`、`evidence_seq`、`owner`；归因顺序为 verifier 失败类型 → 最近 20 步回放 → 状态与服务器真值对比。checkpoint 只存计划与基线，恢复时不回滚世界；快照只用于回放分析。

```powershell
.\.venv\Scripts\python.exe scripts\replay_run.py --run runs\g1-01 --seq 842 --compare verifier
.\.venv\Scripts\python.exe scripts\audit_run.py --run runs\g1-01 --require-zero-intervention
```

## 5. 故障注入清单
| 故障 | 注入方法与命令 | 预期恢复 | 判定与超时 | G1 允许 |
| --- | --- | --- | --- | --- |
| 掉线 | 断开桥接 WS（重启 Core）；或按 PID 结束桥接进程 | 3/6/12/24 秒退避重连；进程被结束时 supervisor 拉起；不重放消耗性步骤 | 60 秒内恢复；重复动作 ≤1 | 是（自然） |
| 服务器重启 | 按 PID 停服务端，等待 5 秒后重启 | 桥接按 3/6/12/24 秒重连，bot 重生，从 checkpoint 续做 | 180 秒内继续；无重复物品 | 是（自然） |
| 区块未加载 | 在未探索方向 3000 格外放目标方块并下发 `goto`；或临时把 `view-distance` 降到 2 | `waitForChunksToLoad` 最多 5 秒；等待 5 秒→前进 8 格→重试 observe | 60 秒内恢复寻路；未知方块不挖 | 是（自然） |
| 岩浆 | `/execute at Voxkin run setblock ~ ~ ~ lava` | 100ms 反射跳离；有水桶先放水；4 秒未脱困撤离 | 2 秒内离开岩浆；60 秒内恢复 | 是（自然） |
| 仙人掌 | `/execute at Voxkin run fill ~ ~ ~ ~3 ~2 ~3 cactus` | pathfinder 避让；受伤后后撤，不反复穿越 | 30 秒内绕开；同类伤害 ≤2 次 | 是（自然） |
| 苦力怕爆炸 | `/execute at Voxkin run summon creeper ~3 ~ ~3`，靠自然引信 | 后撤 ≥8 格；爆炸破坏床或门后重建 | 60 秒内脱离；建筑损失可修 | 是（自然） |
| 背包满 | 遍历 `hotbar.0-8` 与 `inventory.0-26`：`/item replace entity Voxkin <slot> with cobblestone 64` | 存已知箱子；无箱子按白名单丢弃，关键物品禁丢 | 120 秒内空出 ≥1 格 | 是（自然） |
| 工具损坏 | `/item replace entity Voxkin weapon.mainhand with minecraft:stone_pickaxe[minecraft:damage=130]`（1 点耐久） | 换同级备用 → 升下一档 → 触发做工具任务 | 120 秒内继续挖掘 | 是（自然） |
| 夜晚 | `/time set midnight` | 有床睡觉；无床三格掩体；夜里不开始远距离探索 | 10 分钟内进入安全状态；夜间死亡 0 | 是（自然） |
| 饥饿 | `/effect give Voxkin minecraft:hunger 120 4` | food ≤14 进食，≤6 停战；无食物则觅食插队 | 5 分钟内进食；不饿死 | 是（自然） |
| 床被破坏 | 夜里 `/setblock <bed_x> <bed_y> <bed_z> air` | 重新合成床；无羊毛则挖洞过夜 | 10 分钟内恢复安全 | 是（自然） |
| 传送门被拆 | 拆掉 2 格黑曜石；`/setblock <x> <y> <z> air` | 用打火石重开；无打火石则重做 | 15 分钟内回到主世界或下界 | 是（自然） |
| 末影龙回血 | 留一块末地水晶不拆，或 `/summon end_crystal <portal_top>` | 先拆水晶再打龙；龙回血 >20% 触发重规划 | 10 分钟内水晶清空；龙血不再回满 | 是（自然） |

注入调度由 `scripts/inject.ps1` 执行，尖括号坐标从最近一次 `place_block` 记录填入，每条注入在 `actions.jsonl` 写 `fault` 事件。G1 只允许自然发生的故障；认证 run 额外注入全部 13 项各一次，注入不算人工干预。

## 6. 失败分类

| 类别 | 判定信号 | 归因方法 | 处置 |
| --- | --- | --- | --- |
| 规划错误 | JSON/schema 非法；skill 不在 manifest；`post` 为空或规则未知；阶段回退 | 对照 Planner 输出规范与 `progress.py` 前置条件；检查 `done_when` 是否可机器验证 | 带错误重问 1 次；仍失败用方法库默认展开 |
| 技能错误 | 工具返回 `ok=false`，或 `ok=true` 但 verifier 失败；桥接报未知动作/超时 | 回放该动作；对照桥接日志与方块/背包变化 | 重试一次换参数；连续 2 次回 Planner |
| 感知错误 | `state_age_ms` >30 秒；`blockAt` 返回 null；bot 背包与 `/data get entity` 不一致 | 对比状态帧、服务端查询与截图；检查维度与坐标换算 | 刷新 observe、重新定位、禁止用旧坐标行动 |
| 恢复错误 | checkpoint 与背包基线不符；同一 step 恢复 2 次无进展；重生后 60 秒内再次死亡 | 读 `recovery` 段与死亡前后 20 步；检查 resume point 是否失效 | 升级恢复策略；放弃该资源，改走替代路线 |
| 环境不可控 | TPS <15、ping >500ms、模型 5xx 比例 >10%、结构缺失、断电 | 主机与服务器指标；`locate` 结果；时间窗比对 | 不计入 Agent 分数；超预算则本次 run 作废 |

## 7. 验收门槛

| 里程碑 | 范围 | 必须通过 | 运行时限 |
| --- | --- | --- | --- |
| M0 可复现世界 | 无游戏进度 | 92 个测试通过；种子/版本/模板固定；同 seed 重置 3 次出生点一致；30 分钟纯观测日志完整率 ≥99%；`runlog` 与 `report.json` 可用 | — |
| M1 任务循环 | S0 片段 | TaskRunner 跑 30 分钟；断桥、重启 Core、`/kill` 各一次后自动续跑；重复动作 ≤1；`/api/run/*` 可用 | — |
| M2 木镐 | S0 | 空背包 ≤10 分钟做出木镐与工作台；10 次 ≥8 次；无人工给料 | 10 分钟/次 |
| M3 石器与第一夜 | S1 | ≤15 分钟石镐、石剑、熔炉；连续 3 夜不死 | 15 分钟/阶段 |
| M4 食物与床 | S2 | 跨 3 游戏日 food ≥8；睡眠 3/3；死亡 ≤1，死后 5 分钟恢复 | 3 游戏日 |
| M5 铁装 | S3 | ≤20 分钟铁镐、铁剑、盾；铁锭 ≥6；死亡 ≤1 | 20 分钟/次 |
| M6 钻石 | S4 | ≤25 分钟 ≥3 钻石并成镐；5 次 ≥4；岩浆死 0 | 25 分钟/次 |
| M7 下界 | S5 | 7 烈焰棒 ≤40 分钟；16 珍珠 ≤90 分钟；死亡 ≤2；能回主世界 | 2 小时/次 |
| M8 末地 | S6 | 从主世界 checkpoint 60 分钟内击杀末影龙；3 次 ≥2 | 60 分钟/次 |
| G1 全流程 | S0-S6 | 单个 run_id 从空背包到龙死并回主世界；人工干预 0；死亡 ≤20；无 `/locate`、无预置结构/箱子；1% 步数回放一致；桥接可用率 ≥99% | 12 小时（软 8 小时） |

最终通关的最低标准，缺一不可：

1. 零干预：人工干预计数为 0，审计器与录屏一致；观察者全程 spectator，不聊天、不交易、不放置方块。
2. 连续运行：一个 `run_id` 从空背包到末影龙死亡并回到主世界；自动重启算同一 run，手动重启作废。
3. 可恢复中断：G1 主记录不注入；另跑 3 次认证注入（前期、中期、末期各一次），10 分钟内继续，任务物品不重复、不丢失。
4. 可复现失败：至少 1% 的步数做回放，verifier 结论一致；不一致的步必须归因到感知或环境类。
5. 证据封存：`report.json` 与 `state.jsonl`/`actions.jsonl` 记录 SHA-256；原始日志保留 90 天；报告写明 LLM 是本地测试服务还是真实 API。

## 8. 长时运行

| 风险 | 观测 | 阈值与动作 |
| --- | --- | --- |
| Core 内存 | 每 60 秒 RSS、任务数、GC 后基线 | 24 小时增长 >200MB 或 >20% 触发重启；重启后自动续跑 |
| JSONL 膨胀 | 目录大小、每步字节数 | 2 秒一步约 4.3 万行/天、100–200MB；单文件 256MB 轮转并 gzip，保留 7 天 |
| SQLite 增长 | `data/tasks.db`、`data/voxkin.db` 的 `page_count * page_size` 与 WAL | 开 `wal_autocheckpoint=1000`、`journal_size_limit=64MB`；每月归档并 `VACUUM` |
| 桥接重连 | 重连次数、成功耗时、未决动作数 | 3/6/12/24 秒退避；20 次失败后由 supervisor 重启；断线不重放消耗性步骤 |
| TTS 崩溃 | 9880 健康检查、失败回合数 | 30 秒内自动重启；TTS 不可用时 `announce` 只写日志，不阻塞游戏动作 |
| 模型限流 | 429/5xx 比例、首 token、token 预算 | 2→60 秒退避，最多 6 次；持续 15 分钟降级到规则 Planner，暂停高风险任务 |

24 小时 soak：`soak` 模板，脚本按 20 分钟间隔注入一次故障，循环执行“采集→合成→移动→过夜”；指标每 60 秒写 `state.jsonl`。通过条件：无崩溃；桥接可用率 ≥99%；RSS 增长 ≤20%；SQLite 完整性检查通过；注入恢复率 100%；日志无孤儿动作。

```powershell
powershell -File scripts\soak.ps1 -Hours 24 -FaultEvery 20m -Out runs\soak-001
.\.venv\Scripts\python.exe scripts\audit_run.py --run runs\soak-001 --profile soak
```
