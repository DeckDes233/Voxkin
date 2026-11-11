# G1 自主通关与 G2 玩家互动

> 最后的milestone是沃心独立通关一次mc，全流程，我只负责旁观。

这句话定义 G1 自主通关的验收标准；下文 S0–S6 与无人干预要求属于 G1。

G2 是玩家互动：理解玩家说什么、要做什么，并在游戏中执行该目标，接受后续修改、打断和取消，反馈真实进展与结果。G2 需要单独验证指令理解、任务执行和交互恢复，不能用 G1 通关结果代替。两条线共用游戏技能与生存恢复能力，但任务来源和验收条件不同。

## 完成定义

从空背包、生存模式、默认难度开始，沃心在没有人干预的情况下完成：

1. 木头 → 工作台 → 木镐；
2. 石头 → 石镐、石剑、熔炉；
3. 食物与过夜庇护所；
4. 9 个铁锭制成铁镐、铁剑、盾和空桶（M5/S3）；
5. 采集钻石并制成钻石镐（M6/S4；附魔台为可选扩展）；
6. 下界门、烈焰棒、末影珍珠；
7. 要塞、末地门、末地水晶；
8. 击败末影龙。

“没有人干预”包括：不补物品、不报坐标、不救场、不手动暂停、不改游戏规则。允许观察、录屏和事后看日志。

## 必须自己处理的情况

- 死亡与重生，包括掉落物回收或放弃；
- 卡住、寻路失败、区块未加载；
- 夜晚、饥饿、低血、岩浆、仙人掌、苦力怕；
- 背包满、工具损坏、床或传送门被破坏；
- 桥接断线、Core 重启、服务器重启、模型限流；
- 长时间运行后的内存、日志与数据库增长。

## 非目标

- 不用创造模式、作弊命令、外部地图工具或人工补给完成正式验收；
- 不追求速通纪录，优先稳定与可恢复；
- 不要求一次不死，但要求死后能自己继续；
- 不把“玩家在旁边看着”当成隐性帮助。

## 阶段入口

- 架构：[docs/plans/AUTONOMOUS_RUN_ARCHITECTURE.md](plans/AUTONOMOUS_RUN_ARCHITECTURE.md)
- 路线图：[docs/plans/INDEPENDENT_RUN_ROADMAP.md](plans/INDEPENDENT_RUN_ROADMAP.md)
- 评测：[docs/plans/EVALUATION.md](plans/EVALUATION.md)

## 当前状态

