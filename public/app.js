const API_BASE = "/api";
const STORAGE_KEY = "holdem_token";
const CLIENT_KEY = "holdem_client_id";
const BGM_ENABLED_KEY = "holdem_bgm_enabled";
const AUDIO_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const AUDIO_UPLOAD_CHUNK_BYTES = 768 * 1024;
const TAUNT_MESSAGES = [
  "跟得起吗？",
  "这把我收了",
  "别演了，摊牌吧",
  "谢谢老板",
  "牌桌上见真章",
  "稳一点，别上头",
  "人有多大胆，地有多大产",
  "老公你说句话呀！"
];
const CHAT_MAX_LENGTH = 40;
const AUDIO_ACTIONS = [
  { key: "start", label: "开局/发牌" },
  { key: "deal", label: "公共牌" },
  { key: "blind", label: "盲注" },
  { key: "fold", label: "弃牌" },
  { key: "check", label: "看牌" },
  { key: "call", label: "跟注" },
  { key: "bet", label: "下注" },
  { key: "raise", label: "加注" },
  { key: "allin", label: "全下" },
  { key: "timeout", label: "超时弃牌" },
  { key: "showdown", label: "结算" }
];
const SLOT_SYMBOLS = {
  cherry: { label: "樱桃", icon: "/assets/slots/cherry-full.png", className: "cherry", triple: "5x", pair: "1x" },
  lemon: { label: "柠檬", icon: "/assets/slots/lemon.png", className: "lemon", triple: "5x", pair: "1x" },
  clover: { label: "四叶草", icon: "/assets/slots/clover.png", className: "clover", triple: "7x", pair: "2x" },
  bell: { label: "金铃", icon: "/assets/slots/bell.png", className: "bell", triple: "9x", pair: "2x" },
  horseshoe: { label: "马蹄铁", icon: "/assets/slots/horseshoe.png", className: "horseshoe", triple: "10x", pair: "2x" },
  bar: { label: "金条", icon: "/assets/slots/goldbar.png", className: "bar", triple: "14x", pair: "3x" },
  coin: { label: "金币", icon: "/assets/slots/coin.png", className: "coin", triple: "16x", pair: "3x" },
  crown: { label: "皇冠", icon: "/assets/slots/crown.png", className: "crown", triple: "22x", pair: "5x" },
  seven: { label: "幸运 7", icon: "/assets/slots/seven.png", className: "seven", triple: "30x", pair: "4x" },
  diamond: { label: "钻石", icon: "/assets/slots/diamond.png", className: "diamond", triple: "60x", pair: "6x" }
};
const SLOT_SPECIAL_COMBOS = [
  { ids: ["crown", "seven", "diamond"], label: "皇家幸运组合", multiplier: "12x" },
  { ids: ["bar", "coin", "horseshoe"], label: "黄金连线组合", multiplier: "6x" },
  { ids: ["cherry", "lemon", "clover"], label: "水果幸运组合", multiplier: "3x" }
];
const SLOT_DEFAULT_REELS = ["seven", "diamond", "crown"];
const SLOT_BET_PRESETS = [50, 100, 500, 1000];
const SLOT_REVEAL_DELAY_MS = 3600;
const SLOT_REEL_STEPS = [42, 50, 58];
const SLOT_REEL_STRIPS = [
  ["diamond", "seven", "bar", "cherry", "bell", "lemon", "coin", "crown", "clover", "horseshoe", "seven", "bar", "diamond", "coin", "cherry", "bell", "crown", "lemon", "horseshoe", "clover"],
  ["seven", "bell", "cherry", "bar", "diamond", "lemon", "crown", "coin", "horseshoe", "clover", "bar", "seven", "bell", "diamond", "coin", "cherry", "crown", "lemon", "clover", "horseshoe"],
  ["bar", "diamond", "lemon", "seven", "cherry", "bell", "horseshoe", "coin", "crown", "clover", "diamond", "bar", "lemon", "seven", "coin", "bell", "crown", "cherry", "horseshoe", "clover"]
];
const BLACKJACK_BET_PRESETS = [50, 100, 500, 1000];
const BLACKJACK_SEAT_OPTIONS = [3, 5, 7];

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  clientId: getClientId(),
  commandSeq: 0,
  user: null,
  tables: [],
  table: null,
  onlineUsers: [],
  slot: { history: [], result: null, reels: SLOT_DEFAULT_REELS, spinning: false, bet: 100 },
  blackjack: { tables: [], table: null, history: [], bet: 100, buyIn: 2000, maxSeats: 5 },
  view: "auth",
  authMode: "login",
  message: "",
  busy: false,
  poller: null,
  polling: false,
  presenceTimer: null,
  presencePolling: false,
  tableRequestSeq: 0,
  renderedTableId: null,
  animationTable: null,
  scrollLock: null,
  raiseDrawerOpen: false,
  rulesOpen: false,
  chatOpen: false,
  serverClockOffset: 0,
  pingMs: null,
  countdownTimer: null,
  timeoutPollDeadline: "",
  bgmEnabled: localStorage.getItem(BGM_ENABLED_KEY) !== "0",
  audioLastSeqByTable: {},
  admin: { users: [], tables: [], quickMessages: [], audioSettings: defaultAudioSettings(), audit: [] },
  pointerActive: false,
  deferRealtimeRenderUntil: 0,
  realtimeRenderTimer: null,
  realtimeRenderPending: false
};

const $app = document.querySelector("#app");
let bgmAudio = null;
let bgmAudioSrc = "";

function defaultAudioSettings() {
  return {
    bgm: { src: "", name: "", volume: 0.36, enabled: false },
    actions: {},
    quickMessages: {}
  };
}

function getClientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

function nextCommandId(scope) {
  state.commandSeq += 1;
  return `${state.clientId}:${scope}:${Date.now()}:${state.commandSeq}`;
}

function money(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  const sign = number < 0 ? "-" : "";
  const absolute = Math.abs(number);
  const units = [
    { value: 1_000_000_000, label: "B" },
    { value: 1_000_000, label: "M" },
    { value: 1_000, label: "K" }
  ];
  const unit = units.find((item) => absolute >= item.value);
  if (!unit) return `${sign}${absolute.toLocaleString("zh-CN")}`;
  const scaled = absolute / unit.value;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const text = scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  return `${sign}${text}${unit.label}`;
}

function stageLabel(status) {
  return {
    waiting: "等待入局",
    preflop: "翻前",
    flop: "翻牌",
    turn: "转牌",
    river: "河牌",
    showdown: "结算"
  }[status] || status;
}

function suitMeta(card) {
  if (!card) return { rank: "", suit: "", color: "black" };
  const rankMap = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };
  const suitMap = {
    S: ["♠", "black"],
    H: ["♥", "red"],
    D: ["♦", "red"],
    C: ["♣", "black"]
  };
  const [suit, color] = suitMap[card[1]] || ["", "black"];
  return { rawRank: card[0], rank: rankMap[card[0]] || card[0], suit, color };
}

function cardHtml(card, small = false) {
  if (!card) {
    return `
      <div class="card card-back ${small ? "small" : ""}" aria-label="暗牌">
        <span class="back-frame"></span>
        <span class="back-mark">TH</span>
      </div>
    `;
  }
  const meta = suitMeta(card);
  const isFace = ["J", "Q", "K"].includes(meta.rawRank);
  const pips = isFace ? faceCardHtml(meta) : pipCardHtml(meta);
  return `
    <div class="card card-face ${meta.color} rank-${meta.rawRank.toLowerCase()} ${isFace ? "face" : ""} ${small ? "small" : ""}">
      <span class="card-index top"><b>${meta.rank}</b><i>${meta.suit}</i></span>
      ${pips}
      <span class="small-center"><b>${meta.rank}</b><i>${meta.suit}</i></span>
      <span class="card-index bottom"><b>${meta.rank}</b><i>${meta.suit}</i></span>
    </div>
  `;
}

function communityCardHtml(card) {
  if (card) return cardHtml(card);
  return `
    <div class="card card-placeholder" aria-hidden="true">
      <span></span>
    </div>
  `;
}

function pipCardHtml(meta) {
  const layouts = {
    A: [[3, 2, "hero"]],
    "2": [[1, 2], [5, 2, "invert"]],
    "3": [[1, 2], [3, 2], [5, 2, "invert"]],
    "4": [[1, 1], [1, 3], [5, 1, "invert"], [5, 3, "invert"]],
    "5": [[1, 1], [1, 3], [3, 2], [5, 1, "invert"], [5, 3, "invert"]],
    "6": [[1, 1], [1, 3], [3, 1], [3, 3], [5, 1, "invert"], [5, 3, "invert"]],
    "7": [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3], [5, 1, "invert"], [5, 3, "invert"]],
    "8": [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3], [4, 2, "invert"], [5, 1, "invert"], [5, 3, "invert"]],
    "9": [[1, 1], [1, 3], [2, 1], [2, 3], [3, 2], [4, 1, "invert"], [4, 3, "invert"], [5, 1, "invert"], [5, 3, "invert"]],
    T: [[1, 1], [1, 3], [2, 1], [2, 3], [2, 2], [4, 1, "invert"], [4, 3, "invert"], [4, 2, "invert"], [5, 1, "invert"], [5, 3, "invert"]]
  };
  const pips = layouts[meta.rawRank] || [];
  return `
    <span class="card-paper"></span>
    <div class="pip-grid">
      ${pips.map(([row, column, mode]) => `<span class="pip ${mode || ""}" style="grid-row:${row};grid-column:${column}">${meta.suit}</span>`).join("")}
    </div>
  `;
}

function faceCardHtml(meta) {
  const titles = { J: "JACK", Q: "QUEEN", K: "KING" };
  return `
    <span class="card-paper"></span>
    <div class="face-art">
      <span class="face-title">${titles[meta.rawRank]}</span>
      <span class="face-crown">${meta.suit}</span>
      <span class="face-body"><b>${meta.rawRank}</b><i>${meta.suit}</i></span>
      <span class="face-suit">${meta.suit}</span>
    </div>
  `;
}

function chipStackHtml(amount, compact = false) {
  const chips = chipBreakdown(amount, compact ? 4 : 5).reverse().map((denom, index) => {
    return `<span class="chip chip-${denom}" style="--i:${index}"><i>${chipLabel(denom)}</i></span>`;
  }).join("");
  return `<div class="chip-stack ${compact ? "compact" : ""}"><span class="chip-pile" aria-hidden="true">${chips}</span><b>${money(amount)}</b></div>`;
}

function chipBreakdown(amount, maxChips) {
  let remaining = Math.max(0, Math.floor(Number(amount) || 0));
  const denoms = [5000, 1000, 500, 100, 25, 10, 5, 1];
  const chips = [];
  for (const denom of denoms) {
    while (remaining >= denom && chips.length < maxChips) {
      chips.push(denom);
      remaining -= denom;
    }
  }
  if (!chips.length) chips.push(1);
  return chips;
}

function chipLabel(denom) {
  return denom >= 1000 ? `${denom / 1000}K` : String(denom);
}

function setMessage(text) {
  state.message = text || "";
  render();
  if (text) {
    window.clearTimeout(setMessage.timer);
    setMessage.timer = window.setTimeout(() => {
      state.message = "";
      render();
    }, 2800);
  }
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", "x-client-id": state.clientId, ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const trackPing = shouldTrackPing(path);
  const startedAt = trackPing ? performance.now() : 0;
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    cache: "no-store",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (trackPing) recordPing(performance.now() - startedAt);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function shouldTrackPing(path) {
  return !String(path || "").startsWith("/admin/audio-upload");
}

function recordPing(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const sample = Math.max(1, Math.min(9999, Math.round(durationMs)));
  state.pingMs = state.pingMs == null
    ? sample
    : Math.round(state.pingMs * 0.65 + sample * 0.35);
  syncPingBadge();
}

function pingQuality(ms = state.pingMs) {
  if (ms == null) return "unknown";
  if (ms <= 120) return "good";
  if (ms <= 260) return "ok";
  return "slow";
}

function pingText() {
  return state.pingMs == null ? "--ms" : `${state.pingMs}ms`;
}

async function runBusy(task) {
  if (state.busy) return;
  state.busy = true;
  state.tableRequestSeq += 1;
  lockTableScroll();
  syncBusyIndicator();
  let errorMessage = "";
  try {
    await task();
  } catch (error) {
    applyServerPayload(error.payload);
    errorMessage = error.message || "请求失败";
  } finally {
    state.busy = false;
    syncBusyIndicator();
    if (errorMessage) {
      setMessage(errorMessage);
    } else {
      render();
    }
  }
}

function applyServerPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  let changed = false;
  if (payload.serverTime) syncServerClock(payload.serverTime);
  if (Array.isArray(payload.onlineUsers)) {
    state.onlineUsers = payload.onlineUsers;
    changed = true;
  }
  if (payload.user) {
    state.user = payload.user;
    changed = true;
  }
  if (payload.table) {
    syncServerClock(payload.table.serverTime);
    if (payload.table.type === "blackjack") {
      state.blackjack = { ...state.blackjack, table: payload.table };
      if (state.view !== "blackjack") state.view = "blackjack";
    } else {
      state.table = payload.table;
      if (state.view !== "table") state.view = "table";
    }
    changed = true;
  }
  return changed;
}

function requestRealtimeRender() {
  state.realtimeRenderPending = true;
  if (state.busy || shouldDeferRealtimeRender()) {
    queueRealtimeRender();
    return;
  }
  state.realtimeRenderPending = false;
  render();
}

function queueRealtimeRender(delay = 120) {
  if (!state.realtimeRenderPending) return;
  if (state.realtimeRenderTimer) return;
  state.realtimeRenderTimer = window.setTimeout(() => {
    state.realtimeRenderTimer = null;
    if (!state.realtimeRenderPending) return;
    if (state.busy || shouldDeferRealtimeRender()) {
      queueRealtimeRender(160);
      return;
    }
    state.realtimeRenderPending = false;
    render();
  }, delay);
}

function shouldDeferRealtimeRender() {
  return state.pointerActive || Date.now() < state.deferRealtimeRenderUntil || isEditingFormControl();
}

function isEditingFormControl() {
  const active = document.activeElement;
  if (!active) return false;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return true;
  if (active instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "submit"].includes(active.type);
  }
  return Boolean(active.isContentEditable);
}

function markPointerActive() {
  state.pointerActive = true;
  state.deferRealtimeRenderUntil = Date.now() + 500;
}

function releasePointerActive() {
  state.pointerActive = false;
  state.deferRealtimeRenderUntil = Date.now() + 180;
  if (state.realtimeRenderPending) queueRealtimeRender(190);
}

function syncServerClock(serverTime) {
  const stamp = new Date(serverTime || "").getTime();
  if (Number.isFinite(stamp)) state.serverClockOffset = stamp - Date.now();
}

function lockTableScroll() {
  if (state.view === "table" && state.table) {
    if (state.scrollLock && state.scrollLock.tableId === state.table.id) return;
    state.scrollLock = {
      tableId: state.table.id,
      x: window.scrollX,
      y: window.scrollY
    };
  }
}

function syncBusyIndicator() {
  const existing = document.querySelector("[data-loading-indicator]");
  if (!document.body) return;
  if (state.busy && !existing) {
    const loading = document.createElement("div");
    loading.className = "loading";
    loading.dataset.loadingIndicator = "true";
    loading.innerHTML = "<span></span>";
    document.body.appendChild(loading);
  } else if (!state.busy && existing) {
    existing.remove();
  }
}

function persistSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(STORAGE_KEY, token);
}

function logout() {
  state.token = "";
  state.user = null;
  state.tables = [];
  state.table = null;
  state.onlineUsers = [];
  state.slot = { history: [], result: null, reels: SLOT_DEFAULT_REELS, spinning: false, bet: 100 };
  state.blackjack = { tables: [], table: null, history: [], bet: 100, buyIn: 2000, maxSeats: 5 };
  state.view = "auth";
  localStorage.removeItem(STORAGE_KEY);
  stopPolling();
  stopPresenceHeartbeat();
  render();
}

async function bootstrap() {
  if (!state.token) {
    render();
    return;
  }
  try {
    const { user } = await api("/me");
    state.user = user;
    state.view = "games";
    render();
  } catch {
    logout();
  }
}

async function submitAuth(formElement) {
  const form = new FormData(formElement);
  const username = form.get("username");
  const password = form.get("password");
  const endpoint = state.authMode === "register" ? "/register" : "/login";
  await runBusy(async () => {
    const result = await api(endpoint, { method: "POST", body: { username, password } });
    persistSession(result.token, result.user);
    state.view = "games";
    state.table = null;
    state.blackjack.table = null;
    await refreshPresence();
  });
}

async function loadLobby(silent = false) {
  try {
    const result = await api("/lobby");
    state.user = result.user;
    state.tables = result.tables;
    state.onlineUsers = result.onlineUsers || state.onlineUsers || [];
    if (!state.table) state.view = "lobby";
    if (!silent) render();
  } catch (error) {
    if (!silent) setMessage(error.message);
  }
}

async function openPokerLobby() {
  state.table = null;
  state.rulesOpen = false;
  state.chatOpen = false;
  state.blackjack.table = null;
  stopPolling();
  await loadLobby();
  startPolling(700);
}

