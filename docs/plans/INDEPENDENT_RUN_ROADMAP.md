# 沃心独立通关 Minecraft：M 阶段路线图与 TODO

> 最后的milestone是沃心独立通关一次mc，全流程，我只负责旁观。

基于 2026-10-21 仓库现状（90 个测试通过）做只读分析，只新增本文档。阶段顺序 `M0 → M1 → M2 → (M3 ∥ M4) → M5 → M6 → M7 → M8 → G1`；每阶段有独立验收脚本，G1 是最终全流程验收。

## 1. 现状与关键差距

| 层 | 已具备 | 缺口 | 影响 |
| --- | --- | --- | --- |
| Core | 语音回合、世界状态注入、单次工具派发、`TaskStore` 三张表 | 无 TaskRunner 循环、无工具结果回填、无 `/api/run/*` | 一次动作结束后不会自动进入下一步 |
| Bridge | 12 个工具、闲逛/战斗反射、装备自动穿戴、死亡监听 | craft/smelt/sleep/chest/trade/portal/bow 全缺；`pickup_items` 只走近不拾取；死亡后无重生与恢复 | 木镐之后整条链断开 |
| 阶段表 | S0-S6、按背包判定完成 | S2 产出 bread、S4 产出 enchanting_table，偏离最低通关路径；无 checkpoint 语义 | 阶段无法直接作为验收依据 |
| 验收环境 | Paper 1.21.1、生存模式 | seed 未固定、`difficulty=easy`、`view-distance=4`、无 run 记录 | 结果不可复现，失败无法归因 |
| 零干预 | 跟随与距离提醒 | `resolvePlayer` 与 `checkPlayerDistance` 会向玩家索要坐标 | 无人在线时产生求助聊天，违反旁观前提 |

## 2. M 阶段总表

| 阶段 | 目标 | 范围 | 交付物 | 退出条件（独立验收） | 依赖 | 人日 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M0 | 可复现的测试世界与 run 记录 | 固定 seed、world 模板、重置脚本、状态/动作 JSONL、阶段判定基线 | `scripts/mc_reset.ps1`、`runlog.py`、`runs/` 规范、基线报告 | 同 seed 重置 3 次出生点一致；30 分钟纯观测日志完整；90 tests 绿 | — | 2-3 | seed 与版本漂移、磁盘增长 |
| M1 | 长任务循环与进程级恢复 | TaskRunner（PLAN→ACT→VERIFY→RECOVER）、Verifier、checkpoint、`/api/run/*`、死亡重生、卡住检测、独立模式 | `agent/runner.py`、`tasks.py` 扩展、server 路由、恢复测试 | S0 片段跑 30 分钟；断 bridge、重启 Core、`/kill` 各一次后自动续跑，重复动作 ≤1 | M0 | 5-7 | 恢复点与世界状态不一致；重复执行 |
| M2 | 空背包到木镐（S0） | skill registry、craft 配方、工作台放置与回收、S0 模板 | `skills/manifest.js`、`index.js`、`craft.js`、`tools.py` craft | 空背包 10 分钟木镐+工作台，10 次 ≥8 | M1 | 3-4 | 出生点无树、工作台丢失 |
| M3 | 石器、熔炉与第一夜（S1） | 采集工具切换、石制工具、熔炉与燃料、封洞过夜、火把 | `gather.js`、`craft.js` 扩展、`survival.js` | 15 分钟石镐/石剑/熔炉，3 夜不死 | M2 | 3-4 | 石头在地下、夜间怪 |
| M4 | 食物、床与死亡恢复（S2） | eat、狩猎与熟肉、羊毛与床、sleep、死亡重生与掉落处理 | `survival.js`、`combat.js` 扩展、恢复路径 | 跨 3 游戏日 food≥8、睡眠 3/3、死后 5 分钟恢复 | M2（与 M3 并行） | 4-5 | 羊与食物稀缺、床被破坏 |
| M5 | 铁装与盾（S3） | 分支矿道、铁矿、熔炼、铁镐/剑/盾、箱子暂存 | `strip_mine`、smelt、`storage.js` | 20 分钟三件套、铁锭 ≥6、死亡 ≤1 | M3+M4 | 4-5 | 洞穴怪、铁矿稀少 |
| M6 | 钻石与钻石镐（S4） | 深层矿道 y=-54~-59、岩浆规避、钻石识别、钻石镐 | `gather` 深层、`movement` 避险、S4 模板 | 铁镐起手 25 分钟 ≥3 钻石并成镐，5 次 ≥4，岩浆死 0 | M5 | 5-7 | 岩浆、深层怪、钻石稀少 |
| M7 | 下界、烈焰棒与末影珍珠（S5） | 黑曜石与打火石、下界门、维度切换、堡垒探索、烈焰人、末影人 | `nether.js`、`combat.js`、坐标换算、下界 checkpoint | 7 烈焰棒 ≤40 分钟、16 珍珠 ≤90 分钟、死亡 ≤2 且能回主世界 | M6、M4 | 7-9 | 岩浆海、恶魂、堡垒距离、末影人 |
| M8 | 要塞、末地与末影龙（S6） | 末影之眼、三角定位、末地门、水晶、龙战、返回 | `end.js`、`combat.js` 弓盾、S6 模板 | 从主世界 checkpoint 60 分钟击杀末影龙 | M6+M7 | 7-9 | 定位偏差、末地坠落、龙战 |

