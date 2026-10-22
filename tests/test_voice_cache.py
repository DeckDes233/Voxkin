from __future__ import annotations

import json

import numpy as np

from voxkin.voice.cache import SpeechCache, trim_silence


def tone(frames: int = 3200, value: int = 1200) -> np.ndarray:
    return np.full(frames, value, dtype=np.int16)


async def build_cache(tmp_path, voice_id: str = "test-voice", **kwargs) -> SpeechCache:
    cache = SpeechCache(tmp_path / "voice_cache", voice_id, **kwargs)
    await cache.put(
        "ack.collect_blocks",
        "好，我去挖。",
        [tone()],
        sample_rate=32000,
        engine="tone",
    )
    return cache


async def test_put_then_lookup_hits(tmp_path) -> None:
    cache = await build_cache(tmp_path)
    clip = cache.lookup("ack.collect_blocks")
    assert clip is not None
    assert clip.text == "好，我去挖。"
    assert clip.pcm.size == 3200
    assert clip.sample_rate == 32000
    assert cache.describe()["hits"] == 1


async def test_cache_survives_reload(tmp_path) -> None:
    cache = await build_cache(tmp_path)
    reloaded = SpeechCache(tmp_path / "voice_cache", "test-voice")
    await reloaded.load()
    assert reloaded.count == 1
    assert reloaded.lookup("ack.collect_blocks") is not None


async def test_unknown_key_is_a_miss(tmp_path) -> None:
    cache = await build_cache(tmp_path)
    clip, reason = cache.lookup_with_reason("ack.unknown")
    assert clip is None
    assert reason == "not_cached"
    assert cache.describe()["misses"] == 1


async def test_corrupted_audio_is_a_miss(tmp_path) -> None:
    cache = await build_cache(tmp_path)
    audio = tmp_path / "voice_cache" / "test-voice" / "ack.collect_blocks.wav"
    audio.write_bytes(b"not a wav file")
    reloaded = SpeechCache(tmp_path / "voice_cache", "test-voice")
    await reloaded.load()
    assert reloaded.count == 0
    assert reloaded.describe()["miss_reasons"].get("hash_mismatch") == 1


async def test_missing_sidecar_is_a_miss(tmp_path) -> None:
    cache = await build_cache(tmp_path)
    sidecar = tmp_path / "voice_cache" / "test-voice" / "ack.collect_blocks.json"
    sidecar.unlink()
    reloaded = SpeechCache(tmp_path / "voice_cache", "test-voice")
    await reloaded.load()
    assert reloaded.count == 0
    assert reloaded.describe()["miss_reasons"].get("missing_sidecar") == 1


async def test_voice_mismatch_is_a_miss(tmp_path) -> None:
    cache = await build_cache(tmp_path)
    sidecar_path = tmp_path / "voice_cache" / "test-voice" / "ack.collect_blocks.json"
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sidecar["voice_id"] = "other-voice"
    sidecar_path.write_text(json.dumps(sidecar, ensure_ascii=False), encoding="utf-8")
    reloaded = SpeechCache(tmp_path / "voice_cache", "test-voice")
    await reloaded.load()
    assert reloaded.count == 0
    assert reloaded.describe()["miss_reasons"].get("voice_mismatch") == 1


async def test_engine_mismatch_is_a_miss(tmp_path) -> None:
    await build_cache(tmp_path)
    picky = SpeechCache(tmp_path / "voice_cache", "test-voice", expected_engine="gpt_sovits")
    await picky.load()
    assert picky.count == 0
    assert picky.describe()["miss_reasons"].get("engine_mismatch") == 1


async def test_reference_mismatch_is_a_miss(tmp_path) -> None:
    await build_cache(tmp_path)
    picky = SpeechCache(
        tmp_path / "voice_cache", "test-voice", expected_reference_sha256="deadbeef"
    )
    await picky.load()
    assert picky.count == 0
    assert picky.describe()["miss_reasons"].get("reference_mismatch") == 1


async def test_sidecar_records_generation_inputs(tmp_path) -> None:
    await build_cache(tmp_path)
    sidecar = json.loads(
        (tmp_path / "voice_cache" / "test-voice" / "ack.collect_blocks.json").read_text(
            encoding="utf-8"
        )
    )
    assert sidecar["voice_id"] == "test-voice"
    assert sidecar["engine"] == "tone"
    assert sidecar["sha256"]
    assert sidecar["sample_rate"] == 32000
    assert sidecar["text"] == "好，我去挖。"


def test_trim_silence_removes_leading_and_trailing_quiet() -> None:
    pcm = np.concatenate(
        [
            np.zeros(1000, dtype=np.int16),
            np.full(2000, 1500, dtype=np.int16),
            np.zeros(1000, dtype=np.int16),
        ]
    )
    trimmed = trim_silence(pcm)
    assert trimmed.size == 2000
    assert int(trimmed[0]) == 1500
