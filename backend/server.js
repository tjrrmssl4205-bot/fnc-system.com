/**
 * 동서울 물류센터 일일 출근 현황 대시보드 - 자체 서버 백엔드
 *
 * 대시보드 HTML(BACKEND_URL)이 호출하는 API:
 *   GET  /api?date=YYYY-MM-DD   -> 해당 날짜 데이터 반환 (없으면 최신 데이터)
 *   GET  /api                   -> 최신(가장 최근 날짜) 데이터 반환
 *   POST /api  (JSON body)      -> workDateStr 기준으로 저장(있으면 덮어씀, 없으면 새로 추가)
 *
 * 로그인 / 계정관리 API:
 *   POST   /api/login           -> { id, password } 검증 후 토큰 발급
 *   GET    /api/users           -> 계정 목록 (관리자 전용)
 *   POST   /api/users           -> 계정 생성 (관리자 전용)
 *   PUT    /api/users/:id       -> 계정 수정 (관리자 전용)
 *   DELETE /api/users/:id       -> 계정 삭제 (관리자 전용)
 *
 * 데이터는 Turso(외부 SQLite 호환 DB)에 저장됩니다. 서버를 재배포해도 데이터가 유지됩니다.
 * 환경변수 TURSO_DATABASE_URL, TURSO_AUTH_TOKEN 이 없으면 로컬 파일(data.sqlite)로 동작합니다. (개발/테스트용)
 */
const express = require("express");
const cors = require("cors");
const { createClient } = require("@libsql/client");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
// async 라우트에서 오류가 나도 서버가 죽지 않고 500 응답을 주도록 감쌉니다.
["get", "post", "put", "delete"].forEach((m) => {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) => {
    if (m === "get" && handlers.length === 0) return orig(path); // app.get(settingName)
    const last = handlers.pop();
    handlers.push((req, res, next) => Promise.resolve(last(req, res, next)).catch((e) => {
      console.error("API 오류:", e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "서버 오류가 발생했습니다." });
    }));
    return orig(path, ...handlers);
  };
});
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
// 운영시 Render의 Environment 탭에서 JWT_SECRET 환경변수를 별도로 설정해주세요.
const JWT_SECRET = process.env.JWT_SECRET || "fnc-logistics-dev-secret-change-me";

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const db = createClient(
  TURSO_URL
    ? { url: TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: "file:" + DB_PATH }
);
console.log(TURSO_URL ? "DB: Turso 사용 중 (재배포해도 데이터 유지)" : "DB: 로컬 파일 사용 중 (재배포 시 초기화됨 - TURSO 환경변수를 설정하세요)");

// 행(Row)을 일반 객체로 변환 (JSON 응답용)
function toObj(rs, row) {
  const o = {};
  rs.columns.forEach((c, i) => { o[c] = row[i]; });
  return o;
}
// better-sqlite3 스타일(get/all/run)을 비동기로 흉내내는 얇은 래퍼
function P(sql) {
  const norm = (args) => {
    if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) return args[0];
    return args;
  };
  return {
    async get(...args) { const rs = await db.execute({ sql, args: norm(args) }); return rs.rows[0] ? toObj(rs, rs.rows[0]) : undefined; },
    async all(...args) { const rs = await db.execute({ sql, args: norm(args) }); return rs.rows.map((r) => toObj(rs, r)); },
    async run(...args) { await db.execute({ sql, args: norm(args) }); },
  };
}
async function initSchema() {

await db.execute(`
  CREATE TABLE IF NOT EXISTS state (
    workDateStr TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
await db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    passwordHash TEXT NOT NULL,
    name TEXT NOT NULL,
    centerName TEXT,
    role TEXT NOT NULL DEFAULT 'general',
    centerId TEXT,
    createdAt TEXT NOT NULL
  )
`);
// 예전 DB(centerId 컬럼 없이 만들어진 users 테이블)를 위한 안전한 컬럼 추가 (이미 있으면 무시)
try { await db.execute("ALTER TABLE users ADD COLUMN centerId TEXT"); } catch (e) { /* 이미 존재함 */ }
await db.execute(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT '공유',
    title TEXT NOT NULL,
    authorId TEXT,
    authorName TEXT,
    createdAt TEXT NOT NULL,
    attachmentName TEXT,
    attachmentType TEXT,
    attachmentData TEXT
  )
`);
await db.execute(`
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    desc TEXT,
    url TEXT NOT NULL,
    sortOrder INTEGER,
    createdAt TEXT NOT NULL
  )