合计 40-53 人日；M3 与 M4 可并行，压缩约 4 人日。每个阶段的退出条件只依赖本阶段产物，验收失败只回退该阶段。

## 3. 每阶段验收脚本

夹具命令由测试员在 Paper 控制台执行，只用于造场景；沃心自己不能使用命令，G1 不使用补给类夹具。

| 阶段 | 世界/夹具 | 沃心任务 | 通过标准 | 次数（通过线） |
| --- | --- | --- | --- | --- |
| M0 | 复制 world 模板启动，`/seed` 记录；旁观 30 分钟 | 只采集状态 | 出生点/群系/树数 3 次一致；JSONL ≥340 行 | 3（3） |
| M1 | S0 片段；`/kill Voxkin`、结束 bridge、重启 Core | 收集木头 | 自动恢复，重复动作 ≤1，任务不丢 | 3（3） |
| M2 | 新世界，控制台 `/clear Voxkin`，白天 | 做出木镐 | ≤10 分钟，木镐+工作台，无人工给料 | 10（≥8） |
| M3 | M2 产物，`/time set night` | 石镐、石剑、熔炉 | ≤15 分钟，3 夜不死 | 3（3） |
| M4 | S2 起点，连续 3 夜，`/kill Voxkin` 1 次 | 食物与床 | food ≥8，睡眠 3/3，死后 5 分钟恢复 | 3（3） |
| M5 | S3 起点，`/execute at Voxkin run summon minecraft:zombie ~ ~ ~` 2 只 | 铁装 | ≤20 分钟，铁锭 ≥6，死亡 ≤1 | 3（3） |
| M6 | 铁镐起手，`/time set day` | 钻石 | ≤25 分钟 ≥3 钻石+钻石镐 | 5（≥4） |
| M7 | 钻石镐+食物+铁装 checkpoint | 下界 | 7 烈焰棒 ≤40 分钟，16 珍珠 ≤90 分钟 | 5（≥3） |
| M8 | 7 棒+16 珍珠+弓+方块 checkpoint | 末地 | ≤60 分钟龙死 | 3（≥2） |

## 4. 最终全流程验收（G1）

### 4.1 环境与记录

| 项 | 要求 |
| --- | --- |
| seed | M0 选定并写入 `runs/README.md`；G1 前 3 次干跑用同一 seed |
| 版本 | Paper 1.21.1、`difficulty=normal`、`gamemode=survival`、`online-mode=false` |
| 世界 | 从 world 模板重置；不预置村庄或结构，不用 `/locate` |
| 背包 | 空；控制台 `/clear Voxkin` 只在开跑前执行一次 |
| 观察 | spectator 或录屏，不发言、不给物品、不报坐标 |
| 时长 | 软目标 8 小时，硬超时 12 小时 |
| 记录 | `runs/<run_id>/`：state.jsonl、actions.jsonl、stages.json、deaths.json、视频 |
| 胜利 | 末影龙死亡且 bot 回到主世界（`dimension=overworld`） |
| 失败 | 超时、同一 step 连续 3 次卡 30 分钟、死亡 >20、任何人工介入 |

