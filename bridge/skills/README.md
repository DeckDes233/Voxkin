# 技能分类与模块约定

这份文档约束 `bridge/skills/` 的拆分方式。目标是把 MindCraft 一类技能按“玩家会做什么”归类，再按“执行时需要什么逻辑”细分，最后做成可插拔模块，而不是继续把动作堆进 `minecraft_bridge.js`。

## 两个维度

**按用途分三层**

| 层 | 定义 | 例子 |
| --- | --- | --- |
| 基础类 | 任何时刻都可能用到，单个动作很短 | 感知、移动、吃东西、穿装备、换工具 |
| 实用类 | 完成一件日常事，通常几步组合 | 挖一组木头、打一只怪、合成木镐、存箱子 |
| 专精类 | 有目标、有前置条件、需要编排 | 建小屋、跑图找村庄、下界、末地通关 |

**按执行逻辑分六种**

| 类型 | 含义 | 是否需要 pathfinder | 典型超时 |
| --- | --- | --- | --- |
| `sense` | 只读查询，不改世界 | 否 | 1s |
| `act` | 立即改变世界 | 否 | 10s |
| `path` | 以移动为主 | 是 | 60s |
| `wait` | 等待条件成立或冷却 | 可能 | 30s |
| `voice` | 游戏内说话或 TTS | 否 | 5s |
| `plan` | 多步任务编排，调用其它技能 | 可能 | 300s |

## 分类表

### 基础类

| 技能 | 类型 | 说明 |
| --- | --- | --- |
| `observe` | sense | 坐标、朝向、维度、血量、饥饿、时间、天气、附近玩家 |
| `inventory` | sense | 背包、装备槽、手持物、工具耐久 |
| `nearby_blocks` | sense | 指定方块或矿物，带距离与坐标 |
| `nearby_entities` | sense | 玩家、敌对、掉落物，带距离 |
| `look_at` | act | 转向玩家或坐标 |
| `goto` | path | 走到坐标，分段处理远距离 |
| `goto_block` | path | 走到最近的目标方块 |
| `follow_player` | path | 持续跟随，带迟滞与走跑切换 |
| `come_to_player` | path | 一次性走到玩家附近 |
| `stop` | act | 停止移动、跟随、闲逛 |
| `wander` | path | 空闲时在附近走动 |
| `retreat` | path | 远离威胁，12 格 |
| `eat` | act | 饥饿或低血时吃最优食物 |
| `equip_armor` | act | 自动穿最好的护甲 |
| `equip_tool` | act | 按目标方块换镐/斧/锹/剑 |
| `sleep` | wait | 夜晚找床睡觉 |
| `say` | voice | 游戏内聊天或 TTS |
| `wait` | wait | 显式等待 |

### 实用类

| 技能 | 类型 | 说明 |
| --- | --- | --- |
| `collect_blocks` | path | 找方块、走过去、挖、捡掉落 |
| `break_block` | act | 挖指定坐标或最近的目标方块 |
| `pickup_items` | path | 走到掉落物旁边 |
| `dig_down` | path | 向下挖安全竖井 |
| `strip_mine` | plan | 主巷道加分支的挖矿 |
| `attack_nearest` | act | 攻击最近敌对，带接近与控距 |
| `defend` | plan | 受击反击或保护玩家 |
| `kite` | plan | 保持距离、绕圈、等攻击冷却 |
| `flee` | path | 低血逃到安全点 |
| `craft` | act | 查配方、放工作台、合成 |
| `smelt` | wait | 熔炉加料、等待、取出 |
| `craftable` | sense | 当前材料能做什么 |
| `chest_deposit` | act | 存入箱子 |
| `chest_withdraw` | act | 从箱子取出 |
| `chest_view` | sense | 查看箱子内容 |
| `place_block` | act | 在坐标放置方块 |
| `bridge_up` | path | 垫方块向上 |
| `build_wall` | plan | 按尺寸放墙 |
| `till` | act | 锄地 |
| `plant` | act | 播种 |
| `harvest` | act | 收获并补种 |

### 专精类

| 技能 | 类型 | 说明 |
| --- | --- | --- |
| `task_start` | plan | 启动长任务，保存进度 |
| `task_status` | sense | 查询进度 |
| `task_cancel` | act | 取消并清理 |
| `build_blueprint` | plan | 按蓝图逐格建造，统计缺料 |
| `trade` | act | 与村民交易 |
| `villager_trades` | sense | 查看交易列表 |
| `explore` | plan | 选方向跑图，记录路径点 |
| `find_biome` | plan | 按生物群系找目标 |
| `waypoint_save` | sense | 记住坐标 |
| `waypoint_goto` | path | 走到记录的坐标 |
| `nether_portal` | plan | 造门、点火、进入 |
| `end_run` | plan | 找要塞、打龙 |
| `bow_kite` | plan | 远程放风筝 |
| `shield_block` | act | 举盾格挡 |

## 模块布局

```text
bridge/skills/
  manifest.js      技能清单：名字、分组、类型、参数、依赖、超时、是否可打断
  index.js         注册表：按 manifest 组装成 dispatch 表
  perception.js    observe / inventory / nearby_*
  movement.js      goto / follow / retreat / wander / stop
  survival.js      eat / equip_armor / equip_tool / sleep
  combat.js        attack / defend / kite / flee
  gather.js        collect / break / pickup / dig_down
  craft.js         craft / smelt / craftable
  build.js         place / bridge_up / wall / blueprint
  storage.js       chest_*
  farm.js          till / plant / harvest
  trade.js         trade / villager_trades
  tasks.js         task_* / explore / waypoint_*
```

每个模块导出一个工厂：

```js
export function createCombat({ bot, goals, helpers }) {
  return {
    attack_nearest: async (args) => ({ ok: true, detail: '...' }),
    kite: async (args) => ({ ok: true, detail: '...' }),
  };
}
```

`manifest.js` 是唯一事实来源：桥接用它生成 dispatch 表，Core 后续可以从同一份清单生成 tool schema，避免 Python 与 JS 两边各写一份。

## 战斗控制器（控距）

`kite` / `attack_nearest` 共用同一个循环：

1. 选目标：苦力怕单独处理；优先距离最近、能打到自己的怪。
2. 距离带：小于 2.5 格后退，2.5–4.5 格攻击，大于 4.5 格接近。
3. 攻击节奏：每 600ms 一次，命中后侧移 150–250ms，不直线冲脸。
4. 低血：血量 ≤8 停止交战，后撤并吃东西。
5. 目标失效或超过 20 次攻击退出，返回真实结果。

## 独立通关的阶段

| 阶段 | 目标 | 需要的技能 |
| --- | --- | --- |
| S0 | 徒手撸树、做工作台、木镐 | gather、craft、equip_tool |
| S1 | 石镐、石剑、熔炉 | gather、craft、smelt |
| S2 | 食物与临时庇护所 | combat、eat、build、sleep |
| S3 | 铁装、盾与空桶（9 铁锭） | strip_mine、smelt、craft |
| S4 | 钻石、附魔台 | strip_mine、craft、explore |
| S5 | 主世界装水、浇铸黑曜石；下界、烈焰棒、末影珍珠 | fill_water_bucket、collect_obsidian、nether_portal、combat、trade |
| S6 | 要塞、末地、打龙 | end_run、bow_kite、build |

每个阶段只依赖前一个阶段产出的物品与方块，任务层按这个顺序编排。
