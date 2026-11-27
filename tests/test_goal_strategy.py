import asyncio
import json
import time

import pytest

from voxkin.agent.decision_brain import DecisionBrain
from voxkin.agent.goals import GOALS
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.config import BrainConfig
from voxkin.llm.base import LLMDelta


class WaitingLLM:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = []

    async def stream_chat(self, messages, tools=None):
        request = json.loads(messages[-1]["content"])
        self.calls.append(request)
        self.started.set()
        await self.release.wait()
        yield LLMDelta(kind="text", text=json.dumps({
            "decision_id": request["decision_id"], "candidate_id": "eat_before_travel",
        }))


@pytest.fixture
def expedition(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    world = {
        "session_id": "live", "revision": 4, "ready": True, "alive": True, "is_day": True,
        "dimension": "overworld", "food": 12, "health": 19, "position": {"x": 4, "y": 64, "z": 8},
        "surface_access": {"connected_land": True}, "inventory": {"bread": 2},
        "executor": {"active_action_id": None, "safety_active": False},
    }
    llm = WaitingLLM()
    controller = GoalSupervisor(GOALS["S3"], store, None, lambda: world,
                                decision_brain=DecisionBrain(llm, BrainConfig()))
    controller.task_id = store.create_task("S3", "S3").id
    controller.state = controller._new_state()
    step = StepSpec("另找矿区", "explore_mining_site", {"min_distance": 16},
                    {"type": "s3_mining_relocation", "min_distance": 16})
    yield controller, llm, world, step
    store.close()


@pytest.mark.asyncio
async def test_expedition_chooses_local_skill_and_consumes_decision_once(expedition):
    controller, llm, world, step = expedition
    llm.release.set()
    selected, key, cursor = await controller._select_strategy(step, "ore", 2, world)
    assert selected.tool == "eat_if_hungry" and selected.verify == {"type": "food", "min": 13}
    assert (key, cursor) == ("ore:eat_before_travel", None)
    assert await controller._select_strategy(step, "ore", 2, world) == (step, "ore", 2)
    assert len(llm.calls) == 1
    assert controller.state["counters"]["actions"] == 0


@pytest.mark.asyncio
async def test_reflex_invalidates_request_before_new_snapshot(expedition):
    controller, llm, world, step = expedition
    task = asyncio.create_task(controller._select_strategy(step, "ore", None, world))
    await asyncio.wait_for(llm.started.wait(), 1)
    controller.interrupt_decision({"session_id": "live", "state_revision": 5})
    assert await asyncio.wait_for(task, 1) is None
    assert controller._decision_after == ("live", 5)
    assert not controller._state_usable(world, after=controller._decision_after)[0]
    world["revision"] = 6
    assert controller._state_usable(world, after=controller._decision_after)[0]
    assert not controller.state.get("resolved_strategy_forks")
    await controller.decision_brain.close()


@pytest.mark.asyncio
async def test_stage_deadline_ends_pending_request(expedition):
    controller, llm, world, step = expedition
    controller.state["deadline_at"] = time.time() + 0.08
    assert await asyncio.wait_for(controller._select_strategy(step, "ore", None, world), 1) is None
    assert len(llm.calls) == 1
    assert not controller.state.get("resolved_strategy_forks")
    await controller.decision_brain.close()
