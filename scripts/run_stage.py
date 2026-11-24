# 在固定 seed 的评测服务器上重复跑一个阶段，统计成功率与用时。
# 用法：.\.venv\Scripts\python.exe scripts\run_stage.py --stage S0 --runs 10
# 脚本重置评测世界、重启 Paper、按难度设置世界规则，然后通过 /api/run/start
# 触发阶段并轮询 /api/run/status 直到结束。每次运行的原始 JSONL 留在 runs/，
# 汇总写到 runs/registry/。

from __future__ import annotations

import argparse
import copy
import hashlib
import sqlite3
import json
import os
import shutil
import secrets
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

import yaml

ROOT = Path(__file__).resolve().parent.parent
DESCRIPTION = "在固定 seed 的评测服务器上重复跑一个阶段，统计成功率与用时"
_ENV_JAVA = os.environ.get("MINECRAFT_RUNTIME_JAVA", "").strip()
DEFAULT_JAVA = (
    Path(_ENV_JAVA)
    if _ENV_JAVA
    else Path.home() / "AppData/Roaming/.minecraft/runtime/java-runtime-delta/bin/java.exe"
)
DEFAULT_NODE = os.environ.get("VOXKIN_NODE", "").strip() or shutil.which("node") or "node"
PROTECTED_SERVER_NAMES = {"server", "eval_server", "runtime", "craft_test_server"}
ISOLATED_GAME_PORT = 25666
ISOLATED_RCON_PORT = 25676
ISOLATED_STUDIO_PORT = 8766
BRIDGE_RESTART_BASE_BACKOFF_S = 0.5
BRIDGE_RESTART_MAX_BACKOFF_S = 5.0


def rcon(host: str, port: int, password: str, command: str, timeout: float = 10.0) -> str:
    """发送一条 RCON 命令并返回文本输出。"""

    with socket.create_connection((host, port), timeout=timeout) as sock:
        def send(request_id: int, kind: int, body: str) -> None:
            payload = struct.pack("<ii", request_id, kind) + body.encode("utf-8") + b"\x00\x00"
            sock.sendall(struct.pack("<i", len(payload)) + payload)

        def read() -> tuple[int, int, str]:
            header = sock.recv(4)
            if len(header) < 4:
                return 0, 0, ""
            length = struct.unpack("<i", header)[0]
            data = b""
            while len(data) < length:
                chunk = sock.recv(length - len(data))
                if not chunk:
                    break
                data += chunk
            request_id, kind = struct.unpack("<ii", data[:8])
            return request_id, kind, data[8:-2].decode("utf-8", errors="replace")

        send(1, 3, password)
        read()
        send(2, 2, command)
        return read()[2]


def port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_json(url: str, payload: dict | None = None, timeout: float = 10.0) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    last_error: Exception | None = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(1.0)
    raise last_error if last_error else RuntimeError("请求失败")


def log_dir(args: argparse.Namespace | None = None) -> Path:
    isolated_dir = getattr(args, "isolated_studio_dir", None) if args else None
    target = Path(isolated_dir) / "logs" if isolated_dir else ROOT / "work/logs"
    target.mkdir(parents=True, exist_ok=True)
    return target


def studio_endpoint(studio: str) -> tuple[str, int]:
    parsed = urlsplit(studio)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SystemExit("Studio 地址必须是有效的 http(s) URL")
    return parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def rooted_path(value: Path) -> Path:
    expanded = value.expanduser()
    return expanded if expanded.is_absolute() else ROOT / expanded


def validate_isolated_paths(source: Path, target: Path) -> tuple[Path, Path]:
    mc_root = (ROOT / "work/mc").resolve()
    resolved_source = rooted_path(source).resolve()
    resolved_target = rooted_path(target).resolve()
    if not resolved_target.is_relative_to(mc_root) or resolved_target == mc_root:
        raise SystemExit("隔离目标必须位于仓库 work/mc/ 目录内")
    protected = [mc_root / name for name in PROTECTED_SERVER_NAMES]
    if any(resolved_target == item or item in resolved_target.parents for item in protected):
        raise SystemExit("隔离目标不能是受保护的原始服务器目录或其子目录")
    if resolved_source == resolved_target:
        raise SystemExit("隔离目标必须与源服务器不同")
    if resolved_target.is_relative_to(resolved_source) or resolved_source.is_relative_to(resolved_target):
        raise SystemExit("隔离源与目标不能互相包含")
    if not resolved_source.is_dir() or resolved_source == mc_root:
        raise SystemExit("显式指定的源服务器目录不存在")
    if resolved_target.exists():
        raise SystemExit("隔离目标已存在；为避免覆盖，不会继续")
    return resolved_source, resolved_target


def validate_isolated_ports(game_port: int, rcon_port: int, studio_port: int) -> None:
    ports = (game_port, rcon_port, studio_port)
    if any(port < 1 or port > 65535 for port in ports):
        raise SystemExit("隔离模式端口必须在 1-65535 范围内")
    if len(set(ports)) != len(ports):
        raise SystemExit("隔离服务器、RCON 与 Studio 必须使用三个不同端口")
    if set(ports) & {25565, 25566, 25576, 8765}:
        raise SystemExit("隔离端口不能复用常规 Minecraft、评测、RCON 或 Studio 端口")
    for port in ports:
        if port_open("127.0.0.1", port):
            raise SystemExit(f"隔离端口 {port} 已被占用")


def configure_server_properties(server_dir: Path, game_port: int, rcon_port: int, password: str) -> None:
    path = server_dir / "server.properties"
    if not path.is_file():
        raise SystemExit("源服务器缺少 server.properties，无法安全配置隔离端口")
    values = {
        "server-port": str(game_port),
        "server-ip": "127.0.0.1",
        "enable-rcon": "true",
        "rcon.port": str(rcon_port),
        "rcon.password": password,
        "rcon.ip": "127.0.0.1",
    }
    lines = path.read_text(encoding="utf-8").splitlines()
    updated: list[str] = []
    seen: set[str] = set()
    for line in lines:
        key = line.partition("=")[0].strip()
        if key in values:
            if key not in seen:
                updated.append(f"{key}={values[key]}")
                seen.add(key)
        else:
            updated.append(line)
    for key, value in values.items():
        if key not in seen:
            updated.append(f"{key}={value}")
    path.write_text("\n".join(updated) + "\n", encoding="utf-8")


