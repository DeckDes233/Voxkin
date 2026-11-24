# 变更记录

## Unreleased — 2026-11-11 整理与复核

- 整理中英文 README、安装与 Minecraft 接入流程；补充文档分类索引、开发指南及配置、脚本、工具目录说明。
- 明确 G1/G2 的独立验收与历史证据边界，保留 2026-10-28 的恢复、资源补给和原生异常调查记录。
- 提交前离线回归 Python 554 passed、Bridge 310 passed；本轮没有 Minecraft 实机或真实语音基准，见[复核记录](docs/evidence/PRE_PUSH_REVIEW_20261111.md)。

## Unreleased — 2026-10-26–27

### 目标监督与恢复

- S5 已确认的过门回执可保存 source portal / arrival checkpoint 与 receipt 身份；换 Bridge session 后恢复为寻路线索，实际穿门必须重新读取 portal block。普通维度转换的 respawn 包保留 session/revision，死亡与断线继续切换生命周期；bare 原版维度与带命名空间 ID 精确对应，自定义维度不会被子串误认。新增 SQLite 重开恢复及事件路径回归；尚无 S5 实机验收。
- 末地技能准入精确匹配 `the_end` / `minecraft:the_end`，拒绝名称中恰好包含 end 的自定义维度。重启后 root 完整自动化结果为 Python 451 passed、Bridge Node 24.19.0 `--jitless` 215 passed；不代表 S3–S6 实机通过。
- 标准 S0–S6 接入 `GoalSupervisor`；`src/voxkin/agent/goals.py::GOALS` 成为阶段验收条件唯一来源，进度判断与 Studio 状态读取同一契约。
- SQLite `goal_states` 保存 schema version 2 的目标快照，包括目标/方法位置、在途 action ID、观察会话与 revision、预算、计数、最近观察和恢复原因。旧 `TaskRunner` checkpoints 保留给兼容的线性评测任务。
- S2 从固定步骤游标改为基于新鲜观察补齐生存依赖：白天可准备材料，夜晚/危险时优先建立封闭庇护所；食物、室内床、睡眠或安全守夜均纳入条件判断。S3 根据铁料/木料缺口有限选择采集和返地表方法；S4 钻石目标策略也已集成在 `goal_methods.py`。S6 部分使用眼球 overhead 证据选择有界 `safe_descend` 与框架扫描。S0/S1/S5 仍以预定义路线为主，不构成通用动态规划。R22 只实际派发过新的铁矿采集 action，未完成 S3。
- 修正 S2 铁料需求核算：在两枚铁锭目标下，按现有 `iron_ingot` 数量计算 `mine_collect` 目标，已有两枚时不再安排额外采铁。`tests/test_goal_supervisor.py` 覆盖原矿、已炼铁锭与目标已满足三种库存状态。
- Bridge 断开、死亡、未知结果或安全抢占后先按 action ID 与新鲜世界观察对账；只有可安全重选的方法才按当前净缺口重算。不可重放且缺乏可观察后置证据的动作会持久阻塞。
- 完成状态与任务终态在同一 SQLite 事务提交。Studio、游戏聊天和语音停止入口持久化 `paused_by_user`；自动状态更新不恢复用户已停止的目标，明确续跑时先对账。

### Bridge 执行与 Studio

