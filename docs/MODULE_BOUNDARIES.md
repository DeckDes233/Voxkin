# 模块边界与所有权

> 本文以当前仓库代码和配置模型为准，逐项区分仓库模块、外部依赖、Python/JavaScript 模块边界、操作系统进程边界，以及跨边界协议。状态标签描述实现证据，不表示验收成熟度。

## 状态口径

| 标签 | 含义 |
| --- | --- |
| 已实现 | 在当前代码中存在可定位的实现路径；不自动意味着生产/实机验收通过 |
| 部分 | 实现覆盖有限场景，或生产者/消费者、所有权协作等链路只完成一侧 |
| 计划 | 只在路线图、设计稿或契约草案中出现，未找到相应运行代码 |
| 外部 | 不由本仓库拥有或控制的程序、设备、API 或权威数据源 |

## 部署与模块边界矩阵

| 区域 | 仓库归属 | 实际运行位置 | 边界与接口 | 状态及边界说明 |
| --- | --- | --- | --- | --- |
| Python Core | 仓库内 `src/voxkin/` | 单个 Python 3.10+ 服务进程，由 `voxkin serve` 启动 | `Runtime.create()` 组装对象；`StudioServer` 经 aiohttp 对外提供 HTTP 与 WS | 已实现；同一进程中的 package 不是微服务 |
| Python 对话与语音模块 | 仓库内 `pipeline.py`、`voice/`、`stt/`、`tts/`、`audio/`、`llm/` 等 | Python Core 进程；`WhisperSTT` 在该进程加载模型，VoiceLoop 把转写调用放到工作线程 | 普通 Python 方法/async 方法、队列与适配器接口；LLM/TTS 另有网络边界 | 已实现；package 拆分不代表独立部署 |
| Python 动作与阶段任务 | 仓库内 `agent/` | Python Core 进程 | `ConversationPipeline`/`TaskRunner` → `ActionArbiter` → `ActionDispatcher`；对外为 Bridge WebSocket | 部分：固定阶段及线性任务执行存在；任意任务图与动态计划执行未实现 |
| Python Bridge 协议 | 仓库内 `bridge/protocol.py` | Python Core 进程内的类型/解析代码 | JSON 消息结构和动作状态枚举，与 Node Bridge 通过 `/ws/bridge` 交换 | 已实现；字段契约跨语言维护，非独立进程 |
| Node Minecraft Bridge | 仓库内 `bridge/minecraft_bridge.js` | 独立 Node.js 进程，mineflayer 作为游戏客户端连接 MC 服务端 | 对 Core 使用 `ws` 的 `/ws/bridge`；对 Minecraft 使用 mineflayer/Minecraft 客户端协议 | 已实现；连接 Minecraft 的是 bot，不是 Fabric Mod 或 Core |
| Bridge 内部动作队列与反射 | 仓库内 `minecraft_bridge.js` | Node Bridge 进程内 | 内存队列、当前动作标志、mineflayer bot/pathfinder API 与事件回调 | 部分：Core 请求路径与部分自动行为受局部互斥；不构成涵盖所有控制路径的统一全局仲裁 |
| JS 技能模块 | 仓库内 `bridge/skills/*.js` | Node Bridge 进程内，Bridge 启动时由 `registry.js` 动态 import | `skills` 导出对象；handler 接收 `(args, buildSkillContext())`；共享同一个 bot/context | 已实现模块化加载；模块边界是 JS 文件/对象，不是进程或权限沙箱 |
| 技能机器可读清单 | 仓库内 `bridge/skills/manifest.js`、生成的 `manifest.json` | JS 源清单由脚本校验/合并，Node 运行时读 JSON；Python 读 JSON 生成 LLM 工具 schema | 以 skill ID、类型、参数、前置/完成/失败信息描述并映射工具名 | 部分：有描述与 schema；清单更新/模块注册需构建或启动期加载，不是在线注册协议 |
| Fabric 音频 Mod | 仓库内 `mod/` | 作为 Fabric 客户端 Mod 加载在 Minecraft 客户端 JVM；不独立启动 Voxkin 进程 | Java WebSocket 客户端连接 Core `/ws/audio`；调用 Minecraft 客户端声音系统 | 代码与构建已实现；文档记录尚未通过真实客户端端到端验收 |
| Studio 前端 | 仓库内 `src/voxkin/studio/` | HTML/JS/CSS 由 Core 提供；脚本在用户浏览器上下文运行 | HTTP `/`、`/static/*`、`/api/*` 与 WS `/ws` | 已实现；浏览器与 Core 是进程边界，前端文件归仓库内 |
| Minecraft Java 服务端 | 仓库外部 | 独立游戏服务器进程/主机，可能是 Paper 或其他兼容服务端 | mineflayer 与其通过 Minecraft 客户端/服务端协议通信；Fabric Mod 客户端也连接游戏服务 | 外部权威系统；具体服务器部署与版本由环境决定 |
| OpenAI-compatible LLM 服务 | 仓库外部或本地部署 | 由 `llm.base_url` 指定，不能仅凭代码断定云端/本机 | Core 用 HTTP `/chat/completions`；流式结果为 SSE，可含 tool_calls | 客户端适配器已实现；模型服务本身与其生命周期不由当前 Runtime 管理 |
| GPT-SoVITS 服务 | 外部引擎/API | HTTP API 进程，通常独立于 Core；是否由 Core 拉起取决于配置 | Core 请求 `/openapi.json`、`/tts` 并读取流式音频 | 已实现适配器；`ServiceSupervisor` 仅在 `manage_service` 配置启用时管理注册的 TTS 子进程 |
| Genie TTS 引擎 | 第三方 Python 依赖 | 在 Python Core 进程内加载和调用 | `genie_tts` Python API / async generator | 部分：可选引擎适配器存在；模型与特定音色的兼容性见技术评估，非独立服务 |
| faster-whisper / 模型文件 | 第三方依赖与本地模型 | Core 进程内模型对象；模型文件从本地缓存/配置读取 | Python 调用接口；非网络 RPC | 已实现集成；属于可选依赖与运行资产，不是仓库内服务进程 |
| 麦克风、扬声器、音频设备 | 操作系统设备 | Voxkin Core 所在主机的音频设备 | Core `Microphone`/`SpeakerSink` 经 sounddevice/PortAudio 等 API | 外部硬件/OS 能力；设备访问与 Minecraft 客户端不等同 |
| 数据库文件 | Core 维护的本地数据 | Core 所在文件系统 | SQLite：任务库 `data/tasks.db`；记忆库由配置 `memory.db_path` 指定 | 已实现；任务检查点与对话记忆是不同存储和不同语义 |
| WAV 共享目录消费者 | 当前消费者未定位 | 取决于 `audio.minecraft_audio_dir` 指向的目录及部署 | Core `MinecraftFileSink` 生成 WAV 文件 | 部分/未确认：写入端在仓库内；当前 `mod/src/main/java` 未发现文件监听实现，不能把 WebSocket Mod 当作该目录消费者 |

