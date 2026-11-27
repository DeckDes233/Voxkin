from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable

from voxkin.agent.goal_methods import FOOD_ITEMS, _danger_now, _hunt_closing, _is_day, _s3_food_count
from voxkin.agent.goals import inventory_count
from voxkin.agent.recovery_evidence import _fresh_terminal_observation, _position, _same_ground, failure_reason
from voxkin.agent.runner import StepSpec


OPTIONAL_STRATEGIES = {"relocate_wood", "eat_before_travel", "forage_before_travel"}


@dataclass
class StrategyFork:
    key: str
    facts: dict[str, Any]
    options: dict[str, StepSpec]

    def choices(self, failures: Callable[[str], int], method_key: str, limit: int) -> dict[str, str]:
        return {
            name: ("在当前区域扩大地表采木搜索" if name == "continue_task" and "relocate_wood" in self.options else option.description)
            for name, option in self.options.items()
            if failures(method_key if name == "continue_task" else f"{method_key}:{name}") < limit
        }

    def resolved(self, ledger: dict) -> bool:
        return self.key == ledger.get("resolved_wood_fork") or self.key in ledger.get("resolved_strategy_forks", [])


@dataclass
class WoodPrefetch:
    action_id: str
    session_id: str
    key: str
    facts: dict
    choices: dict[str, str]
    position: dict
    inventory: dict

    def matches_world(self, world: dict) -> bool:
        return (self.session_id == world.get("session_id") and self.inventory == world.get("inventory")
                and same_wood_site(self.position, world) and self.facts["food"] == world.get("food")
                and self.facts["health"] == world.get("health"))


def same_wood_site(origin: dict, world: dict) -> bool:
    end = world.get("position") or {}
    return _position(origin) and _position(end) and _same_ground(origin, end)


def _local_wood(row: dict) -> bool:
    args = row.get("arguments") or {}
    radius = args.get("range", 64)
    return (row.get("tool") == "mine_collect" and args.get("surface_wood") is True and args.get("block") == "wood_log"
            and type(radius) is int and 0 < radius < 128 and bool(row.get("action_id")))


def _wood_failure(world: dict, ledger: dict) -> tuple[dict, str] | None:
    for row in reversed(ledger.get("action_history", [])):
        if not _local_wood(row) or row.get("session_id") != world.get("session_id"):
            continue
        reason = failure_reason(row)
        end = _fresh_terminal_observation(row, row.get("result_data") or {})
        if (reason in {"resource_not_found", "surface_route_stalled"} and row.get("status") in {"failed", "blocked"}
                and end and end.get("dimension") == world.get("dimension")
                and end.get("day") == world.get("day") and same_wood_site(end["position"], world)
                and inventory_count(end.get("inventory") or {}, "wood_log") == inventory_count(world.get("inventory") or {}, "wood_log")):
            return row, reason
        break
    return None


def safe_to_deliberate(world: dict, *, active_search: str | None = None) -> bool:
    surface = world.get("surface_access") or {}
    health, food = world.get("health"), world.get("food")
    position = world.get("position") or {}
    return (
        world.get("ready") is True and world.get("alive") is True
        and str(world.get("dimension")).removeprefix("minecraft:") == "overworld"
        and _is_day(world) is True and not _hunt_closing(world) and not _danger_now(world)
        and not world.get("overworld_mining_hostiles")
        and (world.get("executor") or {}).get("active_action_id") in (None, "", active_search)
        and isinstance(health, (float, int)) and 10 < health <= 20
        and isinstance(food, (float, int)) and 8 < food <= 20
        and surface.get("in_water") is not True and surface.get("connected_land") is True
        and all(isinstance(position.get(a), (float, int)) and math.isfinite(position[a]) for a in "xyz")
    )


