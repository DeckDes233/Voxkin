# 沃心技能总表

本文是技能清单的事实来源。技能名、分类、类型、参数、失败条件、可否取消、验收描述以 `bridge/skills/manifest.json` 为准；真实行为以 `bridge/minecraft_bridge.js` 为准；模型看到的工具定义以 `src/voxkin/agent/tools.py` 为准。

> 历史审计基线（2026-10-22 21:50）：当时记录 36 条模块技能、57 条清单技能与 245 个 Python 测试；下方 21 条基线明细保留为拆分前快照。当前状态（2026-10-23）：清单已有 58 条（21 个内建 + 37 个模块技能），Python 测试 270 passed，剪羊技能另有 8 个桥接模拟测试。S2 剪羊与铁矿采集路线仍无真实服务器证据；S1 实机证据见 `docs/evidence/S1_NORMAL_20261022.md`。

## 0. 基线与口径

### 0.1 基线

提交 `11c83c8`，加上 2026-10-22 工作区中尚未提交的改动：`bridge/minecraft_bridge.js`、`src/voxkin/agent/actions.py`、`src/voxkin/agent/run_manager.py`、`src/voxkin/agent/runner.py`、`src/voxkin/bridge/protocol.py`、`src/voxkin/runtime.py`，新增 `bridge/skills/manifest.js`、`bridge/skills/manifest.json`、`scripts/dump_manifest.js`、`src/voxkin/agent/skills.py`、`tests/test_skill_manifest.py`、`tests/test_action_status.py`。

本文所有行号都指上述基线。`bridge/minecraft_bridge.js` 在 2026-10-22 下午被改过，新增了 `statusForError` 与带 `status` 的 `reply`，第 399 行之后的行号整体后移 12 行。

### 0.2 事实来源优先级

1. `bridge/skills/manifest.json`：技能名、分类、类型、参数、超时、能否取消、验收描述。
2. `bridge/minecraft_bridge.js`：真实行为。`runAction` 的 21 个 `case` 分支在第 280 至 386 行。
3. `src/voxkin/agent/tools.py`：模型看到的 20 个工具定义，覆盖清单里除 `chat` 之外的 20 个技能。
4. `src/voxkin/agent/skills.py`：清单读取器与 schema 生成器。`load_manifest`（第 28 行）、`skill_ids`（第 47 行）、`find_skill`（第 51 行）、`tool_schemas`（第 71 行）。

### 0.3 验收分级

| 级别 | 内容 | 适用 |
| --- | --- | --- |
| A1 | 清单与实现的一致性自检 | 全部 21 个技能 |
| A2 | Core 侧派发与状态判定 | 全部 21 个技能 |
| B | 真实 Paper 1.21.1 服务器上的行为验收 | 全部 21 个技能 |
| C | 需要仓库外的真实条件 | 仅 `chat` |

A1 命令与期望：

```
node scripts/dump_manifest.js
.\.venv\Scripts\python.exe -m pytest tests/test_skill_manifest.py -q
git diff --exit-code bridge/skills/manifest.json
```

期望：脚本打印「技能总数 21」「按 group：{"基础类":13,"实用类":8}」「按 type：{"sense":4,"act":8,"path":6,"wait":2,"voice":1}」；pytest 5 个用例通过；`bridge/skills/manifest.json` 没有改动。

A2 命令与期望：

```
.\.venv\Scripts\python.exe -m pytest tests/test_action_status.py tests/test_actions.py tests/test_runner.py -q
```

期望：27 个用例通过（12 + 8 + 7）。这一步证明技能名能进入派发链路、回帧状态能被归入七档、步骤状态会被写进 JSONL 记录。

B 级统一准备：

```
.\scripts\eval_stack.ps1 start
Invoke-RestMethod http://127.0.0.1:8765/api/bridge/state
```

期望：`connected` 为 `true`，`ready` 为 `true`，`age_s` 小于 15。

B 级触发：把该技能的 `StepSpec` 写进 `src/voxkin/agent/plans.py` 的 `PLANS`（例如新增一个 `"probe"` 阶段），然后执行

```
.\.venv\Scripts\python.exe scripts\run_stage.py --stage probe --runs 1 --difficulty normal
```

`run_stage.py` 每次运行前会删掉评测服的世界目录并重启 Paper，难度由 `--difficulty` 决定。也可以用真实模型在游戏内说一句会触发该技能的话，走 `src/voxkin/pipeline.py` 的模型工具调用路径。

B 级观察：`runs/<stage>-<时间戳>.json` 里的 `passed`、`detail`；同目录 `runs/<stage>-<时间戳>.jsonl` 里每一步的 `status`、`ok`、`detail`。

## 1. 总览与统计

### 1.1 数量

| 项 | 数量 | 依据 |
| --- | --- | --- |
| 清单技能总数 | 58 | `bridge/skills/manifest.json`，21 个内建 + 37 个模块技能（2026-10-23） |
| 桥接动作分支数 | 21 | `bridge/minecraft_bridge.js` 的内建 `case`，模块技能走注册表 default 分支 |
| Core 侧工具定义数 | 54 | `src/voxkin/agent/tools.py` 的 `build_tools()`，`chat` 不在其中 |
| 阶段计划条数 | 53 | `src/voxkin/agent/plans.py`，S0–S6 |
| 阶段表条数 | 7 | `src/voxkin/agent/progress.py`，S0 到 S6 |

### 1.2 按分类

| 分类 | 数量 | 技能 |
| --- | --- | --- |
| 基础类 | 13 | observe、inventory、locate_block、locate_entity、look_at_player、goto、goto_block、follow_player、come_to_player、stop、eat、sleep、chat |
| 实用类 | 8 | attack_nearest、attack_target、collect_blocks、break_block、place_block、pickup_items、craft、smelt |
| 专精类 | 37 | 采集、合成、生存、战斗、移动、箱子、下界、末地模块；逐条见 `bridge/skills/manifest.json` |

### 1.3 按类型

| 类型 | 数量 | 技能 |
| --- | --- | --- |
| sense | 6 | observe、inventory、locate_block、locate_entity、find_diamond、list_chest |
| act | 43 | 基础动作与模块技能，逐条见 `bridge/skills/manifest.json` |
| path | 6 | goto、goto_block、follow_player、come_to_player、collect_blocks、pickup_items |
| wait | 2 | sleep、smelt |
| voice | 1 | chat |
| plan | 0 | 阶段编排放在 Core 的 `src/voxkin/agent/plans.py` |

