# Windows Bridge 隔离重装（2026-10-28）

用户提出重装环境。为排查 Bridge 原生退出，未修改原 Node、`bridge/node_modules`、代码或世界；在 `work/reinstall_node_20261028/` 建立独立环境。Windows Node 24.22.1 官方 ZIP 校验与官方 SHASUMS256 一致，独立解压后 node.exe SHA256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`，与原运行时一致。

复制 package.json 和 package-lock.json，以该 Node 自带 npm 对隔离副本执行 `npm ci --no-audit --no-fund`、独立缓存，成功安装 95 个包；package-lock.json 重装前后与仓库一致，SHA256 `e37f0599d7853fd166b55d02eb0e4d26ceea30bc0aa01b1daef38ad6df207ce0`。复制 Bridge 源码和测试供隔离验证；没有改写仓库源码。

`compare.py` 对原、新 node_modules 的常规文件计算 SHA-256，排除 npm 生成的 `.bin/` 包装文件与 `.package-lock.json`；双方各 6587 文件，内容差异 0、仅旧 0、仅新 0。完整结果 `work/reinstall_node_20261028/dependency_compare.json`。这排除比较范围内当前磁盘文件的差异，不证明两份运行期间的内存状态相同或证明硬件健康。

独立副本执行 `node --jitless --test tests/exploration.test.js tests/resource_sites.test.js tests/world_observation.test.js`，11 项通过，采用现有测试替身，并非 Minecraft 实机验证。

本次重装得到与旧环境相同的 Node 和依赖文件，没有发现原生崩溃原因或修复证据；不在 runtime_blocked 下重复相同条件的 Minecraft 测试。保留旧环境、隔离环境、转储与世界。

## 用户明确要求重装后测试

用户随后要求“测试”，明确要求对重装副本进行实机验证。正式运行器新增仅隔离模式可用的 `--bridge-entry`，限制入口为 `work/` 下存在的文件，并将入口写入结果；默认仍为仓库 Bridge。`tests/test_run_stage_isolation.py` 共 35 项通过。

本轮使用新安装 Node 24.22.1 `--jitless` 和 `work/reinstall_node_20261028/bridge/minecraft_bridge.js`，由其相邻 node_modules 解析新装依赖；源服务器为 `work/mc/terra_seed_20261028`，复制到 `work/mc/reinstall_s0_s4_20261028_2155`，游戏/RCON/Studio端口 26800/26801/8879。Bridge 进程 PID3740，ProcDump 已附加且未自动重启。结果证实实际使用了重装 Node 和 Bridge 入口。

S0 73.0秒、S1 158.5秒通过；S2 34.5秒时 Bridge 于22:00:48 以 0xC0000005退出，S2未通过、S3/S4未开始。进程运行310.926秒、此轮合计266秒。新安装未阻止本次原生退出，不因此断言重装对所有运行都无影响。

ProcDump 产生 `work/refactor_validation_20261027/reinstall_2155/node.exe_261028_220048.dmp`，SHA256 `e9bec0906584fe685ede26d19113ccc31e3693fa6a14b0270582e79c44970b92`。同版本 PDB 的 CDB 输出显示进程尝试执行地址0而触发 0xC0000005，栈包含 `Builtins_InterpreterEntryTrampoline`，并不能据此判断是谁造成空地址跳转。本轮与前次访问冲突的位置不同，不证明是两个独立根因。dump 可能包含内存，仅保留在 work。

Paper 22:00:51 保存全部维度，cleanup_errors 为空，owned进程退出且端口无监听。结果 `work/refactor_validation_20261027/reinstall_2155/result.json`，运行 marker 已更新为非活动、清理完成、runtime_blocked=true。