async function openSlots() {
  await runBusy(async () => {
    const result = await api("/slots");
    state.user = result.user || state.user;
    state.slot = {
      ...state.slot,
      history: result.history || [],
      result: state.slot.result,
      reels: state.slot.reels || SLOT_DEFAULT_REELS,
      spinning: false,
      settling: false
    };
    state.table = null;
    state.view = "slots";
    stopPolling();
  });
}

async function spinSlots(formElement) {
  if (state.slot.spinning) return;
  const form = new FormData(formElement);
  const bet = Math.max(10, Number(form.get("bet") || state.slot.bet || 100));
  state.slot = {
    ...state.slot,
    bet,
    result: null,
    spinning: true,
    settling: false,
    reels: state.slot.reels?.length ? state.slot.reels : SLOT_DEFAULT_REELS
  };
  render();
  await runBusy(async () => {
    const result = await api("/slots/spin", {
      method: "POST",
      body: { bet, commandId: nextCommandId("slot") }
    });
    const finalReels = Array.isArray(result.result?.symbols) && result.result.symbols.length
      ? result.result.symbols
      : state.slot.reels || SLOT_DEFAULT_REELS;
    state.slot = {
      ...state.slot,
      result: null,
      reels: finalReels,
      spinning: true,
      settling: true
    };
    state.view = "slots";
    render();
    await sleep(SLOT_REVEAL_DELAY_MS);
    state.user = result.user || state.user;
    state.slot = {
      ...state.slot,
      history: result.history || [],
      result: result.result || null,
      reels: finalReels,
      spinning: false,
      settling: false
    };
    state.view = "slots";
  });
  if (state.slot.spinning || state.slot.settling) {
    state.slot = { ...state.slot, spinning: false, settling: false };
    render();
  }
}

async function openBlackjack() {
  await runBusy(async () => {
    const result = await api("/blackjack");
    applyBlackjackLobbyPayload(result);
    state.table = null;
    state.view = "blackjack";
    startPolling(result.table ? 120 : 700);
  });
}

function applyBlackjackLobbyPayload(result) {
  state.user = result.user || state.user;
  syncServerClock(result.table?.serverTime || result.serverTime);
  state.onlineUsers = result.onlineUsers || state.onlineUsers || [];
  state.blackjack = {
    ...state.blackjack,
    tables: result.tables || state.blackjack.tables || [],
    table: result.table || null,
    history: result.history || state.blackjack.history || [],
    bet: state.blackjack.bet || result.table?.defaultBet || 100,
    buyIn: state.blackjack.buyIn || 2000,
    maxSeats: state.blackjack.maxSeats || 5
  };
}

function applyBlackjackTablePayload(result) {
  state.user = result.user || state.user;
  syncServerClock(result.table?.serverTime || result.serverTime);
  state.blackjack = {
    ...state.blackjack,
    table: result.table || null,
    tables: result.tables || state.blackjack.tables || [],
    history: result.history || state.blackjack.history || []
  };
  state.view = "blackjack";
}

async function createBlackjackTable(formElement) {
  const form = new FormData(formElement);
  const bet = Math.max(10, Number(form.get("bet") || state.blackjack.bet || 100));
  const buyIn = Math.max(bet, Number(form.get("buyIn") || state.blackjack.buyIn || bet * 20));
  const maxSeats = Number(form.get("maxSeats") || state.blackjack.maxSeats || 5);
  state.blackjack = { ...state.blackjack, bet, buyIn, maxSeats };
  await runBusy(async () => {
    const result = await api("/blackjack/tables", {
      method: "POST",
      body: {
        name: form.get("name"),
        bet,
        buyIn,
        maxSeats,
        commandId: nextCommandId("blackjack-create")
      }
    });
    applyBlackjackTablePayload(result);
    startPolling(120);
  });
}

async function openBlackjackTable(tableId) {
  await runBusy(async () => {
    const result = await api(`/blackjack/tables/${tableId}`);
    applyBlackjackTablePayload(result);
    startPolling(120);
  });
}

async function joinBlackjackTable(tableId, seat = null) {
  const buyInInput = document.querySelector("[data-blackjack-buyin]");
  const buyIn = Number(buyInInput?.value || state.blackjack.buyIn || 2000);
  state.blackjack = { ...state.blackjack, buyIn };
  await runBusy(async () => {
    const result = await api(`/blackjack/tables/${tableId}/join`, {
      method: "POST",
      body: { buyIn, seat, commandId: nextCommandId("blackjack-join"), tableRevision: state.blackjack.table?.revision || 0 }
    });
    applyBlackjackTablePayload(result);
    startPolling(120);
  });
}

async function leaveBlackjackTable() {
  const table = state.blackjack.table;
  if (!table) return;
  const activeHand = table.controls?.activeHand;
  const message = activeHand ? "本轮进行中离桌会放弃当前下注，确定离开吗？" : "确定离开当前 21 点桌吗？";
  if (!window.confirm(message)) return;
  await runBusy(async () => {
    const result = await api(`/blackjack/tables/${table.id}/leave`, {
      method: "POST",
      body: { commandId: nextCommandId("blackjack-leave"), tableRevision: table.revision || 0 }
    });
    applyBlackjackTablePayload(result);
    state.blackjack.table = null;
    await loadBlackjackLobby(true);
    startPolling(700);
  });
}

async function disbandBlackjackTable() {
  const table = state.blackjack.table;
  if (!table) return;
  if (!window.confirm("确定解散这张 21 点桌吗？桌上玩家的剩余筹码会退回钱包。")) return;
  await runBusy(async () => {
    const result = await api(`/blackjack/tables/${table.id}/disband`, {
      method: "POST",
      body: { commandId: nextCommandId("blackjack-disband"), tableRevision: table.revision || 0 }
    });
    applyBlackjackTablePayload(result);
    state.blackjack.table = null;
    startPolling(700);
  });
}

async function loadBlackjackLobby(silent = false) {
  try {
    const result = await api("/blackjack");
    applyBlackjackLobbyPayload({ ...result, table: null });
    state.view = "blackjack";
    if (!silent) render();
  } catch (error) {
    if (!silent) setMessage(error.message);
  }
}

async function startBlackjackRound(formElement = null) {
  const table = state.blackjack.table;
  if (!table) return;
  const form = formElement ? new FormData(formElement) : null;
  const bet = Math.max(10, Number(form?.get("bet") || state.blackjack.bet || table.defaultBet || 100));
  state.blackjack = { ...state.blackjack, bet };
  await runBusy(async () => {
    const result = await api(`/blackjack/tables/${table.id}/start`, {
      method: "POST",
      body: { bet, commandId: nextCommandId("blackjack-start"), tableRevision: table.revision || 0 }
    });
    applyBlackjackTablePayload(result);
    nudgePolling();
  });
}

async function blackjackAction(action) {
  const table = state.blackjack.table;
  if (!table) return;
  await runBusy(async () => {
    const result = await api(`/blackjack/tables/${table.id}/action`, {
      method: "POST",
      body: {
        action,
        commandId: nextCommandId(`blackjack-${action}`),
        tableRevision: table.revision || 0
      }
    });
    applyBlackjackTablePayload(result);
    nudgePolling();
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function createTable(formElement) {
  const form = new FormData(formElement);
  const buyInInput = document.querySelector("[data-buyin]");
  await runBusy(async () => {
    const result = await api("/tables", {
      method: "POST",
      body: {
        name: form.get("name"),
        smallBlind: Number(form.get("smallBlind")),
        bigBlind: Number(form.get("bigBlind")),
        maxSeats: Number(form.get("maxSeats")),
        buyIn: Number(buyInInput?.value || 1000),
        commandId: nextCommandId("create")
      }
    });
    state.user = result.user || state.user;
    syncServerClock(result.table?.serverTime);
    state.table = result.table;
    state.view = "table";
    startPolling();
  });
}

async function joinTable(tableId, seat = null) {
  const buyInInput = document.querySelector("[data-buyin]");
  const buyIn = Number(buyInInput?.value || 1000);
  await runBusy(async () => {
    const result = await api(`/tables/${tableId}/join`, {
      method: "POST",
      body: { buyIn, seat, commandId: nextCommandId("join"), tableRevision: state.table?.revision || 0 }
    });
    state.user = result.user;
    syncServerClock(result.table?.serverTime);
    state.table = result.table;
    state.view = "table";
    startPolling();
  });
}

async function openTable(tableId) {
  await runBusy(async () => {
    const result = await api(`/tables/${tableId}`);
    state.user = result.user;
    syncServerClock(result.table?.serverTime);
    state.table = result.table;
    state.view = "table";
    startPolling();
  });
}

async function leaveTable() {
  if (!state.table) return;
  const activeHand = state.table.controls?.activeHand;
  const message = activeHand ? "牌局中离桌会自动弃牌，确定离开吗？" : "确定离开当前牌桌吗？";
  if (!window.confirm(message)) return;
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/leave`, {
      method: "POST",
      body: { commandId: nextCommandId("leave"), tableRevision: state.table.revision || 0 }
    });
    state.user = result.user;
    state.table = null;
    state.view = "lobby";
    state.rulesOpen = false;
    await loadLobby(true);
    stopPolling();
  });
}

async function disbandTable() {
  if (!state.table) return;
  if (!window.confirm("确定解散这张牌桌吗？桌上玩家的剩余筹码会退回钱包。")) return;
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/disband`, {
      method: "POST",
      body: { commandId: nextCommandId("disband"), tableRevision: state.table.revision || 0 }
    });
    state.user = result.user || state.user;
    state.table = null;
    state.tables = result.tables || [];
    state.view = "lobby";
    state.rulesOpen = false;
    stopPolling();
    await loadLobby(true);
  });
}

async function startHand() {
  if (!state.table) return;
  hideShowdownOverlay();
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/start`, {
      method: "POST",
      body: { commandId: nextCommandId("start"), tableRevision: state.table.revision || 0 }
    });
    syncServerClock(result.table?.serverTime);
    state.table = result.table;
    nudgePolling();
  });
}

async function playerAction(action, amount = null) {
  if (!state.table) return;
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/action`, {
      method: "POST",
      body: {
        action,
        amount,
        commandId: nextCommandId("action"),
        tableRevision: state.table.revision || 0
      }
    });
    syncServerClock(result.table?.serverTime);
    state.table = result.table;
    nudgePolling();
  });
}

async function sendChatMessage(message, options = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!state.table || !text) return;
  if ([...text].length > CHAT_MAX_LENGTH) {
    setMessage(`消息不能超过 ${CHAT_MAX_LENGTH} 个字`);
    return;
  }
  try {
    const result = await api(`/tables/${state.table.id}/taunt`, {
      method: "POST",
      body: {
        message: text,
        commandId: nextCommandId("taunt"),
        tableRevision: state.table.revision || 0
      }
    });
    syncServerClock(result.table?.serverTime);
    state.table = result.table;
    if (options.closePresets) state.chatOpen = false;
    nudgePolling();
    render();
    requestAnimationFrame(() => scrollChatScreen());
    return true;
  } catch (error) {
    applyServerPayload(error.payload);
    setMessage(error.message || "消息发送失败");
    return false;
  }
}

async function submitChatMessage(formElement) {
  const input = formElement.querySelector("[data-chat-input]");
  const message = input?.value || "";
  const sent = await sendChatMessage(message);
  if (sent && input) input.value = "";
}

async function refreshTable(silent = true) {
  if (!state.table) return false;
  if (state.busy) return false;
  const requestSeq = ++state.tableRequestSeq;
  const tableId = state.table.id;
  const since = Number(state.table.revision || 0);
  try {
    const result = await api(`/tables/${tableId}?since=${encodeURIComponent(since)}`);
    if (requestSeq !== state.tableRequestSeq || !state.table || state.table.id !== tableId) return false;
    syncServerClock(result.table?.serverTime || result.serverTime);
    if (result.unchanged || !result.table) {
      if (result.user) state.user = result.user;
      return false;
    }
    const changed = Number(result.table.revision || 0) !== Number(state.table.revision || 0)
      || Number(result.user?.revision || 0) !== Number(state.user?.revision || 0);
    if (result.user) state.user = result.user;
    if (result.table) state.table = result.table;
    if (changed && !silent) render();
    return changed;
  } catch (error) {
    const applied = applyServerPayload(error.payload);
    if (applied && !silent) render();
    if (!silent) setMessage(error.message);
    return applied;
  }
}

async function refreshBlackjackTable(silent = true) {
  const table = state.blackjack.table;
  if (!table) return false;
  if (state.busy) return false;
  const requestSeq = ++state.tableRequestSeq;
  const tableId = table.id;
  const since = Number(table.revision || 0);
  try {
    const result = await api(`/blackjack/tables/${tableId}?since=${encodeURIComponent(since)}`);
    if (requestSeq !== state.tableRequestSeq || !state.blackjack.table || state.blackjack.table.id !== tableId) return false;
    syncServerClock(result.table?.serverTime || result.serverTime);
    if (result.unchanged || !result.table) {
      if (result.user) state.user = result.user;
      return false;
    }
    const changed = Number(result.table.revision || 0) !== Number(state.blackjack.table.revision || 0)
      || Number(result.user?.revision || 0) !== Number(state.user?.revision || 0);
    if (result.user) state.user = result.user;
    if (result.table) state.blackjack = { ...state.blackjack, table: result.table };
    if (changed && !silent) render();
    return changed;
  } catch (error) {
    const applied = applyServerPayload(error.payload);
    if (applied && !silent) render();
    if (!silent) setMessage(error.message);
    return applied;
  }
}

function startPolling(delay = 120) {
  if (!state.token || !["table", "lobby", "blackjack"].includes(state.view)) {
    stopPolling();
    return;
  }
  stopPollTimer();
  schedulePoll(delay);
}

function schedulePoll(delay = pollDelay()) {
  stopPollTimer();
  state.poller = window.setTimeout(runPoll, delay);
}

async function runPoll() {
  if (state.polling) {
    schedulePoll();
    return;
  }
  state.polling = true;
  try {
    if (!state.busy && state.view === "table" && state.table) {
      const changed = await refreshTable();
      if (changed) render();
    } else if (!state.busy && state.view === "blackjack" && state.blackjack.table) {
      const changed = await refreshBlackjackTable();
      if (changed) render();
    } else if (!state.busy && state.view === "blackjack") {
      await loadBlackjackLobby(true);
      render();
    } else if (!state.busy && state.view === "lobby") {
      await loadLobby(true);
      render();
    }
  } finally {
    state.polling = false;
    if (state.poller !== null) schedulePoll();
  }
}

function pollDelay() {
  if (state.view === "table" && state.table) {
    if (state.table.controls?.canAct) return 300;
    if (["preflop", "flop", "turn", "river"].includes(state.table.status)) return 350;
    return 900;
  }
  if (state.view === "blackjack" && state.blackjack.table) {
    if (state.blackjack.table.controls?.canAct) return 300;
    if (state.blackjack.table.status === "playing") return 350;
    return 950;
  }
  if (state.view === "blackjack") return 1800;
  if (state.view === "lobby") return 1800;
  return 3500;
}

function stopPolling() {
  stopPollTimer();
  state.polling = false;
}

function stopPollTimer() {
  if (state.poller) window.clearTimeout(state.poller);
  state.poller = null;
}

function syncPollingSubscription() {
  if (!state.token || !["lobby", "table", "blackjack"].includes(state.view)) {
    stopPolling();
    return;
  }
  const fast = state.view === "table" || (state.view === "blackjack" && state.blackjack.table);
  if (!state.poller && !state.polling) startPolling(fast ? 120 : 700);
}

function nudgePolling(delay = 80) {
  if (state.token && ["lobby", "table", "blackjack"].includes(state.view)) startPolling(delay);
}

function startPresenceHeartbeat() {
  if (!state.token || !state.user || state.presenceTimer) return;
  state.presenceTimer = window.setInterval(refreshPresence, 25000);
  refreshPresence();
}

function stopPresenceHeartbeat() {
  if (state.presenceTimer) window.clearInterval(state.presenceTimer);
  state.presenceTimer = null;
  state.presencePolling = false;
}

function syncPresenceSubscription() {
  if (!state.token || !state.user) {
    stopPresenceHeartbeat();
    return;
  }
  startPresenceHeartbeat();
}

async function refreshPresence() {
  if (!state.token || !state.user || state.presencePolling) return false;
  state.presencePolling = true;
  try {
    const result = await api("/presence");
    const nextOnline = result.onlineUsers || [];
    const changed = onlineUsersKey(nextOnline) !== onlineUsersKey(state.onlineUsers || []);
    state.user = result.user || state.user;
    state.onlineUsers = nextOnline;
    syncServerClock(result.serverTime);
    if (changed) syncOnlinePanel();
    return changed;
  } catch {
    return false;
  } finally {
    state.presencePolling = false;
  }
}

function onlineUsersKey(users) {
  return (users || []).map((user) => `${user.id}:${user.lastSeenAt}:${user.location?.type}:${user.location?.tableId || ""}`).join("|");
}

async function loadAdmin() {
  await runBusy(async () => {
    const result = await api("/admin/users");
    applyAdminPayload(result);
    state.view = "admin";
  });
}