### 1.4 按状态

| 状态 | 数量 | 技能 |
| --- | --- | --- |
| existing | 10 | observe、locate_block、locate_entity、look_at_player、stop、eat、sleep、collect_blocks、place_block、craft |
| partial | 10 | inventory、goto、goto_block、follow_player、come_to_player、attack_nearest、attack_target、break_block、pickup_items、smelt |
| missing | 0 | 无 |
| blocked | 1 | chat |

专精类为空是独立通关最大的阻塞点，见第 6 节。

## 2. 技能总表

每条包含四项：来源位置、当前实际行为、缺失能力、验收方法。

### 2.1 基础类

#### observe

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / sense |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:314` |
| 实现函数 | `bridge/minecraft_bridge.js:1726` `observeSurroundings` |
| Core 工具 | `src/voxkin/agent/tools.py:276` |

当前行为：半径截断到 1 至 64 格。输出一段中文文本，包含维度、坐标、朝向、血量、饥饿值、天数与时刻、昼夜、天气、手持物、护甲槽、背包前 8 项、附近玩家与敌对生物各取最近的 4 个。传 `block` 时追加该方块在半径内的 3 个坐标。方块 ID 不在注册表里就抛出「未知方块」。

缺失能力：没有附近方块的完整清单，只能按指定方块 ID 查；没有装备槽逐项明细。

验收方法：B 级，用 `observe` 加 `{"radius": 16}` 触发。期望 detail 里同时出现坐标、血量、饥饿值、天数时刻、背包摘要、附近玩家或敌对生物段落；再传 `{"block": "iron_ore"}` 一次，期望追加 3 个坐标或明确说附近没有。

#### inventory

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / sense |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:307` |
| 实现函数 | `bridge/minecraft_bridge.js:310`（内联） |
| Core 工具 | `src/voxkin/agent/tools.py:98` |

当前行为：读 `bot.inventory.items()`，把每种物品拼成「名字 x数量」，用顿号连接后截断到 400 字；背包为空时返回「背包是空的」。

缺失能力：中文标签用的是 `blockLabel`（`bridge/minecraft_bridge.js:59`），只覆盖方块 ID。`stick`、`coal`、`raw_iron`、`cooked_beef` 这类非方块物品会原样显示英文 ID。`observe` 用的 `itemLabel`（第 122 行）能翻译工具、盔甲与食物，两处口径不同。结果超过 400 字会被截断，后面的物品直接看不见。

验收方法：B 级，背包里放 1 个木棍与 1 个煤再触发。期望 detail 里出现中文名，`stick`、`coal` 这两个英文 ID 不出现在结果里；放 30 种物品时 detail 长度到 400 字后被截断并记录这一事实。

#### locate_block

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / sense |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:359` |
| 实现函数 | `bridge/minecraft_bridge.js:1791` `locateBlock` |
| Core 工具 | `src/voxkin/agent/tools.py:298` |

当前行为：按方块 ID 在半径内查找，半径截断到 1 至 64 格，候选数截断到 1 至 16 个。按距离升序排列，返回每个候选的坐标、距离与带符号的垂直差，并单独指出最近的一个。方块 ID 未知抛出「未知方块」，半径内没有抛出「附近 N 格内没有 X」。

缺失能力：只查已加载区块内的方块，地下 64 格以外或未加载区块里的矿脉找不到；不区分基岩变体，`deepslate` 与 `diamond_ore` 需要分别查。

验收方法：B 级，在出生点附近找 `oak_log`。期望 detail 给出「找到 N 个橡木，最近的是 (x, y, z)，距离 D 格，垂直差 +E」；再查一个不存在的方块 ID，期望抛出「未知方块」。

#### locate_entity

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / sense |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:362` |
| 实现函数 | `bridge/minecraft_bridge.js:1876` `locateEntity` |
| Core 工具 | `src/voxkin/agent/tools.py:327` |

当前行为：在半径内搜索实体，半径截断到 1 至 64 格，候选数截断到 1 至 16 个，按类型、名字过滤。类型支持 `player`、`mob`、`animal`、`hostile`、`item`、`object`、`projectile`、`vehicle`，`hostile` 额外匹配敌对生物名单。玩家用真实用户名显示。返回名字、类型、距离与坐标。找不到抛出「附近 N 格内没有符合条件的实体」。

缺失能力：看不到视距外的实体；掉落物的类型判断依赖 mineflayer 实体名，跨版本可能变。

验收方法：B 级，在服务器里放一只僵尸再触发 `{"type": "hostile"}`。期望 detail 列出名字、类型「敌对生物」、距离与坐标；再触发 `{"type": "player"}`，期望在玩家离开视距后明确说没有符合条件的实体。

#### look_at_player

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / act |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:374` |
| 实现函数 | `bridge/minecraft_bridge.js:375`（内联） |
| Core 工具 | `src/voxkin/agent/tools.py:54` |

当前行为：按 `player` 参数从 `bot.players` 取玩家实体，把视线对准玩家头顶 1.6 格的位置。玩家不存在或实体未加载抛出「找不到玩家 X」。

缺失能力：只认精确用户名，`resolvePlayer`（`bridge/minecraft_bridge.js:2421`）的「回退到最近玩家」在这里不生效，所以名字写错就直接失败。独立通关场景没有玩家，这个技能用不上。

验收方法：B 级，用 `bridge/work/test_player.mjs` 起一个名为 `Steve` 的测试玩家连上评测服，再触发 `{"player": "Steve"}`。期望 detail 是「已看向玩家」，且服务端侧能看到 bot 的 yaw 指向 Steve；传错名字期望抛出「找不到玩家」。

#### goto

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / path |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:344` |
| 实现函数 | `bridge/minecraft_bridge.js:467` `goTo`、`bridge/minecraft_bridge.js:426` `travelTo` |
| Core 工具 | `src/voxkin/agent/tools.py:30` |

当前行为：校验三个坐标是有限数，等区块加载最多 5 秒。水平距离超过 32 格时按 32 格一段推进，最多 10 段。先用 `GoalNear` 到达，失败后改用 `GoalXZ` 再试一次。成功后返回实际距离与垂直差，垂直差大于 2 格时额外说明可能在目标上方或下方。坐标无效抛出「坐标无效」，两种目标都走不到抛出「走不过去」。