- 新增 Node `ExecutionController`，统一管理实际动作队列、动作账本、本地安全抢占以及跟随/闲逛/护甲维护行为。Core 动作派发要求当前 ready 状态、session 和 revision；旧观察不能覆盖新状态。
- 修正床位朝向映射，依据 Mineflayer yaw 转换和原版四向方位计算，四向测试覆盖与 bot 同向的结果。`findNearbyBeds` 改为按注册表方块 ID 搜索后再读取新鲜 `blockAt`，不再用 predicate 遍历所有候选方块；该改动消除 r14 栈中出现的全量 predicate 搜索路径，但尚不能证明它是 Node 退出的根因。新动作启动时会停止并清除 Pathfinder 遗留目标，防止上一动作的 stop 状态影响首个 `GoalFollow`。床位 AABB 清位后，r16 受控库存任务 1 成功放置床并完成 40/40 sealed/inside 庇护所；这不是自然采矿或夜间验收。r16 新夜间任务没有通过 `sleep_confirmed` 验收，尽管之后观察到了白天；Node 22 在清理前以 `0xC0000005` 退出，stderr 无 fatal stack，根因未归因。`sleep_safe` 现在要求观察到睡眠回执、离床并在有限等待中确认世界时间前进；day/time 同时有效时按绝对 ticks 差判定推进，并拒绝 day 回退；Bridge 与 `sleep_safe` 共用此判定。Node 24.19.0 `--jitless` Bridge 模拟 bot 全套 175 项通过，根级 end.test 另有 14 项通过；这不证明实机 native exit 已解决。受控 r17 在 Node 24 下完成床/庇护所与入睡到天亮；r20 又在保存副本上通过一次自然夜间睡眠目标。R24 在 Node 24.19.0 `--jitless` 的两个实机进程均以 `0xC0000005` 清理前退出；自动化测试通过不排除该现象，且目前不能归因根因。这些结果不验证多夜生存或 S3–S6。
- Studio 运行面板显示目标、状态、等待/阻塞/恢复原因、在途动作及动作预算；存在目标时不再用固定步骤游标表示目标完成度，无目标时保留旧式线性评测状态。
- 增加显式 `engine: silent` 配置，用于无需外部 TTS 的动作/测试场景；状态报告如实显示静音引擎。

### 本轮验证边界

- r18b 在保持源时钟、天气与 gamerules，且阶段内无注入的条件下完成 S0/S1 和 S2 白天准备；剪羊后达到 white wool×3，并完成床与 40/40 sealed/inside 庇护所。之后 R20 从保存的世界和 SQLite 目标库副本继续，在未注入时间的昼夜周期中等待到夜晚后以新鲜观察启动 S2 task 4，`sleep_safe` 成功，目标 `night_required=true`、`sleep_confirmed=true`、`done/stage_complete=true`，观察到白天后结束。R20 与 r18b 是分开的运行，不构成多夜生存或 G1；189.8 秒阶段时间包含约 182 秒昼夜等待，不是性能基准。R21 的 S3 `strip_mine` 曾因无安全阶梯落点 blocked。R22 从保存副本恢复 task 5，迁移旧 blocked action 且未重放，随后派发 9 raw iron 目标的 `mine_collect`；存档 playerdata 有 raw_iron×3，但 R22 最后 observation 未同步库存，Node 24 清理前以 `0xC0000005` 退出。R23 用 `--jitless` 续跑同一 task 并确认 raw_iron×3，之后地下缺木、64 格内没有橡木，三次 `mine_collect(oak_log,count=1)` 后以 `budget_method_attempts` blocked，22.4 秒、`stage_complete=false`。R24 从 R23 副本继续但因启动器漏传 `PRESERVE_SOURCE_CLOCK`，fixture 执行 `time set day` 把源时间 9176 改成 1000，故只作为诊断，不算保留时钟实验；S3 `disconnected` 且未完成。Node 24.19.0 `--jitless` 两个进程均清理前 `0xC0000005`；runner 第一次重启成功，第二次退出后 QA 明确请求 API stop，不能据此判断未中断时 runner 会否继续重启。R25 从有效 R23 副本保留时钟续跑，三次 Bridge `0xC0000005` 均触发 runner restart，目标随后因 method-attempt budget 阻断并正常保存；R25 副本晋升为下轮 source。R16/R22/R24/R25 清理前退出已在 Node 22 与 Node 24 观察到，根因未归因。R26 Linux Minecraft 实机尚未启动。r14 是较早 S2 断连结果；标准 `run_stage.py` 启动时会设置 `time set day`，不能描述为全程无时间注入。完整运行证据与历史见 [GOAL_REFACTOR_20261026.md](docs/evidence/GOAL_REFACTOR_20261026.md)。

