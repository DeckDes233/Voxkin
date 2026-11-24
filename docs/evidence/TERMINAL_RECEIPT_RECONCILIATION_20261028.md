# 终态动作回执与新鲜观察（2026-10-28）

## 缺口

`GoalSupervisor` 恢复 pending action 时，`unknown` 回执已有 session/revision 新鲜度检查；但已知 `succeeded`、`failed`、`blocked` 等终态回执此前会直接使用当前观察。若观察仍是动作执行中或更早的状态，监督器可能错误地认为效果未达成，清除 pending 并计入方法失败。另一个跨 session 场景中，终态回执可以来自新 session，而当前缓存仍是旧 session，不能用旧状态验收新回执。

## 修复

- 恢复时先等待相对于原动作基线可用的观察；协议模式下，已知终态回执也须以终态观察和当前 ready/alive/idle 状态对账，满足 session/revision 顺序后才能清除 pending、重规划或计费。
- 回执含 terminal observation 时，同 session 当前 revision 必须至少达到回执 revision；回执来自原 session、当前观察来自新 session 的合法重连可继续，反向的旧 session 观察不能验收新 session 回执。
- 回执没有 terminal observation 时，同 session 保存收到回执时的 revision 并等待后续 revision；`dead`/`disconnected` 的 ready/alive/idle 新 session 可继续。排队、运行中的动作仍保持 pending。未启动且可重试的 stale-observation 准入拒绝继续走原有准入处理。
- 等待期间保留 deadline、动作数、方法预算、传输预算及 pending 的原有信息；为等待无 observation 的终态回执，pending 可以增加 receipt baseline 元数据。没有有效协议元数据且 `require_protocol=False` 的旧调用保留兼容；生产 `RunManager` 要求协议状态。后续对空 `session_id` 和 `revision=None` 占位字段的兼容修复见 [旧调用终态回执兼容](LEGACY_TERMINAL_RECONCILIATION_20261028.md)。

## 证据与边界

Luna 6 max 完成补丁和定向回归，root 使用 Python 3.10 独立运行：

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
./.venv/Scripts/python.exe -B -m pytest -p pytest_asyncio.plugin tests/test_goal_supervisor.py tests/test_run_manager.py tests/test_s4_goal_supervisor.py tests/test_s5_portal_recovery.py -q --disable-warnings --tb=short
```

结果 `108 passed in 13.05s`。禁用自动插件加载是因为本机第三方 langsmith pytest 插件在 Python 3.10 收集前触发 Pydantic `ModelField` 错误；`pytest_asyncio` 已显式启用。覆盖旧观察、执行中的观察、同 session 终态、新 session、无 observation 时的二次恢复，以及 dead/disconnected 和跨 session 次序。

这是生产代码修复与自动化回归，不是 Minecraft 实机通过。当前最新有效来源仍是 `user_paper_02` 的保存世界和 task 7；Node Bridge `0xC0000005` 根因未明，`runtime_blocked=true` 维持。未启动 Paper、Bridge 或 WSL，未改写世界、数据库或 task 7 的 deadline、预算与 pending。
