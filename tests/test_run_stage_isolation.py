from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_stage.py"
SPEC = importlib.util.spec_from_file_location("voxkin_run_stage", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
run_stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_stage)


def make_server(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "paper.jar").write_bytes(b"paper")
    (path / "server.properties").write_text(
        "server-port=25566\nrcon.port=25576\nrcon.password=old\n", encoding="utf-8"
    )
    return path


def test_isolated_paths_refuse_protected_targets(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    source = make_server(tmp_path / "source")
    (tmp_path / "work/mc/eval_server").mkdir(parents=True)
    with pytest.raises(SystemExit, match="受保护"):
        run_stage.validate_isolated_paths(source, tmp_path / "work/mc/eval_server/copy")


def test_isolated_paths_require_new_target_under_mc_root(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    source = make_server(tmp_path / "source")
    with pytest.raises(SystemExit, match="work/mc"):
        run_stage.validate_isolated_paths(source, tmp_path / "outside")
    target = tmp_path / "work/mc/isolated"
    target.mkdir(parents=True)
    with pytest.raises(SystemExit, match="已存在"):
        run_stage.validate_isolated_paths(source, target)


def test_prepare_isolated_copies_server_and_sanitizes_runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    monkeypatch.setattr(run_stage, "port_open", lambda *_args, **_kwargs: False)
    source = make_server(tmp_path / "work/mc/eval_server")
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "voxkin.yaml").write_text(
        "llm:\n  api_key: leaked\n  headers:\n    x-secret: value\n"
        "memory:\n  enabled: true\nserver:\n  port: 8765\n", encoding="utf-8"
    )
    args = argparse.Namespace(
        isolate_from=str(source), isolate_target="work/mc/s2_isolated",
        isolate_port=25666, isolate_rcon_port=25676, isolate_studio_port=8766,
        host="127.0.0.1", rcon_password="voxkin",
    )
    run_stage.prepare_isolated(args)
    target = tmp_path / "work/mc/s2_isolated"
    assert (target / "paper.jar").read_bytes() == b"paper"
    assert (source / "server.properties").read_text(encoding="utf-8").endswith("rcon.password=old\n")
    properties = (target / "server.properties").read_text(encoding="utf-8")
    assert "server-port=25666" in properties
    assert "rcon.port=25676" in properties
    assert "rcon.password=old" not in properties
    config = (target / ".voxkin-studio/voxkin.yaml").read_text(encoding="utf-8")
    assert "leaked" not in config
    assert "x-secret" not in config
    assert "enabled: false" in config
    assert "output: wav_dir" in config
    assert str(target / ".voxkin-studio" / "audio_out") in config
    assert args.port == 25666
    assert args.rcon_port == 25676
    assert args.studio == "http://127.0.0.1:8766"


def test_chain_survival_uses_ordered_stages():
    assert run_stage.stages_for(argparse.Namespace(stage="S2", chain_survival=True)) == (
        "S0", "S1", "S2", "M3_SHELTER", "M3_SLEEP", "M3_SLEEP", "M3_SLEEP", "M3_EXIT"
    )
    assert run_stage.stages_for(argparse.Namespace(stage="S2", chain_survival=False)) == ("S2",)


def test_full_progression_runs_s0_through_s6_without_world_resets():
    args = argparse.Namespace(stage="S4", chain_s0_s6=True, chain_survival=False)

    assert run_stage.stages_for(args) == ("S0", "S1", "S2", "S3", "S4", "S5", "S6")


def test_isolated_run_preserves_requested_stage_unless_chain_is_explicit():
    single = argparse.Namespace(runs=10, stage_timeout=900, chain_survival=False)
    run_stage.configure_isolated_run(single)
    assert single.runs == 1
    assert single.stage_timeout == 900
    assert run_stage.stages_for(argparse.Namespace(stage="S0", chain_survival=False)) == ("S0",)

    chain = argparse.Namespace(runs=10, stage_timeout=900, chain_survival=True)
    run_stage.configure_isolated_run(chain)
    assert chain.runs == 1
    assert chain.stage_timeout == 2700

    progression = argparse.Namespace(
        runs=10, stage_timeout=900, chain_survival=False, chain_s0_s6=True
    )
    run_stage.configure_isolated_run(progression)
    assert progression.runs == 1
    assert progression.stage_timeout == 3600


def test_isolated_studio_environment_does_not_inherit_api_keys():
    env = run_stage.isolated_studio_environment({
        "DEEPSEEK_API_KEY": "secret",
        "OPENAI_API_KEY": "also-secret",
        "PATH": "tools",
    })
    assert env == {"PATH": "tools", "PYTHONUTF8": "1"}


def test_isolated_reset_refuses_protected_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    protected = tmp_path / "work/mc/eval_server"
    protected.mkdir(parents=True)
    with pytest.raises(SystemExit, match="拒绝重置"):
        run_stage.reset_world(protected, isolated=True)