def create_isolated_studio_config(
    studio_dir: Path, studio_port: int, runtime_dir: Path | None = None
) -> Path:
    source = ROOT / "config/voxkin.yaml"
    if not source.is_file():
        raise SystemExit("找不到 config/voxkin.yaml，无法准备隔离 Studio")
    config = copy.deepcopy(yaml.safe_load(source.read_text(encoding="utf-8")) or {})
    if not isinstance(config, dict):
        raise SystemExit("config/voxkin.yaml 格式无效")
    llm = config.setdefault("llm", {})
    if isinstance(llm, dict):
        llm.pop("api_key", None)
        llm.pop("headers", None)
    server = config.setdefault("server", {})
    server.update({"host": "127.0.0.1", "port": studio_port})
    memory = config.setdefault("memory", {})
    memory["enabled"] = False
    audio = config.setdefault("audio", {})
    if isinstance(audio, dict):
        audio["output"] = "wav_dir"
        audio["wav_dir"] = str(((runtime_dir or studio_dir) / "audio_out").resolve())
    tts = config.get("tts", {})
    if isinstance(tts, dict):
        reference = tts.get("reference_audio")
        if reference and not Path(reference).is_absolute():
            tts["reference_audio"] = str((ROOT / reference).resolve())
    studio_dir.mkdir(parents=True, exist_ok=True)
    target = studio_dir / "voxkin.yaml"
    target.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return target



