# SFC 与用户反馈内存检查后 S0 实机（2026-10-28）

用户报告内存诊断无异常、SFC 未发现完整性冲突，并明确要求启动测试。Windows 本次开机时间为 21:35:54 +08:00；独立检查未取得本次内存诊断事件，不将用户反馈升级为已核验事件。此前 S3 原任务 deadline 已过，因此使用正式 run_stage.py 的 `--chain-s0-s4 --runs 1` 从 `work/mc/terra_seed_20261028` 复制新世界至 `work/mc/postcheck_s0_s4_20261028_2145`，端口 26798、26799、8878，Bridge 不自动重启。原有现场不覆盖。

S0 在 77.5 秒内取得木材、木板、工作台和木镐，仍在采集阶段时中断；S0 未通过，S1–S4 未运行。进程 Node 24.22.1 `--jitless` PID36676 于21:47:12中止，运行器记录 0xC000001D，ProcDump 捕获 `work/refactor_validation_20261027/postcheck_2145/node.exe_261028_214712.dmp`，428955360 字节，SHA256 `70ae6afb13af41718ce6f2ee351359524a6579044286d07c08339e2c3313cd46`。转储和详细 stderr 含进程内存与现场数据，保存在忽略的 work 下。

同版本 PDB 的 CDB 结果：异常地址为 `v8::base::OS::Abort+0x63`，指令为 `ud2`，调用链含 `v8::internal::Runtime_Abort` → `Builtins_AbortHandler`；它是 V8 主动中止，不应解读为 CPU 不支持正常工作负载的指令。stderr 标记 `abort: ConstructWithSpread` 并记录 JavaScript 栈：`toBiomePos` → `ChunkColumn.getBiome` → `ChunkColumn.getBlock` → `prismarine-world.getBlock` → Mineflayer `blockAt/findBlocks` → `inspectResourceSites` → `createObservation` → `buildStateObservation` → `sendState` → Node timers。磁盘上的 `toBiomePos` 是计算并返回坐标对象，未看到 spread 构造；不能凭此单独断言字节码损坏、特定依赖缺陷或硬件原因。

之前 20:32 的 `instanceof` 异常也经过 `inspectResourceSites`，但两轮的异常不同，调用链相同不证明因果。本轮首次获得中止时的 JS 栈，后续可针对状态采样和区块读取研究，不可用 catch 假装能处理原生中止。

Paper 于21:47:17确认所有维度保存，运行器 `cleanup_errors=[]`；本轮 owned 进程均已退出，端口无监听。结果 `work/refactor_validation_20261027/postcheck_2145/result.json`；运行 marker 已标记 cleanup_pending=false、runtime_blocked=true。无证据表明 SFC 通过或单次内存检查已消除原生故障；本轮没有重复重启进程。
