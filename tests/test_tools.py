import json
from pathlib import Path

import pytest

from voxkin.agent.tools import MINECRAFT_TOOLS, TOOL_SYSTEM_HINT
from voxkin.pipeline import ConversationPipeline

BRIDGE_SOURCE = Path(__file__).resolve().parents[1] / "bridge" / "minecraft_bridge.js"

NEW_TOOLS = ("eat", "observe", "locate_block", "locate_entity", "sleep", "smelt")

EXISTING_TOOLS = {
    "collect_blocks": ({"block", "count"}, {"block", "count"}),
    "goto": ({"x", "y", "z"}, {"x", "y", "z"}),
    "stop": (set(), set()),
    "look_at_player": ({"player"}, {"player"}),
    "follow_player": ({"player", "distance"}, set()),
    "come_to_player": ({"player"}, set()),
    "inventory": (set(), set()),
    "attack_nearest": ({"range"}, set()),
    "break_block": ({"block", "x", "y", "z", "range"}, set()),
    "place_block": ({"block", "x", "y", "z"}, {"block", "x", "y", "z"}),
    "goto_block": ({"block", "range"}, {"block"}),
    "pickup_items": ({"range"}, set()),
    "craft": ({"item", "count"}, {"item"}),
}


def tool_map() -> dict[str, dict]:
    return {tool["function"]["name"]: tool["function"] for tool in MINECRAFT_TOOLS}


def test_tools_parse_as_function_schemas():
    names = [tool["function"]["name"] for tool in MINECRAFT_TOOLS]
    assert len(names) == len(set(names))
    for tool in MINECRAFT_TOOLS:
        assert tool["type"] == "function"
        function = tool["function"]
        assert function["name"]
        assert function["description"]
        parameters = function["parameters"]
        assert parameters["type"] == "object"
        assert isinstance(parameters["properties"], dict)
        assert isinstance(parameters.get("required", []), list)
        assert set(parameters.get("required", [])) <= set(parameters["properties"])
        json.dumps(tool, ensure_ascii=False)


def test_existing_tools_keep_their_parameters():
    tools = tool_map()
    assert set(EXISTING_TOOLS) <= set(tools)
    for name, (properties, required) in EXISTING_TOOLS.items():
        parameters = tools[name]["parameters"]
        # 允许后续任务追加可选参数，但原有参数与必填项不能被改名或删除。
        assert properties <= set(parameters["properties"])
        assert set(parameters.get("required", [])) == required


def test_new_tools_are_registered():
    tools = tool_map()
    assert set(NEW_TOOLS) <= set(tools)
    assert len(tools) == len(MINECRAFT_TOOLS)


@pytest.mark.parametrize(
    ("tool", "parameter", "minimum", "maximum"),
    [
        ("eat", "count", 1, 16),
        ("observe", "radius", 1, 64),
        ("locate_block", "radius", 1, 64),
        ("locate_block", "limit", 1, 16),
        ("locate_entity", "radius", 1, 64),
        ("locate_entity", "limit", 1, 16),
    ],
)
def test_new_tool_numeric_ranges(tool, parameter, minimum, maximum):
    schema = tool_map()[tool]["parameters"]["properties"][parameter]
    assert schema["type"] in {"integer", "number"}
    assert schema["minimum"] == minimum
    assert schema["maximum"] == maximum
    assert "默认" in schema["description"]


def test_eat_parameters_are_optional():
    parameters = tool_map()["eat"]["parameters"]
    assert set(parameters["properties"]) == {"item", "count"}
    assert "required" not in parameters
    assert "饥饿" in tool_map()["eat"]["description"]
    assert "金苹果" in tool_map()["eat"]["description"]


def test_observe_reports_expected_sections():
    description = tool_map()["observe"]["description"]
    for keyword in ("坐标", "朝向", "维度", "血量", "饥饿", "时间", "天气", "护甲", "背包", "玩家", "敌对生物"):
        assert keyword in description


def test_locate_block_requires_block():
    parameters = tool_map()["locate_block"]["parameters"]
    assert set(parameters["properties"]) == {"block", "radius", "limit"}
    assert parameters["required"] == ["block"]
    assert "找不到" in tool_map()["locate_block"]["description"]


def test_locate_entity_filters_are_optional():
    parameters = tool_map()["locate_entity"]["parameters"]
    assert set(parameters["properties"]) == {"type", "name", "radius", "limit"}
    assert "required" not in parameters
    assert "用户名" in tool_map()["locate_entity"]["description"]


def test_sleep_takes_no_parameters():
    parameters = tool_map()["sleep"]["parameters"]
    assert parameters == {"type": "object", "properties": {}}
    description = tool_map()["sleep"]["description"]
    for keyword in ("下界", "末地", "雷暴", "敌对生物", "占用", "假报天亮"):
        assert keyword in description


def test_hint_mentions_new_skills():
    for name in NEW_TOOLS:
        assert name in TOOL_SYSTEM_HINT


@pytest.mark.parametrize("name", NEW_TOOLS)
def test_action_acknowledgement_covers_new_tools(name):
    pipeline = ConversationPipeline.__new__(ConversationPipeline)
    text = pipeline._action_acknowledgement({"name": name})
    assert text
    assert text != "好的，我这就去。"


def test_bridge_switch_implements_new_tools():
    source = BRIDGE_SOURCE.read_text(encoding="utf-8")
    for name in NEW_TOOLS:
        assert f"case '{name}':" in source
