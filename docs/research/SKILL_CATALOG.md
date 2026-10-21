# 玩家可模拟技能全量清单

范围：本地 MindCraft 源码（只读）导出的全部技能、`!` 命令与任务型能力，对照 Voxkin 现有 8 个工具。用途是给 `src/voxkin/agent/tools.py` 的工具定义与 `bridge/minecraft_bridge.js` 的桥接实现提供依据。

## 0. 证据约定

`短名:行号` 即 `文件:行号`。`skills.js`、`world.js` 指 `work/reference/mindcraft/src/agent/library/` 下同名文件；`actions.js`、`queries.js` 在 `.../src/agent/commands/`；`modes.js`、`agent.js` 在 `.../src/agent/`；`build_goal.js`、`item_goal.js`、`controller.js` 在 `.../src/agent/npc/`。

`tasks.js`、`construction_tasks.js`、`cooking_tasks.js` 在 `.../src/agent/tasks/`；`mcdata.js` 在 `.../src/utils/`；`bridge`=`bridge/minecraft_bridge.js`；`tools.py`=`src/voxkin/agent/tools.py`；`package.json`=`work/reference/mindcraft/package.json`。现有工具（`tools.py:5-115`）在 Voxkin tool 列标 ✓；插件名取自 `package.json:19-26`，装载点见 `mcdata.js:117-121`；detail 示例按 Voxkin 中文风格书写，MindCraft 文案见所引函数的 `log()`。

## 1. 技能总表

### 移动

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `goToPosition` | `skills.js:1181` / `!goToCoordinates` `actions.js:114` | x,y,z,min_distance=2 | 走到坐标，含开门与非破坏寻路（`skills.js:1077-1103`） | pathfinder | goto ✓ | 已到达 (12, 64, -30) 附近，距离 1.2 格 | P0 |
| `goToNearestBlock` | `skills.js:1237` / `!searchForBlock` `actions.js:127` | blockType,min_distance=2,range=64 | 走到最近指定方块，range 上限 512 | pathfinder | goto_block | 走到最近的橡木旁 | P0 |
| `goToPlayer` | `skills.js:1294` / `!goToPlayer` `actions.js:92` | username,distance=3 | 走到玩家 | pathfinder | come_to_player ✓ | 已到 张三 附近，距离 2.0 格 | P0 |
| `followPlayer` | `skills.js:1331` / `!followPlayer` `actions.js:103` | username,distance=4 | 持续跟随直到中断 | pathfinder | follow_player ✓ | 正在跟随 张三，保持 2 格 | P0 |
| `moveAway` | `skills.js:1397` / `!moveAway` `actions.js:153` | distance | 朝任意方向离开当前点 | pathfinder | wander | 从 (10,64,10) 走到 (18,64,10) | P1 |
| `stay` | `skills.js:1475` / `!stay` `actions.js:339` | seconds=30（-1 永久） | 原地停留，暂停全部 mode | 无 | stay | 原地停留 30 秒 | P1 |
| `goToSurface` | `skills.js:1963` / `!goToSurface` `actions.js:484` | 无 | 回到当前 x,z 的最高非空气方块 | pathfinder | go_to_surface | 回到地表 y=71 | P1 |
| `goToNearestEntity` | `skills.js:1274` / `!searchForEntity` `actions.js:142` | entityType,min_distance,range | 走向最近实体 | pathfinder | goto_entity | 已到 牛 附近 | P2 |
| `digDown` | `skills.js:1906` / `!digDown` `actions.js:476` | distance=10 | 垂直下挖，遇水/岩浆/落差错 >2 停止 | pathfinder | dig_down | 向下挖了 6 格，遇到水停下 | P2 |
| `avoidEnemies` | `skills.js:1445` | distance=16 | 退到敌对生物距离外，贴身时反击 | pathfinder+pvp | flee | 退到苦力怕 16 格外 | P2 |
| `moveAwayFromEntity` | `skills.js:1430` | entity,distance=16 | 远离指定实体 | pathfinder | 并入 flee | 远离 张三 5 格 | P2 |

