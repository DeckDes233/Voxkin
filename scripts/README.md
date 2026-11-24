# 仓库脚本

从仓库根目录调用。首次安装见[入门指南](../docs/GETTING_STARTED_CN.md)，所有 Minecraft 实机入口先遵守 [AGENTS.md](../AGENTS.md) 的活动 marker 与环境恢复规则。

| 脚本 | 用途与边界 |
| --- | --- |
| `quickstart_player.py` | Windows 玩家互动启动器，启动/复用 Studio 与 Bridge；要求专用 Node 路径、现有服务器和合规的活动 marker |
| `bridge_watch.py` | 快捷启动器使用的 Bridge 监护与恢复辅助，不是通用服务管理器 |
| `eval_stack.ps1` | 独立模式评测进程组的 start/stop/status/restart；默认 Minecraft 25566、Core 8765；不会启动或创建 Minecraft 世界 |
| `run_stage.py` | 阶段评测、隔离复制和任务续跑；涉及服务器与世界操作，先读参数和评测计划 |
| `mc_reset.ps1` | 从模板重置专用评测世界，会改动目标目录；不要对用户存档运行 |
| `setup_gpt_sovits.py` | 本地 GPT-SoVITS 准备工具，运行包与模型留在本地 |
| `build_voice_cache.py` | 构建本地预生成语音缓存，需要对应引擎 |
| `latency_scenarios.py` | 延迟场景评测，结果须注明真实/测试 LLM 和音频引擎 |
| `dump_manifest.js`、`dump_labels.js`、`merge_module_skills.js` | 技能清单与标签维护；先读[技能开发说明](../bridge/skills/README.md)，生成后核对 diff |

## 玩家互动快捷启动

此入口针对当前 Windows 工作区，固定使用 `work/runtimes/node-v22.23.4-win-x64/node.exe` 和 `http://127.0.0.1:8765`。新克隆没有该运行时，先按[手动接入流程](../docs/ENTER_MINECRAFT_CN.md)安装配置。

```powershell
.\.venv\Scripts\python.exe scripts\quickstart_player.py --help
```

满足运行前条件后，默认连接本机 `25565`；可通过 `--host`、`--port` 指定目标。`--resume-current` 只用于同一世界已有任务的恢复，不能用来绕过 blocked 或未完成清理。

## 评测入口

```powershell
.\scripts\eval_stack.ps1 -Action status
.\.venv\Scripts\python.exe scripts\run_stage.py --help
```

`eval_stack.ps1` 依赖本机约定的 GPT-SoVITS 目录；缺少运行包时不会自动安装。其 `stop` 不停止 Paper。`run_stage.py` 的普通评测与隔离/续跑模式对世界和数据库的处理不同，不能把重置测试世界当作恢复旧任务。具体验收见[评测计划](../docs/plans/EVALUATION.md)，产物规范见 [runs](../runs/README.md)。
