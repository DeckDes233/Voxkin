# Windows 恢复验证与换区路径修复（2026-10-28）

用户反馈不再蓝屏并要求推进 S0–S4；只读预检确认 Windows 于当日 18:32:06 +08:00 重启，运行 marker 无活动运行或待清理进程。进行一次有界验证，原生退出不自动重试。

本轮使用 `scripts/run_stage.py --continue-task 4`，从 `work/mc/terra_s3_continue_jitless_20261028` 复制到 `work/mc/recovery_s3_s4_20261028_2030`，端口 26792/26793/8875，单阶段上限 900 秒。Node 24.22.1 `--jitless`、Temurin 21.0.12.1。原任务 deadline 与预算保留；S0–S2 沿用之前已通过的同一世界进度，本轮只验证 S3 续跑与后续 S4。

新 session `90634749-1aad-445f-a673-9285fa45d2a8` 观察确认 6 个粗铁，并对旧 pending 做未知结果对账。采矿低氧抢占后实际派发了 `explore_mining_site`，随后换区途中再次低氧（oxygen=8，health=20，food=16）。Bridge PID 42244 运行 114.683 秒后以 `0xC0000005` 退出；S3 阶段运行 81.4 秒，未完成；S4 未启动。退出码只能证明原生访问冲突，不能据此认定 CPU、JavaScript 或某个依赖是根因。

结果：`work/refactor_validation_20261027/recovery_2030_result.json`。Paper 20:32:43 记录所有维度保存，结果 cleanup_errors 为空，wrapper/Bridge PID 已不存在，三个端口无监听。源世界和目标现场均保留。副本日志包含历史记录，诊断必须核对本轮时间与日志真实路径。

## 游戏机制与独立代码缺陷

先查询 [Minecraft Wiki 水](https://minecraft.wiki/w/Water) 与 [伤害/溺水](https://minecraft.wiki/w/Fire_damage) 搜索索引：普通角色在水中持续消耗空气，干燥终点不能保证水下途中的呼吸安全。这一机制适用于项目 Java 1.21.1；不引用后来版本新增 gamerule 作为本项目规则。

实际依赖 `bridge/node_modules/mineflayer-pathfinder/lib/movements.js` 的 `getMoveForward` 会在可行性筛选之后增加 liquidCost，因此 liquidCost=100 不代表禁止水路。旧换区逻辑只检查候选终点是否干燥，已证实缺少路径禁水约束；它与原生崩溃的因果关系未证实。

`bridge/skills/exploration.js` 增加临时 exclusionAreasStep，排除路径方块与上方的水、含水方块、危险或未加载空间，并关闭无限液体下落；保留既有排除规则，在 finally 恢复。不是单靠提高寻路代价。六个定向 Node 测试通过，包含水道、气泡柱、含水方块、未加载空间及参数恢复；测试使用确定性地形替身，不代表实机修复已通过。原生运行仍受阻，不重复启动相同环境。
