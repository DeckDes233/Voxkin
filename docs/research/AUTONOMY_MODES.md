# 自主行为与反射设计（Voxkin）

只读对象：`work/reference/mindcraft`（HEAD `f6a9556`，见 `docs/research/MINDCRAFT_AUDIT.md:5-14`）与 Voxkin 现有 bridge/Core。回答 mode 清单、反射事件、空闲自主、优先级抢占、阈值、本地/LLM 分界与验收。只新增本文件，不改生产代码。

证据约定：`M/` = `work/reference/mindcraft/src/`，`P/` = `work/reference/mindcraft/profiles/defaults/`；其余路径相对 Voxkin 仓库根目录。结论按 `文件:行号` 标注，无法确认处写“未确认”。Voxkin 侧正在并行实现自主/反射，本文不引用 bridge 的易变行号，其余 Voxkin 行号为写入时快照；Voxkin 段落为设计建议，结论证据以 MindCraft 源码与 benchmark 为准。

## 1. Mode 清单

MindCraft 的 mode 是每 tick 调用的函数，字段为 `on/active/paused/update`；列表顺序即优先级，`interrupts` 表示“我能打断哪些当前动作”（`M/agent/modes.js:13-24`）。轮询周期 300ms（`M/agent/agent.js:503-524`）。

| # | mode | 触发条件 | 优先级 | 打断当前动作 | 恢复条件 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | self_preservation | 头顶 water；头顶 sand/gravel/concrete_powder；脚或头为 lava/fire；3s 内受伤且 health<5 或单次伤害≥health | 1 | 是（all） | 动作结束回 idle；head-in-water 分支只跳跃、不 execute，不打断；idle 时清控制状态 | `M/agent/modes.js:25-89, 85-87` |
| 2 | unstuck | 非 idle；20s 内位移 <2 格且挖掘目标未变 | 2 | 是（all） | 位置变化或 idle 时计时清零；unpause 时重置计数 | `M/agent/modes.js:90-139` |
| 3 | cowardice | 16 格内 hostile 且 isClearPath | 3 | 是（all） | avoidEnemies 结束回 idle；profile 默认关闭，开启后基本覆盖 self_defense | `M/agent/modes.js:140-155`；`P/survival.json:5` |
| 4 | self_defense | 8 格内 hostile 且 isClearPath | 4 | 是（all） | defendSelf 暂停自身与 cowardice，idle 后 unPauseAll；条件仍满足则立即再触发 | `M/agent/modes.js:156-171`；`M/agent/library/skills.js:370-413` |
| 5 | hunting | 8 格内 isHuntable 动物 | 5 | 是（action:followPlayer） | 击杀或目标丢失；部分 profile 关闭 | `M/agent/modes.js:172-187`；`P/assistant.json:7` |
| 6 | item_collecting | 8 格内 item，空槽>1，持续 2s | 6 | 是（action:followPlayer） | 拾取完成或物品消失 | `M/agent/modes.js:188-218` |
| 7 | torch_placing | 6 格内无 torch、手上有 torch、脚下方块为 air；5s 冷却 | 7 | 是（action:followPlayer） | 放置后进入 5s cooldown | `M/agent/modes.js:219-237`；`M/agent/library/world.js:406-419` |
| 8 | elbow_room | 0.5 格内有玩家 | 8 | 是（action:followPlayer） | 随机 0-1s 后离开 0.5 格 | `M/agent/modes.js:238-258` |
| 9 | idle_staring | 10 格内最近实体，盯 4-5s；之后随机看 2-12s | 9 | 否 | 持续循环，不产生动作 | `M/agent/modes.js:259-295` |
| 10 | cheat | 手动开启（默认 off） | 10 | 无 | 无 | `M/agent/modes.js:296-303`；`P/_default.json:26` |

