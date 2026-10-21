# 通关演练记录

每次阶段验收或全流程演练写一个目录，不覆盖旧记录。

```text
runs/
  g1-20261022-01/
    state.jsonl      每 5 秒一条世界状态
    actions.jsonl    每个动作一行：tool、参数、结果、耗时
    stages.json      阶段开始/结束、耗时、重试、死亡
    checkpoint.json  当前阶段、步骤、背包基线、锚点
    report.json      最终判定与统计
```

## 规则

- `g1` 记录只用于正式零干预验收，不注入人为故障。
- 故障注入另开目录，文件名带 `fault-` 前缀；失败样本保留，作为回归输入。
- 预置箱子只允许出现在 `scenario` 世界，`g1` 世界不允许出现评测箱。
- 报告写明 LLM 是本地测试服务还是真实 API，以及 TTS/STT 的真实引擎。
- 任何人工输入都记为一次 intervention；正式验收要求 0 次。

## 阶段命令草案

```powershell
# 重置到固定 seed 的测试世界
powershell -File scripts\mc_reset.ps1 -TemplateDir work\mc\world_template -ServerDir work\mc\eval_server

# 启动 Studio 与桥接（独立模式）
$env:VOXKIN_INDEPENDENT = "1"
node bridge\minecraft_bridge.js

# 触发 S0
Invoke-RestMethod -Uri http://127.0.0.1:8765/api/run/start -Method Post -Body '{"stage":"S0"}' -ContentType application/json
Invoke-RestMethod -Uri http://127.0.0.1:8765/api/run/status
```

正式 `g1` 前先用同一 seed 干跑三次，确认出生点、树木分布和结构位置一致。