### 采集

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `collectBlock` | `skills.js:417` / `!collectBlocks` `actions.js:256` | blockType,num=1,exclude=null | 找最近同类方块并收集，自动换工具，矿石名自动补 `_ore`/`deepslate_`（`skills.js:433-440`） | collectblock+tool+pathfinder | collect_blocks ✓ | 挖到 3 个 橡木 | P0 |
| `breakBlockAt` | `skills.js:561` | x,y,z | 破坏指定坐标方块，距离 >4.5 先走近 | tool+pathfinder | break_block | 挖掉 (10,64,10) 的 石头 | P0 |
| `pickupNearbyItems` | `skills.js:531` | 无 | 捡 8 格内掉落物 | pathfinder | pickup_items | 捡起 4 个掉落物 | P1 |
| `useToolOnBlock` | `skills.js:2044` | toolName,block | 对指定方块用工具/桶，含视线遮挡重试 | tool | use_on_block | 用 铁镐 采 黑曜石 | P1 |

### 合成 / 熔炼

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `craftRecipe` | `skills.js:36` / `!craftRecipe` `actions.js:267` | itemName,num=1 | 合成；无工作台时自动放置、合成后收回（`skills.js:56-108`），末步 `armorManager.equipAll()` | minecraft-data+armor-manager | craft | 合成 oak_planks，现有 12 个 | P0 |
| `smeltItem` | `skills.js:142` / `!smeltItem` `actions.js:278` | itemName,num=1 | 熔炼；自动放熔炉、按燃料热值算用量（`skills.js:204-226`） | 无 | smelt | 烧出 3 个 iron_ingot | P0 |
| `clearNearestFurnace` | `skills.js:275` / `!clearFurnace` `actions.js:294` | 无 | 取空熔炉三个槽位 | 无 | clear_furnace | 从熔炉取出 2 铁锭、1 煤 | P2 |
| `!getCraftingPlan` | `queries.js:270` | targetItem,quantity | 输出缺料清单 | minecraft-data | craft_plan | 还缺 3 个 oak_log | P2 |

### 建造 / 放置

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `placeBlock` | `skills.js:611` / `!placeHere` `actions.js:302` | blockType,x,y,z,placeOn='bottom' | 贴邻面放置；目标位有方块先挖掉，无支撑则失败（`skills.js:701-751`） | 无 | place_block | 在 (10,64,10) 放了 橡木木板 | P0 |
| `BuildGoal.executeNext` | `build_goal.js:20` / `controller.js:174` | goal,position,orientation | 按内置 JSON 蓝图逐层摆块，缺料回传 | pathfinder | build_blueprint | 摆了 12 块，缺 8 个 oak_planks | P2 |
| `Blueprint` / `blueprintToTask` | `construction_tasks.js:73`、`:1051` | blueprint_data,num_agents | 蓝图解析与按 agent 拆任务（基准评测用） | 无 | — | — | P2 |
| `torch_placing`（mode） | `modes.js:220` / `world.js:406` | 无 | 空闲时 6 格内无火把就插一支 | 无 | 内部行为 | 在脚下插了火把 | P2 |

### 背包 / 箱子

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `getInventoryCounts` | `world.js:262` / `!inventory` `queries.js:67` | 无 | 汇总物品与数量，命令版另报四个护甲槽 | 无 | inventory ✓ | 背包：橡木 x12、面包 x2 | P0 |
| `equip` | `skills.js:791` / `!equip` `actions.js:204` | itemName | 按后缀判断槽位，`hand` 表示空手 | 无 | equip | 装备 铁剑 | P1 |
| `consume` | `skills.js:973` / `!consume` `actions.js:196` | itemName="" | 吃/喝，装手后 `bot.consume()` | 无 | eat | 吃了 面包 | P0 |
| `giveToPlayer` | `skills.js:998` / `!givePlayer` `actions.js:184` | itemType,username,num=1 | 走近后丢出，监听 `playerCollect` 确认（`skills.js:1046-1064`） | pathfinder | give_item | 张三 收到 3 个 面包 | P1 |
| `putInChest` | `skills.js:869` / `!putInChest` `actions.js:212` | itemName,num=-1 | 存进 32 格内最近的箱子 | 无 | put_in_chest | 存了 16 个 圆石 | P1 |
| `takeFromChest` | `skills.js:898` / `!takeFromChest` `actions.js:223` | itemName,num=-1 | 从最近箱子取，跨多槽累加 | 无 | take_from_chest | 取了 8 个 铁锭 | P1 |
| `viewChest` | `skills.js:944` / `!viewChest` `actions.js:234` | 无 | 读箱子内容 | 无 | view_chest | 箱子里有 32 个 泥土 | P2 |
| `discard` | `skills.js:838` / `!discard` `actions.js:242` | itemName,num=-1 | 丢弃；命令版先走开 5 格再丢 | pathfinder | discard | 丢掉 12 个 沙砾 | P2 |
| `getCraftableItems` | `world.js:285` / `!craftable` `queries.js:133` | 无 | 列出当前材料能做的物品 | minecraft-data | craftable | 能合成：木棍、工作台 | P2 |

