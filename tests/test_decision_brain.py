import asyncio
import json

import pytest
from aiohttp import web

from voxkin.agent.decision_brain import DecisionBrain
from voxkin.config import BrainConfig, LLMConfig, VoxkinConfig, load_config, save_config
from voxkin.llm.base import LLMDelta
from voxkin.llm.openai_compat import OpenAICompatLLM


OPTIONS = {"forage": "去已观察的岸边补木", "return": "沿旧路返回营地"}


class DelayedLLM:
    def __init__(self, reply=None):
        self.reply = reply or (lambda token: json.dumps({"decision_id": token, "candidate_id": "forage"}))
        self.inputs = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.active = 0
        self.max_active = 0

    async def stream_chat(self, messages, tools=None):
        assert not tools
        request = json.loads(messages[-1]["content"])
        self.inputs.append(request)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            self.entered.set()
            await self.release.wait()
            content = self.reply(request["decision_id"])
            yield LLMDelta(kind="text", text=content[:9])
            yield LLMDelta(kind="text", text=content[9:])
            yield LLMDelta(kind="done")
        finally:
            self.active -= 1


@pytest.mark.asyncio
async def test_select_prefetches_one_frozen_observation_and_reuses_result_until_expiry(monkeypatch):
    llm = DelayedLLM()
    brain = DecisionBrain(llm, BrainConfig(result_ttl_s=60))
    facts = {"inventory": {"oak_log": 2}}
    assert brain.select("S4:shore", OPTIONS, facts) is None
    facts["inventory"]["oak_log"] = 3
    await llm.entered.wait()
    assert llm.inputs[0]["facts"]["inventory"] == {"oak_log": 2}
    assert brain.select("S4:shore", OPTIONS, facts) is None
    assert await brain.wait_ready("S4:shore", .001) is None
    assert llm.active == 1
    llm.release.set()
    assert await brain.wait_ready("S4:shore") == "forage"
    assert brain.select("S4:shore", OPTIONS, facts) == "forage"
    loop = asyncio.get_running_loop()
    after_expiry = loop.time() + 61
    with monkeypatch.context() as patch:
        patch.setattr(loop, "time", lambda: after_expiry)
        assert brain.select("S4:shore", OPTIONS, facts) is None
        assert await brain.wait_ready("S4:shore", 0) is None
    assert brain.describe()["requested"] == 1
    assert brain.describe()["completed"] == 1
    await brain.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", [
    lambda token: json.dumps({"decision_id": token, "candidate_id": "teleport"}),
    lambda token: json.dumps({"decision_id": "old-decision", "candidate_id": "forage"}),
    lambda token: json.dumps({"decision_id": token, "candidate_id": "forage", "x": 10}),
    lambda token: json.dumps({"decision_id": token, "candidate_id": ["forage"]}),
    lambda token: '{"decision_id":"' + token + '","candidate_id":"return","candidate_id":"forage"}',
    lambda token: '以下是决策 {}',
    lambda token: "x" * 2048,
])
async def test_brain_rejects_unusable_or_ambiguous_json(reply):
    llm = DelayedLLM(reply)
    llm.release.set()
    brain = DecisionBrain(llm, BrainConfig())
    brain.select("at-shore", OPTIONS, {})
    assert await brain.wait_ready("at-shore", 1) is None
    assert brain.describe()["invalid"] == 1
    assert llm.active == 0
    await brain.close()


@pytest.mark.asyncio
async def test_replacement_wakes_old_waiters_and_revalidates_candidates():
    llm = DelayedLLM()
    brain = DecisionBrain(llm, BrainConfig())
    brain.select("at-shore", OPTIONS, {})
    await llm.entered.wait()
    waiter = asyncio.create_task(brain.wait_ready("at-shore", 5))
    await asyncio.sleep(0)
    brain.select("at-shore", {"hide": "在营地等候", "return": OPTIONS["return"]}, {})
    assert await waiter is None
    llm.release.set()
    assert await brain.wait_ready("at-shore", 1) is None
    assert llm.inputs[0]["decision_id"] != llm.inputs[1]["decision_id"]
    assert llm.max_active == 1 and brain.describe()["invalid"] == 1
    assert brain.describe()["cancelled"] == 1
    await brain.close()


