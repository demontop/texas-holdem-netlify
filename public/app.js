const API_BASE = "/api";
const STORAGE_KEY = "holdem_token";
const CLIENT_KEY = "holdem_client_id";

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  clientId: getClientId(),
  commandSeq: 0,
  user: null,
  tables: [],
  table: null,
  view: "auth",
  authMode: "login",
  message: "",
  busy: false,
  poller: null,
  polling: false,
  tableRequestSeq: 0,
  renderedTableId: null,
  animationTable: null,
  scrollLock: null,
  raiseDrawerOpen: false,
  admin: { users: [], tables: [], audit: [] }
};

const $app = document.querySelector("#app");

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
  return Number(value || 0).toLocaleString("zh-CN");
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
      <span class="small-center">${meta.suit}</span>
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
      <span class="face-body">${meta.rawRank}</span>
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
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    cache: "no-store",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
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
  if (payload.user) {
    state.user = payload.user;
    changed = true;
  }
  if (payload.table) {
    state.table = payload.table;
    if (state.view !== "table") state.view = "table";
    changed = true;
  }
  return changed;
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
  state.view = "auth";
  localStorage.removeItem(STORAGE_KEY);
  stopPolling();
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
    state.view = "lobby";
    await loadLobby();
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
    state.view = "lobby";
    await loadLobby();
  });
}

async function loadLobby(silent = false) {
  try {
    const result = await api("/lobby");
    state.user = result.user;
    state.tables = result.tables;
    if (!state.table) state.view = "lobby";
    if (!silent) render();
  } catch (error) {
    if (!silent) setMessage(error.message);
  }
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
    state.table = result.table;
    state.view = "table";
    startPolling();
  });
}

async function openTable(tableId) {
  await runBusy(async () => {
    const result = await api(`/tables/${tableId}`);
    state.user = result.user;
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
    stopPolling();
    await loadLobby(true);
  });
}

async function startHand() {
  if (!state.table) return;
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/start`, {
      method: "POST",
      body: { commandId: nextCommandId("start"), tableRevision: state.table.revision || 0 }
    });
    state.table = result.table;
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
    state.table = result.table;
  });
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

function startPolling() {
  stopPolling();
  schedulePoll(250);
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
    if (state.table.controls?.canAct) return 1200;
    if (["preflop", "flop", "turn", "river"].includes(state.table.status)) return 750;
    return 1600;
  }
  if (state.view === "lobby") return 3000;
  return 5000;
}

function stopPolling() {
  stopPollTimer();
  state.polling = false;
}

function stopPollTimer() {
  if (state.poller) window.clearTimeout(state.poller);
  state.poller = null;
}

async function loadAdmin() {
  await runBusy(async () => {
    const result = await api("/admin/users");
    state.admin = result;
    state.view = "admin";
  });
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
    state.admin = await api("/admin/users");
    if (state.user && result.user.id === state.user.id) state.user = result.user;
    setMessage(`${result.user.username} 当前钱包 ${money(result.user.chips)}`);
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
    state.admin = {
      users: result.users,
      tables: result.tables,
      audit: result.audit
    };
    if (state.table && result.table && state.table.id === result.table.id) {
      await refreshTable(true);
    }
    setMessage(`${result.bot.username} 已加入 ${result.table.name}`);
  });
}

function shell(content) {
  const user = state.user;
  const shellClass = `app-shell ${state.view === "table" ? "table-shell" : ""}`.trim();
  return `
    <div class="${shellClass}">
      <header class="topbar">
        <button class="brand" data-action="lobby" ${!user ? "disabled" : ""}>
          <span class="brand-mark">TH</span>
          <span>德州扑克桌</span>
        </button>
        <div class="top-actions">
          ${user ? `<span class="wallet">${chipStackHtml(user.chips, true)}<span>${user.username}</span></span>` : ""}
          ${user?.isAdmin ? `<button class="icon-text" data-action="admin">后台</button>` : ""}
          ${user ? `<button class="ghost" data-action="logout">退出</button>` : ""}
        </div>
      </header>
      ${content}
      ${state.message ? `<div class="toast">${state.message}</div>` : ""}
    </div>
  `;
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
          <button class="primary" type="submit">${state.authMode === "register" ? "创建账号" : "进入牌局"}</button>
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
  const tables = state.tables.map((table) => `
    <article class="table-row">
      <div>
        <h3>${escapeHtml(table.name)}</h3>
        <p>${stageLabel(table.status)} · ${table.players}/${table.maxSeats} 人 · ${table.smallBlind}/${table.bigBlind}</p>
      </div>
      <div class="row-pot">${chipStackHtml(table.pot || table.bigBlind * 10, true)}</div>
      <button class="primary slim" data-open-table="${table.id}">进桌</button>
    </article>
  `).join("");

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
              <option value="6">6 人桌</option>
              <option value="5">5 人桌</option>
              <option value="4">4 人桌</option>
              <option value="3">3 人桌</option>
              <option value="2">单挑桌</option>
            </select>
          </label>
          <button class="primary" type="submit">创建</button>
        </form>
      </aside>
    </main>
  `);
}

