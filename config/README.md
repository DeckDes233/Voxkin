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
| `tts` | `gpt_sovits` / `genie` / `silent`、模型与参考音频、服务管理 |
| `stt` | faster-whisper、模型、设备、VAD 与输入增益 |
| `audio` | `speaker` / `wav_dir` / `minecraft_file` / `websocket` 输出 |
| `server` | Studio 与 WebSocket 监听地址和端口 |
| `persona`、`memory` | 角色提示、历史和 SQLite 记忆 |
| `voice_cache`、`fast_path` | 预生成语音缓存与快速响应策略 |

从仓库根目录运行，便于解析示例中的相对模型与数据路径。模型、录音、数据库不随配置提交。配置字段的完整定义以 `src/voxkin/config.py` 为准，示例只包含常用字段。