`);
// 예전 DB(sortOrder 컬럼 없이 만들어진 links 테이블)를 위한 안전한 컬럼 추가 (이미 있으면 무시)
try { await db.execute("ALTER TABLE links ADD COLUMN sortOrder INTEGER"); } catch (e) { /* 이미 존재함 */ }
try { await db.execute("ALTER TABLE links ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* 이미 존재함 */ }
try { await db.execute("ALTER TABLE links ADD COLUMN defaultKey TEXT"); } catch (e) { /* 이미 존재함 */ }
// 계정별 개인 메모장 / 해야할일 (본인 계정만 읽고 씀)
await db.execute(`
  CREATE TABLE IF NOT EXISTS memos (
    userId TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL
  )
`);
await db.execute(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  )
`);
// 일일 마감보고 (센터 일일 마감보고 툴 - 기존 대시보드를 대체)
await db.execute(`
  CREATE TABLE IF NOT EXISTS daily_entries (
    center TEXT NOT NULL,
    date TEXT NOT NULL,
    json TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (center, date)
  )
`);
await db.execute(`
  CREATE TABLE IF NOT EXISTS daily_config (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
}

// 재사용할 prepared statement들을 모듈 전역에 보관합니다.
// (요청마다 P()를 새로 호출하면, 일부 Node/better-sqlite3 조합에서
//  임시 Statement 객체가 곧바로 GC되면서 네이티브 크래시(Assertion failed)가
//  발생하는 경우가 있어 이를 방지하기 위함입니다.)
const stmt = {
  countUsers: P("SELECT COUNT(*) AS c FROM users"),
  insertUser: P(`
    INSERT INTO users (id, passwordHash, name, centerName, role, centerId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getUserById: P("SELECT * FROM users WHERE id = ?"),
  listUsers: P("SELECT id, name, centerName, centerId, role, createdAt FROM users ORDER BY createdAt ASC"),
  updateUser: P(`UPDATE users SET passwordHash=?, name=?, centerName=?, role=?, centerId=? WHERE id=?`),
  updateOwnCenter: P("UPDATE users SET centerId=? WHERE id=?"),
  deleteUser: P("DELETE FROM users WHERE id = ?"),
  countAdmins: P("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"),
  getStateByDate: P("SELECT * FROM state WHERE workDateStr = ?"),
  getLatestState: P("SELECT * FROM state ORDER BY workDateStr DESC LIMIT 1"),
  upsertState: P(`
    INSERT INTO state (workDateStr, json, updatedAt)
    VALUES (@workDateStr, @json, @updatedAt)
    ON CONFLICT(workDateStr) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt
  `),
  listState: P("SELECT workDateStr, updatedAt FROM state ORDER BY workDateStr DESC LIMIT 90"),

  countPosts: P("SELECT COUNT(*) AS c FROM posts"),
  insertPost: P(`
    INSERT INTO posts (category, title, authorId, authorName, createdAt, attachmentName, attachmentType, attachmentData)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listPosts: P("SELECT id, category, title, authorId, authorName, createdAt, attachmentName, attachmentType FROM posts ORDER BY id DESC LIMIT 200"),
  getPostById: P("SELECT * FROM posts WHERE id = ?"),
  deletePost: P("DELETE FROM posts WHERE id = ?"),

  countLinks: P("SELECT COUNT(*) AS c FROM links"),
  insertLink: P(`INSERT INTO links (name, desc, url, sortOrder, pinned, createdAt) VALUES (?, ?, ?, ?, ?, ?)`),
  listLinks: P("SELECT id, name, desc, url, sortOrder, pinned, createdAt FROM links ORDER BY sortOrder ASC, id ASC"),
  getLinkById: P("SELECT * FROM links WHERE id = ?"),
  getLinkByUrl: P("SELECT * FROM links WHERE url = ?"),
  setLinkPinned: P("UPDATE links SET pinned = 1 WHERE id = ?"),
  getLinkByKey: P("SELECT * FROM links WHERE defaultKey = ?"),
  listLegacyPinnedLinks: P("SELECT id FROM links WHERE pinned = 1 AND defaultKey IS NULL ORDER BY id ASC"),
  setLinkKey: P("UPDATE links SET defaultKey = ?, pinned = 1 WHERE id = ?"),
  updateLink: P("UPDATE links SET name = ?, desc = ?, url = ? WHERE id = ?"),
  deleteSampleLinks: P("DELETE FROM links WHERE url = 'https://example.com' AND pinned = 0"),
  deleteLink: P("DELETE FROM links WHERE id = ?"),

  getMemo: P("SELECT content, updatedAt FROM memos WHERE userId = ?"),
  upsertMemo: P(`
    INSERT INTO memos (userId, content, updatedAt) VALUES (@userId, @content, @updatedAt)
    ON CONFLICT(userId) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt
  `),
  listTodos: P("SELECT id, text, done, createdAt FROM todos WHERE userId = ? ORDER BY done ASC, id ASC LIMIT 300"),
  countTodos: P("SELECT COUNT(*) AS c FROM todos WHERE userId = ?"),
  insertTodo: P("INSERT INTO todos (userId, text, done, createdAt) VALUES (?, ?, 0, ?)"),
  getTodo: P("SELECT * FROM todos WHERE id = ?"),
  setTodoDone: P("UPDATE todos SET done = ? WHERE id = ?"),
  deleteTodo: P("DELETE FROM todos WHERE id = ?"),
  maxLinkOrder: P("SELECT COALESCE(MAX(sortOrder), 0) AS m FROM links"),
  updateLinkOrder: P("UPDATE links SET sortOrder = ? WHERE id = ?"),
  nullOrderLinks: P("SELECT id FROM links WHERE sortOrder IS NULL ORDER BY id ASC"),

  listDailyEntries: P("SELECT center, date, json, updatedAt FROM daily_entries ORDER BY date ASC"),
  upsertDailyEntry: P(`
    INSERT INTO daily_entries (center, date, json, updatedAt)
    VALUES (@center, @date, @json, @updatedAt)
    ON CONFLICT(center, date) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt
  `),
  deleteDailyEntry: P("DELETE FROM daily_entries WHERE center = ? AND date = ?"),

  getDailyConfig: P("SELECT json FROM daily_config WHERE id = 'default'"),
  upsertDailyConfig: P(`
    INSERT INTO daily_config (id, json, updatedAt)
    VALUES ('default', @json, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt
  `),
};

// 최초 실행 시 기본 관리자 계정 자동 생성 (센터 ID: admin / 비밀번호: admin1234)
// 로그인 후 반드시 센터 계정관리에서 비밀번호를 변경하거나 새 관리자 계정을 만들고 이 계정은 삭제하세요.
async function seedAdmin() {
  const count = (await stmt.countUsers.get()).c;
  if (count === 0) {
    const hash = bcrypt.hashSync("admin1234", 10);
    await stmt.insertUser.run("admin", hash, "관리자", "전체 센터 관리", "admin", null, new Date().toISOString());
    console.log("기본 관리자 계정 생성됨 -> id: admin / password: admin1234 (로그인 후 꼭 변경하세요)");
  }
}

// 고정 관리자 계정 2개 자동 생성/보정 (id: fnc / tjrrmssl, 비밀번호: 1111)
// 이미 존재하면 건드리지 않고, 없을 때만 새로 만듭니다.
async function seedFixedAdmins() {
  const fixedAccounts = [
    { id: "fnc", password: "1111", name: "fnc 관리자", centerName: "전체 센터 관리" },
    { id: "tjrrmssl", password: "1111", name: "tjrrmssl 관리자", centerName: "전체 센터 관리" },
  ];
  for (const acc of fixedAccounts) {
    const exists = await stmt.getUserById.get(acc.id);
    if (!exists) {
      const hash = bcrypt.hashSync(acc.password, 10);
      await stmt.insertUser.run(acc.id, hash, acc.name, acc.centerName, "admin", null, new Date().toISOString());
      console.log(`고정 관리자 계정 생성됨 -> id: ${acc.id} / password: ${acc.password}`);
    }
  }
}

// 최초 실행 시 예시 게시글/자주쓰는 사이트 기본값 등록 (모두 비어있을 때만)
async function seedBoard() {
  if ((await stmt.countPosts.get()).c === 0) {
    const now = new Date().toISOString();
    const samples = [
      ["공지", "9월 정기 안전점검 일정 안내"],
      ["서식", "근태 매트릭스 최신 양식 업로드"],
      ["공유", "추석 연휴 물류 일정 조정 건"],
      ["서식", "사고경위서 작성 양식(개정판)"],
      ["공유", "아워홈 WMS 점검 안내(9/25 새벽)"],
    ];
    for (const [category, title] of samples) {
      await stmt.insertPost.run(category, title, "admin", "관리자", now, null, null, null);
    }
  }
}

// 자주쓰는 사이트 기본(고정) 목록 - 삭제 불가, 이름/설명/주소는 화면에서 수정 가능.
// key로 구분하기 때문에 주소를 수정해도 다시 만들어지지 않고, 목록에 새 기본 사이트를 추가하면 다음 시작 때 자동으로 들어갑니다.
const DEFAULT_LINKS = [
  { key: "ohlog", name: "아워홈 WMS", desc: "OurHome Logistics (OHLOG)", url: "http://osis.ourhome.co.kr/ohlog/LinkedLogin.jsp" },
  { key: "groupware", name: "그룹웨어", desc: "아워홈 그룹웨어", url: "http://ep.ourhome.co.kr/loginForm.do" },
  { key: "safety", name: "FNC 안전교육", desc: "FNC 안전교육", url: "https://github.com/tjrrmssl4205-bot/fnc-system.com/blob/main/backend/server.js" },
];
async function ensureDefaultLinks() {
  await stmt.deleteSampleLinks.run(); // 예전 예시(example.com) 링크 정리
  // 키 없이 만들어졌던 예전 고정 사이트(WMS, 그룹웨어)에 키를 붙입니다. (이미 주소를 수정했어도 중복 생성 방지)
  const legacyKeys = ["ohlog", "groupware"];
  const legacyRows = (await stmt.listLegacyPinnedLinks.all()).slice(0, legacyKeys.length);
  for (let i = 0; i < legacyRows.length; i++) {
    if (!(await stmt.getLinkByKey.get(legacyKeys[i]))) await stmt.setLinkKey.run(legacyKeys[i], legacyRows[i].id);
  }
  for (const d of DEFAULT_LINKS) {
    if (await stmt.getLinkByKey.get(d.key)) continue;
    const sameUrl = await stmt.getLinkByUrl.get(d.url);
    if (sameUrl) {
      await stmt.setLinkKey.run(d.key, sameUrl.id);
    } else {
      const nextOrder = (await stmt.maxLinkOrder.get()).m + 1;
      await stmt.insertLink.run(d.name, d.desc, d.url, nextOrder, 1, new Date().toISOString());
      const added = await stmt.getLinkByUrl.get(d.url);
      if (added) await stmt.setLinkKey.run(d.key, added.id);
    }
  }
}

// 예전 데이터(순서값 없음)에 순서를 한 번만 채워줍니다.
async function backfillLinkOrder() {
  const rows = await stmt.nullOrderLinks.all();
  for (const r of rows) await stmt.updateLinkOrder.run(r.id, r.id);
}

// 일일 마감보고 센터 목록 최초 기본값 (실제 6개 물류센터로 고정) - 이미 설정이 있으면 건드리지 않습니다.
const DEFAULT_DAILY_CENTERS = [
  { id: "dongseoul", name: "동서울 물류센터" },
  { id: "yongin2", name: "용인2 물류센터" },
  { id: "ansan", name: "안산 물류센터" },
  { id: "gyeryong", name: "계룡 물류센터" },
  { id: "honam", name: "호남 물류센터" },
  { id: "namosan", name: "남오산 물류센터" },
];
async function seedDailyConfig() {
  const row = await stmt.getDailyConfig.get();
  if (!row) {
    const json = JSON.stringify({ centers: DEFAULT_DAILY_CENTERS, targetEnd: 22 * 60 });
    await stmt.upsertDailyConfig.run({ json, updatedAt: new Date().toISOString() });
    console.log("일일 마감보고 기본 센터 목록 생성됨 (동서울/용인2/안산/계룡/호남/남오산)");
  }
}

app.use(cors());               // 대시보드가 다른 도메인(GitHub Pages)에서 호출하므로 CORS 허용
// 대시보드가 text/plain으로 보내는 경우(CORS preflight 회피)도 JSON으로 파싱되게 처리
app.use(express.json({ limit: "12mb", type: ["application/json", "text/plain"] }));

// ---------- 인증 미들웨어 ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token && req.query.token) token = req.query.token; // 첨부파일 다운로드 링크(<a>)용
  if (!token) return res.status(401).json({ ok: false, error: "로그인이 필요합니다." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "세션이 만료되었습니다. 다시 로그인해주세요." });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "관리자만 접근할 수 있습니다." });
  }
  next();
}

// ---------- 로그인 ----------
app.post("/api/login", async (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !password) {
    return res.status(400).json({ ok: false, error: "센터 ID와 비밀번호를 입력하세요." });
  }
  const user = await stmt.getUserById.get(id);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, error: "센터 ID 또는 비밀번호가 올바르지 않습니다." });
  }
  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, centerName: user.centerName },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.json({ ok: true, token, id: user.id, name: user.name, role: user.role, centerName: user.centerName });
});

// ---------- 센터 계정관리 (관리자 전용) ----------
app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  res.json(await stmt.listUsers.all());
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { id, password, name, centerName, role, centerId } = req.body || {};
  if (!id || !password || !name) {
    return res.status(400).json({ ok: false, error: "센터 ID, 이름, 비밀번호는 필수입니다." });
  }
  const exists = await stmt.getUserById.get(id);
  if (exists) {
    return res.status(409).json({ ok: false, error: "이미 존재하는 센터 ID입니다." });
  }
  const hash = bcrypt.hashSync(password, 10);
  await stmt.insertUser.run(id, hash, name, centerName || "", role === "admin" ? "admin" : "general", centerId || null, new Date().toISOString());
  res.json({ ok: true });
});

app.put("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const targetId = req.params.id;
  const existing = await stmt.getUserById.get(targetId);
  if (!existing) return res.status(404).json({ ok: false, error: "계정을 찾을 수 없습니다." });

  const { password, name, centerName, role, centerId } = req.body || {};
  const newName = name || existing.name;
  const newCenter = centerName != null ? centerName : existing.centerName;
  const newRole = role === "admin" ? "admin" : "general";
  const newCenterId = centerId !== undefined ? (centerId || null) : existing.centerId;
  const newHash = password ? bcrypt.hashSync(password, 10) : existing.passwordHash;

  await stmt.updateUser.run(newHash, newName, newCenter, newRole, newCenterId, targetId);
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const targetId = req.params.id;
  const adminCount = (await stmt.countAdmins.get()).c;
  const target = await stmt.getUserById.get(targetId);
  if (!target) return res.status(404).json({ ok: false, error: "계정을 찾을 수 없습니다." });
  if (target.role === "admin" && adminCount <= 1) {
    return res.status(400).json({ ok: false, error: "마지막 관리자 계정은 삭제할 수 없습니다." });
  }
  await stmt.deleteUser.run(targetId);
  res.json({ ok: true });
});

// 내 계정 정보 (일일보고 - 로그인한 사람이 자기 담당 센터를 고르고, 다음 로그인부터 기억하기 위함)
app.get("/api/users/me", requireAuth, async (req, res) => {
  const user = await stmt.getUserById.get(req.user.id);
  if (!user) return res.status(404).json({ ok: false, error: "계정을 찾을 수 없습니다." });
  res.json({ id: user.id, name: user.name, centerName: user.centerName, centerId: user.centerId || null, role: user.role });
});

// 내 담당 센터 지정/변경 (일반 계정이 일일보고 첫 로그인 시 직접 선택)
app.put("/api/users/me/center", requireAuth, async (req, res) => {
  const { centerId } = req.body || {};
  if (!centerId || typeof centerId !== "string") {
    return res.status(400).json({ ok: false, error: "센터를 선택하세요." });
  }
  await stmt.updateOwnCenter.run(centerId, req.user.id);
  res.json({ ok: true });
});

// ---------- 게시판 ----------
app.get("/api/posts", requireAuth, async (req, res) => {
  res.json(await stmt.listPosts.all());
});

app.post("/api/posts", requireAuth, async (req, res) => {
  const { category, title, attachmentName, attachmentType, attachmentData } = req.body || {};
  if (!title) {
    return res.status(400).json({ ok: false, error: "제목을 입력하세요." });
  }
  // 첨부파일은 base64로 DB에 저장 (대략 8MB 이하 권장 - Free 요금제 메모리 한도 고려)
  await stmt.insertPost.run(
    category || "공유",
    title,
    req.user.id,
    req.user.name,
    new Date().toISOString(),
    attachmentName || null,
    attachmentType || null,
    attachmentData || null
  );
  res.json({ ok: true });
});

// 첨부파일 다운로드 (인증: Authorization 헤더 또는 ?token= 쿼리)
app.get("/api/posts/:id/attachment", requireAuth, async (req, res) => {
  const post = await stmt.getPostById.get(req.params.id);
  if (!post || !post.attachmentData) {
    return res.status(404).json({ ok: false, error: "첨부파일을 찾을 수 없습니다." });
  }
  const buffer = Buffer.from(post.attachmentData, "base64");
  res.setHeader("Content-Type", post.attachmentType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(post.attachmentName || "file")}"`
  );
  res.send(buffer);
});

app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  const post = await stmt.getPostById.get(req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "게시글을 찾을 수 없습니다." });
  if (req.user.role !== "admin" && post.authorId !== req.user.id) {
    return res.status(403).json({ ok: false, error: "본인 글만 삭제할 수 있습니다." });
  }
  await stmt.deletePost.run(req.params.id);
  res.json({ ok: true });
});

