import numpy as np

from voxkin.stt.vad import VadSegmenter


def tone(seconds: float, frequency: float = 220.0, amplitude: float = 0.2, rate: int = 16000) -> np.ndarray:
    time_axis = np.arange(int(seconds * rate), dtype=np.float32) / rate
    return (amplitude * np.sin(2 * np.pi * frequency * time_axis)).astype(np.float32)


def silence(seconds: float, rate: int = 16000) -> np.ndarray:
    return np.zeros(int(seconds * rate), dtype=np.float32)


def collect(vad: VadSegmenter, audio: np.ndarray, block: int = 512) -> list[np.ndarray]:
    result: list[np.ndarray] = []
    for start in range(0, audio.size, block):
        result.extend(vad.feed(audio[start : start + block]))
    return result


def test_detects_single_utterance():
    vad = VadSegmenter()
    audio = np.concatenate([silence(0.4), tone(1.0), silence(1.0)])
    utterances = collect(vad, audio)
    assert len(utterances) == 1
    assert utterances[0].size / 16000 >= 0.9


def test_silence_only_produces_nothing():
    vad = VadSegmenter()
    assert collect(vad, silence(2.0)) == []
    assert vad.flush() == []


def test_two_utterances_separated_by_pause():
    vad = VadSegmenter()
    audio = np.concatenate([tone(0.8), silence(1.0), tone(0.8), silence(1.0)])
    utterances = collect(vad, audio)
    assert len(utterances) == 2


def test_quiet_noise_does_not_trigger():
    vad = VadSegmenter()
    rng = np.random.default_rng(7)
    noise = (rng.normal(0, 0.001, 16000 * 2)).astype(np.float32)
    assert collect(vad, noise) == []


def test_flush_returns_pending_speech():
    vad = VadSegmenter()
    assert collect(vad, tone(1.0)) == []
    pending = vad.flush()
    assert len(pending) == 1
