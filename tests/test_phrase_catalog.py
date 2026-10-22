from __future__ import annotations

from voxkin.agent.skills import skill_ids
from voxkin.voice.phrase_catalog import (
    CATALOG,
    acknowledgement,
    catalog_entries,
    count_zh,
    phrase_for_intent,
    phrase_for_skill,
)

# 阶段 1 的验收口径：这九类意图各自至少要有一条可缓存的确认语。
REQUIRED_SKILLS = (
    "stop",
    "attack_nearest",
    "collect_blocks",
    "follow_player",
    "come_to_player",
    "eat",
    "sleep",
    "observe",
    "inventory",
)


def test_catalog_has_at_least_twenty_phrases() -> None:
    assert len(CATALOG) >= 20


def test_catalog_covers_required_intents() -> None:
    for skill_id in REQUIRED_SKILLS:
        assert phrase_for_skill(skill_id) is not None, skill_id


def test_every_phrase_maps_to_a_real_skill() -> None:
    known = skill_ids()
    for phrase in CATALOG:
        assert phrase.skill_id in known, phrase.skill_id


def test_phrase_ids_are_unique() -> None:
    ids = [phrase.phrase_id for phrase in CATALOG]
    assert len(ids) == len(set(ids))


def test_count_is_rendered_in_chinese() -> None:
    assert count_zh(1) == "一"
    assert count_zh(3) == "三"
    assert count_zh(10) == "十"
    assert count_zh(12) == "十二"
    assert count_zh(25) == "二十五"


def test_collect_phrase_renders_count_and_plain_text() -> None:
    phrase = phrase_for_skill("collect_blocks")
    assert phrase is not None
    assert phrase.render({"block": "dirt", "count": 3}) == "好，我去挖三块。"
    assert phrase.render({"block": "dirt", "count": 1}) == "好，我去挖。"
    assert phrase.render({}) == "好，我去挖。"


def test_cache_key_ignores_default_count() -> None:
    phrase = phrase_for_skill("collect_blocks")
    assert phrase is not None
    assert phrase.cache_key({"block": "dirt", "count": 1}) == "ack.collect_blocks"
    assert phrase.cache_key({"block": "dirt", "count": 3}) == "ack.collect_blocks#count=3"


def test_acknowledgement_falls_back_for_unknown_skill() -> None:
    assert acknowledgement("follow_player") == "好，我跟着你。"
    assert acknowledgement("not_a_skill") == "好的，我这就去。"


def test_intent_lookup_finds_phrase() -> None:
    assert phrase_for_intent("stop_movement").skill_id == "stop"
    assert phrase_for_intent("eat_food").skill_id == "eat"
    assert phrase_for_intent("collect_blocks").skill_id == "collect_blocks"


def test_catalog_entries_have_unique_keys() -> None:
    entries = catalog_entries()
    keys = [key for key, _ in entries]
    assert len(keys) == len(set(keys))
    assert "ack.collect_blocks" in keys
    assert "ack.collect_blocks#count=3" in keys
    assert len(entries) >= 20
