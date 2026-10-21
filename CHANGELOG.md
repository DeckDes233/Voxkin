# 变更记录

## 0.1.0 — 2026-10-21

### 新增

- Voxkin Core：`ConversationPipeline`，支持流式 LLM、增量分句、流式 TTS、播放队列、打断与延迟时间线。
- 适配器：OpenAI 兼容流式 LLM、GPT-SoVITS `api_v2` 流式 TTS、Genie TTS（进程内 ONNX，受词表限制）、faster-whisper 识别、能量 VAD。
- 音频输出：扬声器、WAV 目录、Minecraft 文件投递。
- 动作通道：`ActionDispatcher` 与 Minecraft 桥接 WebSocket 协议，动作完成以桥接返回结果为准。
- Minecraft 桥接客户端 `bridge/minecraft_bridge.js`，支持聊天转发、移动、挖掘与状态上报。
- Voxkin Studio：状态、试听、实时事件、延迟分解、配置、受管服务启停与健康检查、日志。
- 本地测试 LLM：`tools/dev_llm_server.py`，OpenAI 兼容流式接口。
- 文档：仓库审计、MindCraft 源码审计、架构、技术评估、决策、路线图、状态、基准。

### 实测

- 5 轮连续对话，真实 TTS 与扬声器，首次可听延迟中位数 964 ms（复测 1173 ms）。
- Minecraft 端到端：Paper 1.21.1 上玩家聊天触发语音回复与挖掘动作，首次可听 975–1494 ms，动作完成 6108 ms。
- GPT-SoVITS 预热后首字节 2.4 秒 / 5.3 秒音频，RTF 0.477；`cut5` 首字节 1.17 秒。
- faster-whisper small / int8：9.88 秒中文音频 2.58 秒。
- 真实模型经 OpenCode Go 接入：3 轮首次可听 3134.9–4434.9 ms，模型返回 `collect_blocks` 并在游戏内完成挖掘。
- 工具定义下发与动作结果播报：开始前确认、完成后回报，失败时说明。

### 已知限制

- Genie TTS 无法加载 v2Pro 512 词表模型。
- 模型返回纯工具调用时没有正文，玩家先听到固定确认语。
