# Qwen3-TTS-GGUF 本机评估（2026-10-26）

## 结论

在本机 RTX 4060 Laptop 8 GB 上，使用官方 Qwen3-TTS 1.7B Base 权重导出的 Talker Q5_K、Predictor Q8_0，已通过 llama.cpp Vulkan 真正生成 PCM/WAV。可运行路径是 **GGUF Talker/Predictor 用 Vulkan GPU，ONNX decoder 用 CPU**。DirectML decoder 在模型初始化预热阶段因 `Reshape` 节点失败，不能把本次结果描述为 ONNX 全链路 GPU 加速。

复用已加载模型和参考音色时，三组中文文本的 3 轮中位 RTF 为 0.677（短句）、0.730（长句）、0.737（领域句）；均值小于 1，满足这组三条文本的实时合成速度。短句第一次成功运行的首 PCM 延迟为 5.154 s；同一 benchmark warmset 后的新进程复测为 0.892 s。原因未核实，故保留两次观测，不把首个慢值归因于某个算子或缓存。

这份结果支持继续做隔离进程原型评估；**不能直接把当前 `clone()` 当成可取消、按增量文本输入的流式 API**。公开方法同步返回完整 `TTSResult`，但推理循环会每 12 个 codec code 调用一次 decoder。可以由长驻 worker 转发 decoder 返回的 PCM 块；这需要适配器侧显式实现，且不等于增量文本生成或协作式取消。

## 代码、模型与许可证

