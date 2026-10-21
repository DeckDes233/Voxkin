# Minecraft 技能审计（只读快照）

审计时间 2026-10-22，对象为 `bridge/minecraft_bridge.js`、`src/voxkin/agent/*`、`src/voxkin/pipeline.py`、`tests/`。本次只读代码并运行现有测试（111 passed，7.93s），未连接真实 Minecraft，未改生产代码，未提交 git；工作树中的并发改动不属于本次审计。

审计基线：commit `b602e1d`（`develop`）。审计期间工作树被并发修改（未提交），本表与所有行号均指该 commit；工作树差异见 §5。

## 0. 口径与总量

| 项 | 现状 | 证据 |
| --- | --- | --- |
| bridge 动作分支 | HEAD 14 个 `case`，无注册表；审计时工作树已增到 19 个（未提交） | `bridge/minecraft_bridge.js:189-271`；§5 |
| Python 工具 schema | HEAD 13 个；工作树 18 个（未提交） | `src/voxkin/agent/tools.py:5-215`；§5 |
| 技能模块约定 | 只有 README，`manifest.js`、`index.js` 不存在 | `bridge/skills/README.md:96-126` |
| 动作超时 | Core 单值 120s；bridge 从不读 `timeout_s` | `src/voxkin/agent/actions.py:20,81`；`src/voxkin/bridge/protocol.py:21` |
| 取消 | 仅 `attack_nearest`、`stop` 抢占，且只有部分函数检查 `interrupted` | `bridge:70,134-143,303,321,356,609` |
| 结果回填 | 工具结果只播报，不进下一轮上下文 | `src/voxkin/pipeline.py:199-206,342-389` |
| S0 模板 | 5 步，`PLANS` 仅 S0 | `src/voxkin/agent/plans.py:5-50` |
| 阶段表 | S0-S6 按背包判定 | `src/voxkin/agent/progress.py:15-98` |

状态口径：existing=有工具名与 bridge 分支且参数基本吻合；partial=能力存在但不可独立调用或后置不校验；missing=没有可编排实现（内部辅助函数不算）；blocked=外部条件缺失。本表按 HEAD 计，工作树新增项见 §5。P0 20 项：existing 6、partial 7、missing 7。

零干预口径：`follow_player`、`come_to_player` 在独立通关时因无玩家而 blocked（`bridge:199`、`bridge:924-939`），共玩场景仍按表中状态使用。

## 1. 总表

### 1.1 P0（规格 20 项）

| # | skill_id | 状态 | 现有实现（文件:行号） | 缺口 | 首批 |
| --- | --- | --- | --- | --- | --- |
| 1 | observe_self | partial | `src/voxkin/world_state.py:79-120`；`src/voxkin/pipeline.py:109-113` | 无工具；「在哪/几点」靠状态注入，无 `state_age` 字段 | 4 |
| 2 | observe_environment | missing | 状态帧只有 `players`（`bridge:1331-1343`） | 无周边方块/实体清单 | 2 |
| 3 | inventory | existing | `tools.py:89-96`；`bridge:216-222` | detail 截断 400/500（`bridge:219,290`），无装备槽、耐久、手持分项 | — |
| 4 | locate_block | missing | 内部 `bridge:1069-1081`，固定 `count=1` | 不返回坐标，只服务 `goto_block`/`break_block` | 2 |
| 5 | locate_entity | missing | 内部 `bridge:941-948,963-974` | 结果只进战斗/跟随，无查询入口 | 2 |
| 6 | move_to | existing | `tools.py:21-36`；`bridge:241-243,296-335` | 备用 `GoalXZ` 丢 y（`318`），垂直差 >2 仍报成功（`339-342`），最多 10 段（`302`） | — |
| 7 | approach_target | missing | 内部 `bridge:535-545` | 吞异常只写日志，无距离参数 | 6 |
| 8 | follow_player | partial | `tools.py:57-75`；`bridge:1118-1182` | 独立模式禁用（`199`），5 分钟自停（`1139-1143`），会索要坐标（`930-934`） | — |
| 9 | stop_movement | partial | `tools.py:37-44`；`bridge:194-196,1184-1200` | 只停跟随与寻路，队列中后续动作照跑（`bridge:159-162`） | 3 |
| 10 | come_to_player | existing | `tools.py:76-88`；`bridge:206-215` | 走向玩家旧坐标，垂直差 >2 仍 ok（`210-213`） | — |
| 11 | collect_blocks | partial | `tools.py:9-19`；`bridge:345-369` | 只 `dig` 不拾取，无背包增量校验，换工具失败静默（`371-378`） | 7 |
| 12 | mine_block | existing | `tools.py:118-136`；`bridge:380-399`（名为 `break_block`） | 无中断检查、无方块更新校验，skill 名与实现名不一致 | 1 |
| 13 | equip_item | partial | `bridge:950-957,1253-1260` | 无工具；只认 sword/axe 与自动穿甲，无盾、副手、食物 | 8 |
| 14 | use_item | missing | 仅 `bridge:587-601` 内部射箭 | 无右键/桶/骨粉等通用入口 | — |
| 15 | eat_food | partial | 反射 `bridge:715-726`，触发 `892-895,919-921` | 无工具；`consume` 失败只写日志，无 food 增量校验 | 5 |
| 16 | craft_item | existing | `tools.py:192-214`；`bridge:502-533` | 材料不足也先放工作台（`510-517`），只取 `recipes[0]`（`522`） | 8 |
| 17 | place_block | existing | `tools.py:137-153`；`bridge:401-433` | 只收绝对坐标，目标非空即失败（`406`），无放置后校验 | — |
| 18 | attack_target | missing | 内部 `bridge:603-659` | 需要实体句柄，无 `case`，不可编排 | 6 |
| 19 | attack_nearest | partial | `tools.py:97-114`；`bridge:223-240` | 只 `lookAt`+`attack` 不接近；苦力怕后撤在 `670-673` 未复用 | 6 |
| 20 | assess_threat | missing | 内部 `bridge:896-918` | 只用于自动开战，无威胁摘要 | 2 |

