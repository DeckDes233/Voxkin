# 桥接技能模块契约（bridge/skills/*.js）

状态：2026-10-22 起生效。目标是把 `bridge/minecraft_bridge.js` 里按 `switch (message.tool)` 平铺的分支，逐段拆成独立模块，让并行开发不再争抢同一个文件。

## 1. 文件与导出

每个模块是独立 ESM 文件，放在 `bridge/skills/` 下，导出形状固定：

```js
export const skills = {
  <skill_id>: {
    description: '一句话中文描述',
    parameters: [
      { name: 'count', type: 'number', required: false, default: 1, description: '...' },
    ],
    handler: async (args, ctx) => {
      // 返回 { detail: '中文结果描述', status: 'succeeded' }
    },
  },
};
```

- `skill_id` 必须与 `bridge/skills/manifest.js` 里已登记的 id 一致；新增 id 要同步登记。
- `handler` 抛错即视为失败，桥接会把它映射成 `partial` / `blocked` / `cancelled` / `failed`（见 `minecraft_bridge.js` 的 `statusForError`）。错误信息用中文，并尽量包含「还差」「没有」这类关键词，让状态分类稳定。
- 模块之间不互相 import；需要的能力都从 `ctx` 拿。

## 2. ctx 字段

`ctx` 由 `minecraft_bridge.js` 在启动时构造并传入，字段来自现有顶层函数。签名以现有实现为准，实现位置在 `bridge/minecraft_bridge.js`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bot` | mineflayer bot | 当前 bot 实例 |
| `log` | `(...args) => void` | 桥接日志 |
| `sleep` | `(ms) => Promise` | 延时 |
| `blockLabel` / `itemLabel` | `(name) => string` | 物品与方块的中文名 |
| `travelTo` | `(x, y, z, radius=2) => Promise` | 走到某坐标 |
| `travelToBlock` | `(position, timeoutMs) => Promise` | 走到某个方块附近 |
| `walkOnce` | `(x, y, z, radius, timeoutMs) => Promise` | 走一步 |
| `collectDrops` | `(range, expectName) => Promise` | 捡掉落物 |
| `countItem` | `(name) => number` | 背包里某物品数量 |
| `syncInventory` | `() => Promise` | 与服务端同步背包 |
| `nearbyBlock` | `(name, range) => block \| null` | 附近方块 |
| `equipToolFor` | `(block) => Promise` | 按方块切换工具 |
| `equipWeapon` | `() => Promise` | 切到最强武器 |
| `breakBlock` / `placeBlock` / `pickupItems` | `(args) => Promise<string>` | 已有动作实现，可复用 |
| `placeBlockWithFacing` | `(name, target, yaw) => Promise<string>` | 按指定视角放置方块，床与门框这类有朝向要求的方块用它 |
| `placeInventoryBlock` | `(name, label) => Promise` | 从背包取出并放置方块 |
| `placeCraftingTable` / `recoverPlacedTable` | `() => Promise` / `(table) => Promise` | 工作台放置与回收 |
| `clickWindowSlot` | `(window, slot, mouseButton, mode) => Promise` | 容器格子点击 |
| `craftWithWindow` | `(recipe, window, width, height, times) => Promise` | 按配方合成 |
| `pickRecipe` / `materialsShortage` / `recipeRequirements` / `missingMaterials` | 配方辅助 | 材料核对 |
| `findFuelItem` | `() => item \| null` | 找可用燃料 |
| `craftItem` / `smeltItem` | `(args) => Promise<string>` | 已有动作实现，可复用 |
| `findFoodForEating` / `findFood` | 食物选择 | 食物优先级 |
| `eatFood` | `(args) => Promise<string>` | 已有动作实现 |
| `findNearbyBed` | `(range) => block \| null` | 找床 |
| `sleepInBed` / `isSleepTime` / `isThunderstorm` / `sleepErrorText` | 睡觉 | 过夜判定 |
| `approach` / `retreatFrom` / `attackEntity` / `defendAgainst` | 战斗原语 | 近战与撤退 |
| `findRangedWeapon` / `aimPoint` / `shootAt` | 远程原语 | 弓与投射物 |
| `nearbyPlayers` / `nearbyHostiles` | `(radius, limit) => Array` | 附近实体 |
| `entityMatches` / `entityDisplayName` / `entityTypeLabel` / `playerNameOf` | 实体查询 | |
| `findHostile` / `findAttackTarget` / `resolvePlayer` | 目标选择 | |
| `isNearDanger` / `escapeEnvironment` / `blockIsWater` / `findShore` / `swimToShore` | 环境避险 | |
| `describeEntity` | `(entity) => string` | 实体中文描述 |
| `INDEPENDENT` | boolean | 独立模式开关 |
| `registry` | object | `bot.registry` 的快捷访问 |

约定：

- 只用上表的字段。需要新能力时，先自己在模块内实现，或把缺口写进模块头部的「待接入」注释，由集成阶段补 `ctx`。
- 调用 `ctx` 上可能不存在的可选能力时，用 `typeof ctx.xxx === 'function'` 判断后再调用。
- 不要在模块里直接 `require` / `import` mineflayer 或其它运行时依赖；`bot` 从 `ctx` 取。

## 3. 集成方式

- `bridge/skills/registry.js` 扫描 `bridge/skills/` 目录，动态 import 每个模块，合并所有 `skills` 映射。
- `minecraft_bridge.js` 在 `switch` 的 default 分支里查注册表，命中就调用 `handler(args, ctx)`。
- 新增技能只需要两件事：新建模块文件、跑一次 `node scripts/merge_module_skills.js`。
- `scripts/merge_module_skills.js` 把模块里的技能写进 `manifest.js` 的生成区间（两个标记之间），再由 `node scripts/dump_manifest.js` 生成 `manifest.json`。清单是 Core 侧工具 schema 的来源。
- 注册表对单个模块的加载失败是容错的：一个模块写坏了不会拖垮桥接，错误会打到日志里。技能 id 重名时保留先加载的那条并记一条失败。

## 4. 约束

- 模块里不写死绝对路径，不读环境变量，不连外部服务。
- 每个模块只负责一个领域：采集、合成、生存、战斗、移动、箱子、下界、末地。
- 注释用中文，术语保留 English。
- 提交前跑 `node --check bridge/skills/<模块>.js`。
