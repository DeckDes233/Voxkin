from __future__ import annotations

import re

TERMINATORS = set("。！？!?…；;")
SOFT_BREAKS = set("，,、")
CLOSERS = set("”’」』）)】]》\"'")
EMOJI_PATTERN = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf\U0001f000-\U0001f2ff\ufe0f\u200d]"
)
INLINE_CODE_PATTERN = re.compile(r"`[^`]*`")


class SpokenTextFilter:
    """把模型增量文本转换为可朗读文本，剔除工具调用、代码块与格式符号。"""

    MARKERS = ("```", "<action>")

    def __init__(self) -> None:
        self._buffer = ""
        self._in_fence = False
        self._in_action = False

    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        self._buffer += delta
        return self._drain(final=False)

    def flush(self) -> str:
        return self._drain(final=True)

    def _drain(self, final: bool) -> str:
        text = self._buffer
        out: list[str] = []
        index = 0
        length = len(text)
        while index < length:
            if self._in_fence:
                end = text.find("```", index)
                if end < 0:
                    self._buffer = text[index:]
                    return "".join(out)
                self._in_fence = False
                index = end + 3
                continue
            if self._in_action:
                end = text.find("</action>", index)
                if end < 0:
                    self._buffer = text[index:]
                    return "".join(out)
                self._in_action = False
                index = end + len("</action>")
                continue
            fence = text.find("```", index)
            action = text.find("<action>", index)
            candidates = [pos for pos in (fence, action) if pos >= 0]
            if candidates:
                cut = min(candidates)
                out.append(text[index:cut])
                if cut == fence:
                    self._in_fence = True
                    index = cut + 3
                else:
                    self._in_action = True
                    index = cut + len("<action>")
                continue
            out.append(text[index:])
            index = length
        result = "".join(out)
        self._buffer = ""
        if final:
            self._in_fence = False
            self._in_action = False
            return result
        hold = self._held_tail(result)
        if hold:
            self._buffer = result[-hold:]
            result = result[:-hold]
        return result

    def _held_tail(self, text: str) -> int:
        limit = min(len(text), max(len(marker) for marker in self.MARKERS) - 1)
        for size in range(limit, 0, -1):
            suffix = text[-size:]
            if any(marker.startswith(suffix) for marker in self.MARKERS):
                return size
        return 0


class SpokenTextNormalizer:
    def __init__(self) -> None:
        self._strip_patterns = (
            INLINE_CODE_PATTERN,
            re.compile(r"\*\*|__"),
        )

    def normalize(self, text: str) -> str:
        result = text
        for pattern in self._strip_patterns:
            result = pattern.sub("", result)
        result = EMOJI_PATTERN.sub("", result)
        result = result.replace("*", "").replace("#", "")
        result = result.replace("\r", " ").replace("\n", " ")
        result = re.sub(r"[ \t]+", " ", result)
        return result


class SentenceSplitter:
    """按标点切分增量文本，保证首句尽快可用。"""

    def __init__(self, max_chars: int = 36, min_chars: int = 2) -> None:
        self.max_chars = max_chars
        self.min_chars = min_chars
        self._buffer = ""
        self._filter = SpokenTextFilter()
        self._normalizer = SpokenTextNormalizer()

    def feed(self, delta: str) -> list[str]:
        cleaned = self._normalizer.normalize(self._filter.feed(delta))
        if cleaned:
            self._buffer += cleaned
        return self._extract(final=False)

    def flush(self) -> list[str]:
        cleaned = self._normalizer.normalize(self._filter.flush())
        if cleaned:
            self._buffer += cleaned
        sentences = self._extract(final=True)
        remainder = self._buffer.strip()
        self._buffer = ""
        if remainder and self._is_speakable(remainder):
            sentences.append(remainder)
        return sentences

    def _extract(self, final: bool) -> list[str]:
        sentences: list[str] = []
        while True:
            cut = self._find_terminator(self._buffer)
            if cut is None:
                break
            if not final and cut >= len(self._buffer):
                break
            chunk = self._buffer[:cut]
            self._buffer = self._buffer[cut:]
            chunk = chunk.strip()
            if self._is_speakable(chunk):
                sentences.append(chunk)
        while len(self._buffer) > self.max_chars:
            cut = self._find_soft_break(self._buffer)
            chunk = self._buffer[:cut]
            self._buffer = self._buffer[cut:]
            chunk = chunk.strip()
            if self._is_speakable(chunk):
                sentences.append(chunk)
        return sentences

    def _find_terminator(self, text: str) -> int | None:
        index = 0
        length = len(text)
        while index < length:
            char = text[index]
            if char in TERMINATORS:
                end = index + 1
                while end < length and text[end] in TERMINATORS:
                    end += 1
                while end < length and text[end] in CLOSERS:
                    end += 1
                return end
            if char == ".":
                previous = text[index - 1] if index > 0 else ""
                following = text[index + 1] if index + 1 < length else ""
                if not previous.isdigit() and not following.isdigit():
                    if following == "" or following.isspace() or following in CLOSERS:
                        return index + 1
            if char == "\n":
                return index + 1
            index += 1
        return None

    def _find_soft_break(self, text: str) -> int:
        window_start = max(self.min_chars, int(self.max_chars * 0.5))
        for index in range(self.max_chars, window_start - 1, -1):
            if index - 1 < len(text) and text[index - 1] in SOFT_BREAKS:
                return index
        return self.max_chars

    def _is_speakable(self, text: str) -> bool:
        stripped = text.strip()
        if len(stripped) < self.min_chars:
            return False
        return any(char.isalnum() for char in stripped)