缺失能力：`GoalXZ` 兜底成功时不校验最终距离，走不到目标点也可能返回成功，detail 里的距离会很大。清单的验收描述要求距离落在 2 格半径附近，代码没有这条约束。寻路失败时的最后一条错误信息不写进 detail。

验收方法：B 级，指定一个隔水的坐标。期望 detail 里的距离明显大于 2 格时这条技能应判为失败；当前实现会返回成功，验收要记录这个偏差作为补齐依据。

#### goto_block

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / path |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:356` |
| 实现函数 | `bridge/minecraft_bridge.js:923` `gotoBlock` |
| Core 工具 | `src/voxkin/agent/tools.py:193` |

当前行为：用 `findBlockPosition`（`bridge/minecraft_bridge.js:2566`）找半径内最近的一个目标方块，再走 `travelTo` 过去，返回距离。垂直差大于 2 格时说明在上方或下方。方块 ID 未知抛出「未知方块」，半径内没有抛出「附近 N 格内没有 X」。

缺失能力：只找最近的一个候选，不返回其它候选的位置，目标被占住或走不到时没有第二个选择。距离校验的缺失与 `goto` 相同。

验收方法：B 级，在附近放置一块石头再触发 `{"block": "stone", "range": 32}`。期望 detail 报出距离；再指定一个 64 格内不存在的方块，期望抛出「附近 N 格内没有石头」。

#### follow_player

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / path |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:289` |
| 实现函数 | `bridge/minecraft_bridge.js:2615` `startFollow`、`bridge/minecraft_bridge.js:2633` `tickFollow` |
| Core 工具 | `src/voxkin/agent/tools.py:66` |

当前行为：解析目标玩家，按名字匹配或回退到最近玩家，保持距离截断到 1 至 6 格，创建跟随目标交给 pathfinder，每 250 毫秒刷新一次。距离小于 `distance + 0.2` 时停寻路并每 1.2 秒转身看玩家，大于 `distance + 1.2` 时恢复跟随，大于 `distance + 8` 开小跑，小于 `distance + 4` 改回走路。跟满 5 分钟自动停止。

缺失能力：`VOXKIN_INDEPENDENT=1` 时直接抛出「独立模式不跟随玩家」，独立通关场景用不上。玩家在视距外时 `resolvePlayer` 会要求玩家发坐标，违反零干预。Core 侧没有停止跟随的手段，只能靠桥接自己 5 分钟到点。

验收方法：B 级，用 `bridge/work/test_player.mjs` 起测试玩家，触发 `{"distance": 3}`。期望 10 秒内距离稳定在 3 格附近；发「别跟」到游戏内聊天，期望桥接停掉跟随。

#### come_to_player

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / path |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:297` |
| 实现函数 | `bridge/minecraft_bridge.js:300`（内联） |
| Core 工具 | `src/voxkin/agent/tools.py:85` |

当前行为：解析目标玩家，取玩家当前坐标，按分段寻路走到 2 格内，返回距离。垂直差大于 2 格时说明在上方或下方。

缺失能力：独立模式下没有禁用这段逻辑。`resolvePlayer` 在玩家存在但视距外时会向玩家发「请发一下坐标」，违反零干预要求；`checkPlayerDistance`（`bridge/minecraft_bridge.js:2552`）有 `INDEPENDENT` 保护，这里的调用链没有。

验收方法：B 级，独立模式下让测试玩家走出视距，再触发 `come_to_player`。期望 bridge 日志里没有「你在哪？可以发一下坐标吗？」这类聊天；当前实现会出现，验收要记录这个偏差。

#### stop

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / act |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:285` |
| 实现函数 | `bridge/minecraft_bridge.js:2681` `stopFollow`；队列清空在 `bridge/minecraft_bridge.js:217` `enqueueAction` |
| Core 工具 | `src/voxkin/agent/tools.py:46` |

当前行为：收到 `stop` 时先把动作队列里所有待执行动作清空，逐个回「被停止指令取消」，状态 `cancelled`（`bridge/minecraft_bridge.js:221`），再通过 `interruptCurrent`（`bridge/minecraft_bridge.js:206`）设置 `interrupted` 标志、停 pathfinder、停挖掘、清控制状态，最后自己插到队列最前面执行，停掉跟随。

缺失能力：Core 侧没有取消正在等待中的动作的入口，`stop` 只能从桥接本地触发。

验收方法：B 级，在一次 `collect_blocks` 执行中发 `stop`。期望队列里后续动作全部回「被停止指令取消」，桥接日志出现「打断当前动作」，JSONL 里对应步骤的 `status` 是 `cancelled`。

#### eat

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / act |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:317` |
| 实现函数 | `bridge/minecraft_bridge.js:1572` `eatFood` |
| Core 工具 | `src/voxkin/agent/tools.py:254` |

当前行为：数量截断到 1 至 16 个。不指定物品时从背包里挑质量最高的可吃食物，金苹果除外。每次吃之前记录数量、饥饿值、血量，吃完最多等 1 秒，检测到任一项变化才算这一次成功。返回吃了几个、饥饿值变化、血量变化，数量不够时说明原因。

缺失能力：没有把「吃饱」与「低血量急救」分成两种策略；不检查食物的附加效果。

验收方法：B 级，把饥饿值降到 10 并放 3 个熟牛肉，触发 `eat`。期望 detail 报出「吃了 3 个熟牛肉」与饥饿值从 10 变成多少；饥饿值满时触发，期望抛出「现在不饿，饥饿值已经满了，先不吃东西」。

#### sleep

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / wait |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:381` |
| 实现函数 | `bridge/minecraft_bridge.js:1947` `sleepInBed` |
| Core 工具 | `src/voxkin/agent/tools.py:359` |

当前行为：下界拒绝（床会爆炸），末地拒绝，已经在睡觉拒绝，不是夜晚也没有雷暴拒绝。找 16 格内的床，8 格内有敌对生物就拒绝，走不到床边就拒绝，走到床边后重新检查时刻与敌对生物，躺下后检查 `bot.isSleeping` 或游戏时间是否推进到白天。

缺失能力：没有放床的动作，床必须先由 `place_block` 放好；羊毛来自哪种生物、怎么找羊都不在技能范围内。

验收方法：B 级，夜晚在评测服放一张床再触发 `sleep`。期望 detail 报「已经躺在床上睡着了」或「天亮了」；8 格内放一只僵尸，期望抛出「附近有僵尸，距离 D 格，先清掉再睡」。

