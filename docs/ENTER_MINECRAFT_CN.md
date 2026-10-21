# 让沃心进入 Minecraft：全流程

这篇文档从一台干净的 Windows 电脑开始，把沃心送进 Minecraft 1.21.1，并让它能听见你、用语音回答、在游戏里干活。每一步都给出可以检查的结果，照着做就能定位问题出在哪一环。

## 先理解它是怎么组成的

沃心在游戏里其实由三个进程合作：

| 进程 | 角色 | 在哪里跑 |
| --- | --- | --- |
| Voxkin Core（`python -m voxkin serve`） | 大脑：语音识别、模型、语音合成、记忆、动作派发 | 你的电脑 |
| Minecraft 桥接（`bridge/minecraft_bridge.js`） | 沃心的游戏身份：一个叫 `Voxkin` 的机器人玩家 | 你的电脑 |
| Minecraft 服务器（Paper 1.21.1） | 世界：你和机器人都连到这里 | 你的电脑或局域网 |

数据流是这样的：

```text
你（Minecraft 客户端） ──┐
                        ├── Paper 服务器 ── 机器人 Voxkin（mineflayer）
沃心（Studio 麦克风） ──→ Voxkin Core ── WebSocket ──┘
                              │
                              └── 语音合成 ──→ 音箱，或客户端 Mod 在机器人位置播放
```

两个关键事实：

1. 沃心在游戏里的“说话”走语音，不往聊天框打字。它听见的是玩家在聊天框里发的文字，或者你对着 Studio 麦克风说的话。
2. 机器人是一个独立的 Minecraft 账号（离线模式下的用户名），不是附着在你身上的宠物。它需要自己连进服务器。

## 为什么必须用专用服务器

单机世界的“对局域网开放”默认开启正版验证，离线机器人拿不到正版会话，会被服务器拒绝。专用服务器可以把 `online-mode` 设为 `false`，机器人才能用用户名直接进入。

另外，单机世界在你打开菜单时会暂停，机器人会卡住；专用服务器始终运行，适合长时间陪伴。

> 把 `online-mode=false` 的服务器暴露到公网，任何人都能冒用任意用户名进入。这套配置只用于本机或可信局域网。

## 第一步：准备服务器

需要 Java 21。没有的话，装一个 JDK 21 或 JRE 21。

1. 新建一个目录，例如 `D:\mc-server`。
2. 从 Paper 官方下载 1.21.1 的服务端 jar，重命名为 `paper.jar`。
3. 在同目录新建 `eula.txt`，写入：

   ```text
   eula=true
   ```

4. 启动一次，让它生成配置：

   ```powershell
   cd D:\mc-server
   java -Xms1G -Xmx2G -jar paper.jar nogui
   ```

5. 关闭服务器，编辑 `server.properties`，至少确认这几项：

   ```properties
   online-mode=false
   enforce-secure-profile=false
   spawn-protection=0
   server-port=25565
   gamemode=survival
   difficulty=normal
   ```

   `spawn-protection=0` 很重要：默认的出生点保护会让机器人无法在出生点附近挖方块，动作会失败。

6. 再次启动服务器，看到 `Done (…)! For help, type "help"` 就绪。

**检查点**：服务器日志没有报错，`25565` 端口在监听。

## 第二步：安装沃心

```powershell
git clone https://github.com/DeckDes233/Voxkin.git
cd Voxkin
python -m venv .venv --system-site-packages
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item config\voxkin.example.yaml config\voxkin.yaml
```

把模型密钥写进 `config/local.yaml`（这个文件不会进入版本库）：

```yaml
llm:
  base_url: "https://opencode.ai/inference/go/openai/v1"
  model: "deepseek-v4.1-flash"
  api_key: "<你的密钥>"
  headers:
    x-opencode-session: "voxkin-deepseek-chan-01"
```

准备 GPT-SoVITS v2Pro 运行包和一个训练好的音色，确认 `models/reference/` 下有参考音频，并且 `config/voxkin.yaml` 里的 `tts.reference_audio` 指向它。

## 第三步：按顺序启动三个服务