### 1.2 P1 / P2

规格原文未入库，下表按 `docs/research/SKILL_CATALOG.md:151-177` 与 `docs/plans/INDEPENDENT_RUN_ROADMAP.md:143-164` 合并，条目待与规格核对。

| 优先级 | skill_id | 状态 | 现有实现 | 缺口 |
| --- | --- | --- | --- | --- |
| P1 | pickup_items | partial | `tools.py:174-191`；`bridge:445-457` | 只走近，不拾取、不回报数量 |
| P1 | smelt_item | missing | 无 | 熔炉交互、燃料核算 |
| P1 | sleep | missing | 无 | 床检测、夜晚判定、起床确认 |
| P1 | equip_armor | partial | `bridge:1253-1260` | 每 15s 自动穿，无显式技能与槽位选择 |
| P1 | scan_surroundings | missing | 无 | 周边方块/生物摘要 |
| P1 | use_block | missing | 无 | 门、按钮、拉杆、工作台右键 |
| P1 | store_item / take_item | missing | 无 | 箱子窗口与槽位遍历 |
| P1 | give_item | missing | 无 | 丢出与 `playerCollect` 确认 |
| P1 | trade | missing | 无 | 村民清单、次数上限 |
| P1 | dig_down / go_to_surface | missing | 无 | 安全竖井、回地表 |
| P1 | wander / stay | partial | `bridge:998-1042` 闲逛内部 | 无工具入口；`stay` 无 |
| P1 | defend | partial | `bridge:661-690` | 只由受伤事件触发，无显式技能 |
| P1 | say / chat | partial | `bridge:190-193` 有 `case` | `tools.py` 无 schema，模型无法调用 |
| P2 | build_blueprint / nether_portal / end_run / bow_kite / shield_block | missing | 无 | 见 `roadmap:130-140` |
| P2 | fishing / 载具 / 附魔 / 收获 / waypoint / task_* | missing（`task_*` partial） | `run_manager.py:61-91` | 无阶段模板，只有 S0 |

## 2. P0 详细卡

约定：超时以 `src/voxkin/agent/actions.py:81` 的 120s 为默认，bridge 侧无 deadline。取消指 `stop` 抢占（`bridge:134-143`）。测试方法列只写可在本仓库执行的用例，未执行的标「未验证」。

### 2.1 感知

