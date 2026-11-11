# 低氧重规划后 S0–S4 Windows 隔离实测（2026-10-28）

用户授权一次隔离运行。启动前 marker cleanup_pending、runtime_active、owner_active 均 false，目标不存在且端口无监听。原无世界/DB种子 `work/mc/terra_seed_20261028` 的 level-seed=20261022；新目标 `work/mc/terra_s0_s4_waterreplan_20261028` 生成新世界及DB。normal，启用生物及昼夜循环，关闭 keepInventory，起始时间1000，无物品注入。旧世界和旧 task 7 未修改。

隐藏运行命令：`.venv/Scripts/python.exe scripts/run_stage.py --chain-s0-s4 --isolate-from work/mc/terra_seed_20261028 --isolate-target work/mc/terra_s0_s4_waterreplan_20261028 --isolate-port 26788 --isolate-rcon-port 26789 --isolate-studio-port 8873 --bridge-restarts 0 --stage-timeout 1200 --server-timeout 120 --java D:/AI-Workspace/Voxkin/work/runtimes/temurin-21.0.12.1-win-x64/jdk-21.0.12.1+1/bin/java.exe --node D:/AI-Workspace/Voxkin/work/runtimes/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe --output work/refactor_validation_20261027/waterreplan_s0_s4_result.json`。wrapper PID18732、runner56632、Bridge52672、Paper54176；Bridge ready session 270e0dbd-9043-4409-bb33-02592a8f9b64。

S0 61.0秒、S1 158.5秒、S2 75.1秒通过。S2 sealed/inside，床在室内；night_required=false、sleep_confirmed=false，未确认睡过夜。S3 154.5秒因 Bridge 退出而 blocked，S4 未运行。Bridge 日志显示 JS TypeError `Cannot create property metadata on number 828`，exit code 1（不是 0xC0000005 native AV）；禁止自动重启的预算为0。本轮未触发低氧及换区，不能称水险重规划实机通过。

最后可用观察 revision233、alive、health20、food16、raw_iron4，位置约(-44.5,58,101.5)。保存DB task4 goal为 paused_by_user、task row cancelled（运行器清理API），原 deadline 1793193870.1288028、actions4；pending `6005582ddcf3` mine_collect disconnected、receipt_confirmed=false、needs_reconcile=true，结果未知，不能手改预算或当作终态回执。后续仅可通过正式恢复流程和新鲜观察对账。

Paper 17:27:04记录 RCON stop，保存全部维度；owned进程退出、26788/26789/8873无监听，cleanup_errors=[]。保留世界/DB和日志。结果 `work/refactor_validation_20261027/waterreplan_s0_s4_result.json`；日志 `waterreplan_stdout.log`、`waterreplan_stderr.log` 和目标 `.voxkin-studio/logs/bridge.out.log`、`logs/run_stage_console.log`。
