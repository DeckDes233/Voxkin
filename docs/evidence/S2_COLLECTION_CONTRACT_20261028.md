# S2 采集数量与验收修复（2026-10-28）

## 游戏记录与机制核对

上一轮 Windows 实机 S2 被 `budget_method_attempts` 阻塞，最终泥土库存 64。证据保留在 `work/refactor_validation_20261027/waterfix_s0_s4_result.json`，以及 `work/mc/terra_s0_s4_waterfix_20261028` 的数据库和 Bridge 日志。

第二次搭建时，结构仍缺 35 格，背包有泥土 15、圆石 2、橡木板 2、橡木原木 1，共 20 个可用建材，实际还需 15 个。规划器却直接把结构缺格数 35 当成新增采集量，把泥土目标设为 50。后续目标继续涨到 90、104、104。Bridge 将总库存目标截到 64，报告采集成功；Core 按原目标验收，分别仍缺 26、40、40，于是累计三次方法失败后停止。

Minecraft Wiki 的 [Dirt](https://minecraft.wiki/w/Dirt) 标明泥土可堆叠 64，[Inventory](https://minecraft.wiki/w/Inventory) 说明物品在多个物品栏格子中堆叠。核对 Java 1.21.1：64 是单堆上限，不是背包泥土总量上限。本次浏览通过搜索索引核对；直接打开 Wiki 页面被 robots 拒绝。

## 修复

`goal_methods.py` 在结构缺格数中扣除背包可用建材，再把真正的缺口加到当前泥土库存。上述场景目标改为泥土总量 30；采集达到后进入搭建，不再随库存增加目标。

`gather.js` 的 `mine_collect.count` 按背包总库存解释，支持跨堆采集，并明确校验请求范围，不再静默截成 64。资源储备策略也移除单堆截断。验收仍核对实际观察，不通过放宽 Core 条件、重置预算或伪造成功解决问题。

第一次搭建报告内部方块占位。代码已经在选址、抵达和最终验收检查内部空间；目前证据不足以确认占位方块或施工时变化原因，本次未修改选址逻辑。

## 验证

回归覆盖部分结构扣减混合建材库存、真实 GoalSupervisor 完成采集对账后进入搭建，以及 Bridge 跨过 64 堆叠边界继续采集。测试中的世界与派发使用确定性替身；实机结果单独记录。

Python 相关回归 124 项通过；Bridge 定向 41 项通过后，主代理运行全部 `bridge/tests/*.test.js`，283 项通过、0 失败，日志 `work/s2_contract_bridge_final.log`。`git diff --check` 通过。`minimum_count` 超出 `count` 时明确拒绝，有限搜索后低于硬门槛时仍报失败。

Python 命令：`.venv\Scripts\python.exe -m pytest tests/test_resource_policy.py tests/test_goal_supervisor.py tests/test_skill_manifest.py tests/test_run_stage_isolation.py -q --assert=plain`，结果由工具输出记录。沿用关闭第三方插件自动加载、显式加载 `pytest_asyncio.plugin` 的验证环境。
