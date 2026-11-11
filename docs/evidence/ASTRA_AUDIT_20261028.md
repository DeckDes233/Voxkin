# 崩溃与资源搜索复核（2026-10-28）

## 结论

当前有两类独立问题：主机上广泛发生的原生进程异常，以及 Voxkin 的搜索、寻路和阶段策略缺口。资源逻辑修复不能当作 Node/JVM 原生崩溃的修复。当前没有 Node 崩溃转储，无法给出其故障指令或确认唯一根因。

## 主机与崩溃证据

本轮重新查询 Windows Application Error（1000），窗口为 2026-10-24 11:13 至 2026-10-28 11:13（Asia/Shanghai）。392 条应用错误中，249 条异常码为 `c0000005`，涉及 21 个不同应用名。其中 MicrosoftEdgeUpdate 125 条、Git 54 条、Python 30 条，另有 PowerShell、系统服务、Windows 安全软件、R 和微信等。相同异常码不证明每次根因相同；如此广泛的异常，加上处理器硬件错误记录，使宿主稳定性成为优先调查项。

筛选结果保存在 `work/audit_20261028/application_errors.json`；WHEA 原始 XML 保存在同目录的 `whea_events.xml`。WHEA 包括 10 月 25 日、27 日的处理器核心 Internal parity error（APIC 16、25），以及先前已解码的 cache error。WHEA 记录的是硬件错误报告，不能由它直接指定坏了哪一个部件或证明与某次 Node 退出有关。[Microsoft WHEA 处理说明](https://learn.microsoft.com/en-us/windows-hardware/drivers/whea/error-processing)

本轮内存快照约有 8.2 GiB 可用物理内存、13.5 GiB 可用虚拟内存；这仅描述取样时刻，不能证明此前崩溃时的内存状态。未执行压力测试、改电压、刷 BIOS、重启或修改系统注册表。当前环境没有找到 CDB/WinDbg 命令或 Windows SDK 的默认 CDB 路径；已有 PowerShell/Git 转储不是缺失的 Node 转储。

三次不同故障必须分开：

| 故障 | 已知证据 | 不能据此得出的结论 |
| --- | --- | --- |
| R31 Paper | JDK 21.0.6 的 C2 CompilerThread 在 jvm.dll 访问违规 | 不能直接确定是 Minecraft 方法、JDK 或硬件导致 |
| 用户本地世界 | 10 月 27 日 19:36 渲染蝙蝠时 Java Stream 已消费异常；内置服务器随后保存退出 | 不能根据堆栈没有 Voxkin 名称就彻底排除间接影响；也不能把它称为 Paper 崩溃 |
| 最新隔离 Paper S3 | Node 24.22.1 在 mine_collect 期间以 0xC0000005 退出；Paper 随后正常保存 | 没有 Node native stack；无法归因到采木、协议解析或某个 JS 函数 |

具体旧运行证据见 [Windows 分析](WINDOWS_NATIVE_ANALYSIS_20261027.md)、[Bridge 访问违规](BRIDGE_ACCESS_VIOLATION_20261028.md)、[Paper S3](PAPER_S3_20261028.md)。

## 本轮确认并修复的搜索问题

1. 上一版探索只在初次候选列表为空时执行。候选走不到、消失、或采完仍不够时直接失败，下一动作还可能重新选择相同候选。现在在同一动作中继续扫描与探索，并排除已尝试坐标；所有批次共享五段移动预算，最多检查 512 个不同候选，不因每批补搜重新获得预算。
2. `collect_blocks` 和 `mine_collect` 是两份采集实现。S0 的旧入口现在复用 `mine_collect`，保留外部 action ID、目标工具名与监督器验收，避免只修一条路径。原木按水平距离及树干高度排序，结果仍以真实背包增量为准。
3. 无安全路点或不可达时尝试另一方向，不重复选择同一落点；`stopped`、`cancelled` 和未知移动结果不能当成普通搜索失败继续执行。采矿靠近目标后重新检查血量。
4. `gotoWithDeadline` 只调用 pathfinder 的软 `stop()`，可能要等以后发生 path reset 才结束 Promise。现在同时清空 goal，超时统一返回 `CollectTimeout`；回归直接使用已安装 mineflayer-pathfinder 的 `goto` 实现，确认监听器释放且后续寻路可执行。

这些修复涉及 `bridge/resource_search.js`、`bridge/skills/gather.js`、`bridge/minecraft_bridge.js`、`bridge/pathfinder_control.js` 和对应测试；没有修改存档、任务预算或验收条件。

## 阶段策略的后续修复与剩余范围

本节原先记录的 S0 固定橡木、S2 强制剪刀铁矿链、S3 一次水平探露限制，已在同日后续修复中处理；详见 [S0–S3 流程与修复](S0_S3_PROGRESSION_20261028.md)。S0/S1 现由实时库存依赖驱动，采木支持八种主世界原木，S2 可直接取得同色羊毛，S3 分段探矿并按实际燃料熔炼。以下限制仍保留：

- 探索受动作时限、路线段数、血量和总任务预算约束，不能宣称覆盖全地图或保证任意地形成功。
- 动物、羊、堡垒和要塞使用专用路线；`find_diamond`、`locate_block` 等感知工具不会隐式移动。“所有任务已接入同一套探索”不成立。
- 水源/岩浆源候选存在但全部不可用时的续搜尚未统一，本轮未扩展到 S4 之后的路线。

## 音频及恢复链路

用户世界日志反复出现 WebSocketHandshakeException 的直接配置原因已确认：测试 Core 的 `test-config.yaml` 配置 `audio.output: wav_dir`，而 Mod 连接 `/ws/audio`；`server.py::audio_socket` 在 sink 不是 WebSocketAudioSink 时返回 HTTP 409。它不能作为蝙蝠渲染或 Node 原生退出的归因。下一次要验证 Mod 音频应使用 websocket 输出；当前已归档的运行配置保持不变。

最新有效来源仍是 `user_paper_02`，task 7 的 pending mine_collect 未确认且 deadline 已过。此前的终态观察/session 校验修复通过本轮全量 Python 测试；旧任务缺失 goal_state 的兼容歧义、临时 launch_profile 固定 task 6 的问题仍按已有记录处理。未恢复或创建游戏任务。

## 首轮复核验证与下一步（后续结果见 STATUS）

- Python 3.10：禁用外部 pytest 自动插件并显式加载 pytest_asyncio，`476 passed, 54 warnings in 70.00s`。未修改 Python 生产代码。
- Windows Node 24.22.1：Bridge 全部 `225` 项测试通过；日志在 `work/audit_20261028/bridge_tests.log`。采集测试使用确定性替身；寻路超时测试使用真实库的 goto 和替身 bot。
- Bridge 语法检查、`git diff --check` 通过。
- 未运行 Minecraft。`runtime_blocked=true`，也没有新的环境恢复证据；代码测试不构成 S0–S4 实机通过。

优先核对是否有手动降压、超频或内存参数，再按 ASUS 的硬件诊断流程检查并保存结果；若保持默认设置仍反复出现 WHEA，可向 ASUS 提交上述日志。该建议基于多应用异常与 WHEA 的组合，不是已确认硬件损坏。[ASUS 系统诊断说明](https://www.asus.com/support/faq/1045716/)

恢复环境后才安排一次有界 Windows 实测，并为 owned Node 配置原生 dump 捕获。不能继续用反复重启游戏代替定位，也不能把正常退出一轮解释为主机故障已排除。
