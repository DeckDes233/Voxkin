import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "quickstart_player.py"
SPEC = importlib.util.spec_from_file_location("quickstart_player", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
quickstart = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(quickstart)
pytestmark = pytest.mark.skipif(os.name != "nt", reason="快速启动器面向 Windows")


def configure(tmp_path, monkeypatch, marker):
    marker_path = tmp_path / "active.json"
    marker_path.write_text(json.dumps(marker), encoding="utf-8")
    node = tmp_path / "node.exe"
    bridge = tmp_path / "minecraft_bridge.js"
    node.touch()
    bridge.touch()
    monkeypatch.setattr(quickstart, "MARKER", marker_path)
    monkeypatch.setattr(quickstart, "NODE", node)
    monkeypatch.setattr(quickstart, "BRIDGE", bridge)
    monkeypatch.setattr(quickstart, "WORK", tmp_path / "work")
    monkeypatch.setattr(quickstart, "start_bridge_monitor", lambda *args: None)
    monkeypatch.setattr(sys, "argv", ["quickstart_player.py"])
    monkeypatch.setattr(quickstart, "listening", lambda host, port: port == 25565)
    return marker_path


def test_existing_connected_bridge_is_reused(tmp_path, monkeypatch, capsys):
    marker = {"runtime_active": True, "cleanup_pending": True, "runtime_blocked": True,
              "user_world_25565_run": {"target": "127.0.0.1:25565", "bridge_pid": 42}}
    configure(tmp_path, monkeypatch, marker)
    monkeypatch.setattr(quickstart, "get_json", lambda _path: {"connected": True})
    monkeypatch.setattr(quickstart, "alive", lambda pid, expected_image=None: pid == 42)
    monkeypatch.setattr(quickstart, "launch", lambda *args: pytest.fail("不得重复启动"))
    assert quickstart.main() == 0
    assert "127.0.0.1:25565" in capsys.readouterr().out


def test_other_active_run_is_not_displaced(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch, {"runtime_active": True, "cleanup_pending": True})
    monkeypatch.setattr(quickstart, "get_json", lambda _path: None)
    monkeypatch.setattr(quickstart, "launch", lambda *args: pytest.fail("不得启动"))
    with pytest.raises(SystemExit, match="清理仍未完成"):
        quickstart.main()


def test_same_target_does_not_bypass_cleanup_pending(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch, {
        "runtime_active": True,
        "cleanup_pending": True,
        "user_world_25565_run": {"target": "127.0.0.1:25565", "bridge_pid": 42},
    })
    monkeypatch.setattr(quickstart, "get_json", lambda _path: None)
    monkeypatch.setattr(quickstart, "alive", lambda *_args: False)
    monkeypatch.setattr(quickstart, "launch", lambda *args: pytest.fail("不得启动"))
    with pytest.raises(SystemExit, match="清理仍未完成"):
        quickstart.main()


def test_runtime_blocked_prevents_same_target_restart(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch, {
        "runtime_active": False,
        "cleanup_pending": False,
        "runtime_blocked": True,
        "user_world_25565_run": {"target": "127.0.0.1:25565", "bridge_pid": 42},
    })
    monkeypatch.setattr(quickstart, "get_json", lambda _path: None)
    monkeypatch.setattr(quickstart, "alive", lambda *_args: False)
    monkeypatch.setattr(quickstart, "launch", lambda *args: pytest.fail("不得启动"))
    with pytest.raises(SystemExit, match="blocked"):
        quickstart.main()


def test_runtime_blocked_cannot_be_bypassed_by_watcher_reconnect(tmp_path, monkeypatch):
    configure(tmp_path, monkeypatch, {
        "runtime_active": True,
        "cleanup_pending": True,
        "runtime_blocked": True,
        "user_world_25565_run": {"target": "127.0.0.1:25565", "bridge_pid": 42},
    })
    monkeypatch.setattr(sys, "argv", [
        "quickstart_player.py", "--resume-current", "--watch-reconnect-pid", "42",
    ])
    monkeypatch.setattr(quickstart, "get_json", lambda _path: None)
    monkeypatch.setattr(quickstart, "alive", lambda *_args: False)
    monkeypatch.setattr(quickstart, "launch", lambda *args: pytest.fail("不得启动"))
    with pytest.raises(SystemExit, match="blocked"):
        quickstart.main()


def test_watcher_can_resume_only_its_recorded_bridge_pid(tmp_path, monkeypatch):
    workspace = tmp_path / "work" / "old_session"
    (workspace / "data").mkdir(parents=True)
    (workspace / "data" / "tasks.db").touch()
    marker = configure(tmp_path, monkeypatch, {
        "runtime_active": True,
        "cleanup_pending": True,
        "runtime_blocked": False,
        "user_world_25565_run": {
            "target": "127.0.0.1:25565",
            "bridge_pid": 42,
            "studio_pid": 24,
            "workspace": str(workspace),
        },
    })
    monkeypatch.setattr(quickstart, "ROOT", tmp_path)
    monkeypatch.setattr(sys, "argv", [
        "quickstart_player.py", "--resume-current", "--watch-reconnect-pid", "42",
    ])
    states = iter([
        {"connected": False},
        {"connected": True, "state": {"ready": True}},
    ])
    monkeypatch.setattr(quickstart, "get_json", lambda _path: next(states))
    monkeypatch.setattr(quickstart, "alive", lambda pid, _expected=None: pid == 24)
    monkeypatch.setattr(quickstart.subprocess, "run", lambda *_args, **_kwargs: type("Version", (), {"stdout": "v22.23.4\n"})())
    commands = []

    class Process:
        pid = 100

        def poll(self):
            return None

    def launch(command, *_args):
        commands.append(command)
        return Process()

    monkeypatch.setattr(quickstart, "launch", launch)
    assert quickstart.main() == 0
    assert len(commands) == 1
    assert commands[0][0] == str(quickstart.NODE)
    saved = json.loads(marker.read_text(encoding="utf-8"))
    assert saved["user_world_25565_run"]["workspace"] == str(workspace)
    assert saved["user_world_25565_run"]["bridge_pid"] == 100


def test_watcher_waits_until_studio_reports_bridge_disconnected(monkeypatch):
    monkeypatch.setitem(sys.modules, "quickstart_player", quickstart)
    spec = importlib.util.spec_from_file_location("bridge_watch", SCRIPT.parent / "bridge_watch.py")
    watch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watch)
    states = iter([{"connected": True}, {"connected": False}])
    monkeypatch.setattr(quickstart, "get_json", lambda _path: next(states))
    monkeypatch.setattr(watch.time, "monotonic", iter([0.0, 0.0]).__next__)
    monkeypatch.setattr(watch.time, "sleep", lambda _seconds: None)
    assert watch.wait_for_bridge_disconnect(timeout=1, interval=0.25)