- R25 从 R23 world/DB 副本继续 S3，初始观察时钟自然从 source 的 9176 推进到 9237，无新增库存、时间、天气或地形注入；goal 在 `s3:surface_route:shelter_anchor` 三次 method-attempt 后以 `budget_method_attempts` 阻断，40.5 秒、0/8、`stage_complete=false`。raw_iron×3、health=20、food=18 保存；三次 Bridge `0xC0000005` 均由 official runner 重启成功，最终 replacement 活到目标阻断后的清理。restart budget 未耗尽；Core 正在拆分 transport restart 与 method-attempt 预算记录，不据此归因 runner 故障、物理动作完成次数、Node 稳定性或 native 根因。R25 保存世界晋升为续跑源，R26 Linux Minecraft 实机尚未启动。
- 最新 root 独立 Python 全量回归：`$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'; .\.venv\Scripts\python.exe -B -m pytest -p pytest_asyncio.plugin --assert=plain --noconftest tests -q --tb=short`，444 passed、54 warnings、66.42 秒、exit 0，覆盖 S4 策略、部分 S6 搜索/下探、combat/Nether 路径与 transport/method 预算改动。Windows Node 24.19.0 `--jitless` Bridge 全套 210 passed、约 0.67 秒、exit 0；Ruff F821/F823 与 `git diff --check` 通过。仓库没有 `conftest.py`；`--noconftest` 跳过未使用的 conftest discovery，不代表已解决 Python 3.10 collection access violation 根因。此前 root 对 S4 candidate 的收集在 `pathlib.casefold_parts` / `_pytest.config._is_in_confcutdir` access violation、断言未执行；`-B --assert=plain` 不能称可靠规避。候选 agent 报告的 42 项未由 root 重复。候选方案已有部分进入生产（S4、部分 S6、combat 和 Nether 路径）；S4–S6 仍无实机阶段通过。较早的 425/414 全量与 66 项 S3 定向结果保留为历史快照。
- 官方 Linux Node 24.19.0 便携包已按同目录 `SHASUMS256.txt` 验证 SHA-256；WSL Ubuntu 22.04 root 直接执行生产 Bridge 全套 175/175 通过，1430.905765 ms、exit 0。默认 WSL user 的 systemd/exec timeout 只记为未完成调用，不算测试失败或通过；该模拟 bot 回归不等于 Linux Minecraft 实机验收。
- R26/R26b Linux 启动尝试均未启动 Paper 或执行游戏动作，R25 仍是最后有效的 S3 world/DB 保存来源。R26 因 startup variable 错误在游戏前结束；R26b Linux Node/helper 在 `/mnt/d` I/O 状态停留，TERM/KILL 后未观察自然退出码。R27 已获准使用独立 Linux ext4/fixed-hash bundle；QA 报告 profile/TCPrelay adapter 预检 10 项通过。首次 wrapper preflight 因误校验 release bundle 按设计不含的 `bridge/package-lock.json` 而退出；修正 source glob 后第二次通过本地 manifest/hash 与 WSL route，但 ext4 bootstrap Popen 在 45.034 秒超时、未收到 bundle event。对精确 v3 archive 的只读 Linux ext4 Python `tarfile` 流读取也在 1,792 个成员/70,227,142 bytes 后停滞；同一 archive 在 Windows 完整读取 6,640 entries/599,633,870 bytes、用时 1.83 秒。GNU `timeout` launcher 33.989 秒后 code 9、stderr 空；这不是 Node crash。之后 12 秒 `/proc` 只读探测亦超时。没有创建游戏 target/fixture，Paper/Game/Core/Bridge 均未启动。root 仅运行 `wsl.exe --terminate Ubuntu-22.04`（exit 0），随后确认三个 WSL 发行版均为 `Stopped`；没有全局 WSL shutdown、service/Windows 重启，也不是 Node/Python 自然 exit 0。当前会话非管理员且 `WslService` 正运行，需管理员恢复 WSL 环境后再从 R25 续跑。暂停 bootstrap 工具开发和相同条件重试，不诊断硬件或声称项目改动可修复宿主 AV；R27 无 Minecraft 阶段结果，S3 未完成、S4–S6 未实机验收。完整启动诊断与 archive 路径/hash 见本轮实机记录。

