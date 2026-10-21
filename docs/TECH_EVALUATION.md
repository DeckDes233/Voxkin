# 技术评估

本文件只记录有来源的事实。厂商宣传与本机测量分开标注。

## 1. TTS 引擎

### 1.1 GPT-SoVITS v2Pro（当前采用）

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| 官方仓库 | RVC-Boss/GPT-SoVITS | https://github.com/RVC-Boss/GPT-SoVITS |
| 本机版本 | `v2pro-20250604` 完整运行包，Python 3.9.13，torch 2.0.0+cu118 | 本机 `runtime/python.exe` 实测 |
| 权重 | `GPT_weights/xiaote.ckpt`（155 MB）、`SoVITS_weights/xiaote.pth`（85 MB） | 本机文件 |
| 流式接口 | `POST /tts`，`streaming_mode=true`，首块为 WAV 头，其后为 PCM 分块 | `api_v2.py:300-366` |
| 首段延迟 | 两句话、`cut5`：1173 ms / 1427 ms；`cut0`：3073 ms | 本机实测，RTX 4060 Laptop |
| 单句合成 | 5.3 秒音频约 2.39-2.47 秒，RTF 0.477 | 本机实测（预热后） |
| 冷启动 | 首次请求首字节 7470 ms | 本机实测 |
| 显存占用 | 约 2.3 GB | 本机 `nvidia-smi` |
| 复用现有音色 | 直接加载 `.ckpt` 与 `.pth`，无需转换 | 本机实测 |

结论：现有音色与运行包可以直接进入实时链路，`streaming_mode` 是本次延迟改进的核心开关。单请求仍有约 0.4-0.9 秒固定开销，因此首句越短，首次出声越早。

### 1.2 Genie TTS

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| 安装包 | `genie-tts` 2.0.2，主页 `https://github.com/High-Logic/Genie` | `pip show genie-tts` |
| 模型仓库 | `https://huggingface.co/High-Logic/Genie`，含 `GenieData` 与 v2ProPlus 角色模型 | HuggingFace API 文件列表 |
| 推理形式 | ONNX Runtime；可 CPU 或 GPU；`tts_async` 通过回调分块返回 | 包内 `Internal.py`、`Core/TTSPlayer.py` |
| 增量文本 | `TTSPlayer.feed(text)` 可以连续投喂文本，`end_session()` 结束 | `Core/TTSPlayer.py:195-211` |
| 复用现有模型 | 不能 | 见下 |

不能复用的证据：

- `xiaote.ckpt` 的 `config.model.phoneme_vocab_size = 512`，`ar_text_embedding.word_embeddings.weight` 形状 `[512, 512]`。
- Genie 1.0.3 与 2.0.2 的 `Data/v2/Models/t2s_encoder_fp32.onnx` 中该张量形状为 `[732, 512]`，外部权重长度 `1499136`。
- 用两个版本自带转换器重新转换后，ONNX 维度仍为 `[732, 512]`，外部权重按实际张量写成 `1048576`，ONNX Runtime 报 `external data size mismatch. Computed size: 1499136, external_data.length: 1048576`。
- 该错误是词表尺寸不一致，不是路径或配置问题。

另外两个部署事实：

- Genie 2.0.2 在导入时要求 `GENIE_DATA_DIR` 存在，否则会交互式询问是否下载，且打印表情符号在 GBK 控制台会抛 `UnicodeEncodeError`，需要 `PYTHONUTF8=1`。
- 本机的 `chinese-hubert-base.onnx` 引用 `chinese-hubert-base_weights.bin`，实际只有 fp16 权重；转换为 fp32 后可以加载（已在 `work/` 验证）。

结论：Genie 的流式接口本身适合实时场景，但只能用于与它词表一致的模型（v2 或 v2ProPlus 角色包）。当前 `xiaote` 音色属于 v2Pro 512 词表，Genie 路线不可用。

### 1.3 CosyVoice 3.0

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| 官方仓库 | FunAudioLLM/CosyVoice | https://github.com/FunAudioLLM/CosyVoice |
| 双向流式 | 仓库 README 声称同时支持文本输入流与音频输出流，延迟可低至 150 ms | 该仓库 README 第 19 行（厂商指标） |
| 本机验证 | 未做 | 未下载模型，未在 Windows + 8GB 显存上部署 |

结论：厂商指标不能当作本机预期。它具备与本项目目标最接近的双向流式形态，值得作为下一阶段对照实验；但需要单独的 Python 3.10 环境、模型下载与显存实测，当前没有证据表明它在 8GB 显存与中文音色克隆上优于现有方案。

