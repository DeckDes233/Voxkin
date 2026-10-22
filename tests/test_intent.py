from __future__ import annotations

import pytest

from voxkin.intent import classify, is_stop, plan


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("跟着我", "follow_player"),
        ("不用跟着我了", "stop_movement"),
        ("站住，别动", "stop_movement"),
        ("来我这里", "come_to_player"),
        ("攻击前面那个苦力怕", "attack_nearest"),
        ("小心，附近有苦力怕", "assess_threat"),
        ("把那个金苹果吃了", "eat_food"),
        ("天黑了，睡觉吧", "sleep"),
        ("查看我有什么食物", "inventory"),
        ("你现在在哪", "observe_self"),
    ],
)
def test_classify_examples(text: str, expected: str) -> None:
    intent = classify(text)
    assert intent is not None
    assert intent.name == expected


def test_unknown_or_small_talk_returns_none() -> None:
    assert classify("今天天气不错") is None
    assert classify("") is None


def test_question_about_ability_is_not_an_action() -> None:
    assert classify("你会挖矿吗") is None


def test_is_stop() -> None:
    assert is_stop("不用跟着我了")
    assert is_stop("站住")
    assert not is_stop("跟我来")
    assert not is_stop("今天天气不错")


def test_plan_maps_stop_to_stop_skill() -> None:
    result = plan("停下")
    assert result is not None
    assert result.skill_id == "stop"
    assert result.source == "rule"
    assert result.ack_key == "ack.stop"


def test_plan_maps_follow_to_follow_skill() -> None:
    result = plan("跟着我")
    assert result is not None
    assert result.skill_id == "follow_player"
    assert result.confidence >= 0.9


def test_plan_maps_eat_to_eat_skill() -> None:
    result = plan("我有点饿了，吃点东西")
    assert result is not None
    assert result.skill_id == "eat"
    assert result.ack_key == "ack.eat"


def test_plan_parses_collect_arguments() -> None:
    result = plan("挖三块泥土")
    assert result is not None
    assert result.skill_id == "collect_blocks"
    assert result.arguments == {"block": "dirt", "count": 3}
    assert result.ack_key == "ack.collect_blocks#count=3"
    assert result.ack_text == "好，我去挖三块。"
    assert result.dedupe_key == "collect_blocks|block=dirt|count=3"


def test_plan_uses_plain_ack_for_default_count() -> None:
    result = plan("去挖泥土")
    assert result is not None
    assert result.arguments == {"block": "dirt", "count": 1}
    assert result.ack_key == "ack.collect_blocks"
    assert result.ack_text == "好，我去挖。"


def test_plan_ignores_unknown_block() -> None:
    assert plan("挖钻石") is None


def test_plan_rejects_capability_question() -> None:
    assert plan("你会挖矿吗") is None
    assert plan("你会挖泥土吗") is None
    assert plan("能不能跟着你") is None


def test_plan_treats_negated_collect_as_stop() -> None:
    result = plan("别挖了")
    assert result is not None
    assert result.skill_id == "stop"


def test_plan_allows_question_mark_for_observation() -> None:
    result = plan("我在哪？")
    assert result is not None
    assert result.skill_id == "observe"


def test_plan_returns_none_for_small_talk() -> None:
    assert plan("今天天气不错") is None
    assert plan("") is None


def test_plan_does_not_cover_threat_warning() -> None:
    assert plan("小心，附近有苦力怕") is None
