# Voxkin Audio（Fabric 客户端 Mod）

接收 Voxkin Core 通过 WebSocket 推送的 PCM 分块，在 Minecraft 客户端按顺序播放，并支持 `flush` 打断。

当前版本使用 Java 自带的音频输出（`javax.sound.sampled`），声音从客户端默认输出设备播放，不受游戏内音量设置与声源位置影响。空间音源需要在后续版本中接入 Minecraft 的 OpenAL 混音器。

## 构建

需要 JDK 21 与 Gradle 8.12。

```powershell
cd mod
$env:JAVA_HOME="<JDK 21 路径>"
gradle build
```

产物在 `build/libs/voxkin-audio-0.1.0.jar`，放入 `mods/` 目录（需要 Fabric Loader 与 Fabric API 0.107.0+1.21.1）。

## 运行

1. 启动 Voxkin Core，并把 `audio.output` 设为 `websocket`。
2. 启动 Minecraft 1.21.1（Fabric）。
3. Mod 默认连接 `ws://127.0.0.1:8765/ws/audio`，可用 JVM 参数覆盖：

```
-Dvoxkin.audio.url=ws://127.0.0.1:8765/ws/audio
```

## 协议

- 文本帧：`{"type":"welcome","sample_rate":32000,...}`、`{"type":"pcm","bytes":640,...}`、`{"type":"flush"}`
- 二进制帧：紧跟在 `pcm` 文本帧之后，内容为 little-endian 有符号 16 位单声道 PCM。

## 已知限制

- 没有空间音源、距离衰减与游戏音量联动。
- 没有在真实客户端里做端到端验证，当前只保证编译通过与协议实现。
- 断线后每 3 秒重连一次。