function tableView() {
  const table = state.table;
  if (!table) return lobbyView();
  const seatCount = table.maxSeats || 6;
  const seats = seatEntries(table);
  const winnersText = winnerText(table);
  const isSeated = table.youSeat != null;
  const controls = table.controls || {};

  return shell(`
    <main class="game-layout" data-table-id="${table.id}" data-max-seats="${seatCount}">
      <div class="casino-room" aria-hidden="true">
        <span class="room-column column-left"></span>
        <span class="room-column column-right"></span>
      </div>
      <section class="table-toolbar">
        <button class="ghost" data-action="back-lobby">大厅</button>
        <div class="table-title">
          <strong data-table-title>${escapeHtml(table.name)}</strong>
          <span data-table-meta>${tableMetaText(table)}</span>
        </div>
        <div class="toolbar-actions">${toolbarActionsHtml(table)}</div>
      </section>
      <section class="poker-room">
        <div class="felt-table seats-${seatCount}">
          <div class="rail"></div>
          <div class="table-center">
            <div class="board">${boardHtml(table)}</div>
            <div class="pot">${potHtml(table)}</div>
            <div class="winner-strip ${winnersText ? "" : "empty"}" ${winnersText ? "" : `aria-hidden="true"`}>${winnersText || "等待结算"}</div>
          </div>
          ${seats.map((entry) => seatHtml(entry, table)).join("")}
        </div>
      </section>
      <aside class="side-panel">
        ${isSeated ? actionPanel(controls, table) : sitPanel(table)}
        <div class="log-panel">
          <h2>牌局记录</h2>
          <div class="logs">${logsHtml(table)}</div>
        </div>
      </aside>
    </main>
  `);
}

function tableMetaText(table) {
  return `${stageLabel(table.status)} · 第 ${table.handNo || 0} 手牌 · ${table.smallBlind}/${table.bigBlind}`;
}

