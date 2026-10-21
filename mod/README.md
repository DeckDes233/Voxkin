# Voxkin Audio（Fabric 客户端 Mod）

接收 Voxkin Core 通过 WebSocket 推送的 PCM 分块，交给 Minecraft 的音频引擎播放：使用 `SoundEngine` 的流式 `Source`，绑定机器人实体的位置，因此声音会随距离衰减，并跟随游戏内语音音量。

## 构建

需要 JDK 21，Gradle 8.12（仓库自带 wrapper）。

```powershell
cd mod
$env:JAVA_HOME="<JDK 21 路径>"
.\gradlew build
```

产物在 `build/libs/voxkin-audio-0.1.0.jar`，放入 `mods/` 目录（需要 Fabric Loader 与 Fabric API 0.107.0+1.21.1）。

## 运行

1. 启动 Voxkin Core，并把 `audio.output` 设为 `websocket`。
2. 启动 Minecraft 1.21.1（Fabric）。
3. Mod 默认连接 `ws://127.0.0.1:8765/ws/audio`，可用 JVM 参数覆盖：

```
-Dvoxkin.audio.url=ws://127.0.0.1:8765/ws/audio
-Dvoxkin.audio.bot=Voxkin
```

`voxkin.audio.bot` 是桥接机器人的游戏名，用于定位声源。

## 实现要点

- 通过两个 Mixin 访问器取得 `SoundManager.soundSystem` 与 `SoundSystem.soundEngine`。
- 使用 `SoundEngine.createSource(RunMode.STREAMING)` 创建流式声源，`Source.setStream` 绑定自定义 `AudioStream`。
- `AudioStream.read` 从并发队列取 PCM，队列为空时返回等长静音，避免 OpenAL 断流。
- 每个客户端 tick 调用 `Source.tick()` 补充缓冲区，并按机器人实体位置更新 `setPosition`。
- 音量取游戏内「语音」分类的音量。
- 收到 `flush` 后停止并释放声源，下一次数据到来时重新创建。
- 断线后每 3 秒重连一次。

## 协议

- 文本帧：`{"type":"welcome","sample_rate":32000,...}`、`{"type":"pcm","bytes":640,...}`、`{"type":"flush"}`
- 二进制帧：紧跟在 `pcm` 文本帧之后，内容为 little-endian 有符号 16 位单声道 PCM。

## 已知限制

- 没有在真实 Minecraft 客户端里做端到端验证，当前只保证编译通过、Mixin 目标字段与 Minecraft 1.21.1 的映射一致。
- 声源位置按实体坐标每 tick 更新，没有做遮挡与低通滤波。
- 只支持 32 kHz、单声道、16 位 PCM。
