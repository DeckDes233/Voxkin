const state = {
  socket: null,
  status: null,
  turns: [],
};

const $ = (id) => document.getElementById(id);

function renderPills(status) {
  const llmOk = status.llm.api_key_configured;
  const cache = status.voice_cache || {};
  const cacheLabel = cache.enabled === false
    ? "未启用"
    : cache.count
      ? `${cache.voice_id} ${cache.count} 条 · 命中 ${cache.hits} 未命中 ${cache.misses}`
      : "未构建";
  const pills = [
    ["LLM", llmOk ? status.llm.model : "未配置密钥", llmOk ? "ok" : "warn"],
    ["TTS", status.tts.loaded ? `已加载 ${status.tts.character}` : "未加载", status.tts.loaded ? "ok" : "warn"],
    ["STT", status.stt.loaded ? status.stt.model : `${status.stt.model} 待加载`, status.stt.loaded ? "ok" : "warn"],
    ["语音缓存", cacheLabel, cache.count ? "ok" : "warn"],
    ["音频", status.audio.output, "ok"],
    ["状态", status.speaking ? "正在说话" : "空闲", status.speaking ? "warn" : "ok"],
  ];
  const box = $("pills");
  box.replaceChildren();
  pills.forEach(([label, text, kind]) => {
    const item = document.createElement("span");
    item.className = `pill ${kind || ""}`;
    item.textContent = `${label}：${text}`;
    box.appendChild(item);
  });
  $("uptime").textContent = `${status.persona} · 运行 ${status.uptime_s}s · ${status.audio.output}`;
}

async function loadStatus() {
  const response = await fetch("/api/status");
  const status = await response.json();
  state.status = status;
  renderPills(status);
  fillConfigForm(status);
}

let configFilled = false;
function fillConfigForm(status) {
  if (configFilled) return;
  configFilled = true;
  $("cfgBaseUrl").value = status.llm.base_url;
  $("cfgModel").value = status.llm.model;
  $("cfgCharacter").value = status.tts.character;
  $("cfgReference").value = status.tts.reference_audio;
  $("cfgOutput").value = status.audio.output;
  $("cfgMinecraftDir").value = status.audio.directory && status.audio.output === "minecraft_file" ? status.audio.directory : "";
}

function stamp() {
  const now = new Date();
  return now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
}

function pushEvent(kind, text, cls) {
  const box = $("events");
  const row = document.createElement("div");
  row.className = "event " + (cls || "");
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = stamp();
  const label = document.createElement("span");
  label.className = "k";
  label.textContent = kind;
  const message = document.createElement("span");
  message.textContent = text;
  row.append(time, label, message);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
}

const streamRows = new Map();

function streamDelta(requestId, text) {
  if (!text) return;
  const box = $("events");
  let row = streamRows.get(requestId);
  if (!row) {
    row = document.createElement("div");
    row.className = "event";
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = stamp();
    const label = document.createElement("span");
    label.className = "k";
    label.textContent = "模型";
    const content = document.createElement("span");
    row.append(time, label, content);
    box.appendChild(row);
    streamRows.set(requestId, row);
  }
  row.lastElementChild.textContent += text.replace(/\n/g, " ");
  box.scrollTop = box.scrollHeight;
}

function fmt(value) {
  return value === null || value === undefined ? "-" : value;
}

function renderTurns() {
  const body = $("latencyTable").querySelector("tbody");
  body.replaceChildren();
  state.turns.slice(0, 12).forEach((turn, index) => {
    const row = document.createElement("tr");
    const values = [
      index + 1,
      turn.stt_ms ? fmt(turn.stt_ms) : "-",
      fmt(turn.llm_ttft_ms),
      fmt(turn.first_sentence_ms),
      fmt(turn.tts_first_audio_ms),
      fmt(turn.first_audible_ms),
    ];
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
}

async function loadMetrics() {
  const response = await fetch("/api/metrics?limit=20");
  const data = await response.json();
  state.turns = data.recent;
  renderTurns();
  $("aggregate").textContent = JSON.stringify(data.aggregate, null, 2);
}

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  state.socket = socket;
  socket.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    handleEvent(payload);
  };
  socket.onclose = () => {
    pushEvent("断线", "WebSocket 连接关闭，3 秒后重试", "error");
    setTimeout(connect, 3000);
  };
}