#### chat

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 基础类 / voice |
| 状态 | blocked |
| 桥接分支 | `bridge/minecraft_bridge.js:281` |
| 实现函数 | `bridge/minecraft_bridge.js:282`（内联） |
| Core 工具 | 无。`src/voxkin/agent/tools.py:5` 里没有 `chat` |

当前行为：把 `text` 转成字符串后调用 `bot.chat` 发送，返回「已发送聊天消息」。

缺失能力：Core 侧不把它交给模型，模型只能用 TTS 说话，所以这条技能只能由外部直接发动作触发。发送后没有任何回执，无法从桥接侧确认消息出现在聊天频道。

验收方法：C 级。需要第二个客户端或真人玩家观察游戏内聊天栏。仓库内只有 `bridge/work/test_player.mjs` 这个机器人，它能发消息但读不到聊天频道。补齐回执之前，这条技能的验收只能靠人工观察。

### 2.2 实用类

#### attack_nearest

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / act |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:320` |
| 实现函数 | `bridge/minecraft_bridge.js:2074` `attackEntity` |
| Core 工具 | `src/voxkin/agent/tools.py:106` |

当前行为：范围截断到 3 至 32 格，找最近的敌对生物。目标是苦力怕时后撤 12 格并结束。装备背包里的剑或斧。目标在 6 格外且有弓与箭时改用弓箭并按飞行时间算提前量，目标在飞行时用弓射击，进入 3.5 格内切近战。距离大于 3 格时靠近。每 600 毫秒攻击一次，最多 20 次，自身血量降到 4 以下或目标消失时结束。

缺失能力：目标还活着时返回「攻击了 X N 次，它还在」，`runAction`（`bridge/minecraft_bridge.js:387`）把它回成 `succeeded`，Core 侧据此认为动作成功。世界里生物还活着，阶段判定却会继续往下走。

验收方法：B 级，召唤一只僵尸并把它降到 1 点血，触发 `attack_nearest`。期望 detail 报「击败了僵尸，N 次攻击」；在僵尸有 20 点血时触发并让它逃走，期望动作的状态是失败。

#### attack_target

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / act |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:332` |
| 实现函数 | `bridge/minecraft_bridge.js:2074` `attackEntity`；目标筛选在 `bridge/minecraft_bridge.js:2395` `findAttackTarget` |
| Core 工具 | `src/voxkin/agent/tools.py:124` |

当前行为：按实体 ID、名字或类型筛选目标，范围截断到 3 至 32 格。目标是玩家直接拒绝，抛出「不攻击玩家」。目标是苦力怕时后撤 12 格并结束，其余走与 `attack_nearest` 相同的攻击循环。

缺失能力：与 `attack_nearest` 相同，目标还活着时报 `succeeded`。另外实体 ID 在 mineflayer 的会话内有效，重连后失效，ID 不可当稳定标识。

验收方法：B 级，同时召唤两只僵尸，用 `{"name": "zombie", "type": "hostile"}` 触发一次，期望只打其中符合条件的那只；用 `{"type": "player"}` 触发，期望抛出「不攻击玩家」。

#### collect_blocks

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / path |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:347` |
| 实现函数 | `bridge/minecraft_bridge.js:746` `collectBlocks` |
| Core 工具 | `src/voxkin/agent/tools.py:9` |

当前行为：半径截断到 8 至 64 格，方块 ID 未知抛出「未知方块」。先看背包里已有的数量，够数就直接返回。附近没有目标方块时最多等 6 轮区块加载。目标按距离和高度排序，走过去后重新读一次方块确认没被别人挖掉，按方块自动换工具，挖完等掉落物实体出现再捡起。数量不够时抛出「只拿到 N 个 X，还差 M 个」，桥接把它回成 `partial`。

缺失能力：找矿只搜水平半径内的方块，地下深层矿脉找不到；搜索结果里没有按矿种分级；采集中被怪打断只能等战斗结束或撤退，没有绕行。

验收方法：B 级，触发 `{"block": "oak_log", "count": 3, "range": 64}`。期望 detail 是「获得 3 个橡木，背包共 3 个」，且背包里确实有 3 个原木。这条在真实服务器上跑通过，证据见 `docs/evidence/S0_20261022.md` 与 `docs/evidence/S0_NORMAL_20261022.md`。

#### break_block

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / act |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:350` |
| 实现函数 | `bridge/minecraft_bridge.js:861` `breakBlock` |
| Core 工具 | `src/voxkin/agent/tools.py:154` |

当前行为：给方块 ID 时找半径内最近的一个，给坐标时直接用坐标，两种都没给抛出「需要方块名或坐标」。目标位置没有方块抛出「目标位置没有方块」，距离超过 4 格先走过去，按方块换工具，不能挖时抛出「现在不能挖 X」，挖完返回方块名与坐标。

缺失能力：挖完不检查目标位置是否真的变成空气，挖到一半被打断也会报成功。函数体里没有 `interrupted` 检查，清单宣称可以取消，靠的是 pathfinder 被停后抛出错误间接实现。寻路失败的错误信息只写进日志，不进 detail。

验收方法：B 级，指定一块石头触发。期望 detail 报出坐标，且服务端侧该位置变成空气；在挖硬石头上触发 `stop`，期望动作的状态是 `cancelled`。

#### place_block

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / act |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:353` |
| 实现函数 | `bridge/minecraft_bridge.js:882` `placeBlock` |
| Core 工具 | `src/voxkin/agent/tools.py:176` |

当前行为：坐标必须是有限数，目标位置已有方块抛出「目标位置已经有方块」，背包里没有该方块抛出「背包里没有 X」。距离超过 4 格先走过去。依次尝试六个面，找到能依附的固体方块就放置，放完最多等 1 秒确认位置上的方块名正确。六个面都失败抛出「周围没有可以依附的方块」。

缺失能力：只能放绝对坐标，不能放相对位置，例如脚下或正前方；一次只放一个。

验收方法：B 级，在平地上放一块圆石并指定目标坐标。期望 detail 报「放置 圆石 于 (x, y, z)」，服务端侧该位置是圆石；指定一个已有方块的位置，期望抛出「目标位置已经有方块」。

#### pickup_items

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / path |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:365` |
| 实现函数 | `bridge/minecraft_bridge.js:933` `pickupItems` |
| Core 工具 | `src/voxkin/agent/tools.py:213` |

