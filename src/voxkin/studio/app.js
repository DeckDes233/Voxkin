const state = {
  socket: null,
  status: null,
  turns: [],
};

const $ = (id) => document.getElementById(id);

function pill(label, text, kind) {
  return `<span class="pill ${kind || ""}">${label}：${text}</span>`;
}

function renderPills(status) {
  const llmOk = status.llm.api_key_configured;
  const cache = status.voice_cache || {};
  const cacheLabel = cache.enabled === false
    ? "未启用"
    : cache.count
      ? `${cache.voice_id} ${cache.count} 条 · 命中 ${cache.hits} 未命中 ${cache.misses}`
      : "未构建";
  const pills = [
    pill("LLM", llmOk ? status.llm.model : "未配置密钥", llmOk ? "ok" : "warn"),
    pill("TTS", status.tts.loaded ? `已加载 ${status.tts.character}` : "未加载", status.tts.loaded ? "ok" : "warn"),
    pill("STT", status.stt.loaded ? status.stt.model : `${status.stt.model} 待加载`, status.stt.loaded ? "ok" : "warn"),
    pill("语音缓存", cacheLabel, cache.count ? "ok" : "warn"),
    pill("音频", status.audio.output, "ok"),
    pill("状态", status.speaking ? "正在说话" : "空闲", status.speaking ? "warn" : "ok"),
  ];
  $("pills").innerHTML = pills.join("");
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
  row.innerHTML = `<span class="t">${stamp()}</span><span class="k">${kind}</span><span>${text}</span>`;
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
    row.innerHTML = `<span class="t">${stamp()}</span><span class="k">模型</span><span></span>`;
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
  body.innerHTML = state.turns
    .slice(0, 12)
    .map(
      (turn, index) => `<tr>
        <td>${index + 1}</td>
        <td>${turn.stt_ms ? fmt(turn.stt_ms) : "-"}</td>
        <td>${fmt(turn.llm_ttft_ms)}</td>
        <td>${fmt(turn.first_sentence_ms)}</td>
        <td>${fmt(turn.tts_first_audio_ms)}</td>
        <td>${fmt(turn.first_audible_ms)}</td>
      </tr>`
    )
    .join("");
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
  box.innerHTML = names
    .map((name) => {
      const service = data[name];
      const state = service.running ? `运行中 pid ${service.pid}` : "已停止";
      const reachable = service.health && service.health.reachable;
      const health = reachable === true ? "健康" : reachable === false ? "不可达" : "未检查";
      return `<div class="service" data-name="${name}">
        <strong>${name}</strong>
        <span>${state} · ${health}</span>
        <button data-action="start">启动</button>
        <button data-action="stop">停止</button>
        <button data-action="restart">重启</button>
      </div>`;
    })
    .join("");
  box.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.closest(".service").dataset.name;
      serviceAction(name, button.dataset.action);
    });
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

connect();
loadStatus();
loadMetrics();
loadLogs();
loadServices();
loadMic();
setInterval(loadStatus, 3000);
setInterval(loadServices, 4000);
setInterval(loadMic, 2500);
setInterval(loadLogs, 5000);