def major_fork(stage: str, step: StepSpec, method_key: str, world: dict, ledger: dict, *,
               pending_wood: dict | None = None, include_resolved: bool = False) -> StrategyFork | None:
    if stage not in {"S2", "S3", "S4", "S5", "S6"} or step.tool not in {"mine_collect", "explore_mining_site"}:
        return None
    wood = step.tool == "mine_collect" and step.arguments.get("surface_wood") is True
    expedition = step.tool == "explore_mining_site" and step.verify.get("type") in {"s3_mining_relocation", "s3_wood_relocation", "s2_wool_relocation"}
    if not (wood or expedition) or not safe_to_deliberate(world, active_search=(pending_wood or {}).get("action_id")):
        return None
    pos = {axis: math.floor(world["position"][axis]) for axis in "xyz"}
    stock = _s3_food_count(world.get("inventory") or {})
    actions = ledger.get("counters", {}).get("actions", 0)
    death = ledger.get("last_death_at_action")
    rebuilding = isinstance(death, int) and 0 <= actions - death <= 4
    search_range = step.arguments.get("range", 0)
    wide = wood and isinstance(search_range, (int, float)) and search_range >= 128
    if not (wide or rebuilding or expedition):
        return None
    options = {"continue_task": step}
    if wide:
        avoid = [*(ledger.get("s3_wood_avoid_positions") or [])[-127:], pos]
        options["relocate_wood"] = StepSpec("沿连通干地换一个采木区", "explore_mining_site",
                                            {"min_distance": 16, "connected_route": True, "avoid_positions": avoid},
                                            {"type": "s3_wood_relocation", "min_distance": 16}, timeout_s=180, effect_class="replan")
    food = world["food"]
    if stock > 0 and food < 18:
        options["eat_before_travel"] = StepSpec("用背包中的食物补给后再出发", "eat_if_hungry",
                                                {"threshold": 18, "count": 0}, {"type": "food", "min": int(food) + 1},
                                                timeout_s=60, effect_class="replan")
    if rebuilding and not stock and world.get("nearby_food_animal") is True:
        options["forage_before_travel"] = StepSpec("重生后先就近补充食物", "hunt_animal",
                                                  {"count": 1, "radius": 32, "min_health": 10},
                                                  {"type": "inventory_any", "items": sorted(FOOD_ITEMS), "count": 1},
                                                  timeout_s=120, effect_class="replan")
    if len(options) < 2:
        return None
    cell = tuple(pos[a] // 16 for a in "xyz")
    key = f"{stage}:{world.get('session_id')}:{method_key}:{cell}:{death if rebuilding else '-'}"
    facts = {"stage": stage, "goal": ledger.get("title", stage),
             "reason": "respawn" if rebuilding else "wood_search" if wide else "relocation",
             "health": world["health"], "food": food, "carried_food": stock, "wood_search_radius": search_range,
             "connected_land": True, "local_method_failures": ledger.get("counters", {}).get("method_failures", {}).get(method_key, 0)}
    if wide or step.verify.get("type") == "s3_wood_relocation":
        if wide:
            required = step.arguments.get("minimum_count", step.arguments.get("count", 1))
            carried = inventory_count(world.get("inventory") or {}, "wood_log")
            if type(required) is not int or carried >= required:
                return None
            facts.update(required_wood=required, carried_wood=carried)
        source = (pending_wood, "surface_route_stalled") if pending_wood else _wood_failure(world, ledger)
        if source is None:
            return None
        row, reason = source
        if not _local_wood(row):
            return None
        key = f"{stage}:{world.get('session_id')}:wood:{row['action_id']}"
        failures = ledger.get("counters", {}).get("method_failures", {}).get(row.get("method_key"), 0)
        facts.update(wood_failure=reason, wood_failure_action_id=row["action_id"], local_search_radius=row["arguments"].get("range", 64),
                     local_method_failures=failures + int(pending_wood is not None))
    fork = StrategyFork(key, facts, options)
    if not include_resolved and fork.resolved(ledger):
        return None
    return fork
