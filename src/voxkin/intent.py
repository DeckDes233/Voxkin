from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from voxkin.agent.skills import block_aliases
from voxkin.voice.phrase_catalog import phrase_for_intent

STOP = re.compile(r"(别跟|不要跟|不用跟|别再跟|停下|站住|停住|别动|取消当前|停止当前)")
# 「别挖了」这类否定式采集也是停止；不加进来会被采集规则误判成动作。
STOP_COLLECT = re.compile(r"(别|不要|不用|停止|取消)(再)?(挖|采|收集|摘|砍)")
FOLLOW = re.compile(r"(跟着我|跟上|跟我来|别掉队|离我近点|随我来)")
COME = re.compile(r"(过来|来我这|到我这里|来我身边|来这里)")
ATTACK = re.compile(r"(攻击|打它|打那个|揍|杀了|清怪|干掉)")
THREAT = re.compile(r"(小心|注意|有苦力怕|有僵尸|有怪)")
EAT = re.compile(r"(吃东西|吃点|吃个|吃了|饿了|进食|吃食物)")
SLEEP = re.compile(r"(睡觉|睡吧|去睡|找张床|上床)")
INVENTORY = re.compile(r"(背包|有什么|还有多少|多少个|够不够|有没有)")
OBSERVE = re.compile(r"(你在哪|在哪|坐标|现在几点|什么时间|天亮了吗|天黑了)")

# 会改世界的采集说法：挖、采、收集、弄点、摘、砍。
COLLECT = re.compile(r"(挖|采集|收集|弄点|摘点|砍点|砍)")
# 数量说法：中文数字或阿拉伯数字，后面跟「块」更明确。
COUNT = re.compile(r"([0-9]+|[一二两三四五六七八九十]+)\s*(?:块|个)?")
# 疑问句不触发动作。「你会挖泥土吗」是在问能力，不是在下令。
# 能力询问不触发动作。「你会挖矿吗」是在问能力，不是在下令。
# 单纯的问号不算，「我在哪？」仍然是明确的观察指令。
CAPABILITY_QUESTION = re.compile(
    r"(能不能|可不可以|会不会|是不是能|你会不会|你能不能|你可以吗|你会吗|你会|你能|怎么才能|如何才能)"
)

CN_DIGITS = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}

# 规则意图到技能与参数的映射。参数只放能确定的值，不确定就不走快路。
INTENT_SKILLS: dict[str, tuple[str, float]] = {
    "stop_movement": ("stop", 0.95),
    "follow_player": ("follow_player", 0.9),
    "come_to_player": ("come_to_player", 0.85),
    "attack_nearest": ("attack_nearest", 0.8),
    "eat_food": ("eat", 0.8),
    "sleep": ("sleep", 0.8),
    "inventory": ("inventory", 0.7),
    "observe_self": ("observe", 0.75),
}


@dataclass(frozen=True)
class Intent:
    name: str
    text: str
    confidence: float


@dataclass(frozen=True)
class IntentPlan:
    """规则意图的结构化结果：技能、参数、确认语和去重键。"""

    intent_id: str
    skill_id: str
    arguments: dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.0
    ack_key: str = ""
    source: str = "rule"
    dedupe_key: str = ""
    ack_text: str = ""


def classify(text: str) -> Intent | None:
    """高置信度规则路由；不确定时返回 None，交给模型判断。"""
    value = (text or "").strip()
    if not value:
        return None
    for name, pattern, confidence in (
        ("stop_movement", STOP, 0.95),
        ("stop_movement", STOP_COLLECT, 0.95),
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


def is_stop(text: str) -> bool:
    intent = classify(text)
    return intent is not None and intent.name == "stop_movement"


def _parse_count(text: str) -> int | None:
    """从「三块」「10 个」这类说法里取出数量；没有就返回 None。"""
    match = COUNT.search(text)
    if match is None:
        return None
    raw = match.group(1)
    if raw.isdigit():
        value = int(raw)
    elif raw == "十":
        value = 10
    elif len(raw) == 1:
        value = CN_DIGITS.get(raw, 0)
    elif raw.startswith("十"):
        value = 10 + CN_DIGITS.get(raw[1:], 0)
    elif raw.endswith("十"):
        value = CN_DIGITS.get(raw[0], 0) * 10
    else:
        value = CN_DIGITS.get(raw[0], 0) * 10 + CN_DIGITS.get(raw[1], 0)
    return value if value > 0 else None


def _find_block(text: str) -> str | None:
    """按共享词表找出玩家说的方块；同名时取更长的那个。"""
    best: tuple[str, str] | None = None
    for label, block_id in block_aliases().items():
        if label not in text:
            continue
        if best is None or len(label) > len(best[0]):
            best = (label, block_id)
    return best[1] if best else None


def _normalize_arguments(arguments: dict[str, Any]) -> str:
    return "|".join(f"{key}={arguments[key]}" for key in sorted(arguments))


def _make_plan(
    intent_id: str, skill_id: str, arguments: dict[str, Any], confidence: float
) -> IntentPlan:
    phrase = phrase_for_intent(intent_id) or phrase_for_skill(skill_id)
    if phrase is None:
        ack_key = f"ack.{skill_id}"
        ack_text = ""
    else:
        ack_key = phrase.cache_key(arguments)
        ack_text = phrase.render(arguments)
    return IntentPlan(
        intent_id=intent_id,
        skill_id=skill_id,
        arguments=arguments,
        confidence=confidence,
        ack_key=ack_key,
        source="rule",
        dedupe_key=f"{skill_id}|{_normalize_arguments(arguments)}",
        ack_text=ack_text,
    )


def _collect_plan(text: str) -> IntentPlan | None:
    if COLLECT.search(text) is None:
        return None
    block_id = _find_block(text)
    if block_id is None:
        return None
    count = _parse_count(text) or 1
    return _make_plan(
        "collect_blocks", "collect_blocks", {"block": block_id, "count": count}, 0.92
    )


def plan(text: str) -> IntentPlan | None:
    """把一句话变成可执行的意图计划；不确定时返回 None，交给模型判断。"""
    value = (text or "").strip()
    if not value:
        return None
    if CAPABILITY_QUESTION.search(value):
        return None
    intent = classify(value)
    if intent is not None:
        mapping = INTENT_SKILLS.get(intent.name)
        if mapping is None:
            return None
        skill_id, confidence = mapping
        return _make_plan(intent.name, skill_id, {}, confidence)
    return _collect_plan(value)