- 架构现状：S0–S6 使用 `RunManager` 与持久化 `GoalSupervisor`，验收条件集中在 `src/voxkin/agent/goals.py::GOALS`；`goal_methods.py` 提供无外部 I/O 的阶段策略、资源选择与验收辅助，部分 helper 会更新传入的 `goal_state` 内存字典。GoalSupervisor 串行调用并独占调度、派发、恢复对账、SQLite 持久化和预算。S2/S3/S4 与部分 S6 使用有限观察驱动方法；战斗和 Nether 也接入有界策略。它们不是通用 LLM 动态规划，也不能据此声称 Minecraft 实机通关。最近较大离线回归为 Python 488 passed、54 warnings、76.76 秒和 Bridge 233 passed，证据见 [S0–S3 生存流程修复](evidence/S0_S3_PROGRESSION_20261028.md)；测试使用确定性世界与动作替身，不代表 Minecraft 实机通过。Terra 之后的水中脱困定向回归另有 Bridge 23 passed，见[验证记录](evidence/WATER_ESCAPE_20261028.md)。Linux 215 项在 R30 中未运行。最后启动等待定向回归为 27 passed / 0.25 秒，wrapper transition 10 项通过 / 0.002 秒；route discovery 新增 25 tests + 2 subtests、0.86 秒、exit 0。R30retry 实际 route probe 在 20 秒总 deadline 内用尽两次尝试后 fail-closed，未越过 readiness gate、未复制 target 或启动服务。仓库没有 `conftest.py`，`--noconftest` 只跳过未使用的 conftest discovery；此前 Python 3.10 collection 在 `pathlib.casefold_parts` / `_pytest.config._is_in_confcutdir` 触发 access violation，根因未明，该命令不能视为根因修复。此前 root 的 425 项回归和候选 agent 报告的 S4 candidate 42 项均为历史结果；后者未由 root 独立复核。Ruff F821/F823 与 `git diff --check` 已通过；自动化验证不替代 Minecraft 实机验收，也不排除清理前 native exit。
- 阶段内无新增物资/时间/天气/地形注入的目标证据来自分开的运行：r18b 完成 S0/S1/S2 白天准备；R20 从保存副本的新 S2 task 4 在夜间调用 `sleep_safe` 并观察到白天，`night_required=true`、`sleep_confirmed=true`、goal `done/stage_complete=true`。R20 用时 189.8 秒，包含约 182 秒昼夜等待，不是性能基准。R18b 源世界在复制前已有三张彩色床和蜡铜平台，该布局也见于最早留存的 `eval_server`；初次放置命令未找到。R18b/R20 没有地形注入或使用地下布局，睡眠使用自建庇护所床。结果保留为分阶段行为证据，但不算 clean vanilla/G1。两次结果不构成一次连续 S0→S2 过夜链或多夜生存。
- 2026-10-28 的独立 Paper 测试使用 R29 的隔离副本和 Temurin 21.0.12.1+1。S3 的 goto 成功后，Node Bridge 在采木时 `0xC0000005` 退出；Paper 正常保存，最新有效 world/DB 为 `refactor_validation_20261027_user_paper_02`，task 7 的 deadline、计数与未确认采木动作保留。到 2026-10-27 22:46 UTC，原 deadline 已过，但持久 goal 仍是 `paused_by_user`，pending `mine_collect` 未经新鲜观察对账；没有新 task 或预算重置。S3 未完成，S4–S6 未运行；详见 [Paper S3 实测记录](evidence/PAPER_S3_20261028.md) 与 [task 7 截止后核对](evidence/S3_TASK7_DEADLINE_AUDIT_20261028.md)。
- 同日独立 Terra 新世界连跑中，S0/S1/S2 分别用时 63.1/140.3/109.7 秒完成；S2 未要求或确认睡眠。S3 在 360.4 秒上限前角色溺水，重生后未完成，S4 未运行。随后工作树加入共享水中自救路线，Bridge 定向与 shelter 回归 23 项通过；这只是代码覆盖，尚无新实机验证。详细结果与权威来源/task 7 核对见[水中自救修复与验证](evidence/WATER_ESCAPE_20261028.md)。S0–S6、三夜生存与 clean vanilla/G1 均未验收。
- R21–R29 的 S3 历史阻断、R24 时钟诊断与 R26–R27 Linux 启动诊断详见[本轮实机记录](evidence/GOAL_REFACTOR_20261026.md)；R25（raw_iron×3、health=20、food=18、Y=57）是已被 R29 保存结果取代的历史来源。R27 曾在 ext4 tar 流读取中停滞，但 Windows 重启后同归档的只读完整读取通过。R30 validate-only 的 source 与 bundle/manifest/archive hash 校验通过；route discovery 使用 20 秒 monotonic 总 deadline、最多 3 次动态 ready probe 并 fail-closed，新增 25 tests + 2 subtests 于 0.86 秒通过。R30retry 实机 wrapper 两次空输出 route probe 消耗 12 秒及剩余约 7.75 秒，达到总 deadline 后 `wsl_default_route_discovery_failed`、exit 1，未执行第 3 次探测；没有 target copy、服务启动、Studio API、task 6 resume 或 Linux 215 项测试。QA 已确认三 WSL distro stopped、owned wrappers 不在、相关端口空闲、cleanup_pending=false、owner_active=false 且 lease 已释放。整体 runtime 仍 blocked；Windows native exit 与 Linux WSL 启动/route readiness 超时均未证明根因已修复。R29 是该阶段的有效 world/DB 来源，task 6 原 deadline、actions/history、pending goto 已保留；后续最新来源见上一条；S3 未完成，S4–S6 均无 Minecraft 实机阶段通过。死后掉落回收、长时运行与跨阶段故障恢复仍须按最终标准验证。
- **当前阶段合同与需对齐项：** 顶层验收仍是从空背包开始、无人干预地完成全流程并击败末影龙；M5/S3 的正式里程碑要求铁镐、铁剑、盾、空桶和铁锭≥9，不要求全套铁甲；ROADMAP/EVALUATION 另有时限、死亡和多轮成功率门槛。`GOALS[S3]` 检查铁镐、铁剑、盾与精确的空 `bucket`；水桶/岩浆桶不再计为空桶。它仍未单独检查铁锭数量、时限、死亡或重复运行。S3 当前方法按观察到的铁缺口制定采集目标，优先可达铁矿，缺矿时才安全水平探索；R22–R23 均未验证完整 S3。M6/S4 路线要求采 3 颗钻石并成钻石镐，附魔台是 P1 可选项；`GOALS[S4]` 只检查钻石镐，不检查 3 颗钻石、重复成功率或死亡门槛。M7 的 ROADMAP/EVALUATION 写 7 根烈焰棒、16 颗末影珍珠；`GOALS[S5]` 与线性计划要求 12/24 并检查回到主世界。其他阶段合同差异仍需显式对齐，不能在文档中将较低门槛默认为已满足。
- 历史 S0/S1 重复回归和早期 S2 中断记录保留在[历史证据索引](evidence/GOAL_REFACTOR_20261026.md)、[S0 记录](evidence/S0_NORMAL_20261022.md)、[S1 记录](evidence/S1_NORMAL_20261022.md)与[2026-10-24 链式记录](evidence/S0_S6_CHAIN_20261024.md)。

最终验收前，所有阶段都只是中间产物。任何“看起来能玩”的演示，都不能替代一次零干预的完整通关。