- 仲裁：只有列表首个 `active` 的 mode 会执行，后面的 `break`（`M/agent/modes.js:403-409`）；不产生 action 的 mode（如 head-in-water 跳跃）不占位。
- `interrupts` 含 `all` 的 mode 在任意动作执行中都能触发，其余只能在该动作标签匹配时触发（`M/agent/modes.js:403-407`）。
- `pause` 只跳过 update，不取消正在执行的动作；恢复靠 idle 事件里的 `unPauseAll()`（`M/agent/modes.js:361-379, 399-402`；`M/agent/agent.js:488-497`）。
- 技能内的 pause：defendSelf 暂停 self_defense/cowardice（`M/agent/library/skills.js:379-380`），avoidEnemies 暂停 self_preservation（`:1454`），stay 暂停 7 个 mode（`:1484-1490`）；unpause 依赖 idle 或技能显式调用。
- 所有 mode 动作结束后 `active=false`（`M/agent/modes.js:310-315`），随后 idle 事件 unPauseAll；条件仍满足时下一 tick 可再次触发。
- 被中断的动作不会 emit idle（`M/agent/action_manager.js:119-122`），pause 状态会保留到下一次正常结束；Voxkin 需要在抢占完成后主动重置 mode 状态。
- 每个 mode 动作进入 `runAction` 前先 `await stop()` 打断当前动作（`M/agent/action_manager.js:87-90, 26-37`）。

## 2. 反射事件表

MindCraft 没有统一的反射层：`health` 事件只记录受伤时间与伤害量（`M/agent/agent.js:444-453`），实际反应由 300ms 的 mode 轮询完成；进食例外，由 autoEat 插件在本地处理。

| 事件 | MindCraft 现有反应 | 延迟（现状 → 要求） | 经 LLM | Voxkin 建议（bridge 本地） | 证据 |
| --- | --- | --- | --- | --- | --- |
| 受伤 | 记录 lastDamageTime/lastDamageTaken；仅 3s 内受伤且 health<5 或单次伤害≥health 时 moveAway 20；小伤害交给 self_defense 的 8 格轮询 | 事件即时 → ≤100ms | 否 | 100ms 内判定来源：有 hostile 就还手或横移，无来源就后撤 4 格 | `M/agent/agent.js:444-453`；`M/agent/modes.js:79-84` |
| health 低于阈值 | health<5 且 3s 内受过伤 → moveAway 20 | 300ms → ≤300ms | 否 | ≤8 停战，≤5 退 20 格；用绝对阈值，不依赖“刚受伤” | `M/agent/modes.js:79-83` |
| food 低于阈值 | autoEat 插件：startAt 14、priority foodPoints、禁 rotten_flesh 等 5 种 | 插件 tick（未确认）→ ≤500ms | 否 | ≤14 进食，≤6 停战并吃背包食物；无食物回锚点求助 | `M/agent/agent.js:190-195`；`M/utils/mcdata.js:120` |
| 附近 hostile | 16 格逃跑（默认关）/8 格反击/8 格打动物 | 300ms + 100ms 寻路 → ≤300ms | 否 | 12 格警戒，6 格交战；被打，或 hostile 在 6 格内且距玩家 <4 格时才开战 | `M/agent/modes.js:147-168, 179-184` |
| 脚下悬空 | 无专门逻辑；unstuck 仅在原地 20s 后 moveAway 5；落沙检查的是头顶方块 | 无反应（20s）→ ≤200ms | 否 | 边缘 1 格且下方≥4 格空气 → 停步/后退 | `M/agent/modes.js:44-48, 90-139`（无 edge 检测） |
| 岩浆/火 | 脚或头为 lava/fire → 放水桶，否则 20 格内找水，否则 moveAway 5 | 300ms → ≤100ms 开始脱离 | 否 | 跳离并放水；播报一次 | `M/agent/modes.js:49-77` |
| 溺水 | 头顶 water 且无 pathfinder goal → `setControlState('jump', true)`，不 execute、不打断 | 300ms → ≤200ms 开始上浮 | 否 | 上浮到空气，保持水平移动 | `M/agent/modes.js:38-43` |
| 死亡/重生 | death 事件 cancelResume+stop；死亡消息记 last_death_position 并 handleMessage('system')；源码无显式 respawn 调用 | 事件即时；叙述秒级 → respawn ≤5s | 是（叙述，异步） | bridge 捕获 death，5s 内重生，只播报一次；跟随会话保留 10s | `M/agent/agent.js:465-487` |
| 玩家攻击自己 | 无 entityHurt 监听，也无反击路径；isHostile 不包含 player | 无反应 → ≤200ms 后撤 | 否 | 不还手：后撤 8 格、暂停跟随 10s、播报一次并记录玩家名 | `M/agent/agent.js:444-453`；`M/utils/mcdata.js:141-144` |

