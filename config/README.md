# 配置说明

[入门指南](../docs/GETTING_STARTED_CN.md) · [配置实现](../src/voxkin/config.py)

| 文件 | 用途 | Git |
| --- | --- | --- |
| `voxkin.example.yaml` | 可复制的公共示例，不含凭据或模型文件 | 提交 |
| `voxkin.yaml` | 当前主机运行配置 | 忽略 |
| `local.yaml` | 密钥、私有接口和本机覆盖 | 忽略 |
| `secrets.yaml` | 预留的私有文件名；当前加载器不会自动读取 | 忽略 |

首次配置时只在目标不存在时复制示例，避免覆盖已配置的引擎路径。

加载顺序为：配置类默认值 → 主配置 → 仓库 `config/local.yaml` 递归合并。`--config` 只替换主配置路径，**仍会读取仓库的 local.yaml**。CLI 的全局参数放在子命令前：

```powershell
.\.venv\Scripts\python.exe -m voxkin --config config\voxkin.yaml doctor
```

`llm.api_key` 非空时优先于 `llm.api_key_env` 指向的环境变量。`.env` 不会由当前加载器自动读取。配置保存会省略 `llm.api_key` 和 `llm.headers`，私有值放在 `local.yaml`。

| 配置段 | 负责内容 |
| --- | --- |
| `llm` | OpenAI 兼容地址、模型、凭据、生成与超时参数 |
| `brain` | 重大决策时使用 LLM 的开关、超时与结果有效期 |
| `tts` | `gpt_sovits` / `genie` / `silent`、模型与参考音频、服务管理 |
| `stt` | faster-whisper、模型、设备、VAD 与输入增益 |
| `audio` | `speaker` / `wav_dir` / `minecraft_file` / `websocket` 输出 |
| `server` | Studio 与 WebSocket 监听地址和端口 |
| `persona`、`memory` | 角色提示、历史和 SQLite 记忆 |
| `voice_cache`、`fast_path` | 预生成语音缓存与快速响应策略 |

从仓库根目录运行，便于解析示例中的相对模型与数据路径。模型、录音、数据库不随配置提交。配置字段的完整定义以 `src/voxkin/config.py` 为准，示例只包含常用字段。

## 自主任务

在 Studio 的“自主任务”面板选择阶段和运行方式。通过 HTTP 调用时，向 `POST /api/run/start` 发送 `{"stage":"S4","budget_mode":"adaptive"}` 即可启动相同任务。

| 运行方式 | 预算 |
| --- | --- |
| 自主生存（`adaptive`，Studio 默认） | 初始窗口为 24 个动作、30 分钟。观测到新的阶段物资、探明新区域等进展后，分别从当前动作数与时间延长窗口。重复走回已探索的区域或重复获得同样数量的物资不会延长窗口。 |
| 阶段验收（`acceptance`，HTTP 省略参数时的默认值） | S2 的上限为 48 个动作、30 分钟，其他标准阶段为 120 个动作、4 小时。脚本按此模式启动新阶段。 |

续跑和重连沿用原任务已记录的预算，旧存档沿用阶段验收。Studio 展示的“已用”是该阶段的累计动作数，当前上限会随已确认进展更新。`GET /api/run/status` 的 `action_budget` 提供 `mode`、`used`、`limit` 和 `deadline_at`。

`brain.enabled` 默认为 `true`，需要 `llm` 配置可用的 API 密钥。S2–S6 在主世界白天、有连通干地且周围安全时，会根据实际库存和路线，向模型提供扩大采木搜索、换区、出发前进食或重生后补给等可行选项。模型返回本次决策 ID 与候选 ID，Core 核对当前观察后派发已有技能。默认 `brain.timeout_s` 为 4 秒，`brain.result_ttl_s` 为 60 秒。超时或无有效选择时继续本地计划。遇险由 Bridge 直接自救，玩家可以照常打断任务。将 `brain.enabled` 设为 `false` 可完全使用本地阶段策略。