// ---------- 내 메모장 / 해야할일 (로그인한 본인 것만) ----------
app.get("/api/memo", requireAuth, async (req, res) => {
  const row = await stmt.getMemo.get(req.user.id);
  res.json({ content: row ? row.content : "", updatedAt: row ? row.updatedAt : null });
});

app.put("/api/memo", requireAuth, async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== "string" || content.length > 20000) {
    return res.status(400).json({ ok: false, error: "메모는 2만자 이내 텍스트여야 합니다." });
  }
  await stmt.upsertMemo.run({ userId: req.user.id, content, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.get("/api/todos", requireAuth, async (req, res) => {
  res.json(await stmt.listTodos.all(req.user.id));
});

app.post("/api/todos", requireAuth, async (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "할 일 내용을 입력하세요." });
  if (text.length > 300) return res.status(400).json({ ok: false, error: "할 일은 300자 이내로 입력하세요." });
  if ((await stmt.countTodos.get(req.user.id)).c >= 300) {
    return res.status(400).json({ ok: false, error: "할 일은 최대 300개까지 등록할 수 있습니다." });
  }
  await stmt.insertTodo.run(req.user.id, text, new Date().toISOString());
  res.json({ ok: true });
});

app.put("/api/todos/:id", requireAuth, async (req, res) => {
  const todo = await stmt.getTodo.get(req.params.id);
  if (!todo || todo.userId !== req.user.id) return res.status(404).json({ ok: false, error: "항목을 찾을 수 없습니다." });
  await stmt.setTodoDone.run((req.body || {}).done ? 1 : 0, todo.id);
  res.json({ ok: true });
});

