# 玩家化移动与感知设计（只读调研）

范围：跟随步态、pathfinder 参数、感知采样、空闲闲逛、生存自动化、反机械感、验收场景。只读调研，未改生产代码。
证据口径：`work/reference/mindcraft` 未携带 `node_modules`（目录不存在），pathfinder 默认值改引 Voxkin 桥接安装的 2.4.5（`bridge/node_modules/mineflayer-pathfinder`，与 MindCraft `package.json:25` 同版本）。MindCraft 的 pathfinder 差异用 `patches/mineflayer-pathfinder+2.4.5.patch` 说明。表格中的阈值除注明来源外均为建议值，属于设计决策；标注“未确认”的是仓库内没有证据。桥接文件在调研期间被并发编辑，文中 `bridge/minecraft_bridge.js` 行号按 2026-10-21 22:54 快照标注，后续可能漂移。简写约定：`skills.js`/`modes.js`/`world.js`/`full_state.js`/`agent.js` 指 `work/reference/mindcraft/src/agent/` 下同名文件；`index.js`/`movements.js`/`goals.js`/`astar.js` 指 pathfinder 包内文件；`mineflayer/`、`prismarine-*` 指 `bridge/node_modules/` 下对应包。
## 1. 结论

| 问题 | 结论 |
| --- | --- |
| 一直冲刺 | pathfinder 的 `allowSprinting` 默认 `true`（`bridge/node_modules/mineflayer-pathfinder/lib/movements.js:34`），只要直线可行就每 tick 开 sprint（`index.js:614-619`）。旧桥接快照写的是 `allowSprint`（`bridge/minecraft_bridge.js:546`），该字段无效；当前编辑已改为 `allowSprinting`（`:615`），但仍需按距离分带，否则会全程冲刺。 |
| 走走停停 | `GoalFollow` 的 `isEnd`/`hasChanged` 使用构造时的玩家锚点，不跟实时位置（`lib/goals.js:325-361`）；路径走完后 `pathUpdated` 仍为 `true`，不会重算，直到玩家离开锚点 range（`index.js:456-472`）。只调 `distance` 无法消除。 |
| 贴得太近 | `GoalFollow` 只保证“进入 range”，没有个人空间；MindCraft 跟随在近距离还会暂停 `elbow_room`（`skills.js:1378-1383`）。需要独立的 1.5 格让位与 2.2 格停止。 |
| 步态 | 建议：目标 2.2 格；走 3.2–10 格；10 格外进 sprint，6 格内退 sprint；停止 2.2，恢复 3.2；重寻路间隔 ≥600ms。 |
| 感知 | 50ms 只更新自身位姿与危险；250ms 跟随状态机；500ms 生成给 LLM 的状态 JSON；方块扫描 2s 一次或按需，避免每 tick `findBlocks`。 |
| 闲逛 | 半径 5–9 格、单次 5–9 格、停 4–8s；用 `isClearPath` 加液体/悬崖/敌对检查；玩家 3 格内或说话时进入 ATTEND。 |
| 生存 | 吃用 `mineflayer-auto-eat`（MindCraft 配 `startAt:14`，`agent.js:190-195`）；换工具、插火把、水火脱困自写；桥接当前只装了 pathfinder（`bridge/package.json:13-15`）。 |
| 最大风险 | 仅改数值不能修复 GoalFollow 的锚点语义与死字段；需要自定义 goal 或本地转向控制器，并做 A/B 对照。 |

## 2. 机制核对

