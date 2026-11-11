# 旧调用终态回执兼容（2026-10-28）

## 缺口与修复

上一轮为真实 Bridge 动作增加终态观察的 session/revision 校验后，兼容模式下的一个旧调用会被误判为协议调用。`_execute_step` 即使在没有协议状态的旧调用中也会保存 `session_id=""` 和 `revision=None`；原判断只检查键是否存在，随后要求不存在的 session/revision 基线，导致已有终态回执仍停在等待。

Luna 6 max 补充旧调用回归，先复现该失败，再将判断改为识别有实际值的 session/revision 或明确的 ready 状态。`require_protocol=True` 仍直接要求新鲜协议观察；生产 `RunManager` 使用该模式，本次兼容修复不会放宽 task 7 的对账要求。

## 同轮 S3 合成合同核对

曾有候选修改误将 `craft.count` 当成配方执行次数；root 复核 `bridge/minecraft_bridge.js::pickRecipe` 后确认它是期望产出数量，Bridge 内部按 `ceil(count / 配方产量)` 算执行次数。错误候选已撤回，S3 策略保持原义。新增回归覆盖缺 4、缺 5 块木板和缺 3 根木棍时传递的期望产出数量；这不是实机验收。

## 验证与仍需处理的边界

root 以 Python 3.10、禁用外部插件自动加载并显式启用 `pytest_asyncio`，运行 `tests/test_goal_supervisor.py`、`tests/test_run_manager.py`、`tests/test_s4_goal_supervisor.py`、`tests/test_s5_portal_recovery.py` 和 `tests/test_s3_resource_regression.py`：`111 passed in 14.03s`。本轮没有启动 Minecraft、Paper、Bridge 或 WSL；`runtime_blocked=true` 仍有效。

另查明 `RunManager.resume` 为兼容旧任务，允许没有 `goal_state` 的旧任务恢复；现有任务表没有记录能区分真正旧任务与 schema 2 状态丢失的标识。直接禁止该路径会破坏既有兼容测试，而补建状态会使用默认预算。本轮没有改这项兼容行为；自动化恢复仍须按活动 marker、manifest 与数据库交叉核对，状态缺失或冲突时停止。
