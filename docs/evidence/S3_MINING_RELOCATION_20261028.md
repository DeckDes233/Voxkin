# S3 局部采矿失败后的换区恢复（2026-10-28）

## 机制与已证实问题

先查 [Minecraft Wiki Iron Ore](https://minecraft.wiki/w/Iron_ore)、[挖矿教程](https://minecraft.wiki/w/Tutorial%3AMining) 和 [Water](https://minecraft.wiki/w/Water)，并核对 [Java 1.18 官方矿物生成调整](https://feedback.minecraft.net/hc/en-us/articles/4415128577293-Minecraft-Java-Edition-1-18)：Java 1.21.1 的地下采铁不要求固定在某一个洞穴，矿物分布支持更换区域寻找；水流与溺水风险支持停止危险挖掘，不代表应放弃采铁目标。Wiki 通过搜索索引读取，直接页面访问被 robots 拒绝。

上一轮 `collectionfix_s0_s4_result.json` 显示 S3 得到 8 个粗铁，最低需求 9。局部探矿在水域多次停止，`no_safe_stair` 四个候选均为水，最后 `s3_ore_route_exhausted`。旧实现用完整的局部探露额度耗尽作为终止整个目标的条件，没有新矿区恢复步骤。运行器随后 RCON 正常停服，但这只是一轮测试结束，不代表开发修复完成。

## 当前改动

- 明确被水围住时立即切换换区；其他局部探矿耗尽时也保留采铁目标并换区。
- 新 `explore_mining_site` 仅从已加载地形挑选有实心地面、干燥脚部和头部空间的落点。临时禁用挖路、搭柱与跑酷，尝试实际寻路，结束后恢复参数；处于水下先恢复呼吸。成功必须实际移动至少 16 格并处于干燥站位。
- Core 要求同 session 新鲜观察、已确认成功回执、与派发基线一致的起点和与观察一致的终点。只有确认实际换区才重开局部探矿窗口；记录旧矿区和失败候选，保留全局动作、deadline 和预算。
- 换区失败且有有效已知地表庇护所路线时，允许先返回已知地表再寻找新矿区；准入拒绝不消耗这次恢复机会。
- 新技能进入模型工具清单供 G2 调用，坐标数组有完整 items schema。G1 自主通关和 G2 玩家指令各自验收，定义已记录于 AGENTS、README 和 MILESTONE。

## 离线验证

Bridge 全量 288 项通过，日志 `work/s3_relocation_bridge.log`；覆盖实际位移条件、假到达、含水与危险地面、取消、参数恢复和失败坐标回传。Python Core 相关 104 项通过，后续准入拒绝恢复机会回归也通过；模型工具及清单 38 项通过，日志 `work/s3_relocation_schemas.log`。世界与派发测试使用确定性替身，不能代替实机地形验证。

主代理组合 Python 回归在 pytest 收集时再次发生原生 access violation，栈位于 pathlib / pytest，日志 `work/s3_relocation_python.log`。随后独立清单/工具回归正常通过，不能据此宣称宿主原生崩溃已修复。`git diff --check` 通过。

实机使用原种子 20261022 的新隔离世界，不替换地形规避上一轮问题；运行结果另行记录。

## 首轮实机暴露的安全抢占衔接问题

[换区首轮实测](S0_S4_RELOCATION_WINDOWS_20261028.md) 中 S0–S2 通过，S3 四次低氧避险后仍重复派发同一 `raw8:region0:route0` 采铁目标，最后 `preemption_budget`。角色未死亡，但新换区步骤没有触发：安全中断恢复路径直接按库存重选，丢失了危险原因及位置，没有进入矿点恢复分支。

后续修复把实际 `safety_interruption` 事件、危险坐标和安全动作 ID 从 LocalReflexScheduler 带到被抢占动作的终态回执与状态查询记录。Core 在同会话新鲜观察确认安全执行结束后记录危险点，先离开该区域再恢复生产；保留安全抢占计数，不将其冒充物理失败。Bridge 全量 288 项通过，日志 `work/s3_water_replan_bridge.log`。这部分仍需下一轮实机验证。

最终补齐换区后的危险点排除：`s3_mining_hazards` 只保存确证低氧点，后续 `mine_collect.avoid_positions` 排除其水平八格范围，避免换位后 64 格搜索重新选回旧矿点；探索失败候选使用另一账本。采矿、探矿和换区途中被低氧中断都走恢复；紧急低血量、饥饿与附近危险仍优先处理。Core 相关 111 项、清单/工具 38 项、Bridge 全量 289 项通过，最后日志为 `work/s3_water_replan_schemas.log` 和 `work/s3_water_replan_bridge_final.log`。

## 第二轮的运行时异常调查

[第二轮实测](S0_S4_WATERREPLAN_WINDOWS_20261028.md) 通过 S0–S2，S3 期间 Bridge 抛出 `TypeError: Cannot create property 'metadata' on number '828'` 并以 code 1 退出，尚未触发新的低氧恢复链。当前没有证据证明这个 JS 异常与此前 native access violation 同源。

检查实际依赖：`prismarine-block` 1.23.0 的 `index.js:111` 是 class 构造函数内的 `this.metadata = metadata ?? 0`；调用方 `fromStateId` 使用 `new Block(...)`。本地文件与 npm 发布 tarball 中的文件完全相同，SHA256 `f4e589895cbe1958bf5bdded45294e126d7abdd4e914fa642f4522db3886e5b6`。没有在项目代码中找到修改 Block.prototype 的操作。

同一 Windows Node 24.22.1 对 Java 1.21.1 的全部 26684 个状态构造八轮（213472 次）正常；另以 `--jitless` 构造 200000 次正常。这些离线检查没有复现异常，不能证明根因或运行时已恢复。依据 [Node CLI 对 jitless 的定义](https://nodejs.org/download/release/v24.17.0/docs/api/cli.html)，后续可在保留现场的有界续测中关闭 JIT 作诊断，不能把它写成已验证修复，也不修改第三方构造函数来吞掉错误。

## 保留现场续测

正式运行器增加 `--continue-task ID`，必须搭配新的隔离副本。在来源停服、无 WAL、数据库检查通过后复制世界和任务数据库，核对前后文件摘要。不调用 `reset_world` 或世界规则设置；通过 `/api/run/resume` 恢复已有 S3，并在完成后进入 S4。旧目标 deadline、计数和 pending action 保留，由监督器使用新会话观察对账。该模式是继承现场调试，不能作为新世界零干预 G1 证据。

隔离/续跑测试 34 项通过；其中一次测试进程在导入 Python socket 时出现 `'frame' object is not callable`，随后单次同命令正常通过。这仍属于待调查的宿主运行异常，不归因于已定位的游戏规划缺陷。

实际续跑成功复制现场并对账原 pending，来源摘要不变、原 deadline 不变、动作计数 4→5。随后 Node 24.22.1 `--jitless` 仍以 `0x80000003` 退出，stderr 有 `Invalid bytecode` 和 V8 `std::numeric_limits<int>::max() >= length_` 致命断言。新采矿动作没有终态回执，保留供下次新鲜观察对账；关闭 JIT 没有证明有效。详见 [续跑记录](S3_CONTINUE_JITLESS_WINDOWS_20261028.md)。

只读查询 Windows System 日志发现：2026-10-27 02:54:41 和 03:06:36（Asia/Shanghai），WHEA-Logger Event 19 报告已更正的处理器核心 `Internal parity error`，APIC ID 分别 16、25；03:27:32 另有 Event 2 已更正硬件错误。摘要保留在 `work/refactor_validation_20261027/whea_summary_20261028.json`。CPU 为 i9-14900HX，机器为 ASUS TUF Gaming F16 FX607JVR。记录证明系统曾报告硬件纠错，尚不能将每一次 JS、Python 或 native 异常归为同一个硬件原因，也不能据此判定具体部件故障。
