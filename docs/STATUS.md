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

## 测试结果

```
49 passed
```

覆盖：文本分句与过滤、时间线与指标、配置加载与保存、端点检测、对话管线（含打断）、动作派发、桥接 WebSocket 协议、聊天触发回合、动作与语音并行完成、外部服务启停与健康检查。

## 已知问题

1. 真实模型经 OpenCode Go 接入，接口需要 `x-opencode-session` 头；换用官方 DeepSeek 接口时需要调整配置。
2. 游戏内音频使用文件投递，没有空间音源，打断只能通过停止写新段实现。
3. 麦克风采集已验证可用（3.12 秒收到 94 个 32 ms 音频块），但未用真实说话验证识别与打断。
4. TTS 每句独立请求有 0.4–0.9 秒固定开销；首句过长会推迟出声。
5. Studio 配置修改需要重启服务生效。
6. mineflayer 在 1.21.1 上对部分物品包报 `PartialReadError`，当前不影响动作执行。
7. faster-whisper 对中文可能输出繁体字，尚未接入简繁转换。
8. 模型返回纯工具调用时没有正文，玩家先听到固定确认语「好的，我这就去。」，再听到结果播报。

## 阻塞与前置条件

| 阻塞 | 需要什么 |
| --- | --- |
| 游戏内客户端 Mod | JDK 21 与 Fabric 构建环境（音频投递已可用现有 Mod 验证） |
| 官方 DeepSeek 接口 | 官方 API Key 与费用授权；当前使用 OpenCode Go 订阅 |

## 下一步三件事

1. 把工具执行结果作为 `tool` 消息回填给模型，支持「失败后自己换方案」的多步动作。
2. 用真实麦克风说话校准 VAD，并测量说话结束到首次可听的完整链路。
3. 开发接收 PCM 的客户端 Mod，替换文件投递并获得空间音源与精确打断。
