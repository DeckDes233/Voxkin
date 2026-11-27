# 当前状态

最近实机验证于 2026-11-27（Asia/Shanghai）。

[文档导航](README.md) · [证据索引](evidence/README.md) · [路线图](ROADMAP.md)

11 月 27 日从第五局保存的第 71 个动作恢复 S4。Voxkin 复活后换区找回 7 根橡木，第 120 个动作结束时仍缺钻石镐。当天两次空背包开局均通过 S0、S1，S2 均达到 30 分钟时限。第一局受阻于岸边采木，修复后在终点存档的独立对照中取到橡木。第二局实测上岸后走了 25.9 格继续找羊，最终在夜间因苦力怕封住取土点，未能完成建棚。历史连续最高进度仍为通过 S4 并进入下界。[暂停恢复与两次新世界记录](evidence/NATURAL_S0_S6_20261127.md)

11 月 25 日五次空背包开局中，三次连续通过 S0–S4。第二轮自采十块黑曜石，给门框排水点火并进入下界，探索玄武岩台地时用尽 S5 的 120 个动作。第三轮在 S3 后意外中断，存档回退。第四轮在 S3 死亡后重做铁装，用 18 个动作通过 S4，在 S5 做箱储物并取得十一块黑曜石，之后两次死亡，在重建途中用尽预算。独立复制第四轮死亡前的存档后，同一任务用已有口粮成功建门，于 20:05 进入下界，最终仍缺烈焰棒和珍珠。第五轮在 S3 从淹水矿道上岸并实走 18.3 格换区，之后溺亡。复活后重新取得五根橡木、九个粗铁，累计 90 个动作做齐铁镐、铁剑、盾牌和桶，通过 S3。五轮均未进入 S6。[本轮实机记录](evidence/NATURAL_S0_S6_20261125.md)

合入 main 后，两轮从空背包开始的生存实测均连续通过 S1–S4。最近一轮中，S3 死亡后重做装备，S4 在进水矿井中封水换路，采得五颗钻石并合成钻石镐。S5 做出了打火石并装好水桶，随后在夜间被蜘蛛击杀。复活后的三次就近取食未取得生肉，正式任务 5 在该方法的失败预算处结束。另一个自然建门的存档验证了下界侦察，独立 S6 实测验证了出洞猎食。S5–S6 仍缺连续通关验收。[两轮生存实测及存档](evidence/NATURAL_S1_S6_20261124.md) · [上轮生存复测](evidence/SURVIVAL_RERUN_20261123.md)

S5 在同一生存存档取得打火石和水桶，从地下水层上岸后成功换区。岩浆池对照采齐 10 块黑曜石并建门进入下界。S6 的要塞对照填满天然末地门，从出生平台搭桥上岛。连续副本打掉八颗无遮挡水晶。清除附近末影人后，角色在对照中打掉最后两颗笼内水晶，对龙造成实际伤害。完整验收仍缺 S5 的 12 根烈焰棒、24 颗珍珠及返程，以及 S6 的击龙事件和返程。[试验条件与实际回执](evidence/HEADLESS_S4_S6_20261123.md)

## 2026-11-22 无头 Paper 验证

隔离新世界通过 S0–S2。S3 采得 12 个粗铁后，在夜间缺木时耗尽时限。第一轮对照补给了煤和木板。最终从采木失败的账本续跑，Voxkin 自行取得 4 个橡木原木，用木板熔炼 9 个铁锭并做齐四件装备。修复观察遗漏副手盾牌后，同一任务在第 24 个动作后通过验收。搜索木材期间，Studio 连续三次查询背包都拿到真实库存，原采木动作继续执行。独立采矿测试也在查询后采齐 4 块安山岩。实机使用文本输入和静音输出。Windows 历史原生崩溃仍待定位。[运行与回执记录](evidence/HEADLESS_S3_20261122.md)

以下按各次运行保留当时的结论、验收环境和待办。当前进度见页首。

## 2026-11-11 推送前离线复核

Python 554 项、Bridge 310 项通过，文档与私密文件检查通过。补齐文档导航、开发/配置/脚本说明并保留历史验收边界；没有启动 Minecraft，不改变下述实机结论。测试权限调整、命令和剩余验收项见[本次复核](evidence/PRE_PUSH_REVIEW_20261111.md)。

## S3 避险后继续任务

G1 自主通关与 G2 玩家互动已分别写入 AGENTS、README 和 MILESTONE。局部采矿失败现在可以记录旧区域并换矿区，使用真实位移和新鲜观察验收。首轮换区修复实测通过 S0–S2，但 S3 暴露低氧抢占后重复同一采铁动作的问题，最终触发抢占预算；角色未死亡。已继续修复结构化危险回执、避险后换区，以及换区后采矿排除旧危险点。Core 相关 111 项、清单/工具 38 项、Bridge 全量 289 项通过。

再测通过 S0–S2，但 S3 遭遇 Bridge JS 构造函数异常退出；随后正式 `--continue-task` 保留存档、背包、原 deadline 和 pending 续测，对账成功后 Node 在关闭 JIT 模式下仍发生 V8 fatal/native 退出。因此 S3/S4 尚未通过，新低氧换区链还缺实机确认。来源摘要不变，所有进程已清理，未确认动作保留。Windows 日志另外查到历史处理器核心 WHEA parity 纠错，尚未证明与所有异常同源。详见 [恢复实现与调查](evidence/S3_MINING_RELOCATION_20261028.md)及[现场续跑](evidence/S3_CONTINUE_JITLESS_WINDOWS_20261028.md)。

## S2 采集数量口径修复

已确认上轮 S2 阻塞原因：结构缺格未扣除已有建材，采集目标随库存上涨；Bridge 将总库存目标截成 64，成功回执与 Core 原目标不一致，三次验收失败耗尽预算。修复净缺料计算、跨堆采集以及参数范围校验，保留真实库存验收。Python 相关 124 项、Bridge 全量 283 项通过，详细证据见 [S2 数量合同修复](evidence/S2_COLLECTION_CONTRACT_20261028.md)。新一轮 Windows 隔离实测通过 S0（63.0 秒）、S1（164.7 秒）、S2（61.0 秒）；S3 在 276.7 秒以 `s3_ore_route_exhausted` 阻塞，粗铁 8 个，后续巷道挖矿遇水或无安全阶梯落点；S4 未运行。S2 仅确认白天过夜准备，未实际睡眠。本轮无低氧或死亡日志，未触发水中自救验证。运行器通过 RCON 正常停服，Paper 保存全部维度，进程和端口清理完成，无 Bridge 重启。详见 [补料修复后实测](evidence/S0_S4_COLLECTIONFIX_WINDOWS_20261028.md)。

## 水中自救修复后 S0–S4 实测

用户授权再次使用 Windows 隔离新世界连跑。S0 **63.0 秒**、S1 **148.4 秒**通过；S2 在 **207.5 秒**以 `budget_method_attempts` 阻塞，S3/S4 未运行。庇护所先报告内部方块占用、随后缺建材；Bridge 后续报告泥土库存达到 64，阶段仍记录材料观察缺口及三次失败，原因后续已确认并修复，见上节。最终血量 20、饥饿值 16，没有观察到低氧或死亡，因此本轮不能证明水中自救修复实机有效。