### 农业

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tillAndSow` | `skills.js:1575` | x,y,z,seedType=null | 锄地并播种，seeds 名自动补 s | tool | till_and_sow | 在 (8,63,8) 种下 小麦种子 | P1 |
| `CookingTaskInitiator` | `cooking_tasks.js:3`、`:17` | data,bot | 用 `/fill` 搭测试农田，基准脚手架 | 无 | — | — | P2 |

### 战斗

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `attackNearest` | `skills.js:313` / `!attack` `actions.js:311` | mobType,kill=true | 攻击 24 格内指定类型，`kill` 时交给 pvp 追打 | pvp | attack_nearest ✓ | 击败了 僵尸，5 次攻击 | P0 |
| `defendSelf` | `skills.js:370` | range=9 | 循环清理范围内所有 hostile，creeper/phantom 不贴身 | pvp+pathfinder | defend | 清掉 3 只怪 | P1 |
| `attackEntity` | `skills.js:334` / `!attackPlayer` `actions.js:319` | entity,kill=true | 打具体实体，含玩家 | pvp | attack_entity | 攻击了 张三 4 次 | P2 |
| `equipHighestAttack` | `skills.js:24` | 无 | 按 `attackDamage` 选剑/斧，无则镐/铲 | 无 | 并入 attack | 换上 钻石剑 | P2 |

### 生存

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `goToBed` | `skills.js:1543` / `!goToBed` `actions.js:332` | 无 | 找 32 格内含 `bed` 的方块并睡到醒来 | pathfinder | sleep | 躺上床，天亮醒来 | P0 |
| `!stats` | `queries.js:15` | 无 | 坐标、血量、饥饿、生物群系、天气、时段、附近玩家 | 无 | where_am_i | 血量 18/20，饥饿 14/20，平原，清晨 | P1 |
| `autoEat` | `agent.js:191`、`mcdata.js:120` | 无 | 饥饿值低时自动进食，含黑名单食物 | auto-eat | 内部行为 | 自动吃了 熟牛肉 | P2 |
| `self_preservation`（mode） | `modes.js:26` | 无 | 溺水跳跃、着火放水/找水、低血逃跑 | 无 | 内部行为 | 着火了，去水里 | P2 |

### 村民交易

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tradeWithVillager` | `skills.js:1789` / `!tradeWithVillager` `actions.js:395` | id,index（1 起）,count | 校验交易上限与材料后执行 | 无 | trade | 用 3 个 绿宝石 换了 1 个 面包 | P0 |
| `showVillagerTrades` | `skills.js:1748` / `!showVillagerTrades` `actions.js:387` | id | 列出交易项与已用次数 | 无 | villager_trades | 村民有 4 项交易：1 绿宝石换面包 | P1 |
| `getVillagerProfession` | `world.js:218` | entity | 职业与等级（metadata 映射表 `world.js:220-236`） | 无 | 并入 villager_trades | 图书管理员 L2 | P2 |

