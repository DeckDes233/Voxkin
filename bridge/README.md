# Minecraft 桥接

`minecraft_bridge.js` 让一个机器人在 Minecraft 里用玩家身份进入世界，把聊天转发给 Voxkin Core，并执行 Core 下发的动作。

## 安装与启动

```powershell
cd bridge
npm install
$env:MC_HOST = "127.0.0.1"
$env:MC_PORT = "25565"
$env:MC_VERSION = "1.21.1"     # 留空则自动协商
$env:MC_USERNAME = "Voxkin"
$env:MC_AUTH = "offline"       # 正版账号改成 microsoft
$env:VOXKIN_WS = "ws://127.0.0.1:8765/ws/bridge"
$env:VOXKIN_INDEPENDENT = "1"  # 独立通关模式：不向玩家索要坐标，不跟随玩家
node minecraft_bridge.js
```

Core 必须先启动（`python -m voxkin serve`）。桥接进程会自行处理 Core 断线与 Minecraft 断线，分别在 3 秒与 5 秒后重连。

## 来源

跟随、挖掘、放置、战斗等动作与自主行为的设计参考了 [MindCraft](https://github.com/mindcraft-bots/mindcraft)（MIT）。桥接没有引入它的运行时代码与 agent 循环，按函数重写并保留这份声明。

## 协议

所有消息都是 JSON 文本帧。

桥接 → Core：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `bridge`, `protocol` | 连接后立即发送 |
| `chat` | `player`, `text` | 游戏内聊天 |
| `state` | `data.position`、`health`、`food`、`dimension` | 每 5 秒一次 |
| `action_result` | `action_id`, `ok`, `detail` | 动作结果，必须与 `action_id` 对应 |

Core → 桥接：

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `welcome` | `name` | 握手确认 |
| `action` | `action_id`, `tool`, `arguments`, `timeout_s` | 执行动作 |
| `error` | `error` | 已有其他桥接连接等错误 |

## 支持的动作

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `chat` | `text` | 在游戏内发言 |
| `stop` | 无 | 停止移动并清除控制状态 |
| `goto` | `x`, `y`, `z` | 用 pathfinder 走到目标附近 2 格，返回实际距离 |
| `collect_blocks` | `block`, `count` | 寻找 32 格内最近的方块，逐个走到并挖掘，返回实际挖到的数量 |
| `look_at_player` | `player` | 转向指定玩家 |

动作串行执行：同一时刻只执行一个动作，队列中的动作依次进行。失败时返回 `ok: false` 与原因，不会伪造成成功。

## 已知限制

- 已在本机 Paper 1.21.1 上验证聊天、语音回复与 `collect_blocks` 动作；复杂地形、跨维度、需要特定工具等级的情况未验证。
- mineflayer 在 1.21.1 上对部分物品包会打印 `PartialReadError`（`ArmorTrimMaterial`），当前不影响连接与动作执行。
- `collect_blocks` 只处理 32 格内的方块，找不到时返回失败原因，不伪造成功。
- 动作失败后不会自动对玩家补一句说明，需要 Core 侧增加回述逻辑。
- 状态上报不含背包与附近实体，后续按需扩展。
