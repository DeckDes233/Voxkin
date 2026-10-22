from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 优先级数字越小越优先，与 docs/plans/VOICE_ACTION_LATENCY_PLAN.md 的 8.1 节一致。
PRIORITY_SAFETY = 0
PRIORITY_STOP = 1
PRIORITY_COMMAND = 2
PRIORITY_TASK = 3
PRIORITY_AUTONOMOUS = 4
PRIORITY_REPORT = 5

# 带数量的确认语预合成多少个实例。超过这个范围的数量在运行时现合成并写回缓存。
PRELOAD_COUNTS = 8

_DIGITS = "零一二三四五六七八九"


def count_zh(value: int) -> str:
    """把 1-99 的数量写成中文口语数字，只用于确认语，不参与语义判断。"""
    number = int(value)
    if number < 0 or number > 99:
        return str(number)
    if number < 10:
        return _DIGITS[number]
    if number == 10:
        return "十"
    tens, ones = divmod(number, 10)
    # 十二、十五不说「一十二」，十位是 1 时省略前面的一。
    head = "十" if tens == 1 else _DIGITS[tens] + "十"
    return head + (_DIGITS[ones] if ones else "")


@dataclass(frozen=True)
class Phrase:
    """一句可预合成确认语。text 可含 {count} 之类槽位，缺槽位时退回 plain_text。"""

    phrase_id: str
    intent_id: str
    skill_id: str
    text: str
    plain_text: str
    priority: int
    required_slots: tuple[str, ...] = ()
    fallback: str = "好。"

    def _slot_value(self, values: dict[str, Any], slot: str) -> Any:
        """取槽位值；缺省值算作没有槽位，走通用说法。"""
        value = values.get(slot)
        if value is None:
            return None
        if slot == "count":
            try:
                if int(value) <= 1:
                    return None
            except (TypeError, ValueError):
                return None
        return value

    def render(self, arguments: dict[str, Any] | None = None) -> str:
        values = dict(arguments or {})
        if not self.required_slots:
            return self.text
        slots = {slot: self._slot_value(values, slot) for slot in self.required_slots}
        if any(value is None for value in slots.values()):
            return self.plain_text
        # 目前只支持 count 槽位；新增槽位时在这里补渲染。
        return self.text.replace("{count}", count_zh(int(slots["count"])))

    def cache_key(self, arguments: dict[str, Any] | None = None) -> str:
        """缓存键带上影响短语的槽位，避免不同参数共用一条错误的确认语。"""
        values = dict(arguments or {})
        if not self.required_slots:
            return self.phrase_id
        slots = {slot: self._slot_value(values, slot) for slot in self.required_slots}
        if any(value is None for value in slots.values()):
            return self.phrase_id
        parts = [f"{slot}={slots[slot]}" for slot in self.required_slots]
        return self.phrase_id + "#" + ",".join(parts)


def _phrase(
    skill_id: str,
    text: str,
    plain_text: str,
    priority: int = PRIORITY_COMMAND,
    intent_id: str = "",
    required_slots: tuple[str, ...] = (),
    fallback: str = "好。",
) -> Phrase:
    return Phrase(
        phrase_id=f"ack.{skill_id}",
        intent_id=intent_id,
        skill_id=skill_id,
        text=text,
        plain_text=plain_text,
        priority=priority,
        required_slots=required_slots,
        fallback=fallback,
    )