当前行为：范围截断到 3 至 32 格，找范围内最近的掉落物实体，记录它的物品名与当前背包数量，走到 1 格内等 500 毫秒后比较数量。捡到就返回「捡起了 N 个 X」。

缺失能力：没捡到时返回「走到了掉落物旁边，但还没有捡起」，`runAction` 把它回成 `succeeded`，Core 侧据此认为动作成功。掉落物只捡最近的实体，不会把范围内全部捡走。

验收方法：B 级，挖一块方块让掉落物落在地上，触发 `pickup_items`。期望 detail 报「捡起了 N 个」；把掉落物放在够不到的位置触发，期望动作被判为失败。

#### craft

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / act |
| 状态 | existing |
| 桥接分支 | `bridge/minecraft_bridge.js:368` |
| 实现函数 | `bridge/minecraft_bridge.js:1352` `craftItem` |
| Core 工具 | `src/voxkin/agent/tools.py:231` |

当前行为：物品 ID 未知抛出「未知物品」，数量截断到 1 至 64 个。先用 2×2 背包格判定能否完成，材料不够就直接报缺什么，一个物品都不动。需要工作台的配方先按工作台配方核对材料，再找 32 格内已放下的工作台，没有就检查背包里有没有，有就放一个。合成走自己操作合成窗口的流程，每次点击之间留 80 毫秒。产出数量与预期对不上时让服务端重发一次背包再核对。放在地上的工作台用完后回收。

缺失能力：只按第一个找到的配方做，没有「当前材料能做什么」的查询入口；材料清单只写在错误文本里，没有结构化字段。回收工作台靠 `bot.dig`，没有先换镐，回收失败只写日志。

验收方法：B 级，触发 `{"item": "oak_planks", "count": 12}`。期望 detail 报「合成 12 个 oak_planks」，背包里确实有 12 个木板；材料不足时触发，期望 detail 报缺什么并且背包物品数量不变。这条在真实服务器上跑通过，证据见 `docs/evidence/S0_20261022.md` 与 `docs/evidence/S0_NORMAL_20261022.md`。

#### smelt

| 项 | 值 |
| --- | --- |
| 分类 / 类型 | 实用类 / wait |
| 状态 | partial |
| 桥接分支 | `bridge/minecraft_bridge.js:371` |
| 实现函数 | `bridge/minecraft_bridge.js:1484` `smeltItem` |
| Core 工具 | `src/voxkin/agent/tools.py:367` |

当前行为：物品 ID 未知抛出「未知物品」，原料不够抛出「背包里只有 N 个 X」。找 16 格内的熔炉，没有就检查背包里有没有熔炉并放一个。走到熔炉 3 格内，打开熔炉放入原料，从煤、木炭、橡木板、桦木板、木棍里挑燃料，煤按 8 个物品 1 个燃料、木板按 1.5 个物品 1 个燃料计算用量。每秒检查一次产出，最多等 90 秒，取出产物后返回新增数量与总数。放在地上的熔炉用完挖回。

缺失能力：产物表是硬编码白名单（`bridge/minecraft_bridge.js:1460`），表外的原料会把产物名当成原料名，数量对不上。回收熔炉的 `bot.dig` 没有先换镐，回收失败只写日志，熔炉会留在世界里。燃料只从背包取，不会用身旁的煤炭堆。

验收方法：B 级，准备 4 个粗铁与 1 个煤，触发 `{"item": "raw_iron", "count": 4}`。期望 detail 报「熔炼出 4 个 铁锭，背包共 4 个」，且世界里没有留下熔炉；背包里没有燃料时触发，期望抛出「没有燃料（煤、木炭或木板）」。

### 2.3 专精类

清单里没有专精类技能。`bridge/skills/README.md` 列出的 53 条里，专精类 14 条全部没有实现：`task_start`、`task_status`、`task_cancel`、`build_blueprint`、`trade`、`villager_trades`、`explore`、`find_biome`、`waypoint_save`、`waypoint_goto`、`nether_portal`、`end_run`、`bow_kite`、`shield_block`。

独立通关需要的能力全部落在这 14 条里。第 6 节按依赖顺序给出缺口。

## 3. 状态定义

| 状态 | 判定标准 |
| --- | --- |
| existing | 清单条目、桥接分支、Core 侧工具定义三者齐全（`chat` 除外，它是桥接专有）；实现与清单的 `execution_steps` 逐条对应；清单列出的失败条件在代码里真的会抛出；动作成功与否能从 `detail` 或世界状态读出来。 |
| partial | 要素齐全，但存在下列一种情况：行为与清单声明不一致；动作失败时仍回 `succeeded`；缺少后置校验；只能在部分场景使用，例如独立模式禁用，或独立模式下会向玩家求助。 |
| missing | 清单里有条目，但桥接没有分支，或 Core 侧没有工具定义，模型无法调用。 |
| blocked | 实现存在，行为本身可以从代码里读出来，但验收必须在仓库外的真实环境完成，需要第二个客户端、真实模型接口或真实玩家在场。 |

状态判定只依据代码与仓库内的证据。真实服务器跑过的技能会在第 2 节标注，其余技能的状态表示实现完整度，不代表已经跑过。

## 4. 结构化动作状态机

### 4.1 七档状态的判定依据

状态词表定义在 `src/voxkin/bridge/protocol.py:7`，共七档。

| 状态 | 判定依据 | 产生位置 | 当前是否可达 |
| --- | --- | --- | --- |
| accepted | 动作已被 Core 收下并登记成待执行 | Core 侧没有这个中间态，`ActionDispatcher.dispatch_result`（`src/voxkin/agent/actions.py:81`）发出请求后直接等待结果 | 不可达 |
| running | 动作已经在桥接进程里开始执行 | 桥接的 `runAction`（`bridge/minecraft_bridge.js:246`）只在结束时回一帧，中途不发帧 | 不可达 |
| succeeded | 桥接执行结束且后置检查通过 | `bridge/minecraft_bridge.js:387` 回 `succeeded`；`src/voxkin/bridge/protocol.py:17` 的 `SUCCESS_STATUSES` 把它算作 `ok=true` | 可达 |
| partial | 动作完成了一部分 | 桥接 `statusForError`（`bridge/minecraft_bridge.js:400`）把含「还差」「只拿到」的错误文本映射成 `partial`；Core 侧 `Verifier.classify`（`src/voxkin/agent/runner.py:67`）在背包判定不过关但有进展时也给 `partial` | 可达 |
| failed | 动作失败，原因明确且不属于其它几档 | `statusForError` 的兜底档；`ActionResult.from_message`（`src/voxkin/bridge/protocol.py:49`）在回帧缺 `status` 时按 `ok` 字段兜底 | 可达 |
| cancelled | 动作被新指令抢占、被停止指令清出队列，或连接断开 | `statusForError` 把含「打断」「取消」「断开」的文本映射成 `cancelled`；被清出队列的动作在 `bridge/minecraft_bridge.js:221` 直接回 `cancelled`；`TaskRunner.run`（`src/voxkin/agent/runner.py:244`）遇到 `cancelled` 立即停步并把任务状态置为 `cancelled` | 可达 |
| blocked | 缺少外部条件，动作无法开始或注定无法完成 | `runAction` 在 bot 未进世界时回 `blocked`（`bridge/minecraft_bridge.js:248`）；`statusForError` 把含「没有」「材料不够」的文本映射成 `blocked`；Core 侧没有桥接连接时 `dispatch_result` 抛出 `status="blocked"` 的 `ActionError` | 可达 |