def test_watcher_fails_closed_if_studio_keeps_reporting_connected(monkeypatch):
    monkeypatch.setitem(sys.modules, "quickstart_player", quickstart)
    spec = importlib.util.spec_from_file_location("bridge_watch", SCRIPT.parent / "bridge_watch.py")
    watch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watch)
    monotonic = iter([0.0, 0.0, 2.0])
    monkeypatch.setattr(quickstart, "get_json", lambda _path: {"connected": True})
    monkeypatch.setattr(watch.time, "monotonic", monotonic.__next__)
    monkeypatch.setattr(watch.time, "sleep", lambda _seconds: None)
    assert not watch.wait_for_bridge_disconnect(timeout=1, interval=0.25)


def test_new_start_uses_player_mode_and_records_real_readiness(tmp_path, monkeypatch):
    marker = configure(tmp_path, monkeypatch, {"runtime_active": False, "cleanup_pending": False})
    monkeypatch.setenv("NODE_OPTIONS", "--inspect")
    monkeypatch.setenv("VOXKIN_INDEPENDENT", "1")
    states = iter([None, {"connected": False}, {"connected": True, "state": {"ready": True}}])
    monkeypatch.setattr(quickstart, "get_json", lambda _path: next(states))
    monkeypatch.setattr(quickstart, "alive", lambda *_args: False)
    monkeypatch.setattr(quickstart.subprocess, "run", lambda *_args, **_kwargs: type("Version", (), {"stdout": "v22.23.4\n"})())
    calls = []
    class Process:
        def __init__(self, pid):
            self.pid = pid
        def poll(self):
            return None
    def launch(command, cwd, env, log_prefix):
        calls.append((command, env.copy()))
        return Process(100 + len(calls))
    monkeypatch.setattr(quickstart, "launch", launch)
    assert quickstart.main() == 0
    assert len(calls) == 2
    assert calls[1][0][1] == "--jitless"
    assert calls[1][1]["MC_PORT"] == "25565"
    assert "NODE_OPTIONS" not in calls[1][1]
    assert "VOXKIN_INDEPENDENT" not in calls[1][1]
    saved = json.loads(marker.read_text(encoding="utf-8"))
    assert saved["user_world_25565_run"]["status"] == "connected"
    assert saved["user_world_25565_run"]["bridge_pid"] == 102
    assert saved["runtime_active"] is True


