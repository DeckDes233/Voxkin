# 基准结果

所有数字来自本机真实运行。标注「本地测试 LLM」的结果不包含真实网络与真实模型的首 token 延迟。

## Minecraft 状态快照与进度查询（2026-11-27）

### Bridge 地下出口观察

在 Windows i9-14900HX 上使用 Node 22.23.4、`--jitless` 和 CPU 亲和掩码 `0xFF000000`。同一进程分别加载提交 `ddc7205` 和工作区版本的 `createObservation`，各自在相同内容的 Java 1.21.1 Prismarine 内存区块上执行。角色站在 (8.5, 62, 8.5)，地板在 Y=61。地下场景在 Y=87 加一层石顶，岩层场景另在 Y=65–86 填石。每个场景先核对两个完整快照一致，两版各预热 35 次，随后交替调换执行顺序，各测 11 批、每批 120 次。耗时取 11 个批次单次平均值的中位数。

| 地形 | 基线 ms/快照 | 本次 ms/快照 | 完整方块读取次数（基线 → 本次） | 类型索引读取次数（基线 → 本次） |
| --- | ---: | ---: | ---: | ---: |
| 地下空腔 | 1.401 | 0.212 | 242 → 7 | 0 → 120 |
| 地下岩层 | 0.623 | 0.223 | 132 → 7 | 0 → 120 |
| 露天地表 | 0.135 | 0.140 | 22 → 22 | 0 → 0 |

地下扫描先按类型筛出可能有支撑的落脚点，再读取完整方块验证碰撞、头部空间与天光。露天地表继续使用原有的提前返回路径。运行脚本与逐批样本保存在 `work/nov27_observation_bench/compare.cjs` 和 `work/nov27_observation_bench/result.json`。这组数据衡量本地观察函数，测试期间未运行 Minecraft 服务端、LLM 或 TTS。

### Core 运行进度查询

使用同机 Windows build 22631、CPython 3.10.0、SQLite 3.35.5。以 SQLite backup 从封存的 `work/live_adaptive_20261122/nov27_wood_1113/core/data/tasks.db` 创建两份独立的磁盘副本，分别执行 `ddc7205` 和本次实现，后者先运行初始化建立局部索引。两版返回值一致。每个方法预热 10 次，随后在同一进程用 `perf_counter_ns` 测量 101 对样本并交替调换顺序。表内为单次调用耗时的中位数。

| 存档任务 | 历史记录 / 目标完成事件 | 目标状态 JSON 字节 | 完成事件查询 ms（基线 → 本次） | RunManager.status ms（基线 → 本次） |
| --- | ---: | ---: | ---: | ---: |
| S3，任务 4 | 573 / 6 | 305798 | 2.3930 → 0.0834 | 6.7368 → 3.2617 |
| S4，任务 5 | 748 / 0 | 390306 | 3.5662 → 0.0759 | 7.5075 → 3.7291 |

复现脚本与原始纳秒样本分别在 `work/task_store_20261127/measure.py` 和 `work/task_store_20261127/measurements.json`。本组只调用本地查询，未启动 Minecraft、LLM 或 TTS。

### Studio 阶段面板轮询

在上述 S3、S4 存档的 SQLite 副本上，用同一份角色观察请求默认 `GET /api/run/status` 和 Studio 的 `?view=studio`。两端均走本机 aiohttp HTTP 服务，每个视图预热 10 次，再交替请求 101 对。字节数是未压缩的实际响应正文，耗时从客户端发起 GET 到读完整个正文。用 Chromium 运行仓库中的 Studio，逐项比较阶段面板文字及启动、续跑、停止按钮的可用状态，两份存档的新旧视图显示一致。

| 存档 | 完整响应（字节） | Studio 响应（字节） | 本机 HTTP 中位耗时（完整 → Studio） |
| --- | ---: | ---: | ---: |
| S3，任务 4 | 322466 | 477 | 7.209 → 3.344 ms |
| S4，任务 5 | 412995 | 489 | 8.851 → 4.340 ms |

Studio 每 1.5 秒读取一次阶段面板，另一个每 3 秒的引擎状态请求现在只读取该面板用到的引擎信息。上表只计阶段面板请求。此测试未启动 Minecraft、LLM 或 TTS。复现脚本与样本为 `work/task_store_20261127/studio_response.py` 和同目录 `studio_response.json`。

### Core 阶段观察验收与 SQLite 提交

使用上述 S3、S4 存档，两份磁盘副本都已建索引，并使用相同的完成事件查询实现。基准将任务恢复为 active，向 `GoalSupervisor.run` 中的观察验收代码重复传入同一份末次观察。计时覆盖验收判断和 SQLite 提交，两版各预热 10 次，再交替测量 101 对样本。两版返回的完成状态和原因一致，持久化的目标状态仅更新时间戳有差异。

| 存档任务 | 每轮提交次数（基线 → 本次） | 基线中位数 ms | 本次中位数 ms |
| --- | ---: | ---: | ---: |
| S3，任务 4 | 2 → 1 | 35.3091 | 17.5224 |
| S4，任务 5 | 2 → 1 | 46.8555 | 23.8199 |

本次计时在派发、网络调用和等待之前结束，未启动 Minecraft、LLM 或 TTS。复现脚本与逐次样本保存在 `work/task_store_20261127/measure_observation.py` 和 `work/task_store_20261127/observation_measurements.json`。

### 普通生存中的策略决策与并发背包查询

2026-11-27 在本机运行无头 Paper 1.21.1、Temurin 21.0.12.1 和 Node 22.23.4（`--jitless`，进程亲和掩码 `0xFF000000`）。S0 从种子 `20261022` 的全新普通难度生存世界开始，关闭 LLM，使用静音 TTS。采木动作 `37b6c2bcae4f` 执行时，通过 Core 的动作仲裁器发起背包查询。查询返回空背包，提交前、回执内和返回后的执行器记录均为同一采木动作。随后角色收获 5 块橡木原木，7 个动作后持有工作台和木镐，S0 验收通过，生命值为 20。记录保存在 `work/live_adaptive_20261122/nov27_body_ci_s0/result.json`。