顺序有讲究：先语音合成，再 Core，最后桥接。桥接连不上 Core 会每 3 秒重连，但 Core 启动时读不到配置就会直接报错。

### 1. 语音合成

```powershell
cd <GPT-SoVITS 目录>
.\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml
```

**检查点**：日志出现监听 `127.0.0.1:9880`。

### 2. Voxkin Core 与控制台

另开一个终端：

```powershell
cd D:\AI-Workspace\Voxkin
.\.venv\Scripts\python.exe -m voxkin serve
```

打开 <http://127.0.0.1:8765>。在输入框里发一句“你好”，能听到声音就说明模型、语音合成、播放这条链路是通的。

### 3. Minecraft 桥接

再开一个终端：

```powershell
cd D:\AI-Workspace\Voxkin\bridge
npm install
$env:MC_HOST="127.0.0.1"
$env:MC_PORT="25565"
$env:MC_VERSION="1.21.1"
$env:MC_USERNAME="Voxkin"
$env:MC_AUTH="offline"
$env:VOXKIN_WS="ws://127.0.0.1:8765/ws/bridge"
node minecraft_bridge.js
```

**检查点**：桥接日志依次出现：

```text
[bridge] 已连接 Voxkin Core
[bridge] Core 握手完成 Voxkin@127.0.0.1:25565
[bridge] 已进入世界
```

Studio 顶部的桥接状态变成“已连接”，游戏里能看到玩家 `Voxkin` 站在世界里。

## 第四步：在游戏里和沃心说话

1. 用 Minecraft 1.21.1 客户端连接 `127.0.0.1:25565`。服务器是离线模式，用户名随意，但不要叫 `Voxkin`。
2. 进入世界后，在聊天框输入：

   ```text
   沃心，帮我挖两块泥土
   ```

3. 观察三件事：
   - 几秒内听到沃心的语音回答（从电脑音箱出来）；
   - Studio 的事件流出现 `工具调用`、`行动开始`、`行动完成`；
   - 游戏里的机器人走到泥土旁，真的挖了两块。

   **检查点**：Studio 里 `行动完成` 的结果是 `挖到 2 个 泥土`，打开背包能看到泥土。沃心不会在聊天框里打字，它的回答只有声音。

4. 再试一个不需要动作的问题，例如“你现在在哪”，确认它能结合游戏状态回答。

## 第五步：用麦克风直接对话

游戏内聊天需要打字。想直接说话，用 Studio 的麦克风面板：

1. 在 <http://127.0.0.1:8765> 找到“麦克风”面板，点“开始聆听”。
2. 对着麦克风说“沃心，你能听到我吗”。
3. 面板会显示识别文本、识别耗时和沃心的回复，同时能听到声音。

也可以改用命令行：

```powershell
.\.venv\Scripts\python.exe -m voxkin mic
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--listen-only` | 只识别，不调用模型与语音，用来检查麦克风 |
| `--gain 4` | 麦克风声音偏小时放大输入 |
| `--no-barge-in` | 外放音箱时关闭打断 |
| `--device "<名称片段>"` | 指定输入设备，写设备名的一部分即可，留空用系统默认 |

**外放音箱时**：播放结束后的 1.5 秒内会忽略麦克风输入，避免沃心把自己的声音当成新指令。更稳妥的做法是戴耳机，或者同时只用一种输入方式（要么游戏聊天，要么麦克风）。

麦克风和游戏聊天可以同时开，但两个输入源会抢同一个对话回合。测试时建议一次只用一个。

## 第六步（可选）：让声音从机器人位置传来

默认声音从电脑音箱平铺出来。装上客户端 Mod 后，声音会绑定在机器人实体上，走远会变小，转头能听出方向。

1. 构建 Mod：

   ```powershell
   cd D:\AI-Workspace\Voxkin\mod
   $env:JAVA_HOME="<JDK 21 路径>"
   gradle build
   ```

