# MindCraft 对照与等待动作抢占（2026-10-28）

用户要求直接复用 MindCraft 的相关方案。本次核对本地 `work/reference/mindcraft`，提交 `f6a9556cf756e6bd88a75cc2fa0d5aed7599b101`，以及 [MindCraft 仓库](https://github.com/mindcraft-bots/mindcraft)和上游 [issue #846](https://github.com/mindcraft-bots/mindcraft/issues/846)。MindCraft 使用 MIT License，版权声明为 Copyright (c) 2024 Kolby Nottingham。以下是行为对照与独立修复；本次没有复制 MindCraft 源代码。

MindCraft `src/process/agent_process.js` 由父进程启动 bot 子进程，符合条件的非正常退出可以重启，过早退出不会重启。`src/agent/action_manager.js` 用协作式 interrupt 中断动作，若10秒不结束则结束 agent 进程；上游 issue #846 报告不可达寻路 Promise 不会因仅设置标志而停止。它可作为进程隔离与恢复的参考，不能证明其修复 Node/V8 原生访问冲突；自动循环重启也不符合本项目对未确认动作和原生故障的约束。

本地上游 `patches/protodef+1.19.0.patch` 只注释部分日志，不是 `PartialReadError` 修复。`mineflayer-pathfinder+2.4.5.patch` 含主动改写客户端世界缓存的变更，不能未经世界验证直接覆盖 Voxkin 的实际方块验收。上游 Mineflayer 4.33.0 补丁也不能直接套用到本项目锁定的 4.39.0；需按对应依赖和 MC 版本核验。

结合用户提供的 22:21–22:22 事件，发现 Voxkin `wait_for_day` 一直持有执行权到白天或超时，缺少协作中断检查：22:21:31 安全避险抢占，22:21:50 才返回 preempted，随后才开始反击。Minecraft Wiki [骷髅](https://minecraft.wiki/w/Skeletons)记录其是远程敌对生物，[昼夜循环](https://minecraft.wiki/w/Daylight_cycle)记录白天需要随游戏时间推进；等待白天不能阻塞即时安全处理。Wiki 搜索索引用于核对机制；实际此次发生的动作和时间以本地日志为准。

本次修改 `bridge/skills/survival.js`，在等待动作入口、每轮和超时后检查 `ctx.interrupted`。测试使用真实 `ExecutionController`、`LocalReflexScheduler` 和可控 sleep，验证抢占后下一次等待返回时让出执行权，即使同时天亮也保留 preempted 回执。Node22 下 `sleep_safe.test.js`、`local_reflex.test.js`、`execution_controller.test.js` 共20项通过；其中世界与时间是确定性替身，不是实机验收。这解决已证实的安全抢占延迟，不证明能够解决 V8 崩溃。

用户 25565 局域网世界仍在，真实 Bridge PID45792 已退出，Studio 记录22:56:10 WebSocket关闭但无该进程可信退出码；不能据此判定根因。Core仍运行、其目标 task5为 disconnected，marker仍标记活动和待清理；修改后的 Bridge 尚未在真实世界加载或复测。

## 技能与算法盘点（追加）

三个只读审查分别对照 MindCraft 生存采集与战斗、玩家互动与移动、技能命令清单。盘点覆盖 `src/agent/commands/actions.js` 的 42 项动作命令、`queries.js` 的 14 项查询，以及 `library/skills.js`、`library/world.js`、`modes.js`、`action_manager.js` 的主要实现；没有逐项审计所有 task 数据和依赖补丁。源码位置均相对于本地参考提交。

| 可借鉴的算法 | MindCraft 实现 | Voxkin 适配要点 |
| --- | --- | --- |
| 卡住识别 | `src/agent/modes.js:91` 按位置和挖掘目标观察长期无进展 | 接入现有动作进度、低氧脱险与取消协议；等待和慢速挖掘不能简单当成卡死 |
| 跟随期间压制闲时动作 | `src/agent/library/skills.js:1331` 根据与玩家的距离暂停部分自动模式 | 保留实时目标重新读取和玩家取消，让低优先工作经现有执行器让路 |
| 合成前计算配方与材料上限 | `src/agent/library/skills.js:36` 先筛配方再临时放工作台 | 对照已有合成、窗口同步和物品核验，借鉴可做数量计算，不替换 1.21.1 的窗口处理 |
| 村民交易核验 | `src/agent/library/skills.js:1748` 查看报价、次数和库存 | 可补 G2 可交互交易；须核对 1.21.1 实际交易与元数据，使用窗口回执 |
| 查询材料计划 | `src/agent/commands/queries.js:270` 给出合成计划 | 可改善 G2 对材料缺口和进度的解释，不代替实际动作验收 |
| 子进程监护 | `src/process/agent_process.js:26` 跟踪退出并有条件重启 | 快速启动器新增独立监护，捕获退出码；有活动阻塞标记或原生异常时不自动重复同条件，Core 负责动作对账 |

MineCraft 的普通近战/局部搜索不覆盖 Voxkin 已有的群怪威胁评估、氧气保护和换区验收；其生成并运行任意 JS 的 `coder.js` 也不应替代 Voxkin 的结构化技能接口。独立审查结论是可借鉴局部算法，并非这些功能已被实机验证或整套上游技能已移植。
