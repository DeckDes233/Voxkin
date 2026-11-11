import argparse
import asyncio
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = ROOT / "work/refactor_validation_20261027/active_progress.json"
NODE = ROOT / "work/runtimes/node-v22.23.4-win-x64/node.exe"
BRIDGE = ROOT / "bridge/minecraft_bridge.js"
WORK = ROOT / "work/quickstart_player"
STUDIO = "http://127.0.0.1:8765"


def alive(pid, expected_image=None):
    if not pid:
        return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))
    kernel.QueryFullProcessImageNameW.argtypes = (ctypes.c_void_p, ctypes.c_uint32, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32))
    kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel.OpenProcess(0x1000, False, int(pid))
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:
            return False
        raise OSError(error, f"无法检查进程 {pid}")
    try:
        code = ctypes.c_uint32()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        if code.value != 259:
            return False
        if expected_image:
            buffer = ctypes.create_unicode_buffer(32768)
            size = ctypes.c_uint32(len(buffer))
            if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                raise ctypes.WinError(ctypes.get_last_error())
            return os.path.normcase(os.path.abspath(buffer.value)) == os.path.normcase(os.path.abspath(str(expected_image)))
        return True
    finally:
        kernel.CloseHandle(handle)


def get_json(path):
    try:
        with urllib.request.urlopen(STUDIO + path, timeout=2) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        return None


def listening(host, port):
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def write_marker(marker):
    MARKER.parent.mkdir(parents=True, exist_ok=True)
    temp = MARKER.with_name(MARKER.name + ".quickstart.tmp")
    temp.write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, MARKER)


