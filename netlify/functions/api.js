const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DB_KEY = "db.json";
const STORE_NAME = "holdem-state";
const LOCAL_DB_FILE = path.join(process.cwd(), ".data", "poker-db.json");
const ACTIVE_STAGES = new Set(["preflop", "flop", "turn", "river"]);
const ACTION_TIMEOUT_MS = 20000;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["S", "H", "D", "C"];
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));
const MAX_WRITE_RETRIES = 6;
let blobsModulePromise = null;
let localWriteQueue = Promise.resolve();
let lambdaBlobStrongConsistency = null;

class HttpError extends Error {
  constructor(statusCode, message, payload = {}) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

class WriteConflictError extends Error {
  constructor() {
    super("状态写入冲突");
    this.retryable = true;
  }
}

function defaultDb() {
  return {
    version: 1,
    revision: 0,
    users: {},
    sessions: {},
    tables: {},
    audit: []
  };
}

function shouldUseBlobs() {
  return Boolean(process.env.NETLIFY_BLOBS_CONTEXT || (process.env.NETLIFY_BLOBS_TOKEN && process.env.SITE_ID));
}

async function getBlobStore() {
  const mod = await getBlobsModule();
  const consistencyOptions = blobConsistencyOptions();
  if (process.env.NETLIFY_BLOBS_CONTEXT) return mod.getStore(STORE_NAME, consistencyOptions);
  return mod.getStore({
    name: STORE_NAME,
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
    ...consistencyOptions
  });
}

function getBlobsModule() {
  if (!blobsModulePromise) blobsModulePromise = import("@netlify/blobs");
  return blobsModulePromise;
}

async function configureBlobs(event) {
  if (!event.blobs) return;
  lambdaBlobStrongConsistency = eventBlobsHasUncachedEdgeUrl(event.blobs);
  const mod = await getBlobsModule();
  if (typeof mod.connectLambda === "function") mod.connectLambda(event);
}

function eventBlobsHasUncachedEdgeUrl(rawContext) {
  try {
    const data = JSON.parse(Buffer.from(rawContext, "base64").toString("utf8"));
    return Boolean(data.uncachedEdgeURL || data.uncached_edge_url || data.uncachedURL);
  } catch {
    return false;
  }
}

function envBlobsHasUncachedEdgeUrl() {
  const rawContext = process.env.NETLIFY_BLOBS_CONTEXT;
  if (!rawContext) return false;
  try {
    const data = JSON.parse(Buffer.from(rawContext, "base64").toString("utf8"));
    return Boolean(data.uncachedEdgeURL || data.uncached_edge_url || data.uncachedURL);
  } catch {
    return false;
  }
}

function canUseStrongBlobConsistency() {
  if (lambdaBlobStrongConsistency !== null) return lambdaBlobStrongConsistency;
  return envBlobsHasUncachedEdgeUrl();
}

function blobConsistencyOptions() {
  return canUseStrongBlobConsistency() ? { consistency: "strong" } : {};
}

async function readDb() {
  return (await readDbEntry()).db;
}

async function readDbEntry() {
  if (shouldUseBlobs()) {
    const store = await getBlobStore();
    const entry = await store.getWithMetadata(DB_KEY, { type: "text", ...blobConsistencyOptions() });
    const db = entry?.data ? JSON.parse(entry.data) : defaultDb();
    return { db: normalizeDb(db), etag: entry?.etag || null };
  }

  try {
    const text = await fs.readFile(LOCAL_DB_FILE, "utf8");
    return { db: normalizeDb(JSON.parse(text)), etag: null };
  } catch (error) {
    if (error.code === "ENOENT") return { db: defaultDb(), etag: null };
    throw error;
  }
}

async function writeDbEntry(db, etag = null, options = {}) {
  db.updatedAt = new Date().toISOString();
  if (shouldUseBlobs()) {
    const store = await getBlobStore();
    const setOptions = options.force
      ? {}
      : (etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    const result = await store.set(DB_KEY, JSON.stringify(db), setOptions);
    if (!options.force && result && result.modified === false) throw new WriteConflictError();
    return;
  }

  await fs.mkdir(path.dirname(LOCAL_DB_FILE), { recursive: true });
  await fs.writeFile(LOCAL_DB_FILE, JSON.stringify(db, null, 2));
}

function normalizeDb(db) {
  db.version = db.version || 1;
  db.revision = Number(db.revision || 0);
  db.users = db.users || {};
  db.sessions = db.sessions || {};
  db.tables = db.tables || {};
  db.audit = db.audit || [];

  const now = Date.now();
  for (const [token, session] of Object.entries(db.sessions)) {
    if (!session || session.expiresAt < now) delete db.sessions[token];
  }

  for (const user of Object.values(db.users)) {
    user.revision = Number(user.revision || 0);
  }

  for (const table of Object.values(db.tables)) {
    table.maxSeats = table.maxSeats || 6;
    table.seats = table.seats || Array.from({ length: table.maxSeats }, () => null);
    table.logs = table.logs || [];
    table.winners = table.winners || [];
    table.revision = Number(table.revision || 0);
    table.actionReceipts = table.actionReceipts || {};
    table.detachedPlayers = table.detachedPlayers || [];
    for (const player of table.seats) {
      if (player && db.users[player.userId]) {
        player.isBot = Boolean(db.users[player.userId].isBot);
      }
    }
  }
  return db;
}

async function withDb(mutator) {
  if (!shouldUseBlobs()) {
    const run = async () => {
      const { db } = await readDbEntry();
      const result = await mutator(db);
      db.revision = Number(db.revision || 0) + 1;
      await writeDbEntry(db);
      return result;
    };
    const next = localWriteQueue.then(run, run);
    localWriteQueue = next.catch(() => {});
    return next;
  }

  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt += 1) {
    const { db, etag } = await readDbEntry();
    try {
      const result = await mutator(db);
      db.revision = Number(db.revision || 0) + 1;
      await writeDbEntry(db, etag);
      return result;
    } catch (error) {
      if (!error.retryable) throw error;
      await waitForRetry(attempt);
    }
  }
  throw new HttpError(409, "牌桌状态繁忙，请重试");
}

function waitForRetry(attempt) {
  const delay = 25 * 2 ** attempt + crypto.randomInt(20);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
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
    revision: Number(user.revision || 0),
    isAdmin: Boolean(user.isAdmin),
    isBot: Boolean(user.isBot),
    createdAt: user.createdAt
  };
}

function getToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireUser(db, event, options = {}) {
  const token = getToken(event);
  const session = token ? db.sessions[token] : null;
  if (!session || session.expiresAt < Date.now()) {
    throw new HttpError(401, "请先登录");
  }
  const user = db.users[session.userId];
  if (!user) throw new HttpError(401, "登录状态已失效");
  if (options.refreshSession !== false) {
    session.expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
  }
  return user;
}

function requireAdmin(db, event, options = {}) {
  const user = requireUser(db, event, options);
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

function commandKey(user, body, scope) {
  const raw = String(body.commandId || body.actionId || "").trim();
  if (!raw || raw.length > 120) return "";
  return `${scope}:${user.id}:${raw}`;
}

function commandAlreadyApplied(table, user, body, scope) {
  const key = commandKey(user, body, scope);
  if (!key) return false;
  const receipt = table.actionReceipts?.[key];
  return Boolean(receipt && receipt.userId === user.id);
}

function assertFreshTableRevision(table, user, body) {
  const expectedRevision = Number(body.tableRevision);
  if (!Number.isFinite(expectedRevision) || expectedRevision <= 0) return;
  if (expectedRevision < Number(table.revision || 0)) {
    throw new HttpError(409, "牌桌状态已更新", { table: publicTable(table, user) });
  }
}

function rememberCommand(table, user, body, scope) {
  const key = commandKey(user, body, scope);
  if (!key) return;
  table.actionReceipts = table.actionReceipts || {};
  table.actionReceipts[key] = {
    userId: user.id,
    scope,
    revision: table.revision || 0,
    at: nowIso()
  };
  const entries = Object.entries(table.actionReceipts)
    .sort((a, b) => new Date(b[1].at) - new Date(a[1].at))
    .slice(0, 120);
  table.actionReceipts = Object.fromEntries(entries);
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
  table.detachedPlayers = [];
  clearTurnDeadline(table);

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
  setTurnDeadline(table);
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
  setTurnDeadline(table);
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
  setTurnDeadline(table);
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
  clearTurnDeadline(table);
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

  const all = [...handPlayers(table), ...(table.detachedPlayers || [])];
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
  clearTurnDeadline(table);
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
    revision: table.revision || 0,
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
    actionDeadlineAt: table.actionDeadlineAt || null,
    actionTimeoutMs: ACTION_TIMEOUT_MS,
    currentBet: table.currentBet,
    minRaise: table.minRaise,
    handNo: table.handNo || 0,
    revision: table.revision || 0,
    updatedAt: table.updatedAt,
    serverTime: nowIso(),
    pot: table.pot,
    community: table.community || [],
    winners: table.winners || [],
    logs: table.logs || [],
    youSeat: viewerSeat ? viewerSeat.seat : null,
    isOwner: Boolean(viewer && table.ownerId === viewer.id),
    controls: {
      canAct,
      toCall,
      minRaiseTo,
      maxRaiseTo,
      canLeave: Boolean(viewerSeat),
      canDisband: Boolean(viewer && (viewer.isAdmin || table.ownerId === viewer.id)),
      activeHand: ACTIVE_STAGES.has(table.status),
      actionDeadlineAt: table.actionDeadlineAt || null,
      actionTimeoutMs: ACTION_TIMEOUT_MS
    },
    seats: table.seats.map((player) => {
      if (!player) return null;
      const ownCards = viewer && player.userId === viewer.id;
      const reveal = table.status === "showdown" && table.revealed && !player.folded;
      return {
        seat: player.seat,
        userId: player.userId,
        username: player.username,
        isBot: Boolean(player.isBot),
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

function findPlayerTable(db, userId) {
  for (const table of Object.values(db.tables || {})) {
    const player = table.seats.find((seat) => seat && seat.userId === userId);
    if (player) return table;
  }
  return null;
}

function assertPlayerCanJoinTable(db, table, user) {
  const existingTable = findPlayerTable(db, user.id);
  if (existingTable && existingTable.id !== table.id) {
    throw new HttpError(409, `${user.username} 已在「${existingTable.name}」入座，离桌后才能加入其他牌桌`);
  }
}

function requireSeated(table, user) {
  const player = table.seats.find((seat) => seat && seat.userId === user.id);
  if (!player) throw new HttpError(403, "你还没有坐下");
  return player;
}

function createSeatRecord(user, seat, buyIn) {
  return {
    seat,
    userId: user.id,
    username: user.username,
    isBot: Boolean(user.isBot),
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
}

function sitUserAtTable(db, table, user, requestedBuyIn, requestedSeat = null) {
  const existing = table.seats.find((seat) => seat && seat.userId === user.id);
  if (existing) return existing;
  assertPlayerCanJoinTable(db, table, user);

  const buyIn = clampInt(requestedBuyIn || table.bigBlind * 50, table.bigBlind * 10, 1000000);
  if (user.chips < buyIn) throw new HttpError(400, "钱包筹码不足");
  const preferredSeat = requestedSeat == null ? null : clampInt(requestedSeat, 0, table.maxSeats - 1);
  const seat = preferredSeat != null && !table.seats[preferredSeat]
    ? preferredSeat
    : table.seats.findIndex((value) => !value);
  if (seat < 0) throw new HttpError(400, "牌桌已满");

  user.chips -= buyIn;
  touchUser(user);
  table.seats[seat] = createSeatRecord(user, seat, buyIn);
  addLog(table, `${user.username}${user.isBot ? " 机器人" : ""} 带入 ${buyIn} 筹码入座`);
  touchTable(table);
  return table.seats[seat];
}

function createBotUser(db, name, chips) {
  const cleanedName = cleanUsername(name || "");
  const baseName = cleanedName || randomBotName();
  let username = baseName;
  let suffix = 1;
  while (findUserByUsername(db, username)) {
    username = `${baseName.slice(0, 14)}_${suffix}`;
    suffix += 1;
  }
  const { salt, hash } = hashPassword(randomId(16));
  const bot = {
    id: randomId(10),
    username,
    salt,
    passwordHash: hash,
    chips,
    isAdmin: false,
    isBot: true,
    revision: 0,
    createdAt: nowIso()
  };
  db.users[bot.id] = bot;
  return bot;
}

function randomBotName() {
  const names = ["冷静河牌", "松凶阿K", "慢打师傅", "筹码猎手", "翻牌旅人", "小盲骑士", "坚果同花", "底池管家"];
  return names[crypto.randomInt(names.length)];
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
    revision: 0,
    actionReceipts: {},
    detachedPlayers: [],
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

function archiveDetachedContribution(table, player) {
  if (!ACTIVE_STAGES.has(table.status) || Number(player.contributed || 0) <= 0) return;
  table.detachedPlayers = table.detachedPlayers || [];
  table.detachedPlayers.push({
    userId: player.userId,
    username: player.username,
    stack: 0,
    bet: 0,
    contributed: player.contributed,
    folded: true,
    allIn: false,
    inHand: true,
    acted: true,
    hole: player.hole || []
  });
}

function settleAfterSeatRemoval(table, fromSeat) {
  if (!ACTIVE_STAGES.has(table.status)) return;
  const remaining = remainingPlayers(table);
  if (remaining.length === 1) {
    awardByFold(table, remaining[0]);
    return;
  }
  if (remaining.length === 0) {
    table.status = "waiting";
    table.currentTurnSeat = null;
    table.currentBet = 0;
    table.pot = 0;
    return;
  }
  const actors = actingPlayers(table);
  if (actors.length === 0) {
    runOutToShowdown(table);
    return;
  }
  const current = table.seats[table.currentTurnSeat];
  if (!current || !current.inHand || current.folded || current.allIn) {
    maybeAdvance(table, fromSeat);
    return;
  }
  if (actors.every((player) => player.acted && player.bet === table.currentBet)) {
    advanceStreet(table);
  }
}

function leaveSeat(db, table, user) {
  const player = requireSeated(table, user);
  const leavingSeat = player.seat;
  const active = ACTIVE_STAGES.has(table.status);

  if (active && player.inHand && !player.folded) {
    archiveDetachedContribution(table, player);
    player.folded = true;
    player.acted = true;
    player.lastAction = "弃牌离桌";
  }

  user.chips += player.stack;
  touchUser(user);
  table.seats[leavingSeat] = null;
  addLog(table, active
    ? `${user.username} 弃牌离桌，带走 ${player.stack}`
    : `${user.username} 离开牌桌，带走 ${player.stack}`);

  settleAfterSeatRemoval(table, leavingSeat);
  touchTable(table);
  if (seatedPlayers(table).length === 0) {
    for (const detached of table.detachedPlayers || []) {
      refundPlayer(db, detached, Number(detached.contributed || 0));
    }
    delete db.tables[table.id];
  }
}

function requireTableManager(table, user) {
  if (!user.isAdmin && table.ownerId !== user.id) throw new HttpError(403, "只有房主或管理员可以解散牌桌");
}

function refundPlayer(db, player, amount) {
  const user = db.users[player.userId];
  if (!user || amount <= 0) return;
  user.chips += amount;
  touchUser(user);
}

function disbandTable(db, table, actor) {
  requireTableManager(table, actor);
  const includeContributed = ACTIVE_STAGES.has(table.status);
  for (const player of seatedPlayers(table)) {
    refundPlayer(db, player, player.stack + (includeContributed ? Number(player.contributed || 0) : 0));
  }
  if (includeContributed) {
    for (const player of table.detachedPlayers || []) {
      refundPlayer(db, player, Number(player.contributed || 0));
    }
  }
  db.audit.unshift({
    at: nowIso(),
    actorId: actor.id,
    actor: actor.username,
    type: "disband_table",
    tableId: table.id,
    target: table.name,
    note: includeContributed ? "牌局中解散，退回本手投入" : "牌桌解散"
  });
  db.audit = db.audit.slice(0, 300);
  delete db.tables[table.id];
}

function touchTable(table) {
  table.revision = Number(table.revision || 0) + 1;
  table.updatedAt = nowIso();
}

function touchUser(user) {
  user.revision = Number(user.revision || 0) + 1;
}

function setTurnDeadline(table) {
  const player = table.seats[table.currentTurnSeat];
  if (ACTIVE_STAGES.has(table.status) && player && player.inHand && !player.folded && !player.allIn) {
    table.actionDeadlineAt = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();
  } else {
    table.actionDeadlineAt = null;
  }
}

function clearTurnDeadline(table) {
  table.actionDeadlineAt = null;
}

function isActionDeadlineExpired(table, at = Date.now()) {
  if (!ACTIVE_STAGES.has(table.status) || table.currentTurnSeat == null || !table.actionDeadlineAt) return false;
  return new Date(table.actionDeadlineAt).getTime() <= at;
}

function applyActionTimeouts(table, at = Date.now()) {
  let changed = false;
  let guard = 0;
  while (isActionDeadlineExpired(table, at) && guard < table.maxSeats + 6) {
    guard += 1;
    const player = table.seats[table.currentTurnSeat];
    if (!player || !player.inHand || player.folded || player.allIn) {
      setTurnDeadline(table);
      break;
    }
    player.folded = true;
    player.acted = true;
    player.lastAction = "超时弃牌";
    addLog(table, `${player.username} 20 秒未行动，自动弃牌`);
    maybeAdvance(table, player.seat);
    changed = true;
  }
  return changed;
}

function runAutomaticTableActions(table) {
  const timedOut = applyActionTimeouts(table);
  const bots = processBotTurns(table);
  return timedOut || bots;
}

function handleAction(table, user, body) {
  if (!ACTIVE_STAGES.has(table.status)) {
    throw new HttpError(400, "当前没有进行中的手牌", { table: publicTable(table, user) });
  }
  const player = requireSeated(table, user);
  if (!player.inHand || player.folded || player.allIn) throw new HttpError(400, "当前不能行动");
  if (table.currentTurnSeat !== player.seat) {
    throw new HttpError(409, "牌桌状态已更新", { table: publicTable(table, user) });
  }

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

function processBotTurns(table) {
  let changed = false;
  let guard = 0;
  while (ACTIVE_STAGES.has(table.status) && guard < 36) {
    guard += 1;
    const player = table.seats[table.currentTurnSeat];
    if (!player || !player.isBot) break;

    try {
      handleAction(table, { id: player.userId }, botDecision(table, player));
    } catch (error) {
      addLog(table, `${player.username} 机器人暂停：${error.message}`);
      break;
    }
    changed = true;
  }
  return changed;
}

function botDecision(table, player) {
  const toCall = Math.max(0, table.currentBet - player.bet);
  const maxTarget = player.bet + player.stack;
  const minTarget = table.currentBet === 0 ? table.bigBlind : table.currentBet + table.minRaise;
  const roll = crypto.randomInt(100);

  if (toCall <= 0) {
    if (player.stack > table.bigBlind * 4 && roll < 15) {
      return { action: "raise", amount: Math.min(maxTarget, minTarget) };
    }
    return { action: "check" };
  }

  if (toCall >= player.stack) {
    return roll < 58 ? { action: "allin" } : { action: "fold" };
  }

  const pressure = toCall / Math.max(player.stack, 1);
  if (pressure > 0.36 && roll < 72) return { action: "fold" };
  if (pressure > 0.2 && roll < 34) return { action: "fold" };

  if (roll > 86 && maxTarget > minTarget) {
    const target = Math.min(maxTarget, minTarget + table.bigBlind * crypto.randomInt(1, 4));
    return { action: "raise", amount: target };
  }

  return { action: "call" };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});

  try {
    await configureBlobs(event);
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
          revision: 0,
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
      const result = await withDb((db) => {
        const user = requireUser(db, event);
        return { user: userPublic(user) };
      });
      return json(200, result);
    }

    if (segments[0] === "admin") {
      if (method === "GET" && segments[1] === "users") {
        const db = await readDb();
        requireAdmin(db, event, { refreshSession: false });
        return json(200, {
          users: Object.values(db.users).map(userPublic).sort((a, b) => a.username.localeCompare(b.username)),
          tables: Object.values(db.tables).map(tableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
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
          touchUser(user);
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

      if (method === "POST" && segments[1] === "bots") {
        const result = await withDb((db) => {
          const admin = requireAdmin(db, event);
          const table = getTableOrThrow(db, body.tableId);
          ensureWaitingForSeatChange(table);
          const buyIn = clampInt(body.buyIn || table.bigBlind * 50, table.bigBlind * 10, 1000000);
          const bot = createBotUser(db, body.name, Math.max(buyIn, 1000000));
          sitUserAtTable(db, table, bot, buyIn, body.seat == null ? null : Number(body.seat));
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: "add_bot",
            targetId: bot.id,
            target: bot.username,
            tableId: table.id,
            note: `${table.name} · 带入 ${buyIn}`
          });
          db.audit = db.audit.slice(0, 300);
          return {
            bot: userPublic(bot),
            table: tableSummary(table),
            users: Object.values(db.users).map(userPublic).sort((a, b) => a.username.localeCompare(b.username)),
            tables: Object.values(db.tables).map(tableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
            audit: db.audit.slice(0, 80)
          };
        });
        return json(200, result);
      }
    }

    if (method === "GET" && segments[0] === "lobby") {
      const db = await readDb();
      const user = requireUser(db, event, { refreshSession: false });
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
          sitUserAtTable(db, table, user, body.buyIn || table.bigBlind * 50, body.seat == null ? null : Number(body.seat));
          return { user: userPublic(user), table: publicTable(table, user) };
        });
        return json(201, result);
      }

      if (method === "GET" && segments[1]) {
        const db = await readDb();
        const user = requireUser(db, event, { refreshSession: false });
        const table = getTableOrThrow(db, segments[1]);
        if (seatedPlayers(table).length === 0) throw new HttpError(404, "牌桌已解散");
        const currentPlayer = table.seats[table.currentTurnSeat];
        const since = Number(event.queryStringParameters?.since || -1);
        const needsAutomaticAction = Boolean(currentPlayer?.isBot || isActionDeadlineExpired(table));

        if (!needsAutomaticAction) {
          if (since >= Number(table.revision || 0)) {
            return json(200, {
              user: userPublic(user),
              table: null,
              unchanged: true,
              revision: table.revision || 0,
              serverTime: nowIso()
            });
          }
          return json(200, { user: userPublic(user), table: publicTable(table, user) });
        }

        const result = await withDb((freshDb) => {
          const freshUser = requireUser(freshDb, event, { refreshSession: false });
          const freshTable = getTableOrThrow(freshDb, segments[1]);
          if (seatedPlayers(freshTable).length === 0) throw new HttpError(404, "牌桌已解散");
          const changed = runAutomaticTableActions(freshTable);
          if (changed) touchTable(freshTable);
          return { user: userPublic(freshUser), table: publicTable(freshTable, freshUser) };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "join") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          ensureWaitingForSeatChange(table);
          sitUserAtTable(db, table, user, body.buyIn, body.seat == null ? null : Number(body.seat));
          return { user: userPublic(user), table: publicTable(table, user) };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "leave") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          leaveSeat(db, table, user);
          return { user: userPublic(user), table: db.tables[table.id] ? publicTable(table, user) : null };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "disband") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          disbandTable(db, table, user);
          return {
            user: userPublic(db.users[user.id]),
            tables: Object.values(db.tables).map(tableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
          };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "start") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          requireSeated(table, user);
          if (commandAlreadyApplied(table, user, body, "start")) {
            return { table: publicTable(table, user), duplicate: true };
          }
          assertFreshTableRevision(table, user, body);
          if (ACTIVE_STAGES.has(table.status)) throw new HttpError(400, "手牌已经开始");
          startHand(table);
          runAutomaticTableActions(table);
          touchTable(table);
          rememberCommand(table, user, body, "start");
          return { table: publicTable(table, user) };
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] && segments[2] === "action") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          if (commandAlreadyApplied(table, user, body, "action")) {
            return { table: publicTable(table, user), duplicate: true };
          }
          assertFreshTableRevision(table, user, body);
          const timeoutChanged = applyActionTimeouts(table);
          const player = table.seats.find((seat) => seat && seat.userId === user.id);
          if (timeoutChanged && (!player || player.folded || player.allIn || table.currentTurnSeat !== player.seat)) {
            runAutomaticTableActions(table);
            touchTable(table);
            return { table: publicTable(table, user), timedOut: true };
          }
          handleAction(table, user, body);
          runAutomaticTableActions(table);
          touchTable(table);
          rememberCommand(table, user, body, "action");
          return { table: publicTable(table, user) };
        });
        return json(200, result);
      }
    }

    throw new HttpError(404, "接口不存在");
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    return json(status, { error: error.message || "服务器错误", ...(error.payload || {}) });
  }
};