S2 使用先前普通生存存档 `nov27_full_1145` 的副本，新建独立的自适应预算任务。起点在白天的干地，生命值 17、饥饿值 12，背包里有 3 块白色羊毛、4 块羊肉和 16 块泥土。角色实际搜索 64 格后报告找不到树。Core 在准备扩大到 128 格时请求策略，回环 HTTP 测试服务从继续搜索、换区采木和先吃东西中选择了 `relocate_wood`。该服务返回带有本次决策 ID 的固定 JSON，响应前人为等待 300 ms。角色沿干地从 (139.35, 64, 225.35) 走到 (156.41, 64, 225.50)，水平移动 17.1 格，SQLite 记录动作成功。专项运行在核实换区后停止，S2 的阶段验收仍待完成。

| 实机观察点 | 背包查询往返时间 | 回执中观察到的状态 |
| --- | ---: | --- |
| 入服后首次 64 格采木搜索期间提交 | 4,208.15 ms | 搜索已结束，查询返回完整背包 |
| 第一次重大决策等待回复期间提交 | 44.10 ms | HTTP 测试服务仍在处理同一决策请求 |
| 换区途中提交 | 550.92 ms | 查询前、回执内和返回后均为同一换区动作 `a6ec65aa384c` |

用 `perf_counter` 测量从提交 `inventory` 到收到 Core 动作结果的间隔，每行各一次。首次查询处于入服区块加载期，Bridge 先写出采木失败日志，约 2.5 秒后写出查询成功日志。换区到达后又出现一次同样的策略请求，两次请求依据相同，中间没有新的采木搜索。这轮记录用于追查启动时查询延迟和重复决策。S0、S2 均正常保存，Java 退出码为 0。S2 的原始查询、决策和移动记录位于 `work/live_adaptive_20261122/nov27_brain_ci_wood2/result.json`，同目录保存 `bridge.log`、`paper.log` 和 `core/data/tasks.db`。

修复重复决策后，用同一源存档和 HTTP 测试服务重新运行 S2，同时采集 Bridge 的 V8 CPU profile。真实 64 格搜索失败回执 `6b72da8eff77` 对应一次模型请求，决策记录包含一次本地方法失败及其动作 ID，`prefetched=false`。角色再次走了 17.1 格，随后在新位置开始 128 格采木，直到确认新采集动作仍在执行时，模型请求总数始终为 1。

| 修复后的观察点 | 背包查询往返时间 | 查询回执 |
| --- | ---: | --- |
| 首次 64 格搜索期间提交 | 335.06 ms | 搜索已结束 |
| 决策等待回复期间提交 | 56.02 ms | 决策请求仍打开 |
| 换区途中提交 | 71.85 ms | 换区动作仍在执行 |
| 换区后 128 格搜索期间提交 | 345.80 ms | 采木动作 `7386ad47f352` 仍在执行 |

两次运行的初始查询由 Core 观察到活跃动作后触发，提交时刻受首次入服状态报文到达时间影响。这次 64 格采木从 Bridge 启动动作到返回失败历时约 4.1 秒；表中的 335.06 ms 只计查询提交后的时间。各阶段均为单次样本。实机和决策回执位于 `work/live_adaptive_20261122/nov27_brain_ci_wood3/result.json`，同目录的 `cpu/` 保留约每 2.5 秒一份的原始采样。

将周边资源站点、工作台和要塞门框观察改为按观察半径筛选方块后，再从同一存档和物品状态启动 S2。角色再次根据一条失败回执换区一次，接着开始 128 格采木。64 格搜索从启动到失败约 120 ms，轮询未捕获可提交背包查询的窗口。等待决策时一次查询用时 5.46 ms，换区过程中用时 53.54 ms，换区后的第一次采木查询用时 49.31 ms。随后每次查询返回后间隔 500 ms，共测两组。

| 背包查询条件 | 五次往返耗时（ms） | 中位数（ms） |
| --- | --- | ---: |
| 128 格采木过程中，五次回执都显示同一采木动作 | 49.74、3.21、3.65、13.43、3.65 | 3.65 |
| 主动暂停目标后，五次回执均显示执行器空闲 | 3.33、3.41、3.69、3.45、18.75 | 3.45 |

以两次剖析中首次实际启动采木为起点，比较随后 4.124 秒内的 V8 样本。按采样间隔加权、包含子调用，快照函数 `buildStateObservation` 由约 1098 ms 降至 18 ms。旧快照中的 `bot.findBlocks` 约 1086 ms，新快照中的 `findObservedBlocks` 约 9 ms。同一窗口内处理 Minecraft 数据包的 `serializer._transform` 由约 2607 ms 变为 2829 ms。两次运行在窗口内实际执行的动作和收到的数据包有所不同。首次入服协议处理仍占用较多 Bridge 执行时间。最新查询、日志和原始 CPU 记录位于 `work/live_adaptive_20261122/nov27_brain_ci_wood4/`，模型仍为上述本地 HTTP 测试服务。

S4 从普通生存存档 `nov27_resume_1052` 的副本启动。两次 64 格采木分别遇到两棵走不到的树，角色继续尝试路径时就发出了策略预取请求。请求中的来源动作 ID 与当时仍在执行的采木动作相同，等待两次回复时的背包查询分别为 36.65 ms 和 23.50 ms。第二次预取匹配了正式决策点，本地 HTTP 测试服务仍在模拟 300 ms 回复延迟。决策记录为 `prefetched=true`、`source=local`、`choice=continue_task`，角色直接开始 128 格采木。该次专项验证结束时 S4 仍在进行。原始动作和策略记录位于 `work/live_adaptive_20261122/nov27_brain_ci_canopy_s4/result.json` 与同目录 `core/data/tasks.db`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 机器 | ASUS TUF Gaming F16，Windows |
| CPU | Intel Core i9-14900HX，24 核 32 线程 |
| GPU | NVIDIA RTX 4060 Laptop，8188 MiB，驱动 610.62 |
| 内存 | 32 GB |
| Python | 3.10.0（Core），3.9.13（GPT-SoVITS 运行包） |
| torch | 2.0.0+cu118（GPT-SoVITS），2.4.1+cpu（转换工具） |
| TTS | GPT-SoVITS v2pro-20250604，`xiaote` 权重，`cuda`，`is_half: true` |
| 识别 | faster-whisper 1.1.1，small，int8，CPU |
| 音频输出 | Realtek 扬声器，48 kHz，`sounddevice` |