- `self_defense` 需要 `isClearPath` 成功才行动，路径预算 100ms（`M/agent/modes.js:163-164`；`M/agent/library/world.js:390-404`）；被墙挡住时可能挨打不还手。
- health<5 依赖 3s 内刚受伤，血量长期偏低但未受伤时不会撤退（`M/agent/modes.js:79`）。
- 被反射打断的任务不会本地续做；MindCraft 会发一条 `(AUTO MESSAGE)` 让 LLM 决定（`M/agent/modes.js:317-329`），只有 followPlayer 注册了 resume（`M/agent/commands/actions.js:102-112`；`M/agent/action_manager.js:44-59`）。

## 3. 空闲自主

### 3.1 SelfPrompter 机制

| 项 | 值 | 说明 | 证据 |
| --- | --- | --- | --- |
| 启动 | state=ACTIVE、loop 未运行、idle_time≥cooldown | `idle_time` 只在 idle 时累加 | `M/agent/self_prompter.js:89-106` |
| cooldown | 2000ms | 空闲阈值；每条命令后也 sleep 2s | `M/agent/self_prompter.js:12, 81, 97` |
| prompt | `You are self-prompting with the goal: '<goal>'. Your next response MUST contain a command with this syntax: !commandName. Respond:` | 固定模板，不带 state | `M/agent/self_prompter.js:66` |
| 上下文 | `conversing` system prompt + `$STATS` + `$SELF_PROMPT` + history | stats 含 health/food/entities/blocks | `M/models/prompter.js:137-145, 173-177`；`P/_default.json:4` |
| 每轮 | `handleMessage('system', msg, -1)`，max_responses=Infinity | 一次可连续下多条命令 | `M/agent/self_prompter.js:68`；`M/agent/agent.js:262-267` |
| 停止 | 连续 3 次无 `!command` | 防无效循环 | `M/agent/self_prompter.js:63-78` |
| 用户动作 | 用户命令是 action → stopLoop | 用户优先 | `M/agent/self_prompter.js:139-145` |
| mode 抢占 | 任何 mode execute 前 stopLoop | mode 与 self-prompt 二选一 | `M/agent/modes.js:306-309` |

- 有效间隔 = 动作耗时 + 2s + LLM 延迟，没有固定周期；2s 空闲阈值过短。
- 刷屏来源一：`say()` 默认发游戏内聊天（`narrate_behavior` 为 true，`work/reference/mindcraft/settings.js:53`；`M/agent/modes.js:7-11`）。
- 刷屏来源二：mode 触发会停 self-prompt，动作结束又重启，两个循环来回切（`M/agent/modes.js:306-309`；`M/agent/self_prompter.js:89-106`）。
- 重复动作：只有 <20ms 的快速循环检测（`M/agent/action_manager.js:64-80`），没有相同命令去重；目标结束靠显式 `!endGoal`（`M/agent/commands/actions.js:378-385`）。

### 3.2 Voxkin 建议

