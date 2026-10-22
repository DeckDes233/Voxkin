from __future__ import annotations

from typing import Any

from voxkin.agent.skills import load_manifest, tool_schemas

# chat 只在游戏内生效：Core 用 TTS 说话，不把它当成模型可调的工具。
BRIDGE_ONLY_SKILLS: frozenset[str] = frozenset({"chat"})

# 清单里写成联合类型的参数是桥接侧的宽松约定，模型侧按文本清单给。
UNION_TYPE_HINTS: dict[str, str] = {
    "string|array|object": "写成「物品 数量」的文本，多个物品用逗号分隔。",
}


def _model_type(declared: str) -> str:
    """清单里的联合类型收窄成模型能填的类型。"""
    return declared.split("|", 1)[0] if "|" in declared else declared


def _default_note(parameter: dict[str, Any]) -> str:
    """把清单里的默认值写进参数描述，模型才知道省略参数会发生什么。"""
    default = parameter.get("default", None)
    if default is None:
        return ""
    if isinstance(default, bool):
        return "默认是。" if default else "默认否。"
    return f"默认 {default}。"


def _skill_description(skill: dict[str, Any]) -> str:
    """工具描述 = 清单描述 + 失败情况，让模型知道什么时候别调这个技能。"""
    description = str(skill.get("description") or "")
    failures = [str(item).rstrip("。") for item in (skill.get("failure_conditions") or []) if item]
    if not failures:
        return description
    return f"{description} 失败情况：{'；'.join(failures)}。"


def build_tools(manifest: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """按技能清单生成模型可用的工具列表。

    清单是唯一事实来源：工具名、参数名、必填项与数值范围都跟着清单走，
    Core 只补三件事——去掉只在游戏内生效的技能、把默认值写进参数描述、
    把联合类型收窄成模型能填的类型。
    """
    source = manifest if manifest is not None else load_manifest()
    skills = {str(skill["skill_id"]): skill for skill in source["skills"]}
    tools: list[dict[str, Any]] = []
    for schema in tool_schemas(source):
        name = str(schema["function"]["name"])
        if name in BRIDGE_ONLY_SKILLS:
            continue
        skill = skills.get(name)
        if skill is None:
            raise ValueError(f"技能 {name} 不在清单里")
        parameters = {
            str(item.get("name")): item for item in (skill.get("parameters") or [])
        }
        function = schema["function"]
        function["description"] = _skill_description(skill)
        properties = function["parameters"]["properties"]
        for key, item in properties.items():
            parameter = parameters.get(key)
            if parameter is None:
                continue
            declared = str(parameter.get("type") or "string")
            item["type"] = _model_type(declared)
            notes = []
            hint = UNION_TYPE_HINTS.get(declared)
            if hint:
                notes.append(hint)
            default_note = _default_note(parameter)
            if default_note:
                notes.append(default_note)
            if notes:
                item["description"] = f"{item['description']}{''.join(notes)}"
        tools.append(schema)
    return tools


MINECRAFT_TOOLS: list[dict[str, Any]] = build_tools()

TOOL_SYSTEM_HINT = (
    "你在 Minecraft 世界里行动，可以用工具改变游戏状态。"
    "回答玩家时直接用语音，不要调用工具来说话；只有确实要移动、挖掘或停止时才调用工具。"
    "玩家说跟我来、跟上、别掉队时调用 follow_player；说过来、来我这、到我这里时调用 come_to_player；"
    "问背包或有什么东西时调用 inventory；让你打怪、清怪时调用 attack_nearest；指定打某一只用 attack_target。"
    "要挖单个方块用 break_block；要放置方块用 place_block；要走到某种方块用 goto_block；地上有掉落物用 pickup_items。"
    "要合成木板、木棍、工作台用 craft；要一整套工具用 craft_tool_set；要做床用 craft_bed；要做火把用 craft_torch。"
    "要把粗铁、粗金或生食熔炼时用 smelt；一次熔很多用 smelt_batch。"
    "要知道周围情况用 observe；找方块用 locate_block；找玩家或生物用 locate_entity；饿了用 eat；晚上用 sleep 睡觉。"
    "要走远路用 safe_travel；要下矿道用 deep_mine 或 strip_mine；找钻石用 find_diamond；"
    "要过夜用 sleep_safe；在被封住的庇护所里等天亮用 wait_for_day，天亮后用 leave_shelter 挖开出口；血量太低用 flee_low_health；带盾用 equip_shield；缺庇护所用 make_shelter。"
    "要打猎用 hunt_animal；要剪羊毛用 shear_sheep（需要剪刀）；要打末影人用 hunt_enderman；要打烈焰人用 fight_blaze；打末影龙水晶用 break_crystal。要找要塞用 throw_eye；要激活末地门用 activate_end_portal；要打末影龙用 fight_dragon；龙死后用 return_home 回主世界。"
    "要存物资用 store_items 或 checkpoint_stock；要取物资用 withdraw_items；要找箱子用 list_chest。"
    "箱子满了或者材料不够时，动作结果会说明还差多少，按结果调整数量再来一次。"
    "玩家问你是谁、在哪、在做什么、为什么，先用一句话直接回答，不要调用工具。"
    "调用工具前先说一句要做什么，不要只调用工具不说话。"
    "回答保持一到两句话，不要提到接口、模型、语音合成或系统内部。"
    "描述动作使用「我去」这样的进行时，不要声称已经完成，完成情况由系统回报。"
)