本节所称“无阶段内注入”只描述各次阶段命令。R18b 源世界在复制前已包含三张彩色床与蜡铜平台；同一布局在 2026-10-22 最早留存的 `eval_server` 中也存在，初次放置命令未找到。R18b/R20 没有地形注入，行动记录未使用该地下布局，因此具体采集、庇护所和睡眠行为事实保留，但复制世界不作 clean vanilla G1 证据。

### STT 流式候选评估

- 新增 Paraformer 逐块回放研究：3 条有参考文本的 FLEURS 真人录音在 RTX 4060 Laptop 与 4 线程 CPU 上均完成三次测量；结果、误差、VAD 分离口径及限制见 [研究报告](docs/research/PARAFORMER_STREAMING_20261026.md) 与 [基准](docs/BENCHMARK_RESULTS.md)。该候选尚未接入正式适配器，三样本回放不代表真实麦克风/噪声验收。

### Qwen3-TTS-GGUF 隔离探针

- 在独立 Python 3.14 环境中，使用官方 Qwen 1.7B Base 原始权重按上游脚本导出 Talker Q5_K/Predictor Q8_0，并通过 llama.cpp Vulkan 生成 PCM/WAV。ONNX decoder 使用 CPU provider；DirectML 路径未通过初始化。
- warmset 三条文本 RTF 均低于 1，但首次短句冷启动与后续新进程结果差异较大且原因未核实。本次结果不是 Voxkin 生产适配器、扬声器延迟或主观音质验收；集成限制和原始证据见 [研究报告](docs/research/QWEN3_TTS_GGUF_20261026.md) 与 [基准](docs/BENCHMARK_RESULTS.md)。

## Unreleased — 2026-10-22

### S2 羊毛采集

- 新增 `shear_sheep`，结合 Mineflayer 的 `metadataKeys` 解码羊的颜色、是否剪过和幼年状态；逐只剪羊、收集掉落并检查背包增量，支持取消与低血量中止。
- `S2_STEPS` 改为先备煤烤肉、挖铁并补充熔炼燃料、制作剪刀、剪取同色羊毛后合成床；Verifier 检查单色羊毛数量与床库存。
- 新增 8 个 Node 模拟测试；完整 Python 测试为 270 passed。剪羊与 S2 路线尚未在真实 Minecraft 服务器验证。

### 技能层

- 新增 `bridge/skills/manifest.js` 与 `bridge/skills/manifest.json`：57 个技能（21 个桥接内建 + 36 个模块技能）的单一事实来源，记录参数、前置条件、观察项、执行步骤、后置条件、失败条件、恢复策略、超时、可打断性与判定依据，由 `scripts/dump_manifest.js` 导出。
- Core 侧新增 `src/voxkin/agent/skills.py`，从清单读取技能并生成工具 schema；`tests/test_skill_manifest.py` 校验清单、桥接分支与 Core 工具定义三方一致。
- 新增 `bridge/skills/end.js` 的 `throw_eye`、`activate_end_portal`、`fight_dragon`、`return_home`，补齐末影之眼定位、末地门激活、末地水晶清理、末影龙战与返回主世界；纯几何与状态判断单独导出，便于不连服务器验证。
- 动作结果改为结构化状态：`accepted`、`running`、`succeeded`、`partial`、`failed`、`cancelled`、`disconnected`、`blocked` 八档，贯穿 `src/voxkin/bridge/protocol.py`、`src/voxkin/agent/actions.py`、`src/voxkin/agent/runner.py` 与桥接的 `reply()`；每一步记录 `status`、`skill_id` 与 `action_id`，可以按 action_id 回查桥接消息。
- 技能 handler 的结构化终态现在会原样传回 Core；Runner 遇到 `always` 规则时只接受明确的 `succeeded`，避免把部分完成或失败误记成步骤成功。
- 新增 `docs/SKILLS.md` 技能总表：每项技能的状态、源文件行号、缺失能力与验收方法。
- 新增 `docs/research/MINDCRAFT_SKILL_MAP.md`：MindCraft 可迁移机制与 Voxkin 的落点对照，含技能依赖字段（`produces`、`consumes`、`deps`）的补齐建议。

