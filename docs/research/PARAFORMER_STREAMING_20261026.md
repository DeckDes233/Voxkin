# Paraformer-zh-streaming 本机调研与实测（2026-10-26）

## 结论

`funasr/paraformer-zh-streaming` 是中文/英文 ASR 模型，支持真正的外部逐块输入和逐块返回文本；它不是 TTS，也不是仅把整段文件内部切块的离线接口。要获得真实流式行为，调用方必须在每个音频块到达时调用 `AutoModel.generate()`，把同一个流状态 `cache` 传给后续块，并在最后一块设置 `is_final=True`。模型文件路径形式的快速示例会先读入整个文件，不能据此宣称麦克风首字延迟。

本机以不可变 revision `apache-2.0-20260804` 的权重完成了真实逐块回放。RTX 4060 Laptop 8GB 的 CUDA 推理 RTF 均值为 0.105–0.126；4 线程 CPU 为 0.194–0.240。GPU 上首个非空文本分别在短句 1.266s、中英混合句 1.901s、长句 3.677s 出现；这里的时间从回放开始计，包含模型等待到 600ms 块边界，但不含额外 VAD 端点等待。已测项目的 `VadSegmenter` 在校准后仍需静音 640ms 才触发端点，因此应将 VAD 与模型延迟分开考虑。

**初步建议：**可将它列为本机 STT 的候选实现。流式协议与 8GB 显存可行性已由本机实测确认；小样本识别结果不足以支持通用准确率结论。集成前需实现每会话独立 cache、增量文本累积、结束/取消时状态丢弃，并对真实麦克风、背景噪声、域词和并发流补充验证。本报告只提供证据，不新增生产适配器。

## 模型与源码固定版本

