// Cloudflare Worker + Durable Object backend for the poker app.
// The frontend keeps using same-origin /api/*, while all game state is authoritative inside PokerGame.

const ACTIVE_STAGES = new Set(["preflop", "flop", "turn", "river"]);
const ACTION_TIMEOUT_MS = 20000;
const ONLINE_WINDOW_MS = 60000;
const PRESENCE_TOUCH_INTERVAL_MS = 15000;
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
const CHAT_HISTORY_LIMIT = 30;
const QUICK_MESSAGE_LIMIT = 16;
const TABLE_SEAT_OPTIONS = [3, 5, 7, 9];
const DEFAULT_MAX_SEATS = 9;
const AUDIO_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const AUDIO_UPLOAD_CHUNK_MAX_BYTES = 1024 * 1024;
const AUDIO_SOURCE_MAX_LENGTH = 28 * 1024 * 1024;
const AUDIO_EVENT_LIMIT = 80;
const AUDIO_ACTIONS = ["start", "deal", "fold", "check", "call", "bet", "raise", "allin", "blind", "timeout", "showdown"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["S", "H", "D", "C"];
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));
const SLOT_HISTORY_LIMIT = 120;
const SLOT_MIN_BET = 10;
const SLOT_MAX_BET = 100000;
const BLACKJACK_HISTORY_LIMIT = 80;
const BLACKJACK_MIN_BET = 10;
const BLACKJACK_MAX_BET = 100000;
const BLACKJACK_TABLE_SEAT_OPTIONS = [3, 5, 7];
const BLACKJACK_DEFAULT_MAX_SEATS = 5;
const BLACKJACK_ACTION_TIMEOUT_MS = 20000;
const SLOT_SYMBOLS = [
  { id: "cherry", label: "樱桃", weight: 22, triple: 5, pair: 1 },
  { id: "lemon", label: "柠檬", weight: 21, triple: 5, pair: 1 },
  { id: "clover", label: "四叶草", weight: 18, triple: 7, pair: 2 },
  { id: "bell", label: "金铃", weight: 15, triple: 9, pair: 2 },
  { id: "horseshoe", label: "马蹄铁", weight: 13, triple: 10, pair: 2 },
  { id: "bar", label: "金条", weight: 11, triple: 14, pair: 3 },
  { id: "coin", label: "金币", weight: 10, triple: 16, pair: 3 },
  { id: "crown", label: "皇冠", weight: 7, triple: 22, pair: 5 },
  { id: "seven", label: "幸运 7", weight: 6, triple: 30, pair: 4 },
  { id: "diamond", label: "钻石", weight: 4, triple: 60, pair: 6 }
];
const SLOT_SPECIAL_COMBOS = [
  { ids: ["crown", "diamond", "seven"], title: "皇家幸运组合", multiplier: 12, tier: "jackpot" },
  { ids: ["bar", "coin", "horseshoe"], title: "黄金连线组合", multiplier: 6, tier: "win" },
  { ids: ["cherry", "clover", "lemon"], title: "水果幸运组合", multiplier: 3, tier: "win" }
];

class HttpError extends Error {
  constructor(statusCode, message, payload = {}) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function defaultDb() {
  return {
    version: 1,
    revision: 0,
    users: {},
    sessions: {},
    tables: {},
    slotHistory: [],
    blackjackTables: {},
    blackjackHands: {},
    blackjackHistory: [],
    blackjackReceipts: {},
    audit: []
  };
}

function defaultAudioSettings() {
  return {
    bgm: { src: "", name: "", volume: 0.36, enabled: false },
    actions: {},
    quickMessages: {}
  };
}

function normalizeDb(db) {
  db.version = db.version || 1;
  db.revision = Number(db.revision || 0);
  db.users = db.users || {};
  db.sessions = db.sessions || {};
  db.tables = db.tables || {};
  db.slotHistory = Array.isArray(db.slotHistory) ? db.slotHistory.slice(0, SLOT_HISTORY_LIMIT) : [];
  db.blackjackTables = db.blackjackTables || {};
  db.blackjackHands = db.blackjackHands || {};
  db.blackjackHistory = Array.isArray(db.blackjackHistory) ? db.blackjackHistory.slice(0, BLACKJACK_HISTORY_LIMIT) : [];
  db.blackjackReceipts = db.blackjackReceipts || {};
  db.audit = db.audit || [];
  db.quickMessages = normalizeQuickMessages(db.quickMessages);
  db.audioSettings = normalizeAudioSettings(db.audioSettings);

  const now = Date.now();
  for (const [token, session] of Object.entries(db.sessions)) {
    if (!session || session.expiresAt < now) delete db.sessions[token];
  }

  for (const user of Object.values(db.users)) {
    user.revision = Number(user.revision || 0);
  }

  for (const table of Object.values(db.tables)) {
    table.maxSeats = normalizePersistedMaxSeats(table);
    table.seats = table.seats || Array.from({ length: table.maxSeats }, () => null);
    while (table.seats.length < table.maxSeats) table.seats.push(null);
    table.logs = table.logs || [];
    table.chat = table.chat || [];
    table.quickMessages = normalizeQuickMessages(table.quickMessages || db.quickMessages);
    table.audioSettings = normalizeAudioSettings(table.audioSettings || db.audioSettings);
    table.audioEvents = Array.isArray(table.audioEvents) ? table.audioEvents.slice(-AUDIO_EVENT_LIMIT) : [];
    table.audioSeq = Number(table.audioSeq || 0);
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
  for (const table of Object.values(db.blackjackTables)) {
    table.type = "blackjack";
    table.maxSeats = normalizePersistedBlackjackMaxSeats(table);
    table.seats = Array.isArray(table.seats) ? table.seats : Array.from({ length: table.maxSeats }, () => null);
    while (table.seats.length < table.maxSeats) table.seats.push(null);
    table.seats = table.seats.slice(0, table.maxSeats);
    table.status = ["waiting", "playing", "showdown"].includes(table.status) ? table.status : "waiting";
    table.deck = Array.isArray(table.deck) ? table.deck : [];
    table.dealerCards = Array.isArray(table.dealerCards) ? table.dealerCards : [];
    table.currentTurnSeat = table.currentTurnSeat ?? null;
    table.defaultBet = clampInt(table.defaultBet || 100, BLACKJACK_MIN_BET, BLACKJACK_MAX_BET);
    table.minBet = clampInt(table.minBet || BLACKJACK_MIN_BET, BLACKJACK_MIN_BET, BLACKJACK_MAX_BET);
    table.maxBet = clampInt(table.maxBet || BLACKJACK_MAX_BET, table.minBet, BLACKJACK_MAX_BET);
    table.pot = Number(table.pot || 0);
    table.handNo = Number(table.handNo || 0);
    table.logs = Array.isArray(table.logs) ? table.logs.slice(0, 80) : [];
    table.chat = Array.isArray(table.chat) ? table.chat.slice(-CHAT_HISTORY_LIMIT) : [];
    table.quickMessages = normalizeQuickMessages(table.quickMessages || db.quickMessages);
    table.audioSettings = normalizeAudioSettings(table.audioSettings || db.audioSettings);
    table.audioEvents = Array.isArray(table.audioEvents) ? table.audioEvents.slice(-AUDIO_EVENT_LIMIT) : [];
    table.audioSeq = Number(table.audioSeq || 0);
    table.results = Array.isArray(table.results) ? table.results : [];
    table.revision = Number(table.revision || 0);
    table.actionReceipts = table.actionReceipts || {};
    for (const player of table.seats) {
      if (!player) continue;
      player.cards = Array.isArray(player.cards) ? player.cards : [];
      player.stack = Number(player.stack || 0);
      player.bet = Number(player.bet || 0);
      player.seat = Number(player.seat || 0);
      player.status = player.status || "waiting";
      player.result = player.result || null;
      player.isBot = Boolean(db.users[player.userId]?.isBot || player.isBot);
    }
  }
  return db;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-client-id"
    },
    body: JSON.stringify(payload)
  };
}

function jsonResponse(statusCode, payload) {
  return responseFromResult(json(statusCode, payload));
}

function requestToAuthEvent(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [key, value] of request.headers.entries()) headers[key] = value;
  return {
    httpMethod: request.method,
    path: url.pathname,
    headers,
    body: "",
    isBase64Encoded: false,
    queryStringParameters: Object.fromEntries(url.searchParams.entries())
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? new TextDecoder().decode(Uint8Array.from(atob(event.body), (char) => char.charCodeAt(0)))
    : event.body;
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
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function randomInt(min, max = null) {
  const lower = max == null ? 0 : min;
  const upper = max == null ? min : max;
  if (upper <= lower) return lower;
  const range = upper - lower;
  const limit = Math.floor(0xffffffff / range) * range;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return lower + (values[0] % range);
}

function normalizeMaxSeats(value) {
  const requested = clampInt(value || DEFAULT_MAX_SEATS, TABLE_SEAT_OPTIONS[0], TABLE_SEAT_OPTIONS[TABLE_SEAT_OPTIONS.length - 1]);
  return TABLE_SEAT_OPTIONS.find((option) => option >= requested) || TABLE_SEAT_OPTIONS[TABLE_SEAT_OPTIONS.length - 1];
}

function normalizePersistedMaxSeats(table) {
  const current = clampInt(table?.maxSeats || DEFAULT_MAX_SEATS, 2, 10);
  const normalized = normalizeMaxSeats(current);
  if (normalized >= current) return normalized;
  const seats = Array.isArray(table?.seats) ? table.seats : [];
  return seats.slice(normalized).some(Boolean) ? current : normalized;
}

function normalizeBlackjackMaxSeats(value) {
  const requested = clampInt(
    value || BLACKJACK_DEFAULT_MAX_SEATS,
    BLACKJACK_TABLE_SEAT_OPTIONS[0],
    BLACKJACK_TABLE_SEAT_OPTIONS[BLACKJACK_TABLE_SEAT_OPTIONS.length - 1]
  );
  return BLACKJACK_TABLE_SEAT_OPTIONS.find((option) => option >= requested) || BLACKJACK_TABLE_SEAT_OPTIONS[BLACKJACK_TABLE_SEAT_OPTIONS.length - 1];
}

function normalizePersistedBlackjackMaxSeats(table) {
  const current = clampInt(table?.maxSeats || BLACKJACK_DEFAULT_MAX_SEATS, 2, 7);
  const normalized = normalizeBlackjackMaxSeats(current);
  if (normalized >= current) return normalized;
  const seats = Array.isArray(table?.seats) ? table.seats : [];
  return seats.slice(normalized).some(Boolean) ? current : normalized;
}

function normalizeAudioSettings(settings = {}) {
  const defaults = defaultAudioSettings();
  const source = settings && typeof settings === "object" ? settings : {};
  const actions = {};
  for (const [key, asset] of Object.entries(source.actions || {})) {
    if (!AUDIO_ACTIONS.includes(key)) continue;
    const normalized = normalizeAudioAsset(asset);
    if (normalized.src) actions[key] = normalized;
  }
  const quickMessages = {};
  for (const [message, asset] of Object.entries(source.quickMessages || {})) {
    const text = normalizeQuickMessage(message, { allowEmpty: true });
    if (!text) continue;
    const normalized = normalizeAudioAsset(asset);
    if (normalized.src) quickMessages[text] = normalized;
  }
  return {
    bgm: normalizeAudioAsset(source.bgm || defaults.bgm, { defaultVolume: defaults.bgm.volume, allowDisabled: true }),
    actions,
    quickMessages
  };
}

function normalizeAudioAsset(asset = {}, options = {}) {
  const source = asset && typeof asset === "object" ? asset : {};
  const src = normalizeAudioSource(source.src || source.url || "");
  const name = String(source.name || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 80);
  const volume = clampNumber(source.volume ?? options.defaultVolume ?? 0.8, 0, 1);
  const enabled = options.allowDisabled ? Boolean(source.enabled && src) : Boolean(src);
  return {
    src,
    name,
    volume,
    enabled
  };
}

function normalizeAudioSource(value) {
  const src = String(value || "").trim();
  if (!src) return "";
  if (src.length > AUDIO_SOURCE_MAX_LENGTH) throw new HttpError(400, "单个音频文件太大，请使用更短的音频或外链");
  if (/^https?:\/\//i.test(src) || /^\/[^\s]*$/i.test(src) || /^data:audio\/[a-z0-9.+-]+;base64,/i.test(src)) return src;
  throw new HttpError(400, "音频必须是 http(s) 地址、站内 /audio 路径，或上传的音频文件");
}

function cleanAudioUploadId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(id)) throw new HttpError(400, "音频上传编号无效");
  return id;
}