| skill_id | 参数 | 前置 | 后置 | 失败原因与恢复 | 超时 / 取消 | 测试方法 | 状态证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| observe_self | 无 | 桥接已连接，state 新鲜度 ≤30s（`actions.py:41-46`） | 返回坐标、朝向、维度、时间、血量、饥饿、天气 | 状态过期返回空串（`world_state.py:84-85`）；恢复=等下一帧 | 无动作；状态 5s 一帧（`bridge:1261,1322-1365`） | `tests/test_world_state.py` 已覆盖格式化；语音问答未验证 | 无工具，`pipeline.py:109-113` 注入 |
| observe_environment | 半径 | 已进世界 | 返回周边方块/实体、坐标、距离 | 无实现，无失败路径 | 建议 1s（`bridge/skills/README.md:19`） | 新建 fake bot 断言清单 | missing |
| inventory | 无 | 已进世界 | 物品名与数量完整 | 未进世界报「bot 尚未进入世界」（`bridge:169-172`）；detail 截断丢失尾部 | 120s / 不可取消 | `tests/test_bridge.py:104-127` 只验协议帧 | existing |
| locate_block | block、range≤32、count | 区块已加载 | 最近坐标、距离、可挖判定 | 找不到抛「附近 N 格内没有」（`1077-1079`）；恢复=扩大范围或换目标 | 建议 1s / 不可取消 | fake `findBlocks` 返回固定坐标 | missing |
| locate_entity | type、range、hostile 过滤 | 实体已加载 | id、类型、距离、是否敌对 | 无 | 建议 1s | fake `entities` 注入 | missing |
| assess_threat | range | 已进世界 | 敌对列表、最近距离、是否已交战 | 无 | 建议 1s | 固定 3 只 hostile 断言排序 | missing |

### 2.2 移动

| skill_id | 参数 | 前置 | 后置 | 失败原因与恢复 | 超时 / 取消 | 测试方法 | 状态证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| move_to | x、y、z | 桥接在线，区块可加载 | 水平 ≤2 且垂直 ≤2 | 无路径报「走不过去」（`334`）；分段失败降级直连（`313`）；恢复=换目标或挖开 | 120s；仅分段与尝试间检查 `interrupted`（`303,321`） | `tests/test_actions.py:9-25` 只测派发；真实寻路未验证 | `bridge:241-243,296-335` |
| approach_target | entity_id、distance=2 | 目标可见且存活 | 与目标距离 ≤distance | 内部 `approach` 吞异常（`542-544`），调用方继续攻击 | 无独立超时 | 断言 `pathfinder.goto` 只调用一次 | missing |
| follow_player | player?、distance 1-6 | 玩家可见，非独立模式 | 距离稳定在 distance±1 | 独立模式直接抛错（`199`）；5 分钟自停（`1139-1143`）；玩家不可见时结束（`1144-1147`） | 内部 5min；聊天「别跟」可停（`1275-1278`） | 双 ws 客户端模拟玩家移动；未验证 | partial |
| stop_movement | 无 | — | 无移动、无寻路目标、队列清空 | 未清队列，后续动作继续（`159-162`）；无 ack 回执 | 最高优先级（`70,146-148`） | 入队 3 个动作后 `stop`，断言只执行 1 个 | partial |
| come_to_player | player? | 玩家可见 | 一次到达 ≤2 格 | 目标位置取调用瞬间（`208`）；垂直差 >2 仍 ok（`210-213`）；无玩家时索要坐标（`930-934`） | 120s；`travelTo` 内检查 | 固定玩家坐标，断言水平距离 | existing |

### 2.3 采集与物品

| skill_id | 参数 | 前置 | 后置 | 失败原因与恢复 | 超时 / 取消 | 测试方法 | 状态证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| collect_blocks | block、count≥1 | 32 格内有该方块 | 背包 +count，掉落物已拾取 | 0 个报「没有成功挖到」（`367`）；掉落不拾取；恢复=换方块或扩大范围 | 120s；每块检查中断（`356`） | 真实挖 3 原木并查背包；未验证 | partial |
| mine_block | block 或 x,y,z | 目标非 air，4 格内可达 | 目标坐标变 air | 坐标缺一即报错（`385-388`）；`canDigBlock` 失败（`396`）；无掉落校验 | 120s；`stop` 会 `stopDigging`（`140`） | 固定坐标断言 `blockAt` 变化 | existing（名 `break_block`） |
| equip_item | item、slot? | 背包有该物品 | 手持/穿戴变更可见 | 无工具；`equipWeapon` 只认 sword/axe（`950-957`）；盾与副手无 | 无 | fake inventory 断言 `bot.equip` 参数 | partial |
| use_item | item、target? | 目标 4 格内 | 右键效果生效 | 无 `case`；仅射箭内部 `activateItem`（`593`） | 无 | 需要 fake bot 记录 `activateItem` | missing |
| eat_food | item? | 背包有食物，food<20 | food 增加，食物 -1 | 无工具；`consume` 失败只写日志（`723-725`）；无增量校验 | 随生存 tick 1s（`bridge:1370`） | fake `consume` 后断言 food 变化；未验证 | partial |
| craft_item | item、count 1-64 | 材料够，需要时可放工作台 | 背包 +count | 先放工作台再判配方（`510-517`），材料不足会留下一张工作台；只取 `recipes[0]`（`522`）；回收失败只写日志（`526-530`） | 120s；无中断检查 | `tests/test_runner.py:23-28` 用假 executor；真实合成未验证 | existing |
| place_block | block、x、y、z | 目标为空且有相邻固体 | 目标坐标出现该方块 | 目标非空直接失败（`406`）；周围无可依附方块（`432`）；无放置后校验 | 120s；`stop` 不清放置 | 断言 `placeBlock` 的参考面 | existing |