Paper 已保存全部维度，运行器无清理错误和 Bridge 重启，测试进程与监听端口已清理；保留新世界和数据库，未重置旧任务预算。详见 [水修后实测](evidence/S0_S4_WATERFIX_WINDOWS_20261028.md)。下文为此前修复及运行记录。

## S3 水中脱困修复

先核对 Minecraft Wiki 与 Java 1.21.1 机制后，修复共用水中自救：正确朝向、区分水域与呼吸空间、顶棚阻挡时沿可通行路线侧移、检查真实眼高与氧气恢复，恢复前阻止普通任务复工。两个游泳技能与本地低氧反射共用实现。保存地形的 Prismarine physics 回放通过，最终 Bridge 全量 281 项、Python 相关 57 项通过；没有修复后实机复测。机制来源、地形证据与测试边界见 [水中脱困记录](evidence/WATER_ESCAPE_20261028.md)。

## Terra Windows S0–S4 有界实测

用户在只读复核后明确授权再次启动，Terra 6.1 high 使用 Windows 原生运行时、独立新世界与新任务数据库执行一次 Normal S0–S4 连跑。S0 **63.1 秒**、S1 **140.3 秒**、S2 **109.7 秒**通过；S2 的 `night_required=false`、`sleep_confirmed=false`，本次只验收白天过夜准备。S3 期间 Paper 记录角色溺水，重生后开始重建物资，在 **360.4 秒**达到阶段时间上限；S4 未运行。

本轮 Bridge 无重启，Paper 保存全部维度，运行器 `cleanup_errors=[]`。清理后的独立 PowerShell 检查仍发生 CLR `0x80131506`，不能据本次游戏进程存活宣称宿主原生崩溃已修复。此次开局设置 Normal 与白天，旧 task 7、预算和来源存档未用于重置连跑。详细启动、阶段、死亡与清理证据见 [Terra 实测](evidence/S0_S4_TERRA_WINDOWS_20261028.md)。

针对 Terra S3 的低氧与死亡记录，当前工作树加入共享水中脱困路线：局部有界寻路绕开顶棚，确认眼部空气和氧气恢复后才成功，并由本地低氧 reflex 与 `swim_out` 共用；呼吸恢复前会阻止挖掘、寻路和睡眠。Bridge 定向回归及 shelter 回归 **23 passed**，两个相关模块语法检查通过。该实测早于这组改动；离线回归不能证明真实水域脱困，也不改变 `runtime_blocked=true`。细节、来源与 task 7 状态见 [水中自救修复与验证](evidence/WATER_ESCAPE_20261028.md)。

## 资源储备、村庄补给与铁傀儡取铁

阶段采集增加最低需求与储备软目标，按阶段批量采木、石料、铁矿和煤，并考虑已有库存、血量与背包空位。村庄机会补给接入真实床、箱子与干草观察；使用现成床、箱中面包/铁锭/工具等资源，干草按实际配方转麦子和面包。空点记账后回到原路线，不无限重复。新增 `loot_village`、`harvest_iron_golem` 两个技能，后者有界靠近、核实三格立柱、蹲伏并在冷却完成和有效下降攻击距离内出手，以实际铁锭增量验收。

Windows 离线 Bridge **273 passed**，Python **507 passed**（`--assert=plain`，正常断言仍执行）。默认 pytest 收集测试时再次发生 Windows 原生访问违规，日志保留；改变断言重写方式后一次全量通过不代表宿主已恢复。未运行 Minecraft，`runtime_blocked=true` 保持。实现、资源目标、测试替身和村庄识别边界见 [资源与村庄修复记录](evidence/RESOURCE_VILLAGE_GOLEM_20261028.md)。

## S4–S6 与群怪战斗修复

已扩展到 S4–S6：修复 S4 食物目标、缺镐恢复、石材配方与木板燃料，以及水源/岩浆候选耗尽后的有界探索；S5/S6 按实时库存和维度规划，避免下界重复补主世界材料、门框已找到仍停在搜索分支，以及末地消耗箭后反复要求主世界补给。末影龙击杀事件区分既有返回门与本次战斗证据。

战斗加入逐次出手的群怪威胁评估、自动目标切换、按武器和穿戴护甲判断撤退、苦力怕引爆感知，以及考虑多只怪物的退路评分。中立末影人不主动攻击，猎取末影人改用近战；另修复原木加工、床/火把方块查询和弓箭缺木材搜索问题。

Windows 离线全量：Python **502 passed**，Bridge **251 passed**；清单更新后相关 Python 回归 **37 passed**，语法与差异检查通过。未启动 Minecraft，`runtime_blocked=true` 保持；这些测试不代表 S0–S6 实机通关或宿主崩溃根因已修复。详细依据、改动与替身测试边界见 [S4–S6 与群怪修复记录](evidence/S4_S6_COMBAT_20261028.md)。

## S0–S3 生存流程修复

已核对 Java 1.21.1 的通关依赖、配方、矿物掉落和工具等级，并完成本轮代码修复：S0/S1 按当前背包补齐依赖，支持任意主世界树种；S2 不再为做床强制先采铁，有剪刀则剪毛，否则寻找成年羊取得同色羊毛，饥饿时可利用羊肉；S3 同时识别普通与深层铁矿，搜索无进展后分段朝 Y=16 探矿，并使用实际可用燃料分批熔炼。找不到资源继续有界移动搜索。S0/S1 的完成进度按目标物品计数，不再依赖固定步骤游标。

Windows 离线验证：Python **488 passed, 54 warnings in 76.76s**，Bridge **233 passed**；语法检查与 `git diff --check` 通过。新增测试实际扣除配方材料，覆盖八种主世界木材和 S0→S1→S2→S3 的监督器连续任务，世界与动作结果使用确定性替身。旧任务暂停、断线对账、回执兼容和预算相关回归也通过。流程依据、实现及验证边界见 [S0–S3 修复记录](evidence/S0_S3_PROGRESSION_20261028.md)。

未启动 Minecraft，未修改旧任务预算或存档。活动 marker 仍为 `runtime_blocked=true`；本轮结果不等于 S0–S3 实机通过，也不表示原生崩溃根因已解决。

## Astra 综合复核

本轮复核发现近四天 21 种程序共 249 条访问违规记录，并再次确认处理器 WHEA parity/cache 错误，宿主稳定性是优先调查项，Node 根因尚未确定。代码修复了候选耗尽后不再搜索、S0 与技能采集实现分叉，以及寻路超时只软停止的问题。Python 全量 476 项、Bridge 225 项测试通过；未启动游戏，S0–S4 不视为实机通过。材料选择和专用阶段路线的剩余限制逐项记录在 [综合复核](evidence/ASTRA_AUDIT_20261028.md)。

## Bridge 访问违规调查

最新 Bridge 是以 `0xC0000005` 退出的 Node 进程；没有其 Windows 异常参数、原生调用栈或 Node dump，不能定位具体函数。该码在旧运行的 goto 和最新运行的采木期间均出现，`PartialReadError` 与崩溃的因果关系未证实。2026-10-28 09:18–09:23（Asia/Shanghai）还记录了 PowerShell 和多个 Git 进程的 `0xc0000005`；PowerShell/Git 的独立 dump 可读，但不包含此次 Node 的崩溃栈。需要同时排查宿主稳定性，并在有恢复证据后的隔离验证中捕获 owned Node 的原生 dump；`runtime_blocked=true` 保持。详见 [Bridge 访问违规调查](evidence/BRIDGE_ACCESS_VIOLATION_20261028.md)。