function handleEvent(payload) {
  switch (payload.type) {
    case "turn_started":
      pushEvent("开始", payload.text);
      break;
    case "llm_delta":
      streamDelta(payload.request_id, payload.text);
      break;
    case "sentence_ready":
      pushEvent("分句", payload.text, "sentence");
      break;
    case "fast_path_started":
      pushEvent("快路", `${payload.tool}（置信度 ${payload.confidence}）`, "sentence");
      break;
    case "action_deduped":
      pushEvent("去重", `${payload.tool} 与快路重复，已跳过`, "sentence");
      break;
    case "tts_failed":
      pushEvent("语音失败", payload.error || payload.text || "合成失败", "error");
      break;
    case "turn_finished": {
      const s = payload.summary;
      streamRows.delete(s.request_id);
      const stt = s.stt_ms ? `识别 ${s.stt_ms}ms · ` : "";
      pushEvent(
        "完成",
        `${stt}首字 ${fmt(s.llm_ttft_ms)}ms · 首次可听 ${fmt(s.first_audible_ms)}ms`,
        "sentence"
      );
      loadMetrics();
      break;
    }
    case "turn_interrupted":
    case "turn_cancelled":
      streamRows.delete(payload.request_id);
      pushEvent("打断", payload.reason || payload.request_id, "error");
      break;
    case "turn_failed":
      streamRows.delete(payload.request_id);
      pushEvent("失败", payload.error, "error");
      break;
    case "action_started":
      pushEvent("行动", `${payload.tool} ${JSON.stringify(payload.arguments || {})}`);
      break;
    case "action_finished":
      pushEvent("行动完成", payload.tool);
      break;
    case "player_death":
      pushEvent("死亡恢复", `角色死亡，已暂停当前步骤${payload.interrupted_actions?.length ? `，中断动作 ${payload.interrupted_actions.join("、")}` : ""}`, "error");
      loadRunStatus();
      break;
    case "player_respawn":
      pushEvent("死亡恢复", "角色已重生，正在核对检查点");
      loadRunStatus();
      break;
    case "announce":
      pushEvent("沃心", payload.text, "sentence");
      break;
    case "mic_transcript":
      pushEvent("你说", `${payload.text}（${payload.stt_ms} ms）`, "sentence");
      $("micLog").textContent += `\n你说：${payload.text}`;
      break;
    case "mic_reply": {
      const spoken = payload.summary.meta.spoken;
      $("micLog").textContent += `\n沃心：${spoken}`;
      pushEvent("回复", `首次可听 ${payload.summary.first_audible_ms} ms`, "sentence");
      break;
    }
    case "bridge_state":
      break;
    case "mic_error":
      pushEvent("麦克风", payload.error, "error");
      break;
    default:
      pushEvent(payload.type || "事件", JSON.stringify(payload));
  }
}

