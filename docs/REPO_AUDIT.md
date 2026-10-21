# 仓库审计

审计时间：2026-10-21。所有结论区分「源码证实」与「尚未验证」。

## 1. 工作区与版本

| 位置 | 类型 | 版本/状态 | 来源 |
| --- | --- | --- | --- |
| `D:\AI\middleapi\MiddleAPI-new\MiddleAPI` | Git 仓库 | 分支 `main`，HEAD `d13b50e`，remote `git.espressif.com.cn/LynchPin1634/MiddleAPI`；工作区有未提交修改：`MiddleAPI.py`、`config/config.yaml`、`utils/GenieEngine.py`，新增 `Convert.py`、`GenieData/`、`models/`、`config/xiaote.wav` | 本地 |
| `D:\AI\MiddleMod&Plugin` | 无 Git | 4 个 Gradle 工程：`MiddleMod`（Fabric 1.20.1）、`MiddleModClient`（Fabric 客户端）、`MiddlePlugin1.21`、`MiddlePluginFor1.20.1`（Bukkit 插件） | 本地 |
| `D:\AI\GPTheresaV3.2\GPTheresaV3.3.7z` | 压缩包 | 8.4 GB，包含 GPT-SoVITS `v2pro-20250604` 完整运行包、`GPT_weights/xiaote.ckpt`、`SoVITS_weights/xiaote.pth` | 本地 |
| `D:\AI\mindcraft-main` | 空目录 | 无源码 | 本地 |
| MindCraft 上游 | Git | `develop`，HEAD `f6a9556`（2026-10-02），审计见 [research/MINDCRAFT_AUDIT.md](research/MINDCRAFT_AUDIT.md) | GitHub |

`D:\AI\onnx` 存放的是 Genie 1.0.3 转换器产出的 ONNX 集合；其编码器与 v2Pro 权重不匹配，见第 4 节。

## 2. 现有语音链路（源码证实）

调用顺序：

1. `MiddleAPI.py:128` 的 `/chat/completions` 代理到上游 OpenAI 兼容接口。
2. `utils/ProxyService.py:69` 用 `await api_response.json()` 一次性读完整个响应，随后 `:73-79` 计算超时并 `await _call_tts_service(...)`。
3. `utils/ProxyService.py:147` 调用本机 `/audio/speech`，把整段文本作为一次请求。
4. `MiddleAPI.py:150` 的 `/audio/speech` 调用 `genie_engine.infer(...)`，该函数是同步阻塞调用，却位于 `async def` 中，会阻塞事件循环（`MiddleAPI.py:171`）。
5. `utils/GenieEngine.py:98` 调用 `genie.tts(...)` 生成完整音频到临时文件，`infer` 直到文件写完才返回（`:105-109`）。
6. `MiddleAPI.py:181-190` 把整段 WAV 写入缓存并以单次响应返回。
7. 游戏侧 `MiddleModClient` 的文件监听器发现新 `.wav` 后用 `javax.sound.sampled.Clip` 播放（`MiddleModClient/src/client/java/.../TTSAutoPlayer.java:41-70`、`:80-95`）。

由此产生的结构性延迟：

| 环节 | 证据 | 影响 |
| --- | --- | --- |
| LLM 必须完整返回 | `ProxyService.py:69`、`:73` | 首字延迟 + 全部生成时间都计入 |
| TTS 必须整段合成 | `MiddleAPI.py:157-190`、`GenieEngine.py:98-103` | 文本越长，首段音频越晚 |
| 同步推理阻塞事件循环 | `MiddleAPI.py:171` 调用同步函数 | 同一时刻无法处理其他请求 |
| 播放依赖文件新建事件 | `TTSAutoPlayer.java:45-56` | 缓存命中时文件已存在，不会重新触发播放 |
| 无播放队列与顺序保证 | `TTSAutoPlayer.java:82-94` 每个文件起独立线程 | 多个分段同时到达会重叠播放 |
| 无空间音源 | 使用 `Clip` 直接输出 | 与游戏内声源位置无关 |

## 3. 已确认的实现缺陷

- `utils/GenieEngine.py:63` 定义了 `inference_text` 常量，`:98-100` 实际合成的是这个常量，传入的 `text` 参数完全没有使用。任何调用都只会念同一句话。
- `utils/GenieEngine.py:82` 把参考音频写死为绝对路径 `D:\AI\middleapi\...\xiaote.wav`，`:94` 的参考文本是占位符「这是参考音频的文本内容」。
- `config/config.yaml` 中 `genie.onnx_model_dir` 指向 `D:/GenieModels`，该目录不存在；实际模型在 `models/Theresa`。
- `MiddleAPI.py:325-333` 以 `host="0.0.0.0"` 启动，且 README 说明没有认证（`README.md:151`）。
- 插件版 `MiddlePlugin` 在服务端进程里用 `Clip` 播放音频，声音从服务器机器输出，而不是玩家客户端。

## 4. Genie 与现有模型的兼容性（源码与运行证实）

- 现有音色是 GPT-SoVITS v2Pro 训练结果：`xiaote.ckpt` 内 `config.model.phoneme_vocab_size = 512`，`model.ar_text_embedding.word_embeddings.weight` 形状为 `[512, 512]`。
- Genie 1.0.3 与 2.0.2 自带的编码器骨架 `t2s_encoder_fp32.onnx` 要求 `[732, 512]`，并把外部权重长度写成 `1499136` 字节。
- 用两个版本自带的转换器重新转换后，ONNX 的维度仍是 `[732, 512]`，但外部权重长度按实际张量写成 `1048576`，两者矛盾。
- 运行 `genie.load_character` 时 ONNX Runtime 直接报错：

```
Deserialize tensor encoder.ar_text_embedding.word_embeddings.weight failed.
external data size mismatch. Computed size: 1499136, external_data.length: 1048576
```

- 结论：Genie 的 v2 编码器词表与 v2Pro 的 512 词表不一致，现有 `xiaote` 模型无法被 Genie 直接加载；这不是配置问题，是权重形状问题。
- 追加事实：Genie 需要的 `chinese-hubert-base` 在本机只有 fp16 外部权重，而 ONNX 引用的是 fp32 文件名，必须先做一次 fp16→fp32 转换才能加载（已在 `work/` 中验证该转换可消除 HuBERT 加载错误）。

## 5. Minecraft 音频 Mod 现状（源码证实）

- 客户端 Mod 监听 `<游戏目录>/middleapi/config/tts_audio_storage`（`MiddleModClient/.../TTSAutoPlayer.java:27`）。
- 支持动态生成音频的播放，但不支持队列、打断、音量/位置控制、嘴型同步。
- Bukkit 插件版监听 `<server>/middleapi1/tts_audio_storage`（`MiddlePlugin1.21/.../TTSAutoPlayer.java:23`），在服务端机器播放。
- 结论：现有 Mod 可以作为「文件投递」的接收端复用，但要做无缝顺序播放，必须在 Core 侧按音频时长节流写入；真正的低延迟与空间音源需要专门的客户端 Mod 或语音聊天 Mod 接口。

## 6. 尚未验证

- MindCraft 在真实服务器上的并发行为与丢弃率（审计基于源码，未运行）。
- 真实 DeepSeek 的首 token 延迟（无可用凭据授权，未调用付费接口）。
- CosyVoice 3.0 与 IndexTTS 2.5 在本机的显存、首段延迟与中文效果（未下载模型）。
- Simple Voice Chat / Plasmo Voice 的 API 可接入性（未安装对应 Mod，未读源码）。