### 2.4 战斗

| skill_id | 参数 | 前置 | 后置 | 失败原因与恢复 | 超时 / 取消 | 测试方法 | 状态证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| attack_target | entity_id | 目标可见且存活 | 目标死亡或脱离 | 无 `case`；内部 `attackEntity` 有接近、弓、低血退出（`603-659`），不可寻址 | 20 次×600ms；有中断检查（`609`） | fake 实体生命期，断言只打指定 id | missing |
| attack_nearest | range 3-32 | 范围内有 hostile（`46-52`） | 目标消失 | 不接近，远目标空挥 24 次（`230-235`）；苦力怕不后撤；无弓、盾、低血逻辑 | 24×600ms≈14.4s；无中断检查 | 16 格放僵尸，断言接近后击杀；未验证 | partial |
| assess_threat | range | 已进世界 | 威胁清单与建议 | 无 | 建议 1s | 同 observe_environment 夹具 | missing |

## 3. 意图路由审计

`src/voxkin/intent.py:24-42` 的 `classify` 未被 `pipeline.py` 调用，只有 `tests/test_intent.py:5` 引用；实际路由由模型按 `tools.py:217-227` 提示选择。因此下表的「classify」列是规则层结果，「实际工具」是模型可用的唯一落点。

| # | 话术 | `classify()` | 实际工具 | 判定 | 需要修的路由 |
| --- | --- | --- | --- | --- | --- |
| 1 | 跟着我 | follow_player 0.9 | `follow_player` | 正确；独立模式必失败（`199`） | 独立模式改走 move_to/跟随关闭提示 |
| 2 | 不用跟着我了 | stop_movement 0.95 | `stop` | 正确；后续队列仍执行 | `stop` 清队列 |
| 3 | 来我这里 | come_to_player 0.85 | `come_to_player` | 正确 | 无 |
| 4 | 你现在在哪 | observe_self 0.75 | 无工具，仅状态注入 | 可答，但无坐标核对 | 增加 `observe_self` 工具 |
| 5 | 攻击前面那个苦力怕 | attack_nearest 0.8 | `attack_nearest` | 误：丢失「那个」，不后撤 | 先 `assess_threat`，苦力怕走撤退分支 |
| 6 | 小心，附近有苦力怕 | assess_threat 0.7 | 无工具，可能被提示引向 `attack_nearest` | 误路由为进攻 | 新增 `assess_threat`，提示改为先评估 |
| 7 | 把那个金苹果吃了 | eat_food 0.8 | 无工具 | 可能答「好」但不执行 | 新增 `eat_food` |
| 8 | 天黑了，睡觉吧 | sleep 0.8 | 无工具 | 可能误调 `craft`/`place_block` | 新增 `sleep`，无床时明确说缺 |
| 9 | 查看我有什么食物 | inventory 0.7 | `inventory` | 正确；返回全部物品 | 增加 `filter` 参数 |
| 10 | 附近有煤矿吗 | None | 可能 `goto_block`（提示 `222` 引导走位） | 误：查询变移动 | 新增 `locate_block` |
| 11 | 去砍三块木头 | None | `collect_blocks` | 目标正确，后置不校验 | 增背包增量与掉落拾取 |
| 12 | 把这块石头挖了 | None | `break_block`，无坐标来源 | 可能编坐标 | 先 `locate_block` 或加「眼前方块」感知 |
| 13 | 在这里放一块圆石 | None | `place_block`，需 x/y/z | 可能编坐标或放在脚下 | 增加相对坐标 `here` |
| 14 | 把剑装备上 | None | 无工具，可能误调 `attack_nearest` | 误路由为攻击 | 新增 `equip_item` |
| 15 | 打那只僵尸 | None | `attack_nearest` | 误：可能打最近的骷髅 | 新增 `attack_target` |

