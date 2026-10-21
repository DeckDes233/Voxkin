from __future__ import annotations

from typing import Any

DIRECTIONS = (
    "南",
    "西南",
    "西",
    "西北",
    "北",
    "东北",
    "东",
    "东南",
)

DIMENSIONS = {
    "overworld": "主世界",
    "the_nether": "下界",
    "the_end": "末地",
}

WEATHER = {
    "clear": "晴",
    "rain": "雨",
    "thunder": "雷雨",
}


def direction(yaw: float | None) -> str:
    if yaw is None:
        return "未知"
    normalized = float(yaw) % 360.0
    index = int((normalized + 22.5) // 45.0) % 8
    return DIRECTIONS[index]


def clock(time_of_day: float | None) -> str:
    if time_of_day is None:
        return "未知"
    ticks = float(time_of_day) % 24000.0
    hours = (ticks / 1000.0 + 6.0) % 24.0
    whole = int(hours)
    minutes = int((hours - whole) * 60.0)
    return f"{whole:02d}:{minutes:02d}"


def phase(time_of_day: float | None) -> str:
    if time_of_day is None:
        return "未知"
    ticks = float(time_of_day) % 24000.0
    if ticks < 2000:
        return "清晨"
    if ticks < 6000:
        return "上午"
    if ticks < 9000:
        return "正午"
    if ticks < 12000:
        return "下午"
    if ticks < 13000:
        return "黄昏"
    if ticks < 23000:
        return "夜晚"
    return "黎明"


def _position(value: Any) -> tuple[float, float, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        return float(value["x"]), float(value["y"]), float(value["z"])
    except (KeyError, TypeError, ValueError):
        return None


def _coords(position: tuple[float, float, float]) -> str:
    return f"({position[0]:.1f}, {position[1]:.1f}, {position[2]:.1f})"


def format_world_state(state: dict[str, Any] | None) -> str:
    """把桥接上报的状态压成一行，注入每轮 system 上下文。"""
    if not state:
        return ""
    position = _position(state.get("position"))
    if position is None:
        return ""
    parts = [f"你在 {_coords(position)}"]
    parts.append(f"朝向 {direction(state.get('yaw'))}")
    dimension = str(state.get("dimension") or "overworld")
    parts.append(DIMENSIONS.get(dimension, dimension))
    time_of_day = state.get("time")
    day = state.get("day")
    day_text = f"第 {int(day)} 天 " if isinstance(day, (int, float)) else ""
    parts.append(f"{day_text}{phase(time_of_day)} {clock(time_of_day)}")
    weather = WEATHER.get(str(state.get("weather") or "clear"), "未知")
    parts.append(f"天气 {weather}")
    health = state.get("health")
    food = state.get("food")
    if health is not None:
        parts.append(f"血量 {float(health):.0f}/20")
    if food is not None:
        parts.append(f"饥饿 {float(food):.0f}/20")

    players = state.get("players") or []
    visible = [player for player in players if isinstance(player, dict)]
    if visible:
        described = []
        for player in visible[:4]:
            name = player.get("name") or "玩家"
            distance = player.get("distance")
            player_position = _position(player.get("position"))
            if distance is not None and player_position is not None:
                described.append(
                    f"{name} 在 {float(distance):.1f} 格外 {_coords(player_position)}"
                )
            else:
                described.append(str(name))
        parts.append("；".join(described))
    else:
        parts.append("附近没有看到其他玩家")
    return "[世界状态] " + "，".join(parts) + "。"
