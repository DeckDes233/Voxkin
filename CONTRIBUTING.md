# 开发与维护

[项目入口](README.md) · [文档导航](docs/README.md) · [Agent 约束](AGENTS.md)

## 环境与检查

使用 Python 3.10 和仓库 `.venv`，安装 `.[dev]`。声音、STT 和 Genie 分别按需增加 `audio`、`stt`、`tts` extras。Bridge 使用 `npm --prefix bridge install` 安装依赖。当前 Mineflayer 要求 Node ≥22，CI 使用 Node 22，本机快捷启动固定 Node 22.23.4。Mod 使用 JDK 21 与 Gradle 8.12 wrapper。

从仓库根目录运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
Push-Location bridge
node --test
Pop-Location
node --check bridge/minecraft_bridge.js
git diff --check
git status --short
```

当前 CI 覆盖 Python 与 Bridge 离线测试，不启动 Minecraft 或真实语音引擎。`tests/support.py` 的 `ToneTTS` 等确定性替身只用于逻辑验证。Windows 历史记录包含 pytest 收集阶段的原生访问违规；`--assert=plain` 曾通过全量测试，但它只是绕过断言重写的诊断方式，不证明宿主根因已解决，见[历史证据](docs/evidence/RESOURCE_VILLAGE_GOLEM_20261028.md)。

## 目录与所有权

- `src/voxkin/` 是 Python 包；Studio 页面在 `src/voxkin/studio/`，不要在根目录 `studio/` 建立另一份前端。
- `bridge/` 保存游戏桥接、技能和 Bridge 测试；技能参数合同在 `bridge/skills/manifest.json`，维护流程见[技能模块说明](bridge/skills/README.md)。
- `mod/` 保存客户端音频 Mod；它不承担游戏动作执行。
- `scripts/` 保存仓库维护、启动和阶段评测脚本；`tools/` 保存独立诊断工具。
- `config/voxkin.example.yaml` 是公开配置入口；实际配置、密钥、模型、录音与数据库保留在被忽略的本地目录。
- `docs/evidence/` 保存可提交的验证摘要，原始运行产物放 `work/` 或 `runs/`；保留失败现场与存档。

`ConversationPipeline` 负责语音回合，通过注入的 `ActionHandler` 派发动作。`GoalSupervisor` 独占标准阶段的派发、对账、持久化与预算，策略 helper 不做外部 I/O。详细边界以 [AGENTS.md](AGENTS.md)、[架构](docs/ARCHITECTURE.md)和[模块边界](docs/MODULE_BOUNDARIES.md)为准。

## 文档更新规则

| 变化 | 更新位置 |
| --- | --- |
| 安装、配置、启动命令 | 中英文 README、入门与 Minecraft 接入指南、相关目录 README |
| 当前结果或阻塞 | `docs/STATUS.md` 顶部摘要，并链接具体证据 |
| 新实测 | `docs/evidence/`，注明日期、环境、引擎、人工干预、替身与失败边界 |
| 延迟结论 | `docs/BENCHMARK_RESULTS.md`，区分真实 API 和本地测试 LLM |
| 架构或目标合同 | 架构/边界、`MILESTONE.md` 与相关计划；明确未对齐项 |
| 新文档 | `docs/README.md` 或相应分类索引 |

README 保留能力概览，不反复复制运行流水账和容易过时的测试总数。历史证据不改写为新结论；旧设计保留日期/用途，当前实现以源码与架构文档核对。中英文 README 的能力和限制保持一致。

## 实机与提交

Minecraft 运行前必须读取 `work/refactor_validation_20261027/active_progress.json`，遵守 [AGENTS.md](AGENTS.md) 的清理、环境阻塞与恢复要求。代码或文档整理不需要启动游戏。

每次提交只包含一个目的，先检查文件清单、差异和敏感信息。已有未提交改动应保留，按文件或补丁选择本次变更。`main` 用于已验证版本，`develop` 用于开发版本；不强推、不改写历史、不删除远端分支。不要提交 `work/`、`models/`、`config/local.yaml`、日志、录音、权重或密钥。
