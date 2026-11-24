# Windows 原生崩溃只读分析（2026-10-27）

本轮只读检查了 R25、R29、R31 的既有记录和 Windows 事件日志，没有启动 Minecraft、运行 replay、修改系统设置或更换 JDK。结论是：JDK 编译器故障和 Windows 主机稳定性都需要检查；现有证据不足以证明哪一种导致了全部崩溃。

## 关键时间线

- R25 的第二个 Windows Bridge 进程 PID 71072 在 2026-10-27 03:27:33.334（Asia/Shanghai）以 `0xC0000005` 退出，见 `work/refactor_validation_20261027/processes.jsonl`。同一轮另有两个 Bridge 进程以该代码退出。
- Windows System 日志在 03:27:32.035 记录了一条 `Microsoft-Windows-WHEA-Logger` 事件，Event ID 2、Record ID 375483，描述为已更正的硬件错误；这比上述进程退出记录早约 1.299 秒。事件原始 XML 保存在 `work/refactor_validation_20261027/whea_system_event_375483.xml`。CPER 原始数据 1019 字节，SHA-256 为 `6db8a719eb9e198301122975aab79c4fd301a010de0fa1cfd7d32a0be20946ac`。
- 按本机 Windows SDK `cper.h` 的结构与有效位解析，该 CPER 记录包含通用处理器错误区段：`ValidBits=0x217f`、`ErrorType=1`（cache error）、`Operation=3`（instruction execution）、`ProcessorId=16`。记录的 memory error section `ValidBits=0`，不能据此断言内存条故障。CPER 时间戳的 `Precise` 位未置位；事件记录时间与进程退出时间接近，但事件没有提供将错误关联到该 Node 线程的证据，也不能证明因果。
- 除这次 Event ID 2 外，10 月 27 日 02:54:41、03:06:36 和 10 月 25 日 20:12:20 等还有 WHEA Event ID 19：处理器核心、Corrected Machine Check、Internal parity error，报告的 APIC ID 包括 16 和 25。Windows System 日志查询覆盖到 9 月 3 日；截至本轮查询，R31 18:04 崩溃附近没有新的 WHEA 记录。没有记录并不排除未记录的错误。
- 应用事件日志在 10 月 26–27 日记录过多个 `python.exe` 的 `0xc0000005`，故障模块包括 `python39.dll`、`python310.dll` 和 `python312.dll`。这是整机的事件，尚未逐一归属 Voxkin；不能把所有 Python 崩溃合并成同一根因。
- R31 使用 Temurin 21.0.6+7，JVM 启动约 37.6 秒后，在 `C2 CompilerThread0` 编译 `AbstractMinecart::getPos` 时于 `jvm.dll` 访问违规。JVM 报告见 `work/mc/refactor_validation_20261027_r31_windows_node24lts_s3_s6/hs_err_pid22592.log`。该堆栈证明崩溃位置和当时编译任务，不证明该 Java 方法、JDK 编译器或硬件是哪一个根因。与 R29 Node 的一次 `Invalid bytecode` 栈也不能自动视为同一故障。
- R29 Paper 也使用 Temurin 21.0.6+7 且当轮正常退出；这不排除间歇性 JDK 或系统故障，也不能证明该版本在 R31 场景稳定。R29 多次 Bridge 原生退出与 R31 的 JVM 故障发生在不同进程，仍分别保留证据。

## 环境核对

- 机器为 ASUS TUF Gaming F16 FX607JVR，i9-14900HX；本机 BIOS 为 `FX607JVR.316`，microcode 记为 `0x12b`。ASUS 此型号支持页面本轮列出版本 316。不能根据桌面处理器的历史 Vmin 事件推断本机根因；Intel 的相关说明将 13/14 代移动端及 HX 与该桌面问题区分。
- Adoptium 官方已有 `jdk-21.0.13+9` release；本轮查询其 release 资产时，尚未看到 Windows 资产。官方 Windows x64 latest API 本轮返回的可用包为 `jdk-21.0.12.1+1`，下载包 SHA-256 `f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e`；当前 R31 用的是 21.0.6+7。发布资产可能变化，执行任何下载前应重新查询。新版本是合理的受控对照候选，版本更新本身不证明修复。此轮没有下载安装。
- R31 诊断副本没有本轮正常保存证据，未晋升；R29 仍为已核验的有效恢复来源。R31 的 task 7 只属于诊断副本，不能与 R29 的 task 6 数据库混用。当前 runtime 仍 blocked。

## 推荐验证顺序

1. 保留 R31 `hs_err`、`replay` 和 WHEA 原始记录；先用厂商提供的 CPU、内存诊断和 Windows 事件记录检查主机稳定性。若诊断发现错误，保存结果并交由 ASUS 支持处理；若通过，也不能排除间歇故障。
2. 分开评估官方独立 Windows JDK 21 补丁版：校验包和可执行文件，放在 `work/runtimes`，不更改系统 JDK 或全局 PATH。先记录真实非游戏 JVM 编译/运行结果与相关 WHEA 事件；不得把一次无崩溃烟测当成根因修复或长期稳定证据。
3. 只有出现新的、经审查的环境恢复证据且清理门控满足后，才从 R29 的新隔离副本做一次有界 Windows 验证，保留时钟和验收条件；先通过正式 Supervisor 处理过期 task 6，再创建一次新预算的 S3 任务。继续按 `active_progress.json` 检查 owner/lease 和 cleanup 状态。

## 资料

- [Microsoft：WHEA 错误处理](https://learn.microsoft.com/en-us/windows-hardware/drivers/whea/error-processing)；[处理器错误区段和有效位](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_whea_processor_generic_error_section)。
- [Oracle：JDK 21 故障排查指南](https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshooting-guide.pdf)，CompilerThread 崩溃可能涉及编译器问题，但并非必然。
- [ASUS：FX607JVR BIOS 支持](https://www.asus.com/supportonly/fx607jvr/helpdesk_bios/)；[MyASUS 系统诊断](https://www.asus.com/uk/support/faq/1045716/)；[Intel 对移动端 HX 与桌面 Vmin 问题的说明](https://community.intel.com/t/does-the-recent-problem-concerns-laptop-i9-14900hx-or-only-desktop-cpus/125857)。
- [Adoptium：Temurin 21 Windows x64 官方版本元数据](https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse)；[21.0.13+9 release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9)。