function audioChunkKey(uploadId, index) {
  return `audio:${uploadId}:chunk:${index}`;
}

function audioPartKey(uploadId, index) {
  return `audio:${uploadId}:part:${index}`;
}

function audioMetaKey(uploadId) {
  return `audio:${uploadId}:meta`;
}

function cleanAudioName(name) {
  return String(name || "audio")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "audio";
}

function normalizeAudioMimeType(value) {
  const mime = String(value || "").trim().toLowerCase();
  if (/^audio\/[a-z0-9.+-]+$/.test(mime)) return mime;
  return "audio/mpeg";
}

function parseAudioRange(header, size) {
  const match = String(header || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    throw new HttpError(416, "音频范围无效");
  }
  return { start, end: Math.min(end, size - 1) };
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
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

function normalizeQuickMessage(message, options = {}) {
  const raw = String(message || "").replace(/\s+/g, " ").trim();
  if (!raw && options.allowEmpty) return "";
  const text = normalizeChatMessage(raw);
  if ([...text].length > CHAT_MAX_LENGTH) throw new HttpError(400, `快捷语不能超过 ${CHAT_MAX_LENGTH} 个字`);
  return text;
}

function normalizeQuickMessages(messages) {
  const source = Array.isArray(messages) && messages.length ? messages : TAUNT_MESSAGES;
  const unique = [];
  for (const message of source) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    if (!text || [...text].length > CHAT_MAX_LENGTH || unique.includes(text)) continue;
    unique.push(text);
    if (unique.length >= QUICK_MESSAGE_LIMIT) break;
  }
  return unique.length ? unique : [...TAUNT_MESSAGES];
}

async function hashPassword(password, salt = randomId(16)) {
  const iterations = 100000;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    key,
    256
  );
  return { salt, hash: `pbkdf2$${iterations}$${hexFromBytes(new Uint8Array(bits))}` };
}

async function verifyPassword(password, user) {
  if (!user?.passwordHash?.startsWith("pbkdf2$")) return false;
  const [, iterationText, expected] = user.passwordHash.split("$");
  const iterations = Number(iterationText || 0);
  if (!iterations || !expected) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(user.salt), iterations, hash: "SHA-256" },
    key,
    256
  );
  return constantTimeEqual(expected, hexFromBytes(new Uint8Array(bits)));
}

function hexFromBytes(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
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
  const user = db.users[userId];
  if (user) markUserOnline(user, Date.now(), { force: true });
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
    lastSeenAt: user.lastSeenAt || null,
    createdAt: user.createdAt
  };
}

function adminUserPublic(user) {
  return {
    ...userPublic(user),
    password: user.plainPassword || "",
    hasPassword: Boolean(user.plainPassword)
  };
}

function getToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function userFromToken(db, token) {
  const session = token ? db.sessions[token] : null;
  if (!session || session.expiresAt < Date.now()) throw new HttpError(401, "请先登录");
  const user = db.users[session.userId];
  if (!user) throw new HttpError(401, "登录状态已失效");
  return user;
}

function presenceTime(user) {
  const stamp = new Date(user?.lastSeenAt || 0).getTime();
  return Number.isFinite(stamp) ? stamp : 0;
}

function isUserOnline(user, at = Date.now()) {
  const lastSeen = presenceTime(user);
  return lastSeen > 0 && at - lastSeen <= ONLINE_WINDOW_MS;
}

function shouldTouchPresence(user, at = Date.now()) {
  const lastSeen = presenceTime(user);
  return !lastSeen || at - lastSeen >= PRESENCE_TOUCH_INTERVAL_MS;
}

function markUserOnline(user, at = Date.now(), options = {}) {
  if (!user || (!options.force && !shouldTouchPresence(user, at))) return false;
  const wasOnline = isUserOnline(user, at);
  const stamp = new Date(at).toISOString();
  user.lastSeenAt = stamp;
  if (!wasOnline || !user.onlineSinceAt) user.onlineSinceAt = stamp;
  return true;
}

function onlineLocation(db, user) {
  const pokerTable = findPlayerTable(db, user.id);
  if (pokerTable) {
    return { type: "holdem", label: pokerTable.name, tableId: pokerTable.id };
  }
  const blackjackTable = findBlackjackPlayerTable(db, user.id);
  if (blackjackTable) {
    return { type: "blackjack", label: blackjackTable.name, tableId: blackjackTable.id };
  }
  return { type: "lobby", label: "大厅" };
}

function onlineUserPublic(db, user, at = Date.now()) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: Boolean(user.isAdmin),
    isBot: Boolean(user.isBot),
    lastSeenAt: user.lastSeenAt || null,
    onlineSinceAt: user.onlineSinceAt || user.lastSeenAt || null,
    location: onlineLocation(db, user),
    isSelf: false,
    online: isUserOnline(user, at)
  };
}

function onlineUsersPayload(db, viewer = null) {
  const at = Date.now();
  return Object.values(db.users || {})
    .filter((user) => isUserOnline(user, at))
    .map((user) => ({
      ...onlineUserPublic(db, user, at),
      isSelf: Boolean(viewer && user.id === viewer.id)
    }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
    });
}

function requireUser(db, event, options = {}) {
  const token = getToken(event);
  const user = userFromToken(db, token);
  const session = db.sessions[token];
  if (options.refreshSession !== false) {
    session.expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
  }
  if (options.markPresence !== false) markUserOnline(user);
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
    const j = randomInt(i + 1);
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

function addChatMessage(table, player, text, at) {
  table.chat = table.chat || [];
  table.chat.push({
    at,
    text,
    userId: player.userId,
    username: player.username,
    seat: player.seat,
    isBot: Boolean(player.isBot),
    handNo: table.handNo || 0
  });
  table.chat = table.chat.slice(-CHAT_HISTORY_LIMIT);
}

function addAudioEvent(table, type, player = null, extras = {}) {
  table.audioEvents = Array.isArray(table.audioEvents) ? table.audioEvents : [];
  table.audioSeq = Number(table.audioSeq || 0) + 1;
  const event = {
    id: `${table.handNo || 0}-${table.audioSeq}`,
    seq: table.audioSeq,
    type,
    at: nowIso(),
    handNo: table.handNo || 0,
    userId: player?.userId || null,
    username: player?.username || "",
    seat: player?.seat ?? null,
    ...extras
  };
  table.audioEvents.push(event);
  table.audioEvents = table.audioEvents.slice(-AUDIO_EVENT_LIMIT);
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
  addAudioEvent(table, "blind", player, { amount: paid, label });
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
  addAudioEvent(table, "start", null, { stage: table.status });

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
  addAudioEvent(table, "deal", null, { stage: table.status, communityCount: table.community.length });
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
  addAudioEvent(table, "showdown", winner, { amount, byFold: true });
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
  addAudioEvent(table, "showdown", null, { winners: table.winners });
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

function lobbyPayload(db, user) {
  return {
    type: "lobby",
    user: userPublic(user),
    tables: Object.values(db.tables).map(tableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    onlineUsers: onlineUsersPayload(db, user),
    serverTime: nowIso()
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
  const revealedWinnerIds = new Set(
    table.status === "showdown" && table.revealed
      ? (table.winners || []).map((winner) => winner.userId)
      : []
  );

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
    revealed: Boolean(table.revealed),
    logs: table.logs || [],
    chat: table.chat || [],
    quickMessages: table.quickMessages || TAUNT_MESSAGES,
    audioSettings: normalizeAudioSettings(table.audioSettings),
    audioEvents: Array.isArray(table.audioEvents) ? table.audioEvents.slice(-AUDIO_EVENT_LIMIT) : [],
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
      const reveal = revealedWinnerIds.has(player.userId) && !player.folded;
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
        taunt: player.taunt || null,
        bestHandName: reveal ? player.bestHandName : null,
        hole: ownCards || reveal ? player.hole : (player.hole || []).map(() => null)
      };
    })
  };
}

