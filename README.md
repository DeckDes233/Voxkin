# 沃心 Voxkin

沃心是一个面向 Minecraft 的实时 AI 伙伴系统。它把「听见玩家 → 理解 → 用自然语音回答 → 在游戏里执行动作」拆成互不阻塞的通道：语音通道追求尽快出声，行动通道在后台执行并回报可验证的结果。

当前仓库包含可运行的本地语音链路、Minecraft 桥接协议与客户端、统一控制终端 Voxkin Studio，以及从现有项目迁移所需的模型准备脚本和审计文档。

## 当前能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 流式 LLM → 分句 → 流式 TTS → 播放 | 可运行 | 在本机以 5 轮连续对话实测，首次可听延迟中位数 964 毫秒，复测 1173 毫秒（本地测试 LLM、真实 TTS 与扬声器） |
| GPT-SoVITS v2Pro 音色复用 | 可运行 | 通过 `api_v2.py` 的 `streaming_mode`，直接使用现有 `xiaote` 权重与参考音频 |
| 本地语音识别 | 可运行 | faster-whisper small / int8 / CPU，中文 9.88 秒音频约 2.58 秒 |
| 端点检测与打断 | 可运行 | 能量 VAD、最短语音与静音阈值，检测到新语音即打断当前回复 |
| Minecraft 桥接 | 协议与客户端已完成，未连真实服务器验证 | WebSocket 协议已通过真实 WebSocket 集成测试；`bridge/minecraft_bridge.js` 需要 Minecraft 服务端才能端到端验证 |
| Minecraft 音频投递 | 可运行（复用现有 Mod） | 把语音按句写成 WAV 分段到现有 Mod 监听的目录，按音频时长节流以保证顺序 |
| Voxkin Studio | 可运行 | 状态、试听、实时事件、延迟分解、配置、日志 |

## 环境要求

- Windows 10/11，Python 3.10
- Node.js 20 以上（仅 Minecraft 桥接需要）
- GPT-SoVITS v2Pro 运行包（`runtime/python.exe`、`GPT_SoVITS`、`api_v2.py`）
- 音色权重：`GPT_weights/*.ckpt` 与 `SoVITS_weights/*.pth`
- 可选：NVIDIA 显卡（本项目在 RTX 4060 Laptop 8GB 上以 `cuda`、`is_half: true` 运行）

## 安装

```powershell
python -m venv .venv --system-site-packages
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

`genie-tts`、`faster-whisper`、`sounddevice` 按需安装：`pip install -e ".[tts,stt,audio]"`。

## 配置

- `config/voxkin.example.yaml`：可提交的配置样例。
- `config/voxkin.yaml`：本地实际配置，端口、模型路径等。
- `config/local.yaml`：不进入版本库的覆盖项，可写 API Key 与个人路径。

API Key 只从环境变量 `DEEPSEEK_API_KEY` 或 `config/local.yaml` 读取，日志与状态接口不会返回明文。

## 启动

```powershell
# 1. GPT-SoVITS 语音服务（独立目录，示例路径）
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml

# 2. Voxkin Studio 与控制服务
.\.venv\Scripts\python.exe -m voxkin serve
# 打开 http://127.0.0.1:8765

# 3. Minecraft 桥接（可选）
cd bridge
npm install
$env:MC_HOST="127.0.0.1"; $env:MC_PORT="25565"; $env:MC_USERNAME="Voxkin"
node minecraft_bridge.js
```

## 常用命令

```powershell
python -m voxkin doctor                     # 环境、模型、音频设备检查
python -m voxkin say "你好"                  # 一轮完整链路
python -m voxkin tts "你好" --out work\a.wav # 只测 TTS
python -m voxkin stt work\a16k.wav          # 只测识别
python -m voxkin bench --turns 5            # 连续多轮延迟基准
python -m voxkin mic --seconds 30           # 麦克风实时对话
```

## 目录

```
src/voxkin/            核心包：配置、事件、管线、适配器、服务
src/voxkin/studio/     Studio 前端资源
tests/                 单元测试与 WebSocket 集成测试
tools/dev_llm_server.py 本地 OpenAI 兼容流式服务，用于离线基准
bridge/                Minecraft 桥接客户端（Node.js）
docs/                  审计、架构、评估、决策、路线图、状态、基准
scripts/               模型准备与环境脚本
```

## 文档

- [仓库审计](docs/REPO_AUDIT.md)
- [架构与数据流](docs/ARCHITECTURE.md)
- [技术评估](docs/TECH_EVALUATION.md)
- [决策记录](docs/DECISIONS.md)
- [路线图](docs/ROADMAP.md)
- [当前状态](docs/STATUS.md)
- [基准结果](docs/BENCHMARK_RESULTS.md)
- [MindCraft 源码审计](docs/research/MINDCRAFT_AUDIT.md)

## 许可证与边界

本仓库不包含模型权重、参考录音与第三方运行包。真实 DeepSeek 请求默认不开启，基准使用本地测试服务，详见 [基准结果](docs/BENCHMARK_RESULTS.md)。
