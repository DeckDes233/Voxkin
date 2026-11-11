from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_stage.py"
SPEC = importlib.util.spec_from_file_location("voxkin_run_stage", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
run_stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_stage)


def test_bridge_entry_requires_isolation_and_work_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    entry = tmp_path / "other.js"
    entry.write_text("", encoding="utf-8")
    parser = run_stage.build_parser()
    args = parser.parse_args(["--bridge-entry", str(entry)])
    monkeypatch.setattr(run_stage, "build_parser", lambda: argparse.ArgumentParser())
    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", lambda self: args)
    with pytest.raises(SystemExit, match="只允许隔离评测"):
        run_stage.main()
    args.isolate_from, args.isolate_target = "source", "target"
    with pytest.raises(SystemExit, match="work/"):
        run_stage.main()
    assert run_stage.bridge_command(args)[-1] == str(entry)


def make_server(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "paper.jar").write_bytes(b"paper")
    (path / "server.properties").write_text(
        "server-port=25566\nrcon.port=25576\nrcon.password=old\n", encoding="utf-8"
    )
    return path


def goal_status(
    state: str,
    *,
    running: bool = False,
    recovery_reason: str = "",
    pending_status: str = "",
    used: int = 2,
    limit: int = 48,
    deadline_at: float = 4_000_000_000.0,
    result: dict | None = None,
) -> dict:
    pending = None
    if pending_status:
        pending = {"action_id": "action-1", "tool": "craft_bed", "status": pending_status}
    return {
        "running": running,
        "task_id": 7,
        "stage_complete": False,
        "result": result,
        "action_budget": {"used": used, "limit": limit, "deadline_at": deadline_at},
        "goal": {
            "schema_version": 2,
            "goal_id": "stage:s2",
            "status": state,
            "block_reason": "",
            "recovery": {"reason": recovery_reason, "needs_reconcile": state != "done"},
            "pending_action": pending,
            "method_index": 3,
        },
    }


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


def test_bridge_cli_supports_repeatable_node_args_and_opt_in_restart_budget():
    defaults = run_stage.build_parser().parse_args([])
    assert defaults.bridge_restarts == 0
    assert defaults.node_args == []

    args = run_stage.build_parser().parse_args([
        "--node", "node-custom",
        "--node-arg=--jitless",
        "--node-arg=--trace-gc",
        "--bridge-restarts", "2",
    ])
    assert args.bridge_restarts == 2
    assert run_stage.bridge_command(args) == [
        "node-custom", "--jitless", "--trace-gc", "bridge/minecraft_bridge.js",
    ]


def test_full_progression_runs_s0_through_s6_without_world_resets():
    args = argparse.Namespace(stage="S4", chain_s0_s6=True, chain_survival=False)

    assert run_stage.stages_for(args) == ("S0", "S1", "S2", "S3", "S4", "S5", "S6")


def test_s0_through_s4_chain_stops_at_diamond_stage():
    args = argparse.Namespace(
        stage="S4", chain_s0_s4=True, chain_s0_s6=False, chain_survival=False
    )

    assert run_stage.stages_for(args) == ("S0", "S1", "S2", "S3", "S4")
    assert run_stage.configure_isolated_run(args) is None


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


def test_stage_poll_preserves_disconnect_recovery_and_completion(monkeypatch):
    statuses = iter([
        goal_status("disconnected", recovery_reason="bridge_disconnected", pending_status="unknown"),
        goal_status("recovering", recovery_reason="bridge_disconnected", pending_status="unknown"),
        goal_status("active", running=True, recovery_reason="bridge_disconnected", pending_status="unknown"),
        goal_status("waiting", recovery_reason="bridge_action_still_active", pending_status="running"),
        goal_status("done", result={"ok": True, "status": "done", "method_index": 5}),
    ])
    calls = []

    def fake_http_json(url, payload=None, timeout=10.0):
        calls.append((url, payload))
        return next(statuses)

    monkeypatch.setattr(run_stage, "http_json", fake_http_json)
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": False, "ready": False})
    monkeypatch.setattr(run_stage.time, "sleep", lambda _seconds: None)
    args = argparse.Namespace(studio="http://127.0.0.1:8766", poll_interval_s=0)

    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)

    assert result == {"ok": True, "status": "done", "method_index": 5}
    assert final["goal"]["status"] == "done"
    assert [entry["event"] for entry in history] == [
        "worker_interrupted", "worker_interrupted", "worker_resumed",
        "worker_interrupted", "goal_completed_after_recovery",
    ]
    assert [entry["goal_status"] for entry in history if entry["event"] == "worker_interrupted"] == [
        "disconnected", "recovering", "waiting",
    ]
    assert all(entry["task_id"] == 7 and entry["goal_id"] == "stage:s2" for entry in history)
    assert len(calls) == 5


