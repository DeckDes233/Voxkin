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
            "name": "attack_target",
            "description": "攻击指定名字或类型的实体；默认只打敌对生物，玩家不会被攻击。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "实体名字，例如 zombie、husk",
                    },
                    "type": {
                        "type": "string",
                        "description": "hostile、player 或具体实体类型",
                    },
                    "id": {
                        "type": "integer",
                        "description": "实体 ID，可选，来自 locate_entity",
                    },
                    "range": {
                        "type": "number",
                        "description": "搜索范围，默认 16 格",
                        "minimum": 3,
                        "maximum": 32,
                    },
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
    {
        "type": "function",
        "function": {
            "name": "craft",
            "description": "用背包里的材料合成物品；需要工作台时会自动放置并回收。",
            "parameters": {
                "type": "object",
                "properties": {
                    "item": {
                        "type": "string",
                        "description": "物品 ID，例如 oak_planks、stick、wooden_pickaxe",
                    },
                    "count": {
                        "type": "integer",
                        "description": "合成数量，默认 1",
                        "minimum": 1,
                        "maximum": 64,
                    },
                },
                "required": ["item"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "eat",
            "description": "吃背包里的食物。饥饿值已满时不会吃；不指定 item 时自动挑一种食物，不会主动吃金苹果。",
            "parameters": {
                "type": "object",
                "properties": {
                    "item": {
                        "type": "string",
                        "description": "食物物品 ID，例如 bread、cooked_beef；省略时自动选择",
                    },
                    "count": {
                        "type": "integer",
                        "description": "最多吃几个，默认 1",
                        "minimum": 1,
                        "maximum": 16,
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "observe",
            "description": "用一句话报告自身状态和周围环境：坐标、朝向、维度、血量、饥饿、时间天气、手持、护甲、背包前 8 项、附近玩家与敌对生物。",
            "parameters": {
                "type": "object",
                "properties": {
                    "radius": {
                        "type": "number",
                        "description": "观察半径，默认 16 格",
                        "minimum": 1,
                        "maximum": 64,
                    },
                    "block": {
                        "type": "string",
                        "description": "可选，额外报告附近某一种方块，例如 iron_ore",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "locate_block",
            "description": "按方块 ID 搜索附近方块，返回候选坐标、距离和垂直差，并指出最近的一个；找不到时明确说明。",
            "parameters": {
                "type": "object",
                "properties": {
                    "block": {
                        "type": "string",
                        "description": "方块 ID，例如 iron_ore、oak_log",
                    },
                    "radius": {
                        "type": "number",
                        "description": "搜索半径，默认 32 格",
                        "minimum": 1,
                        "maximum": 64,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几个候选，默认 5",
                        "minimum": 1,
                        "maximum": 16,
                    },
                },
                "required": ["block"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "locate_entity",
            "description": "搜索附近实体，返回名字、类型、距离和坐标；玩家使用真实用户名，找不到时明确说明。",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": "可选，实体类型，例如 player、zombie、hostile",
                    },
                    "name": {
                        "type": "string",
                        "description": "可选，实体或玩家名字",
                    },
                    "radius": {
                        "type": "number",
                        "description": "搜索半径，默认 32 格",
                        "minimum": 1,
                        "maximum": 64,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几个，默认 5",
                        "minimum": 1,
                        "maximum": 16,
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sleep",
            "description": "走到 16 格内的床睡觉；下界、末地、白天（非雷暴）、附近有敌对生物或床被占用时会说明原因，不会假报天亮。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "smelt",
            "description": "把矿石或生食放进熔炉熔炼；附近没有熔炉时会尝试放置背包里的熔炉，结束后回收。",
            "parameters": {
                "type": "object",
                "properties": {
                    "item": {
                        "type": "string",
                        "description": "原料 ID，例如 raw_iron、raw_gold、beef",
                    },
                    "count": {
                        "type": "integer",
                        "description": "熔炼数量，默认 1",
                        "minimum": 1,
                        "maximum": 64,
                    },
                },
                "required": ["item"],
            },
        },
    },
]

TOOL_SYSTEM_HINT = (
    "你在 Minecraft 世界里行动，可以使用工具改变游戏状态。"
    "回答玩家时直接用语音，不要调用工具来说话；只有确实要移动、挖掘或停止时才调用工具。"
    "玩家说跟我来、跟上、别掉队时调用 follow_player；说过来、来我这、到我这里时调用 come_to_player；"
    "问背包或有什么东西时调用 inventory；让你打怪、清怪时调用 attack_nearest；指定打某一只用 attack_target。"
    "要挖单个方块用 break_block；要放置方块用 place_block；要走到某种方块用 goto_block；地上有掉落物用 pickup_items。"
    "要合成木板、木棍、工作台、工具时用 craft。"
    "要把粗铁、粗金或生食熔炼时用 smelt。"
    "想知道周围情况用 observe；找方块用 locate_block；找玩家或生物用 locate_entity；饿了用 eat；晚上用 sleep 睡觉。"
    "玩家问你是谁、在哪、在做什么、为什么，先用一句话直接回答，不要调用工具。"
    "调用工具前先说一句要做什么，不要只调用工具不说话。"
    "回答保持一到两句话，不要提到接口、模型、语音合成或系统内部。"
    "描述动作使用「我去」这样的进行时，不要声称已经完成，完成情况由系统回报。"
)