## 旧调用终态回执兼容

Luna 6 max 修复了上一轮观察校验带来的旧调用回归：空 `session_id` 和 `revision=None` 不再被误认作有效协议元数据；生产 `RunManager` 仍要求新鲜协议观察。S3 合成合同经复核保持不变：`craft.count` 是期望产出数量，Bridge 自行换算配方次数。root 独立运行目标监督器、运行管理器、S3/S4/S5 相关回归，`111 passed in 14.03s`；没有启动 Minecraft。旧任务缺失 `goal_state` 的兼容路径仍无法区分旧任务与 schema 2 状态丢失，本轮未改其契约。详见 [旧调用终态回执兼容](evidence/LEGACY_TERMINAL_RECONCILIATION_20261028.md)。

## 目标恢复对账修复

Luna 6 max 修复了已知终态回执可能使用旧观察或错误 session 对账的问题。监督器现在等待足够新的 ready/alive/idle 观察后，才处理真实 pending 动作的终态回执；等待期间保留原动作、deadline 和预算。无终态 observation 的同 session 回执等待后续 revision，断线后的新 session 可以继续恢复。Python 定向及相关回归由 root 独立运行，`108 passed in 13.05s`；这是代码与自动化证据，没有运行 Minecraft。Bridge native exit 的根因仍未解决，`runtime_blocked=true` 保持。详见 [终态回执与新鲜观察](evidence/TERMINAL_RECEIPT_RECONCILIATION_20261028.md)。

## 最新 Paper S3 实测

依用户最新指令，已核实并清理旧 user-server-test 的五个进程，统一活动 marker 的来源指针与 launch identity；用户自己的服务器进程未触碰。采用新的 Temurin 21.0.12.1+1 和 Node 24.22.1，在 R29 的隔离副本启动 Paper，Voxkin 登录并执行 S3。goto 成功后 Bridge 在采木动作中以 `0xC0000005` 退出；S3 未完成，S4–S6 未运行。Paper 正常保存并以 0 退出；此结果不证明 native crash 根因已修复，`runtime_blocked=true` 保持。

后续只读复核未在退出附近的 Windows Application/WHEA 日志、Bridge stderr 或 Node fatal report 目录找到调用栈；当前 Bridge JS/JSON 文件树 hash 与本次实机记录一致。Luna 6 max 复核确认成功 goto 保存在 SQLite events 中，task 7 缺少 `action_history` 字段本身没有证明回执丢失。细节与时间窗口见 [Paper S3 实测记录](evidence/PAPER_S3_20261028.md)。

本次进程日志的启动到退出观察间隔约 105.596 秒；结果中 `uptime_s=66.962` 使用较晚的监督器计时基线，不能当作完整存活时间。该修正不确定 native exit 的根因。

最新有效续跑来源为 `work/mc/refactor_validation_20261027_user_paper_02`，对应 manifest 为 `work/refactor_validation_20261027/user_paper_20261028_02/saved_world_manifest.json`；世界 tree SHA-256 `100fffa90907bfd2e77644ade7d80e51d118a7056be63759a70e5647ff65f5f8`，数据库 SHA-256 `9b53c33b23458bb64a01d9c957387d97e124a3a3a05445a34d44786099162d41`。正式 Supervisor 已在该副本将过期 task 6 记为 `budget_elapsed` 并保留其历史，创建 task 7；task 7 在 cleanup API 停止后为 `paused_by_user`，原 deadline `1793134250.617673`、actions=2、transport_recoveries=0 和未确认 `mine_collect` `1e55e347dc3a` 保留。其 goal state 无 `action_history` 字段，SQLite events 保留 5 条事件及成功 goto 回执；恢复前须先用新鲜观察对账 pending。详细实测、清理和限制见 [Paper S3 实测记录](evidence/PAPER_S3_20261028.md)。

## task 7 截止后只读核对（2026-10-28）

2026-10-27 22:46 UTC 的核对确认，`last_valid_source`、当前 goal 的 manifest 指针、source hash manifest 与 STATUS 仍指向 `user_paper_20261028_02`。保存世界 manifest 的 51 个文件逐一匹配，未发现缺失、变化或额外文件；`tasks.db` SHA-256 与 manifest 一致，SQLite `quick_check` 为 `ok`。task 7 原 deadline `2026-10-27 20:50:50 UTC` 已过，但 SQLite 中 goal 仍为 `paused_by_user`、task row 仍为 `cancelled`；actions=2、attempts={}、transport_recoveries=0，pending `mine_collect` `1e55e347dc3a` 仍为 disconnected 且未确认。没有新鲜观察，因此未对账、恢复、重派或重置预算，也没有创建新 task。

当前 marker 的上次 launch identity 仍为 `user_paper_20261028_02`；owner inactive，lease 截止时间 `2026-10-27T00:39:45Z` 已过，`cleanup_pending=false`、`runtime_active=false`、目标端口无监听。`runtime_blocked=true` 未变，未发现新的宿主恢复证据；本次没有启动进程。详情见 [task 7 截止后核对](evidence/S3_TASK7_DEADLINE_AUDIT_20261028.md)。

2026-10-28 04:46 UTC 再次交叉核对 marker、task 7 manifest、世界文件与 SQLite：51 个世界文件与 manifest 的大小/SHA-256 匹配，`tasks.db` SHA-256 匹配且 `quick_check=ok`。当前 goal 仍为 `paused_by_user`、task row 为 `cancelled`；原 deadline 已过约 7 小时 56 分，未确认的 `mine_collect` `1e55e347dc3a` 仍需 fresh observation 对账。没有执行 resume、action status、dispatch、预算终止转换或新 task 创建。owner inactive、lease 已过期、`cleanup_pending=false`、`runtime_active=false`、`runtime_blocked=true`；目标端口无监听，没有新的环境恢复证据。进程快照中的 Codex/REA Node 及归属不明的 Session 0 `pythonw.exe` 未触碰。核对明细见 [task 7 截止后核对](evidence/S3_TASK7_DEADLINE_AUDIT_20261028.md)。

2026-10-28 10:51 UTC 再核对 marker、保存来源与进程状态：`last_valid_source` 及四个来源 manifest 指针均一致，仍指向 `user_paper_20261028_02`；51 个世界文件逐一匹配 manifest，无缺失、变化或额外文件，数据库 SHA-256 一致且 SQLite `quick_check=ok`。task 7 仍是 goal `paused_by_user` / task row `cancelled`，deadline `1793134250.617673` 已过；actions=2、attempts={}、transport_recoveries=0。未确认的 `mine_collect` `1e55e347dc3a` 仍是 disconnected，存档中只有 dispatch baseline revision 21，没有动作后的新鲜观察；未做状态查询、对账、resume、预算终止或新 task。owner 标记 inactive、lease 为空、cleanup 完成、`runtime_active=false`、`runtime_blocked=true`；上次 launch identity 仍为 `user_paper_20261028_02`，没有启动新运行。核查的游戏/Bridge/Studio/模型目标端口无监听；未发现项目运行进程，系统 `wslservice.exe` 命令行不可读且未触碰。marker 没有新的环境恢复证据。代码审查确认低氧安全中断到换矿区的恢复实现已在当前工作树，近期运行仍被 Mineflayer JS 异常及 V8 native 退出阻断；没有可据此归因的新代码缺陷或复测依据。本轮只更新状态与审计证据，未改代码、存档、marker 或预算，也未运行测试。详见 [task 7 截止后核对](evidence/S3_TASK7_DEADLINE_AUDIT_20261028.md)。

