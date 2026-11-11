# S0–S4 Windows 运行环境复核（2026-10-28）

## 结论

本轮按 `AGENTS.md` 先读取 `work/refactor_validation_20261027/active_progress.json`，并只读检查当前进程、目标端口和现有 Windows 运行证据。`cleanup_pending=false`、`runtime_active=false`、`owner_active=false`，但 `runtime_blocked=true` 仍有效。没有新的、可验证的 Windows 环境恢复证据，因此没有启动 S0–S4，也没有派发游戏动作。

## 当前环境快照

- 查询时，Paper/Java、Voxkin Studio、Bridge 和本地测试 LLM 均未运行；`25565`、`26768`、`26778`、`8868`、`8799` 均无监听。
- 当前快照中的其他 Node、Python 与 PowerShell 进程属于 Codex 或其他工具，不是本次 Minecraft 运行。本轮没有停止任何进程。
- 端口空闲和旧运行清理完成只说明没有遗留运行占用，不能证明原生崩溃已修复。

## 现存运行证据

- 最新 Windows Paper 实测 `user_paper_20261028_02` 在 S3 的 `mine_collect` 期间，Node v24.22.1 Bridge 以 `0xC0000005` 退出；动作 `1e55e347dc3a` 状态为 `disconnected`，`receipt_confirmed=false`，结果未知。S3 未完成，S4–S6 未运行。Paper 已正常保存并退出。详见 [Paper S3 隔离实测](PAPER_S3_20261028.md) 和 [运行结果](../../work/refactor_validation_20261027/user_paper_20261028_02/s3_s6_result.json)。
- 活动 marker 保留 task 7（S3）：任务为 `paused_by_user`，deadline 已过期；未确认的 `mine_collect` 仍需由正式恢复流程通过新鲜观察对账。不得重置预算或把它当作成功/失败回执。旧 `launch_profile.py` 仍硬编码检查 R29 task 6，不能直接拿来续跑 task 7。
- 原生调查没有确定根因，也没有 Node dump。独立 `pwsh.exe` 与 `git.exe` 曾出现 `0xC0000005`，但这不足以断言共同根因或认定硬件故障。详见 [Bridge 访问违规调查](BRIDGE_ACCESS_VIOLATION_20261028.md) 和 [Windows 原生崩溃只读分析](WINDOWS_NATIVE_ANALYSIS_20261027.md)。
- Windows 离线回归记录为 Python 507 passed、Bridge 273 passed；Python 曾在 pytest AST 断言重写阶段发生 access violation，随后使用 `--assert=plain` 完成离线验证。它们是代码测试，不是 Minecraft 实机恢复证据，也没有解决原生崩溃归因。详见 [资源策略验证记录](RESOURCE_VILLAGE_GOLEM_20261028.md)。
- 既有用户服务器 S0–S4 测试在 S0 阻塞，S1–S4 未运行；之后 Fabric 客户端发生崩溃。该记录未提供新的环境恢复证据。详见 [用户本机世界 S0–S4 测试](USER_SERVER_S0_S4_20261027.md)。

## 恢复条件

恢复实机验证前，需先有新的、可核验的 Windows 环境恢复证据。现有 Windows 原生分析建议检查宿主 CPU/内存稳定性，并保留诊断结果；后续获准的隔离实机运行还应预备针对 owned Node 进程的 native dump 捕获，以便分析真实异常。恢复 task 7 前，须沿用唯一有效存档与原预算，通过正式 Supervisor 对未确认动作做新鲜观察对账；启动配置也须适配当前 source manifest 和 task 7。满足这些条件后再安排一次有界 Windows 验证。
