# 入门：先启动 Voxkin Core

[返回文档导航](README.md) · 下一步：[连接 Minecraft](ENTER_MINECRAFT_CN.md)

先在 Studio 验证文字对话，再接入语音和 Minecraft。Core 可以单独运行；游戏动作另需 Bridge 与 Minecraft 服务端；客户端音频 Mod 是可选输出。

## 1. 准备环境

以下使用 Windows PowerShell，命令从仓库根目录执行，无需管理员权限。使用 Python 3.10；游戏桥接另需 Node.js ≥20，Minecraft 服务端和 Mod 构建另需 Java 21。

```powershell
python -m venv .venv
$env:NO_PROXY = "*"
.\.venv\Scripts\python.exe -m pip install -e ".[dev,audio]"
if (!(Test-Path config\voxkin.yaml)) {
    Copy-Item config\voxkin.example.yaml config\voxkin.yaml
}
```

`audio` 安装扬声器与麦克风所用的 sounddevice；`dev` 安装测试依赖，不包含 STT、Genie 或 GPT-SoVITS 运行包。已有虚拟环境可直接复用。

## 2. 配置模型

示例默认使用 `config/voxkin.example.yaml` 中的 DeepSeek 接口和模型名。使用匹配的服务商密钥：

```powershell
$env:DEEPSEEK_API_KEY = "<你的 API 密钥>"
```

环境变量只作用于当前终端及其子进程。其他 OpenAI 兼容服务需要配置匹配的 `llm.base_url`、`model` 和凭据；示例值并非所有服务商通用。

私有配置可写入 `config/local.yaml`，例如：

```yaml
llm:
  api_key: "<你的 API 密钥>"
```

此文件被 Git 忽略，不要上传。具体覆盖顺序见[配置说明](../config/README.md)。

## 3. 选择语音方式

### 暂时只验证文字与动作

在 `config/local.yaml` 中合并以下字段（保留已有的 `llm` 配置）：

```yaml
tts:
  engine: silent
audio:
  output: wav_dir
```

此模式不产生语音，用于验证 Core、模型与动作链路。以后启用语音时，要一起调整这些本地覆盖，否则它们会继续覆盖主配置。

### 使用 GPT-SoVITS 语音

准备自己的 GPT-SoVITS 运行包、音色权重和有权使用的参考音频。仓库不附带模型或录音。将参考音频放入 `models/reference/`，配置 `tts.reference_audio` 与对应的 `reference_text`，并核对语言与服务地址。

对于采用 `api_v2.py` 的运行包，在该运行包目录单独打开终端：

```powershell
.\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml
```

命令依赖你实际使用的运行包布局。Core 中设置 `tts.engine: gpt_sovits`、`tts.base_url: http://127.0.0.1:9880`、`audio.output: speaker`。Genie 使用 `.[tts]` 可选依赖与独立模型配置，适配器比较见[引擎评估](TECH_EVALUATION.md)。

## 4. 启动和检查

回到仓库根目录：

```powershell
.\.venv\Scripts\python.exe -m voxkin doctor
.\.venv\Scripts\python.exe -m voxkin serve
```

打开 [Studio](http://127.0.0.1:8765)，输入“你好”。检查回复文本、事件与引擎状态；启用真实 TTS 时再检查声音。`doctor` 是诊断入口，成功启动页面不代表模型凭据和真实语音均已可用。当前运行时在 TTS 初始化失败时可静音降级，需看日志确认。

结束时在运行 Core 的终端按 `Ctrl+C`。

## 5. 接入麦克风（可选）

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[stt,audio]"
.\.venv\Scripts\python.exe -m voxkin mic --listen-only
```

首次识别可能需要下载 `stt.model` 指定的 Whisper 模型。只识别检查通过后，可使用 Studio 的“开始聆听”，或结束该进程后运行 `python -m voxkin mic`（使用虚拟环境中的 Python）。

| 参数 | 用途 |
| --- | --- |
| `--listen-only` | 仅识别，不调用模型或 TTS |
| `--device "名称片段"` | 选择 Core 主机上的输入设备 |
| `--gain 4` | 放大较小的输入，按实际情况调整 |
| `--no-barge-in` | 关闭语音打断 |

Studio 控制的是 **Core 主机麦克风**，不采集远端浏览器或各玩家电脑的麦克风。外放可能被识别器收回，建议用耳机，测试时一次使用一种输入源。

## 6. 排查问题

| 现象 | 检查方向 |
| --- | --- |
| 页面打不开 | Core 日志、`server.host` / `port`、端口占用 |
| 有页面但没有模型回复 | API 凭据、模型名、接口地址、请求错误 |
| 有文字但无声音 | 是否启用了 `silent` 或静音降级；TTS 服务、参考音频与 `audio.output` |
| 连接 9880 失败 | GPT-SoVITS 是否启动，地址与端口是否匹配 |
| 麦克风不可用 | `.[stt,audio]`、输入设备、模型下载与主机系统权限 |
| 游戏动作没发生 | 继续按 [Minecraft 接入](ENTER_MINECRAFT_CN.md)检查 Bridge 与真实回执 |

改变 Core 端口后，浏览器、Bridge 的 `VOXKIN_WS` 和 Mod 的音频 URL 都要一起更新。延迟应按[真实基准记录](BENCHMARK_RESULTS.md)的引擎与环境解读，不把测试服务的速度当成真实 API 承诺。
