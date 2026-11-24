import ctypes
import json
import subprocess
import sys
import time

import quickstart_player as quickstart


def wait_for_exit(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    kernel.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))
    kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel.OpenProcess(0x100000 | 0x1000, False, pid)
    if not handle:
        return None
    try:
        result = kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        code = ctypes.c_uint32()
        if result != 0 or not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            return None
        return code.value
    finally:
        kernel.CloseHandle(handle)


def may_restart(marker, pid, target, exit_code, lifetime, retries):
    current = marker.get("user_world_25565_run") or {}
    return (
        current.get("bridge_pid") == pid
        and current.get("target") == target
        and marker.get("runtime_active") is True
        and marker.get("cleanup_pending") is True
        and marker.get("runtime_blocked") is not True
        and exit_code is not None and 0 < exit_code < 0x80000000
        and lifetime >= 10 and retries < 1
    )


def wait_for_bridge_disconnect(timeout=15.0, interval=0.25):
    deadline = time.monotonic() + timeout
    while True:
        state = quickstart.get_json("/api/bridge/state")
        if state is not None and state.get("connected") is False:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(interval, remaining))


def monitor(pid, host, port):
    target = f"{host}:{port}"
    retries = 0
    while True:
        try:
            marker = json.loads(quickstart.MARKER.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return 1
        current = marker.get("user_world_25565_run") or {}
        if current.get("bridge_pid") != pid or current.get("target") != target:
            return 0
        if not quickstart.alive(pid, quickstart.NODE):
            print(f"Bridge PID {pid} 不再运行，未获取到退出码", flush=True)
            return 1
        started = time.monotonic()
        code = wait_for_exit(pid)
        lifetime = time.monotonic() - started
        print(f"Bridge PID {pid} 已退出，code={code}，监测时长={lifetime:.1f}s", flush=True)
        try:
            marker = json.loads(quickstart.MARKER.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return 1
        if not may_restart(marker, pid, target, code, lifetime, retries):
            print("退出不符合安全重连条件，保留状态与证据", flush=True)
            return 0
        if not quickstart.listening(host, port):
            print("Minecraft 不可用，保留状态等待人工恢复", flush=True)
            return 1
        if not wait_for_bridge_disconnect():
            print("Studio 未确认旧 Bridge 已断开，保留状态等待人工恢复", flush=True)
            return 1
        retries += 1
        command = [sys.executable, str(quickstart.ROOT / "scripts/quickstart_player.py"),
                   "--host", host, "--port", str(port), "--resume-current", "--no-watch",
                   "--watch-reconnect-pid", str(pid)]
        result = subprocess.run(command, cwd=str(quickstart.ROOT), check=False)
        if result.returncode:
            return result.returncode
        try:
            marker = json.loads(quickstart.MARKER.read_text(encoding="utf-8-sig"))
            next_pid = int(marker["user_world_25565_run"]["bridge_pid"])
        except (OSError, ValueError, KeyError, TypeError):
            return 1
        if next_pid == pid:
            return 1
        pid = next_pid
