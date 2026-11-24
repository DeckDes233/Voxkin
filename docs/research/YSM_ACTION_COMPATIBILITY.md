# YSM 接入对 21 个游戏动作的兼容性（只读调研）

调研时间：2026-10-22。范围：`bridge/minecraft_bridge.js` 的 21 个动作、`bridge/skills/manifest.js` 的技能清单、本机 YSM 2.6.2 模组、`D:\AI\middleapi`、`D:\AI\MiddleMod&Plugin`、`D:\AI\特雷西娅ysm格式文件`、`D:\AI\特雷西娅  魔王AI.zip`。只读调研，未修改 `bridge/`、`src/`、`mod/` 下任何文件，未做 git 操作。

约定：行号以 2026-10-22 的工作区快照为准；本机路径用 `C:\Users\deckd\AppData\Roaming\.minecraft\...` 表示。凡是素材无法证实的内容，一律标注「本机素材未覆盖，需要查证」。

## 1. 结论

接入 YSM 不会让沃心的 21 个动作失效：在「bot 继续保持协议层假玩家、模型在服务端或观察者客户端侧解决」这个前提下，21 个动作全部可用，其中 17 个完全不受影响，4 个存在耦合点但都能恢复，0 个不可用。

原因是 YSM 作用在渲染层，沃心的动作作用在协议层与服务端状态上，两者没有交集。

| 分类 | 数量 | 动作 |
| --- | --- | --- |
| 完全不受影响 | 17 | observe、inventory、locate_block、locate_entity、look_at_player、goto、goto_block、follow_player、come_to_player、stop、chat、collect_blocks、break_block、place_block、pickup_items、craft、smelt |
| 受影响但可恢复 | 4 | eat、sleep、attack_nearest、attack_target |
| 不可用 | 0 | 无 |

## 2. YSM 处在哪一层

### 2.1 本机 YSM 的构成

本机安装的是 Forge 版 YSM 2.6.2：

