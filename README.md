# 沃心 Voxkin

面向 Minecraft Java 1.21.1 的实时语音伙伴与自主行动原型。Python Core 处理对话、语音与任务，Mineflayer 桥接执行游戏动作，可选 Fabric Mod 在客户端播放语音。

[English](README.en.md) · [文档导航](docs/README.md) · [入门安装](docs/GETTING_STARTED_CN.md) · [Minecraft 接入](docs/ENTER_MINECRAFT_CN.md) · [开发指南](CONTRIBUTING.md)

## 项目目标与现状

- **G1 自主通关**：从空背包开始，自行规划、执行和恢复，最终击败末影龙；S0–S6 是这条线的阶段验收。
- **G2 玩家互动**：理解并执行玩家目标，接受修改、打断和取消，反馈真实进展与结果。它需要独立验收。

标准阶段由持久化 `GoalSupervisor` 根据库存、环境和维度选择下一步，并对账动作回执。当前采用规则式阶段策略，已接入资源储备、村庄补给、铁傀儡取铁及群怪威胁评估。

玩家可以在采矿途中问“背包里有什么”。Bridge 直接读取当前背包，采矿继续持有移动控制权。麦克风在 Voxkin 回复期间继续收音，开启语音打断后可以直接插话。相关场景已有自动化回归。[调度与打断机制](docs/ARCHITECTURE.md#任务语音与动作控制)

最新实机记录见 [2026-11-22 无头 Paper 验证](docs/evidence/HEADLESS_S3_20261122.md)。

| 范围 | 验证状态 |
| --- | --- |
| 对话、TTS/STT、游戏动作桥接 | 已实现，真实引擎与模型需自行配置；延迟按[基准记录](docs/BENCHMARK_RESULTS.md)区分真实 API 与本地测试 LLM |
| S0–S2 | 新世界运行已有通过记录；S2 最近验收的是白天过夜准备，未证明实际过夜或三夜生存 |
| S3 | 本次采到 12 个粗铁，夜间等待采木时达到阶段时限。采铁储备的回执已修复并实机复核，低氧恢复链待验收 |
| S4–S6、村庄补给与铁傀儡取铁 | 已有实现与离线测试，尚无实机通过记录 |
| 技能 | 67 项，Core 暴露 66 个模型工具（不含 `chat`）；见[技能总表](docs/SKILLS.md) |
| Fabric 音频 Mod | 已构建，真实客户端播放与空间音效尚未验收 |
| 完整无人干预通关 | 尚未完成；Windows 原生崩溃问题仍未解决 |

最新结果与历史证据统一见 [STATUS](docs/STATUS.md)，目标和合同差异见 [MILESTONE](docs/MILESTONE.md)。单元测试中的确定性替身不能代替实机验收。

## 快速开始

以下命令从仓库根目录的 Windows PowerShell 执行。使用 Python 3.10；Bridge 需要 Node.js ≥20。Minecraft 服务端与 Mod 构建使用 Java 21。

```powershell
python -m venv .venv
$env:NO_PROXY = "*"
.\.venv\Scripts\python.exe -m pip install -e ".[dev,audio]"
if (!(Test-Path config\voxkin.yaml)) {
    Copy-Item config\voxkin.example.yaml config\voxkin.yaml
}
$env:DEEPSEEK_API_KEY = "<你的 API 密钥>"
```

配置示例使用 DeepSeek 兼容接口与 GPT-SoVITS。编辑 `config/voxkin.yaml` 中的引擎地址、参考音频与对应文本，启动自己的 TTS 服务后运行：

```powershell
.\.venv\Scripts\python.exe -m voxkin doctor
.\.venv\Scripts\python.exe -m voxkin serve
```

打开 [Voxkin Studio](http://127.0.0.1:8765)。没有 TTS 时可按[入门指南](docs/GETTING_STARTED_CN.md)使用静音配置查看文字与动作；麦克风另需 `.[stt,audio]` 和 Whisper 模型。密钥与私有覆盖放在 Git 忽略的 `config/local.yaml` 或环境变量，配置优先级见[配置说明](config/README.md)。

## 连接 Minecraft

先完成 [Minecraft 接入与运行前检查](docs/ENTER_MINECRAFT_CN.md)，确认测试服务器和 Core 已就绪。在另一个仓库根目录终端执行：

```powershell
npm --prefix bridge install
$env:MC_HOST = "127.0.0.1"
$env:MC_PORT = "25565"
$env:MC_VERSION = "1.21.1"
$env:MC_USERNAME = "Voxkin"
$env:MC_AUTH = "offline"
$env:VOXKIN_WS = "ws://127.0.0.1:8765/ws/bridge"
$env:VOXKIN_INDEPENDENT = "0"
node bridge/minecraft_bridge.js
```

`VOXKIN_INDEPENDENT=0` 用于玩家互动；`1` 用于独立通关模式。阶段测试、已有任务续跑和本机快捷启动的前置条件见[脚本说明](scripts/README.md)。

Core 主机的扬声器是默认输出。远端玩家可通过 Minecraft 聊天输入文字；当前麦克风采集在 Core 主机，未接入各玩家的远端麦克风。在游戏客户端听到回复需配置 `audio.output: websocket` 并安装[音频 Mod](mod/README.md)。离线服务器与无认证的 Studio 只用于本机或可信隔离 LAN，不暴露到公网。

## 仓库结构

| 目录 | 用途 |
| --- | --- |
| [src/voxkin/](src/voxkin/) | Core、语音链路、任务监督器、API；Studio 前端在 `src/voxkin/studio/` |
| [bridge/](bridge/) | Mineflayer 连接、技能、世界观察与动作回执 |
| [mod/](mod/) | Fabric 1.21.1 客户端音频 Mod |
| [config/](config/README.md) | 可提交配置示例与本地覆盖规则 |
| [scripts/](scripts/README.md)、[tools/](tools/README.md) | 启停、评测、清单维护与独立诊断工具 |
| [tests/](tests/)、[bridge/tests/](bridge/tests/) | Python 与 Node 离线回归 |
| [docs/](docs/README.md) | 使用说明、架构、计划、研究与实测证据 |
| [runs/](runs/README.md) | 本地运行记录约定，原始产物不入库 |

`work/`、`models/`、`data/`、`logs/` 是本地运行目录，不属于源码交付。不要删除其中的世界、任务数据库或待对账证据。目录职责和贡献规则见 [CONTRIBUTING](CONTRIBUTING.md)，Agent 约束见 [AGENTS](AGENTS.md)。

## 开发验证

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
Push-Location bridge
node --test
Pop-Location
git diff --check
```

离线测试不启动 Minecraft，也不等价于真实引擎延迟测量。Windows 已记录默认 pytest 收集时的原生异常及 `--assert=plain` 的历史通过结果，适用边界见[开发指南](CONTRIBUTING.md)。实机运行前必须读取活动 marker，遵循 [AGENTS.md](AGENTS.md) 的阻塞与恢复规则。

## 许可证

[MIT](LICENSE)。第三方引擎、模型与参考音频各自的授权边界见[许可证分析](docs/LICENSE_ANALYSIS.md)。
