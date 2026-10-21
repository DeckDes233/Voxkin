from __future__ import annotations

from typing import Any

MINECRAFT_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "collect_blocks",
            "description": "走到附近的方块并挖掘指定数量，返回实际挖到的数量。",
            "parameters": {
                "type": "object",
                "properties": {
                    "block": {"type": "string", "description": "方块 ID，例如 dirt、oak_log、stone"},
                    "count": {"type": "integer", "description": "需要挖掘的数量", "minimum": 1},
                },
                "required": ["block", "count"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "goto",
            "description": "走到指定坐标附近两格。",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "z": {"type": "number"},
                },
                "required": ["x", "y", "z"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "chat",
            "description": "在游戏聊天栏发送一条消息。",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stop",
            "description": "停止当前移动与操作。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "look_at_player",
            "description": "转向指定玩家。",
            "parameters": {
                "type": "object",
                "properties": {"player": {"type": "string"}},
                "required": ["player"],
            },
        },
    },
]

TOOL_SYSTEM_HINT = (
    "你在 Minecraft 世界里行动，可以使用工具改变游戏状态。"
    "玩家要求做事时调用合适的工具；描述动作使用「我去」这样的进行时，"
    "不要声称已经完成，完成情况由系统回报。"
)
