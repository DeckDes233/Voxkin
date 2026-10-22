# 变更记录

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
