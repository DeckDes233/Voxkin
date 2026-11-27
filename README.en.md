# Voxkin

A real-time voice companion and autonomous-action prototype for Minecraft Java 1.21.1. Python Core handles conversation, speech and tasks; a Mineflayer bridge executes game actions; an optional Fabric mod plays voice in the client.

[中文](README.md) · [Documentation index](docs/README.md) · [Setup guide (Chinese)](docs/GETTING_STARTED_CN.md) · [Minecraft setup (Chinese)](docs/ENTER_MINECRAFT_CN.md) · [Contributing](CONTRIBUTING.md)

## Goals and status

- **G1 — autonomous completion:** start with an empty inventory, plan, act and recover independently, and defeat the Ender Dragon. S0–S6 belong to this acceptance track.
- **G2 — player interaction:** understand and execute player goals, accept changes, interruption and cancellation, and report actual progress. This requires separate acceptance.

A persistent `GoalSupervisor` plans from inventory, terrain and dimension observations. The bridge handles movement, gathering and emergency responses locally. With an LLM configured, Core can ask it to choose between feasible strategies, such as widening a surface wood search or moving to another site. Core rechecks the world before acting and uses its local plan if the reply times out or fails validation.

Studio defaults to autonomous survival, which extends the action budget when Voxkin makes measurable progress. Select stage acceptance for a fixed budget. Both modes use the same S0–S6 completion criteria. Resuming a task preserves its mode and action count. [Run settings (Chinese)](config/README.md#自主任务)

In Studio, the Chinese command “背包里有什么” asks what Voxkin is carrying. In headless Paper tests, Voxkin returned its inventory during both mining and Nether scouting. The mining action went on to finish, and the scout continued pathfinding under the same action ID. A local rule handles this query. Automated tests cover microphone capture during replies and spoken interruptions. [Scheduling and interruptions](docs/ARCHITECTURE.md#任务语音与动作控制)

Three of five empty-inventory runs on November 25 passed S0–S4 in sequence. All three used the 120-action S5 budget. In the furthest run, Voxkin mined ten obsidian, drained and lit its portal, and scouted the Nether. A fourth run was interrupted after S3. The remaining run escaped a flooded mine, later drowned, and passed S3 after rebuilding its tools and iron equipment. Gathering the required rods and pearls, killing the dragon and returning home still need an end-to-end survival pass. [November 25 survival runs](docs/evidence/NATURAL_S0_S6_20261125.md) · [Earlier End combat tests](docs/evidence/HEADLESS_S4_S6_20261123.md)

On November 27 the fifth run resumed from its saved action. S4 reached its original 120-action limit before Voxkin could rebuild a diamond pickaxe. Two new empty-inventory runs passed S0 and S1. Both reached the S2 time limit, one while searching for wood from a shore and the other after a creeper cut off access to shelter materials at night. A separate test on a copy of the first save recovered an oak log. [November 27 survival results](docs/evidence/NATURAL_S0_S6_20261127.md)

| Area | Evidence boundary |
| --- | --- |
| Conversation, TTS/STT and game bridge | Implemented; engines and models require local configuration. [Benchmarks](docs/BENCHMARK_RESULTS.md) distinguish real APIs from the local test LLM |
| S0–S2 | Fresh-world passes recorded; recent S2 passes cover daytime preparation, not actual overnight sleep or three-night survival |
| S3 | Voxkin mined and smelted iron and crafted an iron pickaxe, iron sword, shield and bucket. A later run demonstrated escape from low oxygen while mining and an 18.3-block move over dry ground. [Survival runs](docs/evidence/NATURAL_S0_S6_20261125.md) |
| S4 | The same empty-inventory survival run passed S4 after a host restart. Voxkin found an overland route to wood, replaced a broken iron pickaxe underground, mined four diamonds and crafted a diamond pickaxe. [Headless Paper rerun](docs/evidence/SURVIVAL_RERUN_20261123.md) |
| S5 | An empty-inventory run reached the Nether through a portal built with naturally mined obsidian. Fortress supplies and the return trip remain open. |
| S6 | In an earlier test the server located a stronghold and supplied a nearby starting point and equipment. Voxkin threw eyes, filled the frames, entered the End and destroyed crystals. That version could also read frames through walls. Combat saves confirm damage to the dragon. Finding the portal from a natural start, killing the dragon and returning home remain open. [Portal and combat rerun](docs/evidence/SURVIVAL_RERUN_20261123.md) |
| Village supplies and iron-golem harvesting | Implemented and covered by offline tests. Live acceptance remains open |
| Skills | 68 skills. Core exposes 67 model tools. The bridge handles in-game chat. [Skill catalog](docs/SKILLS.md) |
| Fabric audio mod | Builds; real-client playback and spatial audio remain unverified |
| Full unattended completion | Not achieved; Windows native-crash issues remain unresolved |

See [status and evidence](docs/STATUS.md) and [acceptance contracts](docs/MILESTONE.md). Deterministic test doubles do not establish live-game acceptance.

## Quick start

Run from the repository root in Windows PowerShell. Use Python 3.10, Node.js ≥22 for the bridge, and Java 21 for the Minecraft server and mod build.

```powershell
python -m venv .venv
$env:NO_PROXY = "*"
.\.venv\Scripts\python.exe -m pip install -e ".[dev,audio]"
if (!(Test-Path config\voxkin.yaml)) {
    Copy-Item config\voxkin.example.yaml config\voxkin.yaml
}
$env:DEEPSEEK_API_KEY = "<your API key>"
```

The example selects a DeepSeek-compatible endpoint and GPT-SoVITS. Configure your TTS endpoint, reference audio and matching transcript in `config/voxkin.yaml`, start your TTS service, then run:

```powershell
.\.venv\Scripts\python.exe -m voxkin doctor
.\.venv\Scripts\python.exe -m voxkin serve
```

Open [Voxkin Studio](http://127.0.0.1:8765). For text/actions without TTS, use the silent configuration in the [setup guide](docs/GETTING_STARTED_CN.md). Microphone input needs `.[stt,audio]` and a Whisper model. Keep credentials in environment variables or ignored `config/local.yaml`; see [configuration](config/README.md).

## Connect Minecraft

Complete the [preflight and server setup](docs/ENTER_MINECRAFT_CN.md) first. With the test server and Core running, open another terminal at the repository root:

```powershell
npm --prefix bridge install
$env:MC_HOST = "127.0.0.1"
$env:MC_PORT = "25565"
$env:MC_VERSION = "1.21.1"
$env:MC_USERNAME = "Voxkin"
$env:MC_AUTH = "offline"
$env:VOXKIN_WS = "ws://127.0.0.1:8765/ws/bridge"
$env:VOXKIN_INDEPENDENT = "0"
node bridge/minecraft_bridge.js
```

Use `VOXKIN_INDEPENDENT=0` for player interaction and `1` for independent progression. See [script notes](scripts/README.md) for stage evaluation, task continuation and the machine-specific quickstart helper.

Audio defaults to the Core host's speakers. Remote players can type in Minecraft chat; microphone capture currently runs on the Core host. Remote microphone streaming is not implemented. In-client voice requires `audio.output: websocket` and the [Fabric audio mod](mod/README.md). Offline servers and the unauthenticated Studio must remain on localhost or an isolated trusted LAN.

## Repository map

| Path | Purpose |
| --- | --- |
| [src/voxkin/](src/voxkin/) | Core, speech, task supervision, APIs and the frontend in `src/voxkin/studio/` |
| [bridge/](bridge/) | Mineflayer, skills, world observations and action receipts |
| [mod/](mod/) | Fabric 1.21.1 audio client |
| [config/](config/README.md) | Configuration example and local override rules |
| [scripts/](scripts/README.md), [tools/](tools/README.md) | Operations, evaluation, manifest maintenance and diagnostics |
| [tests/](tests/), [bridge/tests/](bridge/tests/) | Python and Node offline tests |
| [docs/](docs/README.md) | Guides, architecture, plans, research and evidence |
| [runs/](runs/README.md) | Local run-artifact conventions |

`work/`, `models/`, `data/` and `logs/` contain ignored local runtime assets. Preserve worlds, task databases and unresolved receipts. See [contribution rules](CONTRIBUTING.md) and [agent instructions](AGENTS.md).

## Development checks

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
Push-Location bridge
node --test
Pop-Location
git diff --check
```

Offline tests do not start Minecraft or measure real-engine latency. Historical Windows pytest collection crashes and the `--assert=plain` workaround are documented in [CONTRIBUTING](CONTRIBUTING.md). Read the activity marker before any live run and follow the blocking/recovery rules in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party engines, models and reference recordings have separate terms; see [license analysis](docs/LICENSE_ANALYSIS.md).