function applyAdminPayload(payload) {
  state.admin = {
    users: payload?.users || [],
    tables: payload?.tables || [],
    quickMessages: payload?.quickMessages || TAUNT_MESSAGES,
    audioSettings: normalizeClientAudioSettings(payload?.audioSettings),
    audit: payload?.audit || []
  };
}

function normalizeClientAudioSettings(settings = {}) {
  const defaults = defaultAudioSettings();
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    bgm: { ...defaults.bgm, ...(source.bgm || {}) },
    actions: source.actions && typeof source.actions === "object" ? source.actions : {},
    quickMessages: source.quickMessages && typeof source.quickMessages === "object" ? source.quickMessages : {}
  };
}

async function recharge(formElement) {
  const form = new FormData(formElement);
  await runBusy(async () => {
    const result = await api("/admin/recharge", {
      method: "POST",
      body: {
        userId: form.get("userId"),
        amount: Number(form.get("amount")),
        note: form.get("note")
      }
    });
    applyAdminPayload(await api("/admin/users"));
    if (state.user && result.user.id === state.user.id) state.user = result.user;
    setMessage(`${result.user.username} 当前钱包 ${money(result.user.chips)}`);
  });
}

async function setBalance(formElement) {
  const form = new FormData(formElement);
  await runBusy(async () => {
    const result = await api("/admin/users/balance", {
      method: "POST",
      body: {
        userId: form.get("userId"),
        balance: Number(form.get("balance"))
      }
    });
    applyAdminPayload(result);
    const updated = state.admin.users.find((user) => user.id === form.get("userId"));
    if (state.user && updated?.id === state.user.id) state.user = { ...state.user, chips: updated.chips, revision: updated.revision };
    setMessage(`${updated?.username || "账号"} 余额已设置为 ${money(updated?.chips || 0)}`);
  });
}

async function setAdminPassword(formElement) {
  const form = new FormData(formElement);
  await runBusy(async () => {
    const result = await api("/admin/users/password", {
      method: "POST",
      body: {
        userId: form.get("userId"),
        password: form.get("password")
      }
    });
    applyAdminPayload(result);
    const updated = state.admin.users.find((user) => user.id === form.get("userId"));
    setMessage(`${updated?.username || "账号"} 密码已更新`);
  });
}

async function deleteAdminUser(userId) {
  const user = state.admin.users.find((item) => item.id === userId);
  if (!user || !window.confirm(`确定删除账号「${user.username}」吗？该玩家会被移出所有牌桌。`)) return;
  await runBusy(async () => {
    const result = await api("/admin/users/delete", {
      method: "POST",
      body: { userId }
    });
    applyAdminPayload(result);
    setMessage(`${user.username} 已删除`);
  });
}

async function addBot(formElement) {
  const form = new FormData(formElement);
  await runBusy(async () => {
    const result = await api("/admin/bots", {
      method: "POST",
      body: {
        tableId: form.get("tableId"),
        name: form.get("name"),
        buyIn: Number(form.get("buyIn"))
      }
    });
    applyAdminPayload(result);
    if (state.table && result.table && state.table.id === result.table.id) {
      await refreshTable(true);
    }
    setMessage(`${result.bot.username} 已加入 ${result.table.name}`);
  });
}

async function addQuickMessage(formElement) {
  const form = new FormData(formElement);
  await runBusy(async () => {
    const result = await api("/admin/quick-messages", {
      method: "POST",
      body: {
        action: "add",
        message: form.get("message")
      }
    });
    applyAdminPayload(result);
    if (state.table) await refreshTable(true);
    formElement.reset();
    setMessage("快捷语已添加");
  });
}

async function deleteQuickMessage(message) {
  await runBusy(async () => {
    const result = await api("/admin/quick-messages", {
      method: "POST",
      body: {
        action: "delete",
        message
      }
    });
    applyAdminPayload(result);
    if (state.table) await refreshTable(true);
    setMessage("快捷语已删除");
  });
}

async function saveAudioSettings(formElement) {
  await runBusy(async () => {
    const audioSettings = await collectAudioSettings(formElement);
    const result = await api("/admin/audio-settings", {
      method: "POST",
      body: { audioSettings }
    });
    applyAdminPayload(result);
    if (state.table) await refreshTable(true);
    setMessage("音频设置已保存");
  });
}

async function collectAudioSettings(formElement) {
  const settings = defaultAudioSettings();
  for (const row of formElement.querySelectorAll("[data-audio-row]")) {
    const kind = row.dataset.audioKind;
    const key = row.dataset.audioKey || "";
    const asset = await collectAudioAsset(row);
    if (kind === "bgm") {
      settings.bgm = { ...asset, enabled: Boolean(asset.src && row.querySelector("[data-audio-enabled]")?.checked) };
    } else if (kind === "action") {
      if (asset.src) settings.actions[key] = asset;
    } else if (kind === "quick") {
      if (asset.src) settings.quickMessages[key] = asset;
    }
  }
  return settings;
}

async function collectAudioAsset(row) {
  const clear = Boolean(row.querySelector("[data-audio-clear]")?.checked);
  const file = row.querySelector("[data-audio-file]")?.files?.[0] || null;
  const srcInput = row.querySelector("[data-audio-src]");
  const nameInput = row.querySelector("[data-audio-name]");
  const currentSrc = row.querySelector("[data-audio-current-src]")?.value || "";
  const currentName = row.querySelector("[data-audio-current-name]")?.value || "";
  let src = "";
  let name = "";

  if (!clear && file) {
    if (file.size > AUDIO_UPLOAD_MAX_BYTES) throw new Error(`音频文件不能超过 ${Math.round(AUDIO_UPLOAD_MAX_BYTES / 1024)}KB`);
    const uploaded = await uploadAudioFile(file);
    src = uploaded.src;
    name = uploaded.name || file.name;
  } else if (!clear && srcInput?.value.trim()) {
    src = srcInput.value.trim();
    name = nameFromAudioSource(src);
  } else if (!clear && currentSrc) {
    src = currentSrc;
    name = currentName || nameFromAudioSource(currentSrc);
  }

  if (nameInput?.value.trim()) name = nameInput.value.trim();
  const volume = Math.max(0, Math.min(1, Number(row.querySelector("[data-audio-volume]")?.value || 0.8)));
  return { src, name, volume, enabled: Boolean(src) };
}

async function uploadAudioFile(file) {
  const uploadId = makeAudioUploadId();
  const totalChunks = Math.max(1, Math.ceil(file.size / AUDIO_UPLOAD_CHUNK_BYTES));
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * AUDIO_UPLOAD_CHUNK_BYTES;
    const chunk = file.slice(start, Math.min(file.size, start + AUDIO_UPLOAD_CHUNK_BYTES));
    const url = new URL(`${API_BASE}/admin/audio-upload/chunk`, window.location.origin);
    url.searchParams.set("uploadId", uploadId);
    url.searchParams.set("index", String(index));
    url.searchParams.set("totalChunks", String(totalChunks));
    url.searchParams.set("size", String(file.size));
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/octet-stream",
        "x-client-id": state.clientId,
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {})
      },
      body: chunk
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "音频上传失败");
  }

  const response = await api("/admin/audio-upload/complete", {
    method: "POST",
    body: {
      uploadId,
      name: file.name,
      mimeType: file.type || "audio/mpeg",
      size: file.size,
      totalChunks,
      chunkSize: AUDIO_UPLOAD_CHUNK_BYTES
    }
  });
  if (!response.asset?.src) throw new Error("音频上传失败");
  return response.asset;
}

function makeAudioUploadId() {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return random.replace(/[^a-z0-9_-]/gi, "").slice(0, 48);
}

function nameFromAudioSource(src) {
  if (!src || src.startsWith("data:")) return "";
  try {
    const path = src.startsWith("http") ? new URL(src).pathname : src;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || "").slice(0, 80);
  } catch {
    return "";
  }
}

function shell(content) {
  const user = state.user;
  const shellClass = `app-shell ${state.view === "table" || state.view === "blackjack" ? "table-shell" : ""} ${state.view === "blackjack" ? "blackjack-shell" : ""}`.trim();
  return `
    <div class="${shellClass}">
      <header class="topbar">
        <button class="brand" data-action="game-home" ${!user ? "disabled" : ""}>
          <span class="brand-mark">GH</span>
          <span>游戏大厅</span>
        </button>
        <div class="top-actions">
          ${user ? `<span class="wallet">${chipStackHtml(user.chips, true)}<span>${user.username}</span></span>` : ""}
          ${user ? `<button class="icon-text ${state.view === "lobby" || state.view === "table" ? "active" : ""}" data-action="poker-lobby">德州扑克</button>` : ""}
          ${user ? `<button class="icon-text ${state.view === "blackjack" ? "active" : ""}" data-action="blackjack">21点</button>` : ""}
          ${user ? `<button class="icon-text ${state.view === "slots" ? "active" : ""}" data-action="slots">老虎机</button>` : ""}
          ${user?.isAdmin ? `<button class="icon-text" data-action="admin">后台</button>` : ""}
          ${user ? `<button class="ghost" data-action="logout">退出</button>` : ""}
        </div>
      </header>
      ${content}
      ${state.message ? `<div class="toast">${state.message}</div>` : ""}
    </div>
  `;
}

function gamesView() {
  return shell(`
    <main class="games-lobby">
      <section class="games-main">
        <div class="section-title">
          <div>
            <h1>游戏大厅</h1>
            <p>选择玩法后进入对应房间</p>
          </div>
        </div>
        <div class="game-grid">
          <article class="game-card game-card-poker">
            <div class="game-card-art" aria-hidden="true">
              <span class="game-card-felt"></span>
              <span class="game-card-deck red">A</span>
              <span class="game-card-deck black">K</span>
              <span class="game-chip-stack">${chipStackHtml(188000, true)}</span>
            </div>
            <div>
              <h2>德州扑克</h2>
              <p>多人联网牌桌，支持 3 / 5 / 7 / 9 人桌、机器人陪玩和管理员活动筹码。</p>
            </div>
            <button class="primary" data-action="poker-lobby">进入德扑大厅</button>
          </article>
          <article class="game-card game-card-blackjack">
            <div class="game-card-art" aria-hidden="true">
              <span class="game-card-dealer"></span>
              <span class="game-card-deck red">J</span>
              <span class="game-card-deck black">10</span>
              <span class="game-chip-stack">${chipStackHtml(21000, true)}</span>
            </div>
            <div>
              <h2>21点</h2>
              <p>多人同桌对庄，服务器统一发牌、计分和结算，适合快速开局。</p>
            </div>
            <button class="primary" data-action="blackjack">进入21点大厅</button>
          </article>
          <article class="game-card game-card-slots">
            <div class="game-card-art" aria-hidden="true">
              ${["seven", "diamond", "crown"].map((symbol) => `<span class="game-slot-symbol">${slotSymbolHtml(symbol)}</span>`).join("")}
            </div>
            <div>
              <h2>幸运老虎机</h2>
              <p>钱包筹码玩法，滚轮动画和开奖结果由服务器返回，随时快速旋转。</p>
            </div>
            <button class="primary" data-action="slots">进入老虎机</button>
          </article>
        </div>
      </section>
      <aside class="games-side">
        <section class="wallet-panel">
          <h2>当前账户</h2>
          <div class="wallet-balance">
            ${chipStackHtml(state.user?.chips || 0, true)}
            <strong>${escapeHtml(state.user?.username || "玩家")}</strong>
          </div>
        </section>
        ${onlinePanelHtml()}
      </aside>
    </main>
  `);
}

function authView() {
  return shell(`
    <main class="auth-screen">
      <section class="auth-panel">
        <div class="auth-tabs">
          <button class="${state.authMode === "login" ? "active" : ""}" data-auth="login">登录</button>
          <button class="${state.authMode === "register" ? "active" : ""}" data-auth="register">注册</button>
        </div>
        <form class="auth-form" data-form="auth">
          <label>
            <span>账号</span>
            <input name="username" autocomplete="username" maxlength="18" required />
          </label>
          <label>
            <span>密码</span>
            <input name="password" type="password" autocomplete="current-password" minlength="6" required />
          </label>
          <button class="primary" type="submit">${state.authMode === "register" ? "创建账号" : "进入大厅"}</button>
        </form>
      </section>
      <section class="preview-table" aria-hidden="true">
        <div class="mini-felt">
          ${["A♠", "K♠", "Q♠", "J♠", "10♠"].map((text) => `<div class="mini-card">${text}</div>`).join("")}
          <div class="mini-pot">${chipStackHtml(8880)}</div>
        </div>
      </section>
    </main>
  `);
}

function lobbyView() {
  const tables = state.tables.map(lobbyTableRowHtml).join("");

  return shell(`
    <main class="lobby">
      <section class="lobby-main">
        <div class="section-title">
          <h1>大厅</h1>
          <button class="ghost" data-action="refresh-lobby">刷新</button>
        </div>
        <label class="buyin-line">
          <span>默认带入</span>
          <input data-buyin type="number" min="20" step="10" value="1000" />
        </label>
        <div class="tables-list">${tables || `<div class="empty-state">暂无牌桌</div>`}</div>
      </section>
      <aside class="create-panel">
        <h2>开桌</h2>
        <form data-form="create-table" class="stack-form">
          <label>
            <span>牌桌名</span>
            <input name="name" maxlength="28" value="${escapeAttr(state.user?.username || "玩家")} 的牌桌" required />
          </label>
          <div class="split">
            <label>
              <span>小盲</span>
              <input name="smallBlind" type="number" min="1" value="10" />
            </label>
            <label>
              <span>大盲</span>
              <input name="bigBlind" type="number" min="2" value="20" />
            </label>
          </div>
          <label>
            <span>座位</span>
            <select name="maxSeats">
              <option value="9">9 人桌</option>
              <option value="7">7 人桌</option>
              <option value="5">5 人桌</option>
              <option value="3">3 人桌</option>
            </select>
          </label>
          <button class="primary" type="submit">创建</button>
        </form>
        ${onlinePanelHtml()}
      </aside>
    </main>
  `);
}

function lobbyTableRowHtml(table) {
  return `
    <article class="table-row" data-table-row="${escapeAttr(table.id)}">
      <div>
        <h3 data-table-row-name>${escapeHtml(table.name)}</h3>
        <p data-table-row-meta>${lobbyTableMeta(table)}</p>
      </div>
      <div class="row-pot" data-table-row-pot>${chipStackHtml(table.pot || table.bigBlind * 10, true)}</div>
      <button class="primary slim" data-open-table="${escapeAttr(table.id)}">进桌</button>
    </article>
  `;
}

function lobbyTableMeta(table) {
  return `${stageLabel(table.status)} · ${table.players}/${table.maxSeats} 人 · ${table.smallBlind}/${table.bigBlind}`;
}

function onlinePanelHtml() {
  return `
    <section class="online-panel">
      <div class="online-head">
        <h2>在线玩家</h2>
        <span>${(state.onlineUsers || []).length}</span>
      </div>
      <div class="online-list" data-online-list>${onlineUsersHtml()}</div>
    </section>
  `;
}

function onlineUsersHtml() {
  const users = state.onlineUsers || [];
  if (!users.length) return `<p class="online-empty">暂无在线玩家</p>`;
  return users.map((user) => `
    <article class="online-row ${user.isSelf ? "me" : ""}">
      <span class="online-dot" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(user.username)}${user.isSelf ? "（你）" : ""}</strong>
        <small>${onlineLocationText(user.location)}${user.isAdmin ? " · 管理员" : ""}${user.isBot ? " · AI" : ""}</small>
      </div>
    </article>
  `).join("");
}

function onlineLocationText(location = {}) {
  if (location.type === "holdem") return `德扑 · ${location.label || "牌桌"}`;
  if (location.type === "blackjack") return `21点 · ${location.label || "牌桌"}`;
  return "大厅";
}

function syncOnlinePanel(root = document) {
  const list = root.querySelector?.("[data-online-list]");
  if (!list) return;
  setInnerHtml(list, onlineUsersHtml());
  const count = root.querySelector?.(".online-head span");
  if (count) count.textContent = String((state.onlineUsers || []).length);
}

function slotsView() {
  const slot = state.slot || {};
  const reels = slot.reels?.length ? slot.reels : SLOT_DEFAULT_REELS;
  const bet = Math.max(10, Number(slot.bet || 100));
  const reelSpinMode = slot.spinning && slot.settling ? "rolling" : "";
  return shell(`
    <main class="slots-view">
      <section class="slot-machine ${slot.spinning ? "spinning" : ""}">
        <div class="section-title">
          <div>
            <h1>幸运老虎机</h1>
            <p>钱包筹码玩法，开奖结果由服务器生成</p>
          </div>
          <button class="ghost" data-action="lobby">返回大厅</button>
        </div>
        <div class="slot-cabinet">
          <div class="slot-lights" aria-hidden="true"></div>
          <div class="slot-reels" aria-label="老虎机转轮">
            ${reels.slice(0, 3).map((symbol, index) => slotReelHtml(symbol, index, reelSpinMode)).join("")}
          </div>
          <div class="slot-result ${slot.result ? slot.result.tier : "idle"}">
            ${slotResultHtml(slot.result)}
          </div>
          <form class="slot-controls" data-form="slot-spin">
            <label>
              <span>下注筹码</span>
              <input name="bet" data-slot-bet-input type="number" min="10" step="10" value="${escapeAttr(bet)}" />
            </label>
            <div class="slot-bets">
              ${SLOT_BET_PRESETS.map((value) => `<button class="ghost slim" type="button" data-slot-bet="${value}">${money(value)}</button>`).join("")}
            </div>
            <button class="primary slot-spin-button" type="submit" ${slot.spinning || bet > Number(state.user?.chips || 0) ? "disabled" : ""}>
              ${slot.spinning ? "旋转中" : "开始旋转"}
            </button>
          </form>
        </div>
      </section>
      <aside class="slot-side">
        <section class="slot-card">
          <h2>赔率表</h2>
          <div class="slot-paytable">${slotPaytableHtml()}</div>
        </section>
        <section class="slot-card">
          <h2>最近记录</h2>
          <div class="slot-history">${slotHistoryHtml(slot.history || [])}</div>
        </section>
      </aside>
    </main>
  `);
}

