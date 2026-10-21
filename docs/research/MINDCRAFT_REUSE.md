# MindCraft 复用与接入方案（只读）

调研对象：`work/reference/mindcraft`，HEAD `f6a9556`（2026-10-02），`git describe` 为 `v0.1.3-130-gf6a9556`。已有问题清单见 `docs/research/MINDCRAFT_AUDIT.md`，本文只回答“怎么复用”。
路径约定：MindCraft 文件相对 `work/reference/mindcraft`，Voxkin 文件相对仓库根；同一行内先写全路径，后文用文件名。行号以 2026-10-21 22:35 的工作区为准。

## 0. 结论

| 项 | 结论 |
| --- | --- |
| 推荐路线 | C 混合：WebSocket 桥接与协议保持自建，按函数移植 `skills.js`/`world.js`，只仿照 `action_manager`、`self_prompter`、`history` 的设计 |
| 第一阶段 | P0 状态快照与动作结果回填（含 `inventory` 明细），随后 `follow_player`、`attack`、`mine` |
| 最大风险 | 技能函数与 5 个 mineflayer 插件、`bot.modes`、`bot.output` 深度耦合（`skills.js:10-12,112,323,356,480,506`；`package.json:21-26`），整包复制会把 MindCraft 的 agent 回合与 `patch-package` 补丁一起拖入 |
| 许可 | MIT，可复制、修改、再分发，保留版权与许可声明即可（`LICENSE:1-12`） |

## 1. 现状约束

| 约束 | 证据 | 对方案的影响 |
| --- | --- | --- |
| 桥接只加载 pathfinder | `bridge/minecraft_bridge.js:2-4`、`:340` | 移植技能前需补 collectblock、pvp、auto-eat、armor-manager |
| 现有工具 8 个 | `src/voxkin/agent/tools.py:5-115` | 新动作要同时改 schema、ack 文案与桥接 switch |
| 动作结果只播报，不回灌模型 | `src/voxkin/pipeline.py:349-373` 与 `:238-247` 对比 | 多步重规划的前置条件是动作结果进入上下文 |
| 状态帧只进 Studio 事件 | `src/voxkin/server.py:278-281` | 模型看不到位置、血量、背包，需要 Core 侧保存最近快照 |
| 动作在桥接内串行 | `bridge/minecraft_bridge.js:108-112` | 长任务会阻塞后续动作，需要队列或取消机制 |
| MindCraft 只产出完整字符串 | `src/models/prompter.js:214-262`、`src/agent/agent.js:317-320` | 不能把它的回合循环接进流式语音链路 |

## 2. 模块清单

工作量按 1 名熟悉 mineflayer 的工程师计，含联调，单位为“人日”。

