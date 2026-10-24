# Voxkin 多人测试冻结候选（2026-10-24）

## 冻结范围

- 标签：`multiplayer-test-20261024`
- 分支：`develop`
- 用途：让可信局域网内的多人通过 Minecraft 聊天共同体验当前 Core/Bridge 与生存技能进展；这不是已验收的通关版本。
- 最近已提交基线：`a997f11`（`feat: expand survival skills and isolate live evaluations`）。本冻结候选还包含其后的剪羊探索改动及对应模拟测试、证据更新；冻结标签会指向包含这些改动的提交。

## 验证记录

- Python：`.\.venv\Scripts\python.exe -m pytest tests -q`，323 passed，54 条 aiohttp `NotAppKeyWarning`。
- Bridge：`node --test bridge/tests/*.test.js`，100 passed。
- `git diff --check` 通过。
- **未通过/未覆盖的实机阶段**：截至 2026-10-24，六次隔离 S0→S6 实机链均未完成 S2；最新安全随机剪羊搜索没有一次实际运行到 Minecraft 执行。S3–S6 未运行，S4 未通过。以上自动化测试不是 Paper/Minecraft 实机通过证据。

## 测试者要安装什么

### Voxkin 主机（只需一台）

- Windows 主机安装 Python 3.10、Node.js 20+、Git。多人语音测试主机安装 `.[dev,stt,audio]` 并准备 faster-whisper 模型与可用麦克风。若使用 Genie TTS，再安装 `.[tts]`；若使用 GPT-SoVITS，则需另备其运行包、模型音色与参考音频，并启动本地 API。纯文字聊天/动作测试才可省略 STT 和 TTS。
- 准备 Voxkin 仓库的此冻结标签，安装 Python 与 Bridge 依赖：

  ```powershell
  python -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -e ".[dev,stt,audio]"
  cd bridge
  npm install
  cd ..
  Copy-Item config\voxkin.example.yaml config\voxkin.yaml
  ```

- 配置可用的 OpenAI-compatible LLM 凭据（默认读取 `DEEPSEEK_API_KEY`，也可放在忽略的 `config/local.yaml`）；没有 LLM 凭据时不能进行模型对话与工具调用。
- 使用默认离线 Bridge 账号 `Voxkin`。推荐把 Core、Bridge、专用 Minecraft 测试服务器放在同一台主机上。

### Minecraft 服务器

- 需要 Java 21 与专用 Minecraft Java 1.21.1 Paper 测试服务器；设置 `spawn-protection=0`，并确保局域网参与者可以连接。
- 当前 Bridge 默认是离线账号，因此服务器需要 `online-mode=false` 与 `enforce-secure-profile=false`。离线模式不验证玩家身份，只能在可信、隔离的测试网使用；禁止公网端口转发。
- 如服务器运行在另一台机器，防火墙只允许可信 LAN 访问 Minecraft 端口（通常 TCP 25565）。
- 测试者各自安装匹配的 Minecraft Java 客户端。若要在游戏内听到 Voxkin 语音，每位玩家需安装兼容的 Fabric Loader、Fabric API 和 Voxkin 音频 Mod；Mod 可在 `mod/` 用 JDK 21 与仓库 Gradle Wrapper 构建。仅测试文字聊天与动作时不需要 Mod。

## TTS / STT

- **听到 Voxkin 回复需要 TTS。** TTS 在 Core 主机运行：启动 GPT-SoVITS v2Pro 服务并配置音色，或安装 `.[tts]` 并配置兼容的 Genie 模型与参考音频；无 TTS 时玩家听不到合成回复。
- **游戏内共享播报：** Core 配置 `audio.output: websocket`、`server.host: 0.0.0.0` 并重启；每位要听声音的客户端安装 Voxkin Fabric 音频 Mod，并将 JVM 参数 `-Dvoxkin.audio.url=ws://<Voxkin主机LAN地址>:8765/ws/audio`、`-Dvoxkin.audio.bot=Voxkin`。Studio API 和音频 WebSocket 共用 8765 端口且没有认证；只在防火墙限制来源的可信隔离 LAN 中测试，禁止公网暴露。目前 Mod 的真实多人播放/空间效果尚未实机验收。
- **语音指令需要 STT。** Core 主机需安装 `.[dev,stt,audio]`、faster-whisper 模型并连接麦克风。当前 STT 只采集 Core 主机麦克风；同一房间的多人可共用该麦克风，但每位远端玩家各自电脑的麦克风流还不能传入 Core。远端参与者可用游戏聊天发文字指令。

- **LAN 安全限制：** 远端 Mod 要连接 Core 音频 WebSocket，需设置 `server.host: 0.0.0.0`；但同端口的 Studio API 与 WebSocket 无认证。只在隔离可信 LAN 并用防火墙限制来源的测试环境中开放，禁止公网暴露。若只测试游戏聊天和动作，保持默认 `127.0.0.1`，不要开放 Core 端口。

## 启动与停止

在 Voxkin 仓库根目录、Minecraft 服务器已启动后运行：

```powershell
.\scripts\eval_stack.ps1 -Action start -McPort 25565 -Host_ "<服务器局域网地址>"
```

若服务器就在 Voxkin 主机，地址填 `127.0.0.1`。主持机打开 <http://127.0.0.1:8765> 检查 Bridge 状态；参与者连接 Minecraft 服务器。若仅测文字指令，通过游戏聊天发话；若要听合成语音，确认 Core 的 `server.host` 已设置为 `0.0.0.0`、防火墙只允许可信 LAN 访问 8765，且客户端 Mod 配置了 Core 主机 LAN 地址。结束后：

```powershell
.\scripts\eval_stack.ps1 -Action stop
```

此脚本不会启动、重置或停止 Minecraft 服务器。所有玩家共用一个 Voxkin 对话上下文和一个 bot 动作控制权；为避免多个目标冲突，请一次一人发指令、等待 bot 完成再换下一位。不要多人同时启动多个 Bridge 控制同一个测试世界。

## 冻结不代表

- 不代表 S2 或 S4 已通过。
- 不代表六十四项技能均已实机验证；自动化模拟与真实 Minecraft 结果分别记录。
- 不代表离线模式适合公开服务器，或 Studio 适合对 LAN 开放。
- 不代表多个玩家可安全并行操作同一个 Voxkin bot。

实机进度与失败路径以 [`docs/evidence/S0_S6_CHAIN_20261024.md`](evidence/S0_S6_CHAIN_20261024.md) 为准。