function slotReelHtml(symbolId, index, spinMode = "") {
  const isRolling = spinMode === "rolling";
  if (!isRolling) {
    return `
      <div class="slot-reel reel-${index + 1} is-static">
        <div class="slot-reel-static">
          ${slotSymbolHtml(symbolId)}
        </div>
      </div>
    `;
  }

  const track = slotReelTrack(symbolId, index);
  const endStep = track.length - 1;
  return `
    <div class="slot-reel reel-${index + 1} is-rolling">
      <div class="slot-reel-track rolling" style="--slot-track-end: -${endStep};">
        ${track.map((item) => slotSymbolHtml(item)).join("")}
      </div>
    </div>
  `;
}

function slotReelTrack(symbolId, index) {
  const strip = SLOT_REEL_STRIPS[index % SLOT_REEL_STRIPS.length] || Object.keys(SLOT_SYMBOLS);
  const steps = SLOT_REEL_STEPS[index % SLOT_REEL_STEPS.length] || 30;
  const track = Array.from({ length: steps }, (_, step) => strip[step % strip.length] || "cherry");
  track.push(symbolId);
  return track;
}

function slotSymbolHtml(symbolId) {
  const symbol = slotSymbolMeta(symbolId);
  return `
    <span class="slot-symbol ${symbol.className}" title="${escapeAttr(symbol.label)}">
      <img src="${escapeAttr(symbol.icon)}" alt="${escapeAttr(symbol.label)}" loading="lazy" decoding="async" />
    </span>
  `;
}

function slotSymbolMeta(symbolId) {
  return SLOT_SYMBOLS[symbolId] || SLOT_SYMBOLS.cherry;
}

function slotResultHtml(result) {
  if (!result) return `<strong>等待旋转</strong><span>选择下注后开始</span>`;
  const profit = Number(result.profit || 0);
  const text = profit > 0 ? `净赢 ${money(profit)}` : profit === 0 ? "保本" : `亏损 ${money(Math.abs(profit))}`;
  return `<strong>${escapeHtml(result.title || "开奖结果")}</strong><span>${text} · 派彩 ${money(result.payout || 0)}</span>`;
}

function slotPaytableHtml() {
  const triples = Object.entries(SLOT_SYMBOLS)
    .map(([id, symbol]) => `<p>${slotSymbolHtml(id)}<span>${escapeHtml(symbol.label)} 三连</span><b>${symbol.triple}</b></p>`)
    .join("");
  const pairs = Object.entries(SLOT_SYMBOLS)
    .filter(([, symbol]) => symbol.pair && symbol.pair !== "1x")
    .map(([id, symbol]) => `<p>${slotSymbolHtml(id)}<span>${escapeHtml(symbol.label)} 一对</span><b>${symbol.pair}</b></p>`)
    .join("");
  const specials = SLOT_SPECIAL_COMBOS
    .map((combo) => `
      <p>
        <span class="slot-combo-symbols">${combo.ids.map((id) => slotSymbolHtml(id)).join("")}</span>
        <span>${escapeHtml(combo.label)}</span>
        <b>${escapeHtml(combo.multiplier)}</b>
      </p>
    `)
    .join("");
  return `${specials}${triples}${pairs}`;
}

function slotHistoryHtml(history) {
  if (!history.length) return `<p class="slot-empty">暂无记录</p>`;
  return history.map((entry) => `
    <article class="slot-history-row ${entry.tier || "miss"}">
      <div>${(entry.symbols || []).map((symbol) => slotSymbolHtml(symbol)).join("")}</div>
      <strong>${escapeHtml(entry.title || "旋转")}</strong>
      <span>下注 ${money(entry.bet || 0)} · ${entry.profit >= 0 ? "+" : "-"}${money(Math.abs(entry.profit || 0))}</span>
    </article>
  `).join("");
}

function blackjackView() {
  const game = state.blackjack || {};
  const table = game.table || null;
  if (!table) return blackjackLobbyView();
  return blackjackTableView(table);
}

function blackjackLobbyView() {
  const game = state.blackjack || {};
  const tables = (game.tables || []).map(blackjackLobbyTableRowHtml).join("");
  const bet = Math.max(10, Number(game.bet || 100));
  const buyIn = Math.max(bet, Number(game.buyIn || bet * 20));
  return shell(`
    <main class="blackjack-lobby">
      <section class="lobby-main">
        <div class="section-title">
          <div>
            <h1>21点大厅</h1>
            <p>多人同桌对庄，服务器统一发牌结算</p>
          </div>
          <div class="toolbar-actions">
            <button class="ghost" data-action="lobby">主大厅</button>
            <button class="ghost" data-action="blackjack">刷新</button>
          </div>
        </div>
        <label class="buyin-line">
          <span>默认带入</span>
          <input data-blackjack-buyin type="number" min="${bet}" step="10" value="${escapeAttr(buyIn)}" />
        </label>
        <div class="tables-list blackjack-tables-list">${tables || `<div class="empty-state">暂无 21 点桌</div>`}</div>
      </section>
      <aside class="create-panel blackjack-create-panel">
        <h2>创建 21 点桌</h2>
        <form data-form="blackjack-create-table" class="stack-form">
          <label>
            <span>牌桌名</span>
            <input name="name" maxlength="28" value="${escapeAttr(state.user?.username || "玩家")} 的21点桌" required />
          </label>
          <div class="split">
            <label>
              <span>单局下注</span>
              <input name="bet" data-blackjack-bet-input type="number" min="10" step="10" value="${escapeAttr(bet)}" />
            </label>
            <label>
              <span>带入筹码</span>
              <input name="buyIn" type="number" min="${bet}" step="10" value="${escapeAttr(buyIn)}" />
            </label>
          </div>
          <div class="blackjack-bets">
            ${BLACKJACK_BET_PRESETS.map((value) => `<button class="ghost slim" type="button" data-blackjack-bet="${value}">${money(value)}</button>`).join("")}
          </div>
          <label>
            <span>座位</span>
            <select name="maxSeats">
              ${BLACKJACK_SEAT_OPTIONS.map((value) => `<option value="${value}" ${Number(game.maxSeats || 5) === value ? "selected" : ""}>${value} 人桌</option>`).join("")}
            </select>
          </label>
          <button class="primary" type="submit">创建并入座</button>
        </form>
        ${onlinePanelHtml()}
      </aside>
    </main>
  `);
}

function blackjackLobbyTableRowHtml(table) {
  return `
    <article class="table-row" data-blackjack-table-row="${escapeAttr(table.id)}">
      <div>
        <h3>${escapeHtml(table.name)}</h3>
        <p>${blackjackLobbyTableMeta(table)}</p>
      </div>
      <div class="row-pot">${chipStackHtml(table.pot || table.defaultBet || 100, true)}</div>
      <button class="primary slim" data-open-blackjack-table="${escapeAttr(table.id)}">进桌</button>
    </article>
  `;
}

function blackjackLobbyTableMeta(table) {
  return `${escapeHtml(table.stage || stageLabel(table.status))} · ${table.players}/${table.maxSeats} 人 · 下注 ${money(table.defaultBet || 0)}`;
}

function blackjackTableView(table) {
  const seatCount = table.maxSeats || 5;
  const seats = blackjackSeatEntries(table);
  const isSeated = table.youSeat != null;
  const playing = table.status === "playing";
  return shell(`
    <main class="game-layout blackjack-layout stage-${table.status || "waiting"}" data-blackjack-table-id="${escapeAttr(table.id)}" data-max-seats="${seatCount}">
      <div class="casino-room" aria-hidden="true">
        <span class="room-column column-left"></span>
        <span class="room-column column-right"></span>
      </div>
      <section class="table-toolbar">
        <button class="ghost" data-action="blackjack-lobby">21点大厅</button>
        <div class="table-title">
          <strong>${escapeHtml(table.name)}</strong>
          <span class="table-subline">
            <span>${blackjackTableMetaText(table)}</span>
            ${pingBadgeHtml()}
          </span>
        </div>
        <div class="toolbar-actions">
          <button class="ghost slim bgm-toggle ${state.bgmEnabled ? "active" : ""}" data-action="toggle-bgm">${state.bgmEnabled ? "音乐开" : "静音"}</button>
          <button class="ghost slim rules-toggle ${state.rulesOpen ? "active" : ""}" data-action="toggle-rules" aria-expanded="${state.rulesOpen ? "true" : "false"}">规则</button>
          <button class="ghost slim" data-action="blackjack">刷新</button>
          <button class="ghost slim" data-action="blackjack-leave" ${table.controls?.canLeave ? "" : "disabled"}>${playing ? "放弃离桌" : "离桌"}</button>
          <button class="danger slim" data-action="blackjack-disband" ${table.controls?.canDisband ? "" : "disabled"}>解散桌子</button>
        </div>
      </section>
      <section class="poker-room blackjack-room">
        <div class="felt-table blackjack-felt-table blackjack-seats-${seatCount} ${playing ? "playing" : ""}">
          <div class="rail"></div>
          <div class="blackjack-table-mark" aria-hidden="true">
            <strong>BLACKJACK</strong>
            <span>Dealer stands on 17</span>
          </div>
          ${blackjackDealerHtml(table)}
          <div class="blackjack-center">
            <div class="blackjack-pot">
              ${chipStackHtml(table.pot || table.defaultBet || state.blackjack.bet || 100)}
              <span>${playing ? "本轮总注" : "单局下注"}</span>
            </div>
            <div class="blackjack-status ${blackjackResultClass(table)}">
              ${blackjackStatusHtml(table)}
            </div>
          </div>
          ${seats.map((entry) => blackjackSeatHtml(entry, table)).join("")}
        </div>
      </section>
      <aside class="side-panel blackjack-side-panel">
        ${isSeated ? blackjackControlPanelHtml(table) : blackjackSitPanelHtml(table)}
        <div class="log-panel blackjack-log-panel">
          <h2>牌局记录</h2>
          <div class="blackjack-history">${blackjackLogsHtml(table)}</div>
        </div>
      </aside>
      ${blackjackRulesPanelHtml()}
      ${blackjackShowdownOverlayHtml(table)}
    </main>
  `);
}

function blackjackTableMetaText(table) {
  return `${escapeHtml(table.stage || blackjackStageLabel(table.status))} · 第 ${table.handNo || 0} 轮 · ${blackjackSeatedPlayersCount(table)}/${table.maxSeats} 人 · ${money(table.defaultBet || 0)}`;
}

function blackjackStageLabel(status) {
  return {
    waiting: "等待入座",
    playing: "行动中",
    showdown: "结算"
  }[status] || status;
}

function blackjackSeatedPlayersCount(table) {
  return (table.seats || []).filter(Boolean).length;
}

function blackjackDealerHtml(table) {
  return `
    <div class="blackjack-seat blackjack-dealer">
      <div class="avatar-ring dealer-avatar" style="--avatar-hue:42;--turn-progress:1">
        <div class="avatar-face"><span>D</span></div>
      </div>
      <div class="blackjack-seat-info">
        <strong>庄家</strong>
        <span>${escapeHtml(table.dealerLabel || "等待发牌")}</span>
      </div>
      <div class="blackjack-cards dealer-cards">
        ${blackjackCardsHtml(table.dealerCards || [])}
      </div>
    </div>
  `;
}

function blackjackCardsHtml(cards) {
  if (!cards.length) {
    return `
      <span class="blackjack-card-slot empty" style="--i:0">${cardHtml(null)}</span>
      <span class="blackjack-card-slot empty" style="--i:1">${cardHtml(null)}</span>
    `;
  }
  return cards.map((card, index) => `<span class="blackjack-card-slot" style="--i:${index}">${cardHtml(card)}</span>`).join("");
}

function blackjackStatusHtml(table) {
  if (table.status === "playing") {
    const player = (table.seats || [])[table.currentTurnSeat];
    return `<strong>${player ? `${escapeHtml(player.username)} 行动` : "行动中"}</strong><span>要牌、停牌，前两张可加倍</span>`;
  }
  if (table.status === "showdown") {
    const best = (table.results || []).slice().sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0))[0];
    if (best) return `<strong>${escapeHtml(best.username)} · ${escapeHtml(best.title || "结算")}</strong><span>${best.profit >= 0 ? "+" : ""}${money(best.profit || 0)} · 庄 ${escapeHtml(best.dealerLabel || "")}</span>`;
    return `<strong>本轮结算</strong><span>等待下一轮发牌</span>`;
  }
  return `<strong>等待开局</strong><span>入座后选择下注并开始本轮</span>`;
}

function blackjackResultClass(table) {
  const outcome = table.status === "showdown"
    ? ((table.results || []).some((result) => result.outcome === "blackjack" || result.outcome === "win") ? "win" : "push")
    : table.status;
  return String(outcome).replace(/[^\w-]/g, "");
}

function blackjackSeatEntries(table) {
  const seatCount = table.maxSeats || 5;
  const anchor = table.youSeat == null ? 0 : table.youSeat;
  return Array.from({ length: seatCount }, (_, displaySeat) => {
    const actualSeat = table.youSeat == null ? displaySeat : (anchor + displaySeat) % seatCount;
    return {
      displaySeat,
      actualSeat,
      player: table.seats?.[actualSeat] || null
    };
  });
}

function blackjackSeatHtml(entry, table) {
  const style = blackjackSeatStyle(entry, table);
  return `
    <div class="${blackjackSeatClassName(entry, table)}" data-blackjack-seat="${entry.actualSeat}" data-display-seat="${entry.displaySeat}"${style ? ` style="${style}"` : ""}>
      ${blackjackSeatContentHtml(entry, table)}
    </div>
  `;
}

function blackjackSeatStyle(entry, table) {
  if (entry.displaySeat === 0) return "";
  const seatCount = Math.max(3, Number(table.maxSeats || 5));
  const opponentSlots = Math.max(1, seatCount - 1);
  const leftCount = Math.ceil(opponentSlots / 2);
  const leftPath = [
    [33, 73],
    [18, 62],
    [15, 45],
    [27, 28]
  ];
  const rightPath = [
    [68, 28],
    [77, 45],
    [75, 62],
    [63, 73]
  ];

  if (entry.displaySeat <= leftCount) {
    const p = sideSeatProgress(entry.displaySeat - 1, leftCount);
    const [x, y] = interpolateSeatPath(leftPath, p);
    return `--bj-seat-left:${x.toFixed(2)}%;--bj-seat-top:${y.toFixed(2)}%`;
  }

  const rightCount = opponentSlots - leftCount;
  const rightIndex = entry.displaySeat - leftCount - 1;
  const p = sideSeatProgress(rightIndex, rightCount);
  const [x, y] = interpolateSeatPath(rightPath, p);
  return `--bj-seat-left:${x.toFixed(2)}%;--bj-seat-top:${y.toFixed(2)}%`;
}

function blackjackSeatClassName(entry, table) {
  const player = entry.player;
  const isMe = player && table.youSeat === entry.actualSeat;
  const isTurn = table.currentTurnSeat === entry.actualSeat && table.status === "playing";
  const outcome = player?.result?.outcome || "";
  return ["blackjack-player-seat", `bj-seat-${entry.displaySeat}`, player ? "occupied" : "empty", isMe ? "me" : "", isTurn ? "turn" : "", outcome]
    .filter(Boolean)
    .join(" ");
}

function blackjackSeatContentHtml(entry, table) {
  const { player, actualSeat } = entry;
  if (!player) {
    const canJoin = table.controls?.canJoin;
    return `
      <button class="seat-join blackjack-seat-join" ${canJoin ? `data-join-blackjack-seat="${actualSeat}"` : "disabled"}>
        <span class="avatar">+</span>
        <strong>空位</strong>
      </button>
    `;
  }

  const isTurn = table.currentTurnSeat === actualSeat && table.status === "playing";
  const timerText = isTurn ? countdownText(table) : "";
  const timerStyle = isTurn ? ` style="--turn-progress:${countdownPercent(table)}"` : "";
  const hasBet = Number(player.bet || 0) > 0;
  return `
    <div class="blackjack-seat-player">
      <span class="turn-pointer" aria-hidden="true">行动</span>
      <div class="avatar-ring" style="--avatar-hue:${avatarHue(player.username)};--turn-progress:${countdownPercent(table)}">
        <div class="avatar-face"><span>${escapeHtml(avatarInitial(player.username))}</span></div>
        ${isTurn ? `<em class="seat-timer" data-seat-timer="${actualSeat}"${timerStyle}>${timerText}</em>` : ""}
      </div>
      <div class="blackjack-seat-info">
        <strong>${escapeHtml(player.username)}${player.isBot ? ` <em class="bot-badge">AI</em>` : ""}</strong>
        <span>${money(player.stack || 0)}</span>
      </div>
      <div class="blackjack-cards player-cards">${blackjackCardsHtml(player.cards || [])}</div>
      <div class="seat-bet ${hasBet ? "" : "empty"}" ${hasBet ? "" : `aria-hidden="true"`}>${hasBet ? chipStackHtml(player.bet, true) : ""}</div>
      <div class="status-pill">${escapeHtml(player.scoreLabel || player.lastAction || "等待")}${player.result ? ` · ${player.result.profit >= 0 ? "+" : ""}${money(player.result.profit || 0)}` : ""}</div>
    </div>
  `;
}