async function say() {
  const text = $("sayText").value.trim();
  if (!text) return;
  $("sayText").value = "";
  await fetch("/api/say", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function interrupt() {
  await fetch("/api/interrupt", { method: "POST" });
}

async function synth() {
  const text = $("ttsText").value.trim();
  if (!text) return;
  $("ttsTiming").textContent = "合成中…";
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    $("ttsTiming").textContent = `合成失败：${response.status}`;
    return;
  }
  const firstAudio = response.headers.get("X-First-Audio-Ms");
  const total = response.headers.get("X-Total-Ms");
  $("ttsTiming").textContent = `首段音频 ${firstAudio}ms · 合成总耗时 ${total}ms`;
  const blob = await response.blob();
  $("player").src = URL.createObjectURL(blob);
  $("player").play();
}

async function saveConfig() {
  const payload = {
    llm: { base_url: $("cfgBaseUrl").value, model: $("cfgModel").value },
    tts: { character: $("cfgCharacter").value, reference_audio: $("cfgReference").value },
    audio: {
      output: $("cfgOutput").value,
      minecraft_audio_dir: $("cfgMinecraftDir").value,
    },
  };
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  $("configNote").textContent = data.saved
    ? `已保存 ${data.changed.length} 项，重启服务后生效`
    : "保存失败";
  loadStatus();
}

async function loadMic() {
  const response = await fetch("/api/mic");
  const data = await response.json();
  const labels = { stopped: "未启动", starting: "启动中", running: "正在聆听", ready: "正在聆听" };
  const state = labels[data.state] || data.state;
  $("micState").textContent = `${state}${data.last_stt_ms ? " · 上次识别 " + data.last_stt_ms + " ms" : ""}`;
}

const RUN_STATUS_LABELS = {
  active: "正在执行",
  waiting: "等待游戏状态更新",
  recovering: "正在核对上次进展",
  unknown: "正在确认动作结果",
  preempted: "安全操作打断，等待重新评估",
  blocked: "暂时受阻",
  dead: "角色死亡，等待重生",
  paused_by_user: "已由你停止",
  done: "目标已完成",
  cancelled: "已取消",
  disconnected: "连接中断",
  failed: "执行失败",
};

const STAGE_LABELS = {
  S0: "S0 · 木镐",
  S1: "S1 · 石器与熔炉",
  S2: "S2 · 食物与床",
  S3: "S3 · 铁器",
  S4: "S4 · 钻石镐",
  S5: "S5 · 下界材料",
  S6: "S6 · 末影龙",
};

const RECOVERY_REASON_LABELS = {
  core_restart: "服务重启后正在核对上次动作",
  explicit_resume: "续跑请求已提交，正在核对上次动作",
  bridge_unavailable: "等待 Minecraft 连接恢复",
  await_cancelled: "上次动作被中断，正在核对结果",
  death: "等待重生后的游戏状态",
  preempted: "安全操作完成后正在重新评估",
  cancelled: "上次动作已取消，需要手动续跑",
  verified_action_receipt: "已确认上次动作结果",
};

const BLOCK_REASON_LABELS = {
  budget_actions: "目标动作次数已达到上限",
  budget_elapsed: "目标执行时间已达到上限",
  budget_method_attempts: "一种执行方式已达到尝试上限",
  method_exhausted: "当前执行方式已用完，目标条件仍未满足",
  preemption_budget: "安全中断次数已达到上限",
  disconnected: "Minecraft 连接中断",
  "等待 ready 新鲜观察超时": "等待最新游戏状态",
  "等待下一次夜晚或新鲜状态变化": "等待夜晚或游戏状态变化",
  "等待重生后新的 ready 观察": "等待角色重生后确认状态",
  "动作结果待对账": "正在核对上次动作结果",
};

const ACTION_LABELS = {
  activate_end_portal: "开启末地传送门",
  collect_blaze_rods: "收集烈焰棒",
  collect_blocks: "采集方块",
  collect_flint: "获取燧石",
  collect_obsidian: "采集黑曜石",
  craft_bed: "制作床",
  craft: "制作物品",
  deep_mine: "深入挖掘",
  eat_if_hungry: "补充食物",
  fight_dragon: "挑战末影龙",
  hunt_animal: "获取食物",
  hunt_enderman: "寻找末影珍珠",
  hunt_material: "收集材料",
  inventory: "整理物品",
  leave_shelter: "离开庇护所",
  make_nether_portal: "建造下界传送门",
  make_shelter: "建造庇护所",
  mine_collect: "挖掘与采集",
  nether_travel: "探索下界",
  prepare_bow_arrows: "准备弓箭",
  raid_fortress: "探索下界要塞",
  return_home: "返回安全地点",
  shear_sheep: "获取羊毛",
  sleep_safe: "在安全处休息到天亮",
  smelt_batch: "熔炼材料",
  strip_mine: "挖掘矿物",
  throw_eye: "寻找要塞方向",
};

function safeReason(value, labels, fallback) {
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (labels[raw]) return labels[raw];
  if (/action_id|pending_action|schema_version|protocol/i.test(raw)) return fallback;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;
  const code = raw.split(":", 1)[0];
  return labels[code] || fallback;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 3600) return `${Math.round(value / 3600)} 小时`;
  if (value >= 60) return `${Math.round(value / 60)} 分钟`;
  return `${Math.round(value)} 秒`;
}