app.delete("/api/todos/:id", requireAuth, async (req, res) => {
  const todo = await stmt.getTodo.get(req.params.id);
  if (!todo || todo.userId !== req.user.id) return res.status(404).json({ ok: false, error: "항목을 찾을 수 없습니다." });
  await stmt.deleteTodo.run(todo.id);
  res.json({ ok: true });
});

// ---------- 자주쓰는 사이트 ----------
app.get("/api/links", requireAuth, async (req, res) => {
  res.json(await stmt.listLinks.all());
});

app.post("/api/links", requireAuth, async (req, res) => {
  const { name, desc, url } = req.body || {};
  if (!name || !url) {
    return res.status(400).json({ ok: false, error: "사이트 이름과 URL은 필수입니다." });
  }
  const nextOrder = (await stmt.maxLinkOrder.get()).m + 1;
  await stmt.insertLink.run(name, desc || "", url, nextOrder, 0, new Date().toISOString());
  res.json({ ok: true });
});

// 자주쓰는 사이트 순서 변경 (드래그로 재배열한 결과를 id 배열로 받아 순서를 저장)
app.put("/api/links/reorder", requireAuth, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ ok: false, error: "정렬 순서 목록이 필요합니다." });
  }
  for (let idx = 0; idx < order.length; idx++) await stmt.updateLinkOrder.run(idx + 1, order[idx]);
  res.json({ ok: true });
});