def test_stage_poll_stops_at_terminal_goal_and_budget_exhaustion(monkeypatch):
    statuses = iter([
        goal_status("blocked", result={"ok": False, "status": "blocked", "detail": "unknown_action"}),
    ])
    monkeypatch.setattr(run_stage, "http_json", lambda *_args, **_kwargs: next(statuses))
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: pytest.fail("terminal goal must not poll bridge"))
    monkeypatch.setattr(run_stage.time, "sleep", lambda _seconds: pytest.fail("terminal goal must not wait"))
    args = argparse.Namespace(studio="http://127.0.0.1:8766", poll_interval_s=0)

    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)

    assert result["status"] == "blocked"
    assert final["goal"]["status"] == "blocked"
    assert history == []

    budget = goal_status("active", used=48, limit=48)
    monkeypatch.setattr(run_stage, "http_json", lambda *_args, **_kwargs: budget)
    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)
    assert result["status"] == "blocked"
    assert result["detail"] == "目标动作预算耗尽"
    assert final is budget
    assert history == []


def test_stage_poll_keeps_legacy_taskrunner_result_contract(monkeypatch):
    legacy = {"running": False, "result": {"ok": False, "status": "dead", "cursor": 2, "detail": "legacy death"}}
    monkeypatch.setattr(run_stage, "http_json", lambda *_args, **_kwargs: legacy)
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: pytest.fail("legacy result must not use goal recovery"))
    args = argparse.Namespace(studio="http://127.0.0.1:8766", poll_interval_s=0)

    result, history, final = run_stage.wait_for_stage_result(args, "legacy", timeout_s=10)

    assert result == legacy["result"]
    assert final is legacy
    assert history == []


def test_bridge_exit_after_disconnect_does_not_forge_user_stop(monkeypatch):
    status = goal_status("disconnected", pending_status="disconnected")
    calls = []
    def http(url, *args, **kwargs):
        calls.append(url)
        assert url.endswith("/api/run/status")
        return status
    monkeypatch.setattr(run_stage, "http_json", http)
    monkeypatch.setattr(run_stage, "restart_exited_owned_bridge", lambda *_args: False)
    args = argparse.Namespace(
        studio="http://127.0.0.1:8766", poll_interval_s=0,
        _bridge_restart_blocked={"decision": "native_exit_no_retry", "exitcode": 0xC0000005},
    )
    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)
    assert result["status"] == "blocked"
    assert final["goal"]["status"] == "disconnected"
    assert final["goal"]["pending_action"]["status"] == "disconnected"
    assert not getattr(args, "_stage_stop_requested", False)
    assert calls == ["http://127.0.0.1:8766/api/run/status"]


def test_goal_budget_deadline_is_respected_but_done_wins(monkeypatch):
    expired = goal_status("active", deadline_at=1.0)
    exhausted, reason = run_stage.goal_budget_exhausted(expired, now=2.0)
    assert exhausted is True
    assert reason == "目标执行时长预算耗尽"

    completed = goal_status("done", used=48, limit=48, deadline_at=1.0,
                            result={"ok": True, "status": "done"})
    monkeypatch.setattr(run_stage, "http_json", lambda *_args, **_kwargs: completed)
    args = argparse.Namespace(studio="http://127.0.0.1:8766", poll_interval_s=0)
    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)
    assert result["ok"] is True
    assert final is completed
    assert history == []


class FakeProcess:
    def __init__(self, pid: int, exitcode: int | None = None):
        self.pid = pid
        self.exitcode = exitcode
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.exitcode

    def terminate(self):
        self.terminated = True
        self.exitcode = 0

    def wait(self, timeout=None):
        return self.exitcode

    def kill(self):
        self.killed = True
        self.exitcode = -9


class PollFailureProcess(FakeProcess):
    def poll(self):
        raise RuntimeError("poll failed")


class TerminateFailureProcess(FakeProcess):
    def terminate(self):
        raise RuntimeError("terminate failed")


@pytest.mark.parametrize(
    ("failing_process_type", "expected_message"),
    [
        (PollFailureProcess, "poll failed"),
        (TerminateFailureProcess, "terminate failed"),
    ],
)
def test_owned_bridge_cleanup_continues_after_one_process_raises(
    failing_process_type, expected_message
):
    later_owned = FakeProcess(2)
    failing = failing_process_type(1)
    external = FakeProcess(99)
    args = argparse.Namespace(
        _bridge_process=external,
        _owned_bridge_processes=[later_owned, failing],
    )

    errors = run_stage.stop_owned_bridge_processes(args)

    assert later_owned.terminated is True
    assert external.terminated is False
    assert len(errors) == 1
    assert errors[0]["resource"] == "Bridge pid=1"
    assert errors[0]["message"] == expected_message