def continuation_manifest(server: Path, task_id: int) -> dict:
    db = server / ".voxkin-studio/data/tasks.db"
    world = server / "world"
    if not db.is_file() or not world.is_dir() or not (world / "level.dat").is_file():
        raise SystemExit("续跑来源缺少世界或任务数据库")
    connection = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT stage, status FROM tasks WHERE id=?", (task_id,)).fetchone()
        goal_row = connection.execute("SELECT payload FROM goal_states WHERE task_id=?", (task_id,)).fetchone()
        if not row or row[0] != "S3" or not goal_row:
            raise SystemExit("续跑 task 必须是存在的 S3 目标")
        goal = json.loads(goal_row[0])
        if goal.get("goal_id") != "stage:s3" or goal.get("status") not in {"paused_by_user", "disconnected", "preempted", "recovering", "waiting"}:
            raise SystemExit("S3 目标状态不允许隔离续跑")
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise SystemExit("续跑任务数据库校验失败")
    finally:
        connection.close()
    def digest(path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    files = {}
    for root in (server / "world", server / "world_nether", server / "world_the_end"):
        if root.is_dir():
            for path in sorted(root.rglob("*")):
                if path.is_file() and path.name != "session.lock":
                    files[path.relative_to(server).as_posix()] = digest(path)
    files[".voxkin-studio/data/tasks.db"] = digest(db)
    return {"task_id": task_id, "task_status": row[1], "goal_status": goal.get("status"),
            "deadline_at": goal.get("deadline_at"), "counters": goal.get("counters"),
            "pending_action": goal.get("pending_action"), "files": files}


def validate_continuation_source(args: argparse.Namespace) -> None:
    source = rooted_path(Path(args.isolate_from)).resolve()
    if (source / ".voxkin-studio/data/tasks.db-wal").exists():
        raise SystemExit("续跑来源存在 SQLite WAL；先停止并确认数据库完成检查点")
    properties = (source / "server.properties").read_text(encoding="utf-8").splitlines()
    for line in properties:
        if line.startswith("server-port="):
            if port_open("127.0.0.1", int(line.split("=", 1)[1])):
                raise SystemExit("续跑来源服务器端口仍被占用，拒绝复制")
            break
    args._source_continuation_manifest = continuation_manifest(source, args.continue_task)

def prepare_isolated(args: argparse.Namespace) -> None:
    source_value = getattr(args, "isolate_from", None)
    target_value = getattr(args, "isolate_target", None)
    if not source_value or not target_value:
        raise SystemExit("隔离模式必须同时指定 --isolate-from 和 --isolate-target")
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("隔离评测只允许连接本机服务器")
    game_port = getattr(args, "isolate_port", ISOLATED_GAME_PORT)
    rcon_port = getattr(args, "isolate_rcon_port", ISOLATED_RCON_PORT)
    studio_port = getattr(args, "isolate_studio_port", ISOLATED_STUDIO_PORT)
    validate_isolated_ports(game_port, rcon_port, studio_port)
    source, target = validate_isolated_paths(Path(source_value), Path(target_value))
    if not (source / "paper.jar").is_file():
        raise SystemExit("指定的源目录不是完整 Paper 服务端目录")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(f".{target.name}.preparing-{secrets.token_hex(6)}")
    try:
        shutil.copytree(source, staging)
        if args.rcon_password == "voxkin":
            args.rcon_password = secrets.token_urlsafe(24)
        if getattr(args, "continue_task", None):
            copied = continuation_manifest(staging, args.continue_task)
            current = continuation_manifest(source, args.continue_task)
            if copied != args._source_continuation_manifest or current != args._source_continuation_manifest:
                raise SystemExit("续跑复制前后来源或副本不一致")
        staging_studio_dir = staging / ".voxkin-studio"
        create_isolated_studio_config(staging_studio_dir, studio_port, target / ".voxkin-studio")
        configure_server_properties(staging, game_port, rcon_port, args.rcon_password)
        staging.rename(target)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise
    studio_dir = target / ".voxkin-studio"
    config_path = studio_dir / "voxkin.yaml"
    args.server_dir = str(target)
    args.port = game_port
    args.rcon_port = rcon_port
    args.studio = f"http://127.0.0.1:{studio_port}"
    args.isolated_mode = True
    args.isolated_studio_dir = studio_dir
    args.isolated_config_path = config_path
    print(f"隔离评测副本已准备: {target}", flush=True)


def studio_launch_command(python: Path, config_path: Path) -> list[str]:
    bootstrap = (
        "import asyncio,os,sys; from pathlib import Path; "
        "from voxkin.config import load_config; import voxkin.__main__ as app; "
        "config_path=Path(sys.argv[1]); app.DEFAULT_CONFIG_PATH=config_path; "
        "os.chdir(config_path.parent); "
        "asyncio.run(app.run_serve(load_config(config_path, with_local=False)))"
    )
    return [str(python), "-c", bootstrap, str(config_path)]


def isolated_studio_environment(source: dict[str, str]) -> dict[str, str]:
    env = dict(source)
    for key in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY"):
        env.pop(key, None)
    env["PYTHONUTF8"] = "1"
    return env


def node_version(node: str) -> str:
    """返回桥接使用的 Node 版本，评测记录里必须能追到具体运行时。"""
    try:
        completed = subprocess.run(
            [node, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except OSError as error:
        raise SystemExit(f"找不到 Node 可执行文件 {node}: {error}") from error
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout).strip()
        raise SystemExit(f"Node 不可用 {node}: {message}")
    return completed.stdout.strip()


def bridge_command(args: argparse.Namespace) -> list[str]:
    node_args = list(getattr(args, "node_args", []) or [])
    entry = getattr(args, "bridge_entry", None)
    return [getattr(args, "node", DEFAULT_NODE), *node_args, str(entry or "bridge/minecraft_bridge.js")]


def _owned_bridge_processes(args: argparse.Namespace) -> list[subprocess.Popen[bytes]]:
    processes = getattr(args, "_owned_bridge_processes", None)
    if processes is None:
        processes = []
        args._owned_bridge_processes = processes
    return processes


def _bridge_restart_history(args: argparse.Namespace) -> list[dict]:
    history = getattr(args, "_bridge_restart_history", None)
    if history is None:
        history = []
        args._bridge_restart_history = history
    return history


def _remember_owned_bridge_session(args: argparse.Namespace, info: dict) -> None:
    process = getattr(args, "_bridge_process", None)
    owned = getattr(args, "_owned_bridge_processes", [])
    if process is None or process.poll() is not None or not any(item is process for item in owned):
        return
    if not info.get("connected"):
        return
    state = info.get("state") or {}
    session_id = str(state.get("session_id") or "")
    if session_id:
        sessions = getattr(args, "_owned_bridge_session_ids", None)
        if sessions is None:
            sessions = {}
            args._owned_bridge_session_ids = sessions
        sessions[id(process)] = session_id


def _launch_bridge(args: argparse.Namespace) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["MC_PORT"] = str(args.port)
    env["MC_HOST"] = args.host
    env["VOXKIN_INDEPENDENT"] = "1"
    env["PYTHONUTF8"] = "1"
    if getattr(args, "isolated_mode", False):
        studio_host, studio_port = studio_endpoint(args.studio)
        env["VOXKIN_WS"] = f"ws://{studio_host}:{studio_port}/ws/bridge"
    logs = log_dir(args)
    out = (logs / "bridge.out.log").open("ab")
    err = (logs / "bridge.err.log").open("ab")
    node = getattr(args, "node", DEFAULT_NODE)
    print(f"bridge 运行时: {node} ({node_version(node)})", flush=True)
    process = subprocess.Popen(
        bridge_command(args),
        cwd=str(ROOT),
        stdout=out,
        stderr=err,
        env=env,
    )
    if getattr(args, "isolated_mode", False):
        _owned_bridge_processes(args).append(process)
        args._bridge_process = process
        starts = getattr(args, "_bridge_process_started_at", None)
        if starts is None:
            starts = {}
            args._bridge_process_started_at = starts
        starts[id(process)] = time.time()
    return process


def _status_allows_bridge_restart(
    args: argparse.Namespace,
    status: dict,
    phase: str,
) -> bool:
    if status.get("explicit_stop"):
        return False
    if is_schema2_goal_status(status):
        goal_status = str((status.get("goal") or {}).get("status") or "")
        if goal_status in GOAL_RECOVERABLE_STATUSES:
            return True
        if goal_status == "paused_by_user" and phase == "startup_wait":
            planned = getattr(args, "_planned_resume_task_id", None)
            try:
                return planned is not None and int(planned) == int(status.get("task_id"))
            except (TypeError, ValueError):
                return False
        return False
    return bool(status.get("running"))


def _current_run_status(args: argparse.Namespace) -> dict:
    try:
        return http_json(f"{args.studio}/api/run/status", timeout=5.0)
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return {}


def restart_exited_owned_bridge(
    args: argparse.Namespace,
    status: dict,
    phase: str,
) -> bool:
    """只重启本运行器拥有且异常退出的隔离 Bridge。"""
    if not getattr(args, "isolated_mode", False):
        return False
    process = getattr(args, "_bridge_process", None)
    owned = _owned_bridge_processes(args)
    if process is None or not any(item is process for item in owned):
        return False
    exitcode = process.poll()
    if exitcode is None:
        _remember_owned_bridge_session(args, bridge_state(args.studio))
        return False
    observed = getattr(args, "_observed_bridge_exits", None)
    if observed is None:
        observed = set()
        args._observed_bridge_exits = observed
    if id(process) in observed:
        return False

    used = int(getattr(args, "_bridge_restarts_used", 0))
    budget = max(0, int(getattr(args, "bridge_restarts", 0) or 0))
    attempt = used + 1
    starts = getattr(args, "_bridge_process_started_at", {})
    now = time.time()
    event = {
        "event": "bridge_process_exit",
        "phase": phase,
        "pid": getattr(process, "pid", None),
        "exitcode": exitcode,
        "exitcode_hex": f"0x{(int(exitcode) & 0xFFFFFFFF):08X}"
        if isinstance(exitcode, int) else None,
        "restart_attempt": None,
        "attempts_used": used,
        "attempt_limit": budget,
        "exit_time": now,
        "uptime_s": round(max(0.0, now - starts[id(process)]), 3)
        if id(process) in starts else None,
        "restarted": False,
    }
    history = _bridge_restart_history(args)
    if getattr(args, "_stage_stop_requested", False):
        observed.add(id(process))
        event["decision"] = "explicit_stop"
    elif isinstance(exitcode, int) and (exitcode & 0xFFFFFFFF) in {0xC0000005, 0x80000003}:
        observed.add(id(process))
        event["decision"] = "native_exit_no_retry"
        args._bridge_restart_blocked = event
    elif not _status_allows_bridge_restart(args, status, phase):
        observed.add(id(process))
        event["decision"] = "goal_not_recoverable"
    else:
        bridge_info = bridge_state(args.studio)
        if "connected" not in bridge_info:
            waiting = getattr(args, "_bridge_disconnect_wait_logged", None)
            if waiting is None:
                waiting = set()
                args._bridge_disconnect_wait_logged = waiting
            if id(process) not in waiting:
                waiting.add(id(process))
                event["decision"] = "bridge_disconnect_not_observed"
                history.append(event)
                print(json.dumps({"bridge_restart": event}, ensure_ascii=False), flush=True)
            return False
        if bridge_info.get("connected"):
            state = bridge_info.get("state") or {}
            connected_session = str(state.get("session_id") or "")
            sessions = getattr(args, "_owned_bridge_session_ids", {})
            previous_session = str(sessions.get(id(process)) or "")
            if previous_session and connected_session == previous_session:
                waiting = getattr(args, "_bridge_disconnect_wait_logged", None)
                if waiting is None:
                    waiting = set()
                    args._bridge_disconnect_wait_logged = waiting
                if id(process) not in waiting:
                    waiting.add(id(process))
                    event["decision"] = "old_session_still_connected"
                    event["connected_session_id"] = connected_session
                    history.append(event)
                    print(json.dumps({"bridge_restart": event}, ensure_ascii=False), flush=True)
                return False
            observed.add(id(process))
            event["decision"] = "bridge_session_already_connected"
            event["connected_session_id"] = connected_session
        else:
            observed.add(id(process))
            if used >= budget:
                event["decision"] = "restart_budget_exhausted"
                args._bridge_restart_blocked = event
            else:
                delay = min(
                    BRIDGE_RESTART_BASE_BACKOFF_S * (2 ** used),
                    BRIDGE_RESTART_MAX_BACKOFF_S,
                )
                event["backoff_s"] = delay
                event["decision"] = "restart_scheduled"
                event["restart_attempt"] = attempt
                args._bridge_restarts_used = attempt
                time.sleep(delay)
                event["restart_attempt_time"] = time.time()
                try:
                    replacement = _launch_bridge(args)
                except OSError as error:
                    event["decision"] = "restart_launch_failed"
                    event["error"] = str(error)
                    args._bridge_restart_blocked = event
                else:
                    event["restarted"] = True
                    event["restart_time"] = time.time()
                    event["replacement_pid"] = getattr(replacement, "pid", None)
    history.append(event)
    print(json.dumps({"bridge_restart": event}, ensure_ascii=False), flush=True)
    return bool(event["restarted"])


def _cleanup_error_record(resource: str, error: BaseException) -> dict[str, str]:
    return {
        "resource": resource,
        "error_type": type(error).__name__,
        "message": str(error),
    }


def stop_owned_bridge_processes(args: argparse.Namespace) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    seen: set[int] = set()
    for process in reversed(list(_owned_bridge_processes(args))):
        if id(process) in seen:
            continue
        seen.add(id(process))
        resource = "Bridge owned process"
        try:
            pid = getattr(process, "pid", None)
            if pid is not None:
                resource = f"Bridge pid={pid}"
            stop_process(process)
        except BaseException as error:
            errors.append(_cleanup_error_record(resource, error))
    return errors


def bridge_restart_failure_detail(event: dict) -> str:
    exitcode = event.get("exitcode_hex") or event.get("exitcode")
    decision = event.get("decision") or "unknown"
    return f"Bridge 进程退出且无法恢复（exitcode={exitcode}，{decision}）"


def ensure_studio(args: argparse.Namespace) -> subprocess.Popen[bytes] | None:
    """Studio 没起来就自己拉起来，评测脚本不依赖外部会话。"""
    studio_host, studio_port = studio_endpoint(args.studio)
    if port_open(studio_host, studio_port):
        if getattr(args, "isolated_mode", False):
            owned = getattr(args, "_studio_process", None)
            if owned is not None and owned.poll() is None:
                return owned
            raise SystemExit("隔离 Studio 端口已被占用；拒绝复用其他运行时")
        try:
            http_json(f"{args.studio}/api/status", timeout=5.0)
            return None
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            pass
    python = ROOT / ".venv/Scripts/python.exe"
    if not python.exists():
        raise SystemExit(f"找不到 {python}，先安装依赖")
    isolated = getattr(args, "isolated_mode", False)
    env = (
        isolated_studio_environment(os.environ)
        if isolated
        else {**os.environ, "PYTHONUTF8": "1"}
    )
    logs = log_dir(args)
    command = (
        studio_launch_command(python, Path(args.isolated_config_path))
        if isolated
        else [str(python), "-m", "voxkin", "serve"]
    )
    cwd = Path(args.isolated_studio_dir) if isolated else ROOT
    out = (logs / "studio.out.log").open("ab")
    err = (logs / "studio.err.log").open("ab")
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=out,
        stderr=err,
        env=env,
    )
    if isolated:
        args._studio_process = process
    deadline = time.time() + 90
    while time.time() < deadline:
        if port_open(studio_host, studio_port):
            print("studio 已启动")
            return process
        if process.poll() is not None:
            raise SystemExit("Studio 启动失败，见 work/logs/studio.err.log")
        time.sleep(1.0)
    raise SystemExit(f"Studio 没有在超时内监听 {studio_port}")


def ensure_bridge(args: argparse.Namespace) -> subprocess.Popen[bytes] | None:
    """桥接没连上就自己拉起来。"""
    initial_info = bridge_state(args.studio)
    _remember_owned_bridge_session(args, initial_info)
    current = getattr(args, "_bridge_process", None)
    owned = getattr(args, "_owned_bridge_processes", [])
    if current is not None and any(item is current for item in owned) and current.poll() is not None:
        restart_exited_owned_bridge(args, _current_run_status(args), "startup_wait")
        process = getattr(args, "_bridge_process", current)
    elif initial_info.get("connected"):
        return None
    else:
        process = _launch_bridge(args)
    deadline = time.time() + 30
    while time.time() < deadline:
        info = bridge_state(args.studio)
        _remember_owned_bridge_session(args, info)
        current = getattr(args, "_bridge_process", None)
        if current is not None and current.poll() is not None:
            if restart_exited_owned_bridge(args, _current_run_status(args), "startup_wait"):
                continue
            if getattr(args, "_bridge_restart_blocked", None) is not None:
                return current
            time.sleep(1.0)
            continue
        if info.get("connected"):
            print("bridge 已连接")
            return getattr(args, "_bridge_process", process)
        time.sleep(1.0)
    return getattr(args, "_bridge_process", process)


def stop_server(args: argparse.Namespace) -> None:
    if getattr(args, "isolated_mode", False):
        server_dir = Path(args.server_dir).resolve()
        mc_root = (ROOT / "work/mc").resolve()
        protected = [mc_root / name for name in PROTECTED_SERVER_NAMES]
        if not server_dir.is_relative_to(mc_root) or any(
            server_dir == item or item in server_dir.parents for item in protected
        ):
            raise SystemExit("隔离模式拒绝停止 work/mc/ 外部或受保护的服务器")
        process = getattr(args, "_isolated_server_process", None)
        if process is None or process.poll() is not None:
            if port_open(args.host, args.port):
                raise SystemExit("隔离游戏端口已有非本脚本启动的监听者；拒绝发送 RCON")
            return
    if port_open(args.host, args.port):
        try:
            rcon(args.host, args.rcon_port, args.rcon_password, "stop")
        except OSError as error:
            print(f"[warn] RCON 停止失败: {error}")
    deadline = time.time() + args.server_timeout
    while time.time() < deadline:
        if not port_open(args.host, args.port):
            return
        time.sleep(1.0)
    raise SystemExit("评测服务器没有在超时内停止")


def stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def reset_world(server_dir: Path, isolated: bool = False) -> None:
    resolved = server_dir.resolve()
    mc_root = (ROOT / "work/mc").resolve()
    protected = [mc_root / name for name in PROTECTED_SERVER_NAMES]
    if isolated and (not resolved.is_relative_to(mc_root) or any(
        resolved == item or item in resolved.parents for item in protected
    )):
        raise SystemExit(f"拒绝重置非隔离服务器世界: {resolved}")
    for name in ("world", "world_nether", "world_the_end"):
        target = server_dir / name
        if not target.exists():
            continue

        def on_error(func, path, _info):
            try:
                os.chmod(path, 0o666)
                func(path)
            except OSError:
                pass

        # 服务器刚停时可能还在写盘，删不掉就重试几次。
        for _ in range(6):
            try:
                shutil.rmtree(target, onerror=on_error)
                break
            except OSError:
                time.sleep(1.0)
        if target.exists():
            raise SystemExit(f"无法删除世界目录: {target}")


def start_server(args: argparse.Namespace) -> subprocess.Popen[bytes]:
    server_dir = Path(args.server_dir).resolve()
    log_dir = server_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = (log_dir / "run_stage_console.log").open("ab")
    process = subprocess.Popen(
        [str(args.java), "-Xms1G", "-Xmx2G", "-jar", "paper.jar", "--nogui"],
        cwd=str(server_dir),
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + args.server_timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit("评测服务器启动失败，见 logs/run_stage_console.log")
        if port_open(args.host, args.port):
            time.sleep(3.0)
            return process
        time.sleep(1.0)
    process.terminate()
    raise SystemExit("评测服务器没有在超时内监听端口")


def apply_world_rules(args: argparse.Namespace) -> None:
    commands = (
        f"difficulty {args.difficulty}",
        f"gamerule doMobSpawning {'false' if args.difficulty == 'peaceful' else 'true'}",
        "gamerule keepInventory false",
        "gamerule doDaylightCycle true",
        "time set day",
    )
    # RCON 监听比游戏端口晚一点，连接不上就重试。
    deadline = time.time() + args.server_timeout
    for command in commands:
        last_error: Exception | None = None
        while time.time() < deadline:
            try:
                rcon(args.host, args.rcon_port, args.rcon_password, command)
                last_error = None
                break
            except OSError as error:
                last_error = error
                time.sleep(2.0)
        if last_error is not None:
            raise SystemExit(f"RCON 命令执行失败: {command} ({last_error})")


def bridge_state(studio: str) -> dict:
    try:
        return http_json(f"{studio}/api/bridge/state", timeout=5.0)
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return {}


GOAL_RECOVERABLE_STATUSES = {
    "active", "waiting", "recovering", "dead", "disconnected", "unknown", "preempted",
}
GOAL_TERMINAL_STATUSES = {"blocked", "paused_by_user", "cancelled", "failed"}


def is_schema2_goal_status(status: dict) -> bool:
    goal = status.get("goal")
    if not isinstance(goal, dict):
        return False
    try:
        return int(goal.get("schema_version", 0)) >= 2
    except (TypeError, ValueError):
        return False


def goal_budget_exhausted(status: dict, now: float | None = None) -> tuple[bool, str]:
    """读取 Supervisor 持久化的动作/时间预算，不使用兼容游标。"""
    if not is_schema2_goal_status(status):
        return False, ""
    action_budget = status.get("action_budget") or {}
    try:
        used = int(action_budget.get("used", 0) or 0)
        limit = int(action_budget.get("limit", 0) or 0)
    except (TypeError, ValueError):
        used, limit = 0, 0
    if limit > 0 and used >= limit:
        return True, "目标动作预算耗尽"
    deadline_at = action_budget.get("deadline_at")
    if deadline_at is None:
        deadline_at = (status.get("goal") or {}).get("deadline_at")
    try:
        deadline = float(deadline_at)
    except (TypeError, ValueError):
        deadline = 0.0
    current = time.time() if now is None else float(now)
    if deadline > 0 and current >= deadline:
        return True, "目标执行时长预算耗尽"
    return False, ""


def _goal_recovery_signature(status: dict) -> tuple:
    goal = status.get("goal") or {}
    pending = goal.get("pending_action") or {}
    recovery = goal.get("recovery") or {}
    return (
        str(goal.get("status") or ""),
        str(recovery.get("reason") or ""),
        bool(recovery.get("needs_reconcile")),
        str(pending.get("action_id") or ""),
        str(pending.get("status") or ""),
    )


def _goal_recovery_record(status: dict, event: str) -> dict:
    goal = status.get("goal") or {}
    return {
        "ts": time.time(),
        "event": event,
        "task_id": status.get("task_id"),
        "goal_id": goal.get("goal_id"),
        "goal_status": goal.get("status"),
        "block_reason": goal.get("block_reason") or status.get("blocked_reason") or "",
        "recovery": goal.get("recovery") or {},
        "pending_action": goal.get("pending_action"),
        "action_budget": status.get("action_budget") or {},
    }


def _request_stage_stop_once(args: argparse.Namespace) -> None:
    if getattr(args, "_run_stop_sent", False):
        return
    args._run_stop_sent = True
    args._stage_stop_requested = True
    try:
        http_json(f"{args.studio}/api/run/stop", {}, timeout=15.0)
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        pass


def wait_for_stage_result(args: argparse.Namespace, stage: str, timeout_s: float) -> tuple[dict, list[dict], dict]:
    """等待 GoalSupervisor 的可恢复状态，并保留每次状态变化记录。"""
    status_url = f"{args.studio}/api/run/status"
    deadline = time.monotonic() + max(0.0, float(timeout_s))
    poll_interval = max(0.0, float(getattr(args, "poll_interval_s", 2.0)))
    recovery_history: list[dict] = []
    last_signature: tuple | None = None
    was_recovering = False
    last_status: dict = {}

    def record_resolution(status: dict, event: str) -> None:
        nonlocal was_recovering, last_signature
        if not was_recovering:
            return
        record = _goal_recovery_record(status, event)
        recovery_history.append(record)
        print(json.dumps({"stage": stage, "recovery": record}, ensure_ascii=False), flush=True)
        was_recovering = False
        last_signature = None

    while time.monotonic() < deadline:
        status = http_json(status_url, timeout=15.0)
        last_status = status
        restart_exited_owned_bridge(args, status, "stage_poll")

        goal = status.get("goal") if isinstance(status.get("goal"), dict) else {}
        goal_status = str(goal.get("status") or "")
        if is_schema2_goal_status(status) and goal_status == "done":
            record_resolution(status, "goal_completed_after_recovery")
            return status.get("result") or {
                "ok": True,
                "status": "done",
                "goal_id": goal.get("goal_id"),
                "detail": goal.get("detail") or "持久化目标已完成",
            }, recovery_history, status

        restart_block = getattr(args, "_bridge_restart_blocked", None)
        if restart_block is not None:
            # 已断线且执行器已退出时保留可恢复状态，不能冒充玩家请求停止。
            if status.get("running") or goal_status != "disconnected":
                _request_stage_stop_once(args)
            record = _goal_recovery_record(status, "bridge_restart_blocked")
            record["bridge_restart"] = restart_block
            recovery_history.append(record)
            print(json.dumps({"stage": stage, "recovery": record}, ensure_ascii=False), flush=True)
            was_recovering = False
            last_signature = None
            return {
                "ok": False,
                "status": "blocked",
                "goal_id": goal.get("goal_id"),
                "detail": bridge_restart_failure_detail(restart_block),
            }, recovery_history, status

        if status.get("running"):
            if was_recovering:
                record = _goal_recovery_record(status, "worker_resumed")
                recovery_history.append(record)
                print(json.dumps({"stage": stage, "recovery": record}, ensure_ascii=False), flush=True)
                was_recovering = False
                last_signature = None
            time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))
            continue

        # Legacy TaskRunner 保持线性结果契约；只有 schema 2 目标状态需要等待自动恢复。
        if not is_schema2_goal_status(status):
            record_resolution(status, "recovery_ended_without_goal_state")
            return status.get("result") or {
                "ok": False,
                "status": "stopped",
                "detail": "阶段执行器停止但没有结果",
            }, recovery_history, status

        exhausted, reason = goal_budget_exhausted(status)
        if exhausted:
            record_resolution(status, "goal_budget_exhausted")
            return {
                "ok": False,
                "status": "blocked",
                "detail": reason,
                "goal_id": goal.get("goal_id"),
            }, recovery_history, status
        if goal_status in GOAL_TERMINAL_STATUSES:
            record_resolution(status, "goal_terminal_after_recovery")
            return status.get("result") or {
                "ok": False,
                "status": goal_status,
                "goal_id": goal.get("goal_id"),
                "detail": goal.get("block_reason") or status.get("blocked_reason") or goal_status,
            }, recovery_history, status
        if goal_status not in GOAL_RECOVERABLE_STATUSES:
            record_resolution(status, "goal_status_not_recoverable")
            return {
                "ok": False,
                "status": goal_status or "stopped",
                "goal_id": goal.get("goal_id"),
                "detail": goal.get("block_reason") or f"未知 GoalSupervisor 终态: {goal_status}",
            }, recovery_history, status

        signature = _goal_recovery_signature(status)
        if signature != last_signature:
            record = _goal_recovery_record(status, "worker_interrupted")
            record["bridge"] = bridge_state(args.studio)
            recovery_history.append(record)
            print(json.dumps({"stage": stage, "recovery": record}, ensure_ascii=False), flush=True)
            last_signature = signature
        was_recovering = True
        time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))

    # 阶段超时是运行器明确设置的墙钟预算；只停止当前阶段，并返回此前收集的恢复记录。
    _request_stage_stop_once(args)
    record_resolution(last_status, "stage_timeout")
    return {
        "ok": False,
        "status": "timeout",
        "detail": "阶段超时",
    }, recovery_history, last_status