// 자주쓰는 사이트 수정 (기본/고정 사이트도 이름·설명·주소 수정 가능, 삭제만 불가)
app.put("/api/links/:id", requireAuth, async (req, res) => {
  const link = await stmt.getLinkById.get(req.params.id);
  if (!link) return res.status(404).json({ ok: false, error: "사이트를 찾을 수 없습니다." });
  const { name, desc, url } = req.body || {};
  if (!name || !url) {
    return res.status(400).json({ ok: false, error: "사이트 이름과 URL은 필수입니다." });
  }
  await stmt.updateLink.run(String(name).trim(), String(desc || "").trim(), String(url).trim(), link.id);
  res.json({ ok: true });
});

app.delete("/api/links/:id", requireAuth, async (req, res) => {
  const link = await stmt.getLinkById.get(req.params.id);
  if (link && link.pinned) {
    return res.status(403).json({ ok: false, error: "기본(고정) 사이트는 삭제할 수 없습니다." });
  }
  await stmt.deleteLink.run(req.params.id);
  res.json({ ok: true });
});

// ---------- 일일 마감보고 (센터 일일 마감보고 툴 - 서버 공유 저장) ----------
// 항목 목록 전체 반환: [{ center, date, ...entry필드, updatedAt }]
app.get("/api/daily/entries", requireAuth, async (req, res) => {
  const rows = await stmt.listDailyEntries.all();
  const result = rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.json); } catch (e) { data = {}; }
    return { center: r.center, date: r.date, updatedAt: r.updatedAt, ...data };
  });
  res.json(result);
});