| 机制 | 证据 | 对设计的影响 |
| --- | --- | --- |
| GoalFollow 锚点 | 构造时记录 `entity.position`（`goals.js:325-333`）；`hasChanged` 只在玩家离锚点超过 range 时更新（`:349-361`）；`isEnd` 用锚点（`:342-347`）。 | 玩家在 range 内移动时目标不动，bot 会停在旧位置；换自定义 goal，`isEnd` 读实时玩家。 |
| 路径完成后不重算 | 路径走完 `fullStop()`（`index.js:587-595`）；只有 `!pathUpdated` 才重新 `getPathTo`（`:465-471`），而 `pathUpdated` 只在 `resetPath` 清零（`:123-140`）。 | 这是“走一段、停住、等玩家走远”的根因；自定义 goal 的 `hasChanged` 要节流返回 `true`。 |
| 停止方式 | `setGoal(null)` 走 `resetPath`，清 control states 但不清速度（`index.js:123-147`）；`stop()` 走 `fullStop()`，速度归零并把位置吸到方块中心（`:330-345`、`:390-396`）。 | 正常停跟用 `setGoal(null)`，保留惯性；`stop()` 只用于危险中断。 |
| 当前 LiveFollowGoal | 已有实时 `isEnd` 与 2 格锚点更新（`bridge/minecraft_bridge.js:532-565` 快照）。 | 方向正确；但暂停与冲刺切换仍会新建 goal 并 `setGoal`（`:601-618`），`resetPath` 清控制状态，急停与抖动风险仍在。 |
| 字段名 | `movements.js:34` 定义 `allowSprinting`；`index.js:614,617` 读取它；旧快照写 `allowSprint`（`bridge/minecraft_bridge.js:546`），当前已改为 `allowSprinting`（`:615`）。 | 只认 `allowSprinting`；不要再写 `allowSprint`，sprint 变化只改字段，不重建 goal。 |
| 门 | 原版 2.4.5 `canOpenDoors=false`（`movements.js:101`）；MindCraft 的 patch 改为 `true` 并扩展 door/trapdoor（`patches/mineflayer-pathfinder+2.4.5.patch:132-133`）。 | 不开门时绕路会显得笨；启用 patch 逻辑或自写开门，铁门仍绕行。 |
| MindCraft 跟随 | 跟随时按距离暂停 `unstuck`、`elbow_room`（`skills.js:1378-1389`）；500ms 轮询，30 格内恢复采集/插火把/狩猎（`:1353-1376`）。 | 它的跟随同样缺少个人空间；可借用“远距暂停杂务”的思路；20 秒才脱困（`modes.js:100-133`）对跟随太慢。 |

## 3. 跟随步态

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 目标距离 | 2.2 格（水平） | 按 0.6 格宽的玩家 hitbox 估算，2.2 格不会贴脸；`GoalFollow` 的 range 用平方比较（`goals.js:332`）。 |
| 停止距离 | 2.2 格 | 进入后清 forward/sprint，不再发新 goal。 |
| 恢复距离 | 3.2 格 | 迟滞 1.0 格；避免在 2.2 附近反复启停。 |
| 走带 | 3.2–10.0 格 | 走带内 `allowSprinting=false`。 |
| sprint 进入 | >10.0 格 | 冲刺追上；按常见冲刺速度估算，从 2 格到 10 格约 1.4s，250ms 采样下 2s 内可触发。 |
| sprint 退出 | <6.0 格 | 迟滞 4 格；退出后 1s 内不重新进冲刺。 |
| 重寻路 | ≥600ms，且玩家离上次 anchor >2.0 格 | `setGoal` 会清 path 与 control states（`index.js:142-147`），不能每 tick 调用。 |
| 本地转向 | 距离 ≤6 格且视线通 | 直接按玩家方向转向，避免短距 A* 抖动；被挡或超时再交给 pathfinder。 |
| 平滑 | 3 个 250ms 样本的 EMA | 抑制距离噪声；死区 ±0.3 格。 |
| 个人空间 | <1.5 格侧移 0.5s | 玩家走进 bot 时侧移，不后退挤压；随后回到 2.2。 |
| 停车 | 2.6 格时 `setGoal(null)` | 让摩擦把速度带到约 2.2，避开 `fullStop` 的急停与回中。 |

```text
every 250ms:
  gap = horizontalDistance(bot, player)
  v = ema(player.speed, 3)
  if (gap < 1.5 && !playerWalkingTowardBot) { stepAside(0.5s); return }
  if (gap <= 2.2) { hold(); return }          // setGoal(null), 不清速度
  if (paused && gap < 3.2) return
  paused = false
  sprint = sprint ? gap > 6.0 : gap > 10.0
  movements.allowSprinting = sprint           // 原地改字段, 不 setGoal
  if (gap <= 6.0 && lineOfSight(player)) steerDirect(player)
  else if (now - lastPathAt > 600 && playerMoved > 2.0) repath()
```

区别三种情况：**保持 2 格**时停在 2.2–3.2 死区，不重设 goal；**玩家跑远到 10 格**后 250ms 内把 `allowSprinting` 置 `true`，用 pathfinder 追；**玩家停下**后速度 EMA <0.4，强制 sprint off，走带内本地转向，2.6 格切路径，2.2 格停。

## 4. pathfinder 参数表

