from __future__ import annotations

from typing import Any

HOSTILE_NAMES = {
    "blaze",
    "cave_spider",
    "creeper",
    "drowned",
    "ender_dragon",
    "enderman",
    "endermite",
    "evoker",
    "ghast",
    "guardian",
    "hoglin",
    "husk",
    "magma_cube",
    "phantom",
    "piglin_brute",
    "pillager",
    "ravager",
    "shulker",
    "silverfish",
    "skeleton",
    "slime",
    "spider",
    "stray",
    "vex",
    "vindicator",
    "warden",
    "witch",
    "wither",
    "wither_skeleton",
    " zoglin ".strip(),
    "zombie",
    "zombie_villager",
    "zombified_piglin",
}


def choose_reflex(event: dict[str, Any], state: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Select only bounded survival actions from observed Bridge facts."""
    kind = str(event.get("event") or "")
    payload = event.get("data") if isinstance(event.get("data"), dict) else {}
    try:
        health = float(payload.get("health", state.get("health", 20)))
    except (TypeError, ValueError):
        health = 20.0
    try:
        food = float(payload.get("food", state.get("food", 20)))
    except (TypeError, ValueError):
        food = 20.0

    if kind == "low_oxygen":
        try:
            oxygen = float(payload.get("oxygen", 20))
        except (TypeError, ValueError):
            return None
        return ("swim_escape", {"radius": 32, "timeout_s": 25}) if oxygen <= 8 else None

    if kind == "critical_hunger":
        inventory = state.get("inventory") or {}
        available = any(
            int(inventory.get(item, 0) or 0) > 0
            for item in (
                "bread",
                "cooked_beef",
                "cooked_porkchop",
                "cooked_chicken",
                "cooked_mutton",
                "cooked_cod",
                "cooked_salmon",
                "baked_potato",
                "apple",
                "carrot",
                "potato",
                "melon_slice",
                "sweet_berries",
            )
        )
        return ("eat_if_hungry", {"threshold": 14}) if food <= 8 and available else None

    if kind == "damage":
        source_type = str(payload.get("source_type") or "")
        source_name = str(payload.get("source_name") or "").lower()
        if health <= 8 or source_type == "player" or source_name not in HOSTILE_NAMES:
            return ("flee_low_health", {"threshold": 10})
        entity_id = payload.get("source_id")
        target = {"range": 16}
        if isinstance(entity_id, int) and not isinstance(entity_id, bool):
            target["id"] = entity_id
        else:
            target["name"] = source_name
        return ("attack_target", target)

    if kind == "hostile_nearby":
        source_name = str(payload.get("entity_name") or "").lower()
        if source_name not in HOSTILE_NAMES:
            return None
        entity_id = payload.get("entity_id")
        target = {"range": 16}
        if isinstance(entity_id, int) and not isinstance(entity_id, bool):
            target["id"] = entity_id
        else:
            target["name"] = source_name
        if health <= 8:
            return ("flee_low_health", {"threshold": 10})
        return ("attack_target", target)

    return None