### 1.4 IndexTTS 2.5

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| 官方仓库 | index-tts/index-tts | https://github.com/index-tts/index-tts |
| 版本与能力 | IndexTTS-2.5 支持中英日西阿五种语言、细粒度情绪控制、比 IndexTTS-2 更快 | 该仓库 README 第 19-22 行、第 30-31 行 |
| 流式 | README 未声明流式音频；未在本机验证 | 同上 |
| 本机验证 | 未做 | 未下载模型 |

结论：定位为音质与情绪对照方案。若后续需要情绪控制，应先用同一批中文文本测量它的首段延迟与显存，再决定是否替换主引擎。

### 1.5 引擎选择

当前采用 GPT-SoVITS v2Pro：唯一能直接复用现有音色、且已经在本机跑通流式音频的方案。Genie 因词表不兼容排除；CosyVoice 3.0 与 IndexTTS 2.5 保留为后续对照，不作为当前依赖。

## 2. 语音识别

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| 引擎 | faster-whisper 1.1.1，模型 small，int8，CPU | 本机 `.venv` |
| 模型加载 | 12.16 秒（首次，含本地缓存校验） | 本机实测 |
| 识别速度 | 9.88 秒中文音频 2.58-2.86 秒，RTF 约 0.26 | 本机实测，i9-14900HX |
| 端点检测 | 能量 VAD，自适应噪声底、320 ms 最短语音、640 ms 最短静音 | `src/voxkin/stt/vad.py` |
| 麦克风 | 本机存在 Realtek 麦克风与虚拟输入设备 | `sounddevice.query_devices()` |

结论：对 3 秒左右的短句，识别约 0.8 秒，加上 640 ms 静音判定，语音结束到最终文本约 1.4 秒。这构成本链路最大的固定延迟之一，后续可用流式识别（sherpa-onnx）压缩。

未验证：sherpa-onnx 的流式中文识别、麦克风阵列兼容性、与 Minecraft 的 CPU 竞争。

## 3. 音频播放路线对比

| 维度 | A. 现有本地 Mod | B. 游戏外播放（当前默认） | C. 语音聊天 Mod | D. 专用客户端 Mod（计划） |
| --- | --- | --- | --- | --- |
| 麦克风采集 | 不支持 | 由 Core 直接采集 | 由 Mod 采集，需其 API | 由 Core 直接采集 |
| 本地 STT | 不支持 | 支持 | 需从 Mod 取流 | 支持 |
| TTS 首段延迟 | 受文件写入与轮询影响 | 964 ms（p50，实测） | 未测 | 预计与 B 相近 |
| 与现有播放器兼容 | 直接兼容 | 不涉及 | 需适配 | 需新写 |
| 空间音频 | 无 | 无 | 有（服务端广播） | 可做（客户端声源） |
| YSM 联动 | 未验证 | 无 | 未验证 | 可做 |
| 多人支持 | 仅本机 | 仅本机 | 支持 | 支持（客户端各装） |
| 复杂度 | 低 | 低 | 中高 | 高 |
| 版本风险 | 低（已编译） | 无 | 高（Mod 版本绑定） | 中 |
| 维护成本 | 低 | 低 | 中 | 中高 |

- 路线 C 的四个能力必须分开看：访问玩家麦克风、向本机播放 AI 语音、把 AI 语音作为空间音源广播、触发角色动作。现有公开资料不足以证明 Simple Voice Chat 或 Plasmo Voice 同时支持这四项；本机没有安装对应 Mod，也未阅读其源码，因此不作结论。
- 路线 A 已用 `MinecraftFileSink` 复用：按句写 WAV，按音频时长节流，避免多个文件同时被 `Clip` 播放。这条路线适合当前单人验证，但不具备空间音源与打断能力。
- 路线 B 是当前默认，首段延迟最低，适合先验证语音链路本身。
- 路线 D 是多人扩展与角色表现的正确方向，需要单独开发客户端 Mod，接收 PCM 并送入 Minecraft 声源系统。

## 4. 结论

1. 现有 GPT-SoVITS 权重与运行包保留，实时性通过 `streaming_mode`、增量分句与并行播放解决，不需要更换音色引擎。
2. 语音通道与行动通道必须在架构层分离；Minecraft 的动作以「桥接返回成功」为完成条件。
3. 短期默认使用游戏外播放验证链路，游戏内播放复用现有 Mod 的文件投递；空间音源与 YSM 联动放到专用 Mod 阶段。
4. Genie 只在与自身词表匹配的模型上可用，不能作为现有音色的替代。