function blackjackControlPanelHtml(table) {
  const playing = table.status === "playing";
  const controls = table.controls || {};
  const player = table.youSeat == null ? null : table.seats?.[table.youSeat];
  const bet = Math.max(10, Number(state.blackjack.bet || table.defaultBet || 100));
  return `
    <div class="control-panel blackjack-control ${playing ? "live" : "ready"}">
      <div class="action-status">
        <span class="${controls.canAct ? "live-dot" : ""}">${controls.canAct ? "轮到你" : blackjackControlStatusText(table)}</span>
        <b>${player ? escapeHtml(player.scoreLabel || "等待开局") : "选择座位入桌"}</b>
        ${table.status === "playing" ? `<strong class="turn-countdown" data-countdown-ring style="--turn-progress:${countdownPercent(table)}"><span data-countdown-label>${countdownText(table)}</span></strong>` : ""}
      </div>
      ${playing ? blackjackActionsHtml(table) : blackjackStartRoundFormHtml(table, bet)}
    </div>
  `;
}

function blackjackControlStatusText(table) {
  if (table.status === "showdown") return "等待下一轮";
  if (table.status === "waiting") return "准备区";
  const player = table.seats?.[table.currentTurnSeat];
  return player ? `${player.username} 行动` : "行动中";
}

function blackjackActionsHtml(table) {
  const actions = table.controls || {};
  const player = table.youSeat == null ? null : table.seats?.[table.youSeat];
  return `
    <div class="action-bottom-bar blackjack-actions">
      <button class="primary action-big" data-blackjack-action="hit" ${actions.canHit ? "" : "disabled"}>要牌</button>
      <button class="success action-big" data-blackjack-action="stand" ${actions.canStand ? "" : "disabled"}>停牌</button>
      <button class="ghost action-big allin" data-blackjack-action="double" ${actions.canDouble ? "" : "disabled"}>加倍 ${money(player?.bet || table.defaultBet || 0)}</button>
    </div>
  `;
}

function blackjackStartRoundFormHtml(table, bet) {
  return `
    <form class="blackjack-deal" data-form="blackjack-start-round">
      <label>
        <span>本轮下注</span>
        <input name="bet" data-blackjack-bet-input type="number" min="10" step="10" value="${escapeAttr(bet)}" />
      </label>
      <div class="blackjack-bets">
        ${BLACKJACK_BET_PRESETS.map((value) => `<button class="ghost slim" type="button" data-blackjack-bet="${value}">${money(value)}</button>`).join("")}
      </div>
      <button class="primary" type="submit" ${table.controls?.canStart ? "" : "disabled"}>${table.status === "showdown" ? "再来一轮" : "开始本轮"}</button>
    </form>
  `;
}

function blackjackSitPanelHtml(table) {
  const buyIn = Math.max(table.defaultBet || 100, Number(state.blackjack.buyIn || (table.defaultBet || 100) * 20));
  const disabled = !table.controls?.canJoin;
  return `
    <div class="control-panel sit-control blackjack-sit-control">
      <h2>入座</h2>
      <label>
        <span>带入筹码</span>
        <input data-blackjack-buyin type="number" min="${table.defaultBet || 10}" step="10" value="${escapeAttr(buyIn)}" ${disabled ? "disabled" : ""} />
      </label>
      <button class="primary" data-join-blackjack-table="${escapeAttr(table.id)}" ${disabled ? "disabled" : ""}>坐下</button>
    </div>
  `;
}

function blackjackRulesPanelHtml() {
  return `
    <section class="rules-drawer ${state.rulesOpen ? "open" : ""}" data-rules-drawer aria-hidden="${state.rulesOpen ? "false" : "true"}">
      <div class="rules-head">
        <h2>21点规则</h2>
        <button class="ghost slim" data-action="toggle-rules">关闭</button>
      </div>
      <div class="rules-body">
        <p><strong>目标</strong>：手牌点数尽量接近 21 点，但不能超过 21 点。</p>
        <p><strong>点数</strong>：2-10 按牌面计算，J/Q/K 为 10 点，A 可算 1 点或 11 点。</p>
        <p><strong>多人桌</strong>：同桌玩家使用同一轮下注，按座位顺序依次行动，每人 20 秒。</p>
        <p><strong>操作</strong>：发牌后可以要牌、停牌；前两张牌时可加倍，加倍会追加同额下注并只补一张牌。</p>
        <p><strong>庄家</strong>：所有玩家行动结束后，庄家亮出暗牌并在低于 17 点时继续补牌。</p>
        <p><strong>派彩</strong>：Blackjack 为 3:2，普通胜为 1:1，平局退回本金。</p>
      </div>
    </section>
  `;
}

function blackjackLogsHtml(table) {
  return (table.logs || []).map((entry) => `<p>${escapeHtml(entry.text)}</p>`).join("") || "<p>等待开局</p>";
}

function blackjackShowdownOverlayHtml(table) {
  const results = table.results || [];
  const visible = table.status === "showdown" && results.length > 0;
  const rows = results
    .slice()
    .sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0))
    .map((result) => `
      <article class="showdown-winner ${result.outcome || ""}">
        <div class="showdown-winner-main">
          <strong>${escapeHtml(result.username)}</strong>
          <span>${result.profit >= 0 ? "+" : ""}${money(result.profit || 0)}</span>
          <em>${escapeHtml(result.title || "")}</em>
        </div>
      </article>
    `).join("");
  const stackRows = (table.seats || []).filter(Boolean).map((player) => `
    <span>${escapeHtml(player.username)} <b>${money(player.stack)}</b></span>
  `).join("");
  return `
    <section class="showdown-overlay blackjack-showdown-overlay ${visible ? "visible" : ""}" data-showdown-overlay aria-hidden="${visible ? "false" : "true"}">
      <div class="showdown-card">
        <h2>21 点结算</h2>
        <div class="showdown-winners">${rows || "<p><strong>等待结算</strong></p>"}</div>
        <div class="showdown-stacks">${stackRows}</div>
      </div>
    </section>
  `;
}

function blackjackHistoryHtml(history) {
  if (!history.length) return `<p class="slot-empty">暂无记录</p>`;
  return history.map((entry) => {
    const profit = Number(entry.profit || 0);
    return `
      <article class="blackjack-history-row ${escapeAttr(entry.outcome || "lose")}">
        <strong>${escapeHtml(entry.title || "结算")}</strong>
        <span>${escapeHtml(entry.playerLabel || "")} / 庄 ${escapeHtml(entry.dealerLabel || "")}</span>
        <b>${profit >= 0 ? "+" : "-"}${money(Math.abs(profit))}</b>
      </article>
    `;
  }).join("");
}

function tableView() {
  const table = state.table;
  if (!table) return lobbyView();
  const seatCount = table.maxSeats || 9;
  const seats = seatEntries(table);
  const isSeated = table.youSeat != null;
  const controls = table.controls || {};

  return shell(`
    <main class="${tableLayoutClass(table)}" data-table-id="${table.id}" data-max-seats="${seatCount}">
      <div class="casino-room" aria-hidden="true">
        <span class="room-column column-left"></span>
        <span class="room-column column-right"></span>
      </div>
      <section class="table-toolbar">
        <button class="ghost" data-action="back-lobby">大厅</button>
        <div class="table-title">
          <strong data-table-title>${escapeHtml(table.name)}</strong>
          <span class="table-subline">
            <span data-table-meta>${tableMetaText(table)}</span>
            ${pingBadgeHtml()}
          </span>
        </div>
        <div class="toolbar-actions">${toolbarActionsHtml(table)}</div>
      </section>
      <section class="poker-room">
        <div class="felt-table seats-${seatCount}">
          <div class="rail"></div>
          <div class="table-center">
            <div class="board">${boardHtml(table)}</div>
            <div class="pot">${potHtml(table)}</div>
          </div>
          ${seats.map((entry) => seatHtml(entry, table)).join("")}
        </div>
      </section>
      <aside class="side-panel">
        ${isSeated ? actionPanel(controls, table) : sitPanel(table)}
        ${isSeated ? tauntPanelHtml() : ""}
        <div class="log-panel">
          <h2>牌局记录</h2>
          <div class="logs">${logsHtml(table)}</div>
        </div>
      </aside>
      ${rulesPanelHtml()}
      ${showdownOverlayHtml(table)}
    </main>
  `);
}

function tableMetaText(table) {
  return `${stageLabel(table.status)} · 第 ${table.handNo || 0} 手牌 · ${table.smallBlind}/${table.bigBlind}`;
}

function pingBadgeHtml() {
  return `<span class="ping-badge ${pingQuality()}" data-ping-badge>Ping <b data-ping-label>${pingText()}</b></span>`;
}

function tableLayoutClass(table) {
  return `game-layout stage-${table.status || "waiting"}`;
}

function toolbarActionsHtml(table) {
  const isSeated = table.youSeat != null;
  const canStart = isSeated && ["waiting", "showdown"].includes(table.status);
  const canLeave = Boolean(table.controls?.canLeave);
  const canDisband = Boolean(table.controls?.canDisband);
  const activeHand = Boolean(table.controls?.activeHand);
  return `
    <button class="ghost slim bgm-toggle ${state.bgmEnabled ? "active" : ""}" data-action="toggle-bgm">${state.bgmEnabled ? "音乐开" : "静音"}</button>
    <button class="ghost slim rules-toggle ${state.rulesOpen ? "active" : ""}" data-action="toggle-rules" aria-expanded="${state.rulesOpen ? "true" : "false"}">规则</button>
    <button class="primary slim" data-action="start-hand" ${canStart ? "" : "disabled"}>发牌</button>
    <button class="ghost slim" data-action="leave-table" ${canLeave ? "" : "disabled"}>${activeHand ? "弃牌离桌" : "离桌"}</button>
    <button class="danger slim" data-action="disband-table" ${canDisband ? "" : "disabled"}>解散桌子</button>
  `;
}

function tauntPanelHtml() {
  const presets = quickMessages();
  return `
    <div class="taunt-panel ${state.chatOpen ? "open" : ""}" aria-label="聊天框">
      <div class="taunt-chatbox">
        <div class="chat-head">
          <strong>聊天记录</strong>
        </div>
        <div class="chat-screen" data-chat-screen>
          ${chatHistoryHtml(state.table)}
        </div>
        <form class="chat-compose" data-form="chat-message">
          <input data-chat-input name="message" maxlength="${CHAT_MAX_LENGTH}" autocomplete="off" placeholder="输入聊天内容" />
          <button class="ghost slim chat-shortcut" type="button" data-action="toggle-chat" aria-expanded="${state.chatOpen ? "true" : "false"}">快捷</button>
          <button class="primary slim" type="submit">发送</button>
        </form>
        <div class="chat-presets" aria-hidden="${state.chatOpen ? "false" : "true"}">
          ${presets.map((message) => `<button type="button" data-taunt-message="${escapeAttr(message)}">${escapeHtml(message)}</button>`).join("")}
        </div>
      </div>
    </div>
  `;
}

function quickMessages() {
  const tableMessages = state.table?.quickMessages;
  if (Array.isArray(tableMessages) && tableMessages.length) return tableMessages;
  const adminMessages = state.admin?.quickMessages;
  if (Array.isArray(adminMessages) && adminMessages.length) return adminMessages;
  return TAUNT_MESSAGES;
}

function chatHistoryHtml(table) {
  const messages = table?.chat || [];
  if (!messages.length) return `<p class="chat-empty">暂无聊天</p>`;
  return messages.map((item) => {
    const isMe = state.user && item.userId === state.user.id;
    return `
      <p class="chat-line ${isMe ? "me" : ""}">
        <span><b>${escapeHtml(item.username || "玩家")}</b><time>${chatTime(item.at)}</time></span>
        <em>${escapeHtml(item.text)}</em>
      </p>
    `;
  }).join("");
}

function chatTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function rulesPanelHtml() {
  return `
    <section class="rules-drawer ${state.rulesOpen ? "open" : ""}" data-rules-drawer aria-hidden="${state.rulesOpen ? "false" : "true"}">
      <div class="rules-head">
        <h2>德州扑克规则</h2>
        <button class="ghost slim" data-action="toggle-rules">关闭</button>
      </div>
      <div class="rules-body">
        <p><strong>目标</strong>：用自己的 2 张手牌和桌面 5 张公共牌，组成最大的 5 张牌牌型。</p>
        <p><strong>流程</strong>：翻前下注，随后依次翻牌 3 张、转牌 1 张、河牌 1 张，每轮都可看牌、跟注、加注、全下或弃牌。</p>
        <p><strong>行动时间</strong>：轮到玩家后有 20 秒操作，超时自动弃牌。</p>
        <p><strong>牌型大小</strong>：皇家同花顺 &gt; 同花顺 &gt; 四条 &gt; 葫芦 &gt; 同花 &gt; 顺子 &gt; 三条 &gt; 两对 &gt; 一对 &gt; 高牌。</p>
        <p><strong>摊牌</strong>：河牌下注结束后比牌；若其他玩家都弃牌，最后未弃牌者直接赢得底池。</p>
      </div>
    </section>
  `;
}

function showdownOverlayHtml(table) {
  const winners = table.winners || [];
  const visible = table.status === "showdown" && winners.length > 0;
  const winnerRows = winners.map((winner) => {
    const cards = showdownWinnerCardsHtml(table, winner);
    return `
      <article class="showdown-winner ${cards ? "has-cards" : ""}">
        <div class="showdown-winner-main">
          <strong>${escapeHtml(winner.username)}</strong>
          <span>+${money(winner.amount)}</span>
          ${winner.hand ? `<em>${escapeHtml(winner.hand)}</em>` : ""}
        </div>
        ${cards}
      </article>
    `;
  }).join("");
  const stackRows = (table.seats || []).filter(Boolean).map((player) => `
    <span>${escapeHtml(player.username)} <b>${money(player.stack)}</b></span>
  `).join("");
  return `
    <section class="showdown-overlay ${visible ? "visible" : ""}" data-showdown-overlay aria-hidden="${visible ? "false" : "true"}">
      <div class="showdown-card">
        <h2>本手结算</h2>
        <div class="showdown-winners">${winnerRows || "<p><strong>等待结算</strong></p>"}</div>
        <div class="showdown-stacks">${stackRows}</div>
      </div>
    </section>
  `;
}

function showdownWinnerCardsHtml(table, winner) {
  if (!table.revealed) return "";
  const player = (table.seats || []).find((seat) => seat && seat.userId === winner.userId);
  const cards = (player?.hole || []).slice(0, 2).filter(Boolean);
  if (cards.length < 2) return "";
  return `<div class="showdown-winner-cards">${cards.map((card) => cardHtml(card, true)).join("")}</div>`;
}

function boardCards(table) {
  const board = [...(table.community || [])];
  while (board.length < 5) board.push(null);
  return board;
}

function boardHtml(table) {
  return boardCards(table).map((card, index) => boardSlotHtml(card, index)).join("");
}

function boardSlotHtml(card, index) {
  return `<div class="board-slot ${card ? "filled" : "empty"}" data-board-card="${index}" data-card-value="${card || ""}">${communityCardHtml(card)}</div>`;
}

function potHtml(table) {
  return `${chipStackHtml(table.pot)}<span>底池</span>`;
}

function logsHtml(table) {
  return (table.logs || []).map((entry) => `<p>${escapeHtml(entry.text)}</p>`).join("") || "<p>等待开局</p>";
}

function seatEntries(table) {
  const seatCount = table.maxSeats || 9;
  const anchor = table.youSeat == null ? 0 : table.youSeat;
  return Array.from({ length: seatCount }, (_, displaySeat) => {
    const actualSeat = table.youSeat == null ? displaySeat : (anchor + displaySeat) % seatCount;
    return {
      displaySeat,
      actualSeat,
      player: table.seats[actualSeat] || null
    };
  });
}

function seatHtml(entry, table) {
  const style = seatStyle(entry, table);
  return `
    <div class="${seatClassName(entry, table)}" data-seat="${entry.actualSeat}" data-display-seat="${entry.displaySeat}"${style ? ` style="${style}"` : ""}>
      ${seatContentHtml(entry, table)}
    </div>
  `;
}