以下旧运行段落记录当时的结果；最新来源与 owner 状态以上文及活动 marker 为准。

用户本机 S0–S4 测试已停在 S0：task 1 夜间多次受敌后因 `preemption_budget` 阻断；task 2 白天重试时，在已加载区域内 64 格搜索不到橡木，3 次方法尝试后以 `budget_method_attempts` 阻断。两次记录和预算均保留；S1–S4 未运行。该次测试的 Bridge、Core 和测试模型已于 10 月 28 日依用户指示清理，详见[用户服务器测试记录](evidence/USER_SERVER_S0_S4_20261027.md)。这不是 clean vanilla G1 证据，也不代表此前 native crash 已解决。

用户本机世界连接测试：用户已启动 Java 1.21.1 世界，Bridge 使用离线身份 `Voxkin` 连入 `127.0.0.1:25565`；隔离的临时 Core 已握手并收到 ready、alive 状态，血量和饥饿为 20。连接测试时通过本地规则快路发送一次只读 `observe`，收到 `action_finished` 成功回执；其后 S0 采集尝试的结果见上文。本轮 Core 为静音 TTS 且未配置 LLM；新启动的本地测试模型尚未接入。日志出现 `ArmorTrimMaterial` 的 `PartialReadError`，连接仍保持 ready。测试进程及用户自有服务器身份记录在活动 marker；连接与观察回执分别记录在 `work/user_server_connection_20261027_191116/connection_result.json` 和 `observe_result.json`。此次短时连接不证明既有 native 崩溃根因已解决，`runtime_blocked` 保持为 true。

Windows 只读续查：R25 有一条已更正 WHEA 错误被记录在 Bridge `0xC0000005` 退出前约 1.299 秒；CPER 含处理器缓存错误信息，但不能据时间接近断定因果。系统范围另有多个 Python 版本的访问违规记录，R31 JVM 崩溃也不能只凭 C2 堆栈归因。后续同时核查主机稳定性和独立 Windows JDK 21 补丁版本，等待新的环境恢复证据后才做有界实机验证；详细时间线、原始事件及证据边界见 [Windows 原生崩溃分析](evidence/WINDOWS_NATIVE_ANALYSIS_20261027.md)。

## R31 Windows 本轮结果（2026-10-27）

本轮按 Windows 原生路径运行一次 R31，选用官方独立 Node.js v24.22.1 LTS、正常模式。Bridge 实际依赖加载、观察回归、Bridge 215 项、Python 全量 462 项与 wrapper 过期任务回归均通过；这些自动化与真实依赖 smoke 不能证明实机稳定。Paper 1.21.1 已启动，JVM 启动约 37.6 秒后，Temurin Java 21.0.6 的 HotSpot C2 编译线程在编译 `AbstractMinecart::getPos` 时发生 `EXCEPTION_ACCESS_VIOLATION (0xc0000005)`；Voxkin 于 18:03:59 登录，崩溃记录时间为 18:04:15，约 16 秒后。R31 S3 未完成（0/8 步），S4–S6 未运行。Node 的 `--report-on-fatalerror` 已启用，但本轮未生成 Node fatal report；不能据这段短时运行判定 Node 根因已解决。该 JVM AV 与 R29 Node 的 `0xC0000005` / breakpoint exception `0x80000003` 是不同进程事件，根因仍未知。

正式 Supervisor 已在 R31 诊断副本将过期 task 6 记为 `budget_elapsed` 并只创建一次 task 7；task 7 在停止时为 `paused_by_user`，pending goto `8267d3163a5a` 保留为 disconnected / `replan` / receipt 未确认。task 7 只存在于 R31 副本，未作为恢复来源。R29 source 未变：51 个世界文件 tree SHA-256 `2856ef8264845e096da12544298c551dec79ace4d4bc922729dbb64add622f6a`，`tasks.db` SHA-256 `ad6e50767976b8872571a23b9554eb884cdbef7e708bf78264900b8e55932c2d`，均与 manifest 和独立重算一致。R31 没有正常保存证据，不能晋升；该次运行之后的有效来源见文首。

R31 已有界清理：wrapper、Studio、Bridge、Paper 和 launcher PID 均退出，端口 26768/26778/8868 空闲，`runtime_active=false`、`cleanup_pending=false`、owner lease 已释放。整体 `runtime_blocked=true`、根因未解决；不重复本轮运行条件。完整记录见 `work/refactor_validation_20261027/r31_windows_native_postmortem.json`，JVM 错误与回放日志见 R31 target 的 `hs_err_pid22592.log`、`replay_pid22592.log`。

自动化调度：现有 `3-voxkin` 已通过 app API 更新 prompt 并从磁盘读回确认。任务仍为 ACTIVE、每 3 小时、本地 Voxkin project、`gpt-6-luna`/max；名称及调度字段保留，未改通知偏好。新 prompt 动态以 `active_progress.last_valid_source`、`current_goal`、source manifest 和 STATUS 为恢复准据，禁止回退 R25/重建旧 task 5，并保留 owner/lease、cleanup_pending、runtime_blocked 守则。用户重启 Windows（09:27:33，Asia/Shanghai）后，同 archive 的 WSL 只读 tar 流预检恢复；Windows Node 实机 native 退出仍复现，不能称为宿主根因已解决。

R30/R31 阶段的续跑来源为正常保存并独立重算 hash 的 R29 world/DB。task 5 已按原 deadline 记为 budget_elapsed，13 次动作与 11 条历史保留；R29 新 task 6 曾进入 S3，但 Windows Bridge 三次 0xC0000005 和一次 0x80000003 用尽本轮 3 次重启，S3 未完成。task 6 的 deadline `1793081854.4290042`、actions=4、history=3、transport_recoveries=3 和未确认 goto `9d18f0f32312` 保留；该 pending goto 的状态为 `disconnected`，`effect_class` 为 `replan`。R30 validate-only 于 02:39:08Z 通过；bundle 校验 6641 个成员、archive 含 6642 个条目，manifest SHA-256 为 `e68bad31dd21f16dd5ce613e2ca0ae7b5a7f7d0552e173622ee1660a55d47ccf`，archive SHA-256 为 `ff68a461dcf223fa54e9329bf2bb10466cee7356bc8bea16f30018e991e25921`，Linux Node 24 SHA-256 前缀/后缀为 `bc17c508…a5e12`。route discovery 的 20 秒 monotonic deadline、最多 3 次动态 ready probe 与 fail-closed 实现通过 25 tests + 2 subtests（0.86 秒，exit 0）。R30retry 使用唯一 `launch_attempt_id`，解决首个尝试记录归档冲突且保留旧日志；wrapper PID 16324 的 route probe 分别等待 12 秒与剩余约 7.75 秒，两次 stdout/stderr 均空，到达总 deadline 后未进行第 3 次，返回 `wsl_default_route_discovery_failed`、exit 1。未复制 target、未启动 Studio/Paper/Bridge、未调用 Studio API 或 resume task 6；没有 `bridge_tests_started/passed`，Linux 215 项未运行，S3 无新增进度。最终 cleanup 已确认：三个 WSL distro 为 Stopped，owned wrapper PID 4544/16324 均不存在，端口 26766/26776/8866/8867/26767 全空，R30 target/retry result 未生成，无 Studio/Paper/Bridge/测试/API/task 6 resume。marker 状态为 `runtime_blocked=true`、`runtime_active=false`、`cleanup_pending=false`、`processes=[]`、`owner_active=false`、lease 已释放。最终证据为 `work/refactor_validation_20261027/r30_route_retry1_runtime_failure_evidence.json`。整体 runtime 仍 blocked，不能声称重启后根因已修复。当时 R29 为最新有效来源，task 6 原 deadline、actions/history、pending 均保留；最新来源见文首。

