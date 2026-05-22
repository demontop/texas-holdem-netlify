const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DB_KEY = "db.json";
const STORE_NAME = "holdem-state";
const LOCAL_DB_FILE = path.join(process.cwd(), ".data", "poker-db.json");
const ACTIVE_STAGES = new Set(["preflop", "flop", "turn", "river"]);
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["S", "H", "D", "C"];
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function defaultDb() {
  return {
    version: 1,
    users: {},
    sessions: {},
    tables: {},
    audit: []
  };
}

function shouldUseBlobs() {
  return Boolean(process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY_BLOBS_TOKEN);
}

async function getBlobStore() {
  const mod = await import("@netlify/blobs");
  return mod.getStore(STORE_NAME);
}

async function readDb() {
  if (shouldUseBlobs()) {
    const store = await getBlobStore();
    const text = await store.get(DB_KEY, { type: "text", consistency: "strong" });
    return normalizeDb(text ? JSON.parse(text) : defaultDb());
  }

  try {
    const text = await fs.readFile(LOCAL_DB_FILE, "utf8");
    return normalizeDb(JSON.parse(text));
  } catch (error) {
    if (error.code === "ENOENT") return defaultDb();
    throw error;
  }
}

async function writeDb(db) {
  db.updatedAt = new Date().toISOString();
  if (shouldUseBlobs()) {
    const store = await getBlobStore();
    await store.set(DB_KEY, JSON.stringify(db));
    return;
  }

  await fs.mkdir(path.dirname(LOCAL_DB_FILE), { recursive: true });
  await fs.writeFile(LOCAL_DB_FILE, JSON.stringify(db, null, 2));
}

function normalizeDb(db) {
  db.version = db.version || 1;
  db.users = db.users || {};
  db.sessions = db.sessions || {};
  db.tables = db.tables || {};
  db.audit = db.audit || [];

  const now = Date.now();
  for (const [token, session] of Object.entries(db.sessions)) {
    if (!session || session.expiresAt < now) delete db.sessions[token];
  }

  for (const table of Object.values(db.tables)) {
    table.maxSeats = table.maxSeats || 6;
    table.seats = table.seats || Array.from({ length: table.maxSeats }, () => null);
    table.logs = table.logs || [];
    table.winners = table.winners || [];
  }

  return db;
}

async function withDb(mutator) {
  const db = await readDb();
  const result = await mutator(db);
  await writeDb(db);
  return result;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type"
    },
    body: JSON.stringify(payload)
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体必须是 JSON");
  }
}

