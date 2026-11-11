# S3 保存世界续跑诊断（2026-10-28）

用户授权从上轮保存世界复制到独立目标续跑；这是一轮继承现场诊断，不是从零 G1。预检 marker cleanup_pending/runtime_active/owner_active=false，源 `work/mc/terra_s0_s4_waterreplan_20261028` 已停服、端口空闲、无 SQLite WAL；目标 `work/mc/terra_s3_continue_jitless_20261028` 不存在。正式 `--continue-task 4` 复制前后核对46个世界/DB文件摘要与 task 状态；不重置世界、不更改世界时刻或规则、不注入物品、不改原 deadline 或预算。

隐藏启动命令：`.venv/Scripts/python.exe scripts/run_stage.py --continue-task 4 --isolate-from work/mc/terra_s0_s4_waterreplan_20261028 --isolate-target work/mc/terra_s3_continue_jitless_20261028 --isolate-port 26790 --isolate-rcon-port 26791 --isolate-studio-port 8874 --bridge-restarts 0 --stage-timeout 1200 --server-timeout 120 --java D:/AI-Workspace/Voxkin/work/runtimes/temurin-21.0.12.1-win-x64/jdk-21.0.12.1+1/bin/java.exe --node D:/AI-Workspace/Voxkin/work/runtimes/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe --node-arg=--jitless --output work/refactor_validation_20261027/s3continue_s3_s4_result.json`。wrapper PID57260、runner38872、Bridge46724、Paper58008；新Bridge session ebb8692d-0731-406a-82a9-8fe1cff3e7dd。

原 pending `6005582ddcf3` 在新鲜观察后由正式 Supervisor 记为 `unknown_reconciled_for_replan`，原 receipt_confirmed=false 保留，transport_recoveries=1。任务从 actions4 增至5，deadline仍1793193870.1288028。新 mine_collect `e9abd330f28b` 开始后，进度报告取得2个粗铁；40.8秒时 Bridge Node 24.22.1 --jitless 以 0x80000003 退出，stderr V8 fatal 检查 `std::numeric_limits<int>::max() >= length_`，原生栈保留。Bridge日志另含 protodef PartialReadError 栈，不足以确定与V8 fatal的因果关系。运行器分类 native_exit_no_retry，未重启。S3未完成，S4未运行；该次未验证低氧换区。

target DB task4 为 paused_by_user/task row cancelled，pending `e9abd330f28b` disconnected、receipt_confirmed=false、needs_reconcile=true。进度2并非终态库存回执，后续应通过新鲜观察对账。Paper 17:35:05记录 RCON stop 和全部维度保存；owned进程退出、端口无监听，cleanup_errors=[]，结果中的 source_unchanged=true。保留 source、target、DB与日志；本次不会重复相同原生失败条件。

结果 `work/refactor_validation_20261027/s3continue_s3_s4_result.json` 含source manifest及哈希；日志 `s3continue_stdout.log`、`s3continue_stderr.log` 和目标 `.voxkin-studio/logs/bridge.out.log`、`bridge.err.log`、`logs/run_stage_console.log`。此前 pytest导入期 TypeError 与 native AV 为独立观察，不据此断言共同根因或宿主恢复。