function toolbarActionsHtml(table) {
  const isSeated = table.youSeat != null;
  const canStart = isSeated && ["waiting", "showdown"].includes(table.status);
  const canLeave = Boolean(table.controls?.canLeave);
  const canDisband = Boolean(table.controls?.canDisband);
  const activeHand = Boolean(table.controls?.activeHand);
  return `
    <button class="primary slim" data-action="start-hand" ${canStart ? "" : "disabled"}>发牌</button>
    <button class="ghost slim" data-action="leave-table" ${canLeave ? "" : "disabled"}>${activeHand ? "弃牌离桌" : "离桌"}</button>
    <button class="danger slim" data-action="disband-table" ${canDisband ? "" : "disabled"}>解散桌子</button>
  `;
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

function winnerText(table) {
  return table.winners?.length
    ? table.winners.map((winner) => `${escapeHtml(winner.username)} +${money(winner.amount)} ${winner.hand ? `· ${winner.hand}` : ""}`).join("　")
    : "";
}

function logsHtml(table) {
  return (table.logs || []).map((entry) => `<p>${escapeHtml(entry.text)}</p>`).join("") || "<p>等待开局</p>";
}

function seatEntries(table) {
  const seatCount = table.maxSeats || 6;
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
  return `
    <div class="${seatClassName(entry, table)}" data-seat="${entry.actualSeat}" data-display-seat="${entry.displaySeat}">
      ${seatContentHtml(entry, table)}
    </div>
  `;
}

function seatClassName(entry, table) {
  const { player, displaySeat, actualSeat } = entry;
  const occupied = Boolean(player);
  const isMe = player && table.youSeat === actualSeat;
  const isTurn = table.currentTurnSeat === actualSeat;
  return ["seat", `seat-${displaySeat}`, occupied ? "occupied" : "empty", isMe ? "me" : "", isTurn ? "turn" : "", player?.folded ? "folded" : ""]
    .filter(Boolean)
    .join(" ");
}

function seatContentHtml(entry, table) {
  const { player, actualSeat } = entry;
  const occupied = Boolean(player);
  const dealer = table.dealerSeat === actualSeat;
  const holeCards = occupied && player.hole && player.hole.length ? player.hole : [null, null];
  const hasBet = occupied && Number(player.bet) > 0;

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
      <div class="avatar-ring" style="--avatar-hue:${avatarHue(player.username)}">
        <div class="avatar-face">
          <span>${escapeHtml(avatarInitial(player.username))}</span>
        </div>
        <i>礼</i>
      </div>
      <div class="hole-cards">${holeCards.slice(0, 2).map((card) => cardHtml(card, true)).join("")}</div>
      <div class="player-info">
        <strong>${escapeHtml(player.username)}${player.isBot ? ` <em class="bot-badge">AI</em>` : ""}</strong>
        <span>${money(player.stack)}</span>
      </div>
      <div class="seat-bet ${hasBet ? "" : "empty"}" ${hasBet ? "" : `aria-hidden="true"`}>${hasBet ? chipStackHtml(player.bet, true) : ""}</div>
      <div class="status-pill">${escapeHtml(player.lastAction || "等待")}${player.bestHandName ? ` · ${player.bestHandName}` : ""}</div>
    </div>
  `;
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
  return `
    <div class="control-panel action-panel ${drawerOpen ? "raise-open" : ""} ${activeHand ? "" : "inactive-hand"}" data-control-mode="action" data-control-key="${controlKey(table)}" data-player-bet="${raise.playerBet}" data-current-bet="${table.currentBet || 0}">
      <div class="action-status">
        <span class="${canAct ? "live-dot" : ""}">${canAct ? "轮到你" : (turnName ? `${escapeHtml(turnName)} 行动` : stageLabel(table.status))}</span>
        <b>${toCall > 0 ? `需跟 ${money(toCall)}` : "可看牌"}</b>
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
    table.youSeat ?? "",
    state.raiseDrawerOpen ? 1 : 0
  ].join("|");
}