| 模块 | 职责 | 依赖 | 与现有桥接的耦合点 | 复用方式 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| `src/agent/commands/index.js:7-11,29-30,97-174,212-230` | 命令注册、`!cmd(args)` 解析、参数域校验、执行入口 | 无直接 npm 包；依赖 actions/queries 与 mcdata（间接加载插件） | 我们已用 JSON tool call，正则解析无价值；参数校验与文档生成可借 | 只仿照设计 | 0.5 |
| `src/agent/commands/actions.js:6-25,28-502`、`queries.js:14-213` | 41 个动作与 14 个查询的清单、描述、字符串输出 | skills、world、convoManager | `runAsAction` 依赖 `agent.actions` 并返回 `message`；queries 依赖 `convoManager` | 移植函数（查询优先，删 convoManager） | 1.5 |
| `src/agent/library/skills.js` | 38 个技能：移动、挖掘、合成、熔炼、箱子、种田、战斗 | pathfinder、collectblock（含 tool）、pvp、armorManager、vec3、settings（`package.json:21-26`） | 全部以 `bot` 为参数，内部调用 `bot.modes.pause`、`bot.interrupt_code`、`bot.output`（`skills.js:10-12,112,323,356,480,506`） | 移植函数，逐函数去掉模式与日志耦合 | 8-12（前 10 个动作） |
| `src/agent/library/world.js:118-160,262-309` | 最近方块/实体、背包计数、可合成项 | `mcdata.js`，后者连锁加载 5 个插件（`src/utils/mcdata.js:3-10`） | 只读 `bot`，无协议耦合；导入即拖入插件 | 移植函数，改用 `bot.registry` 替代 mcdata | 2 |
| `src/agent/library/full_state.js:12-108` | 状态对象：位置、装备、附近实体、模式摘要 | world、convoManager | 字段与桥接 `state` 帧高度重合（`bridge/minecraft_bridge.js:364-378`） | 移植函数（删 convoManager、modes） | 1 |
| `src/utils/mcdata.js:70-121` | 位置包节流、PartialReadError 抑制、插件加载 | minecraft-data、prismarine-item | 直接决定桥接稳定性 | 移植片段（节流与错误抑制） | 1.5 |
| `src/agent/action_manager.js:18-24,61-150,168-175` | 单动作互斥、10 秒停止、分钟级超时、输出汇总 | agent | 对应 `actionChain`（`bridge/minecraft_bridge.js:108-112`）与 `ActionDispatcher` 的 120 秒超时 | 只仿照设计（互斥、取消、超时） | 1.5 |
| `src/agent/history.js:21,61-80` | 按条数裁剪、每 5 条做一次 LLM 摘要、落盘 | settings、prompter | 与 SQLite 记忆重复（`src/voxkin/memory.py:217-236`） | 只仿照设计（分块摘要） | 2 |
| `src/agent/memory_bank.js:6-12` | 命名地点存取 | 无 | 无 | 直接 require（25 行） | 0.5 |
| `src/agent/self_prompter.js:56-87,89-102` | 目标循环、空闲重启、3 次无命令停止 | agent、actions | 与回合式语音冲突 | 只仿照设计（空闲重启与失败上限） | 2 |
| `src/agent/modes.js:24-31,333-430` | 10 个常驻行为：自保、脱困、狩猎、拾取、插火把等 | skills、world、settings | 需要 `bot.modes` 与 300ms tick（`src/agent/agent.js:502-517`） | 只仿照设计；单行为按需移植 | 5-8 |
| `src/agent/npc/build_goal.js:20-78`、`npc/utils.js:5-126` | 蓝图逐格放置、材料缺口统计、朝向旋转 | skills、world、vec3 | 无协议耦合 | 移植函数 | 3 |
| `src/agent/npc/item_goal.js:148-174,295-354`、`controller.js:41-79` | 物品依赖图、获取顺序、建造目标编排 | skills、mcdata、NPCData | 依赖 `agent.actions.runAction` 与 `bot.emit('idle')` | 只仿照设计（依赖图算法可移植） | 3 |
| `src/agent/tasks/construction_tasks.js:73-160`、`tasks.js:234-302` | 蓝图校验、分层检查、任务超时 | 大量 agent 组件 | 任务制与我们的回合制不同 | 只仿照设计（蓝图 JSON 与校验） | 4 |
| `src/models/prompter.js:137-204,214-262`、`profiles/defaults/_default.json:2-26` | prompt 占位符、3 次重试、记忆摘要、模式默认值 | 各 provider SDK | 返回完整字符串，无法流式 | 只仿照设计（占位符注入、示例组织） | 1 |

未纳入：`vision/`、`conversation.js`、`speak.js`、`mindserver.js`，理由见第 7 节。

## 3. 三条路线对比

| 路线 | 做法与证据 | 代价 | 风险 | 对语音延迟的影响 | 维护成本 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A 第二桥接后端 | Core 通过 Socket.IO `send-message` 注入文本（`src/mindcraft/mindserver.js:258-268`），MindCraft 自己跑 `handleMessage`→`promptConvo`→执行命令（`src/agent/agent.js:254-382`），语音仍由 Voxkin 负责 | 动作退化为自然语言回合，无法直接下发 tool；两套 LLM 配置、两套状态 | 它要等完整 LLM 回复才执行命令（`prompter.js:214-262`）；结果写回它自己的 history（`agent.js:362-370`）；Core 要另开 `listen-to-agents` 才能拿状态（`mindserver.js:274-276,308-330`） | 动作确认多一次完整 LLM 往返；两套对话可能说出不一致的话 | 高：Node 依赖 + `patch-package`（`package.json:45`） | 仅作演示后端 |
| B 整层移植 commands | 把 commands、agent、action_manager 一起搬进现有桥接，替换 switch | 需要复刻 agent 对象（history、memory、self_prompter、modes） | `runAsAction` 与 agent 强绑定（`actions.js:6-25`）；上游一改就冲突 | 技能本身不阻塞语音；commands 的“完整回合后执行”会把串行带回 | 中高 | 不推荐 |
| C 混合 | 保留 WS 协议与 `ActionDispatcher`（`src/voxkin/agent/actions.py:57-74`），桥接新增 `skills/` 模块逐个移植；Core 增加状态与结果上下文、长任务队列；只借 action_manager/self_prompter 的设计 | 自己维护技能层与插件组合，每个动作要补测试 | 插件版本漂移；`bot.modes` 等隐式依赖要显式化 | 不变，动作继续在后台任务（`pipeline.py:188-195`） | 低-中 | 推荐 |

