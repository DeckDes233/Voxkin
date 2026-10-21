# 决策记录

每条记录包含：背景、选择、备选、代价、重新评估条件。

## D1 保留 GPT-SoVITS v2Pro 作为主 TTS

- 背景：现有音色只有 v2Pro 权重，Genie 词表不兼容（`docs/REPO_AUDIT.md` 第 4 节）。
- 选择：通过 `api_v2.py` 的 `streaming_mode` 获取分块音频，Core 侧做增量分句与队列。
- 备选：Genie（不可用）、CosyVoice 3.0（未验证）、IndexTTS 2.5（无流式声明）。
- 代价：依赖独立的 Python 3.9 运行包与 GPU；单请求固定开销约 0.4-0.9 秒。
- 重新评估：当 CosyVoice 3.0 或 IndexTTS 2.5 在本机中文场景的首段延迟低于 400 ms 且显存不超过 6 GB 时。

## D2 语音通道与行动通道分离

- 背景：旧链路把 LLM 完整回复、整段 TTS、文件写入与播放串在一起。
- 选择：`ConversationPipeline` 只处理语音；工具调用交给 `ActionDispatcher` 的后台任务，经 WebSocket 发给桥接进程。
- 备选：在 MindCraft 内部改造对话循环（需要修改上游，升级成本高）。
- 代价：两个通道需要各自维护状态与超时；动作结果通过事件回传，不在语音回合内。
- 重新评估：当上游 MindCraft 原生提供异步动作与流式文本接口时。

## D3 Minecraft 接入采用独立桥接进程

- 背景：MindCraft 子进程只暴露 Socket.IO，且其对话回合会等待完整 LLM 回复（见 `docs/research/MINDCRAFT_AUDIT.md`）。
- 选择：自建 mineflayer 桥接进程，WebSocket 与 Core 通信，动作串行执行并返回结构化结果。
- 备选：直接改造 MindCraft 的 `agent.js` 与 `prompter.js`（改动面大，且上游更新频繁）。
- 代价：需要维护自己的动作集合；不能直接复用 MindCraft 的全部技能。
- 重新评估：当 MindCraft 提供稳定的外部动作 API 或事件流时，可作为第二种桥接后端接入。

## D4 音频输出默认使用扬声器，游戏内使用文件投递

- 背景：现有 Mod 通过监听目录播放 WAV，无法保证多段顺序。
- 选择：单人验证用 `SpeakerSink`；游戏内用 `MinecraftFileSink` 按音频时长节流写文件。
- 备选：立刻开发客户端 Mod（周期长，先验证语音链路）。
- 代价：文件投递没有空间音源，无法精确打断，只能靠节流近似顺序。
- 重新评估：当需要空间音源或多人共享时，转为专用客户端 Mod。

## D5 配置分层与密钥隔离

- 背景：旧项目把 API Key 放在 `config.yaml`，并且服务监听 `0.0.0.0`。
- 选择：`config/voxkin.example.yaml` 入库，`config/voxkin.yaml` 存本地设置，`config/local.yaml` 存密钥并加入 `.gitignore`；服务默认监听 `127.0.0.1`；状态接口只报告是否配置。
- 备选：全部放在环境变量（对多引擎配置不友好）。
- 代价：多一层合并逻辑。
- 重新评估：当引入 Windows 凭据管理器时，把密钥读取改为凭据接口。

## D6 基准使用本地测试 LLM，真实 API 需显式授权

- 背景：仓库中没有真实 API 的费用授权。
- 选择：`tools/dev_llm_server.py` 提供 OpenAI 兼容流式服务，基准测的是管线开销；真实 DeepSeek 延迟需用户提供密钥后单独测量。
- 备选：直接使用现有第三方代理密钥（未经授权，不采用）。
- 代价：当前基准不含真实网络与模型首 token 延迟。
- 重新评估：用户明确授权并设置 `DEEPSEEK_API_KEY` 后，运行 `python -m voxkin bench` 记录真实数据。
