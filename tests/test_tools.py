from __future__ import annotations

import json
from pathlib import Path

import pytest

from voxkin.agent.skills import load_manifest
from voxkin.agent.tools import BRIDGE_ONLY_SKILLS, MINECRAFT_TOOLS, TOOL_SYSTEM_HINT
from voxkin.pipeline import ConversationPipeline

BRIDGE_SOURCE = Path(__file__).resolve().parents[1] / "bridge" / "minecraft_bridge.js"

NEW_TOOLS = ("eat", "observe", "locate_block", "locate_entity", "sleep", "smelt", "attack_target")

EXISTING_TOOLS = {
    "collect_blocks": ({"block", "count", "range"}, {"block"}),
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
    "smelt": ({"item", "count"}, {"item"}),
}


def tool_map() -> dict[str, dict]:
    return {tool["function"]["name"]: tool["function"] for tool in MINECRAFT_TOOLS}


def manifest_map() -> dict[str, dict]:
    return {str(skill["skill_id"]): skill for skill in load_manifest()["skills"]}


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


def test_tool_list_follows_the_manifest():
    """工具清单由 bridge/skills/manifest.json 生成，不手工维护。"""
    manifest = manifest_map()
    tools = tool_map()
    assert set(tools) | set(BRIDGE_ONLY_SKILLS) == set(manifest)
    assert set(tools) == set(manifest) - set(BRIDGE_ONLY_SKILLS)


def test_bridge_only_skills_are_not_exposed():
    """chat 只在游戏内生效，不交给模型。"""
    assert BRIDGE_ONLY_SKILLS == {"chat"}
    assert "chat" not in tool_map()


def test_tool_parameters_follow_the_manifest():
    manifest = manifest_map()
    for name, function in tool_map().items():
        skill = manifest[name]
        properties = function["parameters"]["properties"]
        required = set(function["parameters"].get("required", []))
        manifest_parameters = {str(item["name"]): item for item in skill["parameters"]}
        assert set(properties) == set(manifest_parameters), name
        manifest_required = {
            key for key, item in manifest_parameters.items() if item.get("required")
        }
        assert manifest_required <= required, name
        for key, item in manifest_parameters.items():
            bounds = item.get("range")
            if not isinstance(bounds, dict):
                continue
            assert properties[key].get("minimum") == bounds.get("min"), (name, key)
            assert properties[key].get("maximum") == bounds.get("max"), (name, key)


def test_hunt_material_schema_exposes_its_supported_item_values():
    schema = tool_map()["hunt_material"]["parameters"]["properties"]["item"]
    assert schema["enum"] == ["feather", "string"]


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


def test_module_skills_are_registered():
    """模块技能也要能调到，否则模型拿不到新能力。"""
    tools = tool_map()
    for name in (
        "smelt_batch",
        "deep_mine",
        "strip_mine",
        "find_diamond",
        "fight_blaze",
        "break_crystal",
        "checkpoint_stock",
        "store_items",
        "withdraw_items",
        "make_shelter",
        "safe_travel",
        "sleep_safe",
    ):
        assert name in tools, name


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
    assert not parameters.get("required")
    assert "饥饿" in tool_map()["eat"]["description"]
    # 不主动吃金苹果写在物品参数的说明里。
    assert "金苹果" in parameters["properties"]["item"]["description"]


def test_observe_reports_expected_sections():
    description = tool_map()["observe"]["description"]
    for keyword in ("坐标", "朝向", "维度", "血量", "饥饿", "时刻", "天气", "护甲", "背包", "玩家", "敌对生物"):
        assert keyword in description


def test_locate_block_requires_block():
    parameters = tool_map()["locate_block"]["parameters"]
    assert set(parameters["properties"]) == {"block", "radius", "limit"}
    assert parameters["required"] == ["block"]
    # 找不到方块时要说清楚，失败条件写在描述里。
    assert "没有" in tool_map()["locate_block"]["description"]


def test_locate_entity_filters_are_optional():
    parameters = tool_map()["locate_entity"]["parameters"]
    assert set(parameters["properties"]) == {"type", "name", "radius", "limit"}
    assert not parameters.get("required")
    assert "玩家名" in parameters["properties"]["name"]["description"]


def test_sleep_takes_no_parameters():
    parameters = tool_map()["sleep"]["parameters"]
    assert set(parameters["properties"]) == set()
    assert not parameters.get("required")
    description = tool_map()["sleep"]["description"]
    for keyword in ("下界", "末地", "雷暴", "敌对生物"):
        assert keyword in description


def test_descriptions_carry_the_manifest_failure_conditions():
    """描述里要带上失败情况，模型才知道什么时候别调这个技能。"""
    manifest = manifest_map()
    for name, function in tool_map().items():
        for condition in manifest[name].get("failure_conditions") or []:
            assert condition.rstrip("。") in function["description"], name


def test_defaults_are_documented():
    manifest = manifest_map()
    for name, function in tool_map().items():
        for parameter in manifest[name].get("parameters") or []:
            if parameter.get("default", None) is None:
                continue
            key = str(parameter["name"])
            assert "默认" in function["parameters"]["properties"][key]["description"], (name, key)


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