R30retry 之后的 route 启动竞态复核仅覆盖隔离运行器：当前 `work/refactor_validation_20261026/run_s0_s1.py` 在动态路由查询前请求有界 `/usr/bin/true` 预热，适配器将预热与 route probe 计入同一个 20 秒 monotonic deadline。新增定向回归验证预热先于动态 route 查询，26 passed、2 subtests passed、0.87 秒、exit 0。没有启动 WSL、Linux Bridge、Paper 或 Studio，也没有 resume task 6；这只证明模拟调用顺序，不能证明 WSL 冷启动已恢复，`runtime_blocked=true` 维持。记录见 `work/refactor_validation_20261027/r30_route_warmup_root_review_evidence.json`。

最新 R30 retry4 bootstrap-only 证据仍未恢复实机环境：固定 Ubuntu-22.04 路径在 `inspect_members` 阶段超时，默认 Ubuntu 路径以 139 退出；Linux Bridge 测试、Paper、Studio、Minecraft 与 task 6 resume 均未启动。`runtime_blocked=true` 继续生效，不重复启动同类环境。

本轮修正 S3 的空桶验收：`inventory_count(..., "bucket")` 现在只计数精确的 `bucket` 物品，水桶与岩浆桶不再满足 M5/S3 的空桶要求；S3 资源策略共用此计数语义。定向回归 `tests/test_goal_conditions.py` 为 12 passed（0.05 秒，exit 0）。这是代码与自动化覆盖证据，不是 Minecraft 实机通过或 runtime 恢复；说明见[验收证据](evidence/S3_EMPTY_BUCKET_ACCEPTANCE_20261027.md)。

## 已完成

| 区域 | 内容 | 验证方式 |
| --- | --- | --- |
| 仓库审计 | MiddleAPI、Minecraft Mod、GPT-SoVITS 运行包、MindCraft 上游调用链 | 源码阅读与行号引用，见 `docs/REPO_AUDIT.md`、`docs/research/MINDCRAFT_AUDIT.md` |
| 语音管线 | 流式 LLM、增量分句、流式 TTS、播放队列、打断、时间线 | 43 个自动化测试通过；5 轮真实 TTS 基准 |
| TTS 接入 | GPT-SoVITS `api_v2.py` 的 `streaming_mode`，复用 `xiaote` 音色 | 本机真实合成并播放 |
| Qwen3-TTS-GGUF 探针 | 官方原始 1.7B Base 权重已在独立 Python 3.14 环境导出并生成 PCM/WAV；GGUF 走 Vulkan，ONNX decoder 用 CPUExecutionProvider | warmset 三条样本文本中位 RTF 0.677/0.730/0.737；未接入正式适配器，Python 版本、DirectML 与取消语义仍需处理。见 [本机评估](research/QWEN3_TTS_GGUF_20261026.md) |
| 识别 | faster-whisper small，中文识别；模板幻觉、重复循环与低置信片段过滤 | 本机实测；17 个过滤测试；5 秒静音返回空文本 |
| 流式 STT 候选 | `funasr/paraformer-zh-streaming` 固定 revision 完成 CPU/GPU 逐块回放；三条 FLEURS 真人录音各重复 3 次 | RTX 4060 Laptop 与 4 线程 CPU 实测；非麦克风现场录音，不是生产适配器验收；数据见 [研究报告](research/PARAFORMER_STREAMING_20261026.md) |
| 端点检测 | 能量 VAD，合成音频测试 | 5 个测试用例 |
| 桥接 | WebSocket 协议、动作派发、mineflayer 客户端 | 真实 WebSocket 集成测试；Paper 1.21.1 上完成聊天到动作的端到端验证 |
| 自主目标运行 | `goals.py::GOALS` 是唯一验收来源；`goal_methods.py` 提供无外部 I/O 的阶段策略、资源选择与验收辅助，部分 helper 会更新传入的 `goal_state` 内存字典；`GoalSupervisor` 串行调用并独占派发、恢复对账、SQLite 持久化和预算。S2/S3/S4 与部分 S6 采用有界的观察驱动方法，不是通用 LLM 规划 | 生产代码已集成 S4、部分 S6 要塞下探、有限战斗和 Nether portal/arrival/patrol 路径；S4–S6 仍无 Minecraft 实机通过。schema v2 `goal_states` 保存目标、pending action、预算、观察和恢复状态 |
| 死亡/断桥恢复 | Bridge `ExecutionController` 管理实际动作队列、有限 action ledger 与本地安全抢占；Core 在新鲜 ready/alive/idle 观察后按 action ID 对账。完成目标和任务终态原子提交；用户显式停止持久化为 `paused_by_user`，不会被重连/死亡自动续跑 | 自动化回归及本轮 Paper 恢复演练；r09 验证了旧工具丢失后按新观察重做工具，不代表恢复死亡掉落物或完成 S2。实机证据见新记录 |
| 生存技能 | 庇护所搭建验收地板/墙顶结构并响应打断；离开庇护所确认已走到墙外；`sleep_safe` 等待 Mineflayer 入睡后再等醒来并核验时间推进，支持取消唤醒 | Node 自动化覆盖模拟世界；R20 从保存副本的 S2 目标在夜间通过一次睡眠到天亮，不能据此推及多夜生存或其他技能 |
| S0/S1 实机证据 | 既有 Normal 难度 S0 10/10、白天 S0→S1 3/3 证据仍有效；r18b 阶段内无新增注入又完成 S0/S1 各 5/5，用时 42.5/76.7 秒。其源 world 已有预置布局，不是 clean vanilla G1 | Paper 实机与目标数据库/事件记录；历史记录及本轮环境、原始 JSON 路径见 `docs/evidence/GOAL_REFACTOR_20261026.md` |
| S2–S6 实机进度 | R20 在保存副本验证一次自然睡眠到白天；本次 Paper S3 中 goto 成功后 Bridge native exit，S3 未完成，S4–S6 未运行。最新正常保存的来源是 `refactor_validation_20261027_user_paper_02`，task 7 原预算与未确认采木动作保留。继承世界含既有布局，不作 clean vanilla/G1。 | [Paper S3 实测记录](evidence/PAPER_S3_20261028.md)；自动化回归与实机结果分开记录 |
| 技能清单与阶段方法 | 清单有 64 项技能（21 个桥接内建 + 43 个模块技能），Core 暴露 63 个工具；模块技能可嵌套调用已注册技能。标准目标由 GoalSupervisor 管理；`goal_methods.py` 提供无外部 I/O 的阶段方法、资源选择与验收辅助，部分 helper 会更新输入的内存 `goal_state` | manifest/自动化测试覆盖代码和模拟行为；实机证据仅覆盖各记录明确执行的操作，不能由清单推及未记录技能。技能级证据边界见 `docs/SKILLS.md` |
| 一键本地实机启动 | `scripts/eval_stack.ps1` 可启动 GPT-SoVITS（本地包存在时）、Studio 与独立模式 Bridge；不会启动或重置 Paper 世界 | 先手动启动 Minecraft 1.21.1 专用测试服务器，再运行 `scripts/eval_stack.ps1 -Action start -McPort 25566`；指引见 README |
| 动作与目标状态 | Bridge 回报 accepted/running/queued/cancelling/preempting/succeeded/partial/failed/cancelled/preempted/disconnected/blocked/dead/unknown 等动作状态；目标另有 active/waiting/recovering/unknown/preempted/blocked/paused_by_user/done 等持久状态 | 动作以 `action_id` 关联；Studio 显示目标状态、等待/阻塞/恢复原因、在途动作和预算；代码与 UI 不把固定步骤游标当目标完成度 |
| Studio | 状态、目标运行面板、试听、事件流、延迟表、配置、受管服务、日志、麦克风启停 | HTTP 接口路径实测；服务管理用真实子进程测试；Studio 目标展示随 `/api/run/status` 读取持久 goal snapshot |
| 基准 | `voxkin bench` 输出 JSON 与分位数；真实模型与 Minecraft 端到端计时 | `docs/BENCHMARK_RESULTS.md` |
| 真实模型 | OpenCode Go（`deepseek-v4.1-flash`）流式对话、工具调用与延迟测量 | 3 轮基准首次可听 3134.9–4434.9 ms；游戏内触发 `collect_blocks` 成功 |
| 长期记忆 | SQLite 保存对话，空闲时压缩摘要，按关键词检索并限制上下文预算 | 4 轮真实对话后 16 条消息、2 条摘要；摘要延迟 10 秒后生成，不干扰对话 |
| 繁简转换 | 识别结果统一转简体 | 3 个转换测试 |
| 客户端 Mod | Fabric 1.21.1，WebSocket 接收 PCM，Minecraft 流式声源与实体定位 | 构建成功（`voxkin-audio-0.1.0.jar`）；Mixin 目标字段与 1.21.1 映射一致；未在真实客户端验证 |
| 音频推送 | `/ws/audio` 向客户端广播 PCM | 真实 TTS 推送 412160 字节 / 6.44 秒，共 4 个分块 |
| 麦克风对话 | 采集、VAD 校准、识别、语音回复、回声冷却；Studio 内启停 | 真实麦克风：识别 1577.3 ms，播放回复；外放回声不再触发新回合 |
| 语音快路 | 本地规则意图产出 `IntentPlan`（停止、跟随、过来、攻击、进食、睡觉、观察、背包、采集），命中即提交动作并播确认语，不等云端模型；同一回合里模型重复的相同调用会被去重 | `tests/test_intent.py` 与 `tests/test_pipeline.py`；能力询问不触发动作 |
| 语音缓存 | `src/voxkin/voice/phrase_catalog.py` 47 条确认语目录（覆盖 54 个可缓存条目），`src/voxkin/voice/cache.py` 预合成缓存（WAV + sidecar，哈希、音色、引擎或参考音频不匹配一律 miss 并记账） | `tests/test_phrase_catalog.py`、`tests/test_voice_cache.py`；`scripts/build_voice_cache.py` 生成，`work/voice_cache/` 不入库 |
| 时间线 | 保留原有 `t0`–`t8`，补 `t_cmd_final`、`t_intent_done`、`t_ack_ready`、`t_audio_start`、`t_action_submit`、`t_action_start`；缺观测点显式失败 | `tests/test_events.py`；`scripts/latency_scenarios.py` 跑六个合成场景 |

