# 水中自救修复与验证（2026-10-28）

## Wiki 机制与版本核对

目标为 Java 1.21.1。按 [Minecraft Wiki Water](https://minecraft.wiki/w/Water)，普通氧气约维持 15 秒，耗尽后每秒损失 2 HP；跳跃用于上浮，潜行加快下沉。[Swimming](https://minecraft.wiki/w/Swimming) 说明在水面游泳也可呼吸，不要求完全上岸。[Bubble Column](https://minecraft.wiki/w/Bubble_Column) 说明气泡柱能恢复氧气；岩浆块气泡柱同时下拉，不能等同安全陆地。[Aqua Affinity](https://minecraft.wiki/w/Aqua_Affinity) 说明无附魔且悬浮的水下挖掘可达正常耗时的 25 倍，因此不采用低氧时默认挖铁顶棚的方案。

[Yarn 1.21.1 Entity](https://maven.fabricmc.net/docs/yarn-1.21.1+build.3/net/minecraft/entity/Entity.html) 确认按眼部浸水扣除 air。项目 Mineflayer `entities.js` 将 `air_supply / 15` 四舍五入作为 `oxygenLevel`，满值 20；阈值 8 约表示 6 秒余量。实际 `lookAt` 使用 `atan2(-delta.x,-delta.z)`，原游岸逻辑的 Z 轴符号相反。原岸边判断还将无碰撞的水误当空气，且固定前进/跳跃，没有检查顶棚与实际位移。

## 最终整合与真实物理回放

主线程只读解析运行后保存世界：死亡位置上方 `(21,58,63)` 为铁矿石，北侧 `(21,58,62)` 和 `(21,59,62)` 为空气，下方有水，左右存在向下气泡柱。局部数据保存为 `bridge/tests/fixtures/drowning_terrain.json`；这是运行后地形，不是死亡前逐帧快照，不能据此确定入水路线。

`water_escape_physics.test.js` 使用实际安装的 Prismarine physics 对该地形计算移动、水流和碰撞；氧气、伤害与时间由确定性替身模拟。初版路线在此回放中仍溺死：距出口 0.45 格便停止前进，身体还压在铁矿顶棚下，水流又把角色推回。到达阈值收紧至 0.12 格后，角色可侧移离开遮挡，上浮并恢复氧气。这是修复开发中发现的问题，不应误称旧实机逻辑唯一死因。

最终共享实现用于本地低氧反射、`swim_escape`、`swim_out`，以绝对坐标记录路线，仅检查已加载的四邻可通行区域，搜索半径最多 8 格。未知区块和有碰撞的含水方块不能穿越；缺失氧气读数不会判成功；取消、死亡、超时和正常完成都会释放全部移动输入。气泡柱作为可补氧水域识别，但不作为安全退出终点，需继续离开至空气。恢复前仅允许停止、只读观察、聊天及两个自救技能，避免其他任务抢占呼吸恢复。

最终主线程 Windows 验证：Bridge 全量 **281 passed**，Python 清单、工具、仲裁与观察相关 **57 passed**（`--assert=plain`），`git diff --check` 通过。日志为 `work/water_escape_bridge_final.log` 与 `work/water_escape_python.log`；没有修复后实机复测。这是有界局部救援，不是完整三维水下导航，也不证明宿主原生崩溃已解决。

## 触发证据

Terra S0–S4 隔离实测中，Bridge 日志于 `2026-10-28T07:21:56.793Z` 报告 oxygen=8；`07:22:02.822Z` 已到 oxygen=0。受伤日志在 `07:22:03` 至 `07:22:12` 持续记录同一位置 `(21.3, 56.2, 63.7)`，Paper 于 `07:22:12.665Z` 记录死亡。此前 `leave_shelter` 未能确认墙外位置。运行没有证明角色如何进入水中，也没有单独确认当时自救逻辑为何未能脱困；原始记录见 [Terra 实测](S0_S4_TERRA_WINDOWS_20261028.md)。

## 当前工作树改动

Bridge 将手动上浮和找岸逻辑收敛到 `bridge/water_escape.js::escapeWater`：只检查已加载且可通行的局部方块，以有界水平路线绕开顶棚，并且只有眼部位于可呼吸方块且氧气恢复到 19 以上才报告成功。退出时总会释放移动控制键。Bridge 本地低氧 reflex 与 `swim_out` 共用这一路径；低氧触发后会保持自救状态，直到新鲜状态确认呼吸恢复。恢复前的动作准入只放行观察、停止、自救及状态查询动作，阻止挖掘、移动和睡眠动作继续把角色带入危险。

机制核对依据 Minecraft Wiki 的 Java 版条目：游泳时按 jump 会上浮；空气及 cave air 可恢复呼吸；氧气耗尽后每秒受到 2 HP 溺水伤害。[Swimming](https://minecraft.wiki/w/Swim)、[Water](https://minecraft.wiki/w/Water)、[Air](https://minecraft.wiki/w/Void_Air)。项目使用 Java Edition 1.21.1；其版本页列出的修复没有涉及游泳机制。[Java Edition 1.21.1](https://minecraft.wiki/w/Java_Edition_1.21.1)。

## 离线验证

使用仓库内 Node.js v24.22.1 执行 `node --test tests/water_escape.test.js tests/survival.test.js`（工作目录 `bridge`）：**23 passed，0 failed**，耗时 116 ms。覆盖上浮、顶棚侧移、未知方块与含水碰撞方块排除、气泡柱不作为呼吸恢复、取消清理、执行器低氧抢占，以及低氧未恢复前的危险动作准入限制。`node --check minecraft_bridge.js` 与 `node --check water_escape.js` 通过。

这些结果是离线 Bridge 自动化覆盖，不是 Paper/Minecraft 实机结果，也不构成 Windows 原生崩溃恢复证据。实测发生在该工作树水中自救改动之前；尚无新实机结果证明新路线能从真实危险地形脱困。

## 权威恢复状态

本次只读交叉核对中，`active_progress.json` 的 canonical source 与全部来源指针仍指向 `user_paper_20261028_02` 及其保存 manifest。51 个世界文件与 manifest 的路径、大小和 SHA-256 全部一致；世界 tree SHA-256 为 `100fffa90907bfd2e77644ade7d80e51d118a7056be63759a70e5647ff65f5f8`。`tasks.db` SHA-256 为 `9b53c33b23458bb64a01d9c957387d97e124a3a3a05445a34d44786099162d41`，SQLite `quick_check=ok`。

当前 goal 仍是 task 7 / S3：任务行 `cancelled`、目标状态 `paused_by_user`，deadline `1793134250.617673`、actions=2、attempts={}、transport recoveries=0；pending `mine_collect` `1e55e347dc3a` 仍为 `disconnected` 且未确认。没有查询动作状态、恢复任务、改预算、启动游戏或服务。marker 仍为 `runtime_blocked=true`、`runtime_active=false`、`cleanup_pending=false`，因此此次单测不改变正式来源或阶段验收状态。
