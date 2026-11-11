# Bridge ProcDump 捕获（2026-10-28）

20:54 的隔离续跑监听游戏 26796、RCON 26797、Studio 8877。用户报告 8877 拒绝连接；Paper 与 Studio 已由运行器在 Bridge 退出后结束，故端口不再监听。20:55:42 Paper 记录所有维度保存；结果 cleanup_errors 为空，owned 进程及端口均已确认退出，运行标记已更新。

运行中的 Node 24.22.1 --jitless（PID16876）由微软签名 ProcDump 12.02 以 `-ma -e -t -n 1` 附加。20:55:38 捕获未处理 `0xc0000005`，生成 `work/refactor_validation_20261027/procdump_2054/node.exe_261028_205538.dmp`（276444311 字节，SHA256 3324119696da80566060923c7e5cc0489ad37d2f9a5a1282ae40687704c3ab68）。dump 可能包含进程内存，只存储在被忽略的 work 目录。

Windows 本机 CDB 读取 dump，使用从 Node.js 官方 v24.22.1 `win-x64/node_pdb.7z` 获取的 PDB；CDB 显示 node 为 private pdb symbols。异常线程 30704，读取 `0x000003ff7a0f39cc` 失败，故障指令在 `node!Builtins_ReturnHandler+0x1a`。原生栈包含多层 `Builtins_InterpreterEntryTrampoline`、`v8::internal::Execution::Call`、`node::Environment::RunTimers`。这说明异常发生在 V8 解释器执行路径，并不单独证明 Node/V8 缺陷、哪段 JavaScript 触发或内存异常的根因。此前无 PDB 时的 `AsyncResource::CallbackScope` 是导出符号近似值，不应当当作精确函数。

完整调试输出和只读异常流脚本保存在同一 work 目录；未再次启动实机测试。S3 本轮未完成，S4 未开始。继续排查需要结合故障前具体 JavaScript 活动、宿主独立访问冲突以及可用的 V8 对象和栈证据。

## 进一步定位（只读，2026-10-28）

- 本机 node.exe 的 SHA-256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`，node_pdb.7z 的 SHA-256 `75653d93bc58a9ae2d6bd419130126d881e27f804fd9e2cd0356696fe1f1a328`，均与 [Node 24.22.1 官方 SHASUMS256](https://nodejs.org/download/release/v24.22.1/SHASUMS256.txt) 一致；node.exe 签名状态有效，签名人为 OpenJS Foundation。这核对了磁盘文件，不等于证明运行期间内存未发生变化。
- dump 的 MemoryInfoList 标记失败读取地址所在区域为 `MEM_FREE`，读取其值的上游对象字段所在区域为 `MEM_COMMIT`。直接从 dump 中核对上游字段值与异常时 RDI 一致。该结论由 `work/refactor_validation_20261027/procdump_2054/inspect_memory_map.py` 和 `inspect_feedback_field.py` 得到；只检查特定字段，不输出其它进程内存。
- 本次反汇编在 `Builtins_ReturnHandler` 中先从解释器栈帧加载对象，再读取其偏移为 `0x2f` 的指针，最终从该指针偏移 `0x13` 处读取失败。结合 [同版本 V8 Return handler](https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/v8/src/interpreter/interpreter-generator.cc) 和 [更新 interrupt budget 的源码](https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/v8/src/interpreter/interpreter-assembler.cc)，这与从函数读取 FeedbackCell 并访问其 interrupt budget 的代码路径对应；不能仅凭源码对应断言上游对象类型已在 dump 中独立验证，也不能确定非法指针由何产生。
- 调用栈含 `node::Environment::RunTimers`；项目同时存在 500 ms、1 s、5 s 和 15 s 的多个定时活动，当前栈未还原 JS 函数，不能据此认定具体回调或资源扫描是根因。本轮追加日志的最后记录为登录与区块可读，没有日志显示崩溃前资源扫描 TypeError；这不代表不存在未记录异常。
- 18:32 重启后至本次检查，所查询的 System WHEA 18/19/20 未见记录；同范围 Kernel-Power 41 只说明上次未正常关机，不能视为硬件健康证明。20:41 同机独立 PowerShell `coreclr.dll` 发生 0xc0000005，20:37 和20:39 EdgeUpdate 也发生 0xc0000005；相同退出码不能单独证明共同原因。BIOS 为 FX607JVR.316；Armoury Crate 进程存在、Performance 电源计划生效均不证明有超频或降压。当前会话不是管理员，未运行需要管理员、重启或负载较高的系统检查。

## GitHub 对照

Luna 检索 Node/V8 与 Prismarine 官方项目，未找到确认匹配本次 Windows Node 24.22.1、`--jitless`、ReturnHandler 访问冲突及指针状态的公开 issue；检索结果不证明没有同类缺陷。[nodejs/node#62260](https://github.com/nodejs/node/issues/62260) 涉及 Node 25.8.0、Maglev 和 0xC0000409，与本次版本、错误码和运行条件不同，不应将 `--no-maglev` 视为已验证修复。

本轮 PartialReadError 的 `ArmorTrimMaterial` 路径和 1.21.1 [官方 protocol schema](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.1/protocol.json) 中 trim registry holder 相关，但未找到对应同症问题。[node-minecraft-protocol#1350](https://github.com/PrismarineJS/node-minecraft-protocol/issues/1350) 涉及另一版本和 holderSet 解码错误，其关联的 [minecraft-data#948](https://github.com/PrismarineJS/minecraft-data/pull/948) 已合并；不能据此断言本轮解析错误已解决或其造成原生退出。

## 用户提供的检查结果（2026-10-28 21:42）

用户报告已完成内存诊断且无异常，并提供 `sfc /verifyonly` 的结果：“Windows 资源保护未找到任何完整性冲突。”系统显示本次开机时间为 21:35:54 +08:00。只读查询 `Microsoft-Windows-MemoryDiagnostics-Results/Debug` 时，最新两条为 2026-06-28 和 2026-06-18，尚未找到本次结果；内存检测正常是用户反馈，不能将旧日志冒充本次证据。查询未发现自本次重启后的 WHEA 18/19/20 记录。文件校验和用户反馈的内存检查不等于已证实访问冲突根因或运行环境恢复；原生转储和现场保留，运行标记仍为 runtime_blocked。
