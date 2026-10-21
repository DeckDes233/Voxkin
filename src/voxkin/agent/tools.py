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
    {
        "type": "function",
        "function": {
            "name": "follow_player",
            "description": "持续跟随玩家，玩家移动时自动跟上，直到收到停止指令。",
            "parameters": {
                "type": "object",
                "properties": {
                    "player": {"type": "string", "description": "玩家名，省略时跟随最近的玩家"},
                    "distance": {
                        "type": "number",
                        "description": "保持的距离，默认 2 格",
                        "minimum": 1,
                        "maximum": 6,
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "come_to_player",
            "description": "走到玩家当前所在位置附近，到一次就结束。",
            "parameters": {
                "type": "object",
                "properties": {
                    "player": {"type": "string", "description": "玩家名，省略时走向最近的玩家"}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inventory",
            "description": "查看背包里有哪些物品和数量。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "attack_nearest",
            "description": "攻击附近最近的敌对生物，自动装备剑或斧。",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": {
                        "type": "number",
                        "description": "搜索范围，默认 16 格",
                        "minimum": 3,
                        "maximum": 32,
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "break_block",
            "description": "挖掉一个方块。给方块名会自动找最近的，给坐标则挖指定位置。",
            "parameters": {
                "type": "object",
                "properties": {
                    "block": {"type": "string", "description": "方块 ID，例如 oak_log、stone"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "z": {"type": "number"},
                    "range": {
                        "type": "number",
                        "description": "按方块名搜索的范围，默认 16 格",
                        "minimum": 2,
                        "maximum": 32,
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "place_block",
            "description": "在指定坐标放置背包里的方块，会依附相邻方块。",
            "parameters": {
                "type": "object",
                "properties": {
                    "block": {"type": "string", "description": "方块 ID，例如 cobblestone"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "z": {"type": "number"},
                },
                "required": ["block", "x", "y", "z"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "goto_block",
            "description": "走到附近指定方块旁边，不挖掘。",
            "parameters": {
                "type": "object",
                "properties": {
                    "block": {"type": "string", "description": "方块 ID，例如 iron_ore"},
                    "range": {
                        "type": "number",
                        "description": "搜索范围，默认 32 格",
                        "minimum": 4,
                        "maximum": 64,
                    },
                },
                "required": ["block"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pickup_items",
            "description": "走到附近最近的掉落物旁边。",
            "parameters": {
                "type": "object",
                "properties": {
                    "range": {
                        "type": "number",
                        "description": "搜索范围，默认 16 格",
                        "minimum": 3,
                        "maximum": 32,
                    }
                },
            },
        },
    },
]

TOOL_SYSTEM_HINT = (
    "你在 Minecraft 世界里行动，可以使用工具改变游戏状态。"
    "回答玩家时直接用语音，不要调用工具来说话；只有确实要移动、挖掘或停止时才调用工具。"
    "玩家说跟我来、跟上、别掉队时调用 follow_player；说过来、来我这、到我这里时调用 come_to_player；"
    "问背包或有什么东西时调用 inventory；让你打怪、清怪时调用 attack_nearest。"
    "要挖单个方块用 break_block；要放置方块用 place_block；要走到某种方块用 goto_block；地上有掉落物用 pickup_items。"
    "玩家问你是谁、在哪、在做什么、为什么，先用一句话直接回答，不要调用工具。"
    "调用工具前先说一句要做什么，不要只调用工具不说话。"
    "回答保持一到两句话，不要提到接口、模型、语音合成或系统内部。"
    "描述动作使用「我去」这样的进行时，不要声称已经完成，完成情况由系统回报。"
)