### 自主任务

- 新增 `TaskRunner`、`StepSpec`、机器 `Verifier`、SQLite checkpoint 与 `RunManager`，提供 `/api/run/start|status|stop`。
- 新增 S0 计划：空背包收集 3 原木 → 12 木板 → 工作台 → 4 木棍 → 木镐；S0–S6 阶段表扩展到 53 步，S3–S6 覆盖铁装、钻石、下界与末地路线。
- S0 在固定 seed 的 Peaceful 功能试跑中连续 2 次 5/5，证据见 `docs/evidence/S0_20261022.md`。
- S0 在 Normal 难度下连续 10 次 5/5，用时 34.3–38.5 秒，P50 36.4 秒，证据见 `docs/evidence/S0_NORMAL_20261022.md`。
- S1 在同一评测世界接 S0 跑通 1 次 5/5（78.9 秒），证明石镐、石剑与熔炉的固定计划可在 Normal 难度完成；这是首次通过，不是 3 次/3 夜的 M3 退出验收，证据见 `docs/evidence/S1_NORMAL_20261022.md`。
- 新增 `scripts/run_stage.py` 与 `scripts/eval_stack.ps1`：固定 seed 评测服务器的重置、启停、难度设置与阶段重复运行，汇总写入 `runs/registry/`。

### 语音快路与语音缓存

- 落地 [docs/plans/VOICE_ACTION_LATENCY_PLAN.md](docs/plans/VOICE_ACTION_LATENCY_PLAN.md) 的阶段 0、阶段 1 与阶段 2 最小闭环：本地规则命中就提交动作并播确认语，不等云端模型。
- `src/voxkin/events.py` 在保留 `t0`–`t8` 的前提下补 `t_cmd_final`、`t_intent_done`、`t_ack_ready`、`t_audio_start`、`t_action_submit`、`t_action_start`；缺观测点由 `TurnTimeline.require()` 显式失败。
- `src/voxkin/intent.py` 新增 `IntentPlan`：停止、跟随、过来、攻击、进食、睡觉、观察、背包、采集等低歧义命令产出技能与参数；能力询问不触发动作，同回合内与模型重复的调用只执行一次。
- 新增 `src/voxkin/voice/phrase_catalog.py`（47 条确认语目录）与 `src/voxkin/voice/cache.py`（WAV + sidecar 预合成缓存）：哈希、音色、引擎或参考音频不匹配一律按 miss 处理并记账。
- 新增 `scripts/build_voice_cache.py` 生成缓存（产物在 `work/voice_cache/`，不入库）与 `scripts/latency_scenarios.py` 跑六个合成场景自检。
- 新增 `bridge/skills/labels.js` 与 `scripts/dump_labels.js`：桥接显示方块中文名、Core 解析玩家说的中文方块名共用同一份词表。
- 配置新增 `voice_cache` 与 `fast_path` 两段，关掉后管线退回改造前行为。
- TTS 在回合中途失败不再让整轮对话失败：动态合成异常时如实记录 `tts_error` 并继续，缓存确认语照常播放。

### 修复