| 字段 | 2.4.5 默认 | 建议值（跟随） | 对“像玩家”的影响 |
| --- | --- | --- | --- |
| `allowSprinting`（无 `allowSprint`） | `true`（`movements.js:34`） | 走带 `false`；CATCHUP `true` | 默认每 tick 冲刺；按带切换，且只改字段不重设 goal。 |
| `canDig` | `true`（`movements.js:23`） | 跟随主路径 `false`；卡住 1.5s 后临时 `true` | 默认会挖穿树/墙；玩家先绕路。 |
| `scafoldingBlocks` | `[dirt, cobblestone]`（`movements.js:75-77`） | `[]` | 默认会搭方块垫脚/搭桥；清空后不再出现“空中放方块”。 |
| `allow1by1towers` | `true`（`movements.js:31`） | `false` | 默认能原地柱状上塔，玩家跟随不会这样走。 |
| `maxDropDown` | `4`（`movements.js:107`） | `2` | 默认允许 4 格落差；玩家通常绕开 >2 格悬崖。 |
| `thinkTimeout` | `5000ms`（`index.js:39`） | 跟随 `800–1200ms` | 短距搜索不需要 5s；超时会留下 partial path。 |
| `tickTimeout` | `40ms`（`index.js:40`） | `20–30ms` | 每 tick 最多算 40ms 会挤占物理 tick；上限注释为 50ms。 |
| `searchRadius` | `-1`（`index.js:41`） | `48` | 防止远距目标把 A* 扩到全图。 |
| `dontMine` | 无此字段 | 用 `canDig` 控制 | 2.4.5 只有 `dontMineUnderFallingBlock`（`movements.js:30`），保持 `true`。 |
| `canOpenDoors` | `false`（`movements.js:101`） | `true`（需 patch 或自写开门） | 否则门/栅栏门一律绕行或挖掉；铁门仍应绕行。 |
| `allowParkour` | `true`（`movements.js:33`） | `false` | 默认会 3–4 格跑跳（`movements.js:577`），观感像跑酷。 |
| `placeCost` / `digCost` | `1` / `1`（`movements.js:24-25`） | `8` / `8` | 提高破坏地形的代价；配合 `canDig=false` 只作兜底。 |
| `liquidCost` | `1`（`movements.js:26`） | `4` | 默认几乎不避免水；玩家会绕开深水。 |
| `entityCost` | `1`（`movements.js:27`） | `2` | 避免从玩家/ mob 身上挤过去。 |
| `allowFreeMotion` | `false`（`movements.js:32`） | `false` | 开启后直线追实体、完全绕过 A*，容易撞墙。 |

MindCraft 的 patch 还改了到达阈值（0.35→0.175，`patches/mineflayer-pathfinder+2.4.5.patch:71-72`）并让 bot 在岩浆中临时不再避开岩浆（`:249-261`）。前者更严格，配合短距重寻路会放大抖动；后者是脱困所需，建议自写脱困时临时移除 `blocksToAvoid` 中的 lava，不改全局 patch。

## 5. 感知模型

玩家视野的本质是“前向锥 + 遮挡 + 服务端已下发”。mineflayer 给 bot 的是 360° 实体表，不能直接当玩家视野用。建议：`seen` 只保留水平 ±50°、垂直 ±30° 且 `bot.world.raycast` 无遮挡的目标（`mineflayer/lib/plugins/blocks.js:238`）；`near` 保留 360° 的危险源（岩浆、火、苦力怕、抛射物）。FOV 具体角度未在仓库找到证据，按设计值处理。

| 通道 | 内容 | 范围 / 频率 | 证据 |
| --- | --- | --- | --- |
| 自身位姿 | position、velocity、yaw/pitch、onGround、isInWater/isInLava | 每 tick（50ms） | mineflayer 物理间隔 50ms（`bridge/node_modules/mineflayer/lib/plugins/physics.js:14-15`） |
| 危险 | 脚下/头顶方块、岩浆/水/火、生命 | 50ms | `modes.js:32-88` 列出检查项；MindCraft 模式循环为 300ms（`agent.js:503`），Voxkin 需 50ms |
| 主玩家 | 距离、速度、视线、装备 | 250ms | `entity.equipment` 由 `entity_equipment` 包更新（`mineflayer/lib/plugins/entities.js:115-123`） |
| 实体 | 16 格内全部，32 格只对 player | 500ms | `getNearbyEntities` 默认 16（`world.js:179-192`）；32 格依赖服务端下发，未确认 |
| 掉落物 | `entity.name === 'item'` | 8 格发现与拾取 | 拾取模式 8 格（`modes.js:199`）；拾取移动 8 格（`skills.js:539-540`） |
| 方块 | 脚下/腿/头/头顶；附近类型按需 | 500ms 四点；2s 扫描 | `getSurroundingBlocks`（`world.js:61-75`）；`getFirstBlockAboveHead` 32 格（`:78-115`） |
| 背包/耐久 | 背包槽、装备槽 5–8、手持耐久 | 1s 或事件 | `getInventoryCounts`（`world.js:262-282`）；装备槽（`full_state.js:38-41`）；耐久（`prismarine-item/index.js:369-383`） |
| 时间/天气 | timeOfDay、rain/thunder | 5s | `full_state.js:22-28` |
| 玩家装备 | heldItem + 4 个 armor 槽 | 事件 + 1s 兜底 | `prismarine-entity/index.js:20-21,48-54` |

