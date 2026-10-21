from __future__ import annotations

from voxkin.world_state import clock, direction, format_world_state, phase


def test_direction() -> None:
    assert direction(0) == "南"
    assert direction(90) == "西"
    assert direction(180) == "北"
    assert direction(270) == "东"
    assert direction(45) == "西南"
    assert direction(-90) == "东"


def test_clock() -> None:
    assert clock(0) == "06:00"
    assert clock(6000) == "12:00"
    assert clock(12000) == "18:00"
    assert clock(18000) == "00:00"


def test_phase() -> None:
    assert phase(1000) == "清晨"
    assert phase(6000) == "正午"
    assert phase(12500) == "黄昏"
    assert phase(18000) == "夜晚"


def test_format_world_state() -> None:
    line = format_world_state(
        {
            "position": {"x": 12.5, "y": 64.0, "z": -3.25},
            "yaw": 270,
            "dimension": "overworld",
            "time": 18000,
            "day": 3,
            "weather": "clear",
            "health": 18.0,
            "food": 16.0,
            "players": [
                {
                    "name": "DeckDes",
                    "position": {"x": 10.0, "y": 64.0, "z": 0.0},
                    "distance": 3.4,
                }
            ],
        }
    )
    assert line.startswith("[世界状态]")
    assert "(12.5, 64.0, -3.2)" in line
    assert "朝向 东" in line
    assert "主世界" in line
    assert "第 3 天" in line
    assert "夜晚" in line
    assert "00:00" in line
    assert "血量 18/20" in line
    assert "DeckDes 在 3.4 格外" in line


def test_format_missing_state() -> None:
    assert format_world_state(None) == ""
    assert format_world_state({}) == ""
    assert format_world_state({"position": None}) == ""


def test_format_without_players() -> None:
    line = format_world_state(
        {
            "position": {"x": 0, "y": 64, "z": 0},
            "yaw": 0,
            "time": 1000,
            "day": 1,
        }
    )
    assert "附近没有看到其他玩家" in line