function turnPlayerName(table) {
  const player = table.seats?.[table.currentTurnSeat];
  return player?.username || "";
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

function adminView() {
  const options = state.admin.users.map((user) => `<option value="${user.id}">${escapeHtml(user.username)} · ${money(user.chips)}</option>`).join("");
  const botTables = (state.admin.tables || []).filter((table) => ["waiting", "showdown"].includes(table.status));
  const tableOptions = botTables.map((table) => `<option value="${table.id}">${escapeHtml(table.name)} · ${table.players}/${table.maxSeats} · ${stageLabel(table.status)}</option>`).join("");
  const rows = state.admin.users.map((user) => `
    <tr>
      <td>${escapeHtml(user.username)}</td>
      <td>${money(user.chips)}</td>
      <td>${user.isBot ? "机器人" : (user.isAdmin ? "管理员" : "玩家")}</td>
    </tr>
  `).join("");
  const audit = state.admin.audit.map((item) => `<p>${escapeHtml(auditText(item))}</p>`).join("");

  return shell(`
    <main class="admin-layout">
      <section class="admin-card">
        <div class="section-title">
          <h1>管理员后台</h1>
          <button class="ghost" data-action="back-lobby">返回</button>
        </div>
        <h2>筹码充值</h2>
        <form class="recharge-form" data-form="recharge">
          <label>
            <span>用户</span>
            <select name="userId">${options}</select>
          </label>
          <label>
            <span>金额</span>
            <input name="amount" type="number" step="100" value="1000" required />
          </label>
          <label>
            <span>备注</span>
            <input name="note" maxlength="80" placeholder="活动充值" />
          </label>
          <button class="primary" type="submit">确认</button>
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
      <section class="admin-card">
        <h2>用户筹码</h2>
        <table>
          <thead><tr><th>用户</th><th>钱包</th><th>角色</th></tr></thead>
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
  } else if (state.view === "admin") {
    $app.innerHTML = adminView();
  } else {
    $app.innerHTML = lobbyView();
  }
  state.renderedTableId = nextTableId;
  if (nextTableId) syncRaiseControls($app);
  if (preserveScroll || lockedScroll) restoreScrollPosition(scrollX, scrollY);
  if (lockedScroll) state.scrollLock = null;
  scheduleTableAnimations(previousAnimationTable, state.view === "table" ? state.table : null);
  state.animationTable = snapshotTable(state.view === "table" ? state.table : null);
}

function patchTableView(table) {
  syncShellChrome();
  const root = $app.querySelector(".game-layout");
  if (!root || root.dataset.tableId !== table.id || Number(root.dataset.maxSeats) !== (table.maxSeats || 6)) {
    $app.innerHTML = tableView();
    return;
  }

  const title = root.querySelector("[data-table-title]");
  if (title) title.textContent = table.name;
  const meta = root.querySelector("[data-table-meta]");
  if (meta) meta.textContent = tableMetaText(table);
  setInnerHtml(root.querySelector(".toolbar-actions"), toolbarActionsHtml(table));

  const felt = root.querySelector(".felt-table");
  if (felt) felt.className = `felt-table seats-${table.maxSeats || 6}`;
  patchBoard(root, table);
  setInnerHtml(root.querySelector(".pot"), potHtml(table));

  const winner = root.querySelector(".winner-strip");
  if (winner) {
    const text = winnerText(table);
    winner.classList.toggle("empty", !text);
    if (text) {
      winner.removeAttribute("aria-hidden");
      winner.textContent = text;
    } else {
      winner.setAttribute("aria-hidden", "true");
      winner.textContent = "等待结算";
    }
  }

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
  setInnerHtml(root.querySelector(".logs"), logsHtml(table));
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

  const winnerStrip = root.querySelector(".winner-strip");
  addTransientClass(winnerStrip, "winner-pop", 1300);
  addTransientClass(root.querySelector(".felt-table"), "showdown-flash", 1200);

  const pot = root.querySelector(".pot");
  for (const winner of table.winners || []) {
    const seat = (table.seats || []).find((player) => player && player.userId === winner.userId);
    const target = seat ? root.querySelector(`[data-seat="${seat.seat}"]`) : winnerStrip;
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
  if (form.dataset.form === "add-bot") addBot(form);
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.actionMove || target.dataset.action === "start-hand") {
    lockTableScroll();
  }
}, true);

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

  if (target.dataset.joinSeat) {
    await joinTable(state.table.id, Number(target.dataset.joinSeat));
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
  if (action === "lobby" || action === "back-lobby") {
    state.view = "lobby";
    state.table = null;
    stopPolling();
    await loadLobby();
    startPolling();
  }
  if (action === "refresh-lobby") await loadLobby();
  if (action === "admin") await loadAdmin();
  if (action === "start-hand") await startHand();
  if (action === "leave-table") await leaveTable();
  if (action === "disband-table") await disbandTable();
  if (action === "toggle-raise") {
    state.raiseDrawerOpen = !state.raiseDrawerOpen;
    render();
  }
});

bootstrap();