### 4.2 检查点与失败续跑

checkpoint 在每次阶段切换和每 10 分钟写入（TaskStore + `runs/<run_id>/checkpoint.json`），内容为阶段、step、背包基线、锚点坐标、重试计数；检查点只保存计划与基线，不回滚世界。

| 故障 | 续跑动作 | 上限 |
| --- | --- | --- |
| bridge 断线 / Core 重启 | 读 checkpoint 续跑当前 step，重放前先读背包确认 | 3 次/阶段 |
| 死亡 | 5 秒内重生；掉落物 5 分钟内回收，超时放弃；回锚点或重生点 | 3 次/阶段 |
| 钻石镐/珍珠/烈焰棒丢失 | 回退到产出阶段（S4/S5）重做，禁止读档 | 2 次/run |
| 寻路卡住或目标方块不存在 | 20 秒位移 <2 格判定卡住；换目标、挖开、绕行 | 5 次/step |
| 床或传送门被破坏 | 就地重建；材料不足则回退到采集 | 2 次/阶段 |
| 模型超时或限流 | 规则 Planner 接管当前 step；10 分钟无进展则暂停并记录 | 无上限 |

续跑接口（M1 交付）：`POST /api/run/resume {"run_id":"g1-01","from":"checkpoint"}`；`GET /api/run/status` 返回阶段、step、重试、死亡、LLM 调用。

### 4.3 判定与统计

- 零干预：除启动/停止服务外无人输入，`human_interventions=0`。
- 通过：龙死、回到主世界、总时长 ≤12 小时、死亡 ≤20、无人工介入。
- 统计：阶段用时、死亡位置、重试原因、工具失败分布、LLM 调用数。
- 失败样本保留：`runs/<run_id>/` 不删除，作为下一轮回归输入。

## 5. TODO 拆解（按依赖排序）

