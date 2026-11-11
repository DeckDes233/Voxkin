# Bridge 访问违规调查（2026-10-28）

## 能确认的事实

- 最新 Paper S3 中，Windows Node 24.22.1 的 Bridge PID 27840 以进程退出码 `0xC0000005` 结束；任务在等待 `mine_collect`。按进程日志，启动记录为 00:49:49.136、退出被观察为 00:51:34.732（Asia/Shanghai），间隔 105.596 秒。阶段结果的 `uptime_s=66.962` 使用较晚的计时基线，不能当作完整存活时间，详见 [Paper S3 实测记录](PAPER_S3_20261028.md)。
- Windows 的 `EXCEPTION_ACCESS_VIOLATION` 说明访问了不允许的虚拟地址；异常记录中的参数才能区分读、写或执行及访问地址。此次只有进程退出码，没有 Node 异常记录或 native stack，不能确定访问类型、故障地址或函数。[Microsoft EXCEPTION_RECORD](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-exception_record)
- 相同退出码以前也出现在 Node 24.19.0 `--jitless` 的多次 shelter `goto` 期间；此次 Node 24.22.1 正常模式下发生于采木期间。因此现有证据不能把它限定为某个动作或 JIT 模式。R29 另一次 `0x80000003` 留有 V8 `Invalid bytecode` 栈，属于另一个退出事件，不能直接当作此次访问违规的栈。
- 本次 `ArmorTrimMaterial` 的 `PartialReadError` 出现在进入世界之前，随后 Bridge 仍登录并完成 goto；同一错误在早期运行也出现。它是需要跟踪的协议解析异常，但没有证据证明其导致本次 native exit。当前 `bridge/node_modules` 的文件盘点未发现 `.node` 原生扩展；Node/V8 自身仍包含原生代码，且没有 dump 可枚举崩溃时加载的全部模块。

## Windows 报告与转储

- 本次退出附近的 Application 1000/1001 和 System WHEA 日志可读取，但未找到 Node 的相关事件；Bridge stderr 与 Node report 目录为空。WER ReportArchive 未找到 node.exe 报告。`--report-on-fatalerror` 针对 Node 运行时 fatal error，不保证每个 Windows 异常都会留下报告。[Node 24 CLI 文档](https://nodejs.org/download/release/v24.17.0/docs/api/cli.html)
- `C:/Users/deckd/AppData/Local/CrashDumps` 当前有 10 个文件，但没有 `node*.dmp`。WER `LocalDumps` 根注册表键存在且含其他程序专用子键，未发现 `node.exe` 子键；仅凭这些事实不能断言过去没有生成过 Node dump 或推断全部 WER 配置效果。没有修改注册表或删除转储。[Microsoft WER 本地转储](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)
- 2026-10-28 09:18:08 的另一个 `pwsh.exe` 进程（PID 52864）在 `coreclr.dll+0x4a38e` 报 `0xc0000005`。只读解析其独立 Windows minidump 的异常元数据，得到访问类型为 read、不可访问地址 `0xffffffffffffffff`；未输出进程内存。该 dump 已复制到 `work/refactor_validation_20261027/native_crash_analysis_20261028/pwsh.exe.52864.dmp`，SHA-256 `05d83779bcbe3c205e9f51ff51a36596fd70cb6d4d8ba3dda4a9e55b03fd0afb`，与原件一致。它不是 Bridge dump，不能用作 Node 调用栈；转储可能含进程内存，保留在被忽略的 `work/` 中。
- 2026-10-28 09:22–09:23 还有三个 `git.exe` 进程发生 `0xc0000005`，Application Error 指向 `ntdll.dll` 或 `msvcrt.dll`；其中一个 PID 之后又记录 `0xc0000025`。只读解析对应 dump 的异常流得到不同访问地址。这些独立进程的异常说明值得排查宿主稳定性，但不能仅凭相同异常码认定与 Bridge 同一根因或断定硬件故障。
- R25 曾有一次 WHEA Event ID 2 的已更正处理器 cache error 记录，时间比当轮一个 Bridge 退出观察早约 1.299 秒。该事件没有关联到 Bridge 线程；最新 Paper S3 的相应窗口没有 WHEA 事件。时间接近不是因果证明。
- 本轮查询的最近 24 小时 System 日志没有 WHEA-Logger 事件；最近 30 天的 System 日志没有查询到 MemoryDiagnostics-Results。日志未出现结果不能证明内存或处理器无故障。当前终端没有管理员权限；`sfc /verifyonly` 需要管理员身份，因此本轮未运行。[Microsoft SFC 文档](https://learn.microsoft.com/windows-server/administration/windows-commands/sfc)

## 结论与后续

当前证据支持“Bridge 以访问违规代码退出，且宿主上其他进程也有原生异常”；仍不能选择 Node/V8、系统模块、第三方注入或硬件中的某一个作为已证实原因。下一次有环境恢复证据且允许的隔离实机验证，需先准备针对本次 owned Node 进程的原生 dump 捕获，再分析异常指令、模块和调用栈；应保留现有 dump，并并行做厂商 CPU/内存稳定性诊断。`runtime_blocked=true` 保持，不重复同条件游戏运行。
