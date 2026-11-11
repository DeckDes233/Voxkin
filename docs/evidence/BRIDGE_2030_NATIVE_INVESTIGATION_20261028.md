# Bridge 原生退出只读调查（2026-10-28）

本轮 `work/refactor_validation_20261027/recovery_2030_result.json` 记录 Node v24.22.1 `--jitless`，PID 42244 在运行 114.683 秒后于 20:32:41.722 +08 以 0xC0000005 退出，未重试。仅凭退出码不能定位故障模块或根因。

目标 `work/mc/recovery_s3_s4_20261028_2030/.voxkin-studio/logs/bridge.out.log` 前约 427 行为复制的旧记录；本轮从约 428 行开始。12:32:40.601Z（20:32:40.601 +08）出现 `TypeError: Right-hand side of 'instanceof' is not an object`，调用链为 `CommonChunkColumn.getBlockEntity` → mineflayer `bot.findBlocks` → `resource_sites.js:15 inspectResourceSites` → `world_observation.js:139` → `minecraft_bridge.js:3509 buildStateObservation`，随后报告 mineflayer error/reconnect，约一秒后发生原生退出。这是时间关联，尚不能证明因果。本轮较早还有 PartialReadError，不证明其与退出有关。

目标 `bridge.err.log` 与源 `work/mc/terra_s3_continue_jitless_20261028/.voxkin-studio/logs/bridge.err.log` 的 SHA256 相同，最后写入时间 17:35；其中 V8 fatal 和 Invalid bytecode 属旧运行，不是本轮原生堆栈。

Windows Application/System 在 20:30–20:35 无事件；Application 20:20–20:45 的 1000/1001 无 Node 或 PID 42244。已检查的目录和 CrashDumps 清单未发现本轮 Node 转储；此结论限于已查范围。

20:41:05 Application 1000（RecordId 279101）记录另一进程 Codex bundled pwsh.exe 7.6.5.500 PID 46972 在 coreclr.dll 10.0.1126.37416 中以 c0000005 退出，offset 0x2278f；20:41:08 WER 1001（RecordId 279102）记录报告，存在独立 `pwsh.exe.46972.dmp`，未分析。它发生在 Bridge 退出约 8 分钟后，不能作为 Bridge 堆栈或证明共同根因。

后续应保留现场，检查状态观察中 TypeError 的可独立修复原因和依赖一致性；仅捕获异常不等于解决 native AV。若要定位原生退出，需先获得针对该进程的可信故障模块和转储证据，并在环境恢复后按 marker 要求进行有界验证。本次没有启动 Minecraft、调试器或压力测试，也没有更改系统。

本轮 TypeError 原始堆栈位于 `bridge.out.log` 第 526–538 行，起点显示 `posKey`（`prismarine-chunk/src/pc/common/CommonChunkColumn.js:1:41`），随后经 `getBlockEntity`、`getBlock`、`prismarine-world` 的 `WorldSync.getBlock` 与 mineflayer `blockAt/findBlocks` 到观察构造。当前磁盘文件中 `posKey` 是模板字符串而无 `instanceof`；运行时执行代码是否与当前文件一致尚未确认，因此不能推断异常的具体触发机制。锁文件记录 mineflayer 4.39.0、mineflayer-pathfinder 2.4.5、minecraft-protocol 1.68.0、protodef 1.19.0、prismarine-chunk 1.41.0、prismarine-world 3.7.0、minecraft-data 3.117.0。资源提示扫描异常传播可作为独立代码审查对象。