# 目录里的 skill_id 必须都能在 bridge/skills/manifest.json 里找到，
# 否则缓存会为不存在的技能预合成语音。tests/test_phrase_catalog.py 会核对这一点。
_CATALOG: tuple[Phrase, ...] = (
    _phrase("stop", "好，我停下了。", "好，我停下。", PRIORITY_STOP, "stop_movement", fallback="停了。"),
    _phrase("attack_nearest", "好，我打它。", "好，我打它。", PRIORITY_COMMAND, "attack_nearest"),
    _phrase("attack_target", "好，我打它。", "好，我打它。"),
    _phrase("collect_blocks", "好，我去挖{count}块。", "好，我去挖。", PRIORITY_COMMAND, "collect_blocks", ("count",)),
    _phrase("follow_player", "好，我跟着你。", "好，我跟着你。", PRIORITY_COMMAND, "follow_player"),
    _phrase("come_to_player", "好，我过去。", "好，我过去。", PRIORITY_COMMAND, "come_to_player"),
    _phrase("eat", "好，我吃点东西。", "好，我吃点东西。", PRIORITY_COMMAND, "eat_food"),
    _phrase("eat_if_hungry", "好，我看看饿不饿。", "好，我看看饿不饿。"),
    _phrase("sleep", "好，我去睡觉。", "好，我去睡觉。", PRIORITY_COMMAND, "sleep"),
    _phrase("sleep_safe", "好，我找地方睡。", "好，我找地方睡。"),
    _phrase("observe", "好，我看看四周。", "好，我看看四周。", PRIORITY_COMMAND, "observe_self"),
    _phrase("inventory", "好，我看看背包。", "好，我看看背包。", PRIORITY_COMMAND, "inventory"),
    _phrase("locate_block", "好，我去找找。", "好，我去找找。"),
    _phrase("locate_entity", "好，我看看附近有谁。", "好，我看看附近有谁。"),
    _phrase("look_at_player", "好，我看你。", "好，我看你。"),
    _phrase("goto", "好，我过去。", "好，我过去。"),
    _phrase("goto_block", "好，我过去。", "好，我过去。"),
    _phrase("break_block", "好，我去挖。", "好，我去挖。"),
    _phrase("place_block", "好，我放。", "好，我放。"),
    _phrase("pickup_items", "好，我去捡。", "好，我去捡。"),
    _phrase("craft", "好，我合成。", "好，我合成。"),
    _phrase("smelt", "好，我去熔炼。", "好，我去熔炼。"),
    _phrase("craft_bed", "好，我做张床。", "好，我做张床。"),
    _phrase("craft_tool_set", "好，我做套工具。", "好，我做套工具。"),
    _phrase("craft_torch", "好，我做火把。", "好，我做火把。"),
    _phrase("equip_shield", "好，我拿盾。", "好，我拿盾。"),
    _phrase("checkpoint_stock", "好，我存一下物资。", "好，我存一下物资。"),
    _phrase("store_items", "好，我收起来。", "好，我收起来。"),
    _phrase("withdraw_items", "好，我取东西。", "好，我取东西。"),
    _phrase("list_chest", "好，我看看箱子。", "好，我看看箱子。"),
    _phrase("mine_collect", "好，我去挖矿。", "好，我去挖矿。"),
    _phrase("deep_mine", "好，我往下挖。", "好，我往下挖。"),
    _phrase("strip_mine", "好，我开一条矿道。", "好，我开一条矿道。"),
    _phrase("safe_descend", "好，我小心下去。", "好，我小心下去。"),
    _phrase("safe_travel", "好，我小心过去。", "好，我小心过去。"),
    _phrase("parkour_safe", "好，我小心过去。", "好，我小心过去。"),
    _phrase("hunt_animal", "好，我去打猎。", "好，我去打猎。"),
    _phrase("find_diamond", "好，我去找钻石。", "好，我去找钻石。"),
    _phrase("make_shelter", "好，我搭个庇护所。", "好，我搭个庇护所。"),
    _phrase("return_home", "好，我回去。", "好，我回去。"),
    _phrase("wait_for_day", "好，我等天亮。", "好，我等天亮。", PRIORITY_AUTONOMOUS),
    _phrase("throw_eye", "好，我丢末影珍珠。", "好，我丢末影珍珠。"),
    _phrase("collect_blaze_rods", "好，我去找烈焰棒。", "好，我去找烈焰棒。"),
    _phrase("make_nether_portal", "好，我建下界门。", "好，我建下界门。"),
    _phrase("activate_end_portal", "好，我进末地。", "好，我进末地。"),
    _phrase("flee_low_health", "我先撤。", "我先撤。", PRIORITY_SAFETY, fallback="撤。"),
    _phrase("swim_escape", "我先上岸。", "我先上岸。", PRIORITY_SAFETY, fallback="上岸。"),
)

CATALOG: tuple[Phrase, ...] = _CATALOG

DEFAULT_ACK = "好的，我这就去。"


def catalog() -> tuple[Phrase, ...]:
    return CATALOG


def phrase_for_skill(skill_id: str) -> Phrase | None:
    for phrase in CATALOG:
        if phrase.skill_id == skill_id:
            return phrase
    return None


def phrase_for_intent(intent_id: str) -> Phrase | None:
    for phrase in CATALOG:
        if phrase.intent_id == intent_id:
            return phrase
    return None


def acknowledgement(skill_id: str, arguments: dict[str, Any] | None = None) -> str:
    """技能对应的确认语；目录里没有的技能用通用说法。"""
    phrase = phrase_for_skill(skill_id)
    if phrase is None:
        return DEFAULT_ACK
    return phrase.render(arguments)


def catalog_entries() -> list[tuple[str, str]]:
    """缓存要预合成的 (键, 文本) 列表：每条技能一份通用语，带槽位的再补一份实例。"""
    entries: list[tuple[str, str]] = []
    for phrase in CATALOG:
        entries.append((phrase.phrase_id, phrase.plain_text))
        if phrase.required_slots:
            for count in range(2, PRELOAD_COUNTS + 1):
                key = phrase.cache_key({"count": count})
                entries.append((key, phrase.render({"count": count})))
    return entries