// 항목 저장(업서트): body = { center, date, ...entry필드 }
app.post("/api/daily/entries", requireAuth, async (req, res) => {
  const { center, date, ...entry } = req.body || {};
  if (!center || !date) {
    return res.status(400).json({ ok: false, error: "center와 date는 필수입니다." });
  }
  const json = JSON.stringify(entry);
  const updatedAt = new Date().toISOString();
  await stmt.upsertDailyEntry.run({ center, date, json, updatedAt });
  res.json({ ok: true });
});

// 항목 삭제
app.delete("/api/daily/entries/:center/:date", requireAuth, async (req, res) => {
  await stmt.deleteDailyEntry.run(req.params.center, req.params.date);
  res.json({ ok: true });
});

// 설정(센터 목록, 목표 마감시간 등) 조회/저장 - 회사 전체 공용 설정 1개
app.get("/api/daily/config", requireAuth, async (req, res) => {
  const row = await stmt.getDailyConfig.get();
  if (!row) return res.json(null);
  try {
    res.json(JSON.parse(row.json));
  } catch (e) {
    res.status(500).json({ ok: false, error: "설정을 읽는 중 오류가 발생했습니다." });
  }
});

app.post("/api/daily/config", requireAuth, async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "invalid JSON body" });
  }
  const json = JSON.stringify(payload);
  const updatedAt = new Date().toISOString();
  await stmt.upsertDailyConfig.run({ json, updatedAt });
  res.json({ ok: true });
});