## 测试结果

本次 Windows 重启后，root 用同一 Python 3.10 命令独立完成全套 451 passed、54 warnings、67.37 秒、exit 0；bundled Windows Node 24.19.0 `--jitless --test --test-reporter=spec` 完成 Bridge 全套 215 passed、0 failed、726.2842 ms、exit 0。Bridge 为模拟 bot 回归。451 项 Python 是后续 `run_stage` 测试增加前的全量快照；451/215 快照也早于最后的 `state.ready` 启动等待修正，不代表修正后的代码全量通过。之后 `state.ready` 定向回归 27 passed / 0.25 秒、wrapper transition 10 项通过 / 0.002 秒；route discovery 新增 25 tests + 2 subtests，0.86 秒、exit 0。R30 Linux Bridge 215 项未执行。历史日志见 `work/refactor_validation_20261027/continue_20261027_unit_validation.json`；重启前 26 点不退出的 runner 经核对后清理、不计通过，重启后同组 26 项 exit 0。自动化通过不等于实机通关或 runtime 根因已修复。

此前 root 独立完整 Python 回归为 `$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'; .\.venv\Scripts\python.exe -B -m pytest -p pytest_asyncio.plugin --assert=plain --noconftest tests -q --tb=short` → 444 passed、54 warnings、66.42 秒、exit 0；运行对应的当前生产代码已含 S3 木材路线、S4 策略、部分 S6 搜索/下探、战斗和 Nether 路径以及 transport/method 预算调整。仓库没有 `conftest.py`，本次 `--noconftest` 跳过未使用的 conftest discovery；这不能证明或声称解决了 Python 3.10 collection access violation 根因。此前 425 passed/54 warnings/62.51 秒、414 passed/54 warnings/61.23 秒全量及 66 passed/4.76 秒定向回归是较早快照。root 对 S4 candidate 使用相同 Python 3.10、`-B --assert=plain` 参数时，collection 在 `pathlib.casefold_parts` / `_pytest.config._is_in_confcutdir` 触发 access violation，exit 1，断言未执行；`--noconftest` 的后续通过不能作为该 crash 已修复的证据。候选 agent 报告的 42 项通过未由 root 独立复核；此前“S4/S5/S6 与 combat 候选尚未集成”的判断已过期，当前集成范围见架构说明；S4–S6 仍无实机阶段通过。54 warnings 来自 `dev_llm_server.py` 的 aiohttp `NotAppKeyWarning`。

此前 Windows Node 24.19.0 `--jitless` 全套模拟 bot 回归为 210 passed、0.67 秒、exit 0；其后 Windows S5 生命周期快照为 215 passed。更早的 Linux 便携 Node 24.19.0 全套为 175/175、0 failed、1430.905765 ms、exit 0。下载包 `work/runtimes/node-v24.19.0/node-v24.19.0-linux-x64.tar.xz`（31,633,904 bytes）的 SHA-256 `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647` 与同目录官方 `SHASUMS256.txt` 一致；可执行文件位于 `work/runtimes/node-v24.19.0/node-v24.19.0-linux-x64/bin/node`。该早期 Linux 结果复现命令（WSL Ubuntu 22.04，root 直接 exec）：

