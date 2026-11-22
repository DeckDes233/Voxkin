# Voxkin

A real-time voice companion and autonomous-action prototype for Minecraft Java 1.21.1. Python Core handles conversation, speech and tasks; a Mineflayer bridge executes game actions; an optional Fabric mod plays voice in the client.

[中文](README.md) · [Documentation index](docs/README.md) · [Setup guide (Chinese)](docs/GETTING_STARTED_CN.md) · [Minecraft setup (Chinese)](docs/ENTER_MINECRAFT_CN.md) · [Contributing](CONTRIBUTING.md)

## Goals and status

- **G1 — autonomous completion:** start with an empty inventory, plan, act and recover independently, and defeat the Ender Dragon. S0–S6 belong to this acceptance track.
- **G2 — player interaction:** understand and execute player goals, accept changes, interruption and cancellation, and report actual progress. This requires separate acceptance.

A persistent `GoalSupervisor` selects actions using inventory, environment and dimension observations and reconciles action receipts. Current stage policies are rule based, with resource reserves, village supplies, iron-golem harvesting and group-threat assessment implemented.

Players can ask what Voxkin is carrying while it mines. The bridge reads the inventory while mining retains control of movement. The microphone keeps listening during replies and supports spoken interruptions when barge-in is enabled. Automated tests cover both paths. [Scheduling and interruptions](docs/ARCHITECTURE.md#任务语音与动作控制)

See the [November 22 headless Paper test](docs/evidence/HEADLESS_S3_20261122.md) for the latest live results.

| Area | Evidence boundary |
| --- | --- |
| Conversation, TTS/STT and game bridge | Implemented; engines and models require local configuration. [Benchmarks](docs/BENCHMARK_RESULTS.md) distinguish real APIs from the local test LLM |
| S0–S2 | Fresh-world passes recorded; recent S2 passes cover daytime preparation, not actual overnight sleep or three-night survival |
| S3 | Collected 12 raw iron and reached the stage time limit while waiting for daylight to gather wood. The reserve collection receipt passed a live retest. Low-oxygen recovery awaits verification |
| S4–S6, village supplies, iron-golem harvesting | Implementation and offline tests exist; no recorded live pass |
| Skills | 67 skills, 66 model tools exposed by Core (excluding `chat`); see [catalog](docs/SKILLS.md) |
| Fabric audio mod | Builds; real-client playback and spatial audio remain unverified |
| Full unattended completion | Not achieved; Windows native-crash issues remain unresolved |

See [status and evidence](docs/STATUS.md) and [acceptance contracts](docs/MILESTONE.md). Deterministic test doubles do not establish live-game acceptance.

## Quick start

Run from the repository root in Windows PowerShell. Use Python 3.10, Node.js ≥20 for the bridge, and Java 21 for the Minecraft server and mod build.

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