`partial` 与 `blocked` 都算 `ok=true`（`src/voxkin/bridge/protocol.py:17`），所以派发层不会因为这两档抛出异常，判定交给步骤级的机器判定。

`accepted` 与 `running` 这两档目前没有任何来源，是状态机里真正的空洞。

### 4.2 完整链路

```mermaid
flowchart TD
    A["模型返回工具调用<br/>src/voxkin/pipeline.py:357"] --> B["先播报一句意图<br/>src/voxkin/pipeline.py:360"]
    B --> C["dispatch_result<br/>src/voxkin/agent/actions.py:81"]
    C --> D["ActionRequest.to_message<br/>src/voxkin/bridge/protocol.py:28<br/>带 action_id / skill_id / timeout_s"]
    D --> E["桥接 enqueueAction<br/>bridge/minecraft_bridge.js:217"]
    E --> F["runAction 执行分支<br/>bridge/minecraft_bridge.js:246"]
    F --> G["reply 回 action_result<br/>bridge/minecraft_bridge.js:408<br/>带 ok / status / skill_id / detail"]
    G --> H["先推 state 帧再回结果<br/>bridge/minecraft_bridge.js:2834"]
    H --> I["ActionResult.from_message<br/>src/voxkin/bridge/protocol.py:49"]
    I --> J{"ok 为真"}
    J -->|"是"| K["返回 ActionResult<br/>src/voxkin/agent/actions.py:106"]
    J -->|"否"| L["ActionError 带 status<br/>src/voxkin/agent/actions.py:10"]
    K --> M["步骤级机器判定 Verifier.check<br/>src/voxkin/agent/runner.py:30"]
    L --> M
    M --> N{"判定通过"}
    N -->|"是"| O["步骤成功 status=succeeded<br/>src/voxkin/agent/runner.py:157"]
    N -->|"否"| P["Verifier.classify 定 partial 或 blocked<br/>src/voxkin/agent/runner.py:67"]
    O --> Q["写 JSONL 步骤记录<br/>status / ok / skill_id / action_id<br/>src/voxkin/agent/runner.py:210"]
    P --> Q
    Q --> R["写检查点与任务状态<br/>src/voxkin/agent/tasks.py"]
```

链路上已知的三处偏差：

1. 桥接的 `statusForError` 靠错误文本匹配判定状态。同一句话在不同技能里的含义可能不同，「熔炼了粗铁，但没有取到铁锭」会被判成 `blocked`，实际是 `failed`。
2. `reply` 把 `detail` 截断到 500 字，超长原因会丢掉。
3. 动作结果只播报，没有作为一条消息回到模型上下文。`src/voxkin/pipeline.py:357` 的 `_run_action` 把结果交给 `announce`，模型下一轮看不到失败原因。

真实运行的 JSONL 里每一步都带 `status`、`skill_id` 与 `action_id`，见 `docs/evidence/S0_NORMAL_20261022.md` 第 10 次运行的完整记录。

## 5. 取消与互斥规则

### 5.1 必须抢占的指令

| 指令 | 抢占范围 | 依据 |
| --- | --- | --- |
| `stop` | 清空动作队列里全部待执行动作；抢占正在执行的技能 | `bridge/minecraft_bridge.js:142` 的 `PRIORITY_ACTIONS`，`bridge/minecraft_bridge.js:217` 的 `enqueueAction` |
| `attack_nearest` | 抢占正在执行的技能，插到队列最前面 | 同上，`PRIORITY_ACTIONS` 只含 `attack_nearest` 与 `stop` |

其余 19 个技能一律进队列尾部串行执行，见 `bridge/minecraft_bridge.js:233` 的 `pumpActions`。

### 5.2 抢占的收敛过程

1. `enqueueAction` 收到 `stop` 时把队列清空，被丢弃的动作逐个回「被停止指令取消」，状态 `cancelled`（`bridge/minecraft_bridge.js:221`）。
2. `interruptCurrent`（`bridge/minecraft_bridge.js:206`）设置 `interrupted = true`，停 pathfinder，停挖掘，清控制状态。
3. 正在执行的技能在检查点读到 `interrupted` 后抛出「被新的指令打断」。检查点位置：`travelTo`（`bridge/minecraft_bridge.js:433` 与 `:451`）、`collectBlocks`（`:788`）、`smeltItem`（`:1516`）、`eatFood`（`:1595`）、`sleepInBed`（`:1972`）、`attackEntity`（`:2080`）。
4. `runAction` 的 catch 把这个错误交给 `statusForError`，映射成 `cancelled` 并回帧（`bridge/minecraft_bridge.js:389`）。
5. `TaskRunner.run` 收到 `cancelled` 立即停止当前阶段，把任务状态置为 `cancelled` 并写检查点（`src/voxkin/agent/runner.py:244`）。

### 5.3 超时的收敛

`runAction` 在开始时按 `timeout_s` 设置一个截止定时器（`bridge/minecraft_bridge.js:256`），取值截断到 5 至 300 秒。到点后同样设置 `interrupted = true` 并停 pathfinder、停挖掘、清控制状态，动作在下一个检查点抛出「被新的指令打断」，被映射成 `cancelled`。Core 侧另有一层超时：`dispatch_result` 的 `asyncio.wait_for` 到点抛出 `ActionError`，状态是 `failed`（`src/voxkin/agent/actions.py:99`）。