### 交互

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `useToolOn` | `skills.js:1982` / `!useOn` `actions.js:492` | toolName,targetName | 对实体/方块/空处右键，`hand` 表示空手 | 无 | use_on | 对 牛 使用 桶，得到牛奶 | P1 |
| `activateNearestBlock` | `skills.js:1652` | type | 16 格内右键按钮/拉杆/门 | pathfinder | activate_block | 按下了 拉杆 | P2 |
| `useDoor` | `skills.js:1499` | door_pos=null | 走门口、开门、穿过、关门 | pathfinder | use_door | 打开了 橡木门 | P2 |

### 探索

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `getNearbyBlockTypes` / `getNearbyEntityTypes` | `world.js:371`、`world.js:325` | distance=16 | 周边方块与生物类型清单 | 无 | scan_surroundings | 附近有：橡木、石头、羊、僵尸 | P1 |
| `getBiomeName` | `world.js:421` | 无 | 生物群系名 | minecraft-data | where_am_i | 当前在 森林 | P1 |
| `!nearbyBlocks` | `queries.js:104` | 无 | 方块清单 + 脚下/腿部/头部 + 头顶首个固体 | 无 | scan_surroundings | 头顶 3 格处是 橡木树叶 | P1 |
| `!entities` | `queries.js:148` | 无 | 附近玩家、bot、生物计数，村民带 id 与职业 | 无 | nearby_entities | 2 只村民（12:农民 L1） | P1 |
| `!searchWiki` | `queries.js:312` | query | 抓 minecraft.wiki 正文 | cheerio | wiki_lookup | 已读到 合成 页面 | P2 |

### 沟通