| 阶段 | # | TODO | 文件/模块 | 完成判定 |
| --- | --- | --- | --- | --- |
| M0 | 1 | 固定 seed、版本与 world 模板，记录 checksum | `work/mc/world_template/`、`runs/README.md` | 两次重置出生点一致 |
| M0 | 2 | 重置脚本：停服、覆盖 world、启动、等端口 | `scripts/mc_reset.ps1` | 一条命令 90 秒内可玩 |
| M0 | 3 | 状态与动作 JSONL（5s 采样 + 每动作一行） | `src/voxkin/agent/runlog.py`（新）、`bridge/minecraft_bridge.js` | 每次 run 数据完整 |
| M0 | 4 | 背包到阶段的只读判定报告 | `agent/progress.py`、`tests/test_progress.py` | 输出阶段与缺料清单 |
| M0 | 5 | 30 分钟纯观测基线 | `runs/`、`docs/plans/EVALUATION.md` | 完整率 ≥99%，无人工输入 |
| M1 | 1 | TaskRunner 循环与 step 终态 | `agent/runner.py`（新） | 单测覆盖 done/failed/retry/cancelled |
| M1 | 2 | Verifier：背包、坐标、维度、方块四类规则 | `progress.py`、`runner.py` | 每步可机器判定 |
| M1 | 3 | TaskStore 扩展 checkpoint、resume、事件查询 | `agent/tasks.py` | 重启后可续跑 |
| M1 | 4 | 死亡重生、卡住检测、bridge 重连 | `runner.py`、`minecraft_bridge.js` | `/kill` 后 5 分钟恢复 |
| M1 | 5 | 独立模式：关闭向玩家要坐标与自动跟随 | `minecraft_bridge.js`、`runner.py` | 无玩家在线时不发求助 |
| M1 | 6 | `/api/run/` 的 start、status、stop、resume 四个路由 | `src/voxkin/server.py` | curl 全流程可用 |
| M2 | 1 | manifest + registry，现有动作原样挂表 | `bridge/skills/manifest.js`、`index.js` | 旧工具行为不变 |
| M2 | 2 | craft 配方解析与材料检查 | `craft.js` | 木板/木棍/工作台/木镐可合成 |
| M2 | 3 | 工作台自动放置、使用、回收 | `craft.js` | 合成后工作台回背包 |
| M2 | 4 | tools.py 增加 craft | `agent/tools.py` | schema 校验通过 |
| M2 | 5 | S0 模板与无树重规划 | `runner.py`、`progress.py` | 空背包 10 分钟木镐 |
| M2 | 6 | S0 回归 10 次 | `scripts/run_stage.py` | ≥8/10，P50 ≤6 分钟 |
| M3 | 1 | collect 工具切换与真实拾取 | `gather.js` | 挖 10 石得 10 圆石 |
| M3 | 2 | 石制工具与熔炉配方 | `craft.js` | 三件各 1 |
| M3 | 3 | 熔炉放置、燃料、取出 | `craft.js` | 烧 3 生铁成功 |
| M3 | 4 | 过夜策略与低血停战 | `survival.js`、`combat.js` | 3 夜不死 |
| M3 | 5 | 火把制作与矿道照明 | `craft.js`、`build.js` | 8 格内有火把 |
| M4 | 1 | eat 工具与食物优先级 | `survival.js`、`tools.py` | food 14→18 |
| M4 | 2 | 狩猎与熟肉熔炼 | `combat.js`、`craft.js` | 3 块熟肉 |
| M4 | 3 | 羊毛、床或封闭庇护所 | `survival.js`、`craft.js` | 夜晚可睡 |
| M4 | 4 | sleep 与床被破坏重建 | `survival.js` | 3/3 夜跳过 |
| M4 | 5 | 死亡恢复：重生、掉落回收/放弃、回锚点 | `runner.py`、`survival.js` | 死后 5 分钟继续 |
| M4 | 6 | 3 日生存回归 | `scripts/run_stage.py` | food ≥8，死亡 ≤1 |
| M5 | 1 | strip_mine 主巷道与分支 | `gather.js` | 20 分钟 32 格 |
| M5 | 2 | 铁矿识别与洞穴敌对处理 | `gather.js`、`combat.js` | 铁矿石 ≥8 |
| M5 | 3 | 熔炼铁锭与燃料核算 | `craft.js` | 铁锭 ≥6 |
| M5 | 4 | 铁镐/铁剑/盾与装备 | `craft.js`、`survival.js` | 三件套齐 |
| M5 | 5 | 箱子暂存检查点物资 | `storage.js` | 存取各 16 圆石 |
| M5 | 6 | S3 回归 3 次 | `scripts/run_stage.py` | ≤20 分钟，死亡 ≤1 |
| M6 | 1 | 深层矿道 y=-54~-59 与岩浆规避 | `gather.js`、`movement.js` | 30 分钟无岩浆伤 |
| M6 | 2 | 钻石矿识别（含 deepslate 变体） | `gather.js` | 3 钻石 |
| M6 | 3 | 钻石镐与备用钻石 | `craft.js` | 镐成，余 ≥3 |
| M6 | 4 | 附魔台（P1，不阻塞） | `craft.js` | 可选 |
| M6 | 5 | S4 回归 5 次 | `scripts/run_stage.py` | ≥4/5，P50 ≤20 分钟 |
| M7 | 1 | 黑曜石获取与打火石 | `nether.js`、`gather.js` | 10 黑曜石 |
| M7 | 2 | 下界门建造、点火、双向通行 | `nether.js` | 往返 3 次 |
| M7 | 3 | 维度坐标换算与下界 checkpoint | `nether.js`、`runner.py` | 回主世界偏差 ≤16 |
| M7 | 4 | 堡垒探索与烈焰人战斗 | `nether.js`、`combat.js` | 7 烈焰棒 |
| M7 | 5 | 末影人猎取与珍珠（交易备选） | `combat.js`、`trade.js` | 16 珍珠 |
| M7 | 6 | S5 回归 5 次 | `scripts/run_stage.py` | ≥3/5，死亡 ≤2 |
| M8 | 1 | 末影之眼合成与投掷定位 | `end.js`、`craft.js` | 3 次投掷收敛 |
| M8 | 2 | 要塞探索与末地门激活 | `end.js` | 12 框架填满 |
| M8 | 3 | 水晶处理（弓或搭塔） | `combat.js`、`build.js` | 水晶全清 |
| M8 | 4 | 龙战与坠落伤害处理 | `end.js`、`combat.js` | 龙死，bot 存活 |
| M8 | 5 | 返回主世界与胜利判定 | `end.js`、`runner.py` | `dimension=overworld` |
| M8 | 6 | S6 回归 3 次 | `scripts/run_stage.py` | ≥2/3，≤60 分钟 |

