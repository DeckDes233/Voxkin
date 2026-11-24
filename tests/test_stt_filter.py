from __future__ import annotations

import pytest

from voxkin.stt.filter import drop_reason, filter_text


@pytest.mark.parametrize(
    "text",
    [
        "字幕by索兰娅",
        "字幕由索兰娅提供",
        "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
        "明镜与点点栏目",
        "字幕由Amara.org社区提供",
        "Thanks for watching!",
        "Subtitles by the Amara.org community",
        "优优独播剧场",
    ],
)
def test_known_hallucinations_are_dropped(text: str) -> None:
    assert drop_reason(text)
    assert filter_text(text) == ""


def test_normal_sentence_passes() -> None:
    assert filter_text("沃心，跟我来") == "沃心，跟我来"
    assert filter_text("帮我挖两块泥土。") == "帮我挖两块泥土。"


def test_short_reply_passes() -> None:
    assert filter_text("好") == "好"
    assert filter_text("谢谢") == "谢谢"


def test_repeated_english_is_dropped() -> None:
    assert filter_text("I love you! " * 6) == ""


def test_repeated_chinese_is_dropped() -> None:
    assert filter_text("爱你" * 8) == ""


def test_short_repeated_period_is_dropped() -> None:
    assert filter_text("维持维持维持") == ""
    assert filter_text("维持。维持。维持。") == ""


def test_two_repetitions_are_kept() -> None:
    assert filter_text("谢谢谢谢") == "谢谢谢谢"


def test_low_information_noise_is_dropped() -> None:
    assert filter_text("啊啊啊啊啊啊啊啊啊啊") == ""


def test_empty_and_punctuation_are_dropped() -> None:
    assert filter_text("") == ""
    assert filter_text("   ") == ""
    assert filter_text("...") == ""


def test_no_speech_metadata_drops() -> None:
    assert filter_text("嗯", no_speech_prob=0.9, avg_logprob=-1.2) == ""


def test_high_compression_drops() -> None:
    assert filter_text("正常的一句话", compression_ratio=3.0) == ""


def test_metadata_with_clear_speech_keeps() -> None:
    assert filter_text("沃心", no_speech_prob=0.2, avg_logprob=-0.3) == "沃心"