| 技能 | 来源 | 参数 | 作用 | 依赖插件 | Voxkin tool | detail 示例 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chat` | `bridge:123-126` / `agent.js:404-426` | text | 游戏内公屏发言，MindCraft 侧由 `openChat` 落到 `bot.chat` | 无 | say | 已发送聊天消息 | P0 |
| `!stfu` / `narrate_behavior` | `actions.js:68`、`modes.js:7-11` | 无 | 停止游戏内播报 | 无 | — | 停止播报 | P2 |
| `!startConversation` / `!endConversation` | `actions.js:407`、`:424` | player_name,message | bot 之间会话，与玩家沟通无关 | 无 | — | — | P2 |

## 2. P0 清单（15 个，按价值排序）

| # | 技能 | 为什么是 P0 |
| --- | --- | --- |
| 1 | collect_blocks ✓ | 挖矿与采集的唯一入口；现有实现只按名字找 32 格内方块（`bridge:216-238`），缺工具切换与掉落拾取 |
| 2 | break_block | 精确改地形（开门洞、清障碍），也是 place_block 的失败回退路径 |
| 3 | place_block | "建东西"的最小单位；MindCraft 已处理贴面、占位与破障（`skills.js:701-751`） |
| 4 | craft | 玩家身份的核心循环；工作台自动放置/收回省掉一整类指令（`skills.js:56-108`） |
| 5 | smelt | 矿石到锭的唯一途径，附燃料估算与超时保护（`skills.js:204-249`） |
| 6 | eat | 饥饿值低时不能疾跑、不回血，战斗与长距离挖矿都依赖它 |
| 7 | attack_nearest ✓ | 用户点名的打怪；需补 `mob` 参数与武器自动切换（`skills.js:24-34`） |
| 8 | follow_player ✓ | 多人服务器最高频的共玩动作，已有实现（`bridge:269-316`） |
| 9 | come_to_player ✓ | 语音"过来"的直接映射，已有实现（`bridge:138-145`） |
| 10 | goto_block | 让"去那棵树""去熔炉"成立；纯坐标 goto 依赖玩家报数 |
| 11 | inventory ✓ | 回答"你有啥"、合成前置校验的唯一数据源（`world.js:262`） |
| 12 | sleep | 跳过夜晚、避开夜间刷怪；床是 craft 产物，依赖链自然（`skills.js:1543`） |
| 13 | trade | 用户点名；绿宝石经济入口，材料校验逻辑可直接移植（`skills.js:1832-1836`） |
| 14 | say | 桥接已实现（`bridge:123-126`），只差工具定义；游戏内文字与语音互补 |
| 15 | pickup_items | 战斗与挖掘后的掉落物回收，否则物品 5 分钟后消失（`skills.js:531`） |

`goto`、`stop`、`look_at_player` 已在 `tools.py` 存在且够用，不占 P0 名额。"闲逛"由 follow/come/goto_block 与 P1 的 `wander` 组合覆盖，单列 `wander` 优先级低于上表。

## 3. P1 / P2 清单与实现难度

| 优先级 | 技能 | 家族 | 难度 | 说明 |
| --- | --- | --- | --- | --- |
| P1 | equip | 背包 | 低 | 按后缀映射槽位，`skills.js:816-833` 可直接照搬 |
| P1 | wander | 移动 | 低 | `GoalInvert(GoalNear)` 一次寻路（`skills.js:1406-1427`） |
| P1 | stay | 移动 | 低 | 定时循环 + 中断标记（`skills.js:1484-1496`） |
| P1 | defend | 战斗 | 中 | 需 hostiles 集合与 creeper 特殊距离（`skills.js:385-397`） |
| P1 | pickup_items | 采集 | 低 | 需要 item 实体过滤与目标跟随 |
| P1 | use_on | 交互 | 中 | 视线遮挡与桶类分支（`skills.js:2053-2090`） |
| P1 | put_in_chest / take_from_chest | 箱子 | 中 | 依赖 `openContainer` 与槽位遍历（`skills.js:891-937`） |
| P1 | give_item | 背包 | 中 | 需监听 `playerCollect` 确认，避免重复丢（`skills.js:1048-1064`） |
| P1 | till_and_sow | 农业 | 中 | 需锄头检测与上方方块清理（`skills.js:1604-1648`） |
| P1 | go_to_surface | 移动 | 中 | 逐列扫描 + 垂直寻路，MindCraft 做法较粗糙（`skills.js:1970-1978`） |
| P1 | scan_surroundings / where_am_i | 探索 | 低 | 纯读数据，适合做上下文注入 |
| P1 | villager_trades | 交易 | 低 | 需把实体 id 转成可读清单（`skills.js:1763-1768`） |
| P2 | build_blueprint | 建造 | 高 | 只支持内置 4 个 JSON；需自行定义蓝图格式与材料替代 |
| P2 | 农业自动化（收获/补种/骨粉） | 农业 | 高 | MindCraft 无实现，需自建状态机 |
| P2 | fishing | 生存 | 高 | 需等待咬钩事件，`useToolOn` 只做一次右键（`skills.js:2001`） |
| P2 | 船 / 矿车 / 骑乘 | 移动 | 高 | 无任何载具调用 |
| P2 | 下界 / 末地 / 传送门 | 探索 | 高 | 无维度跳转与坐标换算 |
| P2 | 附魔 / 铁砧 / 酿造 | 合成 | 高 | 仅解析 NBT 文本（`skills.js:1895-1900`） |
| P2 | 红石 | 建造 | 高 | 只能摆方块，无信号与电路验证 |
| P2 | 剪羊毛 / 挤奶 / 繁殖 | 农业 | 中 | `useToolOn` 到实体的分支可扩展 |
| P2 | 多人协作建造 | 建造 | 高 | `blueprintToTask`（`construction_tasks.js:1051`）只做任务拆分 |
| P2 | 打指定实体/玩家 | 战斗 | 中 | `attackEntity` 需要实体句柄，工具层需 id 解析 |
| P2 | dig_down / use_door / activate_block / view_chest / discard / clear_furnace | 混合 | 低 | 单点封装，价值低但成本低 |

## 4. MindCraft 也没覆盖的

- 钓鱼：全仓无 rod 状态机，`useToolOn` 的 `nothing` 分支只调用一次 `bot.activateItem()`（`skills.js:1996-2002`）。
- 船、矿车、骑乘：无 boat/minecart/mount 调用；`placeBlock` 能放 `rail`（`skills.js:755`），没有上车逻辑。
- 下界、末地、传送门：无 portal 建造或维度切换代码。
- 附魔、铁砧、酿造：只在 `stringifyItem` 里读取 `ench`/`StoredEnchantments`/`Potion` 文本（`skills.js:1887-1901`），没有交互实现。
- 红石逻辑：按钮/拉杆/铁轨只能放置（`skills.js:652-665`、`:755`），无信号、观察者、电路验证。
- 农业只到"锄地 + 播种"（`skills.js:1575-1650`），没有收获、补种、骨粉、灌溉、动物繁殖。
- 复杂建筑蓝图：`BuildGoal` 只吃 `npc/construction/` 下 4 个内置 JSON（`controller.js:43-46`），按 y 层逐格 `placeBlock`（`build_goal.js:37-76`），无外部蓝图导入、材料替换、结构完工校验。
- 多人协作建造：`blueprintToTask(blueprint_data, num_agents)`（`construction_tasks.js:1051`）按 agent 拆任务，服务基准评测；无工期协商、共享材料、冲突避让。
- 战斗细节：无盾牌格挡、弓蓄力、药水、末影珍珠；`equip` 把 shield 放副手（`skills.js:828`）却没有使用逻辑。
- 睡觉只有 `goToBed`（`skills.js:1543`），不判断夜晚/雷暴，不设重生点。
- 死亡与重生：无重生后回原位、无掉落物回收。
- 命令系统本身依赖正则解析 `!cmd(args)`（`.../src/agent/commands/index.js:29`），没有工具 schema；Voxkin 走 function calling，两边不可直接复用。

## 5. P0 验收场景（生存服务器）

| 技能 | 需要环境/物品 | 操作 | 成功标准 |
| --- | --- | --- | --- |
| collect_blocks | 树林，木斧或石斧 | "挖 3 个橡木" | detail 报 3 个，背包 oak_log +3，树干无残留 |
| break_block | 石墙，石镐 | "把 (x,y,z) 挖开" | 该坐标变 air，掉落被捡，detail 含方块名 |
| place_block | 8 个 oak_planks | "在这里砌一格" | 目标坐标出现 oak_planks，无悬空 |
| goto_block | 48 格内有熔炉 | "去熔炉那边" | 停在 4 格内，detail 报距离 |
| craft | 4 个 oak_log | "做工作台" | 背包出现 crafting_table，无报错 |
| smelt | 熔炉 + 煤 + 3 raw_iron | "把这 3 个铁矿烧了" | iron_ingot +3，熔炉清空，detail 报数量 |
| eat | 饥饿 <18，背包有 bread | "吃点东西" | 饥饿上升，bread -1 |
| attack_nearest | 夜晚，8 格内有僵尸，铁剑 | "打那只僵尸" | 僵尸消失，detail 报攻击次数，自身血量 >0 |
| follow_player | 两名玩家，相距 5 格 | "跟着我"后直线走 50 格 | 距离稳定 ≤3 格，不卡墙不掉队 |
| come_to_player | 玩家在 20 格外 | "过来" | 一次到达，距离 ≤2 格 |
| inventory | 背包多类物品，手持铁剑 | "你背包里有啥" | 语音列出主要物品与数量，含手持 |
| sleep | 夜晚，床在 16 格内 | "去睡觉" | 进入 bed，天亮自动醒来 |
| trade | 村庄，农民 L1，3 个绿宝石 | "跟他换一个面包" | 绿宝石 -1，bread +1，交易次数 +1 |
| say | 任意 | "在公屏说你好" | 聊天栏出现该文本，其他玩家可见 |
| pickup_items | 8 格内有掉落物 | "把东西捡起来" | detail 报数量，掉落物消失 |

## 6. 工具 schema 草案

外壳统一为 `{"type": "function", "function": {...}}`，条目追加到 `tools.py:5` 的 `MINECRAFT_TOOLS`。`follow_player`、`come_to_player`、`inventory` 沿用现有定义（`tools.py:58-96`）。

```python
{"name": "collect_blocks", "description": "走到附近的方块旁挖掉指定数量，自动换合适工具并拾取掉落。",
 "parameters": {"type": "object", "properties": {"block": {"type": "string", "description": "方块 ID，例如 oak_log、iron_ore"}, "count": {"type": "integer", "minimum": 1, "maximum": 64}}, "required": ["block", "count"]}},
{"name": "break_block", "description": "挖掉指定坐标的方块，返回方块名。", "parameters": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}}, "required": ["x", "y", "z"]}},
{"name": "place_block", "description": "在指定坐标放置背包里的方块或物品。",
 "parameters": {"type": "object", "properties": {"block": {"type": "string", "description": "方块 ID，例如 oak_planks、torch"}, "x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}}, "required": ["block", "x", "y", "z"]}},
{"name": "goto_block", "description": "走到最近的指定方块旁边。",
 "parameters": {"type": "object", "properties": {"block": {"type": "string", "description": "方块 ID"}, "range": {"type": "integer", "minimum": 8, "maximum": 128, "description": "搜索半径，默认 48"}}, "required": ["block"]}},
{"name": "craft", "description": "按配方合成指定物品，必要时放置并使用工作台。",
 "parameters": {"type": "object", "properties": {"item": {"type": "string", "description": "产物 ID，例如 oak_planks、crafting_table"}, "count": {"type": "integer", "minimum": 1, "maximum": 64}}, "required": ["item", "count"]}},
{"name": "smelt", "description": "在熔炉里烧炼指定物品，自动补充燃料。",
 "parameters": {"type": "object", "properties": {"item": {"type": "string", "description": "原料 ID，矿石用 raw_iron 这类名称"}, "count": {"type": "integer", "minimum": 1, "maximum": 64}}, "required": ["item", "count"]}},
{"name": "eat", "description": "吃掉背包里的指定食物，恢复饥饿值。", "parameters": {"type": "object", "properties": {"item": {"type": "string", "description": "食物 ID，例如 bread、cooked_beef"}}, "required": ["item"]}},
{"name": "attack_nearest", "description": "攻击附近最近的敌对生物，自动装备武器。",
 "parameters": {"type": "object", "properties": {"mob": {"type": "string", "description": "目标生物类型，省略时打最近的敌对生物"}, "range": {"type": "number", "minimum": 3, "maximum": 32, "description": "搜索范围，默认 16 格"}}}},
{"name": "sleep", "description": "走到最近的床睡觉，跳过夜晚。", "parameters": {"type": "object", "properties": {}}},
{"name": "trade", "description": "和附近村民交易，按序号选择交易项，可先查询清单。",
 "parameters": {"type": "object", "properties": {"trade": {"type": "integer", "minimum": 1, "description": "交易项序号，从 1 开始；省略时只返回交易清单"}, "count": {"type": "integer", "minimum": 1, "maximum": 16, "description": "执行次数，默认 1"}, "villager": {"type": "string", "description": "村民实体 ID，省略时用最近的村民"}}, "required": []}},
{"name": "say", "description": "在游戏聊天栏发一句话，最多 200 字。", "parameters": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 200}}, "required": ["text"]}},
{"name": "pickup_items", "description": "走到附近掉落物旁边把它们捡起来。", "parameters": {"type": "object", "properties": {"range": {"type": "number", "minimum": 2, "maximum": 16, "description": "搜索半径，默认 8 格"}}}},
```

## 7. 实现顺序（3 批，每批可独立验收）

| 批次 | 内容 | 依赖 | 独立验收标准 |
| --- | --- | --- | --- |
| 1 动作原语 | break_block、place_block、goto_block、pickup_items、say；扩展 collect_blocks 的工具切换与掉落、attack_nearest 的 `mob` 参数 | pathfinder + collectblock，无需新插件 | 第 5 节前 4 行加 say 全部通过；`bridge` 单进程无残留寻路目标 |
| 2 生存循环 | craft、smelt、eat、sleep | 批 1 的 place_block/break_block（工作台、熔炉、床的摆放与回收） | "原木→木板→工作台→木棍→床→睡到天亮"一条链跑通；熔炉烧 3 个铁矿成功 |
| 3 社交与经济 | trade、inventory 扩展（装备槽与手持）、equip、give_item、put_in_chest/take_from_chest、villager_trades | 批 1 的移动与走位 | 村庄内查到清单并完成一次交易；箱子里存 16 个圆石再取回 8 个 |

批 2 起需要 `bridge` 增加容器窗口状态管理；批 3 起需要实体 ID 解析层（`showVillagerTrades` 依赖数值 id，`skills.js:1682-1684`）。三批都不需要新增 npm 依赖。
