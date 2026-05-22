const API_BASE = "/api";
const STORAGE_KEY = "holdem_token";

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  user: null,
  tables: [],
  table: null,
  view: "auth",
  authMode: "login",
  message: "",
  busy: false,
  poller: null,
  admin: { users: [], tables: [], audit: [] }
};

const $app = document.querySelector("#app");

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
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function runBusy(task) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await task();
  } catch (error) {
    setMessage(error.message);
  } finally {
    state.busy = false;
    render();
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
  await runBusy(async () => {
    const result = await api("/tables", {
      method: "POST",
      body: {
        name: form.get("name"),
        smallBlind: Number(form.get("smallBlind")),
        bigBlind: Number(form.get("bigBlind")),
        maxSeats: Number(form.get("maxSeats"))
      }
    });
    state.table = result.table;
    state.view = "table";
    startPolling();
  });
}

async function joinTable(tableId, seat = null) {
  const buyInInput = document.querySelector("[data-buyin]");
  const buyIn = Number(buyInInput?.value || 1000);
  await runBusy(async () => {
    const result = await api(`/tables/${tableId}/join`, { method: "POST", body: { buyIn, seat } });
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
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/leave`, { method: "POST" });
    state.user = result.user;
    state.table = null;
    state.view = "lobby";
    await loadLobby(true);
    stopPolling();
  });
}

async function startHand() {
  if (!state.table) return;
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/start`, { method: "POST" });
    state.table = result.table;
  });
}

async function playerAction(action, amount = null) {
  if (!state.table) return;
  await runBusy(async () => {
    const result = await api(`/tables/${state.table.id}/action`, { method: "POST", body: { action, amount } });
    state.table = result.table;
  });
}

async function refreshTable(silent = true) {
  if (!state.table) return;
  try {
    const result = await api(`/tables/${state.table.id}`);
    state.user = result.user;
    state.table = result.table;
    if (!silent) render();
  } catch (error) {
    if (!silent) setMessage(error.message);
  }
}

function startPolling() {
  stopPolling();
  state.poller = window.setInterval(async () => {
    if (state.view === "table" && state.table) {
      await refreshTable();
      render();
    } else if (state.view === "lobby") {
      await loadLobby(true);
      render();
    }
  }, 2200);
}

function stopPolling() {
  if (state.poller) window.clearInterval(state.poller);
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
  return `
    <div class="app-shell">
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
      ${state.busy ? `<div class="loading"><span></span></div>` : ""}
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
  const board = [...(table.community || [])];
  while (board.length < 5) board.push(null);
  const isSeated = table.youSeat != null;
  const canStart = isSeated && ["waiting", "showdown"].includes(table.status);
  const controls = table.controls || {};

  return shell(`
    <main class="game-layout">
      <section class="table-toolbar">
        <button class="ghost" data-action="back-lobby">大厅</button>
        <div>
          <strong>${escapeHtml(table.name)}</strong>
          <span>${stageLabel(table.status)} · 第 ${table.handNo || 0} 手牌 · ${table.smallBlind}/${table.bigBlind}</span>
        </div>
        <div class="toolbar-actions">
          ${canStart ? `<button class="primary slim" data-action="start-hand">发牌</button>` : ""}
          ${isSeated && !["preflop", "flop", "turn", "river"].includes(table.status) ? `<button class="ghost" data-action="leave-table">离桌</button>` : ""}
        </div>
      </section>
      <section class="poker-room">
        <div class="felt-table seats-${seatCount}">
          <div class="rail"></div>
          <div class="table-center">
            <div class="board">${board.map((card) => cardHtml(card)).join("")}</div>
            <div class="pot">
              ${chipStackHtml(table.pot)}
              <span>底池</span>
            </div>
            ${table.winners?.length ? `<div class="winner-strip">${table.winners.map((winner) => `${escapeHtml(winner.username)} +${money(winner.amount)} ${winner.hand ? `· ${winner.hand}` : ""}`).join("　")}</div>` : ""}
          </div>
          ${seats.map((entry) => seatHtml(entry, table)).join("")}
        </div>
      </section>
      <aside class="side-panel">
        ${isSeated ? actionPanel(controls, table) : sitPanel(table)}
        <div class="log-panel">
          <h2>牌局记录</h2>
          <div class="logs">
            ${(table.logs || []).map((entry) => `<p>${escapeHtml(entry.text)}</p>`).join("") || "<p>等待开局</p>"}
          </div>
        </div>
      </aside>
    </main>
  `);
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
  const { player, displaySeat, actualSeat } = entry;
  const occupied = Boolean(player);
  const isMe = player && table.youSeat === actualSeat;
  const isTurn = table.currentTurnSeat === actualSeat;
  const dealer = table.dealerSeat === actualSeat;
  const className = ["seat", `seat-${displaySeat}`, occupied ? "occupied" : "empty", isMe ? "me" : "", isTurn ? "turn" : "", player?.folded ? "folded" : ""].join(" ");

  if (!occupied) {
    const canJoin = table.youSeat == null && ["waiting", "showdown"].includes(table.status);
    return `
      <button class="${className}" ${canJoin ? `data-join-seat="${actualSeat}"` : "disabled"}>
        <span class="avatar">+</span>
        <strong>空位</strong>
      </button>
    `;
  }

  return `
    <div class="${className}">
      ${dealer ? `<span class="dealer">D</span>` : ""}
      <div class="hole-cards">${(player.hole || [null, null]).map((card) => cardHtml(card, true)).join("")}</div>
      <div class="player-info">
        <strong>${escapeHtml(player.username)}${player.isBot ? ` <em class="bot-badge">AI</em>` : ""}</strong>
        <span>${money(player.stack)}</span>
      </div>
      ${player.bet > 0 ? `<div class="seat-bet">${chipStackHtml(player.bet, true)}</div>` : ""}
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
    <div class="control-panel">
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
  const minRaise = controls.minRaiseTo || table.bigBlind;
  const maxRaise = controls.maxRaiseTo || minRaise;
  return `
    <div class="control-panel">
      <h2>行动</h2>
      <div class="call-box">
        <span>待跟注</span>
        <strong>${money(toCall)}</strong>
      </div>
      <div class="action-grid">
        <button class="ghost" data-action-move="fold" ${!canAct ? "disabled" : ""}>弃牌</button>
        <button class="ghost" data-action-move="${toCall > 0 ? "call" : "check"}" ${!canAct ? "disabled" : ""}>${toCall > 0 ? "跟注" : "看牌"}</button>
      </div>
      <label>
        <span>加注到</span>
        <input data-raise-amount type="number" min="${minRaise}" max="${maxRaise}" step="${table.bigBlind}" value="${minRaise}" ${!canAct ? "disabled" : ""} />
      </label>
      <div class="action-grid">
        <button class="primary" data-action-move="raise" ${!canAct ? "disabled" : ""}>加注</button>
        <button class="danger" data-action-move="allin" ${!canAct ? "disabled" : ""}>全下</button>
      </div>
    </div>
  `;
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
  if (!state.user) {
    $app.innerHTML = authView();
  } else if (state.view === "table") {
    $app.innerHTML = tableView();
  } else if (state.view === "admin") {
    $app.innerHTML = adminView();
  } else {
    $app.innerHTML = lobbyView();
  }
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

  if (target.dataset.actionMove) {
    const move = target.dataset.actionMove;
    const amount = move === "raise" ? Number(document.querySelector("[data-raise-amount]")?.value || 0) : null;
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
});

bootstrap();