def main_test_args(output: Path) -> argparse.Namespace:
    return argparse.Namespace(
        chain_s0_s6=False,
        chain_s0_s4=False,
        chain_survival=False,
        bridge_restarts=0,
        isolate_from=None,
        isolate_target=None,
        isolated_mode=True,
        runs=1,
        stage="S3",
        difficulty="peaceful",
        node="node-test",
        node_args=[],
        output=output,
        isolated_studio_dir=output.parent,
        _isolated_server_process=FakeProcess(30),
    )


def test_main_reports_cleanup_errors_and_still_stops_studio_and_other_owned_processes(
    tmp_path, monkeypatch
):
    output = tmp_path / "summary.json"
    args = main_test_args(output)
    bridge_after_failure = FakeProcess(2)
    failing_bridge = PollFailureProcess(1)
    external = FakeProcess(99)
    args._owned_bridge_processes = [bridge_after_failure, failing_bridge]
    studio = FakeProcess(3)
    server_stops = []

    class Parser:
        def parse_args(self):
            return args

    def stop_server(_args):
        server_stops.append(True)
        raise OSError("Paper stop failed")

    monkeypatch.setattr(run_stage, "build_parser", lambda: Parser())
    monkeypatch.setattr(run_stage, "ensure_studio", lambda _args: studio)
    monkeypatch.setattr(run_stage, "ensure_bridge", lambda _args: bridge_after_failure)
    monkeypatch.setattr(run_stage, "run_once", lambda _args, _index: {"ok": True, "duration_s": 1.0})
    monkeypatch.setattr(run_stage, "stop_server", stop_server)
    monkeypatch.setattr(run_stage, "node_version", lambda _node: "v24.test")

    result = run_stage.main()

    assert result == 1
    assert server_stops == [True]
    assert bridge_after_failure.terminated is True
    assert studio.terminated is True
    assert external.terminated is False
    summary = json.loads(output.read_text(encoding="utf-8"))
    assert [item["resource"] for item in summary["cleanup_errors"]] == [
        "Paper server",
        "Bridge pid=1",
    ]


def test_main_preserves_execution_error_while_attempting_all_owned_cleanup(
    tmp_path, monkeypatch, capsys
):
    args = main_test_args(tmp_path / "summary.json")
    bridge_after_failure = FakeProcess(2)
    failing_bridge = TerminateFailureProcess(1)
    external = FakeProcess(99)
    args._owned_bridge_processes = [bridge_after_failure, failing_bridge]
    studio = FakeProcess(3)
    server_stops = []

    class Parser:
        def parse_args(self):
            return args

    def stop_server(_args):
        server_stops.append(True)
        raise OSError("Paper stop failed")

    def fail_run(_args, _index):
        raise ValueError("original execution failure")

    monkeypatch.setattr(run_stage, "build_parser", lambda: Parser())
    monkeypatch.setattr(run_stage, "ensure_studio", lambda _args: studio)
    monkeypatch.setattr(run_stage, "ensure_bridge", lambda _args: bridge_after_failure)
    monkeypatch.setattr(run_stage, "run_once", fail_run)
    monkeypatch.setattr(run_stage, "stop_server", stop_server)

    with pytest.raises(ValueError, match="original execution failure") as captured:
        run_stage.main()

    assert server_stops == [True]
    assert bridge_after_failure.terminated is True
    assert studio.terminated is True
    assert external.terminated is False
    assert [item["resource"] for item in captured.value.cleanup_errors] == [
        "Paper server",
        "Bridge pid=1",
    ]
    assert "Paper server" in capsys.readouterr().err


def restart_args(tmp_path: Path, process: FakeProcess | None, budget: int = 1):
    processes = [process] if process is not None else []
    args = argparse.Namespace(
        isolated_mode=True,
        _bridge_process=process,
        _owned_bridge_processes=processes,
        _bridge_process_started_at={id(process): run_stage.time.time() - 2}
        if process is not None else {},
        _owned_bridge_session_ids={id(process): "session-old"}
        if process is not None else {},
        bridge_restarts=budget,
        _bridge_restarts_used=0,
        node="node-test",
        node_args=["--jitless", "--max-old-space-size=4096"],
        port=25666,
        host="127.0.0.1",
        studio="http://127.0.0.1:8766",
        isolated_studio_dir=tmp_path / "studio",
    )
    args.isolated_studio_dir.mkdir(parents=True)
    return args