function seatStyle(entry, table) {
  if (entry.displaySeat === 0) return "";
  const seatCount = Math.max(3, Number(table.maxSeats || 9));
  const opponentSlots = Math.max(1, seatCount - 1);
  const leftEdgePath = [
    [20, 27],
    [9, 42],
    [7, 55],
    [13, 68],
    [25, 74]
  ];
  const rightEdgePath = [
    [75, 74],
    [87, 68],
    [93, 55],
    [91, 42],
    [80, 27]
  ];
  const leftCount = Math.ceil(opponentSlots / 2);

  if (entry.displaySeat <= leftCount) {
    const p = sideSeatProgress(entry.displaySeat - 1, leftCount);
    const [x, y] = interpolateSeatPath(leftEdgePath, p);
    return `--seat-left:${x.toFixed(2)}%;--seat-top:${y.toFixed(2)}%`;
  }

  const rightCount = opponentSlots - leftCount;
  const rightIndex = entry.displaySeat - leftCount - 1;
  const p = sideSeatProgress(rightIndex, rightCount);
  const [x, y] = interpolateSeatPath(rightEdgePath, p);
  return `--seat-left:${x.toFixed(2)}%;--seat-top:${y.toFixed(2)}%`;
}

function sideSeatProgress(index, count) {
  if (count <= 1) return 0.56;
  if (count === 2) return [0.18, 0.75][index] ?? 0.5;
  if (count === 3) return [0, 0.48, 0.86][index] ?? 0.5;
  if (count === 4) return [0, 0.26, 0.72, 1][index] ?? 0.5;
  return index / (count - 1);
}

function interpolateSeatPath(points, t) {
  const clamped = Math.max(0, Math.min(1, Number(t) || 0));
  const scaled = clamped * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const [x1, y1] = points[index];
  const [x2, y2] = points[index + 1];
  return [
    x1 + (x2 - x1) * local,
    y1 + (y2 - y1) * local
  ];
}

function seatClassName(entry, table) {
  const { player, displaySeat, actualSeat } = entry;
  const occupied = Boolean(player);
  const isMe = player && table.youSeat === actualSeat;
  const isTurn = table.currentTurnSeat === actualSeat;
  const winnerIds = new Set((table.winners || []).map((winner) => winner.userId));
  const hasFaceUpHole = player?.hole?.some(Boolean);
  const isWinner = player && table.status === "showdown" && table.revealed && winnerIds.has(player.userId) && hasFaceUpHole;
  return ["seat", `seat-${displaySeat}`, occupied ? "occupied" : "empty", isMe ? "me" : "", isTurn ? "turn" : "", isWinner ? "winner" : "", player?.folded ? "folded" : ""]
    .filter(Boolean)
    .join(" ");
}

function seatContentHtml(entry, table) {
  const { player, actualSeat } = entry;
  const occupied = Boolean(player);
  const dealer = table.dealerSeat === actualSeat;
  const holeCards = occupied && player.hole && player.hole.length ? player.hole : [null, null];
  const hasBet = occupied && Number(player.bet) > 0;
  const isTurn = table.currentTurnSeat === actualSeat && table.controls?.activeHand;
  const timerText = isTurn ? countdownText(table) : "";
  const timerStyle = isTurn ? ` style="--turn-progress:${countdownPercent(table)}"` : "";

  if (!occupied) {
    const canJoin = table.youSeat == null && ["waiting", "showdown"].includes(table.status);
    return `
      <button class="seat-join" ${canJoin ? `data-join-seat="${actualSeat}"` : "disabled"}>
        <span class="avatar">+</span>
        <strong>空位</strong>
      </button>
    `;
  }

  return `
    <div class="seat-player">
      <span class="turn-pointer" aria-hidden="true">行动</span>
      ${dealer ? `<span class="dealer">D</span>` : ""}
      <div class="avatar-ring" style="--avatar-hue:${avatarHue(player.username)};--turn-progress:${countdownPercent(table)}">
        <div class="avatar-face">
          <span>${escapeHtml(avatarInitial(player.username))}</span>
        </div>
        ${isTurn ? `<em class="seat-timer" data-seat-timer="${actualSeat}"${timerStyle}>${timerText}</em>` : ""}
      </div>
      ${tauntBubbleHtml(player)}
      <div class="hole-cards">${holeCards.slice(0, 2).map((card) => cardHtml(card, true)).join("")}</div>
      <div class="player-info">
        <strong>${escapeHtml(player.username)}${player.isBot ? ` <em class="bot-badge">AI</em>` : ""}</strong>
        <span class="stack-line"><small>剩余</small><b>${money(player.stack)}</b></span>
      </div>
      <div class="seat-bet ${hasBet ? "" : "empty"}" ${hasBet ? "" : `aria-hidden="true"`}>${hasBet ? chipStackHtml(player.bet, true) : ""}</div>
      <div class="status-pill">${escapeHtml(player.lastAction || "等待")}${player.bestHandName ? ` · ${player.bestHandName}` : ""}</div>
    </div>
  `;
}

function tauntBubbleHtml(player) {
  const taunt = player?.taunt;
  if (!taunt?.text) return "";
  const stamp = new Date(taunt.at || "").getTime();
  const age = Number.isFinite(stamp) ? (Date.now() + state.serverClockOffset) - stamp : 0;
  if (age > 8000) return "";
  return `<div class="taunt-bubble">${escapeHtml(taunt.text)}</div>`;
}

function auditText(item) {
  const actor = item.actor || item.actorId || "";
  const target = item.target ? ` → ${item.target}` : "";
  const amount = item.amount ? ` ${money(item.amount)}` : "";
  const note = item.note ? ` · ${item.note}` : "";
  return `${item.type} ${actor}${target}${amount}${note}`.trim();
}

function sitPanel(table) {
  const disabled = !["waiting", "showdown"].includes(table.status);
  return `
    <div class="control-panel sit-control" data-control-mode="sit" data-control-key="${controlKey(table)}">
      <h2>入座</h2>
      <label>
        <span>带入筹码</span>
        <input data-buyin type="number" min="${table.bigBlind * 10}" step="${table.bigBlind}" value="${table.bigBlind * 50}" ${disabled ? "disabled" : ""} />
      </label>
      <button class="primary" data-join-table="${table.id}" ${disabled ? "disabled" : ""}>坐下</button>
    </div>
  `;
}

function actionPanel(controls, table) {
  const canAct = controls.canAct;
  const toCall = controls.toCall || 0;
  const raise = raiseCalculator(table);
  const canRaise = canAct && raise.max > table.currentBet;
  const turnName = turnPlayerName(table);
  const drawerOpen = canRaise && state.raiseDrawerOpen;
  const activeHand = ["preflop", "flop", "turn", "river"].includes(table.status);
  const countdown = countdownText(table);
  return `
    <div class="control-panel action-panel ${drawerOpen ? "raise-open" : ""} ${activeHand ? "" : "inactive-hand"}" data-control-mode="action" data-control-key="${controlKey(table)}" data-player-bet="${raise.playerBet}" data-current-bet="${table.currentBet || 0}">
      <div class="action-status">
        <span class="${canAct ? "live-dot" : ""}">${canAct ? "轮到你" : (turnName ? `${escapeHtml(turnName)} 行动` : stageLabel(table.status))}</span>
        <b>${toCall > 0 ? `需跟 ${money(toCall)}` : "可看牌"}</b>
        ${countdown ? `<strong class="turn-countdown" data-countdown-ring style="--turn-progress:${countdownPercent(table)}"><span data-countdown-label>${countdown}</span></strong>` : ""}
      </div>
      <div class="raise-drawer" aria-hidden="${drawerOpen ? "false" : "true"}">
        <div class="raise-total">
          <span>加注到</span>
          <strong data-raise-total>${money(raise.value)}</strong>
        </div>
        <div class="raise-presets">
          ${raise.presets.map((preset) => `<button class="ghost preset" data-raise-preset="${preset.value}" ${!canRaise ? "disabled" : ""}>${preset.label}</button>`).join("")}
        </div>
        <div class="raise-stepper">
          <button class="ghost" data-raise-step="-1" ${!canRaise ? "disabled" : ""}>-</button>
          <label>
            <span>金额</span>
            <input data-raise-amount data-player-bet="${raise.playerBet}" type="number" min="${raise.min}" max="${raise.max}" step="${raise.step}" value="${raise.value}" ${!canRaise ? "disabled" : ""} />
          </label>
          <button class="ghost" data-raise-step="1" ${!canRaise ? "disabled" : ""}>+</button>
        </div>
        <input class="raise-slider" data-raise-slider type="range" min="${raise.min}" max="${raise.max}" step="${raise.step}" value="${raise.value}" ${!canRaise ? "disabled" : ""} />
        <div class="raise-needed" data-raise-needed>需补 ${money(Math.max(0, raise.value - raise.playerBet))}</div>
        <button class="primary confirm-raise" data-action-move="raise" data-raise-submit ${!canRaise ? "disabled" : ""}>确认 ${money(raise.value)}</button>
      </div>
      <div class="action-bottom-bar">
        <button class="danger action-big" data-action-move="fold" ${!canAct ? "disabled" : ""}>弃牌</button>
        <button class="success action-big" data-action-move="${toCall > 0 ? "call" : "check"}" ${!canAct ? "disabled" : ""}>${toCall > 0 ? `跟注 ${money(toCall)}` : "看牌"}</button>
        <button class="primary action-big" data-action="toggle-raise" ${!canRaise ? "disabled" : ""}>${drawerOpen ? "收起加注" : "跟任意注"}</button>
        <button class="ghost action-big allin" data-action-move="allin" ${!canAct ? "disabled" : ""}>全下</button>
      </div>
    </div>
  `;
}

function avatarInitial(username) {
  return String(username || "P").trim().slice(0, 1).toUpperCase();
}

function avatarHue(username) {
  const text = String(username || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360;
  }
  return hash;
}

function controlKey(table) {
  const controls = table.controls || {};
  return [
    table.status,
    table.handNo || 0,
    table.currentTurnSeat ?? "",
    table.currentBet || 0,
    table.pot || 0,
    controls.canAct ? 1 : 0,
    controls.toCall || 0,
    controls.minRaiseTo || 0,
    controls.maxRaiseTo || 0,
    controls.actionDeadlineAt || table.actionDeadlineAt || "",
    table.youSeat ?? "",
    state.raiseDrawerOpen ? 1 : 0
  ].join("|");
}

function turnPlayerName(table) {
  const player = table.seats?.[table.currentTurnSeat];
  return player?.username || "";
}

function actionDeadline(table = state.table) {
  return table?.controls?.actionDeadlineAt || table?.actionDeadlineAt || "";
}

function countdownTable() {
  if (state.view === "table") return state.table;
  if (state.view === "blackjack") return state.blackjack.table;
  return null;
}

function remainingActionSeconds(table = state.table) {
  const deadline = new Date(actionDeadline(table)).getTime();
  if (!Number.isFinite(deadline)) return null;
  const serverNow = Date.now() + (state.serverClockOffset || 0);
  return Math.max(0, Math.ceil((deadline - serverNow) / 1000));
}

function countdownText(table = state.table) {
  const seconds = remainingActionSeconds(table);
  return seconds == null ? "" : `${seconds}s`;
}

function countdownPercent(table = state.table) {
  const seconds = remainingActionSeconds(table);
  const total = Math.max(1, Number(table?.controls?.actionTimeoutMs || table?.actionTimeoutMs || 20000) / 1000);
  return seconds == null ? 0 : Math.max(0, Math.min(1, seconds / total));
}

function raiseCalculator(table) {
  const controls = table.controls || {};
  const player = table.youSeat == null ? null : table.seats?.[table.youSeat];
  const playerBet = Number(player?.bet || 0);
  const step = Math.max(1, Number(table.bigBlind || 1));
  const rawMin = Number(controls.minRaiseTo || table.bigBlind || step);
  const rawMax = Number(controls.maxRaiseTo || rawMin);
  const min = Math.max(0, Math.min(rawMin, rawMax));
  const max = Math.max(min, rawMax);
  const toCall = Number(controls.toCall || 0);
  const potAfterCall = Number(table.pot || 0) + toCall;
  const halfPot = normalizeRaiseValue(table.currentBet + Math.max(step, Math.ceil(potAfterCall / 2)), min, max, step);
  const fullPot = normalizeRaiseValue(table.currentBet + Math.max(step, potAfterCall), min, max, step);
  const value = normalizeRaiseValue(min, min, max, step);
  const presets = [
    { label: "最小", value },
    { label: "半池", value: halfPot },
    { label: "底池", value: fullPot },
    { label: "全下", value: max }
  ];
  const uniquePresets = presets.filter((preset, index, list) => list.findIndex((item) => item.value === preset.value) === index);
  return { min, max, step, value, playerBet, presets: uniquePresets };
}

function normalizeRaiseValue(value, min, max, step) {
  const number = Number(value);
  const safeMin = Number(min) || 0;
  const safeMax = Math.max(safeMin, Number(max) || safeMin);
  const safeStep = Math.max(1, Number(step) || 1);
  const bounded = Math.max(safeMin, Math.min(safeMax, Number.isFinite(number) ? number : safeMin));
  return Math.max(safeMin, Math.min(safeMax, safeMin + Math.ceil((bounded - safeMin) / safeStep) * safeStep));
}

function audioAssetRowHtml(kind, key, label, asset = {}, options = {}) {
  const current = asset && typeof asset === "object" ? asset : {};
  const src = String(current.src || "");
  const isData = src.startsWith("data:");
  const volume = Math.max(0, Math.min(1, Number(current.volume ?? (kind === "bgm" ? 0.36 : 0.8))));
  const status = src ? (current.name || (isData ? "已上传音频" : nameFromAudioSource(src)) || "已设置") : "未设置";
  return `
    <div class="audio-row" data-audio-row data-audio-kind="${kind}" data-audio-key="${escapeAttr(key)}">
      <div class="audio-label">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(status)}</span>
      </div>
      <input type="hidden" data-audio-current-src value="${escapeAttr(src)}" />
      <input type="hidden" data-audio-current-name value="${escapeAttr(current.name || "")}" />
      <input data-audio-src type="text" placeholder="https://... 或 /audio/xxx.mp3" value="${escapeAttr(isData ? "" : src)}" />
      <input data-audio-name maxlength="80" placeholder="名称" value="${escapeAttr(current.name || "")}" />
      <input data-audio-file type="file" accept="audio/*" />
      <label class="audio-volume"><span>音量</span><input data-audio-volume type="range" min="0" max="1" step="0.05" value="${volume}" /></label>
      ${options.bgm ? `<label class="audio-check"><input data-audio-enabled type="checkbox" ${current.enabled && src ? "checked" : ""} />启用</label>` : ""}
      <label class="audio-check"><input data-audio-clear type="checkbox" />清空</label>
    </div>
  `;
}

