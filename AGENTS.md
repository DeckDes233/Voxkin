# AGENTS.md

本文件约束后续接手 Voxkin 的代码 Agent。所有命令与路径都以仓库根目录为基准。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/voxkin/config.py` | 配置模型、YAML 加载、覆盖合并、保存 |
| `src/voxkin/events.py` | 时间线标记、指标聚合、事件分发 |
| `src/voxkin/text.py` | 可朗读文本过滤与增量分句 |
| `src/voxkin/pipeline.py` | 对话回合、TTS 队列、打断、动作派发 |
| `src/voxkin/llm/` | OpenAI 兼容流式客户端 |
| `src/voxkin/tts/` | TTS 适配器：`gpt_sovits`（HTTP 流式）、`genie`（进程内 ONNX） |
| `src/voxkin/audio/` | 麦克风采集、音频输出（扬声器 / WAV / Minecraft 文件） |
| `src/voxkin/stt/` | faster-whisper 识别与能量端点检测 |
| `src/voxkin/agent/actions.py` | 动作派发：转发给桥接并等待可验证结果 |
| `src/voxkin/bridge/protocol.py` | 桥接消息结构 |
| `src/voxkin/server.py` | Studio HTTP/WebSocket 服务与桥接入口 |
| `src/voxkin/services.py` | 外部引擎进程的启停、重启与健康检查 |
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

Windows 下 pip 需要绕过系统代理：设置 `NO_PROXY=*`。

## Git 规则

- 只做本地提交，不执行 `git push`。
- 每个提交只包含一个目的；提交前检查 `git diff --check`、`git status --short` 与文件清单。
- 不提交 `work/`、`models/`、`config/local.yaml`、日志、模型权重、参考录音与密钥。
- 不使用 `git reset --hard`、`git clean -fd`，不改写历史。

## 测试与证据

- 任何延迟结论必须来自 `docs/BENCHMARK_RESULTS.md` 记录的真实运行，并注明 LLM 是本地测试服务还是真实 API。
- 单元测试可以使用确定性测试替身（例如 `tests/support.py` 的 `ToneTTS`），但必须在文档中说明；不得用替身冒充真实引擎的测量结果。
- 新增引擎时，先补 `docs/TECH_EVALUATION.md` 的证据，再写适配器。

## 禁止事项

- 不把真实密钥写入代码、配置样例、日志或提交。
- 不覆盖 `D:\AI` 下的原始项目、模型与录音；需要复用时复制到 `work/` 或 `models/`。
- 不引入 `try/except` 包裹 import；缺依赖就让它失败。
- 不在代码中使用 docstring 开头的模块说明；注释用中文，术语保留英文。
- 不删除或改写用户已有的提交历史。
