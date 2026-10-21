import pytest

from voxkin.text import SentenceSplitter, SpokenTextFilter


def split_all(text: str, chunk: int = 1, max_chars: int = 36) -> list[str]:
    splitter = SentenceSplitter(max_chars=max_chars)
    result: list[str] = []
    for index in range(0, len(text), chunk):
        result.extend(splitter.feed(text[index : index + chunk]))
    result.extend(splitter.flush())
    return result


def test_split_chinese_sentences():
    assert split_all("你好。今天天气不错！要一起去挖矿吗？") == [
        "你好。",
        "今天天气不错！",
        "要一起去挖矿吗？",
    ]


def test_streaming_and_bulk_are_equal():
    text = "第一句。第二句！第三句？剩下的部分没有标点"
    assert split_all(text, chunk=1) == split_all(text, chunk=len(text))


def test_terminator_keeps_trailing_quote():
    assert split_all("他说：“走吧。”然后转身。") == ["他说：“走吧。”", "然后转身。"]


def test_decimal_point_is_not_sentence_end():
    result = split_all("圆周率是 3.14 左右。")
    assert result == ["圆周率是 3.14 左右。"]


def test_long_sentence_breaks_on_comma():
    text = "这是一个很长的句子，" + "一直" * 20 + "没有句号"
    result = split_all(text, max_chars=20)
    assert len(result) >= 2
    assert all(len(item) <= 40 for item in result)


def test_code_fence_is_removed():
    result = split_all("前面这些要读。```python\nprint('x')\n```后面这些也要读。")
    joined = "".join(result)
    assert "print" not in joined
    assert "前面这些要读。" in joined
    assert "后面这些也要读。" in joined


def test_action_tag_is_removed():
    result = split_all('好的<action>{"tool":"dig","x":1}</action>，我这就去。')
    joined = "".join(result)
    assert "action" not in joined
    assert "tool" not in joined
    assert joined == "好的，我这就去。"


def test_emoji_and_markdown_removed():
    result = split_all("**注意**，前面有僵尸😱！")
    joined = "".join(result)
    assert "**" not in joined
    assert "😱" not in joined
    assert "前面有僵尸！" in joined


def test_empty_and_punctuation_only():
    splitter = SentenceSplitter()
    assert splitter.feed("") == []
    assert splitter.feed("……") == []
    assert splitter.flush() == []


def test_filter_holds_unfinished_fence():
    filt = SpokenTextFilter()
    assert filt.feed("开始```") == "开始"
    assert filt.feed("code") == ""
    assert filt.feed("```结束") == "结束"


def test_splitter_flushes_remainder_without_punctuation():
    splitter = SentenceSplitter()
    assert splitter.feed("没有句号的一句话") == []
    assert splitter.flush() == ["没有句号的一句话"]


def test_english_sentence_boundary():
    assert split_all("Hello world. This is fine!") == ["Hello world.", "This is fine!"]


def test_whitespace_between_deltas_preserved():
    splitter = SentenceSplitter()
    assert splitter.feed("Hello ") == []
    assert splitter.feed("world.") == []
    assert splitter.flush() == ["Hello world."]


def test_trailing_terminator_deferred_until_more_text():
    splitter = SentenceSplitter()
    assert splitter.feed("先等一下。") == []
    assert splitter.feed("马上就好。") == ["先等一下。"]
    assert splitter.flush() == ["马上就好。"]