## 状态数据与写入权

| 状态 | 权威拥有者 | Core/Bridge 中的副本 | 持久化与失效规则 |
| --- | --- | --- | --- |
| Minecraft 世界、玩家实体、方块与服务端时间 | Minecraft 服务端 | Node mineflayer bot 保存/观察游戏状态；Bridge 每约 5 秒发送摘要；Python Dispatcher 缓存最近一帧 | 服务端权威；Core `state_snapshot()` 对过期（默认 30 秒）快照返回空值。不能把缓存当成世界真相 |
| 动作实际执行与 Bridge 队列 | Node Bridge | Core Arbiter 的 `ActionTicket`、Dispatcher 的 Future/进度映射 | Node 实际运行/中断动作；Core 保存请求侧状态并按 `action_id` 关联结果。两侧都有生命周期信息，非单一共享状态机 |
| Core 动作占用/等待队列 | Python `ActionArbiter` | Bridge 有自己的 action queue、`actionBusy` 和反射忙碌标志 | Core 只仲裁进入 Core 的动作；Bridge 本地自动行为可能使用独立门控。没有证据表明任意外部/内部行为统一经过一个锁 |
| 语音回合、generation、句子队列 | Python `ConversationPipeline` | Studio 订阅回合事件；音频 Mod 维护 PCM 播放缓冲 | 回合状态主要在内存；pipeline 打断停止语音播放，但与世界动作取消是分开的操作 |
| 固定阶段任务、步骤游标、检查点与事件 | Python `TaskRunner`/`RunManager`，存储所有者为 `TaskStore` | Bridge 仅执行收到的单个动作，不拥有阶段计划 | SQLite `data/tasks.db`；当前恢复能力面向保存的任务/线性步骤游标，不代表可恢复任意协程或任务图 |
| 对话上下文与摘要 | Python `MemoryStore` | Pipeline `ContextBuilder` 读取并组装模型上下文 | 配置所指 SQLite 文件；其目的为对话记忆，不是执行经验/技能版本数据库 |
| 临时 Studio 事件和回合指标 | Python `EventHub` / `MetricsStore` | 每个 WS 订阅者有自己的有界队列；浏览器消费事件 | 进程内内存，EventHub 队列满时丢弃最旧项；MetricsStore 是有限容量聚合，非事件溯源日志 |
| 音频播放状态 | 当前 Sink / Core pipeline 与客户端 Mod 分别拥有 | Core 送出 chunks/flush；Mod 缓冲 PCM 并维护流式声源 | WebSocket 连接态；没有跨 Core/Mod 的持久播放检查点 |

