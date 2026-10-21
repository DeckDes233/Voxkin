from __future__ import annotations

from opencc import OpenCC

_CONVERTER = OpenCC("t2s")


def to_simplified(text: str) -> str:
    if not text:
        return text
    return _CONVERTER.convert(text)