```powershell
wsl.exe -d Ubuntu-22.04 --user root --cd /mnt/d/AI-Workspace/Voxkin/bridge --exec /usr/bin/timeout 30s /mnt/d/AI-Workspace/Voxkin/work/runtimes/node-v24.19.0/node-v24.19.0-linux-x64/bin/node --test --test-concurrency=4 --test-reporter=spec
```

结果日志：`work/runtimes/node-v24.19.0/bridge-node-v24.19.0-linux-tests-rootuser.log`。此前默认 WSL 用户/测试通道的 systemd user-session 警告和 exec timeout 是未完成尝试。R30retry 的 bounded route probe 自动化测试通过，但 wrapper 两次 WSL route 探测用尽 20 秒总 deadline 后 fail-closed；Linux 215 项未执行。最终 QA cleanup 已确认三 distro stopped、owned wrappers 不存在、目标端口空闲、`cleanup_pending=false`、owner inactive 且 lease 已释放；整体 runtime 仍 blocked，不能把 Windows 重启或只读诊断称作根因已修复。R24/R29 的 Windows Node 24.19.0 `--jitless` 实机运行中均曾有进程在清理前 `0xC0000005`/`0x80000003` 退出；自动化回归不构成长时稳定性结论。CI 的 Windows Node 20 job 安装 Bridge 依赖后运行全部单元测试并检查入口语法。

这些 pytest 与 Bridge 测试是本地自动化测试；Bridge 使用模拟 bot。即便 smoke test 或语法检查通过，也不代表 Minecraft 实机执行成功。本轮实机结论单独记录在 `docs/evidence/GOAL_REFACTOR_20261026.md`，只覆盖明确列出的场景。

R29 `bridge.err.log` 只发现一份 Node 24.19.0 `--jitless` V8 `abort: Invalid bytecode` 栈，调用路径为 `findNearbyBeds → bot.findBlocks(maxDistance=64) → createObservation/sendState`；前三个 `0xC0000005` 没有对应的 Node WER 记录或 dump。同一日志中的 `ArmorTrimMaterial` `PartialReadError` 目前无证据表明与 V8 abort 有因果关系。Bridge 现仅在已知 shelter 范围内用有限 `blockAt` 检查收集 `nearby_beds`，不再在 `createObservation` 中作全局床搜索；S2 仍消费 `nearby_beds`，旧 Bridge 缺字段时保留 `shelter.bed_inside` 兼容。该修改通过观察定向回归 4/4、Windows Bridge mock 全套 215/215，以及 Python 全量 462/462；R31 实机运行被独立的 Java HotSpot C2 access violation 阻断。以上没有归因或解决 R29 Node native 退出根因，详见上方 R31 实机结果。

新增部分（2026-10-22 晚）落地了 [docs/plans/VOICE_ACTION_LATENCY_PLAN.md](plans/VOICE_ACTION_LATENCY_PLAN.md) 的阶段 0 与阶段 1，以及阶段 2 的最小闭环：缓存命中时确认语不经过 TTS、缓存缺失时走动态合成并受截止时间约束、动作与确认语并行提交。真实扬声器与真实 TTS 下的首音延迟尚未测量，见 [docs/BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) 的未测量项。

## 已知问题

1. 真实模型经 OpenCode Go 接入，接口需要 `x-opencode-session` 头；换用官方 DeepSeek 接口时需要调整配置。
2. 游戏内音频有两条路：文件投递与 WebSocket PCM。WebSocket 路线已接入 Minecraft 流式声源，但未在真实客户端验证；文件投递没有空间音源。
3. 客户端 Mod 只完成编译与协议实现，没有在真实 Minecraft 客户端验证。
4. 麦克风已用真实说话验证；外放音箱时需要 `--no-barge-in`，播放结束后的 1.5 秒内忽略输入。回声靠时间窗规避，没有回声消除，戴耳机才能自然打断。
5. GPT-SoVITS 每句独立请求有 0.4–0.9 秒固定开销；首句过长会推迟出声。Qwen3-TTS-GGUF 的隔离实测与 Python 3.14 / CPU decoder 接入限制见技术评估，尚未进入生产语音链路。
6. Studio 配置修改需要重启服务生效。
7. mineflayer 在 1.21.1 上对部分物品包报 `PartialReadError`，当前不影响动作执行。
8. 记忆压缩依赖模型调用，离线时只保留原始对话，不生成摘要。
9. mineflayer 的 `clickWindow` 在 1.21.1 上点完合成格会等服务端重发结果槽位，凑不齐配方时必然等满 20 秒；桥接已改为自己发 `window_click` 包并推演本地窗口状态，10 次回归均通过。
10. S0 在 Normal 难度下已连续 10 次 5/5、P50 36.4 秒；S1 已在 Node 24 上完成 3/3 轮 S0→S1 白天链式回归（S1 为 95.0、78.9、78.8 秒）。R20 在保存副本上验证一次睡眠到白天，不满足 M3 的三夜生存要求；换种子与夜间怪物场景也尚未回归。
11. r18b 完成白天准备、R20 在保存副本通过一次自然夜间睡眠；R21–R28 的历史阻断与 R27 环境诊断见实机证据。R29 正式 Supervisor 保留 task 5 预算账本并只创建一次 task 6；该任务进入 S3 后因 Windows Bridge native exit 未完成。R29 保存副本是该阶段的 source，task 6 的 deadline、动作/历史和 pending goto 保留；最新 source 见文首。R30retry route gate 的 25 tests + 2 subtests 通过，但实机 launch 在 20 秒总 deadline 后 fail-closed，未复制 target、运行 Linux Bridge/Minecraft 或 resume task 6。Linux 215 未执行；最终 cleanup 已确认三 distro stopped、owned wrappers 不在、端口空闲、cleanup_pending=false、owner inactive/lease 已释放。S3 尚未通过、S4–S6 未验收，多夜与干净世界 G1 标准不变。
12. 断桥/未知动作仍先保留 pending 并对账，传输恢复与物理方法失败分开计数。Windows Node 22/24 均曾 native 退出；R29 重启后有三次 0xC0000005 和一次 0x80000003，单元测试通过不构成长时稳定结论。重启后的同归档 tar 只读预检完整通过，但这不证明 WSL runtime 根因已修复。R30 冷启动首次 route 调用失败；发行版启动后同命令成功；bounded retry 最终在 20 秒总 deadline 后 fail-closed。整体 runtime 仍 blocked，底层原因未归因；最终 cleanup 已确认、owner inactive 且 lease 已释放。不得重复同条件或扩展临时 harness，也不能据此诊断硬件。
13. `shear_sheep` 有模拟 bot 测试；r18b S2 制作剪刀后，首次尝试被 `critical_hunger` 抢占并消耗本轮采集的苹果，之后按新鲜观察恢复，加载的羊中找到白羊并剪取 1 只，white wool 总数达到 3。该运行只验证到白天准备目标，未覆盖夜间或多夜生存。铁矿采集依赖 `mine_collect` 找到可达矿石；更多早期剪羊尝试见实机证据记录。
14. `collect_flint` 仍只有模拟 bot 背包产出验证，S5 实机路线未验证。S6 已集成部分 eye-overhead 证据驱动的有界 `safe_descend`/frame-scan 路径，Core 与 Bridge 的代码/自动化覆盖不等于要塞或末地实机通过；仍缺真实末影龙事件与返回主世界验收。投眼有界，`throw_eye` 找到估算但未发现框架时会返回 `partial`，不能据此算作阶段完成。
15. 本轮补入 `fill_water_bucket` 与 `collect_obsidian`：只识别静止水/岩浆源，先直接挖已生成黑曜石，再由上方放水将单个岩浆源浇铸，核实方块和桶库存后收回水源并采集；限制主世界、低血停止、附近敌对生物停止。模拟测试通过后仍需在隔离服务器验证水桶交互、不同地形与流体更新行为。
16. 修正 S3 铁料核算：原版铁镐 3、铁剑 2、盾牌 1、桶 3，共 9 铁锭；盾牌配方此前误写为 6，现已修正。S3 结束条件将 `bucket`、`water_bucket`、`lava_bucket` 视为同一桶资源，避免装水后阶段状态倒退。
17. Bridge 为模块技能补充了 `ctx.runSkill(skillId, args)`：只调用启动时注册的处理器，嵌套共享当前动作生命周期，有限制循环/深度并在进入子技能前检查打断。Nether portal 进入、到达坐标记录与有界巡逻已集成；跨 Bridge 重启后，Core 可消费已确认 portal transition 的持久化 hint；arrival checkpoint 只作寻路线索，实际穿门必须 fresh blockAt 确认，尚无该恢复链路的实机证据。`raid_fortress`→`fight_blaze` 有模拟组合测试，Nether 到堡垒/回到主世界仍无 S5 实机验收。
18. `fight_dragon` 清水晶现在优先复用注册的 `break_crystal`，并在调用后重新观察剩余水晶；独立运行的末地战斗若有水晶但没有弓箭会安全失败，不再靠近后尝试近战。新增三个模拟回归测试，Bridge 全套 77 项通过；末地实机行为尚未验证。
19. `break_crystal` 在射击、等待爆炸、撤离和恢复血量阶段检查同一动作的取消信号；取消发生在拉弓/弩时仍通过 `finally` 释放使用状态。新增三个模拟中断测试，Bridge 全套 80 项通过；取消与 Minecraft 服务端/网络交互的时序仍需实机验证。
20. S6 的 `prepare_bow_arrows` 会按现有木材选择树种、缺料时嵌套采集，最后按背包验证弓与 64 支箭；猎材需要线、羽毛和燧石。部分强要塞搜索路径已集成：只有观察到 eye-overhead 证据才选择有界 `safe_descend` 与框架扫描；方向/位置证据不足时阻塞，不自动重复消耗末影之眼。该路径和材料准备尚无实机验证，S6 完整路线尚未通过。
21. `fight_dragon` 要求结构化 `ender_dragon_killed` 结果事件；Bridge 在确认龙血归零或龙不在且返回门出现时上报事件及证据，Core 验收后写入任务 SQLite 历史。S6 最终验收还要求返回主世界；跨重启可消费已持久化龙事件，但目前没有末地实机证据。有限战斗搜索检查健康与取消状态，仍不能把自动化回归等同于击杀实测。

