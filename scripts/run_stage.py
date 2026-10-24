# 在固定 seed 的评测服务器上重复跑一个阶段，统计成功率与用时。
# 用法：.\.venv\Scripts\python.exe scripts\run_stage.py --stage S0 --runs 10
# 脚本重置评测世界、重启 Paper、按难度设置世界规则，然后通过 /api/run/start
# 触发阶段并轮询 /api/run/status 直到结束。每次运行的原始 JSONL 留在 runs/，
# 汇总写到 runs/registry/。

from __future__ import annotations

import argparse
import copy
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
    if bridge_state(args.studio).get("connected"):
        return None
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
        [node, "bridge/minecraft_bridge.js"],
        cwd=str(ROOT),
        stdout=out,
        stderr=err,
        env=env,
    )
    if getattr(args, "isolated_mode", False):
        args._bridge_process = process
    deadline = time.time() + 30
    while time.time() < deadline:
        if bridge_state(args.studio).get("connected"):
            print("bridge 已连接")
            return process
        time.sleep(1.0)
    return process


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


def studio_bridge_ready(studio: str) -> bool:
    return bool(bridge_state(studio).get("connected"))


def wait_for_bridge(studio: str, timeout: float = 120.0) -> bool:
    """服务器重启后桥接会自动重连，等它带着新状态帧回来再开始阶段。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        info = bridge_state(studio)
        state = info.get("state") or {}
        try:
            health = float(state.get("health"))
        except (TypeError, ValueError):
            health = 0.0
        if (
            info.get("connected")
            and info.get("ready")
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
    stop_server(args)
    reset_world(Path(args.server_dir).resolve(), isolated=getattr(args, "isolated_mode", False))
    process = start_server(args)
    if getattr(args, "isolated_mode", False):
        args._isolated_server_process = process
    apply_world_rules(args)
    if getattr(args, "isolated_mode", False):
        args._isolated_server_started = True
    if not wait_for_bridge(args.studio):
        print(f"[{index}/{args.runs}] 桥接没有连上评测服务器")
        return {
            "index": index,
            "stage": args.stage,
            "difficulty": args.difficulty,
            "ok": False,
            "duration_s": 0.0,
            "steps_done": 0,
            "steps_total": 0,
            "detail": "桥接未连接",
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
        http_json(f"{args.studio}/api/run/start", {"stage": stage}, timeout=15.0)
        deadline = started + args.stage_timeout
        result: dict = {}
        while time.time() < deadline:
            status = http_json(f"{args.studio}/api/run/status", timeout=15.0)
            if not status.get("running"):
                result = status.get("result") or {}
                break
            time.sleep(2.0)
        else:
            http_json(f"{args.studio}/api/run/stop", {}, timeout=15.0)
            result = {"ok": False, "detail": "阶段超时"}
        stage_records.append({
            "stage": stage_label,
            "ok": bool(result.get("ok")),
            "duration_s": round(time.time() - started, 1),
            "steps_done": result.get("steps_done"),
            "steps_total": result.get("steps_total"),
            "detail": result.get("detail"),
        })
        print(json.dumps(stage_records[-1], ensure_ascii=False), flush=True)
        if not stage_records[-1]["ok"]:
            break
    result = stage_records[-1] if stage_records else {"ok": False, "detail": "没有执行阶段"}
    started = total_started
    duration = time.time() - started
    record = {
        "index": index,
        "stage": "S0→S1→S2→三夜" if getattr(args, "chain_survival", False) else args.stage,
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
    if getattr(args, "chain_s0_s6", False):
        return tuple(f"S{stage}" for stage in range(7))
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


def main() -> int:
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
    parser.add_argument("--isolate-from", help="隔离评测的源服务器目录；启用后只运行副本")
    parser.add_argument("--isolate-target", help="新隔离副本路径，必须位于 work/mc/ 且不存在")
    parser.add_argument("--isolate-port", type=int, default=ISOLATED_GAME_PORT)
    parser.add_argument("--isolate-rcon-port", type=int, default=ISOLATED_RCON_PORT)
    parser.add_argument("--isolate-studio-port", type=int, default=ISOLATED_STUDIO_PORT)
    parser.add_argument("--chain-survival", action="store_true", help="同一世界连续执行 S0→S1→S2")
    parser.add_argument(
        "--chain-s0-s6",
        action="store_true",
        help="仅隔离模式：同一世界从 S0 连续执行到 S6；任一阶段失败即停止",
    )
    parser.add_argument("--output", type=Path, default=None, help="汇总 JSON 输出路径")
    args = parser.parse_args()

    if args.chain_s0_s6 and not (args.isolate_from and args.isolate_target):
        raise SystemExit("S0→S6 全流程只允许在新建隔离服务器副本中运行")
    if args.isolate_from or args.isolate_target:
        prepare_isolated(args)
        configure_isolated_run(args)

    studio_process = None
    bridge_process = None
    records: list[dict] = []
    try:
        studio_process = ensure_studio(args)
        bridge_process = ensure_bridge(args)
        for index in range(1, args.runs + 1):
            records.append(run_once(args, index))
    finally:
        if getattr(args, "isolated_mode", False):
            if getattr(args, "_isolated_server_process", None) is not None:
                try:
                    stop_server(args)
                except (Exception, SystemExit) as error:
                    print(f"[warn] 停止隔离服务器失败: {error}", flush=True)
            stop_process(bridge_process or getattr(args, "_bridge_process", None))
            stop_process(studio_process or getattr(args, "_studio_process", None))

    passed = [item for item in records if item["ok"]]
    durations = sorted(item["duration_s"] for item in passed)
    summary = {
        "stage": (
            "S0→S1→S2→S3→S4→S5→S6"
            if getattr(args, "chain_s0_s6", False)
            else "S0→S1→S2→三夜"
            if getattr(args, "chain_survival", False)
            else args.stage
        ),
        "difficulty": args.difficulty,
        "node": {"path": args.node, "version": node_version(args.node)},
        "runs": len(records),
        "passed": len(passed),
        "success_rate": round(len(passed) / len(records), 3) if records else 0.0,
        "p50_s": durations[len(durations) // 2] if durations else None,
        "min_s": durations[0] if durations else None,
        "max_s": durations[-1] if durations else None,
        "records": records,
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
    return 0 if summary["passed"] == summary["runs"] else 1


if __name__ == "__main__":
    sys.exit(main())