```json
{
  "t": 123456,
  "self": {"pos": [12.5, 64, -3.2], "vel": [0.1, 0, 0.2], "yaw": 1.57, "health": 18, "food": 17,
           "onGround": true, "inWater": false, "inLava": false},
  "held": {"name": "iron_pickaxe", "remaining": 0.62, "count": 1},
  "armor": {"head": "iron_helmet", "chest": "iron_chestplate", "legs": null, "feet": "iron_boots"},
  "inv": {"torch": 12, "bread": 3, "cooked_beef": 2},
  "env": {"timeOfDay": 6000, "weather": "Clear", "biome": "plains",
          "below": "grass_block", "legs": "air", "head": "air", "above": "oak_leaves"},
  "seen": {"players": [{"name": "Steve", "dist": 3.2, "held": "diamond_sword",
                        "armor": ["iron_helmet", null, null, "iron_boots"], "moving": true}],
            "items": [{"name": "oak_log", "dist": 4.1}],
            "blocks": [{"name": "lava", "dist": 5.0}]},
  "near": {"hostiles": [{"type": "zombie", "dist": 11.4}], "torch": null}
}
```

开销：`getNearbyEntities` 是 O(实体数)，500ms 一次可接受；`bot.findBlocks` 半径 16 约扫 33³≈3.6 万格，半径 32 约 65³≈27.5 万格（估算），只能 2s 一次或按需，不能放进 500ms。`block.light` 在 MindCraft 里被标注为坏掉（`world.js:409`），状态 JSON 不承诺光照值。

## 6. 空闲闲逛

| 状态 | 进入条件 | 行为 | 退出条件 |
| --- | --- | --- | --- |
| IDLE_LOOK | 无跟随、无玩家交互、距上次活动 4–8s | 70% 看玩家（10 格内且有视线），否则随机 yaw ±60°、pitch -10–15° | 计时到或进入 WANDER_PICK |
| WANDER_PICK | IDLE_LOOK 计时结束 | 采样 8 个候选点，做安全与可达校验 | 找到点→WANDER_WALK；全失败→IDLE_LOOK |
| WANDER_WALK | 有目标点 | 走动，速度 walk，超时 8s | 到达 0.8 格内或超时→IDLE_LOOK |
| ATTEND | 玩家发言、玩家进入 3 格 | 立即 `setGoal(null)`，停 sprint，看向玩家 | 最后一条发言后 2s 且玩家 >3.5 格→IDLE_LOOK |
| SURVIVE | 水/岩浆/火/掉落/低血 | 中断闲逛，走脱困流程 | 危险解除→IDLE_LOOK |

选点：半径 5–9 格；地面必须是 `boundingBox === 'block'` 且非水/非岩浆；头顶两格为 `empty`；候选点 3×3×3 内无 lava/water/fire；与当前 y 高差 ≤1.5；12 格内无 hostile；离玩家 3–10 格；最后用 `isClearPath`（`canDig=false`、`canPlaceOn=false`、100ms）验证（`world.js:390-404`）。

```text
for attempt in 1..8:
  p = randomRing(center=bot.pos, r=5..9)
  ground = highestSolid(p, dy=-4..2)
  if !ground or liquidNear(p, 1) or dropFrom(bot, ground) > 1.5: continue
  if hostileWithin(12) or playerDistance(p) not in 3..10: continue
  if !isClearPath(bot, {position: p}): continue
  return p
return null
```

闲逛节奏：每次 5–9 格，走 1.2–2.1s，停 4–8s；20 秒窗口内最多 2 次，累计位移 5–10 格。玩家在 8 格内不启动闲逛；玩家说话优先于闲逛。看向玩家时更新间隔 200ms，不做每 tick `lookAt`。

## 7. 生存自动化

