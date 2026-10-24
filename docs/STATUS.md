# 当前状态

更新时间：2026-10-24（Asia/Shanghai）。

## 已完成

| 区域 | 内容 | 验证方式 |
| --- | --- | --- |
| 仓库审计 | MiddleAPI、Minecraft Mod、GPT-SoVITS 运行包、MindCraft 上游调用链 | 源码阅读与行号引用，见 `docs/REPO_AUDIT.md`、`docs/research/MINDCRAFT_AUDIT.md` |
| 语音管线 | 流式 LLM、增量分句、流式 TTS、播放队列、打断、时间线 | 43 个自动化测试通过；5 轮真实 TTS 基准 |
| TTS 接入 | GPT-SoVITS `api_v2.py` 的 `streaming_mode`，复用 `xiaote` 音色 | 本机真实合成并播放 |
| 识别 | faster-whisper small，中文识别；模板幻觉、重复循环与低置信片段过滤 | 本机实测；17 个过滤测试；5 秒静音返回空文本 |
| 端点检测 | 能量 VAD，合成音频测试 | 5 个测试用例 |
| 桥接 | WebSocket 协议、动作派发、mineflayer 客户端 | 真实 WebSocket 集成测试；Paper 1.21.1 上完成聊天到动作的端到端验证 |
| 自主任务 | TaskRunner、checkpoint、`/api/run/*`；新增显式续跑、恢复时按世界状态对账、死亡中断落盘、重生后的安全恢复 | Python 全量测试；续跑端点拒绝断桥/过期状态/死亡状态；仲裁器在重连新鲜状态抵达前阻止世界写入；死亡恢复自动化测试通过，尚未做 Minecraft 实机死亡恢复验收 |
| 死亡恢复 | Bridge 本地封锁动作、清空队列并中断当前动作；death/respawn 事件带生命周期 ID，经 Core ACK 后移出待发队列，断线重连会重放；Core 取消仲裁动作并清空断桥世界状态；Minecraft bot 掉线会单独让世界状态失效；重生后仅当新鲜世界状态能证明检查点步骤完成才自动续跑 | WebSocket、Bridge 生命周期 helper、RunManager 与恢复 API 自动化测试；不可验证步骤 fail-closed；未做真实服务器死亡恢复与掉落物回收验收 |
| 生存技能 | 庇护所搭建验收地板/墙顶结构并响应打断；离开庇护所确认已走到墙外；`sleep_safe` 等待 Mineflayer 入睡后再等醒来并核验时间推进，支持取消唤醒 | Node 模拟世界测试 19 项；没有 Minecraft 夜间实机验证 |
| S0/S1 实机证据 | S0 空背包到木镐在 Normal 难度下连续 10 次 5/5；S1 白天固定计划有 3/3 次 S0→S1 链式记录；2026-10-24 两次全链尝试的 S0、S1 也各自完成 5/5 | 固定 seed 的 Paper 服务器运行与 JSONL 逐步判定；历史证据见 `docs/evidence/S0_NORMAL_20261022.md`、`docs/evidence/S1_NORMAL_20261022.md`，最近全链尝试见 `docs/evidence/S0_S6_CHAIN_20261024.md` |
| S2–S6 实机进度 | 2026-10-24 两次隔离 S0→S6 链均在 S2 中断：一次死亡于 S2 第 6/16 步；另一次到第 10/16 步，`shear_sheep` 找不到羊并在重试后断桥。S3–S6 未运行 | 本机原始 JSON/JSONL 与 Paper 日志见 `work/mc/full_s0_s6_20261024/`、`work/mc/full_s0_s6_guarded8_20261024/`；汇总见 `docs/evidence/S0_S6_CHAIN_20261024.md`。后续扩大搜索范围只通过模拟测试，未补做实机验收 |
| 技能清单与阶段计划 | 清单有 64 项技能（21 个桥接内建 + 43 个模块技能），Core 暴露 63 个工具；模块技能可嵌套调用已注册技能；固定 S0–S6 共 63 步。技能代码存在不等于技能经测试或实机可用 | manifest/自动化测试覆盖代码和模拟行为；只有 S0/S1 证据明确覆盖的具体操作有实机证据。技能级证据边界见 `docs/SKILLS.md` |
| 一键本地实机启动 | `scripts/eval_stack.ps1` 可启动 GPT-SoVITS（本地包存在时）、Studio 与独立模式 Bridge；不会启动或重置 Paper 世界 | 先手动启动 Minecraft 1.21.1 专用测试服务器，再运行 `scripts/eval_stack.ps1 -Action start -McPort 25566`；指引见 README |
| 动作状态 | accepted/running/succeeded/partial/failed/cancelled/disconnected/blocked/dead 九档状态贯穿协议、派发、桥接与运行记录 | 每步记录 `status`、`skill_id`、`action_id`；`tests/test_action_status.py` 覆盖 |
| Studio | 状态、试听、事件流、延迟表、配置、受管服务、日志、麦克风启停 | HTTP 接口实测；服务管理用真实子进程测试 |
| 基准 | `voxkin bench` 输出 JSON 与分位数；真实模型与 Minecraft 端到端计时 | `docs/BENCHMARK_RESULTS.md` |
| 真实模型 | OpenCode Go（`deepseek-v4.1-flash`）流式对话、工具调用与延迟测量 | 3 轮基准首次可听 3134.9–4434.9 ms；游戏内触发 `collect_blocks` 成功 |
| 长期记忆 | SQLite 保存对话，空闲时压缩摘要，按关键词检索并限制上下文预算 | 4 轮真实对话后 16 条消息、2 条摘要；摘要延迟 10 秒后生成，不干扰对话 |
| 繁简转换 | 识别结果统一转简体 | 3 个转换测试 |
| 客户端 Mod | Fabric 1.21.1，WebSocket 接收 PCM，Minecraft 流式声源与实体定位 | 构建成功（`voxkin-audio-0.1.0.jar`）；Mixin 目标字段与 1.21.1 映射一致；未在真实客户端验证 |
| 音频推送 | `/ws/audio` 向客户端广播 PCM | 真实 TTS 推送 412160 字节 / 6.44 秒，共 4 个分块 |
| 麦克风对话 | 采集、VAD 校准、识别、语音回复、回声冷却；Studio 内启停 | 真实麦克风：识别 1577.3 ms，播放回复；外放回声不再触发新回合 |
| 语音快路 | 本地规则意图产出 `IntentPlan`（停止、跟随、过来、攻击、进食、睡觉、观察、背包、采集），命中即提交动作并播确认语，不等云端模型；同一回合里模型重复的相同调用会被去重 | `tests/test_intent.py` 与 `tests/test_pipeline.py`；能力询问不触发动作 |
| 语音缓存 | `src/voxkin/voice/phrase_catalog.py` 47 条确认语目录（覆盖 54 个可缓存条目），`src/voxkin/voice/cache.py` 预合成缓存（WAV + sidecar，哈希、音色、引擎或参考音频不匹配一律 miss 并记账） | `tests/test_phrase_catalog.py`、`tests/test_voice_cache.py`；`scripts/build_voice_cache.py` 生成，`work/voice_cache/` 不入库 |
| 时间线 | 保留原有 `t0`–`t8`，补 `t_cmd_final`、`t_intent_done`、`t_ack_ready`、`t_audio_start`、`t_action_submit`、`t_action_start`；缺观测点显式失败 | `tests/test_events.py`；`scripts/latency_scenarios.py` 跑六个合成场景 |