- 掉落物过滤改用 `entity.name === 'item'`，此前 `entity.type === 'item'` 永远匹配不到，挖树后捡不到原木。
- 采集目标改为按树干底部接近，避免 pathfinder 爬树；单棵树 30 秒上限并自动换目标。
- 合成改为自己操作合成窗口，逐格放置并留 80 ms 确认间隔；放下工作台后回收，修复 3x3 配方找不到工作台。
- 动作完成后先推一帧世界状态再回结果；Runner 验证最多等待 6 秒，避免用旧背包误判。
- 采集/拾取后主动同步背包，修复 mineflayer 漏掉 `set_slot` 导致的假空背包。
- 采集寻路被外部停止时不再误判成怪物打断：寻路结果分成到达、走不到、取消、血量不足四类，走不到才换目标，外部停止直接结束技能。
- 采集掉落物改为等到实体出现、走进拾取范围并核对背包数量变化，捡不到时如实报告丢失数量。
- 合成改为桥接自己发 `window_click` 包并推演本地窗口状态，不再等待服务端重发结果槽位；此前摆放第一个材料就会卡满 20 秒并失败。
- 合成材料不足时报出还缺的数量并把鼠标上的物品退回背包，失败时还原合成格，材料不会被卡在窗口里。
- TTS 服务不可用时 Core 降级为 `SilentTTS`，只记日志不阻塞动作，`describe()` 如实报告 `adapter_ready=false`。
- 修复 `bridge/skills/gather.js` 把普通坐标对象传给 `bot.blockAt()` 导致的 `pos.floored is not a function`：统一经 `toVec3()`/`blockAtPos()` 转成 bot 的 Vec3，覆盖文件内 22 处调用；修正后 S1 一次通过 5/5。

## 0.1.0 — 2026-10-21

### 新增

- Voxkin Core：`ConversationPipeline`，支持流式 LLM、增量分句、流式 TTS、播放队列、打断与延迟时间线。
- 适配器：OpenAI 兼容流式 LLM、GPT-SoVITS `api_v2` 流式 TTS、Genie TTS（进程内 ONNX，受词表限制）、faster-whisper 识别、能量 VAD。
- 音频输出：扬声器、WAV 目录、Minecraft 文件投递。
- 动作通道：`ActionDispatcher` 与 Minecraft 桥接 WebSocket 协议，动作完成以桥接返回结果为准。
- Minecraft 桥接客户端 `bridge/minecraft_bridge.js`，支持聊天转发、移动、挖掘与状态上报。
- Voxkin Studio：状态、试听、实时事件、延迟分解、配置、受管服务启停与健康检查、日志。
- 本地测试 LLM：`tools/dev_llm_server.py`，OpenAI 兼容流式接口。
- 文档：仓库审计、MindCraft 源码审计、架构、技术评估、决策、路线图、状态、基准。

### 实测

- 5 轮连续对话，真实 TTS 与扬声器，首次可听延迟中位数 964 ms（复测 1173 ms）。
- Minecraft 端到端：Paper 1.21.1 上玩家聊天触发语音回复与挖掘动作，首次可听 975–1494 ms，动作完成 6108 ms。
- GPT-SoVITS 预热后首字节 2.4 秒 / 5.3 秒音频，RTF 0.477；`cut5` 首字节 1.17 秒。
- faster-whisper small / int8：9.88 秒中文音频 2.58 秒。
- 真实模型经 OpenCode Go 接入：3 轮首次可听 3134.9–4434.9 ms，模型返回 `collect_blocks` 并在游戏内完成挖掘。
- 工具定义下发与动作结果播报：开始前确认、完成后回报，失败时说明。
- 长期记忆：SQLite 保存对话，空闲时压缩摘要，关键词检索并按 token 预算组装上下文。
- 识别结果繁简转换。
- 识别幻觉过滤：拦截「字幕by索兰娅」等 Whisper 模板输出、重复循环、低信息与低置信片段。
- WebSocket 音频推送与 Fabric 客户端 Mod（PCM 顺序播放与打断）。
- 中文、英文与小白版文档；Studio 截图。
- 识别过滤：17 个单元测试通过，真实 5 秒静音输入返回空文本。
- 项目采用 MIT 许可证。
- 麦克风对话模式：VAD 自适应校准、输入增益、播放结束回声冷却、只听不答模式。

### 已知限制

- Genie TTS 无法加载 v2Pro 512 词表模型。
- 模型返回纯工具调用时没有正文，玩家先听到固定确认语。