| 需求 | 做法 | 插件/自写 | 证据 |
| --- | --- | --- | --- |
| 自动吃 | 饥饿 ≤16 吃；≤8 强制吃；优先级按 `effectiveQuality`：牛排 20.8、金胡萝卜 20.4、面包 11、腐肉 4.8；禁腐肉/蜘蛛眼/毒土豆/河豚/生鸡肉 | 插件 `mineflayer-auto-eat`；MindCraft 配 `startAt:14`、`priority:'foodPoints'` | `agent.js:190-195`；食物数值 `bridge/node_modules/minecraft-data/minecraft-data/data/pc/1.21.1/foods.json:174-180,264-270,24-30,204-210` |
| 换武器 | 主手空/耐久 <10%/更高级武器才换；剑与斧按材料与附魔，镐只作工具；不按 `attackDamage` 排序 | 自写 | MindCraft 用 `attackDamage` 排序（`skills.js:24-34`），但 `prismarine-item` 未暴露 `attackDamage`，可见字段为 `maxDurability`、`durabilityUsed`、`enchants`（`prismarine-item/index.js:41,255-276,369-383`），该键未确认 |
| 换工具 | 当前工具 `canHarvest` 失败时换；按 `block.harvestTools` 找最低可用工具 | 自写；可参考 `bot.tool.equipForBlock` 调用点 | `skills.js:480,490-493`；`mcdata.js:356-362` |
| 插火把 | 6 格内无 torch/wall_torch、脚下 block 为 air、背包有火把；每 5s 最多 1 个；放在侧后方，避免放在脚下 | 自写 | `world.js:406-419`；`modes.js:220-236`；光照值坏掉（`world.js:409`） |
| 掉水 | 浮起，找 8 格内最近干燥岸边，直接转向游过去 | 自写 | 溺水时只按 jump（`modes.js:38-43`）；路径后处理对水有特判（`index.js:172-177`） |
| 掉岩浆 | 立即 jump + 朝最近非岩浆固体移动；有 water_bucket 先浇水；临时从 `blocksToAvoid` 移除 lava | 自写；参考 patch | 原版把 lava 加入避开集合（`movements.js:49-53`），不临时移除会无路可走；patch 的 `updateLavaAvoidance`（`:249-261`） |
| 火/落沙 | 落沙 `moveAway(2)`；火按岩浆分支（水桶/找水/`moveAway(5)`），不挖头顶落沙 | 自写 | `modes.js:44-48,49-77` |
| 护甲 | 拾取/合成后自动穿 | 插件 `mineflayer-armor-manager` | `mcdata.js:9,121`；桥接未装（`bridge/package.json:13-15`） |
| 开门 | 先 `activateBlock`，1.5s 未通过再绕行；铁门直接绕行 | 自写；或 patch `canOpenDoors` | `skills.js:1116-1179`；patch `:132-133` |

自动吃用插件最省事，但会新增依赖；桥接当前只有 `mineflayer`、`mineflayer-pathfinder`、`ws`（`bridge/package.json:13-15`）。若不扩依赖，用 `foods.json` 的 `effectiveQuality` 自写约 20 行。换武器/工具、火把、水火脱困建议自写，逻辑都在 30 行内，且能控制“像玩家”的节奏。

## 8. 反机械感

| 症状 | 现有机制 | 建议 |
| --- | --- | --- |
| 瞬间转头 | pathfinder 每 tick `bot.look(yaw,0)`（`index.js:607`）；包发送上限约 172°/s（`mineflayer/lib/plugins/physics.js:169-172`、`prismarine-physics/index.js:64`）；`force=true` 直接跳过限速（`mineflayer/lib/plugins/physics.js:350-353`） | 移动中 ≤150°/s，空闲 ≤90°/s，pitch ≤120°/s；休闲动作不用 `force=true`；180° 至少用 1.2s。 |
| 每 tick 重设 goal | `setGoal`/`setMovements` 都会 `resetPath` 清控制状态（`index.js:142-152`） | 只在状态切换或 ≥600ms 时调用；sprint 变化只改 `allowSprinting`。 |
| 一直冲刺 | `allowSprinting` 默认 true（`movements.js:34`） | 走带强制 false；CATCHUP 才 true；退出 sprint 后 1s 锁。 |
| 急停/回中 | 路径走完 `fullStop` 零速度并回方块中心（`index.js:330-345,587-595`） | 2.6 格时 `setGoal(null)`；正常停跟不用 `stop()`。 |
| 跑酷跳 | `allowParkour` 默认 true，sprint 可跳 4 格（`movements.js:33,577`）；sprint jump 自动触发（`index.js:617-619`） | 关 parkour；只在被 1 格挡住或跨 1 格沟时跳；跳跃冷却 700ms。 |
| 贴脸 | `GoalFollow` 无个人空间；MindCraft 近距离暂停 `elbow_room`（`skills.js:1378-1383`） | 1.5 格内侧移；2.2 格停；不向玩家后退挤压。 |
| 卡住不动 | MindCraft 20s 才脱困（`modes.js:100-133`）；pathfinder 3.5s 无进展才 reset（`index.js:631-635`） | 0.3s 无位移→跳；0.8s→侧移；1.5s→重寻路；2.5s→允许挖。 |
| 视线水平 | pathfinder 固定 pitch 0（`index.js:607`） | 走路看前方 10–20 格地面；停下看玩家脸；每 200ms 更新目标。 |
| 同步感 | 所有 bot 250ms 同相位 | 控制器加 0–80ms 抖动；停顿 4–8s 随机；避免全体同向转头。 |

