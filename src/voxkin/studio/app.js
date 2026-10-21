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
  const pills = [
    pill("LLM", llmOk ? status.llm.model : "未配置密钥", llmOk ? "ok" : "warn"),
    pill("TTS", status.tts.loaded ? `已加载 ${status.tts.character}` : "未加载", status.tts.loaded ? "ok" : "warn"),
    pill("STT", status.stt.loaded ? status.stt.model : `${status.stt.model} 待加载`, status.stt.loaded ? "ok" : "warn"),
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
        <td>${fmt(turn.stt_ms)}</td>
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
      pushEvent("模型", payload.text.replace(/\n/g, " "));
      break;
    case "sentence_ready":
      pushEvent("分句", payload.text, "sentence");
      break;
    case "turn_finished": {
      const s = payload.summary;
      pushEvent(
        "完成",
        `识别 ${fmt(s.stt_ms)}ms · 首字 ${fmt(s.llm_ttft_ms)}ms · 首次可听 ${fmt(s.first_audible_ms)}ms`,
        "sentence"
      );
      loadMetrics();
      break;
    }
    case "turn_interrupted":
    case "turn_cancelled":
      pushEvent("打断", payload.reason || payload.request_id, "error");
      break;
    case "turn_failed":
      pushEvent("失败", payload.error, "error");
      break;
    case "action_started":
      pushEvent("行动", `${payload.tool} ${JSON.stringify(payload.arguments || {})}`);
      break;
    case "action_finished":
      pushEvent("行动完成", payload.tool);
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

connect();
loadStatus();
loadMetrics();
loadLogs();
setInterval(loadStatus, 3000);
setInterval(loadLogs, 5000);