## 2. TTS 原始流式延迟

请求：`POST /tts`，`streaming_mode=true`，`media_type=wav`，参考音频 `xiaote.wav`。

| 场景 | 首字节 | 总耗时 | 音频时长 | RTF |
| --- | --- | --- | --- | --- |
| 冷启动（首次请求） | 7470.5 ms | 7623.1 ms | 5.34 s | 1.428 |
| 预热后 | 2388.2 ms | 2526.3 ms | 5.30 s | 0.477 |
| 预热后（重复） | 2471.3 ms | 2615.1 ms | 5.50 s | 0.475 |

说明：`cut0` 时首字节要等整句合成完；`cut5` 会在标点处分块。

同一段两句话文本的切分方式对比：

| 切分 | 首字节 | 总耗时 |
| --- | --- | --- |
| `cut0` | 3073.2 ms | 3210.1 ms |
| `cut5` | 1173.0 ms | 3619.4 ms |
| `cut5`（重复） | 1427.1 ms | 4240.2 ms |

## 3. 端到端语音管线

条件：5 轮连续对话；LLM 为 `tools/dev_llm_server.py`（每 2 字间隔 20 ms 的本地 SSE）；TTS 为真实 GPT-SoVITS；输出为真实扬声器；每轮文本相同，回复约 60 字。

| 指标 | p50 | p90 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- |
| LLM 首 token | 1.5 ms | 1.7 ms | 1.3 ms | 1.8 ms |
| 首个可朗读句子 | 67.2 ms | 67.5 ms | 58.9 ms | 67.6 ms |
| TTS 首段音频 | 725.8 ms | 827.0 ms | 400.6 ms | 894.1 ms |
| 首次可听 | 964.1 ms | 1285.4 ms | 681.2 ms | 1438.1 ms |

逐轮首次可听：790.4、1438.1、964.1、1056.3、681.2 ms。

同条件复测（代码加入后台动作通道后再跑 5 轮）：

| 指标 | p50 | p90 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- |
| LLM 首 token | 1.4 ms | 2.0 ms | 1.0 ms | 2.3 ms |
| 首个可朗读句子 | 63.1 ms | 68.1 ms | 59.1 ms | 68.7 ms |
| TTS 首段音频 | 888.9 ms | 1161.9 ms | 755.9 ms | 1343.5 ms |
| 首次可听 | 1173.5 ms | 1500.8 ms | 951.9 ms | 1562.0 ms |

两次五轮测试的首次可听中位数分别为 964.1 ms 与 1173.5 ms，差异来自 TTS 单次请求的抖动（400-1343 ms），不是管线结构变化。

解读：

- 语音结束到开始播放的链路开销约 1 秒，其中 TTS 首段占 0.7 秒左右。
- 本地测试 LLM 的首 token 只有 1.5 ms；实际模型与网络会增加额外时间。OpenCode Go 的 `deepseek-v4.1-flash` 数据见第 5 节；直接调用官方 DeepSeek API 的结果未测。
- 每个短句单独请求 TTS 时存在约 0.4-0.9 秒的固定开销；首句越短，出声越早。

## 4. 语音识别

| 场景 | 耗时 | 音频时长 | RTF |
| --- | --- | --- | --- |
| 模型加载 | 12.16 s | — | — |
| 识别第 1 次 | 2863.3 ms | 9.88 s | 0.290 |
| 识别第 2 次 | 2605.2 ms | 9.88 s | 0.264 |
| 识别第 3 次 | 2576.0 ms | 9.88 s | 0.261 |

识别文本与参考音频内容一致（中文，无标点）。对 3 秒左右的日常短句，识别约 0.8 秒；加上 640 ms 的最短静音判定，语音结束到最终文本约 1.4 秒。

## 5. 真实 LLM（OpenCode Go）

条件：经 OpenCode Go 订阅路由 `https://opencode.ai/inference/go/openai/v1` 调用模型 `deepseek-v4.1-flash`，请求头包含 `x-opencode-session`；3 轮，真实 GPT-SoVITS 与扬声器。这不是直接调用官方 DeepSeek API 的测量。

| 指标 | p50 | p90 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- |
| LLM 首 token | 2594.7 ms | 2881.4 ms | 1710.7 ms | 2953.1 ms |
| 首个可朗读句子 | 2781.6 ms | 2919.0 ms | 1990.8 ms | 2953.4 ms |
| TTS 首段音频 | 1141.3 ms | 1548.5 ms | 915.5 ms | 1650.3 ms |
| 首次可听 | 3870.7 ms | 4322.1 ms | 3134.9 ms | 4434.9 ms |

逐轮首次可听：3870.7、4434.9、3134.9 ms。同一份代码在本地测试 LLM 下是 964–1173 ms，两者之差主要来自真实网络与模型首 token（1.7–3.0 秒）。

加载工具定义后，真实模型在游戏内聊天「沃心，帮我挖三块泥土」时返回 `collect_blocks` 调用，桥接执行并回报「挖到 3 个 泥土」；该轮语音为「好的，我这就去。」与「好了，挖到 3 个 泥土。」，动作开始 3489 ms，动作完成约 10 秒。

## 6. Minecraft 端到端

环境：Paper 1.21.1 build 133，Temurin JRE 21.0.12.1，`online-mode=false`，视距 4；桥接机器人 `Voxkin`，测试玩家 `Steve`；LLM 为本地测试服务，TTS 为真实 GPT-SoVITS，音频输出为扬声器。