- 上游代码：[`HaujetZhao/Qwen3-TTS-GGUF` 固定提交 `74feb581bc8cefb835fc608107e857036d7580a1`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/tree/74feb581bc8cefb835fc608107e857036d7580a1)，提交时间 `2026-09-19T08:59:52+08:00`。仓库许可证为 MIT。
- 模型：[`Qwen/Qwen3-TTS-12Hz-1.7B-Base` 固定 revision `fd4b254389122332181a7c3db7f27e918eec64e3`](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base/tree/fd4b254389122332181a7c3db7f27e918eec64e3)，模型卡标注 Apache-2.0。原始官方模型快照共 4,544,229,700 bytes；两个主要 safetensors 文件的 SHA-256 与 Hugging Face 文件树 API 的 LFS OID 一致，详见 `work/tts_qwen3_20261026/evidence/artifact_sha256_20261026.json`。
- llama.cpp：GitHub 官方 [b10621 release](https://github.com/ggml-org/llama.cpp/releases/tag/b10621)，Windows Vulkan 包 34,403,304 bytes，SHA-256 `2672d85bf87c8280d94dee01eb6a86280046878f70a07d786a93637fa9081163`。上游加载代码固定从 `qwen3_tts_gguf/inference/bin` 载入 DLL，因此本次将官方 DLL 放到该工作副本路径；未改动上游源码。
- Qwen3-TTS-GGUF 的 GitHub release 未找到可校验的预导出模型 ZIP；作者 README 指向外部网盘。没有用非发布者镜像。本次从上述官方原始权重执行上游导出脚本。作者 README 中的 RTX 5050 数字不作为 RTX 4060 实测结果。
- 未测试 0.6B；本机优先选择 1.7B Base。Clone 使用 `xiaote.wav` 的 speaker embedding，设置 `zero_shot=True`，未提供参考转写。Qwen 官方说明 x-vector-only 模式无需 `ref_text`，但克隆质量可能降低；本报告没有主观音色相似度结论。

## 本机与构建配置

| 项目 | 实测配置 |
| --- | --- |
| 系统 | Windows 11，build 22631；32 GB RAM |
| GPU | NVIDIA GeForce RTX 4060 Laptop GPU，8,188 MiB 可见显存；驱动 610.62 |
| Python | 隔离 venv，CPython 3.14.0rc2；未使用 Voxkin `.venv` |
| 主要依赖 | `torch 2.14.1+cpu`、`transformers 4.57.6`、`onnxruntime-directml 1.24.4`、`onnx 1.23.2`、`gguf 0.19.0`、`tokenizers 0.22.2`、`numpy 2.5.2`、`soundfile 0.14.0` |
| 推理路径 | llama.cpp b10621 Vulkan、Talker Q5_K、Predictor Q8_0、ONNX FP16 decoder + CPUExecutionProvider；`torch.cuda.is_available()` 未用于推理，benchmark 记录为 false |
| 解码参数 | `chunk_size=12`、`n_ctx=512`、进程内 LocalDecoder、`streaming=True`、`max_steps=300`；温度 0.8，固定 seed 42 / sub-seed 45 |
| 声音参考 | 本机已有 `D:\AI\middleapi\MiddleAPI-new\MiddleAPI\config\xiaote.wav` 的工作副本，9.883 s、32 kHz、双声道；原件未覆盖。副本 SHA-256 `ac18c84015ca39494a784db040ffd78ed2fefe95bcbde65fef54c772bd266f20` |

上游 `pyproject.toml` 要求 Python `>=3.14`，而 Voxkin 运行环境是 Python 3.10。测试因此使用单独的 Python 3.14 venv；落地时需要子进程边界或其他隔离方案，不能直接把这套依赖装进项目 venv。导出步骤 15 还输出 tokenizer regex 警告，建议正式打包前核对 `fix_mistral_regex=True` 的行为差异。

本次实际推理所需的 Talker、Predictor、三个 FP16 ONNX、tokenizer 与 `embeddings/*.npy` 共 25 个文件，合计 2,444,908,923 bytes；manifest 记录每个文件的长度与 SHA-256：`work/tts_qwen3_20261026/evidence/runtime_artifact_manifest.json`。这不含 Python venv 与 DLL。导出目录还保留未用于本次运行的 FP16 GGUF、FP32/INT8 ONNX 等中间件，不应把整个工作目录误认为最小运行包。

## 测量方法与样本

所有正式生成使用相同参数、固定随机种子和同一个参考音色。每个新进程在测样前初始化 engine、创建一个 stream，并执行一次 `set_voice()`；warmset 在同一 engine/stream/voice 上先合成 `你好。` 预热，再对每句各生成 3 次。新进程表示 Python 进程和模型实例重建；没有清空系统文件缓存、Vulkan shader cache 或 GPU 驱动缓存。

测量脚本在 `LocalDecoder.decode()` 返回位置捕获 PCM，并另外记录 `clone()` 完成时间、音频时长、RTF、进程内存及 `nvidia-smi` 快照。首 PCM 时间是从调用 `stream.clone()` 到第一个非空 decoder PCM 块返回；它不是首 token 时间，也不是扬声器实际出声时间。观测到的首块为 15,360 samples，即 24 kHz mono 下 0.64 s。流程没有经过 Voxkin `AudioSink`，因此没有测操作系统设备缓冲或扬声器播放延迟。JSON 中的 `runner_to_pcm_seconds` 从 benchmark 脚本计时点开始，不包括 Python 进程创建和脚本顶部已执行的依赖导入。

统一文本：

| 用例 | 文本 |
| --- | --- |
| 短句 | `好的，我这就去。` |
| 长句 | `我已经检查完附近的区域，会先把需要的物品整理好，然后继续按照你的要求一步一步完成。` |
| 游戏领域句 | `沃心，先收集三块泥土，再合成一把石镐。` |

## 真实运行数据

### 新进程运行

| 用例 | 合成耗时 | WAV 时长 | 端到端 RTF | 首 PCM 块 | 首块 RMS | runner 启动后首 PCM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 短句，首次成功的 CPU-decoder 进程 | 6.533 s | 2.72 s | 2.402 | 5.154 s | 0.047596 | 17.610 s |
| 长句，新进程 | 6.164 s | 9.04 s | 0.682 | 0.877 s | 0.000284 | 11.132 s |
| 短句，warmset 后另起新进程 | 1.978 s | 2.72 s | 0.727 | 0.892 s | 0.047596 | 13.020 s |

冷运行的 engine import、engine init、stream 创建、reference voice 准备分别是：短句 `1.260 / 5.501 / 0.079 / 5.198 s`；长句 `1.315 / 3.892 / 0.058 / 4.482 s`；warmset 后另起的短句进程 `1.414 / 4.945 / 0.063 / 5.130 s`。voice 准备在每个进程约 4.5–5.5 s，说明参考音频特征与解码状态应在长驻 worker 中复用。

短句首次成功的进程中首 PCM 延迟较长；另一个新进程观测为 0.892 s。首个 CPU decoder 成功短句前刚发生过一次 DirectML decoder 初始化失败；warmset 后的新进程则是在完整 warmset 之后。`chunk_gen_times` 的首段也分别为 4.828 s 与约 0.546 s。采样与源码记录无法确认造成差异的具体组件，不能把慢值归因于固定 chunk 阈值或某个缓存。长句的首 PCM 块 RMS 很低；完整 WAV 的离线波形在约 0.80 s 音频偏移处才首次出现 20 ms RMS ≥ 0.005。这个偏移不是生成到达时间，报告只把 0.877 s 称为首 PCM 块到达。阈值扫描明细见 `work/tts_qwen3_20261026/evidence/signal_onset_analysis.json`。

### 同进程 warmset（各句 3 轮）

| 用例 | 轮次 | 首 PCM（调用后） | 合成耗时 | WAV 时长 | RTF |
| --- | --- | ---: | ---: | ---: | ---: |
| 短句 | warm1 | 0.617 s | 1.841 s | 2.72 s | 0.677 |
| 短句 | warm2 | 0.661 s | 1.842 s | 2.72 s | 0.677 |
| 短句 | warm3 | 0.645 s | 1.812 s | 2.72 s | 0.666 |
| 长句 | warm1 | 0.641 s | 6.598 s | 9.04 s | 0.730 |
| 长句 | warm2 | 0.716 s | 6.587 s | 9.04 s | 0.729 |
| 长句 | warm3 | 0.691 s | 6.710 s | 9.04 s | 0.742 |
| 游戏领域句 | warm1 | 0.766 s | 4.007 s | 5.44 s | 0.737 |
| 游戏领域句 | warm2 | 0.774 s | 4.150 s | 5.44 s | 0.763 |
| 游戏领域句 | warm3 | 0.695 s | 3.947 s | 5.44 s | 0.726 |

### 内存与显存

- 进程峰值 Working Set 为 3.52 GB，Private Usage 为 5.28 GB；开始 voice 准备前约 2.64 GB Working Set，完成 voice 准备后约 3.27 GB。机器 32 GB RAM 下本次未发生 OOM。
- 500 ms 间隔 `nvidia-smi` 采样中，warmset 最大显存读数 2,358 / 8,188 MiB，最大 GPU util 77%；其余合成窗口最大 util 78–88%。测试开始时桌面背景约 1.1–1.23 GiB，GPU 总占用不是 TTS 独占值；因此只报告采样读数，不将它当成进程专属显存。LLM 推理过程确认使用 Vulkan 后端。

### WAV 与 JSON

所有 WAV 是 24 kHz、mono、PCM-16。至少可直接试听的样本：

- 短句（第一次成功的 CPU decoder 进程）：`work/tts_qwen3_20261026/results/short_cold.wav`，SHA-256 `ce559a6154e015b6970e2f4796d7f83d30b2bc125a3d636f71c0951e0ae58311`。
- 长句：`work/tts_qwen3_20261026/results/long_cold.wav`，SHA-256 `d7b60bcae1be62c94d1282badadea3af1a60e3193ccf8982bd1238f268558974`。
- 游戏领域句：`work/tts_qwen3_20261026/results/domain_warm1.wav`，SHA-256 `b6d66ed1135064dbaea3a5143476c53735edbe537de62af7c215c18a4e41ae67`。
- 短句的新进程复测：`work/tts_qwen3_20261026/results/postwarm-short-process/short_cold.wav`；其波形与固定 seed 的短句样本一致。

每轮原始指标在 `work/tts_qwen3_20261026/results/run_cold_short.json`、`run_cold_long.json`、`run_warm_warmset.json` 与 `postwarm-short-process/run_cold_short.json`；GPU 每 500 ms 原始 CSV 在同目录。24 个 WAV 的格式、时长、RMS、峰值和哈希见 `work/tts_qwen3_20261026/evidence/audio_manifest.json`。另用本机缓存的 faster-whisper small / int8 / CPU / 4 threads 对领域句做了单条 ASR spot-check，识别为 `我心先收集三块泥土再合成一把石膏`。与目标相比，ASR 对“沃心”和“石镐”给出不同汉字；前两字词概率约 0.40 / 0.41，“膏”约 0.75。这个识别结果不能代替人工听审，也不能单独证明发音错；它标出这两个词值得重点试听。原始分词与时间戳见 `work/tts_qwen3_20261026/evidence/domain_asr_spotcheck.json`。

## 接入边界

上游 [`stream.py`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/blob/74feb581bc8cefb835fc608107e857036d7580a1/qwen3_tts_gguf/inference/stream.py#L66-L103) 的 `clone(text, ...)` 在调用栈内执行完整 `_run_engine_loop()`，之后才返回最终 `TTSResult`。当 `TTSConfig.streaming=True` 时，内部循环每积累 12 个 code 调用 decoder，再继续生成；本次通过包装 decoder 返回点观察到了 2 / 9 / 5 个 PCM 块。它没有逐步接收新增文本的 `feed(text)` 接口。

`LocalDecoder.stop()` 只清空 decoder 的 session 和累积 PCM；Talker/Predictor 生成循环没有 stop token 或 cancel event。单独调用它不能证明生成已取消。若 Voxkin 要接入：

1. 放在 Python 3.14 子进程中，维持一个 engine、stream 和 reference voice；避免每个句子重载 1.7B 模型及重复提取 reference anchor。
2. 在独立 worker 中运行同步 `clone()`，把 decoder 返回的 PCM 块转入有界队列，由桥接代码送入既有 `AudioSink`。能力声明只能写实现的 PCM chunk 传递能力，不能声称增量文本输入或 cooperative cancellation。
3. 若需要可靠取消，只能在上游加入 Talker 循环取消标志并验证清理行为，或终止隔离进程；本轮没有实现适配器。
4. 固定上游 commit、HF revision、llama.cpp DLL 版本、权重哈希和导出脚本。该仓库的 README 示例导入路径与模块实际导出存在差异；`pyproject.toml` 的 console script 指向包根 `main`，而本次实际 API 从 `qwen3_tts_gguf.inference` 导入。集成前应以本次可运行 API 为准并补包级验收。

源码核对位置：[`engine.py`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/blob/74feb581bc8cefb835fc608107e857036d7580a1/qwen3_tts_gguf/inference/engine.py#L20-L75) 定义必需文件、GGUF 加载和 decoder provider；[`stream.py`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/blob/74feb581bc8cefb835fc608107e857036d7580a1/qwen3_tts_gguf/inference/stream.py#L189-L241) 定义分块循环；[`decoder.py`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/blob/74feb581bc8cefb835fc608107e857036d7580a1/qwen3_tts_gguf/inference/decoder.py#L45-L104) 展示 provider 选择与启动预热、[`decoder.py`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/blob/74feb581bc8cefb835fc608107e857036d7580a1/qwen3_tts_gguf/inference/decoder.py#L370-L379) 展示 stop 只清除 decoder 会话。

## 复现与限制

本次所有文件与临时环境都在 `work/tts_qwen3_20261026/`，没有改动 Voxkin `.venv`、`D:\AI` 原始文件或 `src/voxkin/tts`。模型源快照、上游 checkout、Python venv、导出件、DLL、日志和 WAV 都在 `work/`；不要把 `work/`、`models/`、参考录音或权重提交入库。

- 环境重建记录：`work/tts_qwen3_20261026/evidence/`；上游 checkout 与 revision 在 `work/tts_qwen3_20261026/upstream/`、`upstream_source_commit.txt`。
- 导出脚本：`work/tts_qwen3_20261026/scripts/export_cpu.ps1`，日志：`work/tts_qwen3_20261026/logs/export/`。脚本设置了 `CUDA_VISIBLE_DEVICES=''`，但 Talker/Predictor 量化日志显示 llama.cpp 载入并枚举了 Vulkan 后端及 RTX 4060、Intel GPU；仅凭日志不能断言量化算子全部运行在 CPU。`33-Convert-Predictor-GGUF.py` 在上游 checkout 缺少它假定的 `ref/llama.cpp` 导入路径；仅在 work 目录的 runner 中把上游自带 converter 加入 `sys.path`，随后导出成功，没有改写上游脚本。
- Benchmark 复现：`work/tts_qwen3_20261026/scripts/bench_local.py`，参数见 `evidence/benchmark_texts.json`；当前 `scripts/benchmark.ps1` 固定使用成功的 CPU ONNX provider。PowerShell 会话按仓库说明设置 `NO_PROXY=*`。
- DirectML 初次加载摘要与 CPU fallback 结果见 `work/tts_qwen3_20261026/evidence/dml_attempt_summary.json`。失败输出当时没有完整落盘，故此文件明确是从终端输出整理的摘要，不冒充完整 traceback。
- tokenizer 步骤提示 regex 应使用 `fix_mistral_regex=True`；未修改上游 tokenizer。生成本身成功，但正式集成前仍应验证 token ID 与官方 Transformers 路径一致。

上游 README/发布页、模型卡和官方 b10621 包：[`Qwen3-TTS-GGUF README`](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/blob/74feb581bc8cefb835fc608107e857036d7580a1/readme.en.md)、[作者发布页](https://github.com/HaujetZhao/Qwen3-TTS-GGUF/releases)、[官方模型 revision](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base/tree/fd4b254389122332181a7c3db7f27e918eec64e3)、[llama.cpp b10621](https://github.com/ggml-org/llama.cpp/releases/tag/b10621)。