| 项目 | 固定值 / 证据 |
| --- | --- |
| 模型 | [`funasr/paraformer-zh-streaming`](https://huggingface.co/funasr/paraformer-zh-streaming) |
| 权重 revision | `apache-2.0-20260804`，解析到 commit `fd2af606b37d7fb8b3b8a218c5be5b07b53ef6ba` |
| 权重 | `model.pt` 880,716,041 bytes，SHA-256 `4fdfb48ed4471777c9a511e96a2acae17f77cac9d709cc756634622769192a64` |
| 代码 | [FunASR v1.4.16](https://github.com/modelscope/FunASR/tree/v1.4.16)，release commit `904cd18681b8083de5e1039bd0ecebc4f49ede60`；下载归档 SHA-256 `66540e6ccf293b47c033b2902b959adc5a1a4df78688a1d1572a0d76e3dd4898` |
| 代码文件指纹 | `funasr/models/paraformer_streaming/model.py` Git blob SHA-1 `69826befacf2306ee6fc49bcb8b9c882739e586e`；原文件 SHA-256 `07265409294c4f52174a186b597ea27b1408f2e95ee67083814ade2a3c6fcf39` |
| 模型许可 | 上述不可变 tag 的 README 声明权重和随附文件为 Apache-2.0；快照内含 `LICENSE`，SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`。FunASR 代码仓库另为 MIT；依赖和其他数据需按各自许可审查。 |

本轮只使用带 `LICENSE` 的不可变 tag。历史 revision `45df2405b92dfeb21e01ea4465954677005ae370` 的仓库树没有其模型卡所引用的 `LICENSE` 文件；这不是对历史版本的追溯性授权判断。[当前模型卡](https://huggingface.co/funasr/paraformer-zh-streaming/blob/apache-2.0-20260804/README.md)也明确记录了这段历史差异。

下载脚本先直接调用 `huggingface_hub.snapshot_download(repo_id=..., revision="apache-2.0-20260804")`，核对 commit 与 `model.pt` SHA-256，再把本地快照目录交给 `AutoModel`。原因是 FunASR v1.4.16 的通用 Hugging Face helper 虽接收 `model_revision`，内部却调用 `snapshot_download(model)`，未把 revision 传入；因此仅按模型卡示例传模型 ID 和 `model_revision`，不能据该源码证明下载被固定。验证后的快照路径、全部文件 SHA 和大小见 [`snapshot_integrity.json`](../../work/stt_paraformer_20261026/results/snapshot_integrity.json)。

## 真实流式协议（按 FunASR 源码）

模型卡的 `generate(input="audio.wav", chunk_size=...)` 是文件输入；[流式模型实现](https://github.com/modelscope/FunASR/blob/v1.4.16/funasr/models/paraformer_streaming/model.py)会先通过音频加载器取得整段数据，再在模型内部循环。真正的外部流式方式见 FunASR 自带的 [Paraformer streaming 测试](https://github.com/modelscope/FunASR/blob/v1.4.16/tests_models/test_paraformer_streaming.py)：加载一次模型，以同一个调用方 `cache` 顺序处理波形块，最后一块传 `is_final=True`。

本次遵循的调用形状：

```python
chunk_size = [0, 10, 5]
stride = chunk_size[1] * 960  # 9,600 samples = 600 ms @ 16 kHz
cache = {}                    # 每条流单独创建
for start in range(0, len(wave_16k_mono), stride):
    end = min(start + stride, len(wave_16k_mono))
    result = model.generate(
        input=wave_16k_mono[start:end],  # 一维 float32 波形块
        cache=cache,
        is_final=(end == len(wave_16k_mono)),
        chunk_size=chunk_size,
        encoder_chunk_look_back=4,
        decoder_chunk_look_back=1,
        batch_size=1,
        fs=16000,
    )
    text_delta = result[0].get("text", "") if result else ""
```

源码中 `[0,10,5]` 的输入步长为 `10 * 960` 个采样点，即 600ms；实现断言每次只有一个 waveform。look-back 4/1 是 FunASR 示例设置，源码默认值实际为 0/0。每个调用只将该次解码出的 token 文本放入当前结果；调用方需要按序累积 delta，不能假设返回的是完整累计稿。新流、取消流或 `is_final` 后都应丢弃 cache。源码在最终块重置自身 cache，但会话层仍应维护独立状态。

另一个可复现风险是并发 cache：源码协议说明的是**单流有序调用**，本轮没有验证多用户、多模型实例或取消竞态，不能把 `cache` 在多个连接间共享。模型的 Python `AutoModel` 接口是进程内接口；它本身不提供 Voxkin 现有 websocket/API 合约。

## 本机环境与运行方式

- Windows 11 10.0.22631；Intel Core i9-14900HX，24 核 / 32 逻辑处理器；RAM 31.6 GiB。
- NVIDIA GeForce RTX 4060 Laptop GPU，8,188 MiB，driver 610.62。
- 专用目录：`work/stt_paraformer_20261026/venv_cuda39`。它是单独的测试 virtualenv；为避免重装数 GB CUDA Torch，virtualenv 通过工作目录内的 `.pth` 只读复用本机既有 GPT-SoVITS Python 3.9.13/Torch 2.0.0+cu118 依赖。只在该测试 venv 安装了 `rapidfuzz==3.9.7`；FunASR v1.4.16 源码从工作目录优先导入。原 GPT-SoVITS 运行时未改动，仓库 `.venv` 未改动。该环境不是可移植的锁文件环境，完整环境信息见 [`environment_snapshot.json`](../../work/stt_paraformer_20261026/results/environment_snapshot.json)。
- 关键包：Python 3.9.13、FunASR 源码 1.4.16、torch 2.0.0+cu118、CUDA 11.8、NumPy 1.23.4、SciPy 1.9.3、soundfile 0.12.1、faster-whisper 1.1.1 / CTranslate2 3.24.0。正式测试将 Torch CPU 线程数固定为 4，模型和 hub 快照均从工作目录本地加载并关闭在线更新。
- 模型加载用时：CPU 2.219s；GPU 2.725s。GPU 模型峰值 allocated 916,296,704 bytes（873.8 MiB）、reserved 939,524,096 bytes（896 MiB）；进程 peak RSS CPU 1.471 GiB、GPU 0.885 GiB。GPU 运行期间整卡观测最大显存占用 2,146 MiB（含桌面/后台），未 OOM。

测试脚本、命令日志、音频和机器可读结果都在 `work/stt_paraformer_20261026/`。复跑主测试可使用：

```powershell
$root = (Resolve-Path 'work\stt_paraformer_20261026').Path
$env:MODELSCOPE_CACHE = Join-Path $root 'modelscope_cache'
$env:HF_HOME = Join-Path $root 'hf_home'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:MODELSCOPE_OFFLINE = '1'
$env:FUNASR_SOURCE = (Resolve-Path 'work\stt_paraformer_20261026\upstream-source\modelscope-FunASR-8762b0a').Path
$env:OMP_NUM_THREADS = '4'
$env:MKL_NUM_THREADS = '4'
$model = Join-Path $root 'hf_cache\models--funasr--paraformer-zh-streaming\snapshots\fd2af606b37d7fb8b3b8a218c5be5b07b53ef6ba'
work\stt_paraformer_20261026\venv_cuda39\Scripts\python.exe `
  work\stt_paraformer_20261026\stream_measure.py `
  --model-dir $model --audio work\stt_paraformer_20261026\audio\fleurs_short.wav `
  work\stt_paraformer_20261026\audio\fleurs_mixed.wav `
  work\stt_paraformer_20261026\audio\fleurs_long.wav `
  --manifest work\stt_paraformer_20261026\fleurs_audio_manifest.json `
  --device cuda --pace realtime --repeats 3 `
  --output work\stt_paraformer_20261026\results\paraformer_gpu_realtime.json
```

正式 CPU/GPU JSON 包含逐块到达、每次 `generate()` 用时、chunk 文本、首个非空文本、尾块完成时间、CER、RTF、RSS、CPU、系统内存及 GPU 采样；console 日志分别为 `results/paraformer_cpu_realtime.log`、`results/paraformer_gpu_realtime.log`。PowerShell 原生命令的中文 stdout 在该次日志中出现解码乱码；逐字转写以 UTF-8 原始 JSON 为准，日志保留启动参数和模型加载信息。`summarize_results.py` 可重算摘要。

## 测试音频与识别结果

准确率输入取自 [Google FLEURS](https://huggingface.co/datasets/google/fleurs) 的 `cmn_hans_cn/validation`，固定数据 revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`；数据集采用 CC-BY-4.0，FLEURS 论文见 [arXiv:2205.12446](https://arxiv.org/abs/2205.12446)。三条是带原始文本的真人朗读数据，不是麦克风现场录音：row 87 短句 3.66s，row 11 含 WiFi 的中英混合句 5.58s，row 295 长句 27.72s。逐文件 hash、原始转写和来源见 [`fleurs_audio_manifest.json`](../../work/stt_paraformer_20261026/fleurs_audio_manifest.json)。

每个 WAV 按 600ms 到达节奏回放 3 次；等候时间计入首字时间和端到端回放时间，`compute RTF` 只统计各次 `generate()` 调用（GPU 调用后同步 CUDA）耗时之和除以音频时长。所有 CER 都是在去空白/标点、英文小写之后逐字符计算；不同轮次输出相同。

| 音频 | Paraformer CPU | Paraformer CUDA | 字符结果（CPU/CUDA相同） |
| --- | --- | --- | --- |
| 短句 3.66s | 首非空均值 1.349s（1.313–1.421）；末尾到 final 173ms；compute RTF 0.240 | 首非空 1.266s（1.250–1.281）；末尾到 final 59ms；compute RTF 0.126 | CER 0.000；识别为“我觉得这毫无道理显然不公平” |
| WiFi 混合句 5.58s | 首非空 1.922s；末尾到 final 123ms；compute RTF 0.194 | 首非空 1.901s（1.891–1.921）；末尾到 final 71ms；compute RTF 0.105 | CER 0.143；参考“他称，他制作了一个 WiFi 门铃”，识别“他称他制作了一个fi门铃”，`WiFi` 丢失了 `w` |
| 长句 27.72s | 首非空 3.761s（3.703–3.860）；末尾到 final 134ms；compute RTF 0.215 | 首非空 3.677s（3.656–3.688）；末尾到 final 87ms；compute RTF 0.106 | 逐字符原始 CER 0.224；识别把 `1978/1979/20/70` 写成汉字数字，另有“戴维→代为”“人质→认质”。仅把该样本中的 `一九七八/一九七九/二十/七十` 映射为对应阿拉伯数字后，CER 为 0.035；这是对该样本的显式数字归一，不是通用评测分数。 |

### 同音频 faster-whisper small 对比

从本机已有缓存只读加载 faster-whisper small（snapshot `536b0662742c02347bc0e980a01041f333bce120`；`model.bin` 483,546,902 bytes，SHA-256 `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`），没有下载或修改 Voxkin 的 Whisper 模型。按项目核心设置运行 CPU / int8 / 4线程 / `language="zh"` / `beam_size=1` / `vad_filter=False` / `condition_on_previous_text=False`，输出再按项目 `OpenCC t2s` 归简体后算 CER。该路径为单次整段 `transcribe()`，仅测完整音频到完整文本的推理耗时，**不产生流式首增量**。

| 音频 | whisper small CPU/int8 推理均值 | RTF 均值 | 项目简体归一 CER |
| --- | ---: | ---: | ---: |
| 短句 3.66s | 1.460s | 0.399 | 0.000 |
| WiFi 混合句 5.58s | 1.386s | 0.248 | 0.000 |
| 长句 27.72s | 2.546s | 0.092 | 0.035 |

这一小集里 Whisper 完整转写了 WiFi，两个模型对长句的 `戴维营协议` 都有同类字符错误；不应由三句话推导通用优劣。长句 Whisper 的离线 compute RTF 低于 Paraformer CPU，但这是整段转写计算时长；它必须等完整波形结束后才调用，不能与 Paraformer 已测到的逐块首文本或最终块尾延迟直接比较。比较包为 faster-whisper 1.1.1 / CTranslate2 4.5.0、Python 3.10.0；load 1.327s、peak RSS 0.477 GiB。Paraformer 测试环境中可见的 CTranslate2 3.24.0 在导入 `WhisperModel` 的 Transformers converter 路径时触发 Windows native access violation，未进入推理；因此对比只读调用项目现有 `.venv` 里的 CTranslate2 4.5.0，没有升级或修改仓库依赖。模型缓存文件信息见 [`faster_whisper_snapshot_integrity.json`](../../work/stt_paraformer_20261026/results/faster_whisper_snapshot_integrity.json)。逐轮原始结果和 `t2s` 后的派生 JSON 在 [`faster_whisper_cpu_compare.json`](../../work/stt_paraformer_20261026/results/faster_whisper_cpu_compare.json)、[`faster_whisper_cpu_compare_simplified.json`](../../work/stt_paraformer_20261026/results/faster_whisper_cpu_compare_simplified.json)。

GPU 文本增量首现时，对应已到达音频量分别是 1.2s、1.8s、3.6s；这是本次波形和块配置的观测值，不代表任意句长/用户的固定首字时间。GPU RTF 优于本机 CPU 小样本；首增量差距较小是因为输入块本身每 600ms 到达，并非 GPU 模型计算耗时接近 1s。CPU 正式测量采样到系统总 CPU 0–7.4%、进程 CPU 峰 47.7%；系统可用 RAM 最低 4.41 GiB。GPU 运行前 8 次 3s 快照为 20–45% util、1,011–1,063 MiB 已用；模型运行时采样均值 21.5%、瞬时峰 88%，峰值整卡显存 2,146 MiB，含非本次测试的桌面/后台进程。测试没有关闭用户进程。

GPU 还对模型 tag 自带 `example/asr_example.wav`（5.55s）和 Voxkin 项目词汇样本各跑 3 轮。模型例音每轮都输出“欢迎大家来体验达摩院推出的语音识别模型”，这只作官方例音烟雾测试，没有独立参考文本，不计 CER。词汇样本从 `work/voice_verify/tts_sample.wav` 复制，`report.json` 标记其为 GPT-SoVITS 生成的 32kHz TTS 音频；目标句为“沃心已经进入世界，正在检查背包”，三轮识别均为“嗯告号”。CPU 又对项目样本 `dirt_ack_full.wav`（samples.json 文本“收到，我这就去挖点泥土。”）按 600ms 块跑了 3 轮，均输出“收到我这就去挖点泥土”；均值首非空 1.912s、末块到 final 188ms、compute RTF 0.196。其录制/合成来源未注明，因此只作为词汇冒烟，不计真人准确率。两条都不能代表自然语音识别率，也不是噪声实测。音频、文本、来源和 hash 见 [`stream_probe_manifest.json`](../../work/stt_paraformer_20261026/stream_probe_manifest.json)。

为找带独立参考文本的域词真人录音，检查了固定 FLEURS validation split 的 386 条中文转写；没有发现 `Voxkin/沃心/我的世界/Minecraft/泥土/钻石/红石/方块` 等目标词。因此当前游戏词结果只有一条已知 TTS 和一条来源不明的项目样本，尚无独立真人域词验收。逐条数据副本见 [`fleurs_validation_manifest.json`](../../work/stt_paraformer_20261026/fleurs_validation_manifest.json)。

## VAD、静音与噪声边界

另按 Voxkin 当前 `src/voxkin/stt/vad.py` 的 512 sample 帧能量端点器，重放 FLEURS 短句并在末尾追加 1.5s 数字零值。默认初始 `noise_floor=0.01`、`threshold_ratio=3`、`min_rms=0.004` 时 5 轮均没有触发；用录音开头 0.64s 安静片段的帧 RMS 中位数（约 0.0012）调用项目现有 `calibrate()` 后，3/3 轮均检测到一句。最后活动帧 3.072s，回调 3.712s；基于音频样本时间的间隔为 640ms，壁钟间隔 640–641ms。数据和逐帧状态见 [`vad_endpoint_calibrated_realtime.json`](../../work/stt_paraformer_20261026/results/vad_endpoint_calibrated_realtime.json)；默认未校准的原始结果见 [`vad_endpoint_realtime.json`](../../work/stt_paraformer_20261026/results/vad_endpoint_realtime.json)。

这是端点逻辑回放，不是实际麦克风环境测试。为确定性设置，探针从音频安静头部估出 calibration RMS 后再将同一整条录音送入 VAD；它没有重现 `voice/loop.py` 的完整 1.2s 麦克风校准过程，也没有把该 640ms 算入模型 `generate()` 延迟。没有录到真人麦克风背景噪声，也未测真实音乐/风扇噪声；因此不能据此判断嘈杂环境识别表现。这里的静音是明确追加的数字零值，不应称为背景噪声。

## 结果适用范围与集成能力声明建议

本机实验支持如下候选能力声明，不等于生产验收：

```json
{
  "engine": "funasr_paraformer_streaming",
  "model_revision": "apache-2.0-20260804",
  "sample_rate_hz": 16000,
  "input": "mono float32 waveform chunks",
  "chunk_stride_ms": 600,
  "streaming_audio": true,
  "streaming_text": true,
  "partial_text_semantics": "per-call delta; caller must accumulate in order",
  "session_state": "one cache per stream; is_final on last chunk; discard after final/cancel"
}
```

实现时应把音频块长度、`chunk_size`、look-back、设备、模型 revision 和依赖版本写入 `describe()`/运行元数据；不得把文件输入内部切片称为低延迟麦克风流式。端点停止条件继续由 VAD/会话层负责，单独计量 VAD 静音等待和模型计算。短句 600ms 输入块之后首个增量有时要到 1.2s 才出现；适配层需保留 partial 更新顺序并验证重复文本、回滚、取消和重启语义。模型输出格式为文本和 key；本轮未观察到词级时间戳能力。

本轮未验证：真实麦克风与真实背景噪声、端到端 VAD+模型生产适配器、带独立参考的真人域词（包含“泥土”）、发音人变化、长时间连续流、同时多会话、取消后缓存回收、资源争用下的稳定性。faster-whisper 同音频实验见上表；现有 `docs/BENCHMARK_RESULTS.md` 的旧 Whisper CPU 数字仍是不同历史条件，不能与这组结果直接合并。

## 复现实验工件

- 固定模型文件清单与 checksum：`work/stt_paraformer_20261026/results/snapshot_integrity.json`
- 源码/tag/license调查证据：`work/stt_paraformer_20261026/results/source_evidence.json`
- 流式测试脚本：`work/stt_paraformer_20261026/stream_measure.py`
- VAD端点脚本：`work/stt_paraformer_20261026/vad_endpoint_probe.py`
- CPU逐块原始JSON/日志：`results/paraformer_cpu_realtime.json`、`results/paraformer_cpu_realtime.log`
- GPU逐块原始JSON/日志：`results/paraformer_gpu_realtime.json`、`results/paraformer_gpu_realtime.log`
- 项目词汇 CPU 冒烟：`results/paraformer_cpu_dirt.json`、`results/paraformer_cpu_dirt.log`
- faster-whisper 同音频比较：`results/faster_whisper_cpu_compare.json`、`results/faster_whisper_cpu_compare_simplified.json`、`results/faster_whisper_cpu_compare.log`
- faster-whisper缓存权重hash：`results/faster_whisper_snapshot_integrity.json`
- 可复跑命令集合：`results/commands.ps1`
- GPU运行前背景快照：`results/gpu_baseline_before.csv`
- 机器与包版本：`results/environment_snapshot.json`
- 音频：`work/stt_paraformer_20261026/audio/`；来源、参考文本和 SHA-256 在对应 manifest。