| 轮次 | 玩家消息 | 首次可听 | 动作开始 | 动作完成 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `ACTION 去砍点木头` | 1219.0 ms | 156.8 ms | — | 失败：32 格内没有 `oak_log`，桥接如实返回 |
| 2 | `ACTION 去挖点泥土` | 975.5 ms | 151.7 ms | — | 桥接日志：挖到 3 个 `dirt` |
| 3 | `ACTION 去挖点泥土` | 1494.5 ms | 150.8 ms | 6108.1 ms | 指标中 `t8` 完整，桥接日志：挖到 3 个 `dirt` |

观察：

- 语音回合在动作开始后 1 秒内已经出声，动作持续约 6 秒，期间语音通道没有等待。
- 动作失败会以 `action_errors` 记录，`t8` 不会写入。
- 动作完成时间通过 `MetricsStore.update` 回填到同一 `request_id` 的记录。
- mineflayer 在 1.21.1 上对部分物品包报 `PartialReadError`（`ArmorTrimMaterial`），不影响连接与动作执行。

## 7. WebSocket 音频与记忆

音频推送：用真实 TTS 合成一句回复，客户端通过 `/ws/audio` 接收。

| 指标 | 结果 |
| --- | --- |
| 二进制总字节 | 412160 |
| 折算时长 | 6.44 秒（32 kHz、单声道、16 位） |
| 分块数 | 4 |
| 与语音时长的比例 | 1.0（字节数与音频时长一致） |

记忆压缩：连续 4 轮真实对话（8 条消息）后，等待 10 秒空闲，数据库从 8 条消息、1 条摘要增长到 16 条消息、2 条摘要。4 轮对话的首次可听分别为 3076.8、3928.6、3070.8、5313.9 ms，摘要没有占用对话请求。

## 8. 麦克风对话

条件：Realtek 麦克风阵列，输入增益 4；用扬声器播放 3.5 秒的问题音频模拟玩家说话；真实模型与 GPT-SoVITS。

| 指标 | 结果 |
| --- | --- |
| 识别文本 | 沃西，你能听到我说话吗（“沃心”被听成“沃西”） |
| 识别耗时 | 1957.2 ms |
| 首次可听 | 4541.6 ms |
| 回复 | 能听到，这回清楚多了，没有回音了…… |

第二次用 Studio 的麦克风面板启停（`POST /api/mic/start`，播放问题音频）：识别文本「沃辛,你能听到我说话吗?」，识别耗时 1577.3 ms，回复「听到了，还是把名字念得有点偏，不过没关系，我知道你在叫我。」，文本与音频都正常返回。

回声处理：修复前，音箱播放的回复会被麦克风再次识别并触发新回合，形成连续自问自答。加入「实际播放状态 + 播放结束后的冷却」后，同一测试只产生一轮回复。冷却时间最初为 0.9 秒，实测仍有尾部音频被收进去，当前默认 1.5 秒。

## 9. 语音快路与缓存的结构自检

条件：`scripts/latency_scenarios.py`，脚本化模型与等幅 PCM 替身；无真实网络、无真实 TTS、无真实服务器。

| 场景 | 确认语来源 | 合成调用 | 动作 | 音频块 | 缺失观测点 |
| --- | --- | --- | --- | --- | --- |
| `cache_miss` | dynamic | 3 | 1 | 6 | 无 |
| `cache_hit` | cache | 2 | 1 | 5 | 无 |
| `action_success` | cache | 2 | 1 | 5 | 无 |
| `action_failure` | cache | 2 | 1 | 5 | 无 |
| `stop` | dynamic | 3 | 1 | 6 | 无 |
| `tts_unavailable` | cache | 2 | 1 | 1 | 无 |

这张表只能证明结构，不能当延迟结论：

- `cache_hit` 的合成调用比 `cache_miss` 少一次，差额正好是确认语本身，说明缓存命中时确认语不经过 TTS。
- `tts_unavailable` 仍然有 1 个音频块，确认语来自缓存；动态部分如实降级，整轮没有崩。
- 六种场景的观测点都齐全，缺一个观测点脚本就以非零码退出。
- 合成场景里的毫秒数不可信：Windows 事件循环的定时粒度会把 5 毫秒等待压成零点几毫秒，所以脚本刻意不制造真实延时，只看顺序与调用次数。

缓存命中时的首音延迟、真实 TTS 下的缓存收益、真实扬声器的可听延迟都还没有测量，见下一节的未测量项。

## 10. 未测量的部分

- 官方 DeepSeek API 直连的首 token 与网络往返：未测；当时没有官方接口的可用凭据/费用授权。第 5 节已记录经 OpenCode Go 订阅路由调用 `deepseek-v4.1-flash` 的真实模型测量，两种 provider route 不混为一项结果。
- 游戏内 Mod 播放：没有运行 Minecraft 客户端，空间音效与端到端时间未测。
- 真人对着麦克风实时说话：当前用扬声器回放问题音频驱动采集链路，未做真人实时说话测量。
- 多人空间音频、YSM 联动：未实现。
- 旧系统 60-120 秒的原始测量：来自用户描述，本仓库没有复现。
- 语音快路（本地意图 + 缓存确认语）的真实首音延迟：未测量。缓存已在 `work/voice_cache/` 生成时才能测，当前仓库没有带缓存的真实运行记录。
- 缓存命中相对动态合成的真实收益：未测量。

## 11. 复现

```powershell
# 终端 A：本地测试 LLM
.\.venv\Scripts\python.exe tools\dev_llm_server.py --port 8799 --delay-ms 20

# 终端 B：GPT-SoVITS
cd work\gpt_sovits_full\GPTheresaV3.2\GPT-SoVITS-v2pro-20250604
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml

# 终端 C：基准
cd D:\AI-Workspace\Voxkin
.\.venv\Scripts\python.exe -m voxkin bench --turns 5 --json work\bench.json

# 语音快路与缓存的结构自检（不访问外网）
.\.venv\Scripts\python.exe scripts\latency_scenarios.py --json work\latency_scenarios.json

# 生成确认语缓存（需要终端 B 的 GPT-SoVITS 在跑）
.\.venv\Scripts\python.exe scripts\build_voice_cache.py
```

## 12. Paraformer 流式 STT 同音频回放（2026-10-26）