- 闲逛用 bridge 本地状态机，LLM 只给“目标”，不驱动每个 tick：`IDLE → LOOK → WANDER → RETURN → IDLE`。当前 bridge 已有本地 `idleTick` 与 20s 阈值，方向一致；建议核对回锚点、闲逛间隔与去重是否已覆盖。
- 触发：全空闲 20s；半径 6 格，单步 2-4 格，单次 8-15s；之后 45s ±15s 再来；出界 8 格立即 RETURN。
- LLM 只做目标级决策：Core 最多每 60s 下发一次 `goal`（如“去东边砍树”），或由玩家对话触发；执行、打断、回锚点都在 bridge。
- 理由：Core 的 state 周期是秒级（`bridge/minecraft_bridge.js` 的 `sendState` 默认 5s），真实 LLM 首 token p50 2594.7ms（`docs/BENCHMARK_RESULTS.md:84-91`），两者都支撑不了 100ms 闭环；MindCraft 的生存反应同样全在本地 tick 内完成（`M/agent/modes.js:21-23`）。
- 防刷屏：闲逛不聊天；自主日志写入 state 的 `autonomy` 字段，Core 只在目标切换或失败时播报，播报节流 30s。
- 防重复：动作按 `(tool, args, anchor)` 做 60s 去重；闲逛失败 3 次后冷却 2min；玩家说话后 60s 内不主动闲逛。

## 4. 优先级与抢占

目标顺序：生存 > 反击 > 吃东西 > 跟随玩家 > 当前任务 > 闲逛。MindCraft 的顺序为 self_preservation > unstuck > cowardice > self_defense > hunting > item_collecting > torch_placing > elbow_room > idle_staring（`M/agent/modes.js:24-303`），可对照，不照搬。

| 新事件 \ 当前状态 | 生存 | 反击 | 进食 | 跟随 | 任务 | 闲逛 |
| --- | --- | --- | --- | --- | --- | --- |
| 生存 | 合并 | 抢占 | 抢占 | 抢占 | 抢占 | 抢占 |
| 反击 | 让位 | 合并 | 抢占 | 抢占 | 抢占 | 抢占 |
| 进食 | 让位 | 让位 | 合并 | 抢占 | 抢占 | 抢占 |
| 跟随 | 让位 | 让位 | 让位 | 合并 | 抢占 | 抢占 |
| 任务 | 让位 | 让位 | 让位 | 让位 | 合并 | 抢占 |
| 闲逛 | 让位 | 让位 | 让位 | 让位 | 让位 | 合并 |

- 抢占动作 = 取消 pathfinder goal、清 control state、停 pvp/dig，再启动新动作（对照 `M/agent/agent.js:233-239`）。
- 生存内部顺序：岩浆/火 > 溺水 > 坠落 > 低血。
- 任务被抢占保存 resume point，由 Core 决定续做；挖掘类不自动重放（方块和背包可能已变化）。
- 跟随被反击打断后 3s 恢复；进食被反击打断后 2s 重试（food 仍 ≤14）。
- 必须排队：任务与闲逛只能等；进食等反击结束；跟随等进食结束；同类事件 FIFO，重复触发 1s 去抖。
- 脱困（unstuck）不单列优先级：跟随/任务进行中每 20s 检查，位移 <2 格则 moveAway 5，不抢生存/反击/进食；跟随时距离 <2 格暂停（对照 `M/agent/library/skills.js:1378-1383`）。
- 可主动抢占其他状态的是生存、反击、进食、跟随；任务与闲逛不主动抢占。
- MindCraft 反例：hunting、item_collecting、torch_placing 都能打断 follow（`M/agent/modes.js:175, 191, 222`），用户需要手动关 hunting 才能安静跟随（`P/_default.json:170-173`）。Voxkin 不采用这条。

```text
IDLE ──20s 无指令──> WANDER ──8-15s 或出界──> RETURN ──回锚点 8 格──> IDLE
  │                    │
  │                    └──受伤/敌对/饥饿──> SURVIVE / FIGHT / EAT ──危险解除──> RETURN
  └──玩家指令──> FOLLOW / TASK ──受伤/敌对/饥饿──> SURVIVE / FIGHT / EAT ──结束 3s──> 原状态
FOLLOW ──玩家 >8 格──> CATCH_UP ──<=6 格──> FOLLOW
FOLLOW ──玩家 >32 格──> 告警一次，继续追
SURVIVE ──health>10 且脱离危险 2s──> EAT（food<=14）或原状态
DEAD ──respawn──> IDLE；死亡前在 FOLLOW 则 5s 后恢复 FOLLOW
```