// 헬스체크
app.get("/", async (req, res) => {
  res.json({ ok: true, service: "attendance-dashboard-backend" });
});

// 조회
app.get("/api", async (req, res) => {
  const { date } = req.query;
  let row;
  if (date) {
    row = await stmt.getStateByDate.get(date);
  }
  if (!row) {
    row = await stmt.getLatestState.get();
  }
  if (!row) return res.json({});
  try {
    res.json(JSON.parse(row.json));
  } catch (e) {
    res.status(500).json({ error: "저장된 데이터를 읽는 중 오류가 발생했습니다." });
  }
});

// 저장 (업서트)
app.post("/api", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "invalid JSON body" });
  }
  const workDateStr = payload.workDateStr || new Date().toISOString().slice(0, 10);
  const json = JSON.stringify(payload);
  const updatedAt = new Date().toISOString();

  await stmt.upsertState.run({ workDateStr, json, updatedAt });

  res.json({ ok: true, workDateStr, updatedAt });
});

// 지난 기록 목록 (일별 로그 카드에서 활용 가능)
app.get("/api/list", async (req, res) => {
  res.json(await stmt.listState.all());
});

(async () => {
  await initSchema();
  await seedAdmin();
  await seedFixedAdmins();
  await seedBoard();
  await ensureDefaultLinks();
  await backfillLinkOrder();
  await seedDailyConfig();
  app.listen(PORT, () => {
    console.log(`Attendance dashboard backend listening on port ${PORT}`);
  });
})().catch((e) => {
  console.error("시작 실패(DB 연결 확인):", e);
  process.exit(1);
});
