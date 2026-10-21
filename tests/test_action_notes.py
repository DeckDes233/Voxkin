from __future__ import annotations

from pathlib import Path

from support import ToneTTS
from voxkin.audio.sinks import build_sink
from voxkin.config import VoxkinConfig
from voxkin.events import MetricsStore
from voxkin.pipeline import ConversationPipeline


def make_pipeline(tmp_path: Path) -> ConversationPipeline:
    config = VoxkinConfig()
    config.persona.system_prompt = "你是一个简洁的中文伙伴。"
    return ConversationPipeline(
        config=config,
        llm=object(),
        tts=ToneTTS(),
        sink=build_sink("wav_dir", directory=str(tmp_path)),
        metrics=MetricsStore(),
    )


def test_action_notes_are_injected_once(tmp_path: Path) -> None:
    pipeline = make_pipeline(tmp_path)
    pipeline._action_notes.append("collect_blocks 失败：附近 32 格内没有橡木")

    messages = pipeline._build_messages("继续")
    notes = [m for m in messages if m["role"] == "system" and "[最近动作]" in m["content"]]
    assert len(notes) == 1
    assert "附近 32 格内没有橡木" in notes[0]["content"]
    assert not pipeline._action_notes

    second = pipeline._build_messages("再试一次")
    assert not [m for m in second if "[最近动作]" in m["content"]]


def test_action_notes_are_capped(tmp_path: Path) -> None:
    pipeline = make_pipeline(tmp_path)
    for index in range(8):
        pipeline._action_notes.append(f"tool{index} 完成：ok")
    messages = pipeline._build_messages("继续")
    note = next(m for m in messages if "[最近动作]" in m["content"])
    assert "tool7" in note["content"]
    assert "tool0" not in note["content"]