## 5. 阈值建议

| 参数 | 建议值 | 依据 | 证据 | 性质 |
| --- | --- | --- | --- | --- |
| health 停战 | ≤8 | MindCraft 在 <5 才撤，对同伴角色偏晚 | `M/agent/modes.js:79` | 调整 |
| health 紧急撤退 | ≤5，退 20 格 | moveAway 20 | `M/agent/modes.js:79-82` | 沿用 |
| food 进食 | ≤14 | autoEat startAt=14 | `M/agent/agent.js:193` | 沿用 |
| food 停战觅食 | ≤6 | 低于 6 不能 sprint（游戏机制） | 未确认（建议值） | 建议 |
| hostile 警戒 | 12 格 | 介于 cowardice 16 与 self_defense 8 之间 | `M/agent/modes.js:147, 163` | 调整 |
| hostile 交战 | 6 格 | 近战 reach 3，留 3 格反应（游戏机制） | `M/agent/modes.js:163` | 调整 |
| 逃跑距离 | 20-24 格 | moveAway 20 / avoidEnemies 24 | `M/agent/modes.js:82, 151` | 沿用 |
| 进食 cooldown | 8s | 进食约 1.6s + 6s 防抖；autoEat 内部 cooldown 未确认 | 未确认（建议值） | 建议 |
| 反击持续 | 10s 或目标消失 | defendSelf 无上限，容易追远；建议加时间上限 | `M/agent/library/skills.js:383-406` | 调整 |
| 闲逛半径 | 6 格，回锚 8 格 | 不脱离玩家/基地视野 | 未确认（建议值） | 建议 |
| 空闲触发 | 20s | SelfPrompter 2s 过短；与验收场景一致 | `M/agent/self_prompter.js:12` | 调整 |
| 闲逛间隔 | 45s ±15s | 防重复动作 | 未确认（建议值） | 建议 |
| 跟随距离 | 2-3 格；>8 加速；>32 告警 | MindCraft follow 默认 4；30 格暂停采集与插火把 | `M/agent/library/skills.js:1331, 1359-1371` | 调整 |

## 6. 本地反射与 LLM 决策分界

| 能力 | 执行位置 | 预算 | 经 LLM | 依据 |
| --- | --- | --- | --- | --- |
| 受击判定、还手/后撤 | bridge | 100ms | 否 | mineflayer 的 health/entityHurt 事件即时，本地 tick 直接读状态；不跨 WebSocket（`M/agent/agent.js:444-453`；`M/agent/modes.js:21-23`） |
| 岩浆/火/溺水/坠落 | bridge | 100-200ms | 否 | 每 tick 读脚/头方块（`M/agent/modes.js:32-77`） |
| 进食 | bridge | 500ms 检测，1.6s 动作 | 否 | autoEat 本地插件先例（`M/utils/mcdata.js:120`） |
| hostile 扫描与选目标 | bridge | 200ms | 否 | isClearPath 预算 100ms（`M/agent/library/world.js:402`） |
| 跟随保持 | bridge | 250-500ms | 否 | MindCraft follow 500ms 轮询（`M/agent/library/skills.js:1353-1354`） |
| 闲逛 FSM | bridge | 1s | 否 | 建议值；20s 阈值见 §5，低价值动作不需要更细的 tick |
| 目标选择（去哪/做什么） | Core | 30-120s | 是 | 真实 LLM 首 token p50 2594.7ms（`docs/BENCHMARK_RESULTS.md:86`） |
| 对话、叙述 | Core | 秒级 | 是 | TTS 首段 725.8ms（`docs/BENCHMARK_RESULTS.md:47`）；播报在 `src/voxkin/pipeline.py` 的 `_run_action` |
| 死亡叙述 | Core async | 秒级 | 是 | 不阻塞 respawn（`M/agent/agent.js:475-487`） |