## 测试结果

```
Python 全量测试：PowerShell 中先执行 `$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = "1"`，再运行 `\.venv\Scripts\python.exe -m pytest -p pytest_asyncio.plugin tests -q` → 323 passed，54 warnings。本机默认 pytest 插件自动加载曾触发 CPython access violation；禁用自动插件后全量测试正常完成。语法检查、smoke test、模拟测试只说明对应软件路径/替身行为，不代表 Minecraft 实机通过。
```

Bridge：`node --test bridge/tests/*.test.js` → 93 passed。Bridge 模拟 bot 测试不构成真实 Minecraft 实机证据。

这些 pytest 与 Bridge 测试是本地自动化测试；Bridge 使用模拟 bot。即便 smoke test 或语法检查通过，也不代表 Minecraft 实机执行成功。本轮没有把这些测试作为任何未覆盖技能的实机结论。

新增部分（2026-10-22 晚）落地了 [docs/plans/VOICE_ACTION_LATENCY_PLAN.md](plans/VOICE_ACTION_LATENCY_PLAN.md) 的阶段 0 与阶段 1，以及阶段 2 的最小闭环：缓存命中时确认语不经过 TTS、缓存缺失时走动态合成并受截止时间约束、动作与确认语并行提交。真实扬声器与真实 TTS 下的首音延迟尚未测量，见 [docs/BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) 的未测量项。

