# 沃心 Voxkin

<p align="center">
  <b>面向 Minecraft 的实时语音伙伴与自主行动原型</b><br>
  对话与语音 · 游戏动作桥接 · 固定阶段任务 · 可复现评测
</p>

Voxkin 连接 Python Core、Minecraft 桥接进程与 Minecraft 世界。玩家通过游戏聊天或麦克风输入，Core 生成回复并派发受支持的动作，桥接执行后回传结果。项目探索无人干预的生存与通关，但目前不能独立通关：长任务使用固定阶段计划，尚无通用动态图执行器或自主技能生成、发布闭环。

English: [README.en.md](README.en.md).

## 当前状态

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| Core 对话、语音与 Minecraft 动作桥接 | 已实现；具体引擎依赖本地配置，技能清单不代表全部经实机验证 | [状态](docs/STATUS.md)、[桥接协议](bridge/README.md)、[技能](docs/SKILLS.md) |
| S0 | 已实机验证：Normal 难度 10/10 轮完成 5/5 步 | [S0 证据](docs/evidence/S0_NORMAL_20261022.md) |
| S1 | 部分验证：白天 S0→S1 链式回归 3/3；夜间生存未验证，M3 未验收 | [S1 证据](docs/evidence/S1_NORMAL_20261022.md) |
| S2–S6、全流程 | 2026-10-24 两次隔离实机链均在 S2 中断；S3–S6 未运行，未完成无人干预通关 | [本轮实机记录](docs/evidence/S0_S6_CHAIN_20261024.md)、[里程碑](docs/MILESTONE.md) |
| 技能 | 技能代码已实现；除 S0/S1 证据明确覆盖的技能外，不能据技能清单或模拟测试宣称实机通过 | [技能清单与证据边界](docs/SKILLS.md) |
| Fabric 音频 Mod | 构建通过；真实客户端端到端效果未验证 | [状态](docs/STATUS.md) |

自动化测试、模拟世界测试和 Paper 实机回归不能互相替代。最终目标与验收定义见 [docs/MILESTONE.md](docs/MILESTONE.md)。

## 内外模块边界

“内 / 外”表示 Voxkin 与外部环境、服务的边界，不意味着支持插件热插拔。

```mermaid
flowchart LR
    P[玩家：聊天 / 麦克风] --> C[内部：Python Core]
    B[外部接入：Node.js mineflayer 桥接] <-->|WebSocket：聊天、状态、动作、结果| C
    P -->|游戏聊天| B
    B <-->|Minecraft 协议| M[外部 Minecraft 服务端]
    C <--> L[外部 LLM / TTS]
    U[Studio] <-->|HTTP / WebSocket| C
    A[可选 Fabric 音频 Mod] <-->|音频 WebSocket| C
```

| 边界 | 职责 | 代码 |
| --- | --- | --- |
| 内部 Core | 语音回合、引擎适配、动作派发与仲裁、固定任务 Runner、记忆、Studio API | [`src/voxkin/`](src/voxkin/)、[`__main__.py`](src/voxkin/__main__.py) |
| 外部游戏桥接 | mineflayer 登录、执行动作/技能、回传结果和世界状态 | [`bridge/minecraft_bridge.js`](bridge/minecraft_bridge.js)、[`bridge/skills/`](bridge/skills/) |
| 外部服务 | Minecraft、LLM、TTS；由配置或协议接入 | [`config/voxkin.example.yaml`](config/voxkin.example.yaml) |
| 可选客户端输出 | Mod 收 PCM 并在游戏客户端播放，不执行游戏动作 | [`mod/`](mod/) |

真实控制链路：输入 → Core 对话/意图 → LLM 工具调用或本地快路 → 动作仲裁/派发 → 桥接执行 → 结果回传。自主阶段任务由 `TaskRunner` 执行固定步骤，并非 LLM 动态规划的通用任务图。桥接消息结构见 [桥接协议](bridge/README.md)，阶段事实见 [当前状态](docs/STATUS.md)。

## 最小启动

以下以 Windows PowerShell 为例，需要 Python 3.10：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item config\voxkin.example.yaml config\voxkin.yaml
$env:DEEPSEEK_API_KEY = "<your API key>"
.\.venv\Scripts\python.exe -m voxkin doctor
.\.venv\Scripts\python.exe -m voxkin serve
```

打开 <http://127.0.0.1:8765>。密钥可用环境变量或 Git 忽略的 `config/local.yaml` 本地覆盖；勿提交密钥。缺少有效 LLM 凭据时模型对话不可用；TTS 不可用会降级为日志输出。麦克风还需要 STT/音频依赖和识别模型，语音合成需要可用 TTS 引擎。

## 接入 Minecraft

准备 Minecraft 1.21.1 服务端，先启动 Core，再启动桥接：

```powershell
cd bridge
npm install
$env:MC_HOST = "127.0.0.1"
$env:MC_PORT = "25565"
$env:MC_USERNAME = "Voxkin"
$env:MC_AUTH = "offline"
$env:VOXKIN_WS = "ws://127.0.0.1:8765/ws/bridge"
node minecraft_bridge.js
```

离线账号只应连接本机或可信测试服；`online-mode=false` 会削弱身份验证，不要暴露到公网。Mod 可选，虽可构建，真实客户端播放/空间音效尚未验收。完整步骤：[Minecraft 接入](docs/ENTER_MINECRAFT_CN.md)。

### 一键启动本地实机测试栈

先手动启动你准备好的 **Minecraft 1.21.1 专用测试服**，确认它监听本机 `25566` 端口；然后在仓库根目录运行：

```powershell
.\scripts\eval_stack.ps1 -Action start -McPort 25566
```

脚本会启动已配置的 GPT-SoVITS（若本机运行包存在）、Voxkin Studio 和独立模式的 Minecraft 桥接；它**不会启动、重置或创建 Minecraft 服务器/世界**。浏览器打开 <http://127.0.0.1:8765>，Studio 的桥接状态应显示已连接。结束时运行：

```powershell
.\scripts\eval_stack.ps1 -Action stop
```

停止命令只结束脚本启动的进程，不会停止 Paper。不要把桥接连到有价值的存档或正在使用的评测世界；脚本默认使用离线用户名 `Voxkin`。如测试服端口不同，调整 `-McPort`。更多准备条件见 [Minecraft 接入](docs/ENTER_MINECRAFT_CN.md)。

## 自主通关进度

- **S0：** Normal 难度 10 次均 5/5；只证明该阶段，不证明完整自治。
- **S1：** 3 次白天 S0→S1 链式回归；三夜生存未验证，M3 未通过。
- **S2–S6：** 有计划及技能实现；2026-10-24 两次隔离实机链均在 S2 停止，S3–S6 未运行。死亡恢复、跨维度和末影龙战斗未最终验收。
- **G1：** 尚未进行零干预全流程通关。

路线图不是能力声明。见[状态](docs/STATUS.md)、[阶段计划](docs/plans/INDEPENDENT_RUN_ROADMAP.md)、[实机证据目录](docs/evidence/)。

## 文档

[新手上手](docs/GETTING_STARTED_CN.md) · [桥接协议](bridge/README.md) · [技能清单](docs/SKILLS.md) · [状态](docs/STATUS.md) · [里程碑](docs/MILESTONE.md) · [评测方法](docs/plans/EVALUATION.md) · [基准](docs/BENCHMARK_RESULTS.md) · [许可证分析](docs/LICENSE_ANALYSIS.md)

## 许可证

MIT，见 [LICENSE](LICENSE)。