```text
every 100ms:
  s = sense()                       # health/food/方块/实体，全部本地
  if s.in_lava or s.drowning or s.at_edge: preempt(SURVIVE)
  elif s.damaged or s.hostile_threat(6, 4): preempt(FIGHT)  # 6 格内且威胁玩家或已挨打
  elif s.food <= 14 and s.cooldown_ok: preempt(EAT)
  elif follow and s.gap > 8: ensure(FOLLOW)
  elif s.idle >= 20s: start(WANDER)  # 本地 FSM，不调 LLM
```

- 反射路径禁止 `await` WebSocket 或 LLM；只读本地状态，只写本地优先级队列。
- Core 只下发目标与参数（`set_goal`、`stop`、`follow`），不下发逐 tick 动作。
- 现有 `ActionDispatcher` 只有 `dispatch`，没有 cancel（`src/voxkin/agent/actions.py:40-48, 57-74`，写入时快照），抢占需要新增 `cancel(action_id)` 或全部放 bridge 本地。

## 7. 验收场景

| # | 场景 | 操作 | 期望 | 通过标准 |
| --- | --- | --- | --- | --- |
| 1 | 被僵尸打一下 | 生存模式 summon zombie 到 2 格并让它攻击一次 | 300ms 内转向反击或后撤 4 格，10s 内结束 | 日志有 reflex=retaliate；无 LLM 请求 |
| 2 | health 4 | `/damage Voxkin 16` | 2s 内停任务，退到 20 格外 | 距离 ≥20；无主动开战 |
| 3 | food 10 | 背包放 3 个熟牛肉，用 hunger 效果或消耗食物到 10 | 2s 内吃，food 回升；8s 内不重复吃 | eat 事件 1 次 |
| 4 | 跟随中玩家走远 30 格 | follow 后玩家走 30 格 | 10s 内追到 6 格内，不绕路采集 | 距离 ≤6；无拾取/插火把日志 |
| 5 | 空闲 20s | 无指令等待 20-30s | 走 2-4 格，60s 内回锚点 8 格内，不聊天 | 有 WANDER 记录；无 chat |
| 6 | 12 格 hostile | 玩家站在 bot 旁，12 格外放僵尸并让它走近 | 警戒但不开战；进 6 格且距玩家 <4 格才交战 | 6 格前无 attack 日志；朝向目标 |
| 7 | 苦力怕贴近 | 4 格内放 creeper | 0.5s 内后撤 ≥8 格，不攻击 | 距离 ≥8；无 attack |
| 8 | 岩浆/溺水 | 脚下放 lava；水中按住下沉 | 300ms 内开始跳离 lava；1s 内头部出水 | 离开 lava；头部露出水面 |
| 9 | 死亡重生 | `/kill Voxkin` | 5s 内重生，播报 1 次，跟随 10s 内恢复 | death 事件 1 条；follow 恢复 |
| 10 | 玩家 PvP | 玩家攻击一次 | 不还手，后撤 8 格，10s 内不跟随，播报 1 次 | 玩家 health 不变 |

## 8. 未确认

- Voxkin bridge 正在并行实现自主/反射，本文未逐项核对其实现行号；验收时以仓库代码为准。
- 死亡后的重生：源码无 `bot.respawn()` 调用，重生由 mineflayer 还是服务器触发未确认。
- autoEat 插件的检测间隔与内部 cooldown：依赖代码不在本地，未确认。
- 脚下悬空/边缘检测：MindCraft 无专门逻辑（负向证据），Voxkin 需要新增。
- 苦力怕引信撤退：defendSelf 只在距离 ≥4 时排除 creeper 追击，没有引信计时，未确认。
- Voxkin Core 与 bridge 的往返延迟：`docs/BENCHMARK_RESULTS.md` 无该指标，未测量。