## 4. 推荐路线与阶段计划

选择 C 的理由：语音链路已经按“流式文本 + 分句 TTS + 后台动作”工作（`pipeline.py:167-199`），MindCraft 的价值集中在技能实现与目标编排；把它的 agent 循环搬进来会破坏这条链路（`prompter.js:214-262`、`agent.js:404-425`）。

| 阶段 | 动作清单 | 验收方式 | 预计改动文件 | 工期 |
| --- | --- | --- | --- | --- |
| P0 可观测性 | 状态快照注入、`action_result` 进入下一轮上下文、detail 可朗读 | 玩家问“你在哪、血量、手上拿什么”时模型直接答；故意让挖矿失败，下一轮模型能引用失败原因；`pytest tests/test_pipeline.py tests/test_actions.py -q` 通过 | `bridge/minecraft_bridge.js`、`src/voxkin/server.py`、`runtime.py`、`pipeline.py`、`memory.py`、`agent/tools.py`、`tests/test_bridge.py` | 2-3 |
| P1 跟随 | `follow_player`、`come_to_player`、`stop` | 玩家跑 20 格，bot 保持 2-4 格；说“停”1 秒内停下；玩家离线返回失败 | `bridge/minecraft_bridge.js`、`agent/tools.py`、`pipeline.py` | 2 |
| P2 战斗 | `attack`、`retreat` | `/summon zombie` 后 15 秒内击杀；无目标返回“附近没有”；被打时能后撤 | 桥接新增 `skills/combat.js`、`tools.py` | 3 |
| P3 采集 | `mine`、`search_block` | 10 个 `oak_log` 采 5 个，数量一致；工具不足返回原因；背包满时提示 | 桥接新增 `skills/gather.js`、`tools.py` | 3-4 |
| P4 建造 | `place_block`、`build` | 平地放 5x5 墙；缺料返回缺口数量；`small_wood_house` 在创造模式完成度 100% | 桥接新增 `skills/build.js`、`tools.py` | 4-6 |
| P5 合成 | `craft`、`smelt`、`craftable` | 4 个 `oak_log` 合成 8 个 `oak_planks`；`raw_iron`+`coal` 熔成 `iron_ingot`；无桌时自动放桌并收回 | 桥接新增 `skills/craft.js`、`tools.py` | 3 |
| P6 箱子 | `chest_deposit`、`chest_withdraw`、`chest_view` | 箱子存 10 个圆石再取 5 个；`chest_view` 数量一致 | 桥接新增 `skills/chest.js`、`tools.py` | 2 |
| P7 长任务 | `task_start`、`task_status`、`task_cancel` | “砍 20 个木头再做 4 个木棍”分步执行并逐步播报；`task_cancel` 1 秒内停止 | 新增 `src/voxkin/agent/tasks.py`、`pipeline.py`、`runtime.py`、`tools.py` | 4-6 |

P0 的关键设计：桥接每 5 秒发的 `state` 增加背包摘要、手持物、附近敌对生物数（现有字段见 `bridge/minecraft_bridge.js:364-378`）；Core 在 `Runtime` 保存最近快照，由 `ContextBuilder.build` 作为 system 行注入（`src/voxkin/memory.py:247-267`）。失败详情目前只进事件（`pipeline.py:349-361`），需要写成一条 system turn，下一轮才能看见。`detail` 成功时会被 `announce("好了，{detail}。")` 直接朗读（`pipeline.py:365`），失败时只播报固定句子（`:361`）；因此成功文案保持可朗读中文、控制在 60 字内，不要放 JSON，失败详情写进 system turn。

## 5. 接口映射样例

`detail` 草案均按“可朗读”写，失败信息同样要进入上下文。