### 5.4 互斥与残留

- 动作开始时会停掉跟随与闲逛（`bridge/minecraft_bridge.js:267`）。
- `interrupted` 标志在每个动作结束时被清回 `false`（`bridge/minecraft_bridge.js:394`）。
- Core 侧的 `ActionDispatcher` 没有 `cancel` 方法（`src/voxkin/agent/actions.py:21`），`TaskRunner.cancel()`（`src/voxkin/agent/runner.py:121`）只在步骤之间生效，无法唤醒正在等待的动作。

### 5.5 缺口

- 抢占集合只有两个。战斗、进食、采集这类长动作被玩家打断时没有抢占路径，只能等当前动作自己结束。
- 抢占在桥接本地完成，Core 不知道动作被抢占了，Core 侧等待的动作仍然等到超时。
- `stop` 清队列时清掉的是还没开始的动作，正在执行的那个靠 `interrupted` 标志停下，没有统一的取消回执。

## 6. 按依赖排序的缺口清单

排序依据是独立通关的依赖顺序：先有采集与合成，再有挖矿与生存，再有维度与通关。前置技能全部来自第 2 节。

| 序 | 缺口 | 缺什么 | 补齐后的验收方法 | 前置技能 |
| --- | --- | --- | --- | --- |
| 1 | 死亡重生与掉落回收 | `createBot`（`bridge/minecraft_bridge.js:2708`）的 death 处理只停跟随与闲逛，没有重生，没有回到安全点，没有掉落物回收 | 在评测服执行 `/kill Voxkin`，期望 5 秒内重新进入世界并继续当前阶段，死亡前的物品按规则回收 | observe、inventory、collect_blocks |
| 2 | 挖竖井与主巷道 | 没有向下挖安全竖井的技能，也没有主巷道加分支的挖矿编排。`collect_blocks` 只搜水平半径 64 格内的方块，挖不到深层矿脉 | 挖 32 格长的竖井与主巷道，期望全程不掉血、不踩空，挖到指定深度后能沿巷道返回 | collect_blocks、place_block、goto_block |
| 3 | 缺料查询 | 没有「当前材料能做什么」的技能。`craft` 把缺料清单塞在错误文本里，模型拿不到结构化的缺料数量 | 背包里放 5 种材料，期望返回可合成物品清单与每种还差多少 | inventory、craft |
| 4 | 战斗结果判定 | `attack_nearest` 与 `attack_target` 在目标还活着时回 `succeeded`，Core 侧据此继续往下走 | 目标还活着时期望动作判为失败，目标被击败时期望判为成功 | attack_nearest、observe |
| 5 | 阶段计划补全 | 已补 `src/voxkin/agent/plans.py` 的 S0–S6 共 53 步；S1 已 1 次 5/5，S2–S6 没有真实服务器运行记录 | 依次用 `scripts/run_stage.py --stage S<n> --runs 10` 跑，达到路线图退出条件后再标记完成 | collect_blocks、craft、smelt、eat、sleep、mine_collect、strip_mine、deep_mine、fight_blaze、hunt_enderman、throw_eye、activate_end_portal、fight_dragon |
| 6 | 箱子暂存 | 没有存箱子、取箱子、看箱子三个技能，长程任务没有物资暂存点 | 存入 16 个圆石再取出，期望背包与箱子数量对得上 | inventory、place_block、goto_block |
| 7 | 弓盾战斗 | 没有举盾格挡与放风筝的技能。`attackEntity` 只能近战，或在 6 格外用弓，没有拉开距离的控距循环 | 8 格外放一只骷髅，期望 bot 举盾挡下攻击，或边退边射并保持 6 格以上 | attack_nearest、inventory |
| 8 | 下界门 | 没有采集黑曜石、造门、点火、维度切换的技能 | 采 10 个黑曜石并造门点火，期望往返主世界 3 次成功，坐标换算偏差不超过 16 格 | collect_blocks、craft、place_block、smelt |
| 9 | 下界战斗 | 没有烈焰人与末影人的专门战斗。`attackEntity` 的近战循环对上烈焰人很难打中 | 在堡垒里打 7 根烈焰棒，期望 40 分钟内完成且死亡不超过 2 次 | attack_nearest、attack_target |
| 10 | 末影之眼与要塞 | 已补 `throw_eye` 与 `activate_end_portal`（`bridge/skills/end.js`），未实跑 | 合成 12 个末影之眼并投掷，期望定位收敛；进要塞填满 12 个末地门框架并进入末地 | craft、throw_eye、activate_end_portal |
| 11 | 末影龙战斗 | 已补 `fight_dragon` 与 `return_home`（`bridge/skills/end.js`），复用 `break_crystal`，未实跑 | 从主世界检查点起跑 60 分钟内击杀末影龙，期望 bot 存活并回到主世界 | fight_dragon、break_crystal、return_home、缺口 7 的弓盾战斗 |
| 12 | 清单驱动的 dispatch | `bridge/skills/index.js` 不存在，`runAction` 仍是 21 个手写 `case` 分支。`src/voxkin/agent/tools.py:5` 也是手写清单，`src/voxkin/agent/skills.py:71` 的 `tool_schemas` 没有接进 `src/voxkin/pipeline.py:130` | 清单里加一条技能后，桥接分支与工具定义自动出现；`tests/test_skill_manifest.py` 与 `scripts/dump_manifest.js` 全绿 | 无 |
| 13 | 状态机补全 | `accepted` 与 `running` 两档没有来源；`statusForError` 靠错误文本匹配 | 一个动作从派发到结束能观察到三帧状态，Core 侧按帧推进 | 无 |
| 14 | 工具结果回灌 | 动作结果只播报，没有回到模型上下文，模型无法根据失败原因重规划 | 一次 `collect_blocks` 失败后，同一回合内模型改调 `goto_block` | 无 |
| 15 | 单技能直发入口 | 没有直接向已连接的桥接发一条动作的接口，每个技能只能靠整阶段回归来验收 | 加一个能发单条动作并读回 `action_result` 的入口，21 个技能各跑一次 | 无 |
| 16 | 客户端 Mod 空间音频 | `mod/` 已能编译，WebSocket PCM 推送也跑通，但没有在真实 Minecraft 客户端里验证过距离衰减与跟随移动 | 在真实客户端里听语音随 bot 移动改变音量与方向 | 无 |

