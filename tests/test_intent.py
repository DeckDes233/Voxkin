from __future__ import annotations

import pytest

from voxkin.intent import classify


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
