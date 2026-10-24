from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

MANIFEST_PATH = (
    Path(__file__).resolve().parents[3] / "bridge" / "skills" / "manifest.json"
)
LABELS_PATH = MANIFEST_PATH.parent / "labels.json"

REQUIRED_FIELDS = (
    "skill_id",
    "group",
    "type",
    "description",
    "parameters",
    "timeout_s",
    "cancellable",
    "verifies",
)

GROUPS = ("基础类", "实用类", "专精类")
TYPES = ("sense", "act", "path", "wait", "voice", "plan")


@lru_cache(maxsize=1)
def load_manifest() -> dict[str, Any]:
    """读取技能清单。清单缺失或格式不对时立刻失败，不做静默兜底。"""
    if not MANIFEST_PATH.exists():
        raise FileNotFoundError(f"技能清单不存在: {MANIFEST_PATH}")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    skills = manifest.get("skills")
    if not isinstance(skills, list) or not skills:
        raise ValueError(f"技能清单缺少 skills 列表: {MANIFEST_PATH}")
    for skill in skills:
        missing = [field for field in REQUIRED_FIELDS if field not in skill]
        if missing:
            raise ValueError(f"技能 {skill.get('skill_id')} 缺少字段 {missing}")
        if skill["group"] not in GROUPS:
            raise ValueError(f"技能 {skill['skill_id']} 的 group 非法: {skill['group']}")
        if skill["type"] not in TYPES:
            raise ValueError(f"技能 {skill['skill_id']} 的 type 非法: {skill['type']}")
    return manifest


def skill_ids() -> set[str]:
    return {str(skill["skill_id"]) for skill in load_manifest()["skills"]}


@lru_cache(maxsize=1)
def load_labels() -> dict[str, str]:
    """方块 ID 到中文名。词表由 bridge/skills/labels.js 生成，桥接与 Core 共用一份。"""
    if not LABELS_PATH.exists():
        raise FileNotFoundError(f"方块词表不存在: {LABELS_PATH}")
    data = json.loads(LABELS_PATH.read_text(encoding="utf-8"))
    blocks = data.get("blocks")
    if not isinstance(blocks, dict) or not blocks:
        raise ValueError(f"方块词表缺少 blocks: {LABELS_PATH}")
    return {str(key): str(value) for key, value in blocks.items()}


@lru_cache(maxsize=1)
def block_aliases() -> dict[str, str]:
    """中文名到方块 ID 的反向表，用于解析玩家说的中文方块名。"""
    return {label: block_id for block_id, label in load_labels().items()}


def block_label(block_id: str) -> str:
    return load_labels().get(block_id, block_id)


def find_skill(skill_id: str) -> dict[str, Any] | None:
    for skill in load_manifest()["skills"]:
        if str(skill["skill_id"]) == skill_id:
            return skill
    return None


def parameter_bounds(parameter: dict[str, Any]) -> tuple[float | None, float | None]:
    """从清单参数里取出数值范围，兼容 range 对象、range 数组与最小最大字段。"""
    minimum = parameter.get("minimum")
    maximum = parameter.get("maximum")
    bounds = parameter.get("range")
    if isinstance(bounds, dict):
        minimum = bounds.get("min", bounds.get("minimum", minimum))
        maximum = bounds.get("max", bounds.get("maximum", maximum))
    elif isinstance(bounds, (list, tuple)) and len(bounds) == 2:
        minimum, maximum = bounds[0], bounds[1]
    return minimum, maximum


def tool_schemas(manifest: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """把技能清单转成模型能用的工具 schema。"""
    source = manifest if manifest is not None else load_manifest()
    schemas: list[dict[str, Any]] = []
    for skill in source["skills"]:
        properties: dict[str, Any] = {}
        required: list[str] = []
        for parameter in skill.get("parameters") or []:
            name = str(parameter.get("name") or "")
            if not name:
                raise ValueError(f"技能 {skill['skill_id']} 有参数缺少 name")
            schema: dict[str, Any] = {
                "type": str(parameter.get("type") or "string"),
                "description": str(parameter.get("description") or ""),
            }
            enum_values = parameter.get("enum")
            if enum_values is not None:
                schema["enum"] = list(enum_values)
            minimum, maximum = parameter_bounds(parameter)
            if minimum is not None:
                schema["minimum"] = minimum
            if maximum is not None:
                schema["maximum"] = maximum
            properties[name] = schema
            if parameter.get("required"):
                required.append(name)
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": str(skill["skill_id"]),
                    "description": str(skill["description"]),
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                    },
                },
            }
        )
    return schemas
