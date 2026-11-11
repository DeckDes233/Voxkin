# Node 22 / V8 12.4 对照（2026-10-28）

用户提出回退 V8：Node 24.22.1 的 `process.versions.v8` 为 `13.6.233.17-node.58`；官方 Node 22.23.4 为 `12.4.254.21-node.57`。下载独立 `work/runtimes/node-v22.23.4-win-x64/node.exe`，SHA256 `dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f` 与 Node 官方发布的 SHASUMS256 一致。新旧 Node 并存，不覆盖系统或原运行时。使用 `--jitless` 和此前重装依赖，对相关组件执行11项定向测试，通过；Node22 提示 `--jitless` 禁用 wasm，该提示不是测试通过或崩溃根因的证明。

用户提出回退验证，以正式 `scripts/run_stage.py --chain-s0-s4` 从 `terra_seed_20261028` 复制新副本 `work/mc/node22_s0_s4_20261028_2205`，Node22 + 原锁依赖，端口26802/26803/8880，Bridge PID39920，ProcDump PID31984，重启预算0。

S0于56.7秒通过、S1通过；S2猎羊时 Bridge 最后日志时间22:09:37，Paper在22:10:09报告 Voxkin 连接超时。Studio 观察为 disconnected，S2未完成，pending `hunt_material` 的回执未知；此时 Node PID39920仍存活，Paper、Studio继续监听，ProcDump 未捕获本轮原生异常，不能判定回退修复故障。

两次 ProcDump PSS 快照（22:11:45与22:13:48，均保存在 `work/refactor_validation_20261027/node22_2205/`）用 SHA256 与官方匹配的 Node22 PDB 分析，主线程栈均处于 `v8::internal::Debug::Break`、`Runtime_DebugBreakOnBytecode`、`Builtins_DebugBreakExtraWideHandler` 与解释器入口附近；两次快照给出相近路径但不同采样指令。尚未确定调试字节码路径因何触发，也不能断言快照或原生调试器是其原因。进程内存快照可能含敏感数据，仅存 work。

22:14 左右观察：Paper 与 Studio仍运行、Bridge未连接，runner仍存在并保留阶段超时/清理机制；marker保留 runtime_active=true、cleanup_pending=true。本轮没有因调查主动停服或重启，后续须先确认该运行及清理状态后再启动其他实机测试。当前结论是 Node22 避开了已观察到的即时原生退出，但本轮仍在 S2 卡住，不能视为 S0–S4通过或故障修复。

## 用户要求指定 Node22 并重新连接

用户指定 Node22 并要求重连；用户级 `VOXKIN_NODE` 设置为 `D:\AI-Workspace\Voxkin\work\runtimes\node-v22.23.4-win-x64\node.exe`，供新启动且继承该变量的 Voxkin 运行器使用；已有进程不会自动更新环境，手工执行 `node` 亦不会因该变量自动改版。

22:15 确认原 Paper/Studio 仍运行、原 Bridge PID39920停滞、S2 task3有未确认的 `hunt_material` 动作；保留原 Bridge、原 runner和其两个卡住快照，未终止原运行器。以相同 Node22 和原隔离 Bridge 创建新 Bridge PID23388连接原端口26802、Studio 8880，新 ProcDump PID29400附加。新 session `14305c24-c6b9-4cdf-a470-e4b31cb9e18c` 获取新世界观察，原任务自动恢复，未重新创建任务或重置预算。随后补足建造材料，22:17:08 `make_shelter` 报告墙与屋顶逐格验收成功；目前S2在 `wait_for_day`，角色满血，未报告 S2 完成。

原 runner仅持有旧 Bridge，无法自行清理新进程；单独启动受身份检查的监护进程 PID12220等待原 runner退出后，仅取消新 Bridge 的 ProcDump 并结束当时仍匹配路径、启动时间和参数的替代 Bridge，不主动操作 Paper；仅在端口、进程、结果和 cleanup_errors 均核验后更新 marker，否则保留 cleanup_pending 供检查。截止记录时服务仍在线、run_state active。日志 `work/refactor_validation_20261027/node22_2205/reconnect_stdout.log` 和 `reconnect_stderr.log`；未将当前连接成功描述为原生故障已修复。

## 22:22 再次退出与停止事件来源

22:21:31 敌对生物触发本地避险并抢占 `wait_for_day`；22:22:12 反击骷髅一次后仍未消灭，恢复等待天亮。22:22:36 替代 Bridge PID23388 发生未处理 0xc0000005，ProcDump 成功产生 `node.exe_261028_222236.dmp`，SHA256 `eb71c8ffc78fe4abf8ce088ddde77299fc1b808d9202bac49cd9cf91645e91b8`。用户日志的桥接断线与实际原生异常时间吻合，不能仅由 hostile_nearby 顺序证明骷髅处理是根因。

Node22 同版本 PDB 与 CDB 确认异常地址 `node!Builtins_InterpreterEntryTrampoline+0x15d`，指令 `push rcx` 向 `0x0000031e14ff45c8` 写入而失败。`inspect_crash_stack.py` 只读解析 dump MemoryInfoList：当时 RSP、异常目标位于 `MEM_FREE`，RBP处于已提交内存，但 RSP 和 RBP 都不在异常线程 dump 所列的栈范围 `0x58acfea000–0x58ad000000`。反汇编显示该 `push` 前执行了 `leave`、`pop rcx` 和 `add rsp,rbx`；这些是已捕获现场，尚不能证明栈异常由哪里、何时产生。CDB 后续返回地址异常且无法可靠回溯成 JS 调用链；不能把上轮 Node24 的 `inspectResourceSites` 栈挪作本轮原因。

