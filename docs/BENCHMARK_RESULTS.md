# 基准结果

所有数字来自本机真实运行。标注「本地测试 LLM」的结果不包含真实网络与真实模型的首 token 延迟。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 机器 | ASUS TUF Gaming F16，Windows |
| CPU | Intel Core i9-14900HX，24 核 32 线程 |
| GPU | NVIDIA RTX 4060 Laptop，8188 MiB，驱动 610.62 |
| 内存 | 32 GB |
| Python | 3.10.0（Core），3.9.13（GPT-SoVITS 运行包） |
| torch | 2.0.0+cu118（GPT-SoVITS），2.4.1+cpu（转换工具） |
| TTS | GPT-SoVITS v2pro-20250604，`xiaote` 权重，`cuda`，`is_half: true` |
| 识别 | faster-whisper 1.1.1，small，int8，CPU |
| 音频输出 | Realtek 扬声器，48 kHz，`sounddevice` |

## 2. TTS 原始流式延迟

请求：`POST /tts`，`streaming_mode=true`，`media_type=wav`，参考音频 `xiaote.wav`。

| 场景 | 首字节 | 总耗时 | 音频时长 | RTF |
| --- | --- | --- | --- | --- |
| 冷启动（首次请求） | 7470.5 ms | 7623.1 ms | 5.34 s | 1.428 |
| 预热后 | 2388.2 ms | 2526.3 ms | 5.30 s | 0.477 |
| 预热后（重复） | 2471.3 ms | 2615.1 ms | 5.50 s | 0.475 |

说明：`cut0` 时首字节要等整句合成完；`cut5` 会在标点处分块。

同一段两句话文本的切分方式对比：

| 切分 | 首字节 | 总耗时 |
| --- | --- | --- |
| `cut0` | 3073.2 ms | 3210.1 ms |
| `cut5` | 1173.0 ms | 3619.4 ms |
| `cut5`（重复） | 1427.1 ms | 4240.2 ms |

## 3. 端到端语音管线

条件：5 轮连续对话；LLM 为 `tools/dev_llm_server.py`（每 2 字间隔 20 ms 的本地 SSE）；TTS 为真实 GPT-SoVITS；输出为真实扬声器；每轮文本相同，回复约 60 字。

| 指标 | p50 | p90 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- |
| LLM 首 token | 1.5 ms | 1.7 ms | 1.3 ms | 1.8 ms |
| 首个可朗读句子 | 67.2 ms | 67.5 ms | 58.9 ms | 67.6 ms |
| TTS 首段音频 | 725.8 ms | 827.0 ms | 400.6 ms | 894.1 ms |
| 首次可听 | 964.1 ms | 1285.4 ms | 681.2 ms | 1438.1 ms |

逐轮首次可听：790.4、1438.1、964.1、1056.3、681.2 ms。

解读：

- 语音结束到开始播放的链路开销约 1 秒，其中 TTS 首段占 0.7 秒左右。
- 本地 LLM 的首 token 只有 1.5 ms，真实 DeepSeek 会额外增加数百毫秒到数秒，因此真实场景的首次可听延迟必然高于此表。
- 每个短句单独请求 TTS 时存在约 0.4-0.9 秒的固定开销；首句越短，出声越早。

## 4. 语音识别

| 场景 | 耗时 | 音频时长 | RTF |
| --- | --- | --- | --- |
| 模型加载 | 12.16 s | — | — |
| 识别第 1 次 | 2863.3 ms | 9.88 s | 0.290 |
| 识别第 2 次 | 2605.2 ms | 9.88 s | 0.264 |
| 识别第 3 次 | 2576.0 ms | 9.88 s | 0.261 |

识别文本与参考音频内容一致（中文，无标点）。对 3 秒左右的日常短句，识别约 0.8 秒；加上 640 ms 的最短静音判定，语音结束到最终文本约 1.4 秒。

## 5. 未测量的部分

- 真实 DeepSeek 的首 token 与网络往返：没有费用授权，未调用。
- 游戏内 Mod 播放：没有运行 Minecraft 客户端，文件投递的端到端时间未测。
- 麦克风采集到识别的真实链路：只用文件做了识别测量，未用麦克风实时说话。
- 多人空间音频、YSM 联动：未实现。
- 旧系统 60-120 秒的原始测量：来自用户描述，本仓库没有复现。

## 6. 复现

```powershell
# 终端 A：本地测试 LLM
.\.venv\Scripts\python.exe tools\dev_llm_server.py --port 8799 --delay-ms 20

# 终端 B：GPT-SoVITS
cd work\gpt_sovits_full\GPTheresaV3.2\GPT-SoVITS-v2pro-20250604
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml

# 终端 C：基准
cd D:\AI-Workspace\Voxkin
.\.venv\Scripts\python.exe -m voxkin bench --turns 5 --json work\bench.json
```