def launch(command, cwd, env, log_prefix):
    out = open(str(log_prefix) + ".out.log", "ab")
    err = open(str(log_prefix) + ".err.log", "ab")
    try:
        return subprocess.Popen(command, cwd=str(cwd), env=env, stdout=out, stderr=err,
                                creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
    finally:
        out.close()
        err.close()


def run_core(workspace):
    from voxkin.__main__ import run_serve
    from voxkin.config import load_config
    config = load_config()
    # 对话记忆继续使用仓库配置；任务数据库留在本次会话目录。
    memory = Path(config.memory.db_path)
    if not memory.is_absolute():
        config.memory.db_path = str(ROOT / memory)
    reference = config.tts.reference_audio
    if reference and not Path(reference).is_absolute():
        config.tts.reference_audio = str(ROOT / reference)
    os.chdir(workspace)
    asyncio.run(run_serve(config))


def start_bridge_monitor(pid, workspace, host, port, env):
    launch([sys.executable, str(Path(__file__).resolve()), "--watch-bridge", str(pid),
            "--host", host, "--port", str(port)], ROOT, env, workspace / "bridge_monitor")


def watch_bridge(pid, host, port):
    import msvcrt
    from bridge_watch import monitor

    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / "watch.lock").open("a+b") as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return 0
        try:
            return monitor(pid, host, port)
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def main():
    parser = argparse.ArgumentParser(description="将 Voxkin 连接到本机 Minecraft 世界")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=25565)
    parser.add_argument("--resume-current", action="store_true", help="恢复同一世界已有的 Voxkin 任务")
    parser.add_argument("--core-workspace", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--watch-bridge", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--watch-reconnect-pid", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--no-watch", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.core_workspace:
        run_core(args.core_workspace.resolve())
        return 0
    if os.name != "nt":
        raise SystemExit("这个快速启动命令需要 Windows。")
    if args.watch_bridge:
        return watch_bridge(args.watch_bridge, args.host, args.port)
    import msvcrt
    WORK.mkdir(parents=True, exist_ok=True)
    # 防止同时启动两个命令时重复登录同一角色。
    with (WORK / "launch.lock").open("a+b") as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit("另一条 Voxkin 启动命令正在运行，请稍候。") from None
        try:
            return start_player(args)
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def start_player(args):
    if not 1 <= args.port <= 65535:
        raise SystemExit("Minecraft 端口无效。")
    if not listening(args.host, args.port):
        raise SystemExit(f"无法连接 Minecraft {args.host}:{args.port}，请先开启服务器或局域网世界。")
    marker = json.loads(MARKER.read_text(encoding="utf-8-sig")) if MARKER.exists() else {}
    current = marker.get("user_world_25565_run") or {}
    target = f"{args.host}:{args.port}"
    same = current.get("target") in {target, "user-provided " + target}
    bridge_state = get_json("/api/bridge/state")
    if bridge_state and bridge_state.get("connected"):
        if same and alive(current.get("bridge_pid"), NODE):
            print(f"Voxkin 已连接 {target}，Studio：{STUDIO}")
            return 0
        raise SystemExit("Studio 已连接其他或无法确认身份的 Bridge，未启动第二个机器人。")

    if marker.get("runtime_blocked") is True:
        raise SystemExit("当前运行环境仍标记为 blocked，需要先核对恢复证据和验证安排；未启动 Minecraft。")

    watch_reconnect = args.watch_reconnect_pid is not None
    if watch_reconnect:
        recorded_pid = current.get("bridge_pid")
        if not (
            args.resume_current
            and same
            and marker.get("runtime_active") is True
            and marker.get("cleanup_pending") is True
            and recorded_pid == args.watch_reconnect_pid
            and not alive(recorded_pid, NODE)
        ):
            raise SystemExit("Bridge 监护进程的重连凭据与活动标记不匹配，未启动新进程。")

    if marker.get("cleanup_pending") is True and not watch_reconnect:
        raise SystemExit("清理仍未完成，未启动新的 Minecraft 运行。")
    if marker.get("runtime_active") is True and not same:
        raise SystemExit("已有其他 Minecraft 运行或清理未完成，请先检查活动标记。")
    if marker.get("runtime_active") is True and not (args.resume_current or watch_reconnect):
        raise SystemExit("已有活动运行；恢复当前任务请使用 --resume-current。")
    if same and alive(current.get("bridge_pid"), NODE):
        raise SystemExit("已有 Voxkin Bridge 进程但尚未连接，请先检查其日志，避免重复登录。")
    if not NODE.is_file() or not BRIDGE.is_file():
        raise SystemExit("找不到 Node 22.23.4 或 Bridge，请先准备项目运行环境。")
    version = subprocess.run([str(NODE), "--version"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    if version != "v22.23.4":
        raise SystemExit(f"Node 版本不符：{version}；需要 v22.23.4。")
    if listening("127.0.0.1", 8765) and not bridge_state:
        raise SystemExit("8765 端口已被无法识别的服务占用。")
    if bridge_state and (not same or not alive(current.get("studio_pid"))):
        raise SystemExit("8765 上的 Studio 不属于本次记录的运行，未连接未知服务。")
    existing_studio_pid = current.get("studio_pid")
    if args.resume_current:
        previous = current.get("workspace") or current.get("working_directory")
        if not same or not previous:
            raise SystemExit("没有找到同一服务器的可恢复任务目录。")
        workspace = Path(previous).resolve()
        if not workspace.is_relative_to((ROOT / "work").resolve()) or not (workspace / "data/tasks.db").is_file():
            raise SystemExit("已有任务目录不可用，未启动新的任务。")
    else:
        workspace = WORK / (datetime.now().strftime("%Y%m%d_%H%M%S") + f"_{os.getpid()}")
        workspace.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env.pop("NODE_OPTIONS", None)
    env.pop("VOXKIN_INDEPENDENT", None)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "MC_HOST": args.host,
                "MC_PORT": str(args.port), "MC_VERSION": "1.21.1", "MC_USERNAME": "Voxkin",
                "MC_AUTH": "offline", "VOXKIN_WS": "ws://127.0.0.1:8765/ws/bridge"})
    current = {"status": "starting", "target": target, "workspace": str(workspace),
               "node": str(NODE), "authorization": "用户运行快速启动命令", "studio": STUDIO}
    marker["user_world_25565_run"] = current
    marker["runtime_active"] = True
    marker["cleanup_pending"] = True
    write_marker(marker)
    if not bridge_state:
        core = launch([sys.executable, str(Path(__file__).resolve()), "--core-workspace", str(workspace)],
                      ROOT, env, workspace / "studio")
        current["studio_pid"] = core.pid
        write_marker(marker)
        for _ in range(60):
            if core.poll() is not None:
                current["status"] = "studio_failed"
                marker["runtime_active"] = False
                marker["cleanup_pending"] = False
                write_marker(marker)
                raise SystemExit(f"Studio 启动失败，查看 {workspace / 'studio.err.log'}")
            bridge_state = get_json("/api/bridge/state")
            if bridge_state is not None:
                break
            time.sleep(1)
        if bridge_state is None:
            raise SystemExit(f"Studio 尚未就绪，请查看 {workspace / 'studio.err.log'}")
    else:
        current["studio_pid"] = existing_studio_pid
    bridge = launch([str(NODE), "--jitless", str(BRIDGE)], ROOT, env, workspace / "bridge")
    current["bridge_pid"] = bridge.pid
    current["status"] = "connecting"
    write_marker(marker)
    for _ in range(60):
        if bridge.poll() is not None:
            current["status"] = "bridge_failed"
            write_marker(marker)
            raise SystemExit(f"Bridge 已退出，查看 {workspace / 'bridge.out.log'}")
        state = get_json("/api/bridge/state")
        if state and state.get("connected") and state.get("state", {}).get("ready"):
            current["status"] = "connected"
            write_marker(marker)
            if not args.no_watch:
                start_bridge_monitor(bridge.pid, workspace, args.host, args.port, env)
            print(f"Voxkin 已加入 {target}，Studio：{STUDIO}")
            return 0
        time.sleep(1)
    raise SystemExit(f"Bridge 已启动但尚未就绪，请查看 {workspace / 'bridge.out.log'}")


if __name__ == "__main__":
    raise SystemExit(main())
