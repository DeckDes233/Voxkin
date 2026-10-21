from __future__ import annotations

import re
from dataclasses import dataclass

STOP = re.compile(r"(别跟|不要跟|不用跟|别再跟|停下|站住|停住|别动|取消当前|停止当前)")
FOLLOW = re.compile(r"(跟着我|跟上|跟我来|别掉队|离我近点|随我来)")
COME = re.compile(r"(过来|来我这|到我这里|来我身边|来这里)")
ATTACK = re.compile(r"(攻击|打它|打那个|揍|杀了|清怪|干掉)")
THREAT = re.compile(r"(小心|注意|有苦力怕|有僵尸|有怪)")
EAT = re.compile(r"(吃东西|吃点|吃个|吃了|饿了|进食|吃食物)")
SLEEP = re.compile(r"(睡觉|睡吧|去睡|找张床|上床)")
INVENTORY = re.compile(r"(背包|有什么|还有多少|多少个|够不够|有没有)")
OBSERVE = re.compile(r"(你在哪|在哪|坐标|现在几点|什么时间|天亮了吗|天黑了)")


@dataclass(frozen=True)
class Intent:
    name: str
    text: str
    confidence: float


def classify(text: str) -> Intent | None:
    """高置信度规则路由；不确定时返回 None，交给模型判断。"""
    value = (text or "").strip()
    if not value:
        return None
    for name, pattern, confidence in (
        ("stop_movement", STOP, 0.95),
        ("follow_player", FOLLOW, 0.9),
        ("come_to_player", COME, 0.85),
        ("attack_nearest", ATTACK, 0.8),
        ("assess_threat", THREAT, 0.7),
        ("eat_food", EAT, 0.8),
        ("sleep", SLEEP, 0.8),
        ("inventory", INVENTORY, 0.7),
        ("observe_self", OBSERVE, 0.75),
    ):
        if pattern.search(value):
            return Intent(name=name, text=value, confidence=confidence)
    return None