这是一项独立 STT 研究，不调用 LLM，也未接入 Voxkin 的生产 STT 适配器。Paraformer 使用 FunASR v1.4.16、固定权重 `apache-2.0-20260804`，在单独的 Python 3.9.13 / torch 2.0.0+cu118 环境测量；CPU 固定 4 线程。硬件为 i9-14900HX、32 GB RAM、RTX 4060 Laptop 8,188 MiB（driver 610.62）。

输入来自带人工参考文本的 Google FLEURS `cmn_hans_cn/validation` 真人朗读 WAV，而非现场麦克风录音：row 87 短句 3.66 秒、row 11 中英 WiFi 混合句 5.58 秒、row 295 长句 27.72 秒。每个样本各重复 3 次，并按 600 ms 节奏提供 16 kHz 单声道 float32 音频块。表中 Paraformer RTF 仅计模型调用耗时除以音频长度；首非空文本从回放开始计，包含等待音频块到达。末块时间为最后有效音频尾部到 final 模型调用结束。

| 样本 | Paraformer CUDA：RTF / 首非空 / 末块尾延迟 / CER | Paraformer CPU：RTF / 首非空 / 末块尾延迟 / CER | Faster-whisper small：整段耗时 / RTF / CER |
| --- | --- | --- | --- |
| 短句 3.66 s | 0.126 / 1.266 s / 59 ms / 0.000 | 0.240 / 1.349 s / 173 ms / 0.000 | 1.460 s / 0.399 / 0.000 |
| 中英 WiFi 句 5.58 s | 0.105 / 1.901 s / 71 ms / 0.143 | 0.194 / 1.922 s / 123 ms / 0.143 | 1.386 s / 0.248 / 0.000 |
| 长句 27.72 s | 0.106 / 3.677 s / 87 ms / 0.224 | 0.215 / 3.761 s / 134 ms / 0.224 | 2.546 s / 0.092 / 0.035 |

所有 CER 均按去空白/标点、英文小写后计算。WiFi 句漏掉 `W`；长句错误包括将年份和数值写成汉字数字，另有“戴维→代为”“人质→认质”。仅对该长句做样本特定的中文数字到阿拉伯数字归一后，Paraformer CER 为 0.035；这不是通用评分。三个样本无法代表一般识别准确率。

Faster-whisper 对照为同一音频的整段离线调用（CPU/int8/4线程、`language=zh`、`beam_size=1`、VAD off），之后做 OpenCC 简体归一并算 CER。该接口不产生流式 partial，必须等待完整录音后调用，因此整段 RTF 与 Paraformer 首增量时间不是同一指标。Voxkin VAD 单独校准的数字零值静音端点为 640 ms；此值未包含在 Paraformer 的首增量/模型时间内。未做真实麦克风、背景噪声或多人并发测试。

GPU 模型峰值 allocated 显存约 874 MiB，整卡采样峰值 2,146 MiB（含桌面/后台），未 OOM。数据、逐块时序、识别文本、CER 计算方式、快照校验、环境快照和复现命令见 [研究报告](research/PARAFORMER_STREAMING_20261026.md)。主要 raw JSON：`work/stt_paraformer_20261026/results/paraformer_gpu_realtime.json`、`paraformer_cpu_realtime.json`、`faster_whisper_cpu_compare.json`、`faster_whisper_cpu_compare_simplified.json`、`vad_endpoint_calibrated_realtime.json`。

## 13. Qwen3-TTS-GGUF 隔离 PCM 探针（2026-10-26）

这不是 Voxkin 正式适配器或扬声器延迟测试。环境为 Windows 11、RTX 4060 Laptop 8,188 MiB、32 GB RAM、独立 CPython 3.14.0rc2 / torch 2.14.1+cpu venv。上游发布页没有可校验的预导出模型 ZIP；本次 Talker Q5_K 与 Predictor Q8_0 由官方 Qwen 1.7B Base 固定 revision `fd4b254389122332181a7c3db7f27e918eec64e3` 在上游提交 `74feb581bc8cefb835fc608107e857036d7580a1` 导出。GGUF 走 llama.cpp b10621 Vulkan，ONNX decoder 走 CPUExecutionProvider。DirectML decoder 在 `Reshape` 节点失败。没有修改 Voxkin `.venv` 或 `src/voxkin/tts`。

文本固定 seed，每个新进程执行 engine/stream/voice 初始化；warmset 在同一 engine/stream/reference voice 上先合成预热文本，然后每条正式文本生成 3 次。合成时间从 `clone()` 调用到完整 WAV 完成；首 PCM 是第一个含非零值的 decoder PCM 块到达时间，不是首 token，也不是声卡/扬声器输出时间。

| 用例 | WAV 时长 | Warmset 中位生成耗时（范围） | 中位 RTF | 首 PCM 中位（范围） |
| --- | ---: | ---: | ---: | ---: |
| 短句 `好的，我这就去。` | 2.72 s | 1.841 s（1.812–1.842） | 0.677 | 0.645 s（0.617–0.661） |
| 长句 | 9.04 s | 6.598 s（6.587–6.710） | 0.730 | 0.691 s（0.641–0.716） |
| 游戏领域句 | 5.44 s | 4.007 s（3.947–4.150） | 0.737 | 0.766 s（0.695–0.774） |

新进程短句第一次成功运行用时 6.533 s、首 PCM 5.154 s、RTF 2.402；warmset 后另起新进程短句用时 1.978 s、首 PCM 0.892 s、RTF 0.727。原因未核实，不能将两者差异归因于某个算子或缓存。新进程长句用时 6.164 s、首 PCM 0.877 s、RTF 0.682，但首 PCM 块 RMS 只有 0.000284；不能把它称为可听首音。实际播放设备与 Voxkin AudioSink 均未参与。

进程峰值 Working Set 3.52 GB、Private Usage 5.28 GB；`nvidia-smi` 采样到整卡峰值 2,358/8,188 MiB（包含桌面/后台进程），未发生 OOM。上游 API 同步返回完整 `TTSResult`；内部每 12 个 codec code 调用一次 decoder，但不提供增量文本输入或已验证的协作式取消。Python 3.14 与 Core Python 3.10 不兼容，若继续集成需要独立 worker/subprocess 方案与取消/PCM 队列验证。未进行主观音质评分。

