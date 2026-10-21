# 沃心架构

## 1. 组件

```mermaid
graph TD
    subgraph Game["Minecraft 与游戏侧"]
        MC[Java 版客户端/服务端]
        MOD[现有音频播放 Mod]
        BR[Minecraft 桥接<br/>mineflayer]
    end

    subgraph Core["Voxkin Core（Python 进程）"]
        SRV[aiohttp 服务<br/>Studio + 桥接 WebSocket]
        PIPE[ConversationPipeline<br/>回合/队列/打断]
        SPLIT[SentenceSplitter<br/>可朗读文本]
        DISP[ActionDispatcher]
        HUB[EventHub]
        MET[MetricsStore]
    end

    subgraph Engines["引擎适配层"]
        LLM[LLM 适配器<br/>OpenAI 兼容流式]
        TTS[GptSoVITSClient<br/>流式音频]
        STT[WhisperSTT]
        VAD[VadSegmenter]
    end

    subgraph Output["音频输出"]
        SPK[SpeakerSink]
        WAV[WavDirSink]
        MCF[MinecraftFileSink]
    end

    subgraph Studio["Voxkin Studio 前端"]
        UI[浏览器控制台]
    end

    MC -->|聊天事件| BR
    BR -->|WebSocket chat| SRV
    BR -->|action_result| DISP
    MC -->|真实动作| BR

    SRV --> PIPE
    PIPE --> SPLIT
    SPLIT --> PIPE
    PIPE --> LLM
    PIPE --> TTS
    TTS --> PIPE
    PIPE --> DISP
    DISP -->|action| BR
    PIPE --> MET
    PIPE --> HUB

    PIPE --> SPK
    PIPE --> WAV
    PIPE --> MCF
    MCF -->|WAV 分段| MOD
    MOD -->|播放| MC

    UI <-->|HTTP/WebSocket| SRV
    HUB --> UI

    MIC[麦克风] --> VAD --> STT --> PIPE
```

## 2. 两条并行通道

```mermaid
graph LR
    subgraph Voice["语音通道（不等待动作）"]
        A1[玩家语音/文本] --> A2[STT 或桥接 chat]
        A2 --> A3[LLM 流式文本]
        A3 --> A4[分句]
        A4 --> A5[TTS 流式音频]
        A5 --> A6[播放队列]
        A6 --> A7[扬声器/Mod]
    end

    subgraph Action["行动通道（后台，可长时运行）"]
        B1[LLM tool_call] --> B2[ActionDispatcher]
        B2 --> B3[桥接进程]
        B3 --> B4[mineflayer 执行]
        B4 --> B5[结果校验]
        B5 --> B6[action_result 回到 Core]
    end

    A3 -.工具调用与口语文本分离.-> B1
```

语音通道不会等待行动通道；行动结果通过事件与时间线单独记录，`t8` 只有在桥接返回成功后才写入。

## 3. 完整时序

```mermaid
sequenceDiagram
    autonumber
    participant P as 玩家
    participant B as 桥接/mineflayer
    participant S as Studio 服务
    participant C as ConversationPipeline
    participant L as LLM
    participant T as GPT-SoVITS api_v2
    participant O as 音频输出

    P->>B: 游戏内聊天
    B->>S: WebSocket chat（进程：Node）
    S->>C: respond(text)
    Note over C: t0 语音结束 / t1 最终文本（同一进程，非阻塞）
    C->>L: POST /chat/completions stream=true
    L-->>C: data: 首 token
    Note over C: t2 首 token
    C->>C: 增量分句
    Note over C: t3 首个可朗读句子
    C->>T: POST /tts streaming_mode=true
    Note over C: t4 TTS 收到文本
    T-->>C: WAV 头 + PCM 首块
    Note over C: t5 首段音频
    C->>O: play(pcm)
    O-->>C: 首次写入声卡回调
    Note over C: t6 首次可听

    par 行动通道
        L-->>C: tool_call
        C->>C: t7 动作开始
        C->>B: WebSocket action
        B->>P: 游戏内移动/挖掘
        B-->>C: action_result ok
        C->>C: t8 动作完成并验证
    end

    P->>B: 再次说话（打断）
    B->>S: WebSocket chat
    S->>C: respond 新请求
    C->>C: interrupt：关闭旧 TTS 响应、清空播放队列
    C->>T: 新请求
    Note over C: 旧回合标记 interrupted，新回合重新计时
```

时序说明：

| 环节 | 进程 | 接口 | 阻塞关系 |
| --- | --- | --- | --- |
| 游戏聊天采集 | Node 桥接 | mineflayer `chat` 事件 | 不阻塞 |
| 文本注入 | Core | WebSocket `/ws/bridge` | 立即返回，回合在后台任务执行 |
| LLM 流 | Core | HTTPS SSE | 只阻塞当前回合，不阻塞其他回合以外的工作 |
| 分句 | Core | 进程内 | 同步、微秒级 |
| TTS | 独立进程 | HTTP 分块响应 | 串行占用 TTS；新回合会中断旧请求 |
| 播放 | Core | PortAudio 回调 | 独立线程，队列非阻塞 |
| 动作 | Node 桥接 | WebSocket | 后台任务，不阻塞语音 |

## 4. 关键接口

- `TTSAdapter`：`initialize()`、`synthesize(text) -> AsyncIterator[np.ndarray]`、`stop()`、`describe()`。
- `AudioSink`：`start()`、`play(turn_id, pcm)`、`flush()`、`close()`、`describe()`。
- `ActionDispatcher`：`attach(sender)`、`dispatch(tool, arguments)`、`resolve(ActionResult)`。
- 桥接消息：`hello`、`chat`、`state`（桥接 → Core）；`welcome`、`action`（Core → 桥接）；`action_result`（桥接 → Core）。

## 5. 并发模型

- 一个 Core 进程、一个事件循环；TTS 合成在独立进程中执行，网络 I/O 全部异步。
- 同一时间只保留一个语音回合；新回合通过递增的 `generation` 使旧回合失效，并关闭旧 TTS HTTP 响应。
- 播放使用独立线程与有界队列；新回合开始时清空队列，避免上一轮音频拖尾。
- 动作使用后台任务集合，跨回合继续执行；Core 关闭时统一取消。
- TTS 适配器内部加锁，保证同一时刻只有一个合成会话（Genie 的全局播放器与 GPT-SoVITS 的服务端都按串行处理）。

## 6. 故障恢复

| 故障 | 行为 |
| --- | --- |
| LLM 非 200 | 抛出 `LLMError`，回合标记失败，Studio 收到 `turn_failed` |
| LLM 流中断 | 当前回合失败，已生成句子仍会播放完 |
| TTS 服务不可用 | `initialize()` 直接失败；运行中失败则回合失败并记录 |
| 桥接断开 | 未完成动作收到「桥接已断开」，不会伪造成功 |
| 播放设备不可用 | `SpeakerSink.start()` 直接抛错，可切换到 `wav_dir` |
| 用户打断 | 关闭旧 TTS 响应、清空播放队列、旧回合不再写指标以外的状态 |
