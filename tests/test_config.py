from pathlib import Path

import pytest
import yaml

from voxkin.config import VoxkinConfig, load_config, save_config


def write_yaml(path: Path, payload: dict) -> Path:
    path.write_text(yaml.safe_dump(payload, allow_unicode=True), encoding="utf-8")
    return path


def test_defaults_are_complete():
    config = load_config(None, with_local=False)
    assert isinstance(config, VoxkinConfig)
    assert config.server.host == "127.0.0.1"
    assert config.tts.sample_rate == 32000
    assert config.stt.sample_rate == 16000


def test_partial_override_keeps_defaults(tmp_path):
    path = write_yaml(
        tmp_path / "voxkin.yaml",
        {"llm": {"model": "deepseek-reasoner"}, "audio": {"output": "wav_dir"}},
    )
    config = load_config(path, with_local=False)
    assert config.llm.model == "deepseek-reasoner"
    assert config.llm.base_url == "https://api.deepseek.com/v1"
    assert config.audio.output == "wav_dir"


def test_invalid_engine_is_rejected(tmp_path):
    path = write_yaml(tmp_path / "voxkin.yaml", {"tts": {"engine": "unknown"}})
    with pytest.raises(ValueError):
        load_config(path, with_local=False)


def test_minecraft_output_requires_directory(tmp_path):
    path = write_yaml(tmp_path / "voxkin.yaml", {"audio": {"output": "minecraft_file"}})
    with pytest.raises(ValueError):
        load_config(path, with_local=False)


def test_save_strips_api_key(tmp_path):
    config = load_config(None, with_local=False)
    config.llm.api_key = "secret-value"
    target = save_config(config, tmp_path / "saved.yaml")
    assert "secret-value" not in target.read_text(encoding="utf-8")
    assert "api_key_env" in target.read_text(encoding="utf-8")