逐轮指标、模型与导出文件 SHA-256、WAV 与 GPU CSV 路径、DirectML 失败摘要和源码核对见 [Qwen3-TTS-GGUF 本机评估](research/QWEN3_TTS_GGUF_20261026.md)。主要原始记录：`work/tts_qwen3_20261026/results/run_cold_short.json`、`run_cold_long.json`、`run_warm_warmset.json`、`postwarm-short-process/run_cold_short.json`；GPU 采样：`work/tts_qwen3_20261026/results/gpu_warm_set.csv` 与同目录冷启动 CSV。

## 14. GoalSupervisor 实机阶段运行与受控抢占观测（2026-10-26–27）

本节记录 Paper 隔离世界里的阶段完成/阻断用时和受控路径，不是语音、LLM、TTS 或 STT 性能基准。S0/S1、r14、r15、r16、r17、r18b、r20、r22、r23、r24 均直接调用阶段运行接口，没有发起 LLM 请求。r05 由 `fault_injection.py` 直接调用 `/api/run/start`，隔离配置没有 API key、LLM base URL 指向不可达的 `127.0.0.1:1/v1`，且 TTS 设为 `silent`，没有调用 LLM 或 TTS。

| 运行 | Paper 场景 | 阶段时间 | 结果 | 记录 |
| --- | --- | --- | --- | --- |
| r11 | Normal 难度，S0→S1 链式回归，单次 | S0 48.5 s；S1 89.0 s；全链 137.5 s | S0、S1 均 5/5，`stage_complete=true` | `work/refactor_validation_20261026/r11_s0_s1_result.json`、`r11_s0_s1_console.jsonl` |
| r12 | Normal 难度，S0→S1 链式回归，单次 | S0 42.5 s；S1 80.7 s；全链 123.2 s | S0、S1 均 5/5，`stage_complete=true`；S1 两个 stale-observation 准入拒绝各被记录一次，`admission_retries` 终值为 0 | `work/refactor_validation_20261026/r12_s0_s1_result.json`、`r12_s0_s1_console.jsonl` |
| r14 | Normal 难度，同一新鲜隔离世界 S0→S1→S2；runner 启动时设置 `time set day`，阶段内未强制设夜，无天气/库存/地形注入 | S0 52.6 s；S1 94.8 s；S2 运行 502.8 s 后断连；全链 650.2 s | S0、S1 均 5/5；S2 未完成，`shear_sheep` 搜索期间 Bridge 断连。阶段时间是实机运行时长，不是 LLM/语音延迟 | `work/refactor_validation_20261026/r14_natural_s2_result.json`、`r14_natural_s2_console.jsonl`、`r14_s2_disconnect_snapshot.json` |
| r15 | 受控库存夹具 S2，白天存活场景；只注入物品，不预放床/庇护所 | 阶段计时 32.1 s，包含库存注入与 Bridge 状态确认；GoalSupervisor 从启动到阻断约 27.3 s | `craft_bed` 成功，`make_shelter` 40/40 且 sealed/inside；玩家站在床脚目标格 `(9,75,68)`，Bridge 记录 3 次服务端拒放及 1 次 stale-observation admission rejection，最终 `budget_method_attempts` 阻断。没有睡眠/夜间验收 | `work/refactor_validation_20261026/r15_controlled_inventory_s2_result.json`、`r15_controlled_inventory_s2_console.jsonl`、`refactor_validation_20261026_r15_controlled_inventory_s2_fixture.jsonl` |
| r16 | 两个受控库存夹具 S2 目标；任务 1 仅注入物品，任务 2 另设夜间条件 | 两任务链 213.9 s；任务 1 阶段计时 44.8 s（含夹具注入）；任务 2 运行 169.1 s（含 RCON 夜间设置与等待） | 任务 1 `stage_complete=true`，床/封闭庇护所成功；任务 2 `night_required=true`，程序未确认睡眠/时间推进，`sleep_confirmed=false`。之后观察到白天，不据此断定服务器未睡。Node 22 在等待下一夜时以 `0xC0000005` 清理前退出，无 fatal stack | `work/refactor_validation_20261026/r16_controlled_inventory_s2_result.json`、`r16_controlled_inventory_s2_console.jsonl`、`r16_night_failure_snapshot.json` |
| r17 | 两个受控库存夹具 S2 目标；Node 24.19.0，任务 1 仅注入物品，任务 2 另设新夜间条件 | 两任务链 59.5 s；任务 1 阶段计时 49.2 s（含 POST 前夹具注入/观察）；任务 2 10.3 s（含夜间注入和新鲜状态确认） | 两任务均 `done/stage_complete=true`。任务 1 床合成、40/40 sealed/inside 庇护所和床位放置成功；任务 2 `night_required=true`，`sleep_confirmed=true`，睡眠后观察到白天。不是自然采矿或多夜生存；Node 24 进程在 stop cleanup 后退出，不是崩溃 | `work/refactor_validation_20261026/r17_controlled_inventory_s2_result.json`、`r17_controlled_inventory_s2_console.jsonl`、`refactor_validation_20261026_r17_controlled_inventory_s2_node24_fixture.jsonl`、`r17_source_hashes.json`、`r17_source_server_hashes_after.json` |
| r18a | S0→S2 自然链启动前置失败 | 未发起 S0 `/api/run/start`，没有阶段时间 | wrapper 漏了原有的限次 RCON 重试，首次连接失败后退出；不能记为阶段失败或通过 | `work/refactor_validation_20261026/r18_natural_s0_s2_console.jsonl` |
| r18b | Normal 难度，自然资源采集 S0→S1→S2 白天准备；源时钟、天气、daylight 和 gamerules 保持默认，无库存/地形注入 | S0 42.5 s；S1 76.7 s；S2 352.7 s；全链 471.9 s | 三个阶段均 `done/stage_complete=true`。RCON 仅设置已为 normal 的难度，其余为只读检查：`keepInventory=false`、`doMobSpawning=true`、`doDaylightCycle=true`、time=15；Bridge 起始观察 time=9/day/clear。S2 首次 shear 被 `critical_hunger` 抢占并消耗已有苹果，之后恢复并剪取 1 只白羊，white wool 总量达到 3。最终 alive、health=20、food=12、overworld、白天；40/40 sealed/inside 庇护所与床放置成功。`night_required=false`、`sleep_confirmed=false`，故不构成夜间或多夜验收。上述阶段用时不是 LLM/语音延迟或动作单次时延 | `work/refactor_validation_20261026/r18b_natural_s0_s2_result.json`、`r18b_natural_s0_s2_console.jsonl`、`refactor_validation_20261026_r18b_natural_s0_s2_node24_fixture.jsonl`、`r18b_source_hashes.json` |
| r20 | 从 r18b→r19 保存世界与 SQLite 目标库副本续跑的自然 S2 夜间目标；Node 24.19.0；无库存、时间、天气、地形注入 | S2 189.8 s，含约 182 s 自然昼夜等待；GoalSupervisor 的创建至终态窗口约 6.6 s | 在 fresh observation `time=13061,is_day=false` 后启动 task 4；`sleep_safe` 成功，观察到白天后 `night_required=true`、`sleep_confirmed=true`，goal `done/stage_complete=true`。仅为单次阶段/观察用时，不代表性能或重复运行分位数；R19 未发起阶段任务 | `work/refactor_validation_20261027/r20_s2_result.json`、`r20_s2_console.log`、`refactor_validation_20261027_r20_continue_s2_s6_node24_fixture.jsonl`、`r20_s2_loaded_source_hashes.json` |
| r21 | 从 R20 保存副本继续自然 S3，Node 24.19.0 | runner 汇总 167.7 s；task 5 创建至终态约 163.9 s；fresh `strip_mine` action 约 120.7 s | 首次准入因 stale observation 在动作开始前拒绝；fresh retry 后动作执行，最终 blocked，原因 `没有安全的阶梯落点`。该次为单样本阶段阻塞用时，不是性能基准；未采到 iron ore | `work/refactor_validation_20261027/r21_s3_s6_result.json`、`r21_s3_s6_console.log`、`refactor_validation_20261027_r21_continue_s3_s6_node24_fixture.jsonl`、`r21_s3_s6_loaded_source_hashes.json`、`r21_saved_world_manifest.json` |
| r22 | 从 R21 保存世界与 task 5 继续自然 S3；Node 24.19.0；未注入库存/时间/天气/地形 | Runner JSON 的单次 S3 `duration_s=262.4 s` | 已知旧 `strip_mine` blocked terminal 被迁移且未重放；随后新 `mine_collect` 目标 9 raw iron。Bridge 日志有 3 次 raw_iron 拾取事件，保存的 playerdata 为 raw_iron×3；最后 Bridge/Core observation 未含这项库存，动作仍无终态回执。Node 24 在清理前 `0xC0000005` 退出，导致阶段 `disconnected`、`stage_complete=false`；单次运行时间不是性能基准 | `work/refactor_validation_20261027/r22_s3_s6_result.json`、`r22_s3_s6_console.log`、`refactor_validation_20261027_r22_continue_s3_s6_node24_fixture.jsonl`、`refactor_validation_20261027_r22_continue_s3_s6_node24_recovery.jsonl`、`r22_saved_world_manifest.json` |
| r23 | 从 R22 世界/DB 副本继续 S3 task 5；Node 24.19.0 `--jitless`；除副本外无物品、世界、时间、天气或地形注入 | S3 22.4 s | fresh observation 对账确认 raw_iron×3；旧 action `3a68c1652ba7` 标记 `reconciled_for_replan`，没有成功回执。地下 Y=47 时需补木料，三次 `mine_collect(oak_log,count=1)` 均在 64 格内未找到橡木，task blocked (`budget_method_attempts`)、`stage_complete=false`。Node 本次短运行没有 crash 或 restart；22.4 s 是单次阻断用时，不是性能或长期稳定性结论 | `work/refactor_validation_20261027/r23_s3_result.json`、`r23_s3_console.log`、`refactor_validation_20261027_r23_continue_s3_s6_node24_fixture.jsonl`、`r23_s3_loaded_source_hashes.json`、`r23_saved_world_manifest.json` |
| r24 | 从 R23 世界/DB 副本继续 S3；Node 24.19.0 `--jitless`；**诊断运行，时钟条件不合规** | CLI S3 `duration_s=181.4 s`；只记录该次阶段运行时间，不是性能基准 | 启动器漏传 `PRESERVE_SOURCE_CLOCK`；fixture 在 `1793041936.831033` 执行 `time set day`，将 R23 副本源时间 9176 改为 1000。因此不能作为无新增时间注入或保留时钟续跑证据。S3 以 `disconnected`、`stage_complete=false` 结束，0/8 步完成；断连时 pending action 为新 session 上的 `goto`，存档 inventory `raw_iron=3`、health=20、food=18。Node PID 23496 首次 `0xC0000005` 后，官方 runner 成功重启为 PID 71756，并在新 session 恢复 goto；replacement 再次 `0xC0000005`。第二次退出后 QA 按明确要求调用 API stop，因此没有观察未中断情况下 runner 会否再次重启；不得据此归因 runner 缺陷。goal `paused_by_user` 是该显式 stop 后状态，更新时刻 `1793042118.188677` 早于 RCON stop `19:15:18.282Z`；Paper 保存后 exit 0。`--jitless` 未避免该次 native exit，根因仍未归因。后续 R25 从有效 R23 副本续跑，结果见下行。 | CLI result `work/refactor_validation_20261027/r24_s3_result.json`；wrapper stdout 仅在 exec session 85937 返回、未存为独立文件；RCON fixture/recovery/journal 误落在 `work/refactor_validation_20261026/`：`refactor_validation_20261027_r24_continue_s3_s6_node24_fixture.jsonl`、`refactor_validation_20261027_r24_continue_s3_s6_node24_recovery.jsonl`、`processes.jsonl`、`refactor_validation_20261027_r24_continue_s3_s6_node24_source_world_hashes_before.json`、`refactor_validation_20261027_r24_continue_s3_s6_node24_copied_world_hashes_before.json`、`refactor_validation_20261027_r24_continue_s3_s6_node24_source_world_hashes_after.json`；Paper/Bridge/Studio/DB 在 `work/mc/refactor_validation_20261027_r24_continue_s3_s6_node24/` |
| r25 | 从 R23 world/DB 副本继续 task 5 的 S3；Node 24.19.0 `--jitless`；没有新增物品、时间、天气或地形写入 | S3 40.5 s；单次阻断运行，不是性能基准 | R23 source 最后 time=9176，副本首次观察 time=9237（期间自然 ticking）；只读 gamerule 查询与最终 `stop`。目标在 `s3:surface_route:shelter_anchor` 的三次 method-attempt 后 `budget_method_attempts` blocked，0/8、`stage_complete=false`；alive/overworld、health=20、food=18、raw_iron=3。Bridge PID 72004、71072、34268 均清理前以 `0xC0000005` 退出，官方 runner 三次均成功 restart；第四个 PID 65168 未再 C5，在目标阻断后由 owned cleanup 结束。restart count=3/limit3、`restart_budget_exhausted=false`；不把 method-budget block 写成 runner failure，也不由此推断 Node 稳定性或 native 根因。Paper exit 0；R25 保存世界及 DB 晋升为下轮 source | `work/refactor_validation_20261027/r25_s3_result.json`、`r25_wrapper_console.log`、`processes.jsonl`、`refactor_validation_20261027_r25_continue_s3_s6_node24_fixture.jsonl`、同前缀 `_recovery.jsonl`、`_source_world_hashes_before.json`、`_source_world_hashes_after.json`、`_copied_world_hashes_before.json`、`r25_saved_world_manifest.json`、`r25_s3_source_hashes_after_run.json`；Paper/Bridge/Studio/DB 在 `work/mc/refactor_validation_20261027_r25_continue_s3_s6_node24/` |

