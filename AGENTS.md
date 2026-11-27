# AGENTS.md

本文件约束后续接手 Voxkin 的代码 Agent。所有命令与路径都以仓库根目录为基准。

## 产品目标与恢复原则

- G1 是自主通关：角色围绕通关目标自行规划、执行和恢复，S0–S6 属于这条验收线。
- G2 是玩家互动：理解玩家说的目标并执行，支持玩家修改、打断和取消，反馈实际进展与结果；不能用 G1 阶段脚本代替 G2 的指令理解与验收。
- 局部找不到资源、寻路失败或遇水，应停止危险动作、保留当前目标，转入脱险、补给、换地点探索和重新规划。不得把局部候选耗尽直接等同于整个目标不可完成；也不得无变化地无限重试相同位置或伪造成功。
- 实机测试暴露阻塞后，继续按 Wiki、日志和世界观察定位、修复、复测。测试运行器结束一轮和清理进程不代表修复任务已完成；不以关服和记录失败替代解决问题。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/voxkin/config.py` | 配置模型、YAML 加载、覆盖合并、保存 |
| `src/voxkin/events.py` | 时间线标记、指标聚合、事件分发 |
| `src/voxkin/text.py` | 可朗读文本过滤与增量分句 |
| `src/voxkin/pipeline.py` | 对话回合、TTS 队列、打断、动作派发 |
| `src/voxkin/llm/` | OpenAI 兼容流式客户端 |
| `src/voxkin/tts/` | TTS 适配器：`gpt_sovits`（HTTP 流式）、`genie`（进程内 ONNX） |
| `src/voxkin/audio/` | 麦克风采集、音频输出（扬声器 / WAV / Minecraft 文件 / WebSocket） |
| `src/voxkin/stt/` | faster-whisper 识别与能量端点检测 |
| `src/voxkin/agent/actions.py` | 动作派发：转发给桥接并等待可验证结果 |
| `src/voxkin/agent/goals.py` | 阶段目标与唯一验收条件声明 |
| `src/voxkin/agent/goal_methods.py` | 阶段策略、资源选择与验收辅助；无外部 I/O，部分 helper 会更新传入的 `goal_state` 内存字典；由 `GoalSupervisor` 串行调用并统一负责派发、对账、SQLite 持久化与预算 |
| `src/voxkin/agent/late_game_methods.py` | S5/S6 的库存、维度与生存前置规划；不做外部 I/O，沿用 `GoalSupervisor` 的派发与持久化所有权 |
| `src/voxkin/agent/resource_policy.py` | 阶段储备软目标、村庄与铁傀儡机会补给；只规划和更新目标内存账本，执行与对账由 `GoalSupervisor` 负责 |
| `src/voxkin/agent/goal_supervisor.py` | 标准阶段目标的调度、派发、对账、持久化与预算所有权 |
| `src/voxkin/agent/strategy_choices.py`、`decision_brain.py` | 前者从世界观察生成可行策略，后者向已配置的 LLM 异步询问候选 ID，由调度器核验并派发 |
| `src/voxkin/agent/recovery_evidence.py`、`progress_budget.py` | 从已确认的动作回执和世界状态提取恢复证据，计算自主模式的无进展窗口 |
| `src/voxkin/bridge/protocol.py` | 桥接消息结构 |
| `src/voxkin/server.py` | Studio HTTP/WebSocket 服务与桥接入口 |
| `src/voxkin/services.py` | 外部引擎进程的启停、重启与健康检查 |
| `src/voxkin/memory.py` | SQLite 对话存储、摘要压缩、检索与上下文预算 |
| `src/voxkin/audio/websocket.py` | 向客户端 Mod 广播 PCM 分块 |
| `mod/` | Fabric 1.21.1 客户端音频 Mod（Java 21 与 Gradle 8.12） |
| `bridge/minecraft_bridge.js` | mineflayer 客户端，执行动作并回报结果 |
| `tools/dev_llm_server.py` | 本地测试 LLM，不访问外网 |
| `docs/` | 事实来源：审计、架构、评估、决策、路线图、状态、基准 |

## 架构边界

- `ConversationPipeline` 只负责语音回合：LLM 流、分句、TTS 队列、播放与打断。它不直接操作 Minecraft。
- 游戏动作通过 `ActionHandler` 注入，由 `ActionDispatcher` 经 WebSocket 发给桥接进程；动作在后台任务中执行，不阻塞语音回合。
- 适配器必须如实声明能力（`describe()` 中的 `capability`），不支持流式文本的引擎不得伪造流式接口。
- 音频输出通过 `AudioSink` 抽象；新增输出方式时实现 `start/play/flush/close/describe`。
- 任何引擎都不得在导入模块时做重活；模型加载放在 `initialize()`。

## 依赖与运行

- Python 3.10，虚拟环境 `.venv`；本项目在 `.venv` 中安装了 `genie-tts`、`faster-whisper`、`sounddevice`、`pyaudio`。
- 安装：`.\.venv\Scripts\python.exe -m pip install -e ".[dev]"`
- 启动服务：`.\.venv\Scripts\python.exe -m voxkin serve`
- 本地测试 LLM：`.\.venv\Scripts\python.exe tools\dev_llm_server.py --port 8799`
- 测试：`.\.venv\Scripts\python.exe -m pytest tests -q`
- 基准：`.\.venv\Scripts\python.exe -m voxkin bench --turns 5 --json work\bench.json`
- 客户端 Mod：`cd mod; $env:JAVA_HOME="<JDK 21>"; gradle build`（Gradle 8.12，需要代理访问 Fabric 与 Mojang 仓库）

Windows 下 pip 需要绕过系统代理：设置 `NO_PROXY=*`。

## Git 规则

- 可以推送到 `https://github.com/DeckDes233/Voxkin`：`main` 存放已验证版本，`develop` 存放开发中版本。
- 不强制推送，不改写已有提交历史，不删除远端分支。
- 推送前确认 `git grep` 找不到密钥，`config/local.yaml` 与 `work/` 未被跟踪。
- 每个提交只包含一个目的；提交前检查 `git diff --check`、`git status --short` 与文件清单。
- 不提交 `work/`、`models/`、`config/local.yaml`、日志、模型权重、参考录音与密钥。
- 不使用 `git reset --hard`、`git clean -fd`，不改写历史。