function formatGoalStatus(data) {
  const goal = data.goal && typeof data.goal === "object" ? data.goal : null;
  const result = data.result || null;
  const status = goal?.status || data.goal_status || result?.status || "";
  const hasGoal = Boolean(goal && (goal.title || goal.goal_id) || data.current_goal);

  if (!hasGoal) {
    const stage = STAGE_LABELS[data.stage] || data.stage || "-";
    const lines = [
      `状态：${data.running ? "运行中" : RUN_STATUS_LABELS[status] || status || "空闲"}`,
      `阶段：${stage}`,
      ...(data.stage_complete === null || data.stage_complete === undefined
        ? []
        : [`阶段目标：${data.stage_complete ? "已完成" : "进行中"}`]),
      `步骤游标：${data.cursor ?? 0}`,
    ];
    if (result) lines.push(`结果：${result.detail || (result.ok ? "成功" : "未完成")}`);
    return lines.join("\n");
  }

  const title = goal?.title || STAGE_LABELS[data.stage] || "当前目标";
  const statusLabel = RUN_STATUS_LABELS[status] || (data.running ? "正在执行" : "等待处理");
  const pending = data.in_flight_action || data.pending_action || goal?.pending_action;
  const actionLabel = pending
    ? ACTION_LABELS[pending.tool] || "执行游戏动作"
    : status === "active"
      ? "正在观察状态并选择下一步"
      : "暂无在途动作";
  const pendingNote = pending?.status === "unknown"
    ? "（正在确认结果）"
    : pending?.status === "preempted"
      ? "（被安全操作打断）"
      : "";
  const budget = data.budget || goal?.budget || {};
  const counters = data.counters || goal?.counters || {};
  const actionBudget = data.action_budget || {};
  const used = actionBudget.used ?? counters.actions ?? 0;
  const limit = actionBudget.limit ?? budget.max_actions;
  const budgetParts = [];
  if (limit !== null && limit !== undefined && Number(limit) > 0) {
    budgetParts.push(`${used} / ${limit} 次动作`);
  }
  if (Number(budget.max_attempts_per_method) > 0) {
    budgetParts.push(`单种方式最多尝试 ${budget.max_attempts_per_method} 次`);
  }
  const elapsedLimit = formatDuration(budget.max_elapsed_s);
  if (elapsedLimit !== "-") budgetParts.push(`最长 ${elapsedLimit}`);

  const lines = [
    `目标：${title}`,
    `状态：${statusLabel}`,
    `当前动作：${actionLabel}${pendingNote}`,
    `动作预算：${budgetParts.length ? budgetParts.join(" · ") : "未提供"}`,
  ];

  const waitingReason = safeReason(
    data.waiting_reason || (status === "waiting" ? data.blocked_reason || goal?.block_reason : ""),
    BLOCK_REASON_LABELS,
    "正在等待游戏状态更新",
  );
  if (waitingReason) lines.push(`等待原因：${waitingReason}`);

  const blockedReasonValue = status === "paused_by_user"
    ? data.blocked_reason || goal?.block_reason || result?.detail || goal?.detail
    : result?.detail || goal?.detail || data.blocked_reason || goal?.block_reason;
  const blockedReason = safeReason(
    blockedReasonValue,
    BLOCK_REASON_LABELS,
    "当前条件未满足",
  );
  if (["blocked", "unknown", "preempted", "dead", "paused_by_user", "cancelled", "disconnected", "failed"].includes(status) && blockedReason) {
    lines.push(`说明：${blockedReason}`);
  }

  const recovery = goal?.recovery || {};
  const shouldShowRecovery = status === "recovering" || recovery.needs_reconcile === true;
  if (shouldShowRecovery) {
    const recoveryReason = safeReason(
      data.recovery_reason || recovery.reason,
      RECOVERY_REASON_LABELS,
      "正在核对上次进展",
    );
    if (recoveryReason) lines.push(`恢复进度：${recoveryReason}`);
  }

  if (status === "done" && (result?.detail || goal?.detail)) {
    lines.push(`结果：${safeReason(result?.detail || goal?.detail, BLOCK_REASON_LABELS, "目标已完成")}`);
  }
  return lines.join("\n");
}

function updateRunControls(data) {
  const goal = data.goal && typeof data.goal === "object" ? data.goal : null;
  const status = goal?.status || data.goal_status || data.result?.status || "";
  const hasGoal = Boolean(goal && (goal.title || goal.goal_id) || data.current_goal);
  const hasTask = (data.task_id !== null && data.task_id !== undefined) || hasGoal || Boolean(data.stage || data.result);
  const completed = status === "done" || data.result?.status === "done";
  $("runStart").disabled = Boolean(data.running);
  $("runResume").disabled = Boolean(data.running) || !hasTask || completed;
  $("runStop").disabled = !data.running;
}