### 生产代码回归快照（2026-10-27）

这些是代码回归结果，不是 Minecraft 游戏时长或动作延迟。root 独立执行 Python 全量命令 `$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'; .\.venv\Scripts\python.exe -B -m pytest -p pytest_asyncio.plugin --assert=plain --noconftest tests -q --tb=short`，结果 444 passed、54 warnings、66.42 s、exit 0；当时生产快照已含 S4 策略、部分 S6 搜索/下探、combat/Nether 路径及 transport/method 预算调整。Windows Node 24.19.0 `--jitless` Bridge 全套为 210 passed、0.67 s、exit 0。Ruff F821/F823 与 `git diff --check` 通过。Python 3.10 collection access violation 根因仍未知；`--noconftest` 因仓库没有 `conftest.py`，只是跳过未使用的 conftest discovery，不能视为根因修复。自动化通过不代表 S4–S6 Minecraft 实机阶段通过。R26/R26b 没有进入 Paper 或产生动作，因此没有阶段时长。R27 的 v3 archive 在 Windows 1.83 秒内完整读取 6,640 entries/599,633,870 bytes，但只读 Linux ext4 Python tar stream 在 1,792 个成员/70,227,142 bytes 后停滞；没有启动游戏进程，也没有阶段时长或 benchmark 样本。该差异记录为宿主/WSL runtime 诊断，不据此推断 Node、硬件或项目代码根因。