## 跨边界协议目录

| 协议 | 所在代码 | 当前承担的语义 | 未提供的语义 |
| --- | --- | --- | --- |
| Core–Bridge WebSocket | `src/voxkin/server.py:StudioServer.bridge_socket`、`src/voxkin/bridge/protocol.py`、`bridge/minecraft_bridge.js:connectCore` | 握手、聊天/世界状态上报、动作请求、取消、可选进度、最终结果、死亡/重生 ACK；请求与结果以 `action_id` 相关联 | 没有任意多节点执行协议；没有通用技能在线注册/卸载或版本协商（握手协议当前为整数 1） |
| Core–Studio HTTP/WS | `src/voxkin/server.py:StudioServer.build`、`websocket` | 状态/控制 API、说话/打断命令、EventHub 事件订阅 | 不拥有游戏动作执行状态或持久任务数据库 |
| Core–Fabric Mod WS | `src/voxkin/audio/websocket.py`、`src/voxkin/server.py:audio_socket`、`mod/.../AudioSocketClient.java` | PCM 元数据帧与紧随其后的二进制音频、客户端 flush、服务端 ping 的 pong 响应处理、断线自动重连 | 不传输麦克风语音、Minecraft 世界状态或游戏动作 |
| LLM HTTP/SSE | `src/voxkin/llm/openai_compat.py` | 模型文本增量与 tool_call 组装 | LLM 返回工具调用不代表动作已经执行/游戏目标已验证 |
| TTS HTTP / Python API | `src/voxkin/tts/gpt_sovits.py`、`genie.py` | 文本到音频块 | 非任务/技能执行协议；引擎健康不代表游戏动作成功 |
| Minecraft 网络协议 | 第三方 mineflayer 与客户端/服务端 | bot 登录、观察与游戏内动作 | 不是 Voxkin 自定义 RPC，服务端是世界权威 |

## 内外模块的阅读边界

- **仓库内部模块**：`src/voxkin/`、`bridge/`、`mod/` 是同一仓库中的代码边界。它们可独立构建或运行，但并非都属于同一个进程。
- **语言模块与进程**：Python package 在 Python Core 进程内；JS skill 模块在 Node Bridge 进程内；Fabric entrypoint 与音频 Java 类运行在 Minecraft 客户端 JVM 中。文件夹/类/插件边界不可直接等同于 OS 进程边界。
- **仓库外部依赖**：Minecraft 服务端、模型 API、GPT-SoVITS 服务、Genie/faster-whisper 软件包、模型权重、音频设备均不是 Voxkin 内部进程。部分引擎可被 Core 包装或通过 `ServiceSupervisor` 启动，但这不改变其实现来源与 API 边界。
- **共享 bot context 不是沙箱**：技能模块接收 `buildSkillContext()`，可取得 `bot` 及操作辅助函数；代码模块化降低组织耦合，但没有隔离权限、崩溃边界或独立版本生命周期。
- **状态副本不等于所有权**：Bridge/Core 的状态是观察和控制记录；Minecraft 服务端拥有游戏真值。SQLite 中任务检查点也不拥有世界状态，只记录 Core 对执行游标的判断。

## 设计稿与代码现状的区分

下列资料描述目标结构、阶段路线或候选契约，不是当前进程图的证据：

- [plans/AUTONOMOUS_RUN_ARCHITECTURE.md](plans/AUTONOMOUS_RUN_ARCHITECTURE.md)：自主规划、验证、恢复的目标架构。
- [plans/INDEPENDENT_RUN_ROADMAP.md](plans/INDEPENDENT_RUN_ROADMAP.md)：独立通关阶段与验收路径。
- [plans/SKILL_MODULE_CONTRACT.md](plans/SKILL_MODULE_CONTRACT.md)：技能模块约定与建议。
- [plans/EVALUATION.md](plans/EVALUATION.md)：评测分层与未来验收设计。

需要判断已经实现、部分实现或计划中的能力时，优先交叉核对 [ARCHITECTURE.md](ARCHITECTURE.md)、[STATUS.md](STATUS.md)、[SKILLS.md](SKILLS.md)、实机证据与具体源代码；清单列有技能不等同于该技能已在目标服务器环境验收。