function adminView() {
  const users = state.admin.users || [];
  const options = users.map((user) => `<option value="${user.id}">${escapeHtml(user.username)} · ${money(user.chips)}</option>`).join("");
  const botTables = (state.admin.tables || []).filter((table) => ["waiting", "showdown"].includes(table.status));
  const tableOptions = botTables.map((table) => `<option value="${table.id}">${escapeHtml(table.name)} · ${table.players}/${table.maxSeats} · ${stageLabel(table.status)}</option>`).join("");
  const rows = users.map((user) => `
    <tr>
      <td><strong>${escapeHtml(user.username)}</strong>${user.isBot ? ` <em class="bot-badge">AI</em>` : ""}</td>
      <td>${money(user.chips)}</td>
      <td class="password-cell">${user.password ? escapeHtml(user.password) : "旧账号未保存"}</td>
      <td>${user.isBot ? "机器人" : (user.isAdmin ? "管理员" : "玩家")}</td>
      <td class="table-actions">
        <button class="danger slim" data-delete-user="${user.id}" ${user.id === state.user?.id ? "disabled" : ""}>删除</button>
      </td>
    </tr>
  `).join("");
  const adminQuickMessages = Array.isArray(state.admin.quickMessages) && state.admin.quickMessages.length
    ? state.admin.quickMessages
    : TAUNT_MESSAGES;
  const audioSettings = normalizeClientAudioSettings(state.admin.audioSettings);
  const bgmAudioRow = audioAssetRowHtml("bgm", "bgm", "背景音乐", audioSettings.bgm, { bgm: true });
  const actionAudioRows = AUDIO_ACTIONS
    .map((item) => audioAssetRowHtml("action", item.key, item.label, audioSettings.actions?.[item.key]))
    .join("");
  const quickAudioRows = adminQuickMessages
    .map((message) => audioAssetRowHtml("quick", message, message, audioSettings.quickMessages?.[message]))
    .join("");
  const quickRows = adminQuickMessages.map((message) => `
    <span class="quick-message-chip">
      <b>${escapeHtml(message)}</b>
      <button type="button" data-delete-quick-message="${escapeAttr(message)}">删除</button>
    </span>
  `).join("");
  const audit = (state.admin.audit || []).map((item) => `<p>${escapeHtml(auditText(item))}</p>`).join("");

  return shell(`
    <main class="admin-layout">
      <section class="admin-card">
        <div class="section-title">
          <h1>管理员后台</h1>
          <button class="ghost" data-action="game-home">返回</button>
        </div>
        <h2>设置账户余额</h2>
        <form class="recharge-form" data-form="set-balance">
          <label>
            <span>用户</span>
            <select name="userId" ${options ? "" : "disabled"}>${options || `<option>暂无用户</option>`}</select>
          </label>
          <label>
            <span>余额</span>
            <input name="balance" type="number" min="0" step="100" value="5000" required />
          </label>
          <button class="primary" type="submit" ${options ? "" : "disabled"}>设置余额</button>
        </form>
      </section>
      <section class="admin-card">
        <h2>增减活动筹码</h2>
        <form class="recharge-form" data-form="recharge">
          <label>
            <span>用户</span>
            <select name="userId" ${options ? "" : "disabled"}>${options || `<option>暂无用户</option>`}</select>
          </label>
          <label>
            <span>金额</span>
            <input name="amount" type="number" step="100" value="1000" required />
          </label>
          <label>
            <span>备注</span>
            <input name="note" maxlength="80" placeholder="活动充值" />
          </label>
          <button class="primary" type="submit" ${options ? "" : "disabled"}>确认</button>
        </form>
      </section>
      <section class="admin-card">
        <h2>密码管理</h2>
        <form class="recharge-form" data-form="set-password">
          <label>
            <span>用户</span>
            <select name="userId" ${options ? "" : "disabled"}>${options || `<option>暂无用户</option>`}</select>
          </label>
          <label>
            <span>新密码</span>
            <input name="password" type="text" minlength="6" autocomplete="off" placeholder="至少 6 位" required />
          </label>
          <button class="primary" type="submit" ${options ? "" : "disabled"}>修改密码</button>
        </form>
      </section>
      <section class="admin-card">
        <h2>机器人陪玩</h2>
        <form class="recharge-form" data-form="add-bot">
          <label>
            <span>牌桌</span>
            <select name="tableId" ${tableOptions ? "" : "disabled"}>${tableOptions || `<option>暂无可加入牌桌</option>`}</select>
          </label>
          <label>
            <span>机器人名称</span>
            <input name="name" maxlength="18" placeholder="自动生成" />
          </label>
          <label>
            <span>带入筹码</span>
            <input name="buyIn" type="number" step="100" value="1000" required />
          </label>
          <button class="primary" type="submit" ${tableOptions ? "" : "disabled"}>添加机器人</button>
        </form>
      </section>
      <section class="admin-card wide-card">
        <h2>快捷用语</h2>
        <form class="quick-message-form" data-form="quick-message-add">
          <input name="message" maxlength="${CHAT_MAX_LENGTH}" autocomplete="off" placeholder="新增快捷语" required />
          <button class="primary slim" type="submit">添加</button>
        </form>
        <div class="quick-message-list">${quickRows}</div>
      </section>
      <section class="admin-card wide-card">
        <h2>音频设置</h2>
        <form class="audio-settings-form" data-form="audio-settings">
          <h3>BGM</h3>
          ${bgmAudioRow}
          <h3>玩家动作音效</h3>
          <div class="audio-grid">${actionAudioRows}</div>
          <h3>快捷语音效</h3>
          <div class="audio-grid">${quickAudioRows}</div>
          <button class="primary" type="submit">保存音频设置</button>
        </form>
      </section>
      <section class="admin-card wide-card">
        <h2>用户账户</h2>
        <table>
          <thead><tr><th>用户</th><th>钱包</th><th>密码</th><th>角色</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
      <section class="admin-card audit-card">
        <h2>审计</h2>
        <div class="logs">${audit || "<p>暂无记录</p>"}</div>
      </section>
    </main>
  `);
}

function render() {
  const previousAnimationTable = state.animationTable;
  if (!state.table?.controls?.canAct) state.raiseDrawerOpen = false;
  const nextTableId = state.view === "table" && state.table ? state.table.id : null;
  const blackjackTable = state.view === "blackjack" ? state.blackjack.table : null;
  const preserveScroll = Boolean(nextTableId && state.renderedTableId === nextTableId);
  const canPatchTable = Boolean(preserveScroll && $app.querySelector(".game-layout"));
  const lockedScroll = state.scrollLock && nextTableId === state.scrollLock.tableId ? state.scrollLock : null;
  const scrollX = lockedScroll ? lockedScroll.x : window.scrollX;
  const scrollY = lockedScroll ? lockedScroll.y : window.scrollY;

  if (!state.user) {
    $app.innerHTML = authView();
  } else if (state.view === "table") {
    if (canPatchTable) {
      patchTableView(state.table);
    } else {
      $app.innerHTML = tableView();
    }
  } else if (state.view === "slots") {
    $app.innerHTML = slotsView();
  } else if (state.view === "blackjack") {
    $app.innerHTML = blackjackView();
  } else if (state.view === "admin") {
    $app.innerHTML = adminView();
  } else if (state.view === "games") {
    $app.innerHTML = gamesView();
  } else {
    if ($app.querySelector(".lobby")) {
      patchLobbyView();
    } else {
      $app.innerHTML = lobbyView();
    }
  }
  state.renderedTableId = nextTableId;
  if (!nextTableId && !blackjackTable) clearTableEffects();
  if (nextTableId) syncRaiseControls($app);
  syncActionCountdown();
  if (preserveScroll || lockedScroll) restoreScrollPosition(scrollX, scrollY);
  if (lockedScroll) state.scrollLock = null;
  scheduleTableAnimations(previousAnimationTable, state.view === "table" ? state.table : null);
  syncTableAudio(previousAnimationTable, state.view === "table" ? state.table : blackjackTable);
  state.animationTable = snapshotTable(state.view === "table" ? state.table : null);
  syncPollingSubscription();
  syncPresenceSubscription();
}

function patchLobbyView() {
  syncShellChrome();
  const list = $app.querySelector(".tables-list");
  if (!list) {
    $app.innerHTML = lobbyView();
    return;
  }

  const nextIds = new Set(state.tables.map((table) => String(table.id)));
  for (const table of state.tables) {
    let row = list.querySelector(`[data-table-row="${table.id}"]`);
    if (!row) {
      const empty = list.querySelector(".empty-state");
      if (empty) empty.remove();
      list.insertAdjacentHTML("beforeend", lobbyTableRowHtml(table));
      row = list.querySelector(`[data-table-row="${table.id}"]`);
    }
    if (!row) continue;
    const name = row.querySelector("[data-table-row-name]");
    if (name && name.textContent !== table.name) name.textContent = table.name;
    const meta = row.querySelector("[data-table-row-meta]");
    const metaText = lobbyTableMeta(table);
    if (meta && meta.textContent !== metaText) meta.textContent = metaText;
    setInnerHtml(row.querySelector("[data-table-row-pot]"), chipStackHtml(table.pot || table.bigBlind * 10, true));
    const button = row.querySelector("[data-open-table]");
    if (button) button.dataset.openTable = table.id;
  }

  for (const row of list.querySelectorAll("[data-table-row]")) {
    if (!nextIds.has(row.dataset.tableRow)) row.remove();
  }
  if (!state.tables.length && !list.querySelector(".empty-state")) {
    list.innerHTML = `<div class="empty-state">暂无牌桌</div>`;
  }
  syncOnlinePanel();
}

function patchTableView(table) {
  syncShellChrome();
  const root = $app.querySelector(".game-layout");
  if (!root || root.dataset.tableId !== table.id || Number(root.dataset.maxSeats) !== (table.maxSeats || 9)) {
    $app.innerHTML = tableView();
    return;
  }

  const title = root.querySelector("[data-table-title]");
  if (title) title.textContent = table.name;
  const meta = root.querySelector("[data-table-meta]");
  if (meta) meta.textContent = tableMetaText(table);
  syncPingBadge(root);
  root.className = tableLayoutClass(table);
  patchToolbarActions(root, table);

  const felt = root.querySelector(".felt-table");
  if (felt) felt.className = `felt-table seats-${table.maxSeats || 9}`;
  patchBoard(root, table);
  setInnerHtml(root.querySelector(".pot"), potHtml(table));
  syncShowdownOverlay(root, table);

  for (const entry of seatEntries(table)) {
    patchSeat(root, entry, table);
  }

  const panel = root.querySelector(".control-panel");
  const nextPanel = table.youSeat != null ? actionPanel(table.controls || {}, table) : sitPanel(table);
  const nextMode = table.youSeat != null ? "action" : "sit";
  const nextKey = controlKey(table);
  if (!panel || panel.dataset.controlMode !== nextMode) {
    if (panel) panel.outerHTML = nextPanel;
  } else if (panel.dataset.controlKey !== nextKey) {
    panel.outerHTML = nextPanel;
  }
  syncRaiseControls(root);
  syncTauntPanel(root, table);
  syncRulesDrawer(root);
  syncActionCountdown();
  setInnerHtml(root.querySelector(".logs"), logsHtml(table));
}

function patchToolbarActions(root, table) {
  const toolbar = root.querySelector(".toolbar-actions");
  if (!toolbar) return;
  if (!toolbar.querySelector('[data-action="start-hand"]')) {
    setInnerHtml(toolbar, toolbarActionsHtml(table));
    return;
  }

  const isSeated = table.youSeat != null;
  const canStart = isSeated && ["waiting", "showdown"].includes(table.status);
  const canLeave = Boolean(table.controls?.canLeave);
  const canDisband = Boolean(table.controls?.canDisband);
  const activeHand = Boolean(table.controls?.activeHand);

  const bgm = toolbar.querySelector('[data-action="toggle-bgm"]');
  if (bgm) {
    bgm.classList.toggle("active", state.bgmEnabled);
    bgm.textContent = state.bgmEnabled ? "音乐开" : "静音";
  }

  const rules = toolbar.querySelector('[data-action="toggle-rules"]');
  if (rules) {
    rules.classList.toggle("active", state.rulesOpen);
    rules.setAttribute("aria-expanded", state.rulesOpen ? "true" : "false");
  }

  const start = toolbar.querySelector('[data-action="start-hand"]');
  if (start) start.disabled = !canStart;

  const leave = toolbar.querySelector('[data-action="leave-table"]');
  if (leave) {
    leave.disabled = !canLeave;
    leave.textContent = activeHand ? "弃牌离桌" : "离桌";
  }

  const disband = toolbar.querySelector('[data-action="disband-table"]');
  if (disband) disband.disabled = !canDisband;
}

function syncTauntPanel(root, table) {
  const existing = root.querySelector(".taunt-panel");
  const next = table.youSeat != null ? tauntPanelHtml().trim() : "";
  if (!next) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.classList.toggle("open", state.chatOpen);
    const shortcut = existing.querySelector(".chat-shortcut");
    if (shortcut) shortcut.setAttribute("aria-expanded", state.chatOpen ? "true" : "false");
    const presets = existing.querySelector(".chat-presets");
    if (presets) {
      presets.setAttribute("aria-hidden", state.chatOpen ? "false" : "true");
      setInnerHtml(presets, quickMessages().map((message) => `<button type="button" data-taunt-message="${escapeAttr(message)}">${escapeHtml(message)}</button>`).join(""));
    }
    setInnerHtml(existing.querySelector("[data-chat-screen]"), chatHistoryHtml(table));
    requestAnimationFrame(() => scrollChatScreen(existing));
    return;
  }
  const sidePanel = root.querySelector(".side-panel");
  if (!sidePanel) return;
  const logPanel = sidePanel.querySelector(".log-panel");
  if (logPanel) {
    logPanel.insertAdjacentHTML("beforebegin", next);
  } else {
    sidePanel.insertAdjacentHTML("beforeend", next);
  }
  requestAnimationFrame(() => scrollChatScreen(sidePanel));
}

function scrollChatScreen(root = document) {
  const screen = root.querySelector?.("[data-chat-screen]");
  if (screen) screen.scrollTop = screen.scrollHeight;
}

function syncRulesDrawer(root = document) {
  const drawer = root.querySelector?.("[data-rules-drawer]");
  if (!drawer) return;
  drawer.classList.toggle("open", state.rulesOpen);
  drawer.setAttribute("aria-hidden", state.rulesOpen ? "false" : "true");
}

function syncShowdownOverlay(root, table) {
  const next = showdownOverlayHtml(table);
  const existing = root.querySelector("[data-showdown-overlay]");
  if (existing) {
    if (existing.outerHTML !== next.trim()) existing.outerHTML = next;
  } else {
    root.insertAdjacentHTML("beforeend", next);
  }
}

function hideShowdownOverlay(root = document) {
  const overlay = root.querySelector("[data-showdown-overlay]");
  if (!overlay) return;
  overlay.classList.remove("visible");
  overlay.setAttribute("aria-hidden", "true");
}

function syncActionCountdown() {
  const table = countdownTable();
  const deadline = actionDeadline(table);
  const isActive = Boolean(table?.controls?.activeHand && deadline);
  if (!isActive) {
    stopCountdownTimer();
    state.timeoutPollDeadline = "";
    return;
  }

  updateActionCountdown();
  if (!state.countdownTimer) {
    state.countdownTimer = window.setInterval(updateActionCountdown, 250);
  }
}