表中是完整阶段运行时间或失败/阻断前的已运行时间，不是模型首 token、动作单次执行延迟或重复运行的分位数；每个阶段各只有一次样本。r15/r16/r17 阶段计时包括 fixture 注入与初始状态确认；r16 的任务 2 还包括 RCON 夜间设置和等待，r17 的任务 2 包括夜间注入和新鲜状态确认；r20 的 189.8 秒包含约 182 秒自然时间等待，GoalSupervisor 执行窗口按 goal `created_at` 至终态 `updated_at` 计算，约 6.6 秒；r21 的 167.7 秒是 runner 汇总，163.9 秒是 task 5 创建至终态，120.7 秒是 Bridge action 日志的开始/终态间隔；r22 的 262.4 秒是 runner JSON 的 S3 单次运行区间；r23 的 22.4 秒是 S3 阶段阻断时间；r24 的 181.4 秒是受错误时钟条件影响的诊断阶段时间；r25 的 40.5 秒是保留时钟 continuation 的单次阻断阶段时间，均不作为性能数据。r18b/r20/r21/r22/r23/r25 阶段运行保留世界时钟状态，r24 不满足保留源时钟条件，单独排除。这些时间不用于推导游戏动作性能。原始 JSON 的阶段字段用于区分各阶段时长，顶层 `duration_s` 是整条链的总时间。r14 使用的 Core 源码快照早于库存净缺口修正，起始库存为空，因此该运行不验证该修正；r15–r17 为库存夹具，不是自然采矿路线验证。

### r05 受控受袭与安全抢占

为使时间口径可复核，故障注入时刻定义为 RCON `summon_near_bot` 命令成功返回并记入日志的时间；“安全接管”定义为后续轮询首次观察到 `executor.safety_active=true`；“恢复目标”定义为轮询首次同时观察到 Bridge ready、bot 存活、安全状态结束且新 action ID 已成为 active action。按该定义，从僵尸召唤命令返回到首次观察到安全接管为 3.275 s，到首次观察到新目标动作派发为 17.468 s。两者都是包含状态轮询间隔的受控观察间隔，不是精确游戏帧时延，也不代表一般场景性能。

原始记录：`work/refactor_validation_20261026/refactor_validation_20261026_r05_attack_rcon.jsonl`（注入时间）、`refactor_validation_20261026_r05_attack_assertions.json`（条件时间与断言）、`refactor_validation_20261026_r05_attack_observations.jsonl`（状态轮询）。7 项受控断言验证旧 `mine_collect` 被抢占、安全动作结束后按新观察派发新目标动作。世界预置了白羊毛、木板和工作台，并注入了 Zombie；bot 通过抗性效果避免死亡。因此该计时只适用于此夹具。