说明：1-9 来自 `tests/test_intent.py:8-21`；10-15 按 P0 技能补的常用说法，仓库内没有对应测试。

## 4. 第一批实现顺序

| 序 | 修复 | 依赖 | 验收场景 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | `bridge/skills/manifest.js` + 单一 schema 源；`mine_block` 更名或别名 | 无 | 同一份清单生成 dispatch 与 tool schema；未知参数被拒绝 | 14 个 `case` 与 13 个 schema 手写同步，新增技能必漏一侧 |
| 2 | 感知三件套：`locate_block`、`locate_entity`、`observe_environment` | 1 | 「附近有煤矿吗」返回坐标与距离且不移动；「有怪吗」返回类型、距离、敌对 | 纯读；解锁「这块/那个/这里」指代，成本最低 |
| 3 | 动作 deadline 与取消语义：`timeout_s` 生效、`stop` 清队列、迟到结果丢弃 | 1 | 注入 10s 不返回的 `dig`，`stop` 后队列为空，后续动作不执行 | 现在超时后 bridge 仍在跑，下一步会踩旧状态 |
| 4 | 工具结果回填：`action_finished`/`action_failed` 以 tool 消息进上下文，允许一次改参 | 3 | `collect_blocks` 失败后同回合改调 `goto_block`，不重复原调用 | 现在失败只播报，模型下一轮不知道发生了什么 |
| 5 | `eat_food` + food 增量校验 | 2、3 | food 14→18，bread -1；无食物时 detail 明说 | 生存链最短板，且现在完全不可编排 |
| 6 | `approach_target`、`attack_target`、苦力怕后撤复用到 `attack_nearest` | 2 | 16 格僵尸 5s 内接近并击杀；8 格苦力怕先退到 12 格；指定 id 只打该目标 | 当前 `attack_nearest` 不接近，远目标必空挥 |
| 7 | `collect_blocks` 拾取掉落 + 背包增量校验 | 3、4 | 挖 3 原木后 `oak_log` +3，detail 报实际数量 | 资源循环的入口，掉落 5 分钟消失 |
| 8 | `craft_item` 材料预检与工作台回收；`equip_item` 统一装备/工具/食物 | 5 | 材料不足时不留工作台；合成后 `crafting_table` 回背包；剑可被点名装备 | 直接决定 S0 成功率 |

工作树已在做的 `observe`、`eat`、`locate_*`、`sleep` 已在 `e1ee85e` 合并，覆盖批次 2、5 的一部分；合并后仍需按上表场景补真实世界验收。

## 5. 未验证与文档漂移

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 真实 Minecraft 端到端 | 本次未运行；`node --check` 通过 | 审计命令 |
| bridge 逻辑测试 | 无 JS 单测；`test_bridge` 只验 WebSocket 帧与派发 | `tests/test_bridge.py:104-127` |
| 测试数量 | 文档已统一为 134；本次实跑 134 | `docs/STATUS.md:27`；`docs/MILESTONE.md:46`；`docs/plans/EVALUATION.md:17` |
| 路线图交付物 | `scripts/run_stage.py`、`bridge/skills/manifest.js` 不存在 | `docs/plans/INDEPENDENT_RUN_ROADMAP.md:102-107` |
| 独立模式接线 | `VOXKIN_INDEPENDENT` 只在 bridge 读取，Python 侧零引用 | `bridge:90,1209-1211` |
| 动作数量 | 文档写 19 个，新增 5 个技能后 `case` 为 19 个 | `bridge:189-380` |
| 并发改动 | `observe`、`eat`、`locate_block`、`locate_entity`、`sleep` 已在 `e1ee85e` 提交；本表状态仍按 `b602e1d` 基线，这 5 项未逐行重评 | `git show e1ee85e --stat` |
| 行号基线 | 本表按 `b602e1d`，工作树行号已偏移；核对用 `git show b602e1d:bridge/minecraft_bridge.js` | 同上 |

最大风险：没有真实服务器证据，且超时/取消没有世界侧确认。动作在 Core 侧已判失败时，bridge 仍可能继续执行并推进队列，界面与语音会报告「好了」或「没做成」，世界状态却已改变，后续步骤据此继续。