def test_owned_bridge_exit_restarts_with_node_args_and_cleanup_stops_replacement(
    tmp_path, monkeypatch
):
    old = FakeProcess(1, exitcode=17)
    other_owned = FakeProcess(9)
    replacement = FakeProcess(2)
    args = restart_args(tmp_path, old)
    args._owned_bridge_processes.append(other_owned)
    commands = []
    delays = []

    def fake_popen(command, **kwargs):
        commands.append((command, kwargs))
        return replacement

    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": False})
    monkeypatch.setattr(run_stage, "node_version", lambda _node: "v24.test")
    monkeypatch.setattr(run_stage.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(run_stage.time, "sleep", delays.append)

    assert run_stage.restart_exited_owned_bridge(
        args, goal_status("disconnected"), "stage_poll"
    ) is True

    assert commands[0][0] == [
        "node-test", "--jitless", "--max-old-space-size=4096", "bridge/minecraft_bridge.js"
    ]
    assert commands[0][1]["env"]["MC_PORT"] == "25666"
    assert commands[0][1]["env"].get("NODE_OPTIONS") == os.environ.get("NODE_OPTIONS")
    assert commands[0][1]["env"].get("PATH") == os.environ.get("PATH")
    assert delays == [run_stage.BRIDGE_RESTART_BASE_BACKOFF_S]
    assert args._bridge_process is replacement
    assert args._owned_bridge_processes == [old, other_owned, replacement]
    assert args._bridge_restart_history[0]["exitcode"] == 17
    assert args._bridge_restart_history[0]["exitcode_hex"] == "0x00000011"
    assert args._bridge_restart_history[0]["pid"] == 1
    assert args._bridge_restart_history[0]["restart_attempt"] == 1
    assert args._bridge_restart_history[0]["restarted"] is True
    assert args._bridge_restart_history[0]["exit_time"] > 0
    assert args._bridge_restart_history[0]["restart_time"] > 0

    run_stage.stop_owned_bridge_processes(args)
    assert replacement.terminated is True
    assert other_owned.terminated is True


def test_native_bridge_exit_codes_are_not_retried(tmp_path, monkeypatch):
    launches = []
    monkeypatch.setattr(run_stage.subprocess, "Popen", lambda *args, **kwargs: launches.append(args))
    for exitcode in (0xC0000005, 0x80000003, -1073741819, -2147483645):
        dead = FakeProcess(10 + len(launches), exitcode=exitcode)
        args = restart_args(tmp_path / str(exitcode), dead, budget=1)
        assert run_stage.restart_exited_owned_bridge(
            args, goal_status("disconnected"), "stage_poll"
        ) is False
        event = args._bridge_restart_history[0]
        assert event["decision"] == "native_exit_no_retry"
        assert event["exitcode"] == exitcode
        assert args._bridge_restart_blocked is event
    assert launches == []


def test_restart_waits_for_old_session_disconnect_before_spawning(tmp_path, monkeypatch):
    old = FakeProcess(1, exitcode=4)
    replacement = FakeProcess(2)
    args = restart_args(tmp_path, old)
    states = iter([
        {"connected": True, "state": {"session_id": "session-old"}},
        {"connected": False, "state": {"session_id": "session-old"}},
    ])
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: next(states))
    monkeypatch.setattr(run_stage, "node_version", lambda _node: "v24.test")
    monkeypatch.setattr(run_stage.subprocess, "Popen", lambda *_args, **_kwargs: replacement)
    monkeypatch.setattr(run_stage.time, "sleep", lambda _seconds: None)

    assert run_stage.restart_exited_owned_bridge(
        args, goal_status("active"), "stage_poll"
    ) is False
    assert args._bridge_restart_history[0]["decision"] == "old_session_still_connected"
    assert args._bridge_process is old

    assert run_stage.restart_exited_owned_bridge(
        args, goal_status("active"), "stage_poll"
    ) is True
    assert args._bridge_process is replacement
    assert args._bridge_restart_history[-1]["decision"] == "restart_scheduled"


