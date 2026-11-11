# S2 采集合同修复后 S0–S4 Windows 隔离实测（2026-10-28）

用户授权代码修复后一次有界连跑。启动前 marker 的 cleanup_pending、runtime_active、owner_active 均为 false，目标不存在且端口无监听。使用不含世界和数据库的 `work/mc/terra_seed_20261028`，在 `work/mc/terra_s0_s4_collectionfix_20261028` 新生成世界和任务数据库；保留旧世界、task 7 和预算。服务 normal，level-seed=20261022，脚本开启生物与昼夜循环、关闭 keepInventory、设初始时间1000；不注入物品。固定种子不能保证路线或事故复现。

隐藏启动命令：`.venv/Scripts/python.exe scripts/run_stage.py --chain-s0-s4 --isolate-from work/mc/terra_seed_20261028 --isolate-target work/mc/terra_s0_s4_collectionfix_20261028 --isolate-port 26784 --isolate-rcon-port 26785 --isolate-studio-port 8871 --bridge-restarts 0 --stage-timeout 600 --server-timeout 120 --java D:/AI-Workspace/Voxkin/work/runtimes/temurin-21.0.12.1-win-x64/jdk-21.0.12.1+1/bin/java.exe --node D:/AI-Workspace/Voxkin/work/runtimes/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe --output work/refactor_validation_20261027/collectionfix_s0_s4_result.json`。总限 3000 秒；实际阶段总用时 565.4 秒。wrapper PID 43692、runner 4156、Bridge 42224、Paper 42920。Paper 就绪后 Bridge session 5246d25e-f070-4b1e-9153-78a5bafe91be ready，初始观察背包为空。

S0 63.0 秒、S1 164.7 秒、S2 61.0 秒通过；S2 完成快照 revision171 显示庇护所 sealed=true、inside=true、missing_blocks=0，床两半在室内，health20、food17。night_required=false、sleep_confirmed=false，不能称实际睡过夜。S2 派发泥土总目标17，之后完成建造及放床；本次没有出现上轮目标持续增至104的现象，但并未复现相同缺料/部分结构场景，不能单凭本次通过断定所有情况已解决。

S3 276.7 秒 blocked：`s3_ore_route_exhausted`，累计17动作，最终8粗铁，最低目标9，transport recoveries=0。采矿回执显示部分目标无法到达；后续 strip_mine 多次遇水或找不到安全阶梯落点，最终探矿路线耗尽。S4 未运行。本轮日志未见低氧或死亡，因此水中自救修复没有被实机触发。

对这个新阻塞再次检索 [Minecraft Wiki 挖矿教程](https://minecraft.wiki/w/Tutorial%3AMining) 与 [Water](https://minecraft.wiki/w/Water)：挖开通路可能暴露水域、引入水流，停止危险下探本身有机制依据。当前已证实的是候选路线遇水后耗尽，尚未完成离开当前水域、迁移采矿地点等策略的缺陷定位；本轮没有修改这部分策略或追加运行。

S3 阻塞后运行器正常清理：Paper 日志 16:44:00 明确记录 RCON stop、Saving players 及所有维度保存；Bridge 的 Server closed 是清理停服后的断线，不是崩溃。结果记录 bridge_restart_history=[]、cleanup_errors=[]；owned 进程退出，26784/26785/8871 无监听。保留世界及数据库，不重跑、不重置预算。结果 `work/refactor_validation_20261027/collectionfix_s0_s4_result.json`；日志 `collectionfix_stdout.log`、`collectionfix_stderr.log`、目标目录 `logs/run_stage_console.log` 与 `.voxkin-studio/logs/bridge.out.log`。
