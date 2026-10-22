from __future__ import annotations

import json
from pathlib import Path

from voxkin.agent.skills import load_manifest, tool_schemas
from voxkin.agent.tools import MINECRAFT_TOOLS

REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_SOURCE = REPO_ROOT / "bridge" / "minecraft_bridge.js"
MANIFEST_JSON = REPO_ROOT / "bridge" / "skills" / "manifest.json"
SKILL_MODULES_DIR = REPO_ROOT / "bridge" / "skills"

# chat 只在游戏内生效，Core 用 TTS 说话，不把它交给模型。
BRIDGE_ONLY_SKILLS = {"chat"}


def manifest_map() -> dict[str, dict]:
    return {str(skill["skill_id"]): skill for skill in load_manifest()["skills"]}


def module_skill_ids() -> set[str]:
    """读取 bridge/skills/ 下模块文件导出的技能 id。

    模块用 `export const skills = {` 开头，条目形如 `  skill_id: {`。
    """
    import re

    ids: set[str] = set()
    pattern = re.compile(r"^\s{2}([a-z][a-z0-9_]*):\s*\{", re.MULTILINE)
    for path in sorted(SKILL_MODULES_DIR.glob("*.js")):
        if path.name in {"manifest.js", "registry.js"}:
            continue
        source = path.read_text(encoding="utf-8")
        if "export const skills" not in source:
            continue
        body = source.split("export const skills", 1)[1]
        ids.update(pattern.findall(body))
    return ids

def tool_map() -> dict[str, dict]:
    return {tool["function"]["name"]: tool["function"] for tool in MINECRAFT_TOOLS}


def test_manifest_json_matches_manifest_module():
    module_data = load_manifest()
    json_data = json.loads(MANIFEST_JSON.read_text(encoding="utf-8"))
    assert json_data["skills"] == module_data["skills"]


def test_manifest_covers_every_bridge_action():
    source = BRIDGE_SOURCE.read_text(encoding="utf-8")
    cases = {
        line.split("'")[1]
        for line in source.splitlines()
        if line.strip().startswith("case '") and "'" in line
    }
    # 清单 = runAction 里的分支动作 + bridge/skills/ 下模块导出的技能。
    assert cases | module_skill_ids() == set(manifest_map())


def test_core_tools_match_manifest_parameters():
    manifest = manifest_map()
    tools = tool_map()
    assert set(tools) | BRIDGE_ONLY_SKILLS == set(manifest)
    for name, function in tools.items():
        skill = manifest[name]
        properties = function["parameters"]["properties"]
        required = set(function["parameters"].get("required", []))
        manifest_parameters = {str(item["name"]): item for item in skill["parameters"]}
        assert set(properties) == set(manifest_parameters), name
        manifest_required = {
            key for key, item in manifest_parameters.items() if item.get("required")
        }
        # 清单里的必填项必须对模型也是必填；模型侧可以更严格，不能更松。
        assert manifest_required <= required, name
        assert required <= set(properties), name
        for key, item in manifest_parameters.items():
            bounds = item.get("range")
            if not isinstance(bounds, dict):
                continue
            assert properties[key].get("minimum") == bounds.get("min"), (name, key)
            assert properties[key].get("maximum") == bounds.get("max"), (name, key)


def test_manifest_schema_generation_keeps_every_skill():
    schemas = tool_schemas()
    assert len(schemas) == len(load_manifest()["skills"])
    for schema in schemas:
        assert schema["type"] == "function"
        function = schema["function"]
        assert function["name"] and function["description"]
        parameters = function["parameters"]
        assert parameters["type"] == "object"
        assert set(parameters.get("required", [])) <= set(parameters["properties"])


def test_every_skill_declares_observable_verification():
    for name, skill in manifest_map().items():
        assert skill["verifies"].strip(), name
        assert skill["recovery_strategy"].strip(), name
        assert isinstance(skill["intent_examples"], list) and skill["intent_examples"], name
        # 只读查询没有失败分支是合理的，会改变世界的技能必须写清失败条件。
        if skill["type"] != "sense":
            assert skill["failure_conditions"], name
