# 水中自救修复后 S0–S4 Windows 隔离实测（2026-10-28）

用户授权一次有界实机连跑。启动前 active_progress 顶层 cleanup_pending、runtime_active、owner_active 均为 false，目标不存在，端口无监听。使用仅含 Paper 程序、运行库及配置的 `work/mc/terra_seed_20261028`，不含世界或任务数据库；目标 `work/mc/terra_s0_s4_waterfix_20261028` 是新生成世界及新数据库，旧 task 7、旧预算及旧世界未改动。配置 `level-seed=20261022`、normal，脚本启用生物生成、关闭 keepInventory、启用昼夜循环并将起始时间设为 1000；未注入物品。固定种子不保证游戏路径或事故复现。

隐藏启动命令：`.venv/Scripts/python.exe scripts/run_stage.py --chain-s0-s4 --isolate-from work/mc/terra_seed_20261028 --isolate-target work/mc/terra_s0_s4_waterfix_20261028 --isolate-port 26782 --isolate-rcon-port 26783 --isolate-studio-port 8870 --bridge-restarts 0 --stage-timeout 600 --server-timeout 120 --java D:/AI-Workspace/Voxkin/work/runtimes/temurin-21.0.12.1-win-x64/jdk-21.0.12.1+1/bin/java.exe --node D:/AI-Workspace/Voxkin/work/runtimes/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe --output work/refactor_validation_20261027/waterfix_s0_s4_result.json`。总轮上限 3000 秒；实际阶段总用时 418.9 秒。wrapper PID 560、Python runner 42520、Bridge 49412、Paper 5872。Paper 启动、Bridge ready，session e8e96d71-3783-4556-a0b9-176e5db82873，初始新鲜观察背包为空。

结果：S0 63.0 秒通过，S1 148.4 秒通过；S2 207.5 秒 blocked，`budget_method_attempts`，stage_complete=false；S3、S4 未运行。S2 night_required=false、sleep_confirmed=false，未确认睡眠过夜。最终观察 health=20、food=16，dirt=64，白床、石镐、石剑、熔炉均在背包。

S2 首次 make_shelter `c9bb04cd8d00` 失败，报告内部 (18,75,81) 被方块占住；一次旧 revision 准入拒绝未启动；`a4235919eb8d` 因缺 15 个建材而 blocked。之后 Bridge 报告成功采集泥土至背包 50、64，随后报告已有 64 无需再挖；最终目标状态记录 `s2:mine_collect:dirt` 观察条件未满足、方法物理失败次数 3/3（缺 dirt 40）。这些回执及计数的具体关系需进一步审查，不能仅凭本次记录推断根因。详见结果 JSON 的 final_goal_state/action_history 与 Bridge 日志。

本次没有在 Bridge 日志中发现低氧或死亡事件，且未进入 S3，因此不能将其作为水中自救修复的实机效果验证。运行器记录 Bridge 重启历史为空，cleanup_errors=[]；Paper 日志确认三个维度全部保存，owned 进程已退出，26782/26783/8870 无监听。保留新世界与数据库。未重试或重置预算。原始日志：`work/refactor_validation_20261027/waterfix_stdout.log`、`waterfix_stderr.log`，目标目录 `logs/run_stage_console.log` 与 `.voxkin-studio/logs/bridge.out.log`。
