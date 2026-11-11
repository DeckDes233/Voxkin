# 用户本机世界 S0–S4 测试（2026-10-27）

## 测试范围

用户启动了本机 Java 1.21.1 世界，Bridge 以离线角色 `Voxkin` 接入 `127.0.0.1:25565`，Core 与 Bridge 使用隔离工作目录。按用户要求从 S0 顺序测试至 S4；只有上一阶段完成才进入下一阶段。本次使用用户提供的世界，不能作为 clean vanilla G1 证据。测试方没有注入物品、修改时间或地形。

## 结果

| 尝试 | 目标 | 结果 | 可验证证据 |
| --- | --- | --- | --- |
| task 1 | S0，夜间开始 | blocked：`preemption_budget` | 安全动作多次抢占采木；Bridge 日志记录 3 次死亡，曾拾取 2 根橡木，后续重生观察的背包为空。完整状态为 `work/user_server_connection_20261027_191116/s0_attempt1_final.json`。 |
| task 2 | S0，白天独立重试 | blocked：`budget_method_attempts` | 当前加载区域内的 64 格搜索未找到 `oak_log`；3 次采集尝试后用尽方法预算。完整状态为 `work/user_server_connection_20261027_191116/s0_attempt2_final.json`。 |
| — | S1–S4 | 未运行 | S0 的工作台与木镐条件没有完成，未通过前置阶段。 |

两次尝试分别创建任务；task 1 的预算与历史没有被清零。日志中的目标橡木位置和两根掉落物属于第一次运行的观察，不证明当前出生点 64 格范围没有任何树，或第一次死亡后的掉落物已被恢复。用户玩家在同一世界中，不能据本次记录声称零人工干预。

S0 当前第一步固定采集 `oak_log`，半径为 64；当前重试在搜索失败后重复相同方法，没有观察到扩展范围或探索路径。此结果可用于审查资源不足时的阶段策略；不能据此放宽 S0 验收、注入资源，或将 S1–S4 记为已测。

## 保存的状态

- 会话初始快照：`work/user_server_connection_20261027_191116/s0_s4_session_start.json`。
- Bridge 日志：`work/user_server_connection_20261027_191116/bridge.out.log`。
- Core 目标数据库：`work/user_server_connection_20261027_191116/data/tasks.db`。
- 两次 S0 目标均已停止；原测试的 Bridge、临时 Core 和测试模型进程已于 2026-10-28 按用户指示核实身份后清理。用户自有服务器进程不属于测试进程，未由本项目清理。
- 此次 Windows 连接没有复现 R29/R31 的原生退出，但不证明原根因已解决；活动 marker 保留此前 `runtime_blocked=true`。
# 19:36 客户端崩溃补充

用户的 1.21.1 Fabric 客户端在 19:36:09 的渲染线程报告 `Rendering entity in world`；崩溃报告指出正在渲染蝙蝠，异常为 `IllegalStateException: stream has already been operated upon or closed`。堆栈未直接指向 Voxkin 音频代码，具体成因尚未确认。内置单人服务器随后停止；客户端日志记录保存玩家、世界及所有维度区块完成。原始报告位于用户版本目录下 `crash-reports/crash-2026-10-27_19.36.11-client.txt`。

崩溃时 S0 第二次尝试已阻塞，新的资源探索代码尚未加载到正在运行的 Bridge，因此本次崩溃不能作为新代码的运行结果。不得在没有新的环境恢复证据时重复实机运行。

后续代码变更为方块采集以及水源、岩浆源查找增加有界移动和重新扫描。动物狩猎与剪羊沿用原有的有界路线；S3/S4 的动态策略与长距离搜索仍需实机验证。Windows Node 24.22.1 下 Bridge 全部 219 个测试通过，测试使用替身，不代表 Minecraft 实机结果。