## 测试与证据

- Minecraft 功能出现阻塞或与预期不符时，先查 Minecraft Wiki，并按项目使用的 Java 版本核对机制；再结合日志、实际依赖实现与世界观察定位原因，最后决定修复方案。记录来源，区分机制事实、已证实缺陷和待验证推断，不先凭直觉改逻辑。
- 启动任何 Minecraft 实机运行前先读取 `work/refactor_validation_20261027/active_progress.json`。`cleanup_pending` 时不得另起运行；`runtime_blocked` 且没有新的环境恢复证据时，不重复相同失败条件或扩展临时 harness，保留证据和存档，可继续独立代码审查。环境恢复后进行一次有界验证并更新 marker 结果。
- 任何延迟结论必须来自 `docs/BENCHMARK_RESULTS.md` 记录的真实运行，并注明 LLM 是本地测试服务还是真实 API。
- 单元测试可以使用确定性测试替身（例如 `tests/support.py` 的 `ToneTTS`），但必须在文档中说明；不得用替身冒充真实引擎的测量结果。
- 新增引擎时，先补 `docs/TECH_EVALUATION.md` 的证据，再写适配器。

## 禁止事项

- 不把真实密钥写入代码、配置样例、日志或提交。
- 不覆盖 `D:\AI` 下的原始项目、模型与录音；需要复用时复制到 `work/` 或 `models/`。
- 不引入 `try/except` 包裹 import；缺依赖就让它失败。
- 不在代码中使用 docstring 开头的模块说明；注释用中文，术语保留英文。
- 不删除或改写用户已有的提交历史。