def test_bridge_restart_budget_and_unowned_process_are_not_restarted(
    tmp_path, monkeypatch
):
    owned_dead = FakeProcess(1, exitcode=17)
    no_budget = restart_args(tmp_path, owned_dead, budget=0)
    launches = []
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": False})
    monkeypatch.setattr(run_stage, "node_version", lambda _node: "v24.test")
    monkeypatch.setattr(run_stage.subprocess, "Popen", lambda *a, **k: launches.append(a))

    assert run_stage.restart_exited_owned_bridge(
        no_budget, goal_status("active"), "stage_poll"
    ) is False
    assert launches == []
    assert no_budget._bridge_restart_history[0]["decision"] == "restart_budget_exhausted"
    assert no_budget._bridge_restart_history[0]["exitcode"] == 17

    unowned = FakeProcess(2, exitcode=23)
    external = argparse.Namespace(
        isolated_mode=True,
        _bridge_process=unowned,
        _owned_bridge_processes=[],
        bridge_restarts=5,
    )
    assert run_stage.restart_exited_owned_bridge(
        external, goal_status("active"), "stage_poll"
    ) is False
    assert launches == []
    assert not hasattr(external, "_bridge_restart_history")

    already_connected = FakeProcess(3, exitcode=24)
    connected_owner = argparse.Namespace(
        isolated_mode=True,
        _bridge_process=already_connected,
        _owned_bridge_processes=[already_connected],
        _owned_bridge_session_ids={id(already_connected): "session-old"},
        bridge_restarts=5,
        studio="http://127.0.0.1:8766",
    )
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {
        "connected": True, "state": {"session_id": "session-new"},
    })
    assert run_stage.restart_exited_owned_bridge(
        connected_owner, goal_status("active"), "stage_poll"
    ) is False
    assert launches == []
    assert connected_owner._bridge_restart_history[0]["decision"] == "bridge_session_already_connected"

    external_service = argparse.Namespace(studio="http://127.0.0.1:8766")
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": True})
    assert run_stage.ensure_bridge(external_service) is None
    assert not hasattr(external_service, "_bridge_process")


def test_stage_poll_restarts_owned_bridge_only_while_goal_is_recoverable(
    tmp_path, monkeypatch
):
    old = FakeProcess(1, exitcode=7)
    replacement = FakeProcess(2)
    args = restart_args(tmp_path, old)
    args.poll_interval_s = 0
    statuses = iter([
        goal_status("disconnected", recovery_reason="bridge_disconnected"),
        goal_status("done", result={"ok": True, "status": "done"}),
    ])
    monkeypatch.setattr(run_stage, "http_json", lambda *_args, **_kwargs: next(statuses))
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": False})
    monkeypatch.setattr(run_stage.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(run_stage, "node_version", lambda _node: "v24.test")
    monkeypatch.setattr(run_stage.subprocess, "Popen", lambda *_args, **_kwargs: replacement)

    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)

    assert result == {"ok": True, "status": "done"}
    assert final["goal"]["status"] == "done"
    assert args._bridge_process is replacement
    assert args._bridge_restart_history[0]["phase"] == "stage_poll"
    assert args._bridge_restart_history[0]["restarted"] is True
    assert [entry["event"] for entry in history] == [
        "worker_interrupted", "goal_completed_after_recovery",
    ]


def test_exhausted_bridge_restart_preserves_disconnected_goal(tmp_path, monkeypatch):
    dead = FakeProcess(1, exitcode=17)
    args = restart_args(tmp_path, dead, budget=0)
    args.poll_interval_s = 0
    calls = []

    def fake_http_json(url, payload=None, timeout=10.0):
        calls.append((url, payload))
        if url.endswith("/api/run/status"):
            return goal_status("disconnected", recovery_reason="bridge_disconnected")
        return {"stopped": True}

    monkeypatch.setattr(run_stage, "http_json", fake_http_json)
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": False})
    monkeypatch.setattr(run_stage.time, "sleep", lambda _seconds: None)

    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=60)

    assert result["status"] == "blocked"
    assert "restart_budget_exhausted" in result["detail"]
    assert final["goal"]["status"] == "disconnected"
    assert [url.rsplit("/", 1)[-1] for url, _payload in calls] == ["status"]
    assert not getattr(args, "_run_stop_sent", False)
    assert not getattr(args, "_stage_stop_requested", False)
    assert history[-1]["event"] == "bridge_restart_blocked"
    assert history[-1]["bridge_restart"]["exitcode_hex"] == "0x00000011"

def test_native_bridge_exit_preserves_disconnected_goal_without_retry(tmp_path, monkeypatch):
    dead = FakeProcess(1, exitcode=-1073741819)
    args = restart_args(tmp_path, dead, budget=1)
    args.poll_interval_s = 0
    calls = []

    def fake_http_json(url, payload=None, timeout=10.0):
        calls.append((url, payload))
        if url.endswith("/api/run/status"):
            return goal_status("disconnected", recovery_reason="bridge_disconnected")
        return {"stopped": True}

    monkeypatch.setattr(run_stage, "http_json", fake_http_json)
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: {"connected": False})
    monkeypatch.setattr(run_stage.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        run_stage.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("native exit must not restart Node"),
    )

    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=60)

    assert result["status"] == "blocked"
    assert "native_exit_no_retry" in result["detail"]
    assert final["goal"]["status"] == "disconnected"
    assert [url.rsplit("/", 1)[-1] for url, _payload in calls] == ["status"]
    assert not getattr(args, "_run_stop_sent", False)
    assert not getattr(args, "_stage_stop_requested", False)
    assert history[-1]["bridge_restart"]["decision"] == "native_exit_no_retry"


