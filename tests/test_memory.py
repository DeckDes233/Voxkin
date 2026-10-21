import asyncio
from pathlib import Path

import pytest

from voxkin.config import MemoryConfig
from voxkin.memory import (
    ContextBuilder,
    MemoryStore,
    MemoryWriter,
    estimate_tokens,
    extract_keywords,
)


class StubLLM:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls = 0

    async def stream_chat(self, messages, tools=None):
        from voxkin.llm.base import LLMDelta

        self.calls += 1
        for index in range(0, len(self.reply), 4):
            yield LLMDelta(kind="text", text=self.reply[index : index + 4])
        yield LLMDelta(kind="done")


def make_store(tmp_path: Path, **overrides) -> MemoryStore:
    config = MemoryConfig(db_path=str(tmp_path / "memory.db"), session_id="test")
    for key, value in overrides.items():
        setattr(config, key, value)
    store = MemoryStore(config)
    store.initialize()
    return store


def test_turns_persist_across_reopen(tmp_path):
    store = make_store(tmp_path)
    store.add_turn("r1", "user", "我们去挖矿")
    store.add_turn("r1", "assistant", "好，我带路")
    store.close()

    reopened = make_store(tmp_path)
    turns = reopened.recent_turns()
    reopened.close()
    assert [turn["role"] for turn in turns] == ["user", "assistant"]
    assert turns[0]["content"] == "我们去挖矿"


def test_keyword_extraction_keeps_bigrams():
    keywords = extract_keywords("我们去挖铁矿，然后回家")
    assert "铁矿" in keywords
    assert "挖铁" in keywords


def test_search_returns_relevant_memory(tmp_path):
    store = make_store(tmp_path)
    store.add_memory("summary", "玩家在矿洞丢失了钻石镐，后来找回来了")
    store.add_memory("summary", "玩家喜欢在河边建房子")
    results = store.search("我的钻石镐在哪")
    store.close()
    assert results
    assert "钻石镐" in results[0].content


def test_context_builder_includes_memory_and_budget(tmp_path):
    store = make_store(tmp_path, context_token_budget=40, recent_turns=10)
    store.add_memory("summary", "玩家把基地建在河边，门口有箱子")
    for index in range(10):
        store.add_turn(f"r{index}", "user", f"第 {index} 句话，内容比较长需要占预算" * 2)
    builder = ContextBuilder(store, store.config, "你是沃心")
    messages = builder.build("河边基地的箱子在哪")
    store.close()
    assert messages[0]["role"] == "system"
    assert "河边" in messages[0]["content"]
    assert messages[-1]["content"] == "河边基地的箱子在哪"
    total = sum(estimate_tokens(message["content"]) for message in messages)
    assert total < 160


async def test_memory_writer_summarizes_and_marks(tmp_path):
    store = make_store(tmp_path, summarize_threshold=3)
    for index in range(3):
        store.add_turn(f"r{index}", "user", f"消息 {index}")
    llm = StubLLM("玩家想挖矿并回基地")
    writer = MemoryWriter(store, llm, store.config)
    summary = await writer.maybe_summarize()
    assert summary == "玩家想挖矿并回基地"
    assert store.unsummarized_turns() == []
    assert store.search("挖矿")[0].content == "玩家想挖矿并回基地"
    store.close()


async def test_memory_writer_waits_for_threshold(tmp_path):
    store = make_store(tmp_path, summarize_threshold=4)
    store.add_turn("r1", "user", "一句话")
    writer = MemoryWriter(store, StubLLM("x"), store.config)
    assert await writer.maybe_summarize() is None
    store.close()


def test_estimate_tokens_grows_with_length():
    assert estimate_tokens("你好") < estimate_tokens("你好，今天天气不错，我们出门吧")
    assert estimate_tokens("") == 0