function stopCountdownTimer() {
  if (state.countdownTimer) window.clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

function updateActionCountdown() {
  const table = countdownTable();
  if (!table) {
    stopCountdownTimer();
    return;
  }

  const deadline = actionDeadline(table);
  if (!deadline) {
    stopCountdownTimer();
    return;
  }

  const label = countdownText(table);
  const progress = countdownPercent(table);
  document.querySelectorAll("[data-countdown-label], [data-seat-timer]").forEach((element) => {
    element.textContent = label;
  });
  document.querySelectorAll("[data-countdown-ring], .seat.turn .avatar-ring, .seat.turn .seat-timer, .blackjack-player-seat.turn .avatar-ring").forEach((element) => {
    element.style.setProperty("--turn-progress", String(progress));
    element.classList.toggle("danger-time", remainingActionSeconds(table) !== null && remainingActionSeconds(table) <= 5);
  });

  if (remainingActionSeconds(table) === 0 && state.timeoutPollDeadline !== deadline && !state.busy) {
    state.timeoutPollDeadline = deadline;
    const refresh = state.view === "blackjack" ? refreshBlackjackTable : refreshTable;
    refresh(false).then((changed) => {
      if (changed) render();
    });
  }
}

function patchBoard(root, table) {
  boardCards(table).forEach((card, index) => {
    const slot = root.querySelector(`[data-board-card="${index}"]`);
    if (!slot) return;
    const value = card || "";
    slot.classList.toggle("filled", Boolean(card));
    slot.classList.toggle("empty", !card);
    if (slot.dataset.cardValue !== value) {
      slot.dataset.cardValue = value;
      slot.innerHTML = communityCardHtml(card);
    }
  });
}

function patchSeat(root, entry, table) {
  const seat = root.querySelector(`[data-seat="${entry.actualSeat}"]`);
  if (!seat) return;
  const nextClass = seatClassName(entry, table);
  if (seat.className !== nextClass) seat.className = nextClass;
  const nextStyle = seatStyle(entry, table);
  if ((seat.getAttribute("style") || "") !== nextStyle) {
    if (nextStyle) seat.setAttribute("style", nextStyle);
    else seat.removeAttribute("style");
  }
  if (seat.dataset.displaySeat !== String(entry.displaySeat)) {
    seat.dataset.displaySeat = String(entry.displaySeat);
  }
  const nextContent = seatContentHtml(entry, table).trim();
  if (seat.innerHTML.trim() !== nextContent) seat.innerHTML = nextContent;
}

function snapshotTable(table) {
  if (!table) return null;
  return JSON.parse(JSON.stringify({
    id: table.id,
    status: table.status,
    handNo: table.handNo || 0,
    revision: table.revision || 0,
    pot: table.pot || 0,
    currentTurnSeat: table.currentTurnSeat,
    community: table.community || [],
    winners: table.winners || [],
    seats: (table.seats || []).map((player) => player ? {
      seat: player.seat,
      userId: player.userId,
      username: player.username,
      bet: player.bet || 0,
      contributed: player.contributed || 0,
      stack: player.stack || 0,
      inHand: Boolean(player.inHand),
      folded: Boolean(player.folded),
      allIn: Boolean(player.allIn),
      lastAction: player.lastAction || "",
      holeCount: (player.hole || []).length
    } : null)
  }));
}

function scheduleTableAnimations(previous, next) {
  if (!next) return;
  window.requestAnimationFrame(() => runTableAnimations(previous, next));
}

function runTableAnimations(previous, next) {
  const root = document.querySelector(".game-layout");
  if (!root || !next || !previous || previous.id !== next.id) return;
  if (Number(next.revision || 0) <= Number(previous.revision || 0)) return;

  const handStarted = Number(next.handNo || 0) > Number(previous.handNo || 0);
  if (handStarted && next.controls?.activeHand) {
    animateHandStart(root, next);
  }

  animateNewBoardCards(root, previous, next);
  animateBetChanges(root, previous, next);
  animateTurnChange(root, previous, next);
  animateShowdown(root, previous, next);
}

function animateHandStart(root, table) {
  addTransientClass(root.querySelector(".felt-table"), "hand-start-flash", 900);
  (table.seats || []).forEach((player) => {
    if (!player || !player.inHand) return;
    const target = root.querySelector(`[data-seat="${player.seat}"] .hole-cards`) || root.querySelector(`[data-seat="${player.seat}"]`);
    if (!target) return;
    animateFlyingCard(root, target, { delay: 80 + player.seat * 90, small: player.seat !== table.youSeat });
    animateFlyingCard(root, target, { delay: 210 + player.seat * 90, small: player.seat !== table.youSeat });
  });
}

function animateNewBoardCards(root, previous, table) {
  const oldCards = previous.community || [];
  const newCards = table.community || [];
  newCards.forEach((card, index) => {
    if (!card || oldCards[index] === card) return;
    const slot = root.querySelector(`[data-board-card="${index}"]`);
    if (!slot) return;
    addTransientClass(slot, "board-card-reveal", 760);
    const cardElement = slot.querySelector(".card");
    addTransientClass(cardElement, "card-just-revealed", 760);
    animateFlyingCard(root, slot, { delay: index * 70, face: true });
  });
}

function animateBetChanges(root, previous, table) {
  (table.seats || []).forEach((player, index) => {
    if (!player) return;
    const oldPlayer = (previous.seats || [])[index];
    if (!oldPlayer || oldPlayer.userId !== player.userId) return;
    const contributedDelta = Number(player.contributed || 0) - Number(oldPlayer.contributed || 0);
    const betDelta = Number(player.bet || 0) - Number(oldPlayer.bet || 0);
    const amount = Math.max(contributedDelta, betDelta, 0);
    if (amount <= 0) return;
    const seat = root.querySelector(`[data-seat="${player.seat}"]`);
    const pot = root.querySelector(".pot");
    if (!seat || !pot) return;
    animateChipFlight(seat, pot, amount);
    addTransientClass(seat.querySelector(".seat-bet"), "bet-pop", 720);
    addTransientClass(pot, "pot-pop", 720);
  });

  if (Number(table.pot || 0) !== Number(previous.pot || 0)) {
    addTransientClass(root.querySelector(".pot"), "pot-pop", 720);
  }
}

function animateTurnChange(root, previous, table) {
  if (previous.currentTurnSeat === table.currentTurnSeat || table.currentTurnSeat == null) return;
  const seat = root.querySelector(`[data-seat="${table.currentTurnSeat}"]`);
  addTransientClass(seat, "turn-change", 900);
  const status = root.querySelector(".action-status");
  addTransientClass(status, "action-status-pop", 720);
}

function animateShowdown(root, previous, table) {
  const becameShowdown = previous.status !== "showdown" && table.status === "showdown";
  const newWinnerText = (table.winners || []).map((winner) => `${winner.userId}:${winner.amount}`).join("|");
  const oldWinnerText = (previous.winners || []).map((winner) => `${winner.userId}:${winner.amount}`).join("|");
  if (!becameShowdown && newWinnerText === oldWinnerText) return;

  addTransientClass(root.querySelector(".felt-table"), "showdown-flash", 1200);

  const pot = root.querySelector(".pot");
  const fallbackTarget = root.querySelector(".showdown-card") || root.querySelector(".felt-table");
  for (const winner of table.winners || []) {
    const seat = (table.seats || []).find((player) => player && player.userId === winner.userId);
    const target = seat ? root.querySelector(`[data-seat="${seat.seat}"]`) : fallbackTarget;
    if (pot && target) animateChipFlight(pot, target, winner.amount || 0, { reverse: true, count: 5 });
  }
}

function animateFlyingCard(root, target, options = {}) {
  const source = root.querySelector(".table-toolbar") || root.querySelector(".felt-table");
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const width = options.small ? 34 : 58;
  const height = width * 1.42;
  const endX = targetRect.left + targetRect.width / 2 - width / 2;
  const endY = targetRect.top + targetRect.height / 2 - height / 2;
  const startX = sourceRect.left + sourceRect.width / 2 - width / 2;
  const startY = sourceRect.top + sourceRect.height / 2 - height / 2;
  const card = document.createElement("div");
  card.className = `fx-card-flight ${options.face ? "face-up" : "card-back"}`;
  card.style.left = `${endX}px`;
  card.style.top = `${endY}px`;
  card.style.width = `${width}px`;
  card.style.height = `${height}px`;
  card.style.setProperty("--from-x", `${startX - endX}px`);
  card.style.setProperty("--from-y", `${startY - endY}px`);
  card.style.animationDelay = `${options.delay || 0}ms`;
  card.innerHTML = `<span></span>`;
  document.body.appendChild(card);
  removeAfterAnimation(card, 900 + (options.delay || 0));
}

function animateChipFlight(fromElement, toElement, amount, options = {}) {
  const fromRect = fromElement.getBoundingClientRect();
  const toRect = toElement.getBoundingClientRect();
  const count = options.count || Math.min(5, Math.max(2, Math.ceil(Math.log10(Math.max(10, amount)))));
  const denom = chipBreakdown(amount || 1, 1)[0] || 1;

  for (let index = 0; index < count; index += 1) {
    const size = 30 + Math.min(8, index * 2);
    const fromX = fromRect.left + fromRect.width / 2 - size / 2;
    const fromY = fromRect.top + fromRect.height / 2 - size / 2;
    const toX = toRect.left + toRect.width / 2 - size / 2 + (index - count / 2) * 6;
    const toY = toRect.top + toRect.height / 2 - size / 2 + (index % 2 ? 6 : -5);
    const chip = document.createElement("div");
    chip.className = `fx-chip-flight chip-${denom}`;
    chip.style.left = `${toX}px`;
    chip.style.top = `${toY}px`;
    chip.style.width = `${size}px`;
    chip.style.height = `${size}px`;
    chip.style.setProperty("--from-x", `${fromX - toX}px`);
    chip.style.setProperty("--from-y", `${fromY - toY}px`);
    chip.style.animationDelay = `${(options.delay || 0) + index * 52}ms`;
    chip.innerHTML = `<i>${chipLabel(denom)}</i>`;
    document.body.appendChild(chip);
    removeAfterAnimation(chip, 980 + (options.delay || 0) + index * 52);
  }
}

function addTransientClass(element, className, duration = 700) {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  window.setTimeout(() => element.classList.remove(className), duration);
}

function removeAfterAnimation(element, duration) {
  window.setTimeout(() => element.remove(), duration);
}

function clearTableEffects() {
  document.querySelectorAll(".fx-card-flight, .fx-chip-flight").forEach((element) => element.remove());
  pauseBgm();
}

function syncTableAudio(previous, table) {
  if (!table) {
    pauseBgm();
    return;
  }

  syncBgm(table);
  const events = Array.isArray(table.audioEvents) ? table.audioEvents : [];
  const maxSeq = events.reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0);
  const lastSeq = state.audioLastSeqByTable[table.id];
  if (lastSeq == null || !previous || previous.id !== table.id) {
    state.audioLastSeqByTable[table.id] = maxSeq;
    return;
  }

  for (const event of events) {
    if (Number(event.seq || 0) > lastSeq) playTableAudioEvent(table, event);
  }
  state.audioLastSeqByTable[table.id] = maxSeq;
}

function playTableAudioEvent(table, event) {
  const settings = normalizeClientAudioSettings(table.audioSettings);
  const asset = event.type === "quickMessage"
    ? settings.quickMessages?.[event.message]
    : settings.actions?.[event.type];
  playAudioAsset(asset);
}

function playAudioAsset(asset) {
  if (!asset?.src) return;
  try {
    const audio = new Audio(asset.src);
    audio.volume = Math.max(0, Math.min(1, Number(asset.volume ?? 0.8)));
    audio.play().catch(() => {});
  } catch {
    // Ignore unsupported or blocked audio; gameplay should never depend on sound.
  }
}

function currentAudioTable() {
  return state.view === "blackjack" ? state.blackjack.table : state.table;
}

function syncBgm(table = currentAudioTable()) {
  const bgm = normalizeClientAudioSettings(table?.audioSettings).bgm;
  if (!state.bgmEnabled || !bgm.enabled || !bgm.src) {
    pauseBgm();
    return;
  }

  if (!bgmAudio || bgmAudioSrc !== bgm.src) {
    pauseBgm();
    bgmAudio = new Audio(bgm.src);
    bgmAudio.loop = true;
    bgmAudioSrc = bgm.src;
  }
  bgmAudio.volume = Math.max(0, Math.min(1, Number(bgm.volume ?? 0.36)));
  bgmAudio.play().catch(() => {});
}

function pauseBgm() {
  if (bgmAudio) bgmAudio.pause();
}

function toggleBgm() {
  state.bgmEnabled = !state.bgmEnabled;
  localStorage.setItem(BGM_ENABLED_KEY, state.bgmEnabled ? "1" : "0");
  if (state.bgmEnabled) syncBgm();
  else pauseBgm();
  render();
}

function syncShellChrome() {
  const wallet = $app.querySelector(".wallet");
  if (wallet && state.user) {
    setInnerHtml(wallet, `${chipStackHtml(state.user.chips, true)}<span>${escapeHtml(state.user.username)}</span>`);
  }
  syncToast();
}

function syncToast() {
  const shellElement = $app.querySelector(".app-shell");
  if (!shellElement) return;
  const existing = shellElement.querySelector(".toast");
  if (!state.message) {
    if (existing) existing.remove();
    return;
  }
  const html = escapeHtml(state.message);
  if (existing) {
    if (existing.innerHTML !== html) existing.innerHTML = html;
  } else {
    shellElement.insertAdjacentHTML("beforeend", `<div class="toast">${html}</div>`);
  }
}

function syncPingBadge(root = document) {
  const badge = root.querySelector("[data-ping-badge]");
  if (!badge) return;
  const quality = pingQuality();
  badge.className = `ping-badge ${quality}`;
  const label = badge.querySelector("[data-ping-label]");
  if (label) label.textContent = pingText();
}

function setInnerHtml(element, html) {
  if (element && element.innerHTML !== html) element.innerHTML = html;
}

function setRaiseAmount(value, commit = true) {
  const input = document.querySelector("[data-raise-amount]");
  if (!input) return 0;
  const min = Number(input.min || 0);
  const max = Number(input.max || min);
  const step = Number(input.step || 1);
  const next = normalizeRaiseValue(value, min, max, step);
  input.value = String(next);
  const slider = document.querySelector("[data-raise-slider]");
  if (slider) slider.value = String(next);
  syncRaiseControls(document);
  if (commit) input.dispatchEvent(new Event("change", { bubbles: true }));
  return next;
}

function syncRaiseControls(scope = document) {
  const root = scope.querySelector ? scope : document;
  const input = root.querySelector("[data-raise-amount]");
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || min);
  const step = Number(input.step || 1);
  const value = normalizeRaiseValue(input.value, min, max, step);
  const slider = root.querySelector("[data-raise-slider]");
  if (slider && document.activeElement !== slider) slider.value = String(value);
  const playerBet = Number(input.dataset.playerBet || 0);
  const needed = Math.max(0, value - playerBet);
  const neededLabel = root.querySelector("[data-raise-needed]");
  if (neededLabel) neededLabel.textContent = `需补 ${money(needed)}`;
  const total = root.querySelector("[data-raise-total]");
  if (total) total.textContent = money(value);
  const submit = root.querySelector("[data-raise-submit]");
  if (submit) submit.textContent = submit.classList.contains("confirm-raise") ? `确认 ${money(value)}` : `加注到 ${money(value)}`;
}

function commitRaiseInput() {
  const input = document.querySelector("[data-raise-amount]");
  if (!input) return 0;
  return setRaiseAmount(input.value, false);
}

function restoreScrollPosition(scrollX, scrollY) {
  window.scrollTo(scrollX, scrollY);
  const defer = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (callback) => window.setTimeout(callback, 0);
  defer(() => window.scrollTo(scrollX, scrollY));
  defer(() => defer(() => window.scrollTo(scrollX, scrollY)));
  window.setTimeout(() => window.scrollTo(scrollX, scrollY), 60);
  window.setTimeout(() => window.scrollTo(scrollX, scrollY), 180);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === "auth") submitAuth(form);
  if (form.dataset.form === "create-table") createTable(form);
  if (form.dataset.form === "recharge") recharge(form);
  if (form.dataset.form === "set-balance") setBalance(form);
  if (form.dataset.form === "set-password") setAdminPassword(form);
  if (form.dataset.form === "add-bot") addBot(form);
  if (form.dataset.form === "quick-message-add") addQuickMessage(form);
  if (form.dataset.form === "audio-settings") saveAudioSettings(form);
  if (form.dataset.form === "chat-message") submitChatMessage(form);
  if (form.dataset.form === "slot-spin") spinSlots(form);
  if (form.dataset.form === "blackjack-create-table") createBlackjackTable(form);
  if (form.dataset.form === "blackjack-start-round") startBlackjackRound(form);
});

document.addEventListener("pointerdown", (event) => {
  markPointerActive();
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.actionMove || target.dataset.action === "start-hand") {
    lockTableScroll();
  }
}, true);

document.addEventListener("pointerup", releasePointerActive, true);
document.addEventListener("pointercancel", releasePointerActive, true);
document.addEventListener("blur", releasePointerActive, true);

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.raiseSlider !== undefined) {
    setRaiseAmount(target.value, false);
  }
  if (target.dataset.raiseAmount !== undefined) {
    syncRaiseControls(document);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.dataset.raiseAmount !== undefined) {
    commitRaiseInput();
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.auth) {
    state.authMode = target.dataset.auth;
    render();
    return;
  }

  if (target.dataset.openTable) {
    await openTable(target.dataset.openTable);
    return;
  }

  if (target.dataset.joinTable) {
    await joinTable(target.dataset.joinTable);
    return;
  }

  if (target.dataset.openBlackjackTable) {
    await openBlackjackTable(target.dataset.openBlackjackTable);
    return;
  }

  if (target.dataset.joinBlackjackTable) {
    await joinBlackjackTable(target.dataset.joinBlackjackTable);
    return;
  }

  if (target.dataset.joinBlackjackSeat) {
    await joinBlackjackTable(state.blackjack.table.id, Number(target.dataset.joinBlackjackSeat));
    return;
  }

  if (target.dataset.joinSeat) {
    await joinTable(state.table.id, Number(target.dataset.joinSeat));
    return;
  }

  if (target.dataset.tauntMessage) {
    await sendChatMessage(target.dataset.tauntMessage, { closePresets: true });
    return;
  }

  if (target.dataset.deleteUser) {
    await deleteAdminUser(target.dataset.deleteUser);
    return;
  }

  if (target.dataset.deleteQuickMessage) {
    await deleteQuickMessage(target.dataset.deleteQuickMessage);
    return;
  }

  if (target.dataset.slotBet) {
    const input = document.querySelector("[data-slot-bet-input]");
    if (input) input.value = target.dataset.slotBet;
    state.slot.bet = Number(target.dataset.slotBet);
    return;
  }

  if (target.dataset.blackjackBet) {
    const input = document.querySelector("[data-blackjack-bet-input]");
    if (input) input.value = target.dataset.blackjackBet;
    state.blackjack.bet = Number(target.dataset.blackjackBet);
    return;
  }

  if (target.dataset.blackjackAction) {
    await blackjackAction(target.dataset.blackjackAction);
    return;
  }

  if (target.dataset.raisePreset) {
    setRaiseAmount(Number(target.dataset.raisePreset));
    return;
  }

  if (target.dataset.raiseStep) {
    const input = document.querySelector("[data-raise-amount]");
    const step = Number(input?.step || state.table?.bigBlind || 1);
    setRaiseAmount(Number(input?.value || 0) + Number(target.dataset.raiseStep) * step);
    return;
  }

  if (target.dataset.actionMove) {
    const move = target.dataset.actionMove;
    const amount = move === "raise" ? commitRaiseInput() : null;
    state.raiseDrawerOpen = false;
    await playerAction(move, amount);
    return;
  }

  const action = target.dataset.action;
  if (action === "logout") logout();
  if (action === "game-home" || action === "lobby") {
    state.view = "games";
    state.table = null;
    state.blackjack.table = null;
    state.rulesOpen = false;
    state.chatOpen = false;
    stopPolling();
    render();
    return;
  }
  if (action === "poker-lobby" || action === "back-lobby") {
    await openPokerLobby();
    return;
  }
  if (action === "refresh-lobby") await loadLobby();
  if (action === "slots") await openSlots();
  if (action === "blackjack") await openBlackjack();
  if (action === "blackjack-lobby") {
    state.blackjack.table = null;
    state.view = "blackjack";
    state.rulesOpen = false;
    await loadBlackjackLobby(true);
    startPolling(700);
    render();
  }
  if (action === "admin") await loadAdmin();
  if (action === "start-hand") await startHand();
  if (action === "leave-table") await leaveTable();
  if (action === "disband-table") await disbandTable();
  if (action === "blackjack-leave") await leaveBlackjackTable();
  if (action === "blackjack-disband") await disbandBlackjackTable();
  if (action === "toggle-bgm") toggleBgm();
  if (action === "toggle-rules") {
    state.rulesOpen = !state.rulesOpen;
    render();
  }
  if (action === "toggle-chat") {
    state.chatOpen = !state.chatOpen;
    render();
    if (state.chatOpen) requestAnimationFrame(() => scrollChatScreen());
  }
  if (action === "toggle-raise") {
    state.raiseDrawerOpen = !state.raiseDrawerOpen;
    render();
  }
});

bootstrap();