| 动作 | MindCraft 实现 | Voxkin tool 与参数 | `detail` 草案 | 桥接实现要点 |
| --- | --- | --- | --- | --- |
| follow | `skills.js:1331-1394`、`actions.js:103-111` | `follow_player {player?: string, distance?: number}`，distance 限制 1-6 | 成功“已跟上 Steve，保持 3 格”；失败“找不到玩家 Steve” | 现有 `GoalFollow`（`bridge/minecraft_bridge.js:269-307`）已够用，补玩家重连后重新解析、被新动作替换时清 goal |
| attack | `skills.js:313-368`、`actions.js:310-317` | `attack {type?: string, range?: number, kill?: boolean}` | 成功“击败 zombie，攻击 6 次”；失败“附近 16 格没有 zombie” | 加载 `mineflayer-pvp`，按 `attackDamage` 选武器（`skills.js:24-34`），`bot.pvp.attack(entity)` 后等实体失效（`:356-363`） |
| mine | `skills.js:417-529`、`actions.js:255-265` | `mine {block: string, count: integer, radius?: number}` | 成功“挖到 7 个 oak_log，背包共 12 个”；部分“只挖到 3 个，工具不够好” | 加载 `mineflayer-collectblock`；`bot.tool.equipForBlock`（`:480`）、`bot.collectBlock.collect`（`:506`）、挖完 `pickupNearbyItems`（`:531-559`） |
| place/build | `skills.js:611-789`、`build_goal.js:20-78`、`actions.js:301-308` | `place_block {block, x, y, z, face?}`；`build {blueprint, origin?}` | 放置“放置 oak_planks 于 (12, 64, -3)”；建造“小木屋完成 18/42 块，缺 oak_planks 24” | 去掉 `/setblock` 作弊分支（`:634-680`），保留相邻面选择与远近调整（`:716-780`）；蓝图按 `build_goal` 逐格扫描、缺料计数 |
| craft | `skills.js:36-115`、`actions.js:266-276` | `craft {item: string, count: integer}` | 成功“合成 8 个 oak_planks，消耗 2 个 oak_log”；失败“缺少 crafting_table” | `bot.recipesFor` 与 `bot.craft`（`:53,103`）；桌子的放置/收回（`:56-83`）；删掉 `bot.armorManager.equipAll()`（`:112`） |

## 6. 许可与上游维护

| 事项 | 结论 | 证据 |
| --- | --- | --- |
| 许可类型 | MIT，允许使用、复制、修改、合并、发布、再许可、销售 | `LICENSE:5-6` |
| 复制代码的义务 | 保留版权声明与许可声明；建议附改动说明，MIT 本身不强制 | `LICENSE:3`、`:12` |
| 直接 require 的义务 | 同样只需保留声明；若打包分发 `node_modules`，把 LICENSE 一并带上 | `LICENSE:12` |
| 作为库调用的可行性 | 仓库定位是应用；`package.json` 无 `main`/`exports`，入口在 `main.js:1`，只能按文件路径导入 | `package.json:1-7`、`main.js:1` |
| 依赖补丁 | 6 个 `patch-package` 补丁，覆盖 pathfinder 12KB、mineflayer、minecraft-data 协议等；安装时自动打补丁 | `package.json:45`、`patches/mineflayer-pathfinder+2.4.5.patch:1`、`patches/minecraft-data+3.97.0.patch:1` |
| 上游节奏 | 1671 commits，2023-08-15 起；2025-08 有 87 次、2025-09 有 63 次；2026-05 后提交稀少（5 月 3 次、6 月 3 次、10 月 1 次），HEAD 为 2026-10-02，`v0.1.4` 标签为 2026-03-20 | 本地 git 元数据（`git rev-list --count HEAD`、`git log --date=format:%Y-%m`、`git log -1 v0.1.4`） |

上游风险：内部模块没有版本边界，HEAD 在 `v0.1.3` 之后又有 130 个提交；`patch-package` 补丁绑定精确版本（`package.json:21,45`）。建议复制时在 `bridge/vendor/mindcraft/REVISION` 记录 `f6a9556` 与来源 URL，保留 `LICENSE` 与改动说明，每季度手工 diff 一次，不跟随 `develop`。

## 7. 不建议复用的部分

