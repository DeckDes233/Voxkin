# 在固定 seed 的评测服务器上重复跑一个阶段，统计成功率与用时。
# 用法：.\.venv\Scripts\python.exe scripts\run_stage.py --stage S0 --runs 10
# 脚本重置评测世界、重启 Paper、按难度设置世界规则，然后通过 /api/run/start
# 触发阶段并轮询 /api/run/status 直到结束。每次运行的原始 JSONL 留在 runs/，
# 汇总写到 runs/registry/。

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESCRIPTION = "在固定 seed 的评测服务器上重复跑一个阶段，统计成功率与用时"
_ENV_JAVA = os.environ.get("MINECRAFT_RUNTIME_JAVA", "").strip()
DEFAULT_JAVA = (
    Path(_ENV_JAVA)
    if _ENV_JAVA
    else Path.home() / "AppData/Roaming/.minecraft/runtime/java-runtime-delta/bin/java.exe"
)


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


def log_dir() -> Path:
    target = ROOT / "work/logs"
    target.mkdir(parents=True, exist_ok=True)
    return target


def ensure_studio(args: argparse.Namespace) -> subprocess.Popen[bytes] | None:
    """Studio 没起来就自己拉起来，评测脚本不依赖外部会话。"""
    if port_open("127.0.0.1", 8765):
        try:
            http_json(f"{args.studio}/api/status", timeout=5.0)
            return None
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            pass
    python = ROOT / ".venv/Scripts/python.exe"
    if not python.exists():
        raise SystemExit(f"找不到 {python}，先安装依赖")
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    out = (log_dir() / "studio.out.log").open("ab")
    err = (log_dir() / "studio.err.log").open("ab")
    process = subprocess.Popen(
        [str(python), "-m", "voxkin", "serve"],
        cwd=str(ROOT),
        stdout=out,
        stderr=err,
        env=env,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if port_open("127.0.0.1", 8765):
            print("studio 已启动")
            return process
        if process.poll() is not None:
            raise SystemExit("Studio 启动失败，见 work/logs/studio.err.log")
        time.sleep(1.0)
    raise SystemExit("Studio 没有在超时内监听 8765")


def ensure_bridge(args: argparse.Namespace) -> subprocess.Popen[bytes] | None:
    """桥接没连上就自己拉起来。"""
    if bridge_state(args.studio).get("connected"):
        return None
    env = os.environ.copy()
    env["MC_PORT"] = str(args.port)
    env["MC_HOST"] = args.host
    env["VOXKIN_INDEPENDENT"] = "1"
    env["PYTHONUTF8"] = "1"
    out = (log_dir() / "bridge.out.log").open("ab")
    err = (log_dir() / "bridge.err.log").open("ab")
    process = subprocess.Popen(
        ["node", "bridge/minecraft_bridge.js"],
        cwd=str(ROOT),
        stdout=out,
        stderr=err,
        env=env,
    )
    deadline = time.time() + 30
    while time.time() < deadline:
        if bridge_state(args.studio).get("connected"):
            print("bridge 已连接")
            return process
        time.sleep(1.0)
    return process


def stop_server(args: argparse.Namespace) -> None:
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


def reset_world(server_dir: Path) -> None:
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
        if info.get("connected") and info.get("ready") and float(info.get("age_s", 99)) < 15:
            return True
        time.sleep(2.0)
    return False


def run_once(args: argparse.Namespace, index: int) -> dict:
    ensure_studio(args)
    ensure_bridge(args)
    stop_server(args)
    reset_world(Path(args.server_dir).resolve())
    process = start_server(args)
    apply_world_rules(args)
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
    started = time.time()
    http_json(f"{args.studio}/api/run/start", {"stage": args.stage}, timeout=15.0)
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
    duration = time.time() - started
    record = {
        "index": index,
        "stage": args.stage,
        "difficulty": args.difficulty,
        "ok": bool(result.get("ok")),
        "duration_s": round(duration, 1),
        "steps_done": result.get("steps_done"),
        "steps_total": result.get("steps_total"),
        "detail": result.get("detail"),
    }
    print(
        f"[{time.strftime('%H:%M:%S')}] [{index}/{args.runs}] "
        f"{'通过' if record['ok'] else '失败'} "
        f"{record['duration_s']}s {record['steps_done']}/{record['steps_total']} {record['detail']}",
        flush=True,
    )
    return record


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
    args = parser.parse_args()

    ensure_studio(args)
    ensure_bridge(args)

    records: list[dict] = []
    for index in range(1, args.runs + 1):
        records.append(run_once(args, index))

    passed = [item for item in records if item["ok"]]
    durations = sorted(item["duration_s"] for item in passed)
    summary = {
        "stage": args.stage,
        "difficulty": args.difficulty,
        "runs": len(records),
        "passed": len(passed),
        "success_rate": round(len(passed) / len(records), 3) if records else 0.0,
        "p50_s": durations[len(durations) // 2] if durations else None,
        "min_s": durations[0] if durations else None,
        "max_s": durations[-1] if durations else None,
        "records": records,
    }
    registry = ROOT / "runs/registry"
    registry.mkdir(parents=True, exist_ok=True)
    target = registry / f"{args.stage}-{int(time.time())}.json"
    target.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\n{args.stage} {args.difficulty}: {summary['passed']}/{summary['runs']} "
        f"通过，P50 {summary['p50_s']}s，汇总写入 {target.relative_to(ROOT)}"
    )
    return 0 if summary["passed"] == summary["runs"] else 1


if __name__ == "__main__":
    sys.exit(main())
