# S3 空桶验收修正（2026-10-27）

## 变更

M5/S3 正式目标要求铁镐、铁剑、盾和空桶。此前 `inventory_count(..., "bucket")` 把 `bucket`、`water_bucket` 和 `lava_bucket` 相加，导致已有装液桶时 `GOALS[S3]` 可能误报完成，也可能让 S3 资源策略跳过空桶合成。

现在 `bucket` 只计数观察库存中的精确 `bucket` 项。验收与 S3 资源策略共用该语义；没有改变 S3 的其他条件或 S0–S6 最终验收标准。

## 自动化回归

命令：

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
.\.venv\Scripts\python.exe -B -m pytest -p pytest_asyncio.plugin --assert=plain --noconftest tests\test_goal_conditions.py -q --tb=short
```

结果：12 passed，0.05 秒，exit 0。回归覆盖仅有水桶、仅有岩浆桶、空桶，以及空桶与装液桶并存时的 S3 验收结果。这是单元测试覆盖，不是 Minecraft 实机通过。

## 运行边界

- 恢复来源仍为 `work/mc/refactor_validation_20261027_r29_continue_s3_s6_node24`；R29 manifest 的 51 个 world 文件当前逐项 hash 均匹配，source DB 实际 SHA-256 与 marker/manifest 一致。
- task 6 仍为 S3 `paused_by_user`，原 deadline、actions/history 与 pending goto `9d18f0f32312` 保留；本轮未对该动作做 fresh observation 对账、未派发，也未 resume 任务。
- owner inactive，`cleanup_pending=false`，`runtime_active=false`，`runtime_blocked=true`。R30 retry4 的 bootstrap-only 证据仍为失败；没有启动 Bridge 测试、Paper、Studio 或 Minecraft。
- 本项未解决 S3 是否还需在阶段末额外持有 9 个铁锭、以及时限/死亡/重复成功率如何与 `GOALS[S3]` 对齐的问题；这些正式要求没有被降低。