2. 把 `mod\build\libs\voxkin-audio-0.1.0.jar` 和对应 1.21.1 的 Fabric API 放进客户端的 `mods\` 目录。
3. 把 `config/voxkin.yaml` 的 `audio.output` 改成 `websocket`，重启 Core。
4. 在启动器的 JVM 参数里加上：

   ```text
   -Dvoxkin.audio.url=ws://127.0.0.1:8765/ws/audio
   -Dvoxkin.audio.bot=Voxkin
   ```

   `voxkin.audio.bot` 必须和桥接的 `MC_USERNAME` 一致，否则 Mod 找不到声音应该绑定到谁身上。

5. 进入世界，确认客户端日志出现 `[voxkin-audio] 已连接 ws://127.0.0.1:8765/ws/audio`。游戏设置里把“玩家语音”音量调到合适位置。

**当前状态**：这段代码已经构建通过，声源创建、PCM 推流、位置更新都写好了，但还没有在真实 Minecraft 客户端里验证过空间效果。第一次实机测试时，重点看声音是否随距离衰减、是否跟随机器人移动。

## 第七步（可选）：给机器人换外观

Yes Steve Model（YSM）是客户端模组，模型包也放在客户端。把模型包放进 YSM 的模型目录，在它的界面里把模型分配给玩家名 `Voxkin`。

这只改变你客户端看到的外观；其他玩家看到什么，取决于服务器是否同步模型。YSM 的具体菜单在不同版本里会变，按你安装的版本操作。

## 验收清单

全部通过，说明这条链路真的跑通了：

| 检查项 | 预期结果 |
| --- | --- |
| 桥接连接 | 日志有“已进入世界”，Studio 显示已连接 |
| 游戏内聊天 | 发一句话，几秒内听到语音回答 |
| 动作执行 | 让它挖两块泥土，`行动完成` 返回实际数量，背包里有泥土 |
| 麦克风 | Studio 里点开始聆听，说话后显示识别文本与回复 |
| 延迟 | 真实模型首句可听约 3.9 秒；本地测试模型约 1 秒 |
| 客户端 Mod（可选） | 声音从机器人方向传来，距离越远越小 |

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 桥接报 `ECONNREFUSED` | 服务器没开，或端口不对 | 确认 Paper 已就绪，`MC_PORT` 与 `server-port` 一致 |
| 机器人被踢：`Invalid session` | 服务器开着正版验证 | `online-mode=false`，重启服务器 |
| 机器人加入后立刻断开 | 版本不匹配 | 设置 `MC_VERSION=1.21.1`，客户端也用 1.21.1 |
| 有文字回复但没有声音 | 语音合成没启动，或输出设备不对 | 检查 9880 端口；Studio 里试听一句；确认 `audio.output` |
| 只说话不干活 | 模型没有选择工具，或桥接断开 | 说得具体些（“用工具挖两块泥土”）；看 Studio 桥接状态 |
| 动作失败：附近没有泥土 | 机器人周围确实没有目标方块 | 换到有泥土的地方，或换成 `stone`、`oak_log` |
| 动作失败：无法破坏方块 | 出生点保护 | `spawn-protection=0` |
| 沃心回答自己的话 | 外放音箱被麦克风收进去 | 戴耳机，或加 `--no-barge-in`，或测试时只开一种输入 |
| Mod 没有声音 | 没连上、输出方式没改、名字不一致 | 看客户端 `[voxkin-audio]` 日志；`audio.output: websocket`；`voxkin.audio.bot` 与 `MC_USERNAME` 一致 |
| 第一句要等很久 | 用的是真实在线模型 | 这是当前真实延迟，约 3–4 秒；离线测试模型约 1 秒 |

## 这一套验证到了什么程度

本机已经完成的验证：

- 游戏内聊天触发语音回答与工具调用，`action_done` 返回真实结果（挖到 2 个泥土，约 10 秒完成）。
- Studio 麦克风识别中文提问，识别耗时约 1.6 秒，回复正常播放。
- 桥接断线重连、动作结果回传、记忆写入都跑通。

还没有完成的验证：

- 客户端 Mod 在真实 Minecraft 客户端里的空间音频效果。
- 戴耳机时的自然打断体验。
- 公网服务器、正版账号机器人、多人同时对话。

这些在 [STATUS.md](STATUS.md) 里持续更新。