def test_resume_uses_same_world_task_directory(tmp_path, monkeypatch):
    workspace = tmp_path / "work" / "old_session"
    (workspace / "data").mkdir(parents=True)
    (workspace / "data" / "tasks.db").touch()
    marker = configure(tmp_path, monkeypatch, {
        "runtime_active": False, "cleanup_pending": False,
        "user_world_25565_run": {"target": "127.0.0.1:25565", "workspace": str(workspace)},
    })
    monkeypatch.setattr(quickstart, "ROOT", tmp_path)
    monkeypatch.setattr(sys, "argv", ["quickstart_player.py", "--resume-current"])
    states = iter([None, {"connected": False}, {"connected": True, "state": {"ready": True}}])
    monkeypatch.setattr(quickstart, "get_json", lambda _path: next(states))
    monkeypatch.setattr(quickstart, "alive", lambda *_args: False)
    monkeypatch.setattr(quickstart.subprocess, "run", lambda *_args, **_kwargs: type("Version", (), {"stdout": "v22.23.4\n"})())
    commands = []
    class Process:
        def __init__(self, pid): self.pid = pid
        def poll(self): return None
    def launch(command, cwd, env, log_prefix):
        commands.append(command)
        return Process(200 + len(commands))
    monkeypatch.setattr(quickstart, "launch", launch)
    assert quickstart.main() == 0
    assert commands[0][-1] == str(workspace)
    assert json.loads(marker.read_text(encoding="utf-8"))["user_world_25565_run"]["workspace"] == str(workspace)


def test_bridge_monitor_only_restarts_known_non_native_exit(monkeypatch):
    monkeypatch.setitem(sys.modules, "quickstart_player", quickstart)
    spec = importlib.util.spec_from_file_location("bridge_watch", SCRIPT.parent / "bridge_watch.py")
    watch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watch)
    marker = {"runtime_active": True, "cleanup_pending": True, "runtime_blocked": False,
              "user_world_25565_run": {"bridge_pid": 42, "target": "127.0.0.1:25565"}}
    assert watch.may_restart(marker, 42, "127.0.0.1:25565", 1, 20, 0)
    assert not watch.may_restart(marker, 42, "127.0.0.1:25565", 0xC0000005, 20, 0)
    assert not watch.may_restart(marker, 42, "127.0.0.1:25565", 0, 20, 0)
    assert not watch.may_restart(marker, 42, "127.0.0.1:25565", 1, 5, 0)
    assert not watch.may_restart(marker, 42, "127.0.0.1:25565", 1, 20, 1)
    assert not watch.may_restart({**marker, "runtime_blocked": True}, 42, "127.0.0.1:25565", 1, 20, 0)
    assert not watch.may_restart({**marker, "cleanup_pending": False}, 42, "127.0.0.1:25565", 1, 20, 0)