## 阻塞与前置条件

2026-10-28 玩家世界低饥饿调查：Java 版[饥饿机制](https://minecraft.wiki/w/Food_mechanics)中，饥饿值降至 0 才可能产生饥饿伤害，不能冲刺的阈值为 6。实机日志显示饥饿值为 8 且背包没有食物时，Bridge 每 8 秒触发一次无法执行进食的 `critical_hunger`，导致 S0 动作重复被抢占并耗尽抢占预算。现已让本地进食抢占要求有可用食物，并让 S0/S1 在白天安全时优先搜索食物；自动化测试覆盖，正在运行的 Bridge/Core 尚未加载修改，实机效果待验证。狩猎搜索仍有范围和重试限制，不能宣称所有缺食场景均已解决。

同次 S2 搜羊日志显示有限搜索绕回原区域，三次未找到羊后耗尽方法预算。根据 [Minecraft Wiki 的草方块生成说明](https://minecraft.wiki/w/Grass_block)，Java 版多数动物随地形生成，等待原地重新生成并非可靠的搜索策略；战斗材料与食物狩猎的局部路点已改为朝固定方向逐段推进，安全检查及有限动作预算保留。自动化测试通过，实机复测与 S2 多轮搜索后的换区恢复尚待验证，不能把局部失败等同于世界没有羊。

玩家世界 23:24 的新 Bridge 已加载定向搜索：日志显示向外推进并拾取羊毛；S2 随后完成。又发现低氧自救只验收恢复呼吸，未验收靠岸。依据 Wiki 的[水中上浮](https://minecraft.wiki/w/Water)、[出水跳跃](https://minecraft.wiki/w/Jump)及[树叶破坏](https://minecraft.wiki/w/Breaking)机制，现增加可呼吸后寻找并验收干地、在氧气安全时清理阻挡的树叶，以及水中禁止寻路垫方块；上述新代码仅自动化验证，尚未加载实机。根据 [煤炭燃料](https://minecraft.wiki/w/Coal)每个可熔炼八项，S3 在处理铁矿时优先有界搜索煤炭储备，失败后继续其他燃料；实机待验。23:29 和 23:32 玩家客户端先后在渲染苦力怕和蝙蝠时异常退出，集成服务器随客户端停止；前者 JOML 类型错误，后者 Java stream 状态错误，不得归因于已证实的 Bridge 缺陷。

23:55 玩家客户端 JVM 在渲染线程发生 `0xC0000005`，日志中该次最后明确世界保存为 23:51:55；用户报告世界回档。SQLite 的 task 18 在旧 session 中记录 S4 完成、3 钻石及钻石镐；重连后的 task 20 新 session 观察为 2 钻石且没有钻石镐，坐标也回到更早矿区。已把当前 `level.dat`、`level.dat_old` 与玩家 `.dat_old` 单文件证据复制到 `work/rollback_evidence_20261029_000026`；复制时世界可能在线，因此这不是完整一致的世界备份，也不能直接用作恢复存档。崩溃日志包含登录凭据，分享前必须脱敏。

| 阻塞 | 需要什么 |
| --- | --- |
| 客户端 Mod 端到端 | 可运行的 Minecraft 1.21.1 客户端与 Fabric 环境 |
| 空间音效 | 真实客户端里验证距离衰减与跟随机器人移动 |
| 官方 DeepSeek 接口 | 官方 API Key 与费用授权；当前使用 OpenCode Go 订阅 |
| 自主目标实机验收 | 最新有效来源与 task 7 见文首及活动 marker；S3 未完成，S4–S6 未验收。Bridge `0xC0000005` 再现，runtime 仍 blocked；恢复前需新的环境恢复证据和对未确认动作的新鲜观察。 |

## 下一步三件事

1. 保持已确认的 cleanup/owner 状态；不得在无新环境恢复证据时重复 runtime 条件或扩展 harness。
2. runtime 仍 blocked；无新的环境恢复证据时仅做只读或独立代码审查。将来恢复前须核对最新 manifest、task 7 原 deadline、动作计数与 pending，先以新鲜观察对账；Linux 路径仍须通过对应 gate。
3. 验证多夜生存和恢复，再按原有零干预 G1 标准从干净世界完整通关；最终目标与要求没有降低。