## 6. 技能缺口清单

| 优先级 | 缺口 | 现状 | 目标模块 | 阻塞 |
| --- | --- | --- | --- | --- |
| P0 | craft | 无 | `bridge/skills/craft.js` | M2 |
| P0 | smelt | 无 | `craft.js` | M3/M5 |
| P0 | 采集工具切换与掉落拾取 | 只走近，不拾取 | `gather.js` | M3 |
| P0 | equip_tool / equip_armor | 插件自动，工具不完整 | `survival.js` | M3 |
| P0 | eat | 仅反射 | `survival.js` | M4 |
| P0 | sleep | 无 | `survival.js` | M4 |
| P0 | 死亡重生与恢复 | 只监听 death | `session.js`（新）、`runner.py` | M1/M4 |
| P0 | strip_mine / dig_down | 无 | `gather.js` | M5 |
| P0 | nether_portal | 无 | `nether.js`（新） | M7 |
| P0 | 烈焰人/末影人战斗 | 通用近战 | `combat.js` | M7 |
| P0 | 末影之眼与要塞 | 无 | `end.js`（新） | M8 |
| P0 | 末影龙与弓 | 无 | `end.js`、`combat.js` | M8 |
| P1 | 箱子存取 | 无 | `storage.js` | M5 |
| P1 | 盾格挡 | 无 | `combat.js` | M8 |
| P1 | 探索与路径点 | 无 | `tasks.js` | M7 |
| P1 | 村民交易 | 无 | `trade.js` | M7 |
| P1 | 水桶与坠落保护 | 无 | `survival.js` | M6/M8 |
| P2 | 附魔/铁砧/药水/钓鱼/船/矿车 | 无 | `craft.js`、`survival.js`、`movement.js` | 不阻塞通关 |

## 7. 评估节奏与回滚

| 节奏 | 内容 | 通过线 | 不通过动作 |
| --- | --- | --- | --- |
| 每次提交 | 90 tests + manifest schema 校验 + JSONL 回放 | 全绿 | 阻止合并 |
| 每阶段退出 | 第 3 节脚本重复 N 次 | 达到通过线 | 不进入下一阶段 |
| 每周 | 固定 seed 用 checkpoint 串联 S0 到当前阶段 | 串联成功率 ≥80% | 排查断点，暂停新阶段 |
| 每个里程碑（M5、M8 后） | 从空背包起跑的全流程演练 | 到达当前最高阶段 | 记录根因并重排 |
| G1 前 | 3 次干跑 | 至少 1 次零干预到末地 | 推迟 G1 |

- 同一阶段连续 2 次失败且根因在最近改动，回滚该改动，保留其他阶段。
- 新增技能让既有阶段成功率下降 ≥10%，回滚并先补回归。
- 阶段成功率低于阈值（M2-M5 80%，M6-M8 60%），停止后续阶段，先修当前阶段。
- LLM 成本或延迟超过预算 2 倍，改用规则 Planner，LLM 只做失败重规划。
- 连续 3 次 G1 在同一阶段超时，拆分该阶段并重估人日。

## 8. 不做什么

- 不用创造模式、作弊命令、人工补给、改游戏规则完成正式验收。
- 不让玩家报坐标、给物品、救场、暂停；观察者保持 spectator 且不发言。
- 不用外部地图或种子工具为正式运行指路；离线 seed 分析只用于设计测试，须标注。
- 不用世界回滚撤销死亡或物品损失；检查点只保存计划与物品基线。
- 不做在线自训练、模型互训、自动改代码。
- 不以速通为目标，不追求一次不死，要求死后能继续。