被方块挡住时的顺序：先确认前方脚/头方块，能跳就跳（冷却 700ms）；跳不过就左右各探 1 格，选空的一侧侧移 400ms；两侧都堵就重寻路（`canDig=false`）；2.5s 仍无路才允许挖，且只挖 `safeToBreak` 且不在 `blocksCantBreak` 的方块（`movements.js:41-47,252-274`）。

## 9. 验收场景

| # | 场景 | 通过标准 |
| --- | --- | --- |
| 1 | 玩家绕一棵树走一圈（半径 3，20s） | 卡住（位移 <0.1 且 >1s）≤1 次；重寻路 ≤3 次；结束距离 2.0–3.5 格。 |
| 2 | 玩家 sprint 直线 30 格 | 玩家起步到 bot `sprint=true` ≤2s；最大距离 ≤12 格；玩家停后 3s 内回到 ≤3.5 格。 |
| 3 | 玩家从 sprint 急停 | bot 2.5s 内停；最终 2.0–2.6 格；不越过 1.5 格；前后摆动 ≤1 格。 |
| 4 | 平地匀速走 60s | 距离 p50 2.2–3.2、p95 <4.0；sprint 占比 <10%；无每 2s 一次的启停。 |
| 5 | 无玩家交互空闲 20s | 水平位移 5–10 格；行程 1–2 次；每次停 ≥3s；不踩水/岩浆/>1 格落差。 |
| 6 | 玩家在 6 格处发言并走到 2 格 | 300ms 内停止闲逛；500ms 内看向玩家；发言后 2s 且 >3.5 格才恢复。 |
| 7 | 木门房屋，玩家穿过门 | 1.5s 内开门通过；不挖门；铁门场景改为绕行且不撞门。 |
| 8 | 饥饿 14、工具耐久 <10%、黑暗处、掉岩浆 | 1s 内开始吃；工具在 `canHarvest` 失败前更换；2s 内插火把且 5s 内不重复；岩浆 4s 内脱困且掉血 ≤4。 |

每个场景记录 `follow_gap`、`sprint_on`、`repath_count`、`stuck_ms`、`path_status`、`yaw_rate` 六个指标；用同一 seed 的世界与固定坐标复现。验收前先做 A/B：旧 `GoalFollow` 与新控制器各跑 5 次，比较 p50/p95。

## 10. 风险与未确认

- GoalFollow 锚点语义是结构性问题；自定义 goal 必须实现 `isEnd`（实时距离）、`hasChanged`（节流 + 锚点位移）、`isValid`（实体存在），参考基类接口 `goals.js:5-27`。
- 旧快照的 `allowSprint` 已在当前编辑中改为 `allowSprinting`（`bridge/minecraft_bridge.js:615` 快照）；合并前再 grep 一次，避免回退。
- 服务端 view-distance/entity tracking 决定 32 格数据是否完整；本仓库基准用视距 4（`docs/BENCHMARK_RESULTS.md:97`）。`seen` 为空不能当成“世界中没有”；`block.light` 不可用（`world.js:409`），火把只能按“附近 6 格无火把”判断。
- 高频重寻路与转头可能触发 Paper 包限速；MindCraft 把位置包压到 50ms（`mcdata.js:70-98`），控制频率保持 250ms 以上。
- 自动吃/护甲插件版本与桥接 mineflayer 4.24 的兼容性未验证；MindCraft 用的是 mineflayer 4.33（`package.json:21`）。