def test_done_goal_wins_over_exited_bridge_and_does_not_stop(tmp_path, monkeypatch):
    dead = FakeProcess(1, exitcode=7)
    args = restart_args(tmp_path, dead, budget=0)
    args.poll_interval_s = 0
    done = goal_status("done", running=True, result={"ok": True, "status": "done"})
    calls = []

    def fake_http_json(url, payload=None, timeout=10.0):
        calls.append((url, payload))
        return done

    monkeypatch.setattr(run_stage, "http_json", fake_http_json)
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: pytest.fail("done 不需检查重启"))

    result, history, final = run_stage.wait_for_stage_result(args, "S2", timeout_s=10)

    assert result == done["result"]
    assert final is done
    assert len(calls) == 1
    assert not hasattr(args, "_bridge_restart_blocked")


def test_startup_wait_restarts_owned_bridge_but_respects_terminal_goal(
    tmp_path, monkeypatch
):
    old = FakeProcess(1, exitcode=1)
    replacement = FakeProcess(2)
    args = restart_args(tmp_path, old)
    args._planned_resume_task_id = 5
    paused = goal_status("paused_by_user")
    paused["task_id"] = 5
    states = iter([
        {"connected": False, "ready": False},
        {"connected": False, "ready": False},
        {"connected": True, "ready": True, "age_s": 0,
         "state": {"ready": True, "alive": True, "health": 20, "session_id": "session-new"}},
    ])
    monkeypatch.setattr(run_stage, "bridge_state", lambda _studio: next(states))
    monkeypatch.setattr(run_stage, "_current_run_status", lambda _args: paused)
    monkeypatch.setattr(run_stage, "time", type("Clock", (), {
        "time": staticmethod(lambda: 100.0),
        "sleep": staticmethod(lambda _seconds: None),
    }))
    monkeypatch.setattr(run_stage, "node_version", lambda _node: "v24.test")
    monkeypatch.setattr(run_stage.subprocess, "Popen", lambda *_args, **_kwargs: replacement)
    monkeypatch.setattr(run_stage, "log_dir", lambda _args: args.isolated_studio_dir)

    assert run_stage.wait_for_bridge(args.studio, timeout=10, args=args) is True
    assert args._bridge_process is replacement
    assert args._bridge_restart_history[0]["phase"] == "startup_wait"
    assert args._bridge_restart_history[0]["restarted"] is True

    terminal = restart_args(tmp_path / "terminal", FakeProcess(3, exitcode=2))
    terminal._planned_resume_task_id = 5
    paused_other = goal_status("paused_by_user")
    paused_other["task_id"] = 6
    assert run_stage.restart_exited_owned_bridge(
        terminal, paused_other, "startup_wait"
    ) is False
    assert terminal._bridge_restarts_used == 0
    assert terminal._bridge_restart_history[0]["decision"] == "goal_not_recoverable"
    paused_stage = restart_args(tmp_path / "paused_stage", FakeProcess(4, exitcode=3))
    paused_stage._planned_resume_task_id = 5
    assert run_stage.restart_exited_owned_bridge(
        paused_stage, paused, "stage_poll"
    ) is False
    assert paused_stage._bridge_restart_history[0]["decision"] == "goal_not_recoverable"

    stopped = restart_args(tmp_path / "stopped", FakeProcess(5, exitcode=5))
    stopped._planned_resume_task_id = 5
    stopped._stage_stop_requested = True
    assert run_stage.restart_exited_owned_bridge(
        stopped, paused, "startup_wait"
    ) is False
    assert stopped._bridge_restart_history[0]["decision"] == "explicit_stop"


