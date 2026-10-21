from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any, get_type_hints

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "voxkin.yaml"
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config" / "voxkin.example.yaml"
LOCAL_CONFIG_PATH = PROJECT_ROOT / "config" / "local.yaml"


@dataclass
class LLMConfig:
    provider: str = "openai_compat"
    base_url: str = "https://api.deepseek.com/v1"
    model: str = "deepseek-chat"
    api_key: str = ""
    api_key_env: str = "DEEPSEEK_API_KEY"
    temperature: float = 0.7
    max_tokens: int = 512
    timeout_s: float = 60.0
    stream: bool = True
    headers: dict[str, str] = field(default_factory=dict)
    enable_tools: bool = True

    def resolve_api_key(self) -> str:
        if self.api_key:
            return self.api_key
        return os.environ.get(self.api_key_env, "")


@dataclass
class TTSConfig:
    engine: str = "gpt_sovits"
    character: str = "Theresa"
    base_url: str = "http://127.0.0.1:9880"
    model_dir: str = "models/Theresa"
    genie_data_dir: str = ""
    reference_audio: str = "models/reference/xiaote.wav"
    reference_text: str = ""
    text_lang: str = "zh"
    prompt_lang: str = "zh"
    language: str = "zh"
    sample_rate: int = 32000
    max_chars_per_request: int = 40
    timeout_s: float = 120.0
    manage_service: bool = False
    start_command: list[str] = field(default_factory=list)
    working_dir: str = ""
    health_url: str = "http://127.0.0.1:9880/openapi.json"


@dataclass
class STTConfig:
    engine: str = "faster_whisper"
    model: str = "small"
    device: str = "cpu"
    compute_type: str = "int8"
    language: str = "zh"
    beam_size: int = 1
    vad_threshold: float = 0.5
    vad_min_speech_ms: int = 320
    vad_min_silence_ms: int = 640
    sample_rate: int = 16000
    max_utterance_s: float = 20.0
    to_simplified: bool = True


@dataclass
class AudioConfig:
    output: str = "speaker"
    device: str = ""
    volume: float = 1.0
    minecraft_audio_dir: str = ""
    wav_dir: str = "data/audio_out"
    segment_lead_s: float = 0.05


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8765


@dataclass
class PersonaConfig:
    name: str = "DeepSeek-chan"
    system_prompt: str = ""
    max_history_turns: int = 12


@dataclass
class VoxkinConfig:
    llm: LLMConfig = field(default_factory=LLMConfig)
    tts: TTSConfig = field(default_factory=TTSConfig)
    stt: STTConfig = field(default_factory=STTConfig)
    audio: AudioConfig = field(default_factory=AudioConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    persona: PersonaConfig = field(default_factory=PersonaConfig)

    def validate(self) -> None:
        if self.llm.provider not in {"openai_compat", "scripted"}:
            raise ValueError(f"未知的 LLM provider: {self.llm.provider}")
        if self.tts.engine not in {"genie", "gpt_sovits"}:
            raise ValueError(f"未知的 TTS engine: {self.tts.engine}")
        if self.audio.output not in {"speaker", "wav_dir", "minecraft_file"}:
            raise ValueError(f"未知的音频输出: {self.audio.output}")
        if self.audio.output == "minecraft_file" and not self.audio.minecraft_audio_dir:
            raise ValueError("minecraft_file 输出必须配置 minecraft_audio_dir")
        if self.tts.manage_service and not self.tts.start_command:
            raise ValueError("tts.manage_service 开启时必须配置 tts.start_command")


def _build(cls: type, data: Any) -> Any:
    if data is None:
        return cls()
    if not is_dataclass(cls):
        return data
    hints = get_type_hints(cls)
    kwargs = {}
    for item in fields(cls):
        if item.name in data:
            value = data[item.name]
            item_type = hints.get(item.name, item.type)
            if is_dataclass(item_type):
                kwargs[item.name] = _build(item_type, value)
            else:
                kwargs[item.name] = value
    return cls(**kwargs)


def _merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path: Path | str | None = None, with_local: bool = True) -> VoxkinConfig:
    target = Path(path) if path else DEFAULT_CONFIG_PATH
    data: dict = {}
    if target.exists():
        data = yaml.safe_load(target.read_text(encoding="utf-8")) or {}
    elif path is not None:
        raise FileNotFoundError(f"配置文件不存在: {target}")
    if with_local and LOCAL_CONFIG_PATH.exists():
        local = yaml.safe_load(LOCAL_CONFIG_PATH.read_text(encoding="utf-8")) or {}
        data = _merge(data, local)
    config = _build(VoxkinConfig, data)
    config.validate()
    return config


def save_config(config: VoxkinConfig, path: Path | str | None = None) -> Path:
    target = Path(path) if path else DEFAULT_CONFIG_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "llm": {k: v for k, v in config.llm.__dict__.items() if k not in {"api_key", "headers"}},
        "tts": config.tts.__dict__,
        "stt": config.stt.__dict__,
        "audio": config.audio.__dict__,
        "server": config.server.__dict__,
        "persona": config.persona.__dict__,
    }
    target.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )
    return target
