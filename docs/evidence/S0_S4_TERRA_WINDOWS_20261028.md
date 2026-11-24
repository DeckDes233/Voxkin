# S0–S4 Windows 隔离实测（2026-10-28）

用户授权一次有界启动。marker 预检 cleanup_pending=false；新种子仅复制 Paper 程序、库和服务器配置，无世界和任务数据库；新目标 `work/mc/terra_s0_s4_20261028` 首次生成世界与数据库，不继承旧 task 7 或其存档。难度 normal，脚本设置 doMobSpawning=true、keepInventory=false、doDaylightCycle=true、时间 1000；这不是完全无设置干预的测试。未注入物品。静音运行，无 LLM 延迟测量。

启动命令：`.venv/Scripts/python.exe scripts/run_stage.py --chain-s0-s4 --isolate-from work/mc/terra_seed_20261028 --isolate-target work/mc/terra_s0_s4_20261028 --isolate-port 26780 --isolate-rcon-port 26781 --isolate-studio-port 8869 --bridge-restarts 0 --stage-timeout 360 --server-timeout 120 --java D:/AI-Workspace/Voxkin/work/runtimes/temurin-21.0.12.1-win-x64/jdk-21.0.12.1+1/bin/java.exe --node D:/AI-Workspace/Voxkin/work/runtimes/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe --output work/refactor_validation_20261027/terra_s0_s4_result.json`。首次命令 Java 路径含空格被拆分，参数解析失败，未创建目标、未启动服务；修正后运行。wrapper PID 54252、实际 Python 56724、Studio listener 56308、Bridge 56344、Paper 57244。Paper ready 后 Voxkin 登录，Bridge 给出 ready 新鲜观察。

结果：S0 63.1 秒、S1 140.3 秒、S2 109.7 秒均 stage_complete=true；S2 的 night_required=false、sleep_confirmed=false，不能声称实际睡过夜。S3 360.4 秒达到阶段超时，stage_complete=false，最后等待白天补食物；S4 未运行。总阶段时间 673.5 秒。详见 `work/refactor_validation_20261027/terra_s0_s4_result.json`。

Paper 日志 15:22:12 报告 Voxkin drowned；Bridge 日志显示死亡前 mine_collect 被低氧本地避险抢占，氧气 8 后降为 0；受伤期间位置约 (21.3, 56.2, 63.7) 未变，随后死亡重生。此前庇护所位于 (22,62,60)，leave_shelter 未验证走到墙外，随后执行 craft 与 mine_collect。日志显示低氧反应确有触发，但不足以确定入水途径、动作目标及未脱困的具体算法根因。死亡后重建物资，keepInventory=false；Bridge PID 未更换。原始日志在目标 `.voxkin-studio/logs/bridge.out.log` 和 `logs/run_stage_console.log`。

运行器记录 Bridge 重启历史为空、cleanup_errors=[]；Paper 日志确认各维度保存，owned 进程退出，端口 26780、26781、8869 无监听。世界保留在目标目录。清理后的独立只读 PowerShell 端口检查发生 CLR internal error 0x80131506，随后用 netstat 核对；该异常不属于 Paper 或 Bridge，本次无法归因。旧有效来源及未确认任务未被修改；该次运行不证明宿主原生异常已解决。