function realtimePayload(db, attachment = {}) {
  const user = db.users[attachment.userId];
  if (!user) return { type: "error", error: "登录状态已失效", serverTime: nowIso() };
  if (attachment.tableId) {
    const table = db.tables[attachment.tableId];
    return {
      type: "table",
      user: userPublic(user),
      table: table && seatedPlayers(table).length > 0 ? publicTable(table, user) : null,
      tableId: attachment.tableId,
      serverTime: nowIso()
    };
  }
  return lobbyPayload(db, user);
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
  const existingBlackjackTable = findBlackjackPlayerTable(db, user.id);
  if (existingBlackjackTable) {
    throw new HttpError(409, `${user.username} 已在「${existingBlackjackTable.name}」21点桌入座，离桌后才能加入其他牌桌`);
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

async function createBotUser(db, name, chips) {
  const cleanedName = cleanUsername(name || "");
  const baseName = cleanedName || randomBotName();
  let username = baseName;
  let suffix = 1;
  while (findUserByUsername(db, username)) {
    username = `${baseName.slice(0, 14)}_${suffix}`;
    suffix += 1;
  }
  const password = randomId(8);
  const { salt, hash } = await hashPassword(password);
  const bot = {
    id: randomId(10),
    username,
    salt,
    passwordHash: hash,
    plainPassword: password,
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
  return names[randomInt(names.length)];
}

function slotSymbolPublic(symbol) {
  return {
    id: symbol.id,
    label: symbol.label,
    triple: symbol.triple,
    pair: symbol.pair
  };
}

function slotHistoryForUser(db, userId) {
  return (db.slotHistory || [])
    .filter((entry) => entry.userId === userId)
    .slice(0, 18);
}

function slotsPayload(db, user) {
  return {
    user: userPublic(user),
    minBet: SLOT_MIN_BET,
    maxBet: SLOT_MAX_BET,
    symbols: SLOT_SYMBOLS.map(slotSymbolPublic),
    specialCombos: SLOT_SPECIAL_COMBOS,
    history: slotHistoryForUser(db, user.id)
  };
}

function drawSlotSymbol() {
  const total = SLOT_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
  let roll = randomInt(total);
  for (const symbol of SLOT_SYMBOLS) {
    roll -= symbol.weight;
    if (roll < 0) return symbol;
  }
  return SLOT_SYMBOLS[0];
}

function scoreSlot(symbols, bet) {
  const counts = new Map();
  for (const symbol of symbols) counts.set(symbol.id, (counts.get(symbol.id) || 0) + 1);
  const triple = symbols.find((symbol) => counts.get(symbol.id) === 3);
  if (triple) {
    const payout = bet * triple.triple;
    return {
      payout,
      multiplier: triple.triple,
      title: `${triple.label} 三连`,
      tier: triple.id === "diamond" || triple.id === "seven" ? "jackpot" : "win"
    };
  }

  const symbolSetKey = symbols.map((symbol) => symbol.id).sort().join("|");
  const special = SLOT_SPECIAL_COMBOS.find((combo) => combo.ids.slice().sort().join("|") === symbolSetKey);
  if (special) {
    return {
      payout: bet * special.multiplier,
      multiplier: special.multiplier,
      title: special.title,
      tier: special.tier
    };
  }

  const pair = symbols.find((symbol) => counts.get(symbol.id) === 2);
  if (pair) {
    const multiplier = pair.pair || 1;
    return {
      payout: bet * multiplier,
      multiplier,
      title: `${pair.label} 一对`,
      tier: multiplier > 1 ? "win" : "push"
    };
  }

  return {
    payout: 0,
    multiplier: 0,
    title: "未中奖",
    tier: "miss"
  };
}

function spinSlots(db, user, body) {
  const bet = clampInt(body.bet, SLOT_MIN_BET, SLOT_MAX_BET);
  if (bet > user.chips) throw new HttpError(400, "钱包筹码不足");
  const symbols = [drawSlotSymbol(), drawSlotSymbol(), drawSlotSymbol()];
  const score = scoreSlot(symbols, bet);
  user.chips = Math.max(0, user.chips - bet + score.payout);
  touchUser(user);

  const entry = {
    id: randomId(6),
    at: nowIso(),
    userId: user.id,
    username: user.username,
    bet,
    payout: score.payout,
    profit: score.payout - bet,
    multiplier: score.multiplier,
    title: score.title,
    tier: score.tier,
    symbols: symbols.map((symbol) => symbol.id)
  };
  db.slotHistory.unshift(entry);
  db.slotHistory = db.slotHistory.slice(0, SLOT_HISTORY_LIMIT);
  return {
    user: userPublic(user),
    result: entry,
    history: slotHistoryForUser(db, user.id)
  };
}

function blackjackHistoryForUser(db, userId) {
  return (db.blackjackHistory || [])
    .filter((entry) => entry.userId === userId)
    .slice(0, 18);
}

function blackjackPayload(db, user) {
  return {
    user: userPublic(user),
    minBet: BLACKJACK_MIN_BET,
    maxBet: BLACKJACK_MAX_BET,
    hand: publicBlackjackHand(db.blackjackHands?.[user.id] || null),
    history: blackjackHistoryForUser(db, user.id)
  };
}

function blackjackCommandKey(user, body, action) {
  const raw = String(body.commandId || "").trim();
  if (!raw || raw.length > 120) return "";
  return `blackjack:${action}:${user.id}:${raw}`;
}

function rememberBlackjackCommand(db, key, payload) {
  if (!key) return;
  db.blackjackReceipts = db.blackjackReceipts || {};
  db.blackjackReceipts[key] = { at: nowIso(), payload };
  const entries = Object.entries(db.blackjackReceipts)
    .sort((a, b) => new Date(b[1].at) - new Date(a[1].at))
    .slice(0, 160);
  db.blackjackReceipts = Object.fromEntries(entries);
}

function withBlackjackReceipt(db, user, body, action, mutator) {
  const key = blackjackCommandKey(user, body, action);
  const receipt = key ? db.blackjackReceipts?.[key] : null;
  if (receipt?.payload) return receipt.payload;
  const payload = mutator();
  rememberBlackjackCommand(db, key, payload);
  return payload;
}

function blackjackCardScore(card) {
  const rank = card?.[0];
  if (rank === "A") return 11;
  if (["T", "J", "Q", "K"].includes(rank)) return 10;
  return clampInt(rank, 0, 10);
}

function blackjackScore(cards = []) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (!card) continue;
    total += blackjackCardScore(card);
    if (card[0] === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0 && total <= 21;
  return {
    total,
    soft,
    busted: total > 21,
    blackjack: cards.length === 2 && total === 21
  };
}

function blackjackScoreLabel(cards = []) {
  const score = blackjackScore(cards);
  if (score.blackjack) return "Blackjack";
  if (score.busted) return `爆牌 ${score.total}`;
  return `${score.soft ? "软 " : ""}${score.total} 点`;
}

function publicBlackjackHand(hand) {
  if (!hand) return null;
  const settled = hand.status === "settled";
  const dealerCards = settled
    ? hand.dealerCards || []
    : (hand.dealerCards || []).map((card, index) => (index === 0 ? card : null));
  const playerScore = blackjackScore(hand.playerCards || []);
  const dealerScore = settled ? blackjackScore(hand.dealerCards || []) : blackjackScore((hand.dealerCards || []).slice(0, 1));
  return {
    id: hand.id,
    status: hand.status,
    bet: hand.bet,
    playerCards: hand.playerCards || [],
    dealerCards,
    playerScore,
    dealerScore,
    playerLabel: blackjackScoreLabel(hand.playerCards || []),
    dealerLabel: settled ? blackjackScoreLabel(hand.dealerCards || []) : "暗牌",
    result: hand.result || null,
    actions: {
      canHit: hand.status === "playing",
      canStand: hand.status === "playing",
      canDouble: hand.status === "playing" && (hand.playerCards || []).length === 2 && !hand.doubled
    },
    createdAt: hand.createdAt,
    updatedAt: hand.updatedAt
  };
}

function startBlackjackHand(db, user, body) {
  const existing = db.blackjackHands?.[user.id];
  if (existing?.status === "playing") throw new HttpError(409, "当前 21 点牌局还没有结束");

  const bet = clampInt(body.bet, BLACKJACK_MIN_BET, BLACKJACK_MAX_BET);
  if (bet > user.chips) throw new HttpError(400, "钱包筹码不足");

  const deck = makeDeck();
  const hand = {
    id: randomId(8),
    userId: user.id,
    username: user.username,
    bet,
    deck,
    playerCards: [deck.pop(), deck.pop()],
    dealerCards: [deck.pop(), deck.pop()],
    status: "playing",
    doubled: false,
    result: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  user.chips -= bet;
  touchUser(user);
  db.blackjackHands[user.id] = hand;

  const player = blackjackScore(hand.playerCards);
  const dealer = blackjackScore(hand.dealerCards);
  if (player.blackjack || dealer.blackjack) {
    settleBlackjackHand(db, user, hand, { immediateBlackjack: true });
  }

  return blackjackPayload(db, user);
}

function requireActiveBlackjackHand(db, user) {
  const hand = db.blackjackHands?.[user.id];
  if (!hand || hand.status !== "playing") throw new HttpError(400, "当前没有进行中的 21 点牌局");
  return hand;
}

function hitBlackjackHand(db, user) {
  const hand = requireActiveBlackjackHand(db, user);
  hand.playerCards.push(hand.deck.pop());
  hand.updatedAt = nowIso();
  const score = blackjackScore(hand.playerCards);
  if (score.busted || score.total === 21) settleBlackjackHand(db, user, hand);
  return blackjackPayload(db, user);
}

function standBlackjackHand(db, user) {
  const hand = requireActiveBlackjackHand(db, user);
  settleBlackjackHand(db, user, hand);
  return blackjackPayload(db, user);
}

function doubleBlackjackHand(db, user) {
  const hand = requireActiveBlackjackHand(db, user);
  if (hand.doubled || hand.playerCards.length !== 2) throw new HttpError(400, "只有前两张牌时可以加倍");
  if (user.chips < hand.bet) throw new HttpError(400, "钱包筹码不足，无法加倍");
  user.chips -= hand.bet;
  hand.bet *= 2;
  hand.doubled = true;
  hand.playerCards.push(hand.deck.pop());
  hand.updatedAt = nowIso();
  touchUser(user);
  settleBlackjackHand(db, user, hand);
  return blackjackPayload(db, user);
}

function playDealerBlackjack(hand) {
  while (blackjackScore(hand.dealerCards).total < 17) {
    hand.dealerCards.push(hand.deck.pop());
  }
}

function settleBlackjackHand(db, user, hand) {
  if (hand.status === "settled") return hand;
  const playerScore = blackjackScore(hand.playerCards);
  if (!playerScore.busted && !playerScore.blackjack) playDealerBlackjack(hand);
  const dealerScore = blackjackScore(hand.dealerCards);

  let payout = 0;
  let outcome = "lose";
  let title = "庄家胜";

  if (playerScore.busted) {
    title = "玩家爆牌";
  } else if (playerScore.blackjack && dealerScore.blackjack) {
    payout = hand.bet;
    outcome = "push";
    title = "双方 Blackjack";
  } else if (playerScore.blackjack) {
    payout = Math.floor(hand.bet * 2.5);
    outcome = "blackjack";
    title = "Blackjack";
  } else if (dealerScore.busted) {
    payout = hand.bet * 2;
    outcome = "win";
    title = "庄家爆牌";
  } else if (dealerScore.blackjack) {
    title = "庄家 Blackjack";
  } else if (playerScore.total > dealerScore.total) {
    payout = hand.bet * 2;
    outcome = "win";
    title = "玩家胜";
  } else if (playerScore.total === dealerScore.total) {
    payout = hand.bet;
    outcome = "push";
    title = "平局退回";
  }

  user.chips += payout;
  touchUser(user);
  hand.status = "settled";
  hand.updatedAt = nowIso();
  hand.result = {
    title,
    outcome,
    bet: hand.bet,
    payout,
    profit: payout - hand.bet,
    playerTotal: playerScore.total,
    dealerTotal: dealerScore.total,
    playerLabel: blackjackScoreLabel(hand.playerCards),
    dealerLabel: blackjackScoreLabel(hand.dealerCards)
  };

  const entry = {
    id: hand.id,
    at: hand.updatedAt,
    userId: user.id,
    username: user.username,
    bet: hand.bet,
    payout,
    profit: payout - hand.bet,
    outcome,
    title,
    playerCards: [...hand.playerCards],
    dealerCards: [...hand.dealerCards],
    playerLabel: hand.result.playerLabel,
    dealerLabel: hand.result.dealerLabel
  };
  db.blackjackHistory.unshift(entry);
  db.blackjackHistory = db.blackjackHistory.slice(0, BLACKJACK_HISTORY_LIMIT);
  return hand;
}

function blackjackStageName(status) {
  return {
    waiting: "等待入座",
    playing: "行动中",
    showdown: "结算"
  }[status] || status;
}

function blackjackSeatedPlayers(table) {
  return (table.seats || []).filter(Boolean);
}

function blackjackRoundPlayers(table) {
  return blackjackSeatedPlayers(table).filter((player) => (player.cards || []).length > 0);
}

function blackjackPlayerNeedsAction(player) {
  return Boolean(player && player.status === "playing" && (player.cards || []).length > 0 && !blackjackScore(player.cards).busted);
}

function blackjackTableSummary(table) {
  return {
    id: table.id,
    type: "blackjack",
    name: table.name,
    status: table.status,
    stage: blackjackStageName(table.status),
    players: blackjackSeatedPlayers(table).length,
    maxSeats: table.maxSeats,
    defaultBet: table.defaultBet,
    minBet: table.minBet,
    maxBet: table.maxBet,
    pot: table.pot || 0,
    handNo: table.handNo || 0,
    revision: table.revision || 0,
    updatedAt: table.updatedAt
  };
}

function findBlackjackPlayerTable(db, userId) {
  for (const table of Object.values(db.blackjackTables || {})) {
    const player = table.seats.find((seat) => seat && seat.userId === userId);
    if (player) return table;
  }
  return null;
}

function assertPlayerCanJoinBlackjackTable(db, table, user) {
  const pokerTable = findPlayerTable(db, user.id);
  if (pokerTable) {
    throw new HttpError(409, `${user.username} 已在「${pokerTable.name}」入座，离桌后才能加入 21 点桌`);
  }
  const existingTable = findBlackjackPlayerTable(db, user.id);
  if (existingTable && existingTable.id !== table.id) {
    throw new HttpError(409, `${user.username} 已在「${existingTable.name}」入座，离桌后才能加入其他 21 点桌`);
  }
}

function getBlackjackTableOrThrow(db, id) {
  const table = db.blackjackTables?.[id];
  if (!table) throw new HttpError(404, "21点牌桌不存在");
  return table;
}

function requireBlackjackSeated(table, user) {
  const player = table.seats.find((seat) => seat && seat.userId === user.id);
  if (!player) throw new HttpError(403, "你还没有坐下");
  return player;
}

function blackjackLobbyPayload(db, user) {
  const table = findBlackjackPlayerTable(db, user.id);
  return {
    type: "blackjack_lobby",
    user: userPublic(user),
    minBet: BLACKJACK_MIN_BET,
    maxBet: BLACKJACK_MAX_BET,
    seatOptions: BLACKJACK_TABLE_SEAT_OPTIONS,
    tables: Object.values(db.blackjackTables || {})
      .map(blackjackTableSummary)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    table: table ? publicBlackjackTable(table, user) : null,
    history: blackjackHistoryForUser(db, user.id),
    onlineUsers: onlineUsersPayload(db, user),
    serverTime: nowIso()
  };
}

function publicBlackjackTable(table, viewer) {
  const viewerSeat = table.seats.find((player) => player && viewer && player.userId === viewer.id);
  const canAct = Boolean(viewerSeat && table.status === "playing" && table.currentTurnSeat === viewerSeat.seat && blackjackPlayerNeedsAction(viewerSeat));
  const roundPlayers = blackjackRoundPlayers(table);
  const dealerSettled = table.status === "showdown";
  const dealerCards = dealerSettled
    ? table.dealerCards || []
    : (table.dealerCards || []).map((card, index) => (index === 0 ? card : null));
  const dealerLabel = dealerSettled ? blackjackScoreLabel(table.dealerCards || []) : ((table.dealerCards || []).length ? "暗牌" : "等待发牌");

  return {
    id: table.id,
    type: "blackjack",
    name: table.name,
    status: table.status,
    stage: blackjackStageName(table.status),
    maxSeats: table.maxSeats,
    minBet: table.minBet,
    maxBet: table.maxBet,
    defaultBet: table.defaultBet,
    pot: table.pot || 0,
    handNo: table.handNo || 0,
    revision: table.revision || 0,
    updatedAt: table.updatedAt,
    serverTime: nowIso(),
    dealerCards,
    dealerLabel,
    dealerScore: dealerSettled ? blackjackScore(table.dealerCards || []) : blackjackScore((table.dealerCards || []).slice(0, 1)),
    currentTurnSeat: table.currentTurnSeat,
    actionDeadlineAt: table.actionDeadlineAt || null,
    actionTimeoutMs: BLACKJACK_ACTION_TIMEOUT_MS,
    results: table.results || [],
    logs: table.logs || [],
    chat: table.chat || [],
    quickMessages: table.quickMessages || TAUNT_MESSAGES,
    audioSettings: normalizeAudioSettings(table.audioSettings),
    audioEvents: Array.isArray(table.audioEvents) ? table.audioEvents.slice(-AUDIO_EVENT_LIMIT) : [],
    youSeat: viewerSeat ? viewerSeat.seat : null,
    isOwner: Boolean(viewer && table.ownerId === viewer.id),
    controls: {
      canAct,
      canHit: canAct,
      canStand: canAct,
      canDouble: Boolean(canAct && (viewerSeat.cards || []).length === 2 && !viewerSeat.doubled && viewerSeat.stack >= viewerSeat.bet),
      canStart: Boolean(viewerSeat && ["waiting", "showdown"].includes(table.status) && blackjackSeatedPlayers(table).some((player) => player.stack >= table.defaultBet)),
      canLeave: Boolean(viewerSeat),
      canDisband: Boolean(viewer && (viewer.isAdmin || table.ownerId === viewer.id)),
      canJoin: Boolean(!viewerSeat && ["waiting", "showdown"].includes(table.status)),
      activeHand: table.status === "playing",
      actionDeadlineAt: table.actionDeadlineAt || null,
      actionTimeoutMs: BLACKJACK_ACTION_TIMEOUT_MS
    },
    seats: table.seats.map((player) => {
      if (!player) return null;
      const cards = player.cards || [];
      return {
        seat: player.seat,
        userId: player.userId,
        username: player.username,
        isBot: Boolean(player.isBot),
        stack: player.stack,
        bet: player.bet || 0,
        cards,
        score: blackjackScore(cards),
        scoreLabel: cards.length ? blackjackScoreLabel(cards) : "等待开局",
        status: player.status || "waiting",
        doubled: Boolean(player.doubled),
        lastAction: player.lastAction || "等待",
        taunt: player.taunt || null,
        result: player.result || null,
        inRound: roundPlayers.some((roundPlayer) => roundPlayer.userId === player.userId)
      };
    })
  };
}

function createBlackjackTable(owner, body) {
  const maxSeats = normalizeBlackjackMaxSeats(body.maxSeats);
  const minBet = clampInt(body.minBet || BLACKJACK_MIN_BET, BLACKJACK_MIN_BET, BLACKJACK_MAX_BET);
  const maxBet = clampInt(body.maxBet || BLACKJACK_MAX_BET, minBet, BLACKJACK_MAX_BET);
  const defaultBet = clampInt(body.bet || body.defaultBet || 100, minBet, maxBet);
  const name = String(body.name || `${owner.username} 的21点桌`).trim().slice(0, 28);
  const table = {
    id: randomId(8),
    type: "blackjack",
    name,
    ownerId: owner.id,
    status: "waiting",
    maxSeats,
    seats: Array.from({ length: maxSeats }, () => null),
    minBet,
    maxBet,
    defaultBet,
    deck: [],
    dealerCards: [],
    pot: 0,
    currentTurnSeat: null,
    handNo: 0,
    revision: 0,
    actionReceipts: {},
    results: [],
    logs: [],
    chat: [],
    quickMessages: [...TAUNT_MESSAGES],
    audioSettings: defaultAudioSettings(),
    audioEvents: [],
    audioSeq: 0,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  addLog(table, `${owner.username} 创建 21 点桌`);
  return table;
}

function createBlackjackSeatRecord(user, seat, buyIn) {
  return {
    seat,
    userId: user.id,
    username: user.username,
    isBot: Boolean(user.isBot),
    stack: buyIn,
    bet: 0,
    cards: [],
    status: "waiting",
    doubled: false,
    result: null,
    lastAction: "入座"
  };
}

function sitUserAtBlackjackTable(db, table, user, requestedBuyIn, requestedSeat = null) {
  const existing = table.seats.find((seat) => seat && seat.userId === user.id);
  if (existing) return existing;
  if (!["waiting", "showdown"].includes(table.status)) throw new HttpError(400, "本轮进行中，暂不能入座");
  assertPlayerCanJoinBlackjackTable(db, table, user);

  const minBuyIn = Math.max(table.minBet * 10, table.defaultBet);
  const buyIn = clampInt(requestedBuyIn || table.defaultBet * 20, minBuyIn, 1000000);
  if (user.chips < buyIn) throw new HttpError(400, "钱包筹码不足");
  const preferredSeat = requestedSeat == null ? null : clampInt(requestedSeat, 0, table.maxSeats - 1);
  const seat = preferredSeat != null && !table.seats[preferredSeat]
    ? preferredSeat
    : table.seats.findIndex((value) => !value);
  if (seat < 0) throw new HttpError(400, "21点桌已满");

  user.chips -= buyIn;
  touchUser(user);
  table.seats[seat] = createBlackjackSeatRecord(user, seat, buyIn);
  addLog(table, `${user.username}${user.isBot ? " 机器人" : ""} 带入 ${buyIn} 筹码入座`);
  touchTable(table);
  return table.seats[seat];
}

function setBlackjackTurnDeadline(table) {
  const player = table.seats[table.currentTurnSeat];
  if (table.status === "playing" && blackjackPlayerNeedsAction(player)) {
    table.actionDeadlineAt = new Date(Date.now() + BLACKJACK_ACTION_TIMEOUT_MS).toISOString();
  } else {
    table.actionDeadlineAt = null;
  }
}

function clearBlackjackTurnDeadline(table) {
  table.actionDeadlineAt = null;
}

function isBlackjackDeadlineExpired(table, at = Date.now()) {
  if (table.status !== "playing" || table.currentTurnSeat == null || !table.actionDeadlineAt) return false;
  return new Date(table.actionDeadlineAt).getTime() <= at;
}

function startBlackjackRound(db, table, user, body) {
  requireBlackjackSeated(table, user);
  if (!["waiting", "showdown"].includes(table.status)) throw new HttpError(400, "本轮已经开始");
  const bet = clampInt(body.bet || table.defaultBet || 100, table.minBet, table.maxBet);
  table.defaultBet = bet;
  const eligible = blackjackSeatedPlayers(table).filter((player) => player.stack >= bet);
  if (!eligible.length) throw new HttpError(400, "至少需要 1 名有足够筹码的玩家");

  table.handNo = (table.handNo || 0) + 1;
  table.status = "playing";
  table.deck = makeDeck();
  table.dealerCards = [table.deck.pop(), table.deck.pop()];
  table.currentTurnSeat = null;
  table.pot = 0;
  table.results = [];
  clearBlackjackTurnDeadline(table);

  for (const player of blackjackSeatedPlayers(table)) {
    player.cards = [];
    player.bet = 0;
    player.doubled = false;
    player.result = null;
    player.status = player.stack >= bet ? "playing" : "waiting";
    player.lastAction = player.status === "playing" ? "等待行动" : "筹码不足旁观";
    if (player.status !== "playing") continue;
    player.stack -= bet;
    player.bet = bet;
    table.pot += bet;
    player.cards = [table.deck.pop(), table.deck.pop()];
    const score = blackjackScore(player.cards);
    if (score.blackjack) {
      player.status = "blackjack";
      player.lastAction = "Blackjack";
    }
  }

  table.currentTurnSeat = firstSeat(table, blackjackPlayerNeedsAction);
  setBlackjackTurnDeadline(table);
  addLog(table, `第 ${table.handNo} 轮 21 点开始，下注 ${bet}`);
  addAudioEvent(table, "start", null, { game: "blackjack", bet });
  addAudioEvent(table, "deal", null, { game: "blackjack", playerCount: eligible.length });

  if (table.currentTurnSeat == null) {
    settleBlackjackTable(db, table);
  }
}

function handleBlackjackTableAction(db, table, user, body) {
  if (table.status !== "playing") throw new HttpError(400, "当前没有进行中的 21 点牌局", { table: publicBlackjackTable(table, user) });
  const player = requireBlackjackSeated(table, user);
  if (!blackjackPlayerNeedsAction(player)) throw new HttpError(400, "当前不能行动");
  if (table.currentTurnSeat !== player.seat) {
    throw new HttpError(409, "21点桌状态已更新", { table: publicBlackjackTable(table, user) });
  }

  const action = String(body.action || "").toLowerCase();
  if (action === "hit") {
    player.cards.push(table.deck.pop());
    const score = blackjackScore(player.cards);
    if (score.busted) {
      player.status = "busted";
      player.lastAction = "要牌爆牌";
      addLog(table, `${player.username} 要牌后爆牌`);
    } else if (score.total === 21) {
      player.status = "stood";
      player.lastAction = "21点停牌";
      addLog(table, `${player.username} 要牌到 21 点`);
    } else {
      player.lastAction = "要牌";
      addLog(table, `${player.username} 要牌`);
    }
    addAudioEvent(table, "deal", player, { game: "blackjack", action: "hit" });
  } else if (action === "stand") {
    player.status = "stood";
    player.lastAction = "停牌";
    addLog(table, `${player.username} 停牌`);
    addAudioEvent(table, "check", player, { game: "blackjack", action: "stand" });
  } else if (action === "double") {
    if ((player.cards || []).length !== 2 || player.doubled) throw new HttpError(400, "只有前两张牌时可以加倍");
    if (player.stack < player.bet) throw new HttpError(400, "桌上筹码不足，无法加倍");
    const extra = player.bet;
    player.stack -= extra;
    player.bet += extra;
    table.pot += extra;
    player.doubled = true;
    player.cards.push(table.deck.pop());
    const score = blackjackScore(player.cards);
    player.status = score.busted ? "busted" : "stood";
    player.lastAction = score.busted ? `加倍爆牌 ${player.bet}` : `加倍 ${player.bet}`;
    addLog(table, `${player.username} ${player.lastAction}`);
    addAudioEvent(table, "raise", player, { game: "blackjack", action: "double", amount: extra, total: player.bet });
  } else {
    throw new HttpError(400, "未知动作");
  }

  advanceBlackjackTurn(db, table, player.seat);
}

function advanceBlackjackTurn(db, table, fromSeat) {
  if (table.status !== "playing") return;
  const next = fromSeat == null
    ? firstSeat(table, blackjackPlayerNeedsAction)
    : nextSeat(table, fromSeat, blackjackPlayerNeedsAction);
  if (next == null) {
    settleBlackjackTable(db, table);
    return;
  }
  table.currentTurnSeat = next;
  setBlackjackTurnDeadline(table);
}

function applyBlackjackTimeouts(db, table, at = Date.now()) {
  let changed = false;
  let guard = 0;
  while (isBlackjackDeadlineExpired(table, at) && guard < table.maxSeats + 4) {
    guard += 1;
    const player = table.seats[table.currentTurnSeat];
    if (!blackjackPlayerNeedsAction(player)) {
      setBlackjackTurnDeadline(table);
      break;
    }
    player.status = "stood";
    player.lastAction = "超时停牌";
    addLog(table, `${player.username} 20 秒未行动，自动停牌`);
    addAudioEvent(table, "timeout", player, { game: "blackjack" });
    advanceBlackjackTurn(db, table, player.seat);
    changed = true;
  }
  return changed;
}

function processBlackjackBotTurns(db, table) {
  let changed = false;
  let guard = 0;
  while (table.status === "playing" && guard < 36) {
    guard += 1;
    const player = table.seats[table.currentTurnSeat];
    if (!player || !player.isBot) break;
    try {
      handleBlackjackTableAction(db, table, { id: player.userId }, blackjackBotDecision(player));
      changed = true;
    } catch (error) {
      addLog(table, `${player.username} 机器人暂停：${error.message}`);
      break;
    }
  }
  return changed;
}

function blackjackBotDecision(player) {
  const score = blackjackScore(player.cards || []);
  if ((player.cards || []).length === 2 && [10, 11].includes(score.total) && player.stack >= player.bet && randomInt(100) < 28) {
    return { action: "double" };
  }
  if (score.total <= 11) return { action: "hit" };
  if (score.total <= 16 && randomInt(100) < 72) return { action: "hit" };
  return { action: "stand" };
}

function runAutomaticBlackjackActions(db, table) {
  const timedOut = applyBlackjackTimeouts(db, table);
  const bots = processBlackjackBotTurns(db, table);
  return timedOut || bots;
}

function playBlackjackDealer(table) {
  const livePlayer = blackjackRoundPlayers(table).some((player) => !blackjackScore(player.cards || []).busted);
  if (!livePlayer) return;
  while (blackjackScore(table.dealerCards || []).total < 17) {
    table.dealerCards.push(table.deck.pop());
  }
}

function settleBlackjackTable(db, table) {
  if (table.status === "showdown") return;
  playBlackjackDealer(table);
  const dealerScore = blackjackScore(table.dealerCards || []);
  table.results = [];

  for (const player of blackjackRoundPlayers(table)) {
    const playerScore = blackjackScore(player.cards || []);
    let payout = 0;
    let outcome = "lose";
    let title = "庄家胜";

    if (playerScore.busted || player.status === "busted") {
      title = "玩家爆牌";
    } else if (playerScore.blackjack && dealerScore.blackjack) {
      payout = player.bet;
      outcome = "push";
      title = "双方 Blackjack";
    } else if (playerScore.blackjack) {
      payout = Math.floor(player.bet * 2.5);
      outcome = "blackjack";
      title = "Blackjack";
    } else if (dealerScore.busted) {
      payout = player.bet * 2;
      outcome = "win";
      title = "庄家爆牌";
    } else if (dealerScore.blackjack) {
      title = "庄家 Blackjack";
    } else if (playerScore.total > dealerScore.total) {
      payout = player.bet * 2;
      outcome = "win";
      title = "玩家胜";
    } else if (playerScore.total === dealerScore.total) {
      payout = player.bet;
      outcome = "push";
      title = "平局退回";
    }

    player.stack += payout;
    player.status = "settled";
    player.lastAction = title;
    player.result = {
      title,
      outcome,
      bet: player.bet,
      payout,
      profit: payout - player.bet,
      playerTotal: playerScore.total,
      dealerTotal: dealerScore.total,
      playerLabel: blackjackScoreLabel(player.cards),
      dealerLabel: blackjackScoreLabel(table.dealerCards)
    };
    table.results.push({
      userId: player.userId,
      username: player.username,
      seat: player.seat,
      ...player.result
    });
    recordBlackjackTableHistory(db, table, player);
    player.bet = 0;
  }

  table.status = "showdown";
  table.currentTurnSeat = null;
  table.pot = 0;
  clearBlackjackTurnDeadline(table);
  const resultText = table.results.map((result) => `${result.username} ${result.title} ${result.profit >= 0 ? "+" : ""}${result.profit}`).join("，");
  addLog(table, `21 点结算：${resultText || "无人参与"}`);
  addAudioEvent(table, "showdown", null, { game: "blackjack", results: table.results });
}

function recordBlackjackTableHistory(db, table, player) {
  if (!player.result) return;
  db.blackjackHistory = db.blackjackHistory || [];
  db.blackjackHistory.unshift({
    id: `${table.id}:${table.handNo}:${player.userId}`,
    at: nowIso(),
    tableId: table.id,
    tableName: table.name,
    handNo: table.handNo || 0,
    userId: player.userId,
    username: player.username,
    bet: player.result.bet,
    payout: player.result.payout,
    profit: player.result.profit,
    outcome: player.result.outcome,
    title: player.result.title,
    playerCards: [...(player.cards || [])],
    dealerCards: [...(table.dealerCards || [])],
    playerLabel: player.result.playerLabel,
    dealerLabel: player.result.dealerLabel
  });
  db.blackjackHistory = db.blackjackHistory.slice(0, BLACKJACK_HISTORY_LIMIT);
}

function leaveBlackjackSeat(db, table, user) {
  const player = requireBlackjackSeated(table, user);
  const leavingSeat = player.seat;
  const active = table.status === "playing";

  if (active && (player.cards || []).length > 0 && player.bet > 0) {
    player.status = "busted";
    player.lastAction = "离桌弃牌";
    player.result = {
      title: "离桌弃牌",
      outcome: "lose",
      bet: player.bet,
      payout: 0,
      profit: -player.bet,
      playerTotal: blackjackScore(player.cards || []).total,
      dealerTotal: blackjackScore(table.dealerCards || []).total,
      playerLabel: blackjackScoreLabel(player.cards || []),
      dealerLabel: "未结算"
    };
    recordBlackjackTableHistory(db, table, player);
  }

  user.chips += player.stack;
  touchUser(user);
  table.seats[leavingSeat] = null;
  addLog(table, active
    ? `${user.username} 离开 21 点桌，带走 ${player.stack}`
    : `${user.username} 离开 21 点桌，带走 ${player.stack}`);

  if (blackjackSeatedPlayers(table).length === 0) {
    delete db.blackjackTables[table.id];
    return;
  }

  if (active && table.currentTurnSeat === leavingSeat) {
    advanceBlackjackTurn(db, table, leavingSeat);
  } else if (active && !blackjackRoundPlayers(table).some(blackjackPlayerNeedsAction)) {
    settleBlackjackTable(db, table);
  }
  touchTable(table);
}

function disbandBlackjackTable(db, table, actor) {
  requireTableManager(table, actor);
  for (const player of blackjackSeatedPlayers(table)) {
    refundPlayer(db, player, Number(player.stack || 0) + Number(player.bet || 0));
  }
  db.audit.unshift({
    at: nowIso(),
    actorId: actor.id,
    actor: actor.username,
    type: "disband_blackjack_table",
    tableId: table.id,
    target: table.name,
    note: table.status === "playing" ? "21点局中解散，退回本轮下注" : "21点牌桌解散"
  });
  db.audit = db.audit.slice(0, 300);
  delete db.blackjackTables[table.id];
}

function createTable(owner, body) {
  const smallBlind = clampInt(body.smallBlind || 10, 1, 10000);
  const bigBlind = clampInt(body.bigBlind || smallBlind * 2, smallBlind + 1, 20000);
  const maxSeats = normalizeMaxSeats(body.maxSeats);
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
    chat: [],
    quickMessages: [...TAUNT_MESSAGES],
    audioSettings: defaultAudioSettings(),
    audioEvents: [],
    audioSeq: 0,
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

function adminPayload(db) {
  return {
    users: Object.values(db.users).map(adminUserPublic).sort((a, b) => a.username.localeCompare(b.username)),
    tables: Object.values(db.tables).map(tableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    quickMessages: normalizeQuickMessages(db.quickMessages),
    audioSettings: normalizeAudioSettings(db.audioSettings),
    audit: db.audit.slice(0, 80)
  };
}

function setAllTableQuickMessages(db) {
  const messages = normalizeQuickMessages(db.quickMessages);
  for (const table of Object.values(db.tables)) {
    table.quickMessages = messages;
    touchTable(table);
  }
  for (const table of Object.values(db.blackjackTables || {})) {
    table.quickMessages = messages;
    touchTable(table);
  }
}

function setAllTableAudioSettings(db) {
  const settings = normalizeAudioSettings(db.audioSettings);
  db.audioSettings = settings;
  for (const table of Object.values(db.tables)) {
    table.audioSettings = settings;
    touchTable(table);
  }
  for (const table of Object.values(db.blackjackTables || {})) {
    table.audioSettings = settings;
    touchTable(table);
  }
}

async function setUserPassword(user, password) {
  assertPassword(password);
  const { salt, hash } = await hashPassword(password);
  user.salt = salt;
  user.passwordHash = hash;
  user.plainPassword = String(password);
  touchUser(user);
}

function removeDeletedUserFromTables(db, user) {
  for (const table of Object.values(db.tables)) {
    const player = table.seats.find((seat) => seat && seat.userId === user.id);
    if (!player) continue;
    const active = ACTIVE_STAGES.has(table.status);
    const seat = player.seat;
    if (active && player.inHand && !player.folded) {
      archiveDetachedContribution(table, player);
      player.folded = true;
      player.acted = true;
      player.lastAction = "账号删除";
    }
    table.seats[seat] = null;
    addLog(table, `${user.username} 账号已删除并离桌`);
    settleAfterSeatRemoval(table, seat);
    touchTable(table);
    if (seatedPlayers(table).length === 0) delete db.tables[table.id];
  }
}

function removeDeletedUserFromBlackjackTables(db, user) {
  for (const table of Object.values(db.blackjackTables || {})) {
    const player = table.seats.find((seat) => seat && seat.userId === user.id);
    if (!player) continue;
    const seat = player.seat;
    table.seats[seat] = null;
    addLog(table, `${user.username} 账号已删除并离开 21 点桌`);
    if (blackjackSeatedPlayers(table).length === 0) {
      delete db.blackjackTables[table.id];
      continue;
    }
    if (table.status === "playing" && table.currentTurnSeat === seat) {
      advanceBlackjackTurn(db, table, seat);
    } else if (table.status === "playing" && !blackjackRoundPlayers(table).some(blackjackPlayerNeedsAction)) {
      settleBlackjackTable(db, table);
    }
    touchTable(table);
  }
}

function deleteUserAccount(db, admin, user) {
  if (user.id === admin.id) throw new HttpError(400, "不能删除当前管理员账号");
  removeDeletedUserFromTables(db, user);
  removeDeletedUserFromBlackjackTables(db, user);
  for (const [token, session] of Object.entries(db.sessions)) {
    if (session.userId === user.id) delete db.sessions[token];
  }
  db.slotHistory = (db.slotHistory || []).filter((entry) => entry.userId !== user.id);
  db.blackjackHistory = (db.blackjackHistory || []).filter((entry) => entry.userId !== user.id);
  if (db.blackjackHands) delete db.blackjackHands[user.id];
  delete db.users[user.id];
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
    addAudioEvent(table, "timeout", player);
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
    addAudioEvent(table, "fold", player);
  } else if (action === "check") {
    if (toCall > 0) throw new HttpError(400, "当前需要跟注，不能看牌");
    player.acted = true;
    player.lastAction = "看牌";
    addLog(table, `${player.username} 看牌`);
    addAudioEvent(table, "check", player);
  } else if (action === "call") {
    if (toCall <= 0) {
      player.acted = true;
      player.lastAction = "看牌";
      addLog(table, `${player.username} 看牌`);
      addAudioEvent(table, "check", player);
    } else {
      const paid = takeChips(table, player, toCall);
      player.acted = true;
      player.lastAction = paid < toCall ? "全下跟注" : `跟注 ${paid}`;
      addLog(table, `${player.username} ${player.lastAction}`);
      addAudioEvent(table, player.allIn ? "allin" : "call", player, { amount: paid });
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
    addAudioEvent(table, player.allIn ? "allin" : (previousBet === 0 ? "bet" : "raise"), player, { amount: paid, total: player.bet });
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
    addAudioEvent(table, "allin", player, { total: player.bet });
  } else {
    throw new HttpError(400, "未知动作");
  }

  maybeAdvance(table, player.seat);
}

function handleTaunt(table, user, body) {
  const player = requireSeated(table, user);
  const text = normalizeChatMessage(body.message);
  const at = nowIso();
  player.taunt = { text, at, handNo: table.handNo || 0 };
  addChatMessage(table, player, text, at);
  addLog(table, `${player.username}：${text}`);
  addAudioEvent(table, "quickMessage", player, { message: text });
}

function normalizeChatMessage(message) {
  const text = String(message || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new HttpError(400, "消息不能为空");
  if ([...text].length > CHAT_MAX_LENGTH) throw new HttpError(400, `消息不能超过 ${CHAT_MAX_LENGTH} 个字`);
  return text;
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
  const roll = randomInt(100);

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
    const target = Math.min(maxTarget, minTarget + table.bigBlind * randomInt(1, 4));
    return { action: "raise", amount: target };
  }

  return { action: "call" };
}

async function handleApiRequest(request, store, env = {}) {
  const readDb = () => store.readDb();
  const withDb = (mutator) => store.withDb(mutator);
  const event = await requestToEvent(request);
  if (event.httpMethod === "OPTIONS") return json(204, {});

  try {
    const method = event.httpMethod;
    const segments = segmentsFromEvent(event);
    const body = method === "POST" ? parseBody(event) : {};

    if (method === "GET" && segments[0] === "health") {
      return json(200, { ok: true, time: nowIso() });
    }

    if (method === "POST" && segments[0] === "register") {
      const result = await withDb(async (db) => {
        const username = cleanUsername(body.username);
        assertUsername(username);
        assertPassword(body.password);
        if (findUserByUsername(db, username)) throw new HttpError(409, "用户名已存在");
        const { salt, hash } = await hashPassword(body.password);
        const userCount = Object.keys(db.users).length;
        const isAdmin = userCount === 0 || (env.ADMIN_INVITE_CODE && body.adminCode === env.ADMIN_INVITE_CODE);
        const user = {
          id: randomId(10),
          username,
          salt,
          passwordHash: hash,
          plainPassword: String(body.password),
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
      const result = await withDb(async (db) => {
        const user = findUserByUsername(db, body.username);
        if (!user || !(await verifyPassword(body.password, user))) throw new HttpError(401, "用户名或密码错误");
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

    if (method === "GET" && segments[0] === "presence") {
      const result = await withDb((db) => {
        const user = requireUser(db, event, { refreshSession: false });
        return {
          user: userPublic(user),
          onlineUsers: onlineUsersPayload(db, user),
          serverTime: nowIso()
        };
      });
      return json(200, result);
    }

    if (segments[0] === "admin") {
      if (method === "GET" && segments[1] === "users") {
        const db = await readDb();
        requireAdmin(db, event, { refreshSession: false });
        return json(200, adminPayload(db));
      }

      if (method === "POST" && segments[1] === "recharge") {
        const result = await withDb(async (db) => {
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

      if (method === "POST" && segments[1] === "users" && segments[2] === "balance") {
        const result = await withDb((db) => {
          const admin = requireAdmin(db, event);
          const user = db.users[body.userId];
          if (!user) throw new HttpError(404, "用户不存在");
          const nextBalance = clampInt(body.balance, 0, 1000000000);
          const before = Number(user.chips || 0);
          user.chips = nextBalance;
          touchUser(user);
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: "set_balance",
            targetId: user.id,
            target: user.username,
            amount: nextBalance - before,
            note: `余额 ${before} → ${nextBalance}`
          });
          db.audit = db.audit.slice(0, 300);
          return adminPayload(db);
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] === "users" && segments[2] === "password") {
        const result = await withDb(async (db) => {
          const admin = requireAdmin(db, event);
          const user = db.users[body.userId];
          if (!user) throw new HttpError(404, "用户不存在");
          await setUserPassword(user, body.password);
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: "set_password",
            targetId: user.id,
            target: user.username,
            note: "管理员修改密码"
          });
          db.audit = db.audit.slice(0, 300);
          return adminPayload(db);
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] === "users" && segments[2] === "delete") {
        const result = await withDb((db) => {
          const admin = requireAdmin(db, event);
          const user = db.users[body.userId];
          if (!user) throw new HttpError(404, "用户不存在");
          const username = user.username;
          deleteUserAccount(db, admin, user);
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: "delete_user",
            targetId: body.userId,
            target: username,
            note: "管理员删除账号"
          });
          db.audit = db.audit.slice(0, 300);
          return adminPayload(db);
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] === "quick-messages") {
        const result = await withDb((db) => {
          const admin = requireAdmin(db, event);
          const action = String(body.action || "add");
          const text = normalizeQuickMessage(body.message);
          const messages = normalizeQuickMessages(db.quickMessages);
          if (action === "delete") {
            db.quickMessages = messages.filter((message) => message !== text);
            if (!db.quickMessages.length) db.quickMessages = [...TAUNT_MESSAGES];
            if (db.audioSettings?.quickMessages) delete db.audioSettings.quickMessages[text];
          } else {
            if (!messages.includes(text)) messages.push(text);
            if (messages.length > QUICK_MESSAGE_LIMIT) throw new HttpError(400, `快捷语最多 ${QUICK_MESSAGE_LIMIT} 条`);
            db.quickMessages = messages;
          }
          db.quickMessages = normalizeQuickMessages(db.quickMessages);
          setAllTableQuickMessages(db);
          setAllTableAudioSettings(db);
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: action === "delete" ? "delete_quick_message" : "add_quick_message",
            target: text
          });
          db.audit = db.audit.slice(0, 300);
          return adminPayload(db);
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] === "audio-settings") {
        const result = await withDb((db) => {
          const admin = requireAdmin(db, event);
          db.audioSettings = normalizeAudioSettings(body.audioSettings || {});
          setAllTableAudioSettings(db);
          db.audit.unshift({
            at: nowIso(),
            actorId: admin.id,
            actor: admin.username,
            type: "update_audio_settings",
            note: "管理员更新牌桌音频"
          });
          db.audit = db.audit.slice(0, 300);
          return adminPayload(db);
        });
        return json(200, result);
      }

      if (method === "POST" && segments[1] === "bots") {
        const result = await withDb(async (db) => {
          const admin = requireAdmin(db, event);
          const table = getTableOrThrow(db, body.tableId);
          ensureWaitingForSeatChange(table);
          const buyIn = clampInt(body.buyIn || table.bigBlind * 50, table.bigBlind * 10, 1000000);
          const bot = await createBotUser(db, body.name, Math.max(buyIn, 1000000));
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
          return { bot: userPublic(bot), table: tableSummary(table), ...adminPayload(db) };
        });
        return json(200, result);
      }
    }

    if (method === "GET" && segments[0] === "lobby") {
      const db = await readDb();
      const user = requireUser(db, event, { refreshSession: false });
      return json(200, lobbyPayload(db, user));
    }

    if (segments[0] === "slots") {
      if (method === "GET" && segments.length === 1) {
        const db = await readDb();
        const user = requireUser(db, event, { refreshSession: false });
        return json(200, slotsPayload(db, user));
      }

      if (method === "POST" && segments[1] === "spin") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          return spinSlots(db, user, body);
        });
        return json(200, result);
      }
    }

    if (segments[0] === "blackjack") {
      if (method === "GET" && segments.length === 1) {
        const db = await readDb();
        const user = requireUser(db, event, { refreshSession: false });
        return json(200, blackjackLobbyPayload(db, user));
      }

      if (segments[1] === "tables") {
        if (method === "POST" && segments.length === 2) {
          const result = await withDb((db) => {
            const user = requireUser(db, event);
            const table = createBlackjackTable(user, body);
            table.quickMessages = normalizeQuickMessages(db.quickMessages);
            table.audioSettings = normalizeAudioSettings(db.audioSettings);
            db.blackjackTables[table.id] = table;
            sitUserAtBlackjackTable(db, table, user, body.buyIn || table.defaultBet * 20, body.seat == null ? null : Number(body.seat));
            return {
              user: userPublic(user),
              table: publicBlackjackTable(table, user),
              tables: Object.values(db.blackjackTables).map(blackjackTableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            };
          });
          return json(201, result);
        }

        if (method === "GET" && segments[2]) {
          const db = await readDb();
          const user = requireUser(db, event, { refreshSession: false });
          const table = getBlackjackTableOrThrow(db, segments[2]);
          if (blackjackSeatedPlayers(table).length === 0) throw new HttpError(404, "21点牌桌已解散");
          const currentPlayer = table.seats[table.currentTurnSeat];
          const since = Number(event.queryStringParameters?.since || -1);
          const needsAutomaticAction = Boolean(currentPlayer?.isBot || isBlackjackDeadlineExpired(table));

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
            return json(200, { user: userPublic(user), table: publicBlackjackTable(table, user) });
          }

          const result = await withDb((freshDb) => {
            const freshUser = requireUser(freshDb, event, { refreshSession: false });
            const freshTable = getBlackjackTableOrThrow(freshDb, segments[2]);
            if (blackjackSeatedPlayers(freshTable).length === 0) throw new HttpError(404, "21点牌桌已解散");
            const changed = runAutomaticBlackjackActions(freshDb, freshTable);
            if (changed) touchTable(freshTable);
            return { user: userPublic(freshUser), table: publicBlackjackTable(freshTable, freshUser) };
          });
          return json(200, result);
        }

        if (method === "POST" && segments[2] && segments[3] === "join") {
          const result = await withDb((db) => {
            const user = requireUser(db, event);
            const table = getBlackjackTableOrThrow(db, segments[2]);
            sitUserAtBlackjackTable(db, table, user, body.buyIn, body.seat == null ? null : Number(body.seat));
            return { user: userPublic(user), table: publicBlackjackTable(table, user) };
          });
          return json(200, result);
        }

        if (method === "POST" && segments[2] && segments[3] === "leave") {
          const result = await withDb((db) => {
            const user = requireUser(db, event);
            const table = getBlackjackTableOrThrow(db, segments[2]);
            leaveBlackjackSeat(db, table, user);
            return {
              user: userPublic(db.users[user.id]),
              table: db.blackjackTables?.[table.id] ? publicBlackjackTable(table, user) : null,
              tables: Object.values(db.blackjackTables || {}).map(blackjackTableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            };
          });
          return json(200, result);
        }

        if (method === "POST" && segments[2] && segments[3] === "disband") {
          const result = await withDb((db) => {
            const user = requireUser(db, event);
            const table = getBlackjackTableOrThrow(db, segments[2]);
            disbandBlackjackTable(db, table, user);
            return {
              user: userPublic(db.users[user.id]),
              table: null,
              tables: Object.values(db.blackjackTables || {}).map(blackjackTableSummary).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            };
          });
          return json(200, result);
        }

        if (method === "POST" && segments[2] && segments[3] === "start") {
          const result = await withDb((db) => {
            const user = requireUser(db, event);
            const table = getBlackjackTableOrThrow(db, segments[2]);
            if (commandAlreadyApplied(table, user, body, "blackjack-start")) {
              return { user: userPublic(user), table: publicBlackjackTable(table, user), duplicate: true };
            }
            startBlackjackRound(db, table, user, body);
            runAutomaticBlackjackActions(db, table);
            touchTable(table);
            rememberCommand(table, user, body, "blackjack-start");
            return { user: userPublic(user), table: publicBlackjackTable(table, user) };
          });
          return json(200, result);
        }

        if (method === "POST" && segments[2] && segments[3] === "action") {
          const result = await withDb((db) => {
            const user = requireUser(db, event);
            const table = getBlackjackTableOrThrow(db, segments[2]);
            if (commandAlreadyApplied(table, user, body, "blackjack-action")) {
              return { user: userPublic(user), table: publicBlackjackTable(table, user), duplicate: true };
            }
            const timeoutChanged = applyBlackjackTimeouts(db, table);
            const player = table.seats.find((seat) => seat && seat.userId === user.id);
            if (timeoutChanged && (!player || table.currentTurnSeat !== player.seat || !blackjackPlayerNeedsAction(player))) {
              runAutomaticBlackjackActions(db, table);
              touchTable(table);
              return { user: userPublic(user), table: publicBlackjackTable(table, user), timedOut: true };
            }
            handleBlackjackTableAction(db, table, user, body);
            runAutomaticBlackjackActions(db, table);
            touchTable(table);
            rememberCommand(table, user, body, "blackjack-action");
            return { user: userPublic(user), table: publicBlackjackTable(table, user) };
          });
          return json(200, result);
        }
      }

      const blackjackActions = new Set(["deal", "hit", "stand", "double"]);
      if (method === "POST" && blackjackActions.has(segments[1])) {
        const action = segments[1];
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          return withBlackjackReceipt(db, user, body, action, () => {
            if (action === "deal") return startBlackjackHand(db, user, body);
            if (action === "hit") return hitBlackjackHand(db, user);
            if (action === "stand") return standBlackjackHand(db, user);
            return doubleBlackjackHand(db, user);
          });
        });
        return json(200, result);
      }
    }

    if (segments[0] === "tables") {
      if (method === "POST" && segments.length === 1) {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = createTable(user, body);
          table.quickMessages = normalizeQuickMessages(db.quickMessages);
          table.audioSettings = normalizeAudioSettings(db.audioSettings);
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

      if (method === "POST" && segments[1] && segments[2] === "taunt") {
        const result = await withDb((db) => {
          const user = requireUser(db, event);
          const table = getTableOrThrow(db, segments[1]);
          if (commandAlreadyApplied(table, user, body, "taunt")) {
            return { table: publicTable(table, user), duplicate: true };
          }
          handleTaunt(table, user, body);
          touchTable(table);
          rememberCommand(table, user, body, "taunt");
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
}

function responseFromResult(result) {
  const status = result.statusCode || 200;
  const body = status === 204 || status === 304 ? null : result.body || null;
  return new Response(body, { status, headers: result.headers || {} });
}

async function requestToEvent(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [key, value] of request.headers.entries()) headers[key] = value;
  return {
    httpMethod: request.method,
    path: url.pathname,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
    isBase64Encoded: false,
    queryStringParameters: Object.fromEntries(url.searchParams.entries())
  };
}

export class PokerGame {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async readDb() {
    return normalizeDb((await this.state.storage.get("db")) || defaultDb());
  }

  async writeDb(db) {
    db.updatedAt = nowIso();
    await this.state.storage.put("db", db);
  }

  async withDb(mutator) {
    const run = async () => {
      const db = await this.readDb();
      const result = await mutator(db);
      db.revision = Number(db.revision || 0) + 1;
      await this.writeDb(db);
      await this.scheduleNextAlarm(db);
      this.broadcastDb(db);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async requireUploadAdmin(request) {
    const db = await this.readDb();
    return requireAdmin(db, requestToAuthEvent(request), { refreshSession: false });
  }

  async handleAudioUploadChunk(request) {
    if (request.method === "OPTIONS") return jsonResponse(204, {});
    if (request.method !== "POST") return jsonResponse(405, { error: "只支持 POST" });
    try {
      await this.requireUploadAdmin(request);
      const url = new URL(request.url);
      const uploadId = cleanAudioUploadId(url.searchParams.get("uploadId"));
      const index = clampInt(url.searchParams.get("index"), 0, 200);
      const totalChunks = clampInt(url.searchParams.get("totalChunks"), 1, 200);
      const declaredSize = clampInt(url.searchParams.get("size"), 1, AUDIO_UPLOAD_MAX_BYTES);
      if (index >= totalChunks) throw new HttpError(400, "音频分片编号无效");
      if (declaredSize > AUDIO_UPLOAD_MAX_BYTES) throw new HttpError(413, "音频文件不能超过 20MB");

      const chunk = await request.arrayBuffer();
      if (chunk.byteLength <= 0) throw new HttpError(400, "音频分片为空");
      if (chunk.byteLength > AUDIO_UPLOAD_CHUNK_MAX_BYTES) throw new HttpError(413, "单个音频分片太大");
      await this.state.storage.put(audioChunkKey(uploadId, index), chunk);
      await this.state.storage.put(audioPartKey(uploadId, index), {
        size: chunk.byteLength,
        uploadedAt: nowIso()
      });
      return jsonResponse(200, { ok: true, uploadId, index });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error(error);
      return jsonResponse(status, { error: error.message || "音频上传失败" });
    }
  }

  async handleAudioUploadComplete(request) {
    if (request.method === "OPTIONS") return jsonResponse(204, {});
    if (request.method !== "POST") return jsonResponse(405, { error: "只支持 POST" });
    try {
      const admin = await this.requireUploadAdmin(request);
      const body = await request.json().catch(() => {
        throw new HttpError(400, "请求体必须是 JSON");
      });
      const uploadId = cleanAudioUploadId(body.uploadId);
      const totalChunks = clampInt(body.totalChunks, 1, 200);
      const declaredSize = clampInt(body.size, 1, AUDIO_UPLOAD_MAX_BYTES);
      const chunkSize = clampInt(body.chunkSize, 1, AUDIO_UPLOAD_CHUNK_MAX_BYTES);
      if (declaredSize > AUDIO_UPLOAD_MAX_BYTES) throw new HttpError(413, "音频文件不能超过 20MB");

      let totalSize = 0;
      for (let index = 0; index < totalChunks; index += 1) {
        const part = await this.state.storage.get(audioPartKey(uploadId, index));
        if (!part) throw new HttpError(400, "音频分片未上传完整，请重新上传");
        totalSize += Number(part.size || 0);
      }
      if (totalSize !== declaredSize) throw new HttpError(400, "音频分片大小不一致，请重新上传");

      const meta = {
        id: uploadId,
        name: cleanAudioName(body.name),
        mimeType: normalizeAudioMimeType(body.mimeType),
        size: totalSize,
        totalChunks,
        chunkSize,
        createdBy: admin.id,
        createdAt: nowIso()
      };
      await this.state.storage.put(audioMetaKey(uploadId), meta);
      return jsonResponse(200, {
        ok: true,
        asset: {
          src: `/api/audio/${uploadId}`,
          name: meta.name,
          volume: 0.8,
          enabled: true
        }
      });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error(error);
      return jsonResponse(status, { error: error.message || "音频上传失败" });
    }
  }

  async handleAudioAsset(request) {
    if (!["GET", "HEAD"].includes(request.method)) return jsonResponse(405, { error: "只支持 GET" });
    try {
      const url = new URL(request.url);
      const uploadId = cleanAudioUploadId(url.pathname.split("/").filter(Boolean).pop());
      const meta = await this.state.storage.get(audioMetaKey(uploadId));
      if (!meta) throw new HttpError(404, "音频不存在");
      const range = parseAudioRange(request.headers.get("range"), Number(meta.size || 0));
      const start = range ? range.start : 0;
      const end = range ? range.end : Number(meta.size || 0) - 1;
      const contentLength = Math.max(0, end - start + 1);
      const headers = {
        "content-type": meta.mimeType || "audio/mpeg",
        "cache-control": "public, max-age=31536000, immutable",
        "accept-ranges": "bytes",
        "content-length": String(contentLength)
      };
      if (range) headers["content-range"] = `bytes ${start}-${end}/${meta.size}`;
      const body = request.method === "HEAD"
        ? null
        : this.audioStream(uploadId, meta, start, end);
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error(error);
      const headers = status === 416 ? { "content-range": "bytes */0" } : undefined;
      return new Response(error.message || "音频读取失败", { status, headers });
    }
  }

  audioStream(uploadId, meta, start, end) {
    const storage = this.state.storage;
    const chunkSize = Number(meta.chunkSize || AUDIO_UPLOAD_CHUNK_MAX_BYTES);
    return new ReadableStream({
      async start(controller) {
        try {
          let offset = start;
          while (offset <= end) {
            const chunkIndex = Math.floor(offset / chunkSize);
            const chunk = await storage.get(audioChunkKey(uploadId, chunkIndex));
            if (!chunk) throw new Error("音频分片缺失");
            const chunkStart = chunkIndex * chunkSize;
            const from = Math.max(0, offset - chunkStart);
            const to = Math.min(chunk.byteLength, end - chunkStart + 1);
            controller.enqueue(new Uint8Array(chunk.slice(from, to)));
            offset = chunkStart + to;
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });
  }

  async handleWebSocket(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const db = await this.readDb();
    let user = null;
    try {
      user = userFromToken(db, url.searchParams.get("token"));
    } catch (error) {
      return new Response(error.message || "Unauthorized", { status: error.statusCode || 401 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment = {
      userId: user.id,
      clientId: String(url.searchParams.get("clientId") || "").slice(0, 120),
      tableId: String(url.searchParams.get("tableId") || "").slice(0, 80) || null,
      connectedAt: nowIso()
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify(realtimePayload(db, attachment)));
    await this.scheduleNextAlarm(db);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let payload = {};
    try {
      payload = JSON.parse(String(message || "{}"));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "消息格式错误", serverTime: nowIso() }));
      return;
    }

    const attachment = ws.deserializeAttachment() || {};
    if (payload.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", serverTime: nowIso() }));
      return;
    }
    if (payload.type === "subscribe") {
      attachment.tableId = payload.tableId ? String(payload.tableId).slice(0, 80) : null;
      attachment.clientId = payload.clientId ? String(payload.clientId).slice(0, 120) : attachment.clientId;
      attachment.subscribedAt = nowIso();
      ws.serializeAttachment(attachment);
    }

    const db = await this.readDb();
    ws.send(JSON.stringify(realtimePayload(db, attachment)));
  }

  webSocketClose() {}

  webSocketError(ws) {
    try {
      ws.close(1011, "WebSocket error");
    } catch {}
  }

  broadcastDb(db) {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1012, "HTTP polling enabled");
      } catch {}
    }
  }

  async scheduleNextAlarm(db) {
    const nextAt = this.nextWakeAt(db);
    if (nextAt) {
      await this.state.storage.setAlarm(nextAt);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  nextWakeAt(db) {
    const now = Date.now();
    const times = [];
    for (const table of Object.values(db.tables || {})) {
      if (!ACTIVE_STAGES.has(table.status)) continue;
      const current = table.seats?.[table.currentTurnSeat];
      if (current?.isBot) times.push(now + 250);
      if (table.actionDeadlineAt) {
        const deadline = new Date(table.actionDeadlineAt).getTime();
        if (Number.isFinite(deadline)) times.push(Math.max(now + 250, deadline));
      }
    }
    return times.length ? Math.min(...times) : null;
  }

  async alarm() {
    const run = async () => {
      const db = await this.readDb();
      let changed = false;
      for (const table of Object.values(db.tables || {})) {
        if (seatedPlayers(table).length === 0) {
          delete db.tables[table.id];
          changed = true;
          continue;
        }
        if (runAutomaticTableActions(table)) {
          touchTable(table);
          changed = true;
        }
      }
      if (changed) {
        db.revision = Number(db.revision || 0) + 1;
        await this.writeDb(db);
        this.broadcastDb(db);
      }
      await this.scheduleNextAlarm(db);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") return new Response("HTTP polling enabled", { status: 410 });
    if (url.pathname === "/api/admin/audio-upload/chunk") return this.handleAudioUploadChunk(request);
    if (url.pathname === "/api/admin/audio-upload/complete") return this.handleAudioUploadComplete(request);
    if (url.pathname.startsWith("/api/audio/")) return this.handleAudioAsset(request);
    return responseFromResult(await handleApiRequest(request, this, this.env));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      const id = env.POKER_GAME.idFromName("global");
      return env.POKER_GAME.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
