# 当前状态

更新时间：2026-10-21 19:45（Asia/Shanghai）。

## 已完成

| 区域 | 内容 | 验证方式 |
| --- | --- | --- |
| 仓库审计 | MiddleAPI、Minecraft Mod、GPT-SoVITS 运行包、MindCraft 上游调用链 | 源码阅读与行号引用，见 `docs/REPO_AUDIT.md`、`docs/research/MINDCRAFT_AUDIT.md` |
| 语音管线 | 流式 LLM、增量分句、流式 TTS、播放队列、打断、时间线 | 43 个自动化测试通过；5 轮真实 TTS 基准 |
| TTS 接入 | GPT-SoVITS `api_v2.py` 的 `streaming_mode`，复用 `xiaote` 音色 | 本机真实合成并播放 |
| 识别 | faster-whisper small，中文文件识别 | 本机实测 |
| 端点检测 | 能量 VAD，合成音频测试 | 5 个测试用例 |
| 桥接 | WebSocket 协议、动作派发、mineflayer 客户端 | 真实 WebSocket 集成测试；Paper 1.21.1 上完成聊天到动作的端到端验证 |
| Studio | 状态、试听、事件流、延迟表、配置、受管服务、日志 | HTTP 接口实测；服务管理用真实子进程测试 |
| 基准 | `voxkin bench` 输出 JSON 与分位数；真实模型与 Minecraft 端到端计时 | `docs/BENCHMARK_RESULTS.md` |
| 真实模型 | OpenCode Go（`deepseek-v4.1-flash`）流式对话、工具调用与延迟测量 | 3 轮基准首次可听 3134.9–4434.9 ms；游戏内触发 `collect_blocks` 成功 |
| 长期记忆 | SQLite 保存对话，空闲时压缩摘要，按关键词检索并限制上下文预算 | 4 轮真实对话后 16 条消息、2 条摘要；摘要延迟 10 秒后生成，不干扰对话 |
| 繁简转换 | 识别结果统一转简体 | 3 个转换测试 |
| 客户端 Mod | Fabric 1.21.1，WebSocket 接收 PCM | 构建成功（`voxkin-audio-0.1.0.jar`，10.7 KB）；未在真实客户端验证 |
| 音频推送 | `/ws/audio` 向客户端广播 PCM | 真实 TTS 推送 412160 字节 / 6.44 秒，共 4 个分块 |

## 测试结果

```
62 passed
```

覆盖：文本分句与过滤、时间线与指标、配置加载与保存、端点检测、对话管线（含打断）、动作派发、桥接 WebSocket 协议、聊天触发回合、动作与语音并行完成、外部服务启停与健康检查。

## 已知问题

1. 真实模型经 OpenCode Go 接入，接口需要 `x-opencode-session` 头；换用官方 DeepSeek 接口时需要调整配置。
2. 游戏内音频有两条路：文件投递与 WebSocket PCM。两条都没有空间音源，客户端 Mod 目前使用系统混音器，未接入游戏混音器。
3. 客户端 Mod 只完成编译与协议实现，没有在真实 Minecraft 客户端验证。
4. 麦克风采集已验证可用（3.12 秒收到 94 个 32 ms 音频块），但未用真实说话验证识别与打断。
5. TTS 每句独立请求有 0.4–0.9 秒固定开销；首句过长会推迟出声。
6. Studio 配置修改需要重启服务生效。
7. mineflayer 在 1.21.1 上对部分物品包报 `PartialReadError`，当前不影响动作执行。
8. 记忆压缩依赖模型调用，离线时只保留原始对话，不生成摘要。

## 阻塞与前置条件

| 阻塞 | 需要什么 |
| --- | --- |
| 客户端 Mod 端到端 | 可运行的 Minecraft 1.21.1 客户端与 Fabric 环境 |
| 空间音源 | 接入 Minecraft OpenAL 混音器的 Mixin 实现 |
| 官方 DeepSeek 接口 | 官方 API Key 与费用授权；当前使用 OpenCode Go 订阅 |

## 下一步三件事

1. 把工具执行结果作为 `tool` 消息回填给模型，支持「失败后自己换方案」的多步动作。
2. 用真实麦克风说话校准 VAD，并测量说话结束到首次可听的完整链路。
3. 在客户端 Mod 中接入 OpenAL 空间音源，并做真实客户端验证。
