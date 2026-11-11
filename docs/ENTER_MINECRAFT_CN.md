# 连接 Minecraft

[文档导航](README.md) · 前置步骤：[启动 Core](GETTING_STARTED_CN.md) · [桥接协议](../bridge/README.md)

本文使用 Windows、Minecraft Java 1.21.1 与独立测试服务器。Core 和 Bridge 通常运行在同一主机，服务器可以在本机或可信 LAN；Fabric 音频 Mod 只负责客户端播放。

```text
玩家游戏聊天 → Minecraft 服务端 → Mineflayer Bridge ↔ Core / Studio
Core 主机麦克风 → STT → Core → LLM / TTS → 主机扬声器或客户端音频 Mod
```

## 运行前检查

在已有工作区启动任何实机运行前，先读取：

```powershell
Get-Content work\refactor_validation_20261027\active_progress.json
```

`cleanup_pending` 时不得另起运行；`runtime_blocked` 且没有新的环境恢复证据时，不重复相同失败条件。保留存档、数据库、原 deadline 与未确认动作，恢复后进行一次有界验证。完整规则见 [AGENTS.md](../AGENTS.md)。新克隆可能没有这个本地文件，不能将缺失当作已有环境恢复的证据；已有工作区缺失时先查找原运行记录。

截至 2026-10-28 的记录仍有 Windows 原生崩溃阻塞，见 [STATUS](STATUS.md)。本文描述配置流程，不表示当前主机已通过恢复验证。

## 1. 准备测试服务器

使用 Java 21 与兼容的 Minecraft Java 1.21.1 服务端。项目历史实测使用 Paper；自行准备运行目录、服务端 jar，并阅读和接受其 EULA。首次启动生成配置后，停止服务器再编辑 `server.properties`。

默认离线机器人对应以下**本机或隔离可信 LAN 测试配置**：

```properties
online-mode=false
enforce-secure-profile=false
spawn-protection=0
server-port=25565
gamemode=survival
difficulty=normal
```

离线模式无法验证玩家身份，不开放公网端口。使用专门的测试存档；正式 G1 对世界初始化、规则和人工干预另有[验收要求](MILESTONE.md)。已有服务器的版本、认证方式和端口必须与 Bridge 配置一致。

服务器目录中的启动示例：

```powershell
java -Xms1G -Xmx2G -jar paper.jar nogui
```

检查服务器就绪日志与端口，然后用自己的客户端确认能加入。该命令不用于重置世界。

## 2. 启动 Core 和 Bridge

按[入门指南](GETTING_STARTED_CN.md)配置并启动 Core。另开 PowerShell，从仓库根目录运行：

```powershell
npm --prefix bridge install
$env:MC_HOST = "127.0.0.1"
$env:MC_PORT = "25565"
$env:MC_VERSION = "1.21.1"
$env:MC_USERNAME = "Voxkin"
$env:MC_AUTH = "offline"
$env:VOXKIN_WS = "ws://127.0.0.1:8765/ws/bridge"
$env:VOXKIN_INDEPENDENT = "0"
node bridge/minecraft_bridge.js
```

`0` 用于 G2 玩家互动；`1` 用于 G1 独立模式，不向玩家索要坐标或跟随玩家。Microsoft 认证是另一配置路径，未由本文的离线测试验收。

检查 Bridge 已连接 Core、已进入世界，以及 Studio 桥接状态。普通动作还需世界就绪与新鲜观察；仅 WebSocket 建连成功不表示可执行游戏动作。

本机专用的 `scripts/quickstart_player.py` 依赖 `work/runtimes/node-v22.23.4-win-x64/node.exe`、固定 Studio 地址及活动 marker，不能替代新克隆的安装步骤。条件满足后才使用，详见[脚本说明](../scripts/README.md)。

## 3. 验证玩家互动

用名字不同于 `Voxkin` 的玩家加入世界，在聊天框提出明确的小目标，例如“帮我挖两块泥土”。依次检查：

1. Core 收到玩家输入，并出现模型回复或工具调用。
2. Studio 有动作开始和终态事件，游戏里发生对应动作。
3. 结果回执与背包、世界观察一致；失败或部分完成时如实反馈。
4. 再测试修改目标、停止和取消，单独记录 G2 的结果。

当前对话回复主要通过 Core 的语音链路输出；静音时从 Studio 查看。说“完成了”不能代替实际数量核验。G1 阶段脚本通过也不能证明 G2 指令理解通过。

麦克风配置见[入门指南](GETTING_STARTED_CN.md)。它读取 Core 主机设备，远端玩家目前使用游戏聊天输入文字。

## 4. 客户端音频与 LAN（可选）

默认 `speaker` 只在 Core 主机播放。让每位玩家在客户端听到语音：

1. 按 [Mod 说明](../mod/README.md)用 JDK 21 和 Gradle wrapper 构建，把产物和对应 Fabric API 安装到每个客户端。
2. 配置 Core 的 `audio.output: websocket`，重启 Core。
3. 本机客户端使用默认 `ws://127.0.0.1:8765/ws/audio`；远端客户端使用 Core 主机的 LAN 地址。
4. JVM 参数 `-Dvoxkin.audio.bot=Voxkin` 必须匹配 `MC_USERNAME`；音频地址用 `-Dvoxkin.audio.url=ws://<Core主机LAN地址>:8765/ws/audio` 指定。

LAN 音频需要 Core 的 `server.host: 0.0.0.0` 并用防火墙限制来源。Studio API 与音频 WebSocket 共用端口且没有认证，仅限可信隔离 LAN。Bridge 与 Core 在同机时，`VOXKIN_WS` 仍用回环地址；Minecraft 在另一主机时，仅将 `MC_HOST` 指向服务器。

Mod 已构建，但真实客户端空间音效尚未验收；需检查播放、距离衰减、跟随移动和打断。不要把这些预期效果当成已通过结果。外观研究另见 [YSM 兼容性](research/YSM_ACTION_COMPATIBILITY.md)。

## 5. 评测与退出

手动启动的 Bridge 和 Core 各自在终端按 `Ctrl+C` 退出，服务器使用自身控制台的 `stop` 保存后退出。

`eval_stack.ps1` 是独立模式测试栈，默认游戏端口 `25566`；它不创建或启动 Minecraft 服务器。它的 `stop` 只结束该脚本管理的进程，不能代替 Paper 保存，也不能代替未完成的动作对账。阶段评测与续跑见[脚本说明](../scripts/README.md)及[评测计划](plans/EVALUATION.md)。

## 排查与验收边界

| 现象 | 检查 |
| --- | --- |
| `ECONNREFUSED` | 服务器/Core 是否监听，`MC_HOST`、`MC_PORT`、`VOXKIN_WS` 是否匹配 |
| 登录失败或被踢 | 服务端版本、认证方式、用户名冲突和服务器日志 |
| 已连接但动作不运行 | 世界 ready、新鲜观察、执行器状态、模型工具调用与动作回执 |
| 挖掘失败 | 服务器保护、距离、工具、可达性和技能失败原因 |
| 有文字无声音 | TTS 初始化/静音降级、参考音频、`audio.output`、Mod 连接 |
| 原生异常退出 | 保留日志与 marker，不反复重启相同失败条件；按现有调查继续定位 |

局部资源耗尽或遇水应保留目标并恢复、换区、重新规划。实机阻塞时先按 [AGENTS.md](../AGENTS.md)查 Wiki、依赖实现与世界证据再修复。已记录结果见 [STATUS](STATUS.md)，延迟及其引擎环境见 [BENCHMARK_RESULTS](BENCHMARK_RESULTS.md)。