async function loadRunStatus() {
  const response = await fetch("/api/run/status");
  const data = await response.json();
  $("runStatus").textContent = formatGoalStatus(data);
  updateRunControls(data);
}

async function runAction(action, body = {}) {
  const response = await fetch(`/api/run/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    pushEvent("自主任务", `${action} 失败：${await response.text()}`, "error");
  } else {
    const data = await response.json();
    pushEvent("自主任务", `${action} 已提交（${data.stage || "最近任务"}）`);
  }
  await loadRunStatus();
}

async function micAction(action) {
  const response = await fetch(`/api/mic/${action}`, { method: "POST" });
  if (!response.ok) {
    pushEvent("麦克风", `${action} 失败：HTTP ${response.status}`, "error");
  }
  loadMic();
}

async function loadServices() {
  const response = await fetch("/api/services");
  const data = await response.json();
  const box = $("services");
  const names = Object.keys(data);
  if (names.length === 0) {
    box.innerHTML = '<span class="legend">未配置受管服务，可在 config 中开启 tts.manage_service</span>';
    return;
  }
  box.replaceChildren();
  names.forEach((name) => {
    const service = data[name];
    const serviceState = service.running ? `运行中 pid ${service.pid}` : "已停止";
    const reachable = service.health && service.health.reachable;
    const health = reachable === true ? "健康" : reachable === false ? "不可达" : "未检查";
    const row = document.createElement("div");
    row.className = "service";
    const title = document.createElement("strong");
    title.textContent = name;
    const summary = document.createElement("span");
    summary.textContent = `${serviceState} · ${health}`;
    row.append(title, summary);
    ["start", "stop", "restart"].forEach((action) => {
      const button = document.createElement("button");
      button.textContent = { start: "启动", stop: "停止", restart: "重启" }[action];
      button.addEventListener("click", () => serviceAction(name, action));
      row.appendChild(button);
    });
    box.appendChild(row);
  });
}

async function serviceAction(name, action) {
  const response = await fetch(`/api/services/${name}/${action}`, { method: "POST" });
  if (!response.ok) {
    pushEvent("服务", `${name} ${action} 失败：HTTP ${response.status}`, "error");
  } else {
    pushEvent("服务", `${name} 已执行 ${action}`);
  }
  loadServices();
}

async function testLlm() {
  $("llmNote").textContent = "请求中…";
  const response = await fetch("/api/llm/test", { method: "POST" });
  if (!response.ok) {
    $("llmNote").textContent = `测试失败：HTTP ${response.status} ${await response.text()}`;
    return;
  }
  const data = await response.json();
  $("llmNote").textContent = `首 token ${data.ttft_ms} ms · 总耗时 ${data.total_ms} ms · 回复：${data.text.slice(0, 60)}`;
}

async function loadLogs() {
  const response = await fetch("/api/logs?lines=60");
  const data = await response.json();
  $("logs").textContent = data.lines.join("\n");
}

$("sayBtn").addEventListener("click", say);
$("sayText").addEventListener("keydown", (event) => {
  if (event.key === "Enter") say();
});
$("interruptBtn").addEventListener("click", interrupt);
$("ttsBtn").addEventListener("click", synth);
$("saveConfig").addEventListener("click", saveConfig);
$("testLlm").addEventListener("click", testLlm);
$("micStart").addEventListener("click", () => micAction("start"));
$("micStop").addEventListener("click", () => micAction("stop"));
$("runStart").addEventListener("click", () =>
  runAction("start", { stage: $("runStage").value }),
);
$("runResume").addEventListener("click", () => runAction("resume"));
$("runStop").addEventListener("click", () => runAction("stop"));

connect();
loadStatus();
loadMetrics();
loadLogs();
loadServices();
loadMic();
loadRunStatus();
setInterval(loadStatus, 3000);
setInterval(loadServices, 4000);
setInterval(loadMic, 2500);
setInterval(loadRunStatus, 1500);
setInterval(loadLogs, 5000);