@pytest.mark.asyncio
async def test_timeout_cancels_stream_without_retrying_an_unchanged_decision():
    llm = DelayedLLM()
    brain = DecisionBrain(llm, BrainConfig(timeout_s=.02))
    brain.select("blocked", OPTIONS, {})
    await llm.entered.wait()
    assert await brain.wait_ready("blocked") is None
    assert brain.select("blocked", OPTIONS, {}) is None
    assert brain.describe()["timed_out"] == 1
    await brain.close()
    assert llm.active == 0 and len(llm.inputs) == 1
    brain.select("after-close", OPTIONS, {})
    assert brain.describe()["requested"] == 1


@pytest.mark.asyncio
async def test_close_returns_if_provider_suppresses_cancellation_and_late_reply_is_ignored():
    class StickyTransport:
        def __init__(self):
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.finished = asyncio.Event()

        async def stream_chat(self, messages):
            token = json.loads(messages[-1]["content"])["decision_id"]
            self.started.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                await self.release.wait()
            try:
                yield LLMDelta(kind="text", text=json.dumps({"decision_id": token, "candidate_id": "return"}))
            finally:
                self.finished.set()

    llm = StickyTransport()
    brain = DecisionBrain(llm, BrainConfig(timeout_s=.04))
    brain.select("during-danger", OPTIONS, {})
    await llm.started.wait()
    brain.cancel()
    try:
        await asyncio.wait_for(brain.close(), 1)
        assert not llm.finished.is_set()
    finally:
        llm.release.set()
        await asyncio.wait_for(llm.finished.wait(), 1)
    assert await brain.wait_ready("during-danger") is None
    assert brain.describe().get("completed", 0) == 0


@pytest.mark.asyncio
async def test_error_disabled_and_single_option_use_local_fallback():
    def broken(_):
        raise ConnectionError("offline")

    llm = DelayedLLM(broken)
    brain = DecisionBrain(llm, BrainConfig())
    assert brain.select("only", {"forage": "唯一候选"}, {}) is None
    assert not brain.describe()["pending"]
    brain.select("choose", OPTIONS, {})
    llm.release.set()
    assert await brain.wait_ready("choose", 1) is None
    assert brain.describe()["errors"] == 1
    await brain.close()
    disabled = DecisionBrain(llm, BrainConfig(enabled=False))
    assert disabled.select("disabled", OPTIONS, {}) is None
    assert len(llm.inputs) == 1
    await disabled.close()


def test_brain_config_round_trips_and_checks_deadlines(tmp_path):
    config = VoxkinConfig(brain=BrainConfig(enabled=False, timeout_s=.8, result_ttl_s=10))
    saved = save_config(config, tmp_path / "brain.yaml")
    assert load_config(saved, with_local=False).brain == config.brain
    config.brain.timeout_s = float("nan")
    with pytest.raises(ValueError, match="brain.timeout_s"):
        config.validate()


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True])
async def test_brain_can_share_the_openai_compatible_adapter(stream):
    async def chat(request):
        payload = await request.json()
        decision = json.loads(payload["messages"][-1]["content"])
        answer = json.dumps({"decision_id": decision["decision_id"], "candidate_id": "return"})
        if not payload["stream"]:
            return web.json_response({"choices": [{"message": {"content": answer}}]})
        chunks = [json.dumps({"choices": [{"delta": {"content": part}}]}) for part in (answer[:8], answer[8:])]
        return web.Response(text="".join(f"data: {chunk}\n\n" for chunk in chunks) + "data: [DONE]\n\n",
                            content_type="text/event-stream")

    app = web.Application()
    app.router.add_post("/v1/chat/completions", chat)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    endpoint = f"http://127.0.0.1:{server.addresses[0][1]}/v1"
    llm = OpenAICompatLLM(LLMConfig(base_url=endpoint, api_key="local-only", stream=stream))
    brain = DecisionBrain(llm, BrainConfig())
    try:
        brain.select("repair", OPTIONS, {"health": 18})
        assert await brain.wait_ready("repair") == "return"
    finally:
        await brain.close()
        await llm.close()
        await server.cleanup()
