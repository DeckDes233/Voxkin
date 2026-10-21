# 当前状态

更新时间：2026-10-21 19:10（Asia/Shanghai）。

## 已完成

| 区域 | 内容 | 验证方式 |
| --- | --- | --- |
| 仓库审计 | MiddleAPI、Minecraft Mod、GPT-SoVITS 运行包、MindCraft 上游调用链 | 源码阅读与行号引用，见 `docs/REPO_AUDIT.md`、`docs/research/MINDCRAFT_AUDIT.md` |
| 语音管线 | 流式 LLM、增量分句、流式 TTS、播放队列、打断、时间线 | 43 个自动化测试通过；5 轮真实 TTS 基准 |
| TTS 接入 | GPT-SoVITS `api_v2.py` 的 `streaming_mode`，复用 `xiaote` 音色 | 本机真实合成并播放 |
| 识别 | faster-whisper small，中文文件识别 | 本机实测 |
| 端点检测 | 能量 VAD，合成音频测试 | 5 个测试用例 |
| 桥接 | WebSocket 协议、动作派发、mineflayer 客户端 | 真实 WebSocket 集成测试；客户端仅语法检查 |
| Studio | 状态、试听、事件流、延迟表、配置、受管服务、日志 | HTTP 接口实测；服务管理用真实子进程测试 |
| 基准 | `voxkin bench` 输出 JSON 与分位数 | `docs/BENCHMARK_RESULTS.md` |

## 测试结果

```
48 passed
```

覆盖：文本分句与过滤、时间线与指标、配置加载与保存、端点检测、对话管线（含打断）、动作派发、桥接 WebSocket 协议、聊天触发回合、动作与语音并行完成、外部服务启停与健康检查。

## 已知问题

1. 真实 DeepSeek 未测量：没有费用授权，所有基准使用本地测试 LLM。
2. Minecraft 端到端未验证：本机没有运行 Minecraft 服务端，桥接只做到协议与脚本层。
3. 游戏内音频使用文件投递，没有空间音源，打断只能通过停止写新段实现。
4. 麦克风实时链路未实测：没有用真实说话验证 VAD 阈值与噪声环境。
5. TTS 每句独立请求有 0.4-0.9 秒固定开销；首句过长会推迟出声。
6. Studio 配置修改需要重启服务生效。

## 阻塞与前置条件

| 阻塞 | 需要什么 |
| --- | --- |
| 真实 LLM 延迟 | 用户提供可用的 API Key 与费用授权 |
| 游戏内验证 | 本地 Minecraft Java 服务端（1.20.1 或 1.21） |
| 客户端 Mod | JDK 21 与 Fabric 构建环境 |

## 下一步三件事

1. 用真实 Minecraft 服务端跑通「游戏内聊天 → 语音回复 → 执行动作 → 回报结果」。
2. 获得授权后测真实 DeepSeek 首 token，把数据补进基准。
3. 在真实麦克风上校准 VAD，并测量说话结束到首次可听的完整链路。
