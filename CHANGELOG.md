# 变更记录

## Unreleased — 2026-10-22

### 自主任务

- 新增 `TaskRunner`、`StepSpec`、机器 `Verifier`、SQLite checkpoint 与 `RunManager`，提供 `/api/run/start|status|stop`。
- 新增 S0 计划：空背包收集 3 原木 → 12 木板 → 工作台 → 4 木棍 → 木镐。
- S0 在固定 seed 的 Peaceful 功能试跑中连续 2 次 5/5，证据见 `docs/evidence/S0_20261022.md`。

### 修复

- 掉落物过滤改用 `entity.name === 'item'`，此前 `entity.type === 'item'` 永远匹配不到，挖树后捡不到原木。
- 采集目标改为按树干底部接近，避免 pathfinder 爬树；单棵树 30 秒上限并自动换目标。
- 合成改为自己操作合成窗口，逐格放置并留 80 ms 确认间隔；放下工作台后回收，修复 3x3 配方找不到工作台。
- 动作完成后先推一帧世界状态再回结果；Runner 验证最多等待 6 秒，避免用旧背包误判。
- 采集/拾取后主动同步背包，修复 mineflayer 漏掉 `set_slot` 导致的假空背包。

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
- 长期记忆：SQLite 保存对话，空闲时压缩摘要，关键词检索并按 token 预算组装上下文。
- 识别结果繁简转换。
- 识别幻觉过滤：拦截「字幕by索兰娅」等 Whisper 模板输出、重复循环、低信息与低置信片段。
- WebSocket 音频推送与 Fabric 客户端 Mod（PCM 顺序播放与打断）。
- 中文、英文与小白版文档；Studio 截图。
- 识别过滤：17 个单元测试通过，真实 5 秒静音输入返回空文本。
- 项目采用 MIT 许可证。
- 麦克风对话模式：VAD 自适应校准、输入增益、播放结束回声冷却、只听不答模式。

### 已知限制

- Genie TTS 无法加载 v2Pro 512 词表模型。
- 模型返回纯工具调用时没有正文，玩家先听到固定确认语。