def test_wait_for_bridge_waits_for_authoritative_state_ready(monkeypatch):
    state_not_ready = {
        "connected": True,
        "ready": True,
        "age_s": 0.1,
        "state": {
            "ready": False,
            "alive": True,
            "health": 20,
            "position": {"x": -18.5, "y": 57, "z": 143.4},
        },
    }
    state_ready = {
        "connected": True,
        "ready": True,
        "age_s": 0.1,
        "state": {
            "ready": True,
            "alive": True,
            "health": 20,
            "position": {"x": -18.5, "y": 57, "z": 143.4},
        },
    }
    snapshots = iter([state_not_ready, state_ready])
    observed = []
    clock = {"now": 0.0, "sleeps": []}

    def fake_bridge_state(_studio):
        snapshot = next(snapshots)
        observed.append(snapshot)
        return snapshot

    def fake_time():
        return clock["now"]

    def fake_sleep(seconds):
        clock["sleeps"].append(seconds)
        clock["now"] += seconds

    monkeypatch.setattr(run_stage, "bridge_state", fake_bridge_state)
    monkeypatch.setattr(run_stage, "time", type("Clock", (), {
        "time": staticmethod(fake_time),
        "sleep": staticmethod(fake_sleep),
    }))

    assert run_stage.wait_for_bridge("http://127.0.0.1:8766", timeout=10) is True
    assert len(observed) == 2
    assert observed[0]["ready"] is True
    assert observed[0]["state"]["ready"] is False
    assert observed[1]["state"]["ready"] is True
    assert clock["sleeps"] == [2.0]


def test_run_once_times_out_without_starting_stage_when_state_never_ready(
    tmp_path, monkeypatch
):
    clock = {"now": 0.0}
    bridge_polls = []
    http_calls = []

    def fake_time():
        return clock["now"]

    def fake_sleep(seconds):
        clock["now"] += seconds

    def fake_bridge_state(_studio):
        bridge_polls.append(clock["now"])
        return {
            "connected": True,
            "ready": True,
            "age_s": 0.1,
            "state": {
                "ready": False,
                "alive": True,
                "health": 20,
                "position": {"x": -18.5, "y": 57, "z": 143.4},
            },
        }

    monkeypatch.setattr(run_stage, "ensure_studio", lambda _args: None)
    monkeypatch.setattr(run_stage, "ensure_bridge", lambda _args: None)
    monkeypatch.setattr(run_stage, "stop_server", lambda _args: None)
    monkeypatch.setattr(run_stage, "reset_world", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_stage, "start_server", lambda _args: object())
    monkeypatch.setattr(run_stage, "apply_world_rules", lambda _args: None)
    monkeypatch.setattr(run_stage, "bridge_state", fake_bridge_state)
    monkeypatch.setattr(run_stage, "http_json", lambda *args, **kwargs: http_calls.append((args, kwargs)))
    monkeypatch.setattr(run_stage, "time", type("Clock", (), {
        "time": staticmethod(fake_time),
        "sleep": staticmethod(fake_sleep),
    }))

    args = argparse.Namespace(
        studio="http://127.0.0.1:8766",
        server_dir=str(tmp_path / "isolated"),
        isolated_mode=False,
        stage="S3",
        runs=1,
        difficulty="normal",
    )
    result = run_stage.run_once(args, 1)

    assert result["status"] == "bridge_unavailable"
    assert len(bridge_polls) == 60
    assert clock["now"] == 120.0
    assert http_calls == []

def _make_continuation_source(path: Path) -> Path:
    import sqlite3
    source = make_server(path)
    (source / "world").mkdir()
    (source / "world/level.dat").write_bytes(b"saved world")
    data = source / ".voxkin-studio/data"
    data.mkdir(parents=True)
    with sqlite3.connect(data / "tasks.db") as connection:
        connection.execute("CREATE TABLE tasks (id INTEGER PRIMARY KEY, stage TEXT, status TEXT)")
        connection.execute("CREATE TABLE goal_states (task_id INTEGER PRIMARY KEY, payload TEXT)")
        connection.execute("INSERT INTO tasks VALUES (4, 'S3', 'cancelled')")
        connection.execute("INSERT INTO goal_states VALUES (?, ?)", (4, json.dumps({
            "goal_id": "stage:s3", "status": "paused_by_user", "deadline_at": 12345,
            "counters": {"actions": 4}, "pending_action": {"action_id": "unknown"},
        })))
    return source