| 机制 | 与“流式语音优先”的冲突 | 证据 |
| --- | --- | --- |
| 整条 agent 回合 | 等完整 LLM 字符串返回后才 `routeResponse`，首句无法先合成 | `src/agent/agent.js:317-320`、`src/models/prompter.js:214-262`；我们的分句流见 `pipeline.py:167-199` |
| `speak` / 整段 TTS | 整段文本进队列后整段请求远程 TTS，和 GPT-SoVITS 的逐句流式队列重复 | `src/agent/speak.js:11-27`、`agent.js:404-425`、`pipeline.py:292-311` |
| Socket.IO 单入口 | 只有 `send-message` 文本注入，服务固定 `localhost`，没有动作接口 | `src/mindcraft/mindserver.js:258-268`、`:279-285` |
| `!newAction` 代码生成 | LLM 写 JS 并执行，5 次尝试；`allow_insecure_coding` 关闭时不可用；`lockdown.js` 在当前 HEAD 上自递归 | `actions.js:28-52`、`coder.js:31-90`、`settings.js:43`、`lockdown.js:9-21` |
| `modes` 常驻循环 | 300ms tick 自主行为会与玩家指令抢占，并通过 `say` 自行发声 | `agent.js:502-517`、`modes.js:7-11,399` |
| 每 5 条 history 摘要 | 额外 LLM 调用，和我们按预算裁剪的 SQLite 记忆重复 | `history.js:72-78`、`memory.py:217-236` |
| `!cmd(args)` 正则入口 | 我们已用结构化 tool call，多一层文本解析只会增加歧义 | `commands/index.js:29-30,97-174` |

## 8. 第一批 10 个动作（按价值排序）

| # | 动作 | MindCraft 参考 | 桥接实现要点 | 验证所需游戏条件 |
| --- | --- | --- | --- | --- |
| 1 | `get_state` | `queries.js:14-65`、`full_state.js:12-108` | 扩展现有 `sendState` 字段（`bridge:364-378`），Core 保存并注入 system | 生存模式，任意位置，问坐标/血量/手持物 |
| 2 | `inventory` | `queries.js:66-101`、`world.js:262-282` | 数量 + 装备槽 + 手持物，输出一行式文本 | 给 bot 若干物品后查询 |
| 3 | `follow_player` | `skills.js:1331-1394` | 沿用 pathfinder `GoalFollow`，补玩家重连与停止 | 玩家持续跑动 20 格，中途说停 |
| 4 | `come_to_player` | `skills.js:1294-1328`、`goToGoal:1070-1113` | 非破坏路径优先，卡住时开门（`:1116-1179`） | 玩家在 30 格外，中间有门或台阶 |
| 5 | `attack` | `skills.js:313-368` | 加载 pvp，选最佳武器，等实体失效 | `/summon zombie`（需开作弊）或生存夜晚 |
| 6 | `mine` / `collect_blocks` | `skills.js:417-529` | 加载 collectblock，工具选择，拾取掉落物 | 附近 10 个 `oak_log`；另测无工具挖石头 |
| 7 | `craft` | `skills.js:36-115` | 配方查询、桌子放置/收回、数量上限 | 4 个 `oak_log`；另测需要桌子的木镐 |
| 8 | `place_block` | `skills.js:611-789` | 相邻面选择、距离调整、失败原因 | 平地，背包有 `cobblestone` |
| 9 | `chest_deposit` / `chest_withdraw` | `skills.js:869-942` | `openContainer`、按槽位分批存取、数量校验 | 放置箱子并预置物品 |
| 10 | `smelt` | `skills.js:142-273` | 燃料换算、输入/输出循环、11 秒无输出退出 | 熔炉、煤、`raw_iron` |

## 9. 风险与验证顺序

- 先做 P0。动作再多，模型看不见状态与结果就无法多步重规划，`docs/ROADMAP.md:11` 也把“工具结果回填”列为 P0。
- 每个技能先在 Node 侧用假 `bot` 做单元测试，再接入 WS；现有 `tests/test_bridge.py:104-120` 已给出假桥接的写法。
- 版本风险：MindCraft 依赖 mineflayer `^4.33.0` 与 minecraft-data `3.97`（`package.json:19,21`），我们的桥接是 `^4.24.0`（`bridge/package.json:13`）；移植前先在目标 1.21.1 服务器上跑通插件冒烟测试。
- 建造蓝图的坐标与朝向依赖 `build_goal.js:20-78` 与 `rotateXZ`（`npc/utils.js:121-126`），先在创造模式验证，再放到生存模式。
