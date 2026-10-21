from __future__ import annotations

import re
from collections import Counter

# Whisper 在静音、音乐、噪声上常见的模板化输出。匹配前会去掉空格与标点并转小写。
KNOWN_HALLUCINATIONS = (
    "字幕by索兰娅",
    "字幕由索兰娅提供",
    "字幕索兰娅",
    "索兰娅字幕",
    "请不吝点赞订阅转发打赏支持明镜与点点栏目",
    "明镜与点点栏目",
    "字幕由amaraorg社区提供",
    "amaraorg",
    "谢谢观看",
    "感谢观看",
    "谢谢收看",
    "优优独播剧场",
    "yoyotelevision",
    "thanksforwatching",
    "thankyouforwatching",
    "subtitlesby",
    "captionsby",
)

_CJK = re.compile(r"[\u4e00-\u9fff]")
_WORD = re.compile(r"[a-z]+|[\u4e00-\u9fff]")
_SENTENCE = re.compile(r"[。！？!?.]+")
_PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)


def normalize(text: str) -> str:
    return _PUNCT.sub("", text or "").lower()


def is_known_hallucination(text: str) -> bool:
    normalized = normalize(text)
    if not normalized:
        return False
    for phrase in KNOWN_HALLUCINATIONS:
        if phrase in normalized:
            return True
    if len(normalized) >= 6 and ("字幕" in normalized and "索兰娅" in normalized):
        return True
    return False


def _is_looped(text: str) -> bool:
    normalized = normalize(text)
    if len(normalized) >= 12:
        top = Counter(normalized).most_common(1)[0][1]
        if top / len(normalized) >= 0.5:
            return True
    words = _WORD.findall(text or "")
    if len(words) >= 8:
        top = Counter(words).most_common(1)[0][1]
        if top / len(words) >= 0.5:
            return True
    parts = [part.strip() for part in _SENTENCE.split(text or "") if part.strip()]
    if len(parts) >= 3:
        unique = len(set(parts))
        if unique <= max(1, len(parts) // 3):
            return True
    return False


def drop_reason(
    text: str,
    *,
    no_speech_prob: float | None = None,
    avg_logprob: float | None = None,
    compression_ratio: float | None = None,
) -> str:
    """返回丢弃原因；空串表示保留。"""
    if not text or not text.strip():
        return "empty"
    if not _CJK.search(text) and not re.search(r"[a-zA-Z0-9]", text):
        return "punctuation"
    if is_known_hallucination(text):
        return "known_hallucination"
    if _is_looped(text):
        return "looped"
    if compression_ratio is not None and compression_ratio > 2.6:
        return "compression"
    if (
        no_speech_prob is not None
        and avg_logprob is not None
        and no_speech_prob >= 0.6
        and avg_logprob <= -0.8
    ):
        return "no_speech"
    return ""


def filter_text(
    text: str,
    *,
    no_speech_prob: float | None = None,
    avg_logprob: float | None = None,
    compression_ratio: float | None = None,
) -> str:
    if drop_reason(
        text,
        no_speech_prob=no_speech_prob,
        avg_logprob=avg_logprob,
        compression_ratio=compression_ratio,
    ):
        return ""
    return text