def test_continuation_copies_world_db_and_preserves_pending(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    monkeypatch.setattr(run_stage, "port_open", lambda *_a, **_kw: False)
    source = _make_continuation_source(tmp_path / "work/mc/source")
    (tmp_path / "config").mkdir()
    (tmp_path / "config/voxkin.yaml").write_text("server: {}\n", encoding="utf8")
    args = argparse.Namespace(isolate_from=str(source), isolate_target="work/mc/continue", continue_task=4,
        isolate_port=26790, isolate_rcon_port=26791, isolate_studio_port=8874, host="127.0.0.1", rcon_password="voxkin")
    run_stage.validate_continuation_source(args)
    original = args._source_continuation_manifest
    run_stage.prepare_isolated(args)
    assert run_stage.continuation_manifest(source, 4) == original
    assert run_stage.continuation_manifest(tmp_path / "work/mc/continue", 4) == original
    assert original["pending_action"]["action_id"] == "unknown"
    assert original["counters"]["actions"] == 4
    assert original["deadline_at"] == 12345


def test_continuation_never_resets_world_or_changes_rules_and_resumes_before_s4(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(run_stage, "ensure_studio", lambda _a: None)
    monkeypatch.setattr(run_stage, "ensure_bridge", lambda _a: None)
    monkeypatch.setattr(run_stage, "stop_server", lambda _a: None)
    monkeypatch.setattr(run_stage, "start_server", lambda _a: object())
    monkeypatch.setattr(run_stage, "reset_world", lambda *_a, **_k: pytest.fail("世界不得重置"))
    monkeypatch.setattr(run_stage, "apply_world_rules", lambda *_a: pytest.fail("规则不得修改"))
    monkeypatch.setattr(run_stage, "wait_for_bridge", lambda *_a, **_k: True)
    monkeypatch.setattr(run_stage, "http_json", lambda url, payload=None, **_k: calls.append((url, payload)) or {})
    monkeypatch.setattr(run_stage, "wait_for_stage_result", lambda _a, stage, _t: (
        {"ok": True, "status": "done"}, [], {"stage_complete": True, "goal": {"status": "done", "goal_id": f"stage:{stage.lower()}"}}
    ))
    args = argparse.Namespace(studio="http://127.0.0.1:8874", server_dir=str(tmp_path), isolated_mode=True,
        continue_task=4, runs=1, difficulty="normal", stage_timeout=60, stage="S3")
    result = run_stage.run_once(args, 1)
    assert result["ok"] is True
    assert calls == [("http://127.0.0.1:8874/api/run/resume", {"task_id": 4}),
                     ("http://127.0.0.1:8874/api/run/start", {"stage": "S4"})]


def test_continuation_failed_s3_does_not_start_s4(tmp_path, monkeypatch):
    calls = []
    for name in ("ensure_studio", "ensure_bridge", "stop_server"):
        monkeypatch.setattr(run_stage, name, lambda *_a: None)
    monkeypatch.setattr(run_stage, "start_server", lambda _a: object())
    monkeypatch.setattr(run_stage, "wait_for_bridge", lambda *_a, **_k: True)
    monkeypatch.setattr(run_stage, "http_json", lambda url, payload=None, **_k: calls.append((url, payload)) or {})
    monkeypatch.setattr(run_stage, "wait_for_stage_result", lambda *_a: ({"ok": False, "status": "blocked"}, [], {"goal": {}}))
    args = argparse.Namespace(studio="http://localhost", server_dir=str(tmp_path), isolated_mode=True,
        continue_task=4, runs=1, difficulty="normal", stage_timeout=60, stage="S3")
    assert run_stage.run_once(args, 1)["ok"] is False
    assert calls == [("http://localhost/api/run/resume", {"task_id": 4})]

def test_continuation_rejects_live_source_and_wal(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    source = _make_continuation_source(tmp_path / "work/mc/source")
    args = argparse.Namespace(isolate_from=str(source), continue_task=4)
    monkeypatch.setattr(run_stage, "port_open", lambda *_a, **_k: True)
    with pytest.raises(SystemExit, match="端口仍被占用"):
        run_stage.validate_continuation_source(args)
    monkeypatch.setattr(run_stage, "port_open", lambda *_a, **_k: False)
    (source / ".voxkin-studio/data/tasks.db-wal").write_bytes(b"pending")
    with pytest.raises(SystemExit, match="SQLite WAL"):
        run_stage.validate_continuation_source(args)


def test_continuation_detects_copy_or_source_change(tmp_path, monkeypatch):
    monkeypatch.setattr(run_stage, "ROOT", tmp_path)
    monkeypatch.setattr(run_stage, "port_open", lambda *_a, **_k: False)
    source = _make_continuation_source(tmp_path / "work/mc/source")
    (tmp_path / "config").mkdir()
    (tmp_path / "config/voxkin.yaml").write_text("server: {}\n", encoding="utf8")
    args = argparse.Namespace(isolate_from=str(source), isolate_target="work/mc/continue", continue_task=4,
        isolate_port=26790, isolate_rcon_port=26791, isolate_studio_port=8874, host="127.0.0.1", rcon_password="voxkin")
    run_stage.validate_continuation_source(args)
    (source / "world/level.dat").write_bytes(b"changed after validation")
    with pytest.raises(SystemExit, match="不一致"):
        run_stage.prepare_isolated(args)
    assert not (tmp_path / "work/mc/continue").exists()