## 已知问题

1. 真实模型经 OpenCode Go 接入，接口需要 `x-opencode-session` 头；换用官方 DeepSeek 接口时需要调整配置。
2. 游戏内音频有两条路：文件投递与 WebSocket PCM。WebSocket 路线已接入 Minecraft 流式声源，但未在真实客户端验证；文件投递没有空间音源。
3. 客户端 Mod 只完成编译与协议实现，没有在真实 Minecraft 客户端验证。
4. 麦克风已用真实说话验证；外放音箱时需要 `--no-barge-in`，播放结束后的 1.5 秒内忽略输入。回声靠时间窗规避，没有回声消除，戴耳机才能自然打断。
5. TTS 每句独立请求有 0.4–0.9 秒固定开销；首句过长会推迟出声。
6. Studio 配置修改需要重启服务生效。
7. mineflayer 在 1.21.1 上对部分物品包报 `PartialReadError`，当前不影响动作执行。
8. 记忆压缩依赖模型调用，离线时只保留原始对话，不生成摘要。
9. mineflayer 的 `clickWindow` 在 1.21.1 上点完合成格会等服务端重发结果槽位，凑不齐配方时必然等满 20 秒；桥接已改为自己发 `window_click` 包并推演本地窗口状态，10 次回归均通过。
10. S0 在 Normal 难度下已连续 10 次 5/5、P50 36.4 秒；S1 已在 Node 24 上完成 3/3 轮 S0→S1 白天链式回归（S1 为 95.0、78.9、78.8 秒），但 3 夜生存、换种子与夜间怪物场景尚未回归。
11. 真实服务器证据只覆盖 S0 的 `collect_blocks`/`craft` 与 S1 的 `mine_collect`/`craft`；2026-10-24 两次隔离全链都在 S2 停止，S3–S6 没有运行。不能据技能清单、语法检查、smoke test 或模拟测试宣称技能实机可用。
12. 断桥已从 `cancelled` 拆成 `disconnected`，任务保留 checkpoint；Node 22.23.2 在采集阶段出现过 V8 原生崩溃，当前评测改用 Node 24.19.0，连续 3 轮没有复现。
13. 新增的 `shear_sheep` 有模拟 bot 测试，S2 计划会制作剪刀并剪羊，羊毛与床的计划内判定读取背包。2026-10-24 的真实服务器运行未找到可剪羊，后续扩大搜索范围仅经模拟测试，仍需隔离服务器复验；铁矿采集依赖 `mine_collect` 找到可达矿石。
14. 新增的 `collect_flint` 只在模拟 bot 中验证背包燧石产出；S5/S6 仍是固定计划，烈焰棒、珍珠和末影之眼预算支持最多 12 次单次投眼搜索，另留 12 眼用于门框；投眼步骤不自动重跑，以免重复消耗并丢失单次搜索上下文。整段路线未实机验证。`throw_eye` 找到估算但未发现框架时返回 `partial`，Runner 的 `always` 验收不会把 `partial` 推进为成功。
15. 本轮补入 `fill_water_bucket` 与 `collect_obsidian`：只识别静止水/岩浆源，先直接挖已生成黑曜石，再由上方放水将单个岩浆源浇铸，核实方块和桶库存后收回水源并采集；限制主世界、低血停止、附近敌对生物停止。模拟测试通过后仍需在隔离服务器验证水桶交互、不同地形与流体更新行为。
16. 修正 S3 铁料核算：原版铁镐 3、铁剑 2、盾牌 1、桶 3，共 9 铁锭；盾牌配方此前误写为 6，现已修正。S3 结束条件将 `bucket`、`water_bucket`、`lava_bucket` 视为同一桶资源，避免装水后阶段状态倒退。
17. Bridge 为模块技能补充了 `ctx.runSkill(skillId, args)`：只调用启动时注册的处理器，嵌套共享当前动作生命周期，有限制循环/深度并在进入子技能前检查打断。`raid_fortress`→`fight_blaze` 已有模拟组合测试；未新增运行时热插拔，也未完成 S5 实机验证。
18. `fight_dragon` 清水晶现在优先复用注册的 `break_crystal`，并在调用后重新观察剩余水晶；独立运行的末地战斗若有水晶但没有弓箭会安全失败，不再靠近后尝试近战。新增三个模拟回归测试，Bridge 全套 77 项通过；末地实机行为尚未验证。
19. `break_crystal` 在射击、等待爆炸、撤离和恢复血量阶段检查同一动作的取消信号；取消发生在拉弓/弩时仍通过 `finally` 释放使用状态。新增三个模拟中断测试，Bridge 全套 80 项通过；取消与 Minecraft 服务端/网络交互的时序仍需实机验证。
20. S6 通过单步 `prepare_bow_arrows` 按现有木板/原木选择树种，材料不足时用 `ctx.runSkill('mine_collect')` 嵌套采集，必要时制作工作台，再合成并按背包验证弓与 64 支箭；前置猎材仍要求 3 根线、16 根羽毛和 16 个燧石。模拟测试覆盖非橡木及竹木库存、桦木原木采集、中断与缺料失败。本轮 Bridge 全套 93 项、Python 全量 323 项通过；未进行真实 Minecraft 验证。
21. S6 的 `fight_dragon` 现要求结构化 `ender_dragon_killed` 结果事件；Bridge 在确认龙血归零或“龙不在且返回门出现”时上报事件与证据类型，Core 验收后将事件持久化到当前任务的 SQLite 事件表。断点恢复可用已验收事件跳过重复击龙，Studio 阶段状态在服务重启后也从最近任务事件恢复；这仍是代码/模拟测试证据，不代表真实服务器上的龙战通过。

## 阻塞与前置条件

| 阻塞 | 需要什么 |
| --- | --- |
| 客户端 Mod 端到端 | 可运行的 Minecraft 1.21.1 客户端与 Fabric 环境 |
| 空间音效 | 真实客户端里验证距离衰减与跟随机器人移动 |
| 官方 DeepSeek 接口 | 官方 API Key 与费用授权；当前使用 OpenCode Go 订阅 |

## 下一步三件事

1. S1 已完成 3/3 轮白天链式回归；庇护所与 `sleep_safe` 的代码侧模拟测试已补齐，下一步在专用世界验证真实夜间睡眠与 3 夜生存。
2. 在专用世界实测 `/kill` 后的动作中断、重生与检查点续跑；当前代码不会自动找回死亡掉落物，需先验证安全的掉落点观测与回收策略。
3. 先在隔离服务器验证 S2 铁矿采集、剪羊、床与庇护所链路；再逐段验收 S3–S6，尤其确认燧石、黑曜石、下界资源与要塞定位，不要直接跳到末地。