| 事实 | 出处 |
| --- | --- |
| 模组加载器是 Forge，版本范围 Minecraft `[1.20,1.20.2)` | `…\mods\[是，史蒂夫模型] ysm-2.6.2-forge+mc1.20.1-release.jar` 内 `META-INF/mods.toml` |
| 渲染相关改动全部在 client mixin 清单里：`LivingRendererMixin`、`EntityRenderDispatcherMixin`、`WorldRendererMixin`、`LivingEntityAccessor` 等 | 同上 jar 内 `yes_steve_model.mixins.json` |
| 通用 mixin 只有 `AbstractArrowEntityMixin`、`ProjectileEntityMixin`、`ServerPlayerMixin` | 同上 |
| `ServerPlayerMixin` 只改两处：`startRiding` 与 `positionRider` | 同上 jar 内 `yes_steve_model.refmap.json` 的 `com/elfmcys/yesstevemodel/mixin/ServerPlayerMixin` 条目 |
| 模型渲染依赖原生库 `META-INF/native/ysm-core.dll` 与 `libysm-core.so` | 同上 jar 条目 |
| 服务端存在一份每世界配置 `yes_steve_model-server.toml`，字段含 `DefaultModelId`、`DefaultModelId`、`CanSwitchModel`、`ClientNotDisplayModels` | `…\saves\新的世界 (3)\serverconfig\yes_steve_model-server.toml:1-30` |
| 玩家与模型的绑定持久化在玩家 NBT 的 Forge capability 里，键名 `yes_steve_model:model_id`、`yes_steve_model:own_models`、`yes_steve_model:star_models` | `…\saves\新的世界 (3)\playerdata\6a309310-71ae-4b52-91d4-ec12398d0b78.dat`（gzip 解压后字符串扫描） |
| 服务端与客户端之间用 Forge `SimpleChannel` 通信，通道名 `yes_steve_model`，协议版本 `2.6.0`，方向 `PLAY_TO_CLIENT` 与 `PLAY_TO_SERVER` | jar 内 `com/elfmcys/yesstevemodel/OoO0oOoOO0Oo0o0O0o0OoOOO.class` 常量池 |
| 推送时机挂在 `PlayerEvent$StartTracking`、`EntityJoinLevelEvent`、`TickEvent$ServerTickEvent`、`PlayerEvent$Clone` | jar 内 `com/elfmcys/yesstevemodel/OO000oO0OO00OOoOOooOOooO.class` 常量池 |
| 客户端会缓存服务端下发的模型，`cache\server\` 按 SHA-256 命名，`cache\client\<服务器标识>\<SHA-256>` 是本地副本 | `…\config\yes_steve_model\cache\` 目录结构 |

结论：YSM 的服务端组件负责「把哪个玩家用哪个模型」告诉观察客户端，观察客户端的渲染器负责画出来。模型数据走 plugin message 通道 `yes_steve_model`，与 vanilla 的实体 metadata、skin URL、资源包都不是一回事。

### 2.2 沃心的 bot 在哪一层

| 事实 | 出处 |
| --- | --- |
| bot 是 mineflayer 协议客户端，默认离线模式，用户名 `Voxkin` | `bridge/minecraft_bridge.js:13-17` |
| 桥接不设置 skin、不写 entity metadata、不发 plugin message、不下载资源包 | 对 `bridge/minecraft_bridge.js` 搜 `skin` / `profile` / `plugin_message` / `resource_pack` / `set_skin`，命中的 4 处全是物品 NBT 的 data value（`:1135`、`:1297`、`:1301`、`:1318`） |
| mineflayer 依赖里没有任何渲染侧包，没有 `prismarine-viewer`、没有 `minecraft-assets` | `bridge/node_modules/mineflayer/package.json` 的 `dependencies` 全文 |
| mineflayer 对资源包只应答不下载 | `bridge/node_modules/mineflayer/lib/plugins/resource_pack.js:57-84` |
| mineflayer 只把其它玩家的 skin URL 解析成字符串存进 `player.skinData`，从不下载 | `bridge/node_modules/mineflayer/lib/plugins/entities.js:946-972`，挂载点 `:620`、`:681` |
| `minecraft-data` 的 1.21.1 数据目录只有 JSON，没有贴图与模型 | `bridge/node_modules/minecraft-data/minecraft-data/data/pc/1.21.1/` |
| 桥接登录时唯一的「外观」信息是 `settings` 包里的 `skinParts` 位掩码，默认 127（全图层开启） | `bridge/node_modules/mineflayer/lib/plugins/settings.js:47-53`、`:78-88`；`bridge/node_modules/minecraft-protocol/src/client/play.js:64-73` |

由此得出：bot 进程里没有渲染器，没有方块模型、物品模型、实体贴图，也没有任何一个动作读取这些资源。21 个动作全部靠协议包加服务端状态完成。

### 2.3 「接入 YSM 模型」具体要做什么

在当前架构里，接入 YSM 落在观察侧，bot 侧基本无感。可选的落点有三处：

1. 观察者客户端本地指派：观察者装了 YSM，在它的界面里把模型指派给玩家名 `Voxkin`。仓库已有同样描述：`docs/ENTER_MINECRAFT_CN.md:222-224`。
2. 服务端绑定：服务端跑 YSM 的 Forge 组件，用命令或直接改玩家 NBT 的 `yes_steve_model:model_id` 给 bot 绑定模型，服务端在 `PlayerEvent$StartTracking` 时推给观察客户端。
3. 自定义实体路线：服务端注册一个 NPC 实体，用 `SynchedEntityData` 下发皮肤名，客户端 renderer 取贴图。本机 `D:\AI\untitled` 是这个范式：`production\entity\DreamNpc.java:28-29`、`:48`、`:67-68`，`production\entity\client\DreamNpcRenderer.java:34-36`。这条路会把 bot 从 Player 实体换成自定义实体，身份与寻址都要重做。

## 3. 21 个动作的逐条评估

判定前提：bot 保持 mineflayer 协议层假玩家，模型在服务端或观察者客户端侧解决。

### 3.1 完全不受影响（17 个）

这些动作只读服务端世界、实体、背包，或只写位置、朝向、聊天、容器点击。YSM 不改变任何一项服务端状态。

| 动作 | 分支行号 | 依赖 | 为什么不受影响 |
| --- | --- | --- | --- |
| observe | `:314` | 坐标、血量、饥饿、时刻、背包、附近实体 | 全部是服务端下发的状态 |
| inventory | `:307` | 背包物品栈 | 服务端容器状态 |
| locate_block | `:359` | 世界方块数据 | 服务端区块数据 |
| locate_entity | `:362` | 实体位置与类型名 | 服务端实体与玩家列表 |
| look_at_player | `:374` | 玩家位置、yaw/pitch | 朝向是协议包，服务端不校验外观 |
| goto | `:344` | 区块、方块、位置 | 移动由服务端碰撞与方块决定 |
| goto_block | `:356` | 目标方块位置 | 同上 |
| follow_player | `:289` | 目标玩家位置 | 跟随只读位置 |
| come_to_player | `:297` | 目标玩家位置 | 同上 |
| stop | `:285` | 移动控制态 | 服务端只关心位置 |
| chat | `:281` | 服务器聊天转发 | 与外观无关 |
| collect_blocks | `:347` | 方块、掉落物实体、背包 | 掉落物是服务端实体 |
| break_block | `:350` | 方块、位置 | `block_dig` 是协议包 |
| place_block | `:353` | 目标方块、手持物品 | `block_place` 只带 location、direction、heldItem、cursor，服务端用 bot 自报的眼高与朝向做射线 |
| pickup_items | `:365` | 掉落物实体、背包 | 拾取由服务端结算 |
| craft | `:368` | 背包、服务端配方、工作台窗口 | `window_click` 是容器协议 |
| smelt | `:371` | 熔炉窗口与服务端进度条 | 同上 |

补充依据：挖掘时服务端判定依据是 `block_dig`，手臂动画 `arm_animation` 只用于显示（`bridge/node_modules/mineflayer/lib/plugins/digging.js:130-153`）；放置时服务端判定依据是 `block_place`（`bridge/node_modules/mineflayer/lib/plugins/generic_place.js:74-86`）；进食时 1.21.1 走 `use_item` 包（`bridge/node_modules/mineflayer/lib/plugins/inventory.js:133-142`）；攻击时 1.21.1 走 `use_entity` 包（`bridge/node_modules/mineflayer/lib/plugins/entities.js:911-928`）。

### 3.2 受影响但可恢复（4 个）

| 动作 | 受影响点 | 恢复办法 |
| --- | --- | --- |
| eat | 服务端依据是物品消耗与饥饿值，1.21.1 走 `use_item`（`bridge/node_modules/mineflayer/lib/plugins/inventory.js:133-142`），模型不影响判定。但「进食动画」由客户端渲染，YSM 接管动画后，视觉节奏会与真实进食脱节 | 动画与动作解耦：服务端结算完成即视为动作成功，动画节奏交给渲染层。仓库里「YSM 动作联动」本来就是独立任务（`docs/ROADMAP.md:40`），不与本动作耦合 |
| sleep | 服务端用方块实体与玩家坐标判定床是否被占用，躺姿由服务端下发 metadata（`bridge/node_modules/mineflayer/lib/plugins/bed.js:176-181`）。YSM 客户端用自己的模型渲染睡姿，视觉与服务端姿态可能不一致 | 以服务端 metadata 为准，`bot.isSleeping` 作为唯一成功信号。若观测到不一致，把 YSM 的睡姿动画关掉 |
| attack_nearest | 1.21.1 的攻击顺序是 `use_entity` 在前、`arm_animation` 在后（`bridge/node_modules/mineflayer/lib/plugins/entities.js:911-928`），服务端不校验手臂动画。YSM 会用自己的动画替换挥臂表现 | 服务端判定不受影响。若走自定义 NPC 路线，寻址要改成实体 id |
| attack_target | 同上，另外还依赖实体 id 寻址（`bridge/minecraft_bridge.js:2398`） | 同上 |

### 3.3 不可用（0 个）

在判定前提下，没有动作会因为接入 YSM 而失效。

需要单独说明一种方案风险：如果把 bot 换成一个装了 YSM 的真客户端，而不是继续用 mineflayer 协议客户端，那么 21 个动作的实现全部作废，需要按真客户端重写。这是方案选择的后果，与 YSM 模组本身无关。

### 3.4 需要查证的服务端侧事项

1. 1.21.1 服务端对 `block_place` 的射线校验，以及服务端插件是否给 `use_item`、`use_entity`、`block_dig` 附加校验。客户端代码里看不到这些。
2. `use_entity` 的 `sneaking` 字段取自 `bot.getControlState('sneak')`，而桥接从不设置 sneak（`bridge/node_modules/mineflayer/lib/plugins/entities.js:922-928`），该字段恒为 false。需要确认目标服务端是否依赖它。
3. `use_item` 的 `rotation` 字段取自本地 yaw 与 pitch（`bridge/node_modules/mineflayer/lib/plugins/inventory.js:137-140`），需要确认反作弊是否额外校验。
4. 服务端下发 `yes_steve_model` 通道的 plugin message 时，mineflayer 是否会断连。桥接目前没有任何相关处理代码，需要实机联调。
5. YSM 是否改变玩家实体的眼高或碰撞箱。桥接多处依赖 `bot.entity.eyeHeight`，若眼高变化会改变放置射线与挖掘距离判定。
6. 离线模式下服务端按 `OfflinePlayer:<名字>` 生成 UUID，名字固定则 UUID 固定；若改用正版账号认证，`bot.players` 的 uuid 与 username 与实体 id 的关联会走真实会话（`bridge/node_modules/mineflayer/lib/plugins/entities.js:610-651`、`:662-694`）。

## 4. MiddleMod 与 MiddleAPI 的角色

### 4.1 本机素材的结论

这两个项目与玩家模型没有交集，它们解决的是「TTS 音频怎么在游戏里播出来」。

| 项目 | 是什么 | 出处 |
| --- | --- | --- |
| MiddleAPI | FastAPI 应用，暴露 `/chat/completions`、`/audio/speech`、`/app/setconfig` 等 HTTP 接口，把生成的 wav 落到 `config/tts_audio_storage` | `D:\AI\middleapi\MiddleAPI-new\MiddleAPI\MiddleAPI.py:42`、`:112`、`:128`、`:150`、`:203`、`:237`、`:282` |
| MiddleMod | Fabric 服务端 mod，`fabric.mod.json` 里 `environment` 是 `server`，监听 `middleapi/config/tts_audio_storage`，用 `javax.sound.sampled.Clip` 播放 | `D:\AI\MiddleMod&Plugin\MiddleMod\src\main\resources\fabric.mod.json:11`、`:18`；`…\utils\TTSAutoPlayer.java:22`、`:84-98` |
| MiddleModClient | Fabric 客户端 mod，机制与 MiddleMod 相同 | `D:\AI\MiddleMod&Plugin\MiddleModClient\src\main\resources\fabric.mod.json:9`；`…\utils\TTSAutoPlayer.java:27` |
| MiddlePlugin1.21 与 MiddlePluginFor1.20.1 | Bukkit 插件，机制同上，目录分别是 `middleapi1/tts_audio_storage` 与 `middleapi/config/tts_audio_storage` | `D:\AI\MiddleMod&Plugin\MiddlePlugin1.21\src\main\java\org\examples\middlePlugin\utils\TTSAutoPlayer.java:23`；`MiddlePluginFor1.20.1\…\TTSAutoPlayer.java:23` |

对 `D:\AI\MiddleMod&Plugin` 全部源码搜 `ysm`、`YesSteve`、`skin`、`model_id`、`CustomPayload`、`plugin_message`、`setSkin`、`NPC`，命中数为 0。三个 jar 内也只有配置类与播放类，没有网络包类。

### 4.2 特蕾西娅素材的归属

| 路径 | 内容 | 与 YSM 的关系 |
| --- | --- | --- |
| `D:\AI\特蕾西娅ysm格式文件` | 空目录，递归计数 0 | 无 |
| `D:\AI\特蕾西娅  魔王AI.zip`（文件名实为「特雷西娅」） | 三个条目：`GPT_weights/小特.ckpt`、`SoVITS_weights/小特.pth`、`阅读我注意事项.txt` | 语音克隆权重，与 YSM 无关 |
| `…\config\yes_steve_model\custom\Therasa.ysm` | YSM 模型包，头部 `YSGP`，`<name> 特蕾西娅`，`<hash> 1dd2d169c5b49b721aca936257ffc14e`，格式版本 9，加密版本 3 | 这才是特蕾西娅的 YSM 模型 |

### 4.3 结论

模型不由 MiddleMod 或 MiddleAPI 注入。它们的耦合点是文件系统里的音频目录，与模型分发无关。仓库也把两件事分开列：`docs/ROADMAP.md:40` 把「YSM 动作联动」列为 P2，`docs/TECH_EVALUATION.md:95` 标记 YSM 联动为未验证，`docs/BENCHMARK_RESULTS.md:145` 记录多人空间音频与 YSM 联动未实现。

## 5. 可行路径

目标：别人看到沃心时是特蕾西娅的样子。

### 路径 A：观察者客户端本地指派

- 组件：观察者客户端装 YSM 1.21.1 版本，把 `Therasa.ysm` 放进 YSM 模型目录，在 YSM 界面里把模型指派给玩家名 `Voxkin`。
- 改动：零代码改动。服务端保持 Paper 1.21.1，bot 保持 mineflayer。
- 代价：每个观察者都要各配一次；未装 YSM 的玩家看到的是默认皮肤；本机现有实例是 Forge 1.20.1 的重度整合包，需要为 1.21.1 另备客户端。
- 风险：最低。这是 `docs/ENTER_MINECRAFT_CN.md:222-224` 已经描述过的做法。

### 路径 B：服务端绑定 + 客户端同步

- 组件：服务端换成 Forge 1.20.1 并装 YSM 服务端组件，模型放服务端，客户端装 YSM 客户端组件；用服务端命令或直接改 `playerdata/<uuid>.dat` 的 `yes_steve_model:model_id` 给 bot 绑定。
- 改动：服务端换实现（成本最大），bot 侧零改动。
- 代价：Paper 装不了 Forge 的 YSM 服务端组件，除非 YSM 有 Paper 实现，这一点本机素材未覆盖，需要查证。
- 风险：服务端换实现会影响 M0 到 M8 的全部验收脚本与基准数据，换型要重跑所有阶段。

### 路径 C：自定义 NPC 实体

- 组件：服务端注册 NPC 实体并下发皮肤名，客户端注册 renderer。
- 改动：bot 身份从 Player 实体换成自定义实体，21 个动作里的寻址、交互、战斗全部要改。
- 代价：最高。
- 风险：与独立通关主线冲突最大，属于 P2。

### 路径 D：客户端 Mod 统一渲染

- 组件：把特蕾西娅的模型与贴图并入 `mod/`（Fabric 1.21.1 客户端 Mod），由 Voxkin 自己的 Mod 渲染 bot。
- 改动：只改 `mod/`，服务端与桥接不动。
- 代价：需要把加密的 `.ysm` 拆成模型与贴图资源，`.ysm` 的负载是加密的（格式版本 9，加密版本 3），本机没有解密工具，拆包这一步需要额外手段。
- 风险：只对装了 Voxkin Mod 的客户端有效，收益范围与路径 A 相当。

综合推荐：先走路径 A，用 1.21.1 版本的 YSM 把观感问题解决掉；路径 B 与 C 留到独立通关主线走完之后再评估。

## 6. 对独立通关主线的影响

不阻塞。

- YSM 不改服务端世界、实体、背包、容器的任何状态，21 个动作的服务端语义全部保留。
- 阶段表 S0 到 S6 依赖的是背包产出、坐标、维度、方块四类判定（`src/voxkin/agent/progress.py:16` 的阶段表），这四类都不受渲染层影响。
- 仓库已经把 YSM 相关工作排在 P2：`docs/ROADMAP.md:40` 的「YSM 动作联动」，`docs/plans/INDEPENDENT_RUN_ROADMAP.md` 的 M0 到 M8 阶段表里没有 YSM 相关条目。
- 唯一需要在主线里留意的一点：服务端若装 YSM 组件，会在 `PlayerEvent$StartTracking` 时向观察客户端推送模型数据，占用 plugin message 通道带宽；这与 Paper 服无关，与 Forge 服务端路线相关。

## 7. 待查证清单

| 事项 | 状态 |
| --- | --- |
| YSM 是否有 Paper 或 Bukkit 版服务端实现 | 本机素材未覆盖，需要查证 |
| 服务端模型目录的确切路径与文件名 | 类名混淆，只能确认 `model`、`players`、`custom`、`cache`、`export`、`auth` 这些字面量，需要查证 |
| 服务端把模型指派给玩家的命令语法 | 常量池里命令根被混淆，lang 只给了消息文案，需要实机查 `/help` |
| `PlayerEvent$StartTracking` 下发的包体结构 | 17 个消息类型职责被混淆，需要查证 |
| `server_index` 与 `cache\server` 的二进制格式 | 加密或压缩二进制，本机无法解析 |
| mineflayer 收到 `yes_steve_model` 通道的 plugin message 会不会断连 | 桥接无相关处理代码，需要实机联调 |
| YSM 1.21.1 版本的获取方式与 Fabric 加载器适配 | 本机只有 Forge 1.20.1 版本，需要查证并获取 |
| `.ysm` 的加密算法与 `YSGP` 负载格式 | 本机无解密工具，需要查证 |
| YSM 是否有「由音频驱动嘴型」的公开接口 | jar 内有 `playerAnim` 依赖与大量动画文件，没有找到接口定义，需要查证 |
| `D:\AI\middleapi\MiddleAPI.7z` 与 `MiddleAPI（一键包）.7z` 内是否另有 Minecraft 相关组件 | 未解压，需要查证 |