第 1 到第 5 项阻塞 M2 与 M3 的退出条件，第 6 到第 11 项阻塞 M5 到 M8，第 12 到第 16 项是全链路的通透性问题。

## 7. 已执行的测试与结果

### 7.1 本次实跑

命令：

```
.\.venv\Scripts\python.exe -m pytest tests -q
```

结果：`245 passed, 40 warnings in 48.17s`。警告全部来自 `tools/dev_llm_server.py:20` 与 `:21` 的 `NotAppKeyWarning`。

各测试文件的用例数：

| 测试文件 | 用例数 | 内容 |
| --- | --- | --- |
| `tests/test_action_status.py` | 12 | 状态解析、派发返回、桥接缺失判 blocked、Runner 记录状态、cancelled 停步、partial 与 blocked 判定、桥接源码含结构化状态字段 |
| `tests/test_actions.py` | 8 | 动作派发与超时 |
| `tests/test_runner.py` | 7 | 步骤循环、检查点、重试 |
| `tests/test_skill_manifest.py` | 5 | 清单与 JSON 一致、清单覆盖桥接全部分支、工具定义与清单参数一致、schema 生成、验收描述非空 |
| `tests/test_plans.py` | 7 | S0–S6 计划覆盖、工具名与参数、判定类型、超时余量 |
| `tests/test_tools.py` | 23 | 工具定义格式与参数边界 |
| `tests/test_intent.py` | 13 | 意图到工具的路由 |
| `tests/test_text.py` | 14 | 可朗读文本过滤与增量分句 |
| `tests/test_stt_filter.py` | 17 | 识别结果过滤 |
| `tests/test_progress.py` | 6 | 阶段表与缺料计算 |
| `tests/test_bridge.py` | 7 | WebSocket 协议与派发 |
| `tests/test_world_state.py` | 6 | 世界状态解析 |
| `tests/test_memory.py` | 7 | 对话存储与检索 |
| `tests/test_config.py` | 5 | 配置加载与保存 |
| `tests/test_events.py` | 5 | 时间线与指标 |
| `tests/test_pipeline.py` | 5 | 回合管线与打断 |
| `tests/test_vad.py` | 5 | 能量端点检测 |
| `tests/test_services.py` | 4 | 外部服务启停 |
| `tests/test_silent_tts.py` | 4 | 静音 TTS 适配器 |
| `tests/test_normalize.py` | 3 | 繁简转换 |
| `tests/test_action_notes.py` | 2 | 动作结果注入上下文 |
| `tests/test_run_manager.py` | 2 | 阶段运行管理 |
| `tests/test_tasks.py` | 2 | 任务与检查点存储 |

### 7.2 替身与真实运行

| 类别 | 内容 |
| --- | --- |
| 确定性替身 | `tests/support.py` 的 `ToneTTS` 产生等幅 PCM，用于验证管线时序与队列。`tests/test_bridge.py`、`tests/test_pipeline.py`、`tests/test_action_notes.py` 用它代替真实 TTS。`tests/test_action_status.py` 的 `test_bridge_reports_structured_status` 只检查桥接源码里存在 `statusForError` 与 `status` 字段，不执行桥接。 |
| 真实服务器 | `docs/evidence/S0_20261022.md`：Paper 1.21.1-133，seed 20261022，Peaceful 难度，`VOXKIN_INDEPENDENT=1`，连续两次跑完 S0 的 5 步，task_id 37 与 38，用时 52.4 秒与 32.6 秒。 |
| 真实服务器 | `docs/evidence/S0_NORMAL_20261022.md`：同一套环境，Normal 难度，怪物生成开启，`.\.venv\Scripts\python.exe scripts\run_stage.py --stage S0 --runs 10 --difficulty normal` 连续 10 次全部 5/5 通过，用时 34.3 到 38.5 秒，P50 36.4 秒。阶段计划是固定规则，没有调用 LLM。这两条证据覆盖 `collect_blocks` 与 `craft`。 |
| 真实服务器 | `docs/evidence/S1_NORMAL_20261022.md`：同一评测世界接在 S0 后跑 S1，Paper 1.21.1-133、Normal、seed 20261022，5/5 步、78.9 秒；`mine_collect` 与 3 次 `craft` 均一次成功。阶段计划是固定规则，没有调用 LLM。 |
| 真实模型 | `docs/BENCHMARK_RESULTS.md:93`：真实模型在游戏内聊天里返回 `collect_blocks` 调用，桥接执行并回报「挖到 3 个 泥土」。 |
| 未验证 | 除 S0 的 `collect_blocks`/`craft` 与 S1 的 `mine_collect`/`craft` 外，其余内建技能与 37 个模块技能没有真实服务器运行记录；S2–S6 的阶段计划也没有实跑。`shear_sheep` 只有模拟 bot 测试，尚无真实服务器证据。`docs/STATUS.md` 记录客户端 Mod 只完成编译与协议实现，没有在真实 Minecraft 客户端验证。 |

### 7.3 文档与代码的偏差

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 技能清单来源 | 模块文件已落地：`combat.js`、`craft.js`、`gather.js`、`movement.js`、`nether.js`、`storage.js`、`survival.js`、`end.js` 与 `manifest.js`、`registry.js`；当前清单 58 条（21 个内建 + 37 个模块技能）。以 `manifest.json` 为准 | `bridge/skills/` 目录 |
| 清单驱动的 dispatch | `bridge/skills/registry.js` 已存在，`runAction` 的 default 分支查注册表；仍有 21 个内建 `case` 分支 | `bridge/minecraft_bridge.js` |
| 工具定义来源 | `src/voxkin/agent/tools.py` 已改为 `build_tools()`，从清单生成；`src/voxkin/pipeline.py` 使用 `MINECRAFT_TOOLS` | `src/voxkin/pipeline.py` |
| 测试数量 | 2026-10-23 本次实跑 270 个 Python 测试通过；剪羊技能另有 8 个 Node 模拟测试 | 本次实跑输出 |
| 阶段模板 | `PLANS` 已有 S0–S6 共 53 步；S1–S6 未实跑 | `src/voxkin/agent/plans.py` |
| 阶段产出 | S2 产出 `bed` 与 `cooked_beef`，S3 产出 `shield`，S4 产出 `diamond_pickaxe`，计划已按这些产出写死；S6 仍靠 `ender_dragon_killed` 事件判定，事件上报未实现，当前只有 `fight_dragon` 的动作层成功 | `src/voxkin/agent/progress.py` |