def studio_bridge_ready(studio: str) -> bool:
    return bool(bridge_state(studio).get("connected"))


def wait_for_bridge(
    studio: str,
    timeout: float = 120.0,
    args: argparse.Namespace | None = None,
) -> bool:
    """服务器重启后桥接会自动重连，等它带着新状态帧回来再开始阶段。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        info = bridge_state(studio)
        if args is not None:
            _remember_owned_bridge_session(args, info)
            current = getattr(args, "_bridge_process", None)
            if current is not None and current.poll() is not None:
                if restart_exited_owned_bridge(args, _current_run_status(args), "startup_wait"):
                    continue
                if getattr(args, "_bridge_restart_blocked", None) is not None:
                    return False
                time.sleep(2.0)
                continue
        state = info.get("state") or {}
        try:
            health = float(state.get("health"))
        except (TypeError, ValueError):
            health = 0.0
        if (
            info.get("connected") is True
            and info.get("ready") is True
            and state.get("ready") is True
            and state.get("alive") is True
            and health > 0
            and float(info.get("age_s", 99)) < 15
        ):
            return True
        time.sleep(2.0)
    return False


def run_once(args: argparse.Namespace, index: int) -> dict:
    ensure_studio(args)
    ensure_bridge(args)
    restart_block = getattr(args, "_bridge_restart_blocked", None)
    if restart_block is not None:
        return {
            "index": index,
            "stage": args.stage,
            "difficulty": args.difficulty,
            "ok": False,
            "status": "blocked",
            "duration_s": 0.0,
            "steps_done": 0,
            "steps_total": 0,
            "detail": bridge_restart_failure_detail(restart_block),
        }
    stop_server(args)
    if not getattr(args, "continue_task", None):
        reset_world(Path(args.server_dir).resolve(), isolated=getattr(args, "isolated_mode", False))
    process = start_server(args)
    if getattr(args, "isolated_mode", False):
        args._isolated_server_process = process
    if not getattr(args, "continue_task", None):
        apply_world_rules(args)
    if getattr(args, "isolated_mode", False):
        args._isolated_server_started = True
    if not wait_for_bridge(args.studio, args=args):
        print(f"[{index}/{args.runs}] 桥接没有连上评测服务器")
        restart_block = getattr(args, "_bridge_restart_blocked", None)
        return {
            "index": index,
            "stage": args.stage,
            "difficulty": args.difficulty,
            "ok": False,
            "status": "blocked" if restart_block is not None else "bridge_unavailable",
            "duration_s": 0.0,
            "steps_done": 0,
            "steps_total": 0,
            "detail": bridge_restart_failure_detail(restart_block)
            if restart_block is not None else "桥接未连接",
        }
    stages = stages_for(args)
    stage_records = []
    total_started = time.time()
    night = 0
    for stage in stages:
        stage_label = stage
        if stage == "M3_SLEEP":
            night += 1
            stage_label = f"M3_SLEEP_{night}"
            rcon(args.host, args.rcon_port, args.rcon_password, "time set night")
            rcon(args.host, args.rcon_port, args.rcon_password, "weather clear")
        started = time.time()
        if getattr(args, "continue_task", None) and stage == "S3":
            http_json(f"{args.studio}/api/run/resume", {"task_id": args.continue_task}, timeout=15.0)
        else:
            http_json(f"{args.studio}/api/run/start", {"stage": stage}, timeout=15.0)
        result, recovery_history, final_status = wait_for_stage_result(args, stage, args.stage_timeout)
        final_goal = final_status.get("goal") if isinstance(final_status.get("goal"), dict) else {}
        stage_records.append({
            "stage": stage_label,
            "ok": bool(result.get("ok")),
            "duration_s": round(time.time() - started, 1),
            "status": result.get("status"),
            "steps_done": result.get("steps_done", result.get("method_index", result.get("cursor"))),
            "steps_total": result.get("steps_total"),
            "detail": result.get("detail"),
            "goal_id": final_goal.get("goal_id"),
            "goal_status": final_goal.get("status"),
            "goal_method_index": final_goal.get("method_index"),
            "stage_complete": final_status.get("stage_complete"),
            "final_goal_state": final_goal,
            "recovery_history": recovery_history,
        })
        print(json.dumps(stage_records[-1], ensure_ascii=False), flush=True)
        if not stage_records[-1]["ok"]:
            break
    result = stage_records[-1] if stage_records else {"ok": False, "detail": "没有执行阶段"}
    started = total_started
    duration = time.time() - started
    record = {
        "index": index,
        "stage": (
            "S3→S4（续跑）"
            if getattr(args, "continue_task", None)
            else "S0→S1→S2→S3→S4"
            if getattr(args, "chain_s0_s4", False)
            else "S0→S1→S2→S3→S4→S5→S6"
            if getattr(args, "chain_s0_s6", False)
            else "S0→S1→S2→三夜"
            if getattr(args, "chain_survival", False)
            else args.stage
        ),
        "difficulty": args.difficulty,
        "ok": all(item["ok"] for item in stage_records),
        "duration_s": round(duration, 1),
        "steps_done": result.get("steps_done"),
        "steps_total": result.get("steps_total"),
        "detail": result.get("detail"),
        "stages": stage_records,
    }
    print(
        f"[{time.strftime('%H:%M:%S')}] [{index}/{args.runs}] "
        f"{'通过' if record['ok'] else '失败'} "
        f"{record['duration_s']}s {record['steps_done']}/{record['steps_total']} {record['detail']}",
        flush=True,
    )
    return record


def stages_for(args: argparse.Namespace) -> tuple[str, ...]:
    if getattr(args, "continue_task", None):
        return ("S3", "S4")
    if getattr(args, "chain_s0_s6", False):
        return tuple(f"S{stage}" for stage in range(7))
    if getattr(args, "chain_s0_s4", False):
        return tuple(f"S{stage}" for stage in range(5))
    return (
        ("S0", "S1", "S2", "M3_SHELTER", "M3_SLEEP", "M3_SLEEP", "M3_SLEEP", "M3_EXIT")
        if getattr(args, "chain_survival", False)
        else (args.stage,)
    )


def configure_isolated_run(args: argparse.Namespace) -> None:
    args.runs = 1
    if getattr(args, "chain_s0_s6", False):
        args.stage_timeout = max(args.stage_timeout, 3600.0)
    elif getattr(args, "chain_survival", False):
        args.stage_timeout = max(args.stage_timeout, 2700.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument("--stage", default="S0", help="阶段名，对应 agent.plans.PLANS")
    parser.add_argument("--runs", type=int, default=10, help="重复次数")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=25566, help="评测服务器端口")
    parser.add_argument("--rcon-port", type=int, default=25576)
    parser.add_argument("--rcon-password", default="voxkin")
    parser.add_argument("--server-dir", default=str(ROOT / "work/mc/eval_server"))
    parser.add_argument("--studio", default="http://127.0.0.1:8765")
    parser.add_argument("--difficulty", default="normal", choices=["peaceful", "easy", "normal", "hard"])
    parser.add_argument("--stage-timeout", type=float, default=900.0, help="单次阶段超时（秒）")
    parser.add_argument("--server-timeout", type=float, default=120.0, help="服务器启停超时（秒）")
    parser.add_argument("--java", default=str(DEFAULT_JAVA))
    parser.add_argument(
        "--node",
        default=DEFAULT_NODE,
        help="桥接使用的 Node 可执行文件，也可用 VOXKIN_NODE 指定",
    )
    parser.add_argument(
        "--node-arg",
        action="append",
        default=[],
        dest="node_args",
        help="只传给 Bridge 的 Node 参数；可重复指定，例如 --node-arg=--jitless",
    )
    parser.add_argument("--bridge-entry", help="隔离评测使用的 Bridge 入口，仅允许 work/ 下的独立副本")
    parser.add_argument(
        "--bridge-restarts",
        type=int,
        default=0,
        help="隔离模式下 runner-owned Bridge 的意外退出重启次数；默认 0",
    )
    parser.add_argument("--continue-task", type=int, help="仅隔离模式：恢复复制的 S3 task，验收后继续 S4")
    parser.add_argument("--isolate-from", help="隔离评测的源服务器目录；启用后只运行副本")
    parser.add_argument("--isolate-target", help="新隔离副本路径，必须位于 work/mc/ 且不存在")
    parser.add_argument("--isolate-port", type=int, default=ISOLATED_GAME_PORT)
    parser.add_argument("--isolate-rcon-port", type=int, default=ISOLATED_RCON_PORT)
    parser.add_argument("--isolate-studio-port", type=int, default=ISOLATED_STUDIO_PORT)
    parser.add_argument("--chain-survival", action="store_true", help="同一世界连续执行 S0→S1→S2")
    parser.add_argument(
        "--chain-s0-s4",
        action="store_true",
        help="仅隔离模式：同一世界从 S0 连续执行到 S4；任一阶段失败即停止",
    )
    parser.add_argument(
        "--chain-s0-s6",
        action="store_true",
        help="仅隔离模式：同一世界从 S0 连续执行到 S6；任一阶段失败即停止",
    )
    parser.add_argument("--output", type=Path, default=None, help="汇总 JSON 输出路径")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    if getattr(args, "bridge_entry", None):
        if not (args.isolate_from and args.isolate_target):
            raise SystemExit("--bridge-entry 只允许隔离评测")
        entry = rooted_path(Path(args.bridge_entry)).resolve()
        if not entry.is_relative_to((ROOT / "work").resolve()) or not entry.is_file():
            raise SystemExit("--bridge-entry 必须是 work/ 下已存在的文件")
        args.bridge_entry = str(entry)

    if getattr(args, "continue_task", None) is not None:
        if args.continue_task < 1 or not (args.isolate_from and args.isolate_target):
            raise SystemExit("--continue-task 必须指定正 task ID 和隔离来源/目标")
        if args.chain_s0_s4 or args.chain_s0_s6 or args.chain_survival:
            raise SystemExit("--continue-task 不能与新世界连跑选项混用")
        validate_continuation_source(args)
        args._planned_resume_task_id = args.continue_task
    if args.chain_s0_s6 and not (args.isolate_from and args.isolate_target):
        raise SystemExit("S0→S6 全流程只允许在新建隔离服务器副本中运行")
    if args.chain_s0_s4 and not (args.isolate_from and args.isolate_target):
        raise SystemExit("S0→S4 连跑只允许在新建隔离服务器副本中运行")
    if args.bridge_restarts < 0:
        raise SystemExit("--bridge-restarts 不能小于 0")
    if args.isolate_from or args.isolate_target:
        prepare_isolated(args)
        configure_isolated_run(args)

    studio_process = None
    bridge_process = None
    records: list[dict] = []
    cleanup_errors: list[dict[str, str]] = []
    try:
        studio_process = ensure_studio(args)
        bridge_process = ensure_bridge(args)
        for index in range(1, args.runs + 1):
            records.append(run_once(args, index))
    finally:
        primary_error = sys.exc_info()[1]
        if getattr(args, "isolated_mode", False):
            if getattr(args, "_isolated_server_process", None) is not None:
                try:
                    stop_server(args)
                except BaseException as error:
                    cleanup_errors.append(_cleanup_error_record("Paper server", error))
            try:
                cleanup_errors.extend(stop_owned_bridge_processes(args))
            except BaseException as error:
                cleanup_errors.append(_cleanup_error_record("Bridge owned processes", error))
            try:
                stop_process(studio_process or getattr(args, "_studio_process", None))
            except BaseException as error:
                cleanup_errors.append(_cleanup_error_record("Studio", error))
        if cleanup_errors:
            args._cleanup_errors = list(cleanup_errors)
            for error in cleanup_errors:
                print(
                    f"[warn] 隔离资源清理失败: {json.dumps(error, ensure_ascii=False)}",
                    file=sys.stderr,
                    flush=True,
                )
            if primary_error is not None:
                try:
                    primary_error.cleanup_errors = list(cleanup_errors)
                except BaseException:
                    pass

    passed = [item for item in records if item["ok"]]
    durations = sorted(item["duration_s"] for item in passed)
    summary = {
        "stage": (
            "S3→S4（续跑）"
            if getattr(args, "continue_task", None)
            else "S0→S1→S2→S3→S4→S5→S6"
            if getattr(args, "chain_s0_s6", False)
            else "S0→S1→S2→S3→S4"
            if getattr(args, "chain_s0_s4", False)
            else "S0→S1→S2→三夜"
            if getattr(args, "chain_survival", False)
            else args.stage
        ),
        "difficulty": args.difficulty,
        "node": {
            "path": args.node,
            "args": list(args.node_args),
            "version": node_version(args.node),
            "bridge_entry": str(getattr(args, "bridge_entry", None) or "bridge/minecraft_bridge.js"),
        },
        "bridge_restart_budget": args.bridge_restarts,
        "bridge_restart_history": list(getattr(args, "_bridge_restart_history", [])),
        "cleanup_errors": list(cleanup_errors),
        "runs": len(records),
        "passed": len(passed),
        "success_rate": round(len(passed) / len(records), 3) if records else 0.0,
        "p50_s": durations[len(durations) // 2] if durations else None,
        "min_s": durations[0] if durations else None,
        "max_s": durations[-1] if durations else None,
        "records": records,
    }
    if getattr(args, "continue_task", None):
        source_after = continuation_manifest(rooted_path(Path(args.isolate_from)).resolve(), args.continue_task)
        summary["continuation"] = {
            "source": str(rooted_path(Path(args.isolate_from)).resolve()),
            "target": str(Path(args.server_dir).resolve()),
            "source_before": args._source_continuation_manifest,
            "source_unchanged": source_after == args._source_continuation_manifest,
        }
    registry = (
        Path(args.isolated_studio_dir) / "runs/registry"
        if getattr(args, "isolated_mode", False)
        else ROOT / "runs/registry"
    )
    registry.mkdir(parents=True, exist_ok=True)
    target = args.output.resolve() if args.output is not None else registry / f"{args.stage}-{int(time.time())}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\n{summary['stage']} {args.difficulty}: {summary['passed']}/{summary['runs']} "
        f"通过，P50 {summary['p50_s']}s，汇总写入 {target}"
    )
    return 0 if summary["passed"] == summary["runs"] and not cleanup_errors else 1


if __name__ == "__main__":
    sys.exit(main())
