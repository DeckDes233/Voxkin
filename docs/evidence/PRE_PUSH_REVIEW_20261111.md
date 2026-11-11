# 推送前离线复核（2026-11-11）

本次将现有工作树的功能实现、测试、历史证据与文档整理提交到 develop，不作为正式 G1/G2 或稳定版发布。没有启动 Minecraft，也未修改活动 marker、旧任务预算或存档。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Python 3.10.0 | 554 passed，54 warnings，68.26 秒；使用默认断言重写 |
| Bridge，Node v22.23.2 | 310 passed，0 failed；测试运行约 1.39 秒 |
| Bridge 入口语法 | node --check 通过 |
| 文档链接 | 整理时已有 80 份 Markdown，本地文件目标无缺失；提交前再检查新增记录 |
| 敏感文件 | config/local.yaml、work/、models/ 未被跟踪 |
| 凭据检查 | git grep 常见密钥格式无命中；对已跟踪和未忽略文件补充本地凭据值比对无命中 |

Python 命令：`.\.venv\Scripts\python.exe -m pytest tests -q --basetemp work/push_review_20261111/pytest_tmp`。Bridge 在 bridge 目录运行 `node --test`。初次沙箱运行中 Python 默认临时目录无法创建、Node 测试子进程 spawn EPERM；前者改用工作区临时目录，后者在获准的沙箱外运行离线测试后通过。两次失败属于本次测试执行权限问题，不能据重跑通过宣称历史原生崩溃已修复。

测试包含确定性世界、动作、TTS 替身及已有物理回放，不是新 Minecraft 实机验收或语音延迟基准。原始输出保存在被忽略的 `work/push_review_20261111/`。

## 尚未完成

- G1：S3 恢复链仍缺实机通过，S4–S6 与完整零干预通关尚未验收。
- G2：仍需独立验证玩家目标理解、修改、打断、取消及结果反馈，不能用 G1 阶段测试替代。
- Windows/Bridge 历史原生异常尚未证明根因修复；实机前继续遵守活动 marker 和恢复证据要求。
- Fabric 音频 Mod 的真实客户端播放、空间音效与自然打断尚未完成验收。
- 里程碑、计划和 GOALS 的阶段合同差异仍需显式对齐，详见 [MILESTONE](../MILESTONE.md)。

本轮未构建 Mod，未测真实 API/TTS/STT，也未将研究中的流式 STT 或新 TTS 宣称为正式接入。项目状态以 [STATUS](../STATUS.md) 与具体历史证据为准。