原 runner 在最初 Bridge PID39920退出时看到替代 session仍连接，等待；替代进程 22:22:36 退出后，runner 对原进程报告重启预算耗尽，调用 `/api/run/stop`。该接口固定使用“玩家要求停止目标”，所以日志是 runner 产生的自动停止调用，不代表用户手动点击。旧版 runner 因此将此目标设为 `paused_by_user`，需将其作为 runner 自动清理污染处理，不能误认为用户要求放弃 S2。Paper22:22:37记录所有维度保存，结果 cleanup_errors 为空。

修正 `scripts/run_stage.py`：Bridge 退出且 GoalSupervisor 已断线、worker不再运行时不调用显式玩家停止接口，保留断线与未确认动作；worker仍运行或其他目标状态沿用原有停用逻辑。`tests/test_run_stage_isolation.py` 36项通过；尚未用新版 runner 做实机验证，阶段超时及其他状态的停止语义未在此改动中改变。

监护脚本完成进程清理后，Windows PowerShell 5 的 `ConvertFrom-Json` 不能读取当时 marker，导致更新 marker 失败；人工用 Python 读取并核验 marker、结果、端口和进程后修正为 runtime_active=false、cleanup_pending=false、runtime_blocked=true。脚本失败不等于停止或保存失败。保留旧现场和新转储；不要将这次快照中内存异常直接归因于硬件或特定游戏逻辑。

## `add rsp, rbx` 回溯

22:22 崩溃时 RBX 为 `0x2c567ff5ac0`（3046876601024 字节）。按转储中的指令序列逆推 `leave` 与 `pop rcx` 的16字节消耗，`pre_leave_rbp = rsp - rbx - 16 = 0x58acffeb00`，落在该线程已捕获的栈区间；读取其保存帧指针可复核崩溃时 RBP。读取 `[pre_leave_rbp-0x18]` 得到 `0x58acffeb58`，其值乘8与崩溃时 RBX 相等。脚本 `work/refactor_validation_20261027/node22_2205/reconstruct_frame.py` 从 dump 中仅验证这些指定字段。

Node 22.23.4 [V8 x64 LeaveInterpreterFrame 源码](https://raw.githubusercontent.com/nodejs/node/v22.23.4/deps/v8/src/builtins/x64/builtins-x64.cc) 将该偏移作为实际参数数量，乘指针大小后与形式参数大小比较，使用较大者回收栈参数。本次该槽位值外观及数值更像栈地址，不像正常参数个数。这个推断解释了计算后的异常 RBX，但不足以确定是帧类型识别错误、写入异常还是其他原因，也不能凭此确定是 V8 缺陷或硬件问题。

## 不附加调试器的控制运行

用户明确要求无调试器对照。上轮 PID及 26802/26803/8880端口已核对释放；发现 PID31088 为22:11:45 PSS快照产生的零线程遗留进程，经身份核对请求结束后确认消失。检查 runner 的 Node 参数拼接，未发现自动加入 `--inspect`；本轮启动时清空 `NODE_OPTIONS`。仍使用 Node22.23.4、同一锁定依赖、`--jitless`，从 `terra_seed_20261028` 创建独立干净世界 `work/mc/node22_nodbg_s0_s4_20261028_2228`，端口26804/26805/8881，无 ProcDump。

本轮 Bridge PID45688 的实际命令行只有 `--jitless` 与 Bridge 入口，无 `--inspect`；调用 Windows `CheckRemoteDebuggerPresent` 分别在进入世界和断线后均返回 false，未发现 ProcDump 进程。22:30:15 最后记录拾取橡木，22:30:46 Paper 记录连接超时，Studio 随后报告 S0 的 `mine_collect` disconnected；22:31 仍观察 Node进程存活，执行器非运行状态，故本轮未完成S0。与附加 ProcDump 的前轮都曾出现 Node进程存活但连接超时，说明外观相似的卡住可在无原生调试器条件下出现；并不能证明底层卡点相同，也不能排除调试器对之前 0xc0000005 的影响。本轮没有附加调试器或抓取进程快照。

本轮启动了标准 S0–S4 runner以从干净世界自然取得S2前置，但当前S0已断线，未达到S2。截至22:31末，Paper、Studio、runner和该Node仍存在，已保留原世界、任务及日志；marker保持 runtime_active/cleanup_pending，后续不得误判为已清理或并行启动另一轮。

静态检查崩溃前执行流：`wait_for_day` 是有截止时间且每秒异步等待的循环；`defendAgainst` 使用 try/catch/finally 并异步调用战斗逻辑；仅凭源码未发现这些函数本身的无限递归，也不能排除依赖内部的深调用或运行时帧问题。另一次 Node24 中止的 JS 栈经过 `inspectResourceSites` 的 `findBlocks` 和 Mineflayer 区块读取，但不能将那个栈视为本次 Node22 退出时的 JS 栈。依赖 `protodef/src/compiler.js` 确实通过 `eval(code)()` 动态生成协议编解码器；这证明动态代码存在，不证明其导致指针或栈异常。

以前运行多次存在未附加 ProcDump 的原生退出记录；本次无调试器对照出现的是连接超时和事件循环疑似无响应，不能说“无调试器仍发生了相同原生崩溃”。同理，一轮未崩溃也不能锁定调试器是根因。此前 ProcDump `-e` 是原生异常调试附加；原生调试器与 Node Inspector 不应混同。当前没有独立于游戏逻辑的稳定最小复现，尚不具备向上游提交可复现 bug 的条件。