function segmentsFromEvent(event) {
  let route = event.path || "/";
  route = route.replace(/^\/\.netlify\/functions\/api\/?/, "/");
  route = route.replace(/^\/api\/?/, "/");
  return route.split("/").filter(Boolean).map(decodeURIComponent);
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function cleanUsername(username) {
  return String(username || "").trim().replace(/\s+/g, "_").slice(0, 18);
}

function assertUsername(username) {
  if (!/^[\w\u4e00-\u9fa5]{2,18}$/.test(username)) {
    throw new HttpError(400, "用户名需为 2-18 位中文、字母、数字或下划线");
  }
}

function assertPassword(password) {
  if (String(password || "").length < 6) {
    throw new HttpError(400, "密码至少 6 位");
  }
}

function hashPassword(password, salt = randomId(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const actual = crypto.scryptSync(String(password), user.salt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function findUserByUsername(db, username) {
  const normalized = String(username || "").trim().toLowerCase();
  return Object.values(db.users).find((user) => user.username.toLowerCase() === normalized);
}

function createSession(db, userId) {
  const token = randomId(32);
  db.sessions[token] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14
  };
  return token;
}

function userPublic(user) {
  return {
    id: user.id,
    username: user.username,
    chips: user.chips,
    isAdmin: Boolean(user.isAdmin),
    createdAt: user.createdAt
  };
}

function getToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireUser(db, event) {
  const token = getToken(event);
  const session = token ? db.sessions[token] : null;
  if (!session || session.expiresAt < Date.now()) {
    throw new HttpError(401, "请先登录");
  }
  const user = db.users[session.userId];
  if (!user) throw new HttpError(401, "登录状态已失效");
  session.expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
  return user;
}

function requireAdmin(db, event) {
  const user = requireUser(db, event);
  if (!user.isAdmin) throw new HttpError(403, "需要管理员权限");
  return user;
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function seatedPlayers(table) {
  return table.seats.filter(Boolean);
}

function handPlayers(table) {
  return table.seats.filter((player) => player && player.inHand);
}

function remainingPlayers(table) {
  return handPlayers(table).filter((player) => !player.folded);
}

function actingPlayers(table) {
  return remainingPlayers(table).filter((player) => !player.allIn && player.stack > 0);
}

function nextSeat(table, fromSeat, predicate) {
  for (let step = 1; step <= table.maxSeats; step += 1) {
    const seat = (fromSeat + step + table.maxSeats) % table.maxSeats;
    const player = table.seats[seat];
    if (player && predicate(player)) return seat;
  }
  return null;
}

function firstSeat(table, predicate) {
  for (let seat = 0; seat < table.maxSeats; seat += 1) {
    const player = table.seats[seat];
    if (player && predicate(player)) return seat;
  }
  return null;
}

function addLog(table, text) {
  table.logs = table.logs || [];
  table.logs.unshift({ at: nowIso(), text });
  table.logs = table.logs.slice(0, 80);
}

function takeChips(table, player, amount) {
  const chips = Math.max(0, Math.min(Math.floor(Number(amount) || 0), player.stack));
  player.stack -= chips;
  player.bet += chips;
  player.contributed += chips;
  table.pot += chips;
  if (player.stack <= 0) {
    player.stack = 0;
    player.allIn = true;
  }
  return chips;
}

function postBlind(table, seat, amount, label) {
  const player = table.seats[seat];
  const paid = takeChips(table, player, amount);
  player.lastAction = `${label} ${paid}`;
  table.currentBet = Math.max(table.currentBet, player.bet);
}

function startHand(table) {
  const eligible = seatedPlayers(table).filter((player) => player.stack > 0);
  if (eligible.length < 2) throw new HttpError(400, "至少需要 2 名有筹码的玩家");

  table.handNo = (table.handNo || 0) + 1;
  table.status = "preflop";
  table.community = [];
  table.deck = makeDeck();
  table.pot = 0;
  table.currentBet = 0;
  table.minRaise = table.bigBlind;
  table.winners = [];
  table.revealed = false;

  for (const player of seatedPlayers(table)) {
    player.hole = [];
    player.folded = player.stack <= 0;
    player.allIn = false;
    player.bet = 0;
    player.contributed = 0;
    player.acted = false;
    player.inHand = player.stack > 0;
    player.lastAction = player.inHand ? "等待" : "旁观";
    player.bestHandName = null;
  }

  const dealer = table.dealerSeat == null
    ? eligible[0].seat
    : nextSeat(table, table.dealerSeat, (player) => player.stack > 0);
  table.dealerSeat = dealer;

  const active = handPlayers(table);
  const smallBlindSeat = active.length === 2
    ? dealer
    : nextSeat(table, dealer, (player) => player.inHand);
  const bigBlindSeat = nextSeat(table, smallBlindSeat, (player) => player.inHand);

  for (let card = 0; card < 2; card += 1) {
    for (const player of handPlayers(table)) {
      player.hole.push(table.deck.pop());
    }
  }

  postBlind(table, smallBlindSeat, table.smallBlind, "小盲");
  postBlind(table, bigBlindSeat, table.bigBlind, "大盲");

  table.currentTurnSeat = nextSeat(table, bigBlindSeat, (player) => player.inHand && !player.folded && !player.allIn);
  addLog(table, `第 ${table.handNo} 手牌开始，${table.seats[smallBlindSeat].username} 小盲，${table.seats[bigBlindSeat].username} 大盲`);

  if (table.currentTurnSeat == null) runOutToShowdown(table);
}

function findNextActor(table, fromSeat) {
  for (let step = 1; step <= table.maxSeats; step += 1) {
    const seat = (fromSeat + step + table.maxSeats) % table.maxSeats;
    const player = table.seats[seat];
    if (!player || !player.inHand || player.folded || player.allIn) continue;
    if (!player.acted || player.bet < table.currentBet) return seat;
  }
  return firstSeat(table, (player) => player.inHand && !player.folded && !player.allIn);
}

function maybeAdvance(table, fromSeat) {
  const remaining = remainingPlayers(table);
  if (remaining.length === 1) {
    awardByFold(table, remaining[0]);
    return;
  }

  const actors = actingPlayers(table);
  if (actors.length === 0) {
    runOutToShowdown(table);
    return;
  }

  const roundComplete = actors.every((player) => player.acted && player.bet === table.currentBet);
  if (roundComplete) {
    advanceStreet(table);
    return;
  }

  table.currentTurnSeat = findNextActor(table, fromSeat);
}

function advanceStreet(table) {
  for (const player of handPlayers(table)) {
    player.bet = 0;
    player.acted = false;
  }
  table.currentBet = 0;
  table.minRaise = table.bigBlind;

  if (table.status === "river") {
    resolveShowdown(table);
    return;
  }

  dealNextCommunity(table);

  if (remainingPlayers(table).length === 1) {
    awardByFold(table, remainingPlayers(table)[0]);
    return;
  }

  if (actingPlayers(table).length <= 1) {
    runOutToShowdown(table);
    return;
  }

  table.currentTurnSeat = nextSeat(table, table.dealerSeat, (player) => player.inHand && !player.folded && !player.allIn);
  addLog(table, `${stageName(table.status)} 开始`);
}

function dealNextCommunity(table) {
  if (table.status === "preflop") {
    table.community.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
    table.status = "flop";
  } else if (table.status === "flop") {
    table.community.push(table.deck.pop());
    table.status = "turn";
  } else if (table.status === "turn") {
    table.community.push(table.deck.pop());
    table.status = "river";
  }
}

function runOutToShowdown(table) {
  while (table.status !== "river" && ACTIVE_STAGES.has(table.status)) {
    dealNextCommunity(table);
  }
  resolveShowdown(table);
}

function awardByFold(table, winner) {
  const amount = table.pot;
  winner.stack += amount;
  table.winners = [{ userId: winner.userId, username: winner.username, amount, hand: "其他玩家弃牌" }];
  table.pot = 0;
  table.status = "showdown";
  table.currentTurnSeat = null;
  table.revealed = false;
  for (const player of handPlayers(table)) {
    player.bet = 0;
    player.acted = false;
  }
  addLog(table, `${winner.username} 赢得 ${amount} 筹码`);
}

function resolveShowdown(table) {
  const contenders = remainingPlayers(table);
  if (contenders.length === 1) {
    awardByFold(table, contenders[0]);
    return;
  }

  for (const player of contenders) {
    const best = bestHand([...player.hole, ...table.community]);
    player.best = best;
    player.bestHandName = best.name;
  }

  const all = handPlayers(table);
  const levels = [...new Set(all.map((player) => player.contributed).filter((value) => value > 0))].sort((a, b) => a - b);
  const totals = new Map();
  let previous = 0;

  for (const level of levels) {
    const potAmount = all.reduce((sum, player) => sum + Math.max(0, Math.min(player.contributed, level) - previous), 0);
    const eligible = contenders.filter((player) => player.contributed >= level);
    if (potAmount > 0 && eligible.length > 0) {
      const winners = findBestPlayers(eligible);
      const share = Math.floor(potAmount / winners.length);
      let remainder = potAmount - share * winners.length;
      for (const winner of winners) {
        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        const amount = share + extra;
        winner.stack += amount;
        totals.set(winner.userId, (totals.get(winner.userId) || 0) + amount);
      }
    }
    previous = level;
  }

  table.winners = [...totals.entries()].map(([userId, amount]) => {
    const player = contenders.find((candidate) => candidate.userId === userId);
    return {
      userId,
      username: player.username,
      amount,
      hand: player.bestHandName
    };
  });
  table.status = "showdown";
  table.currentTurnSeat = null;
  table.revealed = true;
  table.pot = 0;

  for (const player of handPlayers(table)) {
    player.bet = 0;
    player.acted = false;
  }

  const winnerText = table.winners.map((winner) => `${winner.username} +${winner.amount}（${winner.hand}）`).join("，");
  addLog(table, `摊牌：${winnerText}`);
}

function stageName(status) {
  return {
    waiting: "等待",
    preflop: "翻前",
    flop: "翻牌",
    turn: "转牌",
    river: "河牌",
    showdown: "结算"
  }[status] || status;
}

function cardValue(card) {
  return RANK_VALUE[card[0]];
}

function evaluateFive(cards) {
  const values = cards.map(cardValue).sort((a, b) => b - a);
  const suits = cards.map((card) => card[1]);
  const flush = suits.every((suit) => suit === suits[0]);
  const unique = [...new Set(values)].sort((a, b) => b - a);
  let straightHigh = null;

  if (unique.length === 5 && unique[0] - unique[4] === 4) straightHigh = unique[0];
  if (unique.join(",") === "14,5,4,3,2") straightHigh = 5;

  const counts = [...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map()).entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (flush && straightHigh) return score(8, [straightHigh], straightHigh === 14 ? "皇家同花顺" : "同花顺", cards);

  const four = counts.find((entry) => entry[1] === 4);
  if (four) {
    const kicker = values.find((value) => value !== four[0]);
    return score(7, [four[0], kicker], "四条", cards);
  }

  const three = counts.find((entry) => entry[1] === 3);
  const pairForHouse = counts.find((entry) => entry[1] === 2);
  if (three && pairForHouse) return score(6, [three[0], pairForHouse[0]], "葫芦", cards);

  if (flush) return score(5, values, "同花", cards);
  if (straightHigh) return score(4, [straightHigh], "顺子", cards);

  if (three) {
    const kickers = values.filter((value) => value !== three[0]).slice(0, 2);
    return score(3, [three[0], ...kickers], "三条", cards);
  }

  const pairs = counts.filter((entry) => entry[1] === 2).map((entry) => entry[0]).sort((a, b) => b - a);
  if (pairs.length >= 2) {
    const kicker = values.find((value) => !pairs.slice(0, 2).includes(value));
    return score(2, [...pairs.slice(0, 2), kicker], "两对", cards);
  }

  if (pairs.length === 1) {
    const kickers = values.filter((value) => value !== pairs[0]).slice(0, 3);
    return score(1, [pairs[0], ...kickers], "一对", cards);
  }

  return score(0, values, "高牌", cards);
}

function score(rank, kickers, name, cards) {
  return { rank, kickers, name, cards };
}

function combinations(items, size, start = 0, chosen = [], out = []) {
  if (chosen.length === size) {
    out.push([...chosen]);
    return out;
  }
  for (let i = start; i <= items.length - (size - chosen.length); i += 1) {
    chosen.push(items[i]);
    combinations(items, size, i + 1, chosen, out);
    chosen.pop();
  }
  return out;
}

function compareScores(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const length = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.kickers[i] || 0) - (b.kickers[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHand(cards) {
  return combinations(cards, 5)
    .map(evaluateFive)
    .sort((a, b) => compareScores(b, a))[0];
}

function findBestPlayers(players) {
  let winners = [];
  let best = null;
  for (const player of players) {
    if (!best || compareScores(player.best, best) > 0) {
      best = player.best;
      winners = [player];
    } else if (compareScores(player.best, best) === 0) {
      winners.push(player);
    }
  }
  return winners;
}

function tableSummary(table) {
  return {
    id: table.id,
    name: table.name,
    status: table.status,
    stage: stageName(table.status),
    players: seatedPlayers(table).length,
    maxSeats: table.maxSeats,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    pot: table.pot,
    handNo: table.handNo || 0,
    updatedAt: table.updatedAt
  };
}

function publicTable(table, viewer) {
  const viewerSeat = table.seats.find((player) => player && viewer && player.userId === viewer.id);
  const canAct = Boolean(viewerSeat && ACTIVE_STAGES.has(table.status) && table.currentTurnSeat === viewerSeat.seat);
  const toCall = viewerSeat ? Math.max(0, table.currentBet - viewerSeat.bet) : 0;
  const maxRaiseTo = viewerSeat ? viewerSeat.bet + viewerSeat.stack : 0;
  const minRaiseTo = table.currentBet === 0
    ? Math.min(table.bigBlind, maxRaiseTo)
    : Math.min(table.currentBet + table.minRaise, maxRaiseTo);

  return {
    id: table.id,
    name: table.name,
    status: table.status,
    stage: stageName(table.status),
    maxSeats: table.maxSeats,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    dealerSeat: table.dealerSeat,
    currentTurnSeat: table.currentTurnSeat,
    currentBet: table.currentBet,
    minRaise: table.minRaise,
    handNo: table.handNo || 0,
    pot: table.pot,
    community: table.community || [],
    winners: table.winners || [],
    logs: table.logs || [],
    youSeat: viewerSeat ? viewerSeat.seat : null,
    controls: { canAct, toCall, minRaiseTo, maxRaiseTo },
    seats: table.seats.map((player) => {
      if (!player) return null;
      const ownCards = viewer && player.userId === viewer.id;
      const reveal = table.status === "showdown" && table.revealed && !player.folded;
      return {
        seat: player.seat,
        userId: player.userId,
        username: player.username,
        stack: player.stack,
        bet: player.bet,
        contributed: player.contributed,
        folded: player.folded,
        allIn: player.allIn,
        inHand: player.inHand,
        lastAction: player.lastAction,
        bestHandName: reveal ? player.bestHandName : null,
        hole: ownCards || reveal ? player.hole : (player.hole || []).map(() => null)
      };
    })
  };
}

function getTableOrThrow(db, id) {
  const table = db.tables[id];
  if (!table) throw new HttpError(404, "牌桌不存在");
  return table;
}

function requireSeated(table, user) {
  const player = table.seats.find((seat) => seat && seat.userId === user.id);
  if (!player) throw new HttpError(403, "你还没有坐下");
  return player;
}

function createTable(owner, body) {
  const smallBlind = clampInt(body.smallBlind || 10, 1, 10000);
  const bigBlind = clampInt(body.bigBlind || smallBlind * 2, smallBlind + 1, 20000);
  const maxSeats = clampInt(body.maxSeats || 6, 2, 6);
  const name = String(body.name || `${owner.username} 的牌桌`).trim().slice(0, 28);
  const table = {
    id: randomId(8),
    name,
    ownerId: owner.id,
    status: "waiting",
    maxSeats,
    seats: Array.from({ length: maxSeats }, () => null),
    smallBlind,
    bigBlind,
    community: [],
    deck: [],
    pot: 0,
    currentBet: 0,
    minRaise: bigBlind,
    currentTurnSeat: null,
    dealerSeat: null,
    handNo: 0,
    winners: [],
    logs: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  addLog(table, `${owner.username} 创建牌桌`);
  return table;
}

function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function ensureWaitingForSeatChange(table) {
  if (ACTIVE_STAGES.has(table.status)) throw new HttpError(400, "牌局进行中，暂不能入座或离桌");
}

function touchTable(table) {
  table.updatedAt = nowIso();
}

function handleAction(table, user, body) {
  if (!ACTIVE_STAGES.has(table.status)) throw new HttpError(400, "当前没有进行中的手牌");
  const player = requireSeated(table, user);
  if (!player.inHand || player.folded || player.allIn) throw new HttpError(400, "当前不能行动");
  if (table.currentTurnSeat !== player.seat) throw new HttpError(409, "还没轮到你");

  const action = String(body.action || "").toLowerCase();
  const toCall = Math.max(0, table.currentBet - player.bet);

  if (action === "fold") {
    player.folded = true;
    player.acted = true;
    player.lastAction = "弃牌";
    addLog(table, `${player.username} 弃牌`);
  } else if (action === "check") {
    if (toCall > 0) throw new HttpError(400, "当前需要跟注，不能看牌");
    player.acted = true;
    player.lastAction = "看牌";
    addLog(table, `${player.username} 看牌`);
  } else if (action === "call") {
    if (toCall <= 0) {
      player.acted = true;
      player.lastAction = "看牌";
      addLog(table, `${player.username} 看牌`);
    } else {
      const paid = takeChips(table, player, toCall);
      player.acted = true;
      player.lastAction = paid < toCall ? "全下跟注" : `跟注 ${paid}`;
      addLog(table, `${player.username} ${player.lastAction}`);
    }
  } else if (action === "raise") {
    const target = clampInt(body.amount, 1, player.bet + player.stack);
    const maxTarget = player.bet + player.stack;
    const minTarget = table.currentBet === 0 ? table.bigBlind : table.currentBet + table.minRaise;
    if (target <= table.currentBet) throw new HttpError(400, "加注额必须高于当前下注");
    if (target < minTarget && target < maxTarget) throw new HttpError(400, `最小加注到 ${minTarget}`);

    const previousBet = table.currentBet;
    const paid = takeChips(table, player, target - player.bet);
    player.acted = true;
    player.lastAction = player.allIn ? `全下 ${player.bet}` : (previousBet === 0 ? `下注 ${player.bet}` : `加注到 ${player.bet}`);

    if (player.bet > previousBet) {
      const raiseBy = player.bet - previousBet;
      table.currentBet = player.bet;
      if (raiseBy >= table.minRaise || previousBet === 0) {
        table.minRaise = Math.max(table.minRaise, raiseBy);
        for (const other of actingPlayers(table)) {
          if (other.userId !== player.userId) other.acted = false;
        }
      }
    }
    addLog(table, `${player.username} ${player.lastAction}`);
    if (paid <= 0) throw new HttpError(400, "筹码不足");
  } else if (action === "allin") {
    const previousBet = table.currentBet;
    takeChips(table, player, player.stack);
    player.acted = true;
    player.lastAction = `全下 ${player.bet}`;
    if (player.bet > previousBet) {
      const raiseBy = player.bet - previousBet;
      table.currentBet = player.bet;
      if (raiseBy >= table.minRaise || previousBet === 0) {
        table.minRaise = Math.max(table.minRaise, raiseBy);
        for (const other of actingPlayers(table)) {
          if (other.userId !== player.userId) other.acted = false;
        }
      }
    }
    addLog(table, `${player.username} ${player.lastAction}`);
  } else {
    throw new HttpError(400, "未知动作");
  }

  maybeAdvance(table, player.seat);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});

  try {
    const method = event.httpMethod;
    const segments = segmentsFromEvent(event);
    const body = method === "POST" ? parseBody(event) : {};

    if (method === "GET" && segments[0] === "health") {
      return json(200, { ok: true, time: nowIso() });
    }

    if (method === "POST" && segments[0] === "register") {
      const result = await withDb((db) => {
        const username = cleanUsername(body.username);
        assertUsername(username);
        assertPassword(body.password);
        if (findUserByUsername(db, username)) throw new HttpError(409, "用户名已存在");
        const { salt, hash } = hashPassword(body.password);
        const userCount = Object.keys(db.users).length;
        const isAdmin = userCount === 0 || (process.env.ADMIN_INVITE_CODE && body.adminCode === process.env.ADMIN_INVITE_CODE);
        const user = {
          id: randomId(10),
          username,
          salt,
          passwordHash: hash,
          chips: 5000,
          isAdmin,
          createdAt: nowIso()
        };
        db.users[user.id] = user;
        db.audit.unshift({ at: nowIso(), actorId: user.id, type: "register", note: `${username} 注册${isAdmin ? "并成为管理员" : ""}` });
        const token = createSession(db, user.id);
        return { token, user: userPublic(user) };
      });
      return json(201, result);
    }

    if (method === "POST" && segments[0] === "login") {
      const result = await withDb((db) => {
        const user = findUserByUsername(db, body.username);
        if (!user || !verifyPassword(body.password, user)) throw new HttpError(401, "用户名或密码错误");
        const token = createSession(db, user.id);
        return { token, user: userPublic(user) };
      });
      return json(200, result);
    }

    if (method === "GET" && segments[0] === "me") {
      const db = await readDb();
      const user = requireUser(db, event);
      await writeDb(db);
      return json(200, { user: userPublic(user) });
    }

    if (segments[0] === "admin") {
      if (method === "GET" && segments[1] === "users") {
        const db = await readDb();
        requireAdmin(db, event);
        return json(200, {
          users: Object.values(db.users).map(userPublic).sort((a, b) => a.username.localeCompare(b.username)),
          audit: db.audit.slice(0, 80)
        });
      }

      if (method === "POST" && segments[1] === "recharge") {
        const result = await withDb((db) => {
          const admin = requireAdmin(db, event);
          const amount = clampInt(body.amount, -100000000, 100000000);
          if (amount === 0) throw new HttpError(400, "充值金额不能为 0");
          const user = body.userId ? db.users[body.userId] : findUserByUsername(db, body.username);
          if (!user) throw new HttpError(404, "用户不存在");
          user.chips = Math.max(0, user.chips + amount);
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: "recharge",
            targetId: user.id,
            target: user.username,
            amount,
            note: String(body.note || "").slice(0, 80)
          });
          db.audit = db.audit.slice(0, 300);
          return { user: userPublic(user), audit: db.audit.slice(0, 80) };
        });
        return json(200, result);
      }
    }

    if (method === "GET" && segments[0] === "lobby") {
      const db = await readDb();
      const user = requireUser(db, event);
      return json(200, {
        user: userPublic(user),
        tables: Object.values(db.tables).map(tableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      });
    }

    if (segments[0] === "tables") {
      if (method === "POST" && segments.length === 1) {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = createTable(user, body);
          db.tables[table.id] = table;
          return { table: publicTable(table, user) };
        });
        return json(201, result);
      }

      if (method === "GET" && segments[1]) {
        const db = await readDb();
        const user = requireUser(db, event);
        const table = getTableOrThrow(db, segments[1]);
        return json(200, { user: userPublic(user), table: publicTable(table, user) });
      }

      if (method === "POST" && segments[1] && segments[2] === "join") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          ensureWaitingForSeatChange(table);
          const existing = table.seats.find((seat) => seat && seat.userId === user.id);
          if (existing) return { user: userPublic(user), table: publicTable(table, user) };
          const buyIn = clampInt(body.buyIn || table.bigBlind * 50, table.bigBlind * 10, 1000000);
          if (user.chips < buyIn) throw new HttpError(400, "钱包筹码不足");
          const requested = body.seat == null ? null : clampInt(body.seat, 0, table.maxSeats - 1);
          const seat = requested != null && !table.seats[requested]
            ? requested
            : table.seats.findIndex((value) => !value);
          if (seat < 0) throw new HttpError(400, "牌桌已满");
          user.chips -= buyIn;
          table.seats[seat] = {
            seat,
            userId: user.id,
            username: user.username,
            stack: buyIn,
            hole: [],
            folded: false,
            allIn: false,
            inHand: false,
            bet: 0,
            contributed: 0,
            acted: false,
            lastAction: "入座"
          };
          addLog(table, `${user.username} 带入 ${buyIn} 筹码入座`);
          touchTable(table);
          return { user: userPublic(user), table: publicTable(table, user) };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "leave") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          ensureWaitingForSeatChange(table);
          const player = requireSeated(table, user);
          user.chips += player.stack;
          table.seats[player.seat] = null;
          addLog(table, `${user.username} 离开牌桌，带走 ${player.stack}`);
          touchTable(table);
          if (seatedPlayers(table).length === 0) delete db.tables[table.id];
          return { user: userPublic(user), table: db.tables[table.id] ? publicTable(table, user) : null };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "start") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          requireSeated(table, user);
          if (ACTIVE_STAGES.has(table.status)) throw new HttpError(400, "手牌已经开始");
          startHand(table);
          touchTable(table);
          return { table: publicTable(table, user) };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "action") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          handleAction(table, user, body);
          touchTable(table);
          return { table: publicTable(table, user) };
        });
        return json(200, result);
      }
    }

    throw new HttpError(404, "接口不存在");
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    return json(status, { error: error.message || "服务器错误" });
  }
};
