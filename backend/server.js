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
 * 데이터는 이 서버의 SQLite 파일(data.sqlite)에 저장됩니다. (구글시트 대신 직접 관리하는 DB)
 */
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
// 운영시 Render의 Environment 탭에서 JWT_SECRET 환경변수를 별도로 설정해주세요.
const JWT_SECRET = process.env.JWT_SECRET || "fnc-logistics-dev-secret-change-me";

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    workDateStr TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    passwordHash TEXT NOT NULL,
    name TEXT NOT NULL,
    centerName TEXT,
    role TEXT NOT NULL DEFAULT 'general',
    createdAt TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT '공유',
    title TEXT NOT NULL,
    authorId TEXT,
    authorName TEXT,
    createdAt TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    desc TEXT,
    url TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`);

// 재사용할 prepared statement들을 모듈 전역에 보관합니다.
// (요청마다 db.prepare()를 새로 호출하면, 일부 Node/better-sqlite3 조합에서
//  임시 Statement 객체가 곧바로 GC되면서 네이티브 크래시(Assertion failed)가
//  발생하는 경우가 있어 이를 방지하기 위함입니다.)
const stmt = {
  countUsers: db.prepare("SELECT COUNT(*) AS c FROM users"),
  insertUser: db.prepare(`
    INSERT INTO users (id, passwordHash, name, centerName, role, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  listUsers: db.prepare("SELECT id, name, centerName, role, createdAt FROM users ORDER BY createdAt ASC"),
  updateUser: db.prepare(`UPDATE users SET passwordHash=?, name=?, centerName=?, role=? WHERE id=?`),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  countAdmins: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"),
  getStateByDate: db.prepare("SELECT * FROM state WHERE workDateStr = ?"),
  getLatestState: db.prepare("SELECT * FROM state ORDER BY workDateStr DESC LIMIT 1"),
  upsertState: db.prepare(`
    INSERT INTO state (workDateStr, json, updatedAt)
    VALUES (@workDateStr, @json, @updatedAt)
    ON CONFLICT(workDateStr) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt
  `),
  listState: db.prepare("SELECT workDateStr, updatedAt FROM state ORDER BY workDateStr DESC LIMIT 90"),

  countPosts: db.prepare("SELECT COUNT(*) AS c FROM posts"),
  insertPost: db.prepare(`INSERT INTO posts (category, title, authorId, authorName, createdAt) VALUES (?, ?, ?, ?, ?)`),
  listPosts: db.prepare("SELECT id, category, title, authorId, authorName, createdAt FROM posts ORDER BY id DESC LIMIT 200"),
  getPostById: db.prepare("SELECT * FROM posts WHERE id = ?"),
  deletePost: db.prepare("DELETE FROM posts WHERE id = ?"),

  countLinks: db.prepare("SELECT COUNT(*) AS c FROM links"),
  insertLink: db.prepare(`INSERT INTO links (name, desc, url, createdAt) VALUES (?, ?, ?, ?)`),
  listLinks: db.prepare("SELECT id, name, desc, url, createdAt FROM links ORDER BY id ASC"),
  deleteLink: db.prepare("DELETE FROM links WHERE id = ?"),
};

// 최초 실행 시 기본 관리자 계정 자동 생성 (센터 ID: admin / 비밀번호: admin1234)
// 로그인 후 반드시 센터 계정관리에서 비밀번호를 변경하거나 새 관리자 계정을 만들고 이 계정은 삭제하세요.
function seedAdmin() {
  const count = stmt.countUsers.get().c;
  if (count === 0) {
    const hash = bcrypt.hashSync("admin1234", 10);
    stmt.insertUser.run("admin", hash, "관리자", "전체 센터 관리", "admin", new Date().toISOString());
    console.log("기본 관리자 계정 생성됨 -> id: admin / password: admin1234 (로그인 후 꼭 변경하세요)");
  }
}
seedAdmin();

// 최초 실행 시 예시 게시글/자주쓰는 사이트 기본값 등록 (모두 비어있을 때만)
function seedBoard() {
  if (stmt.countPosts.get().c === 0) {
    const now = new Date().toISOString();
    const samples = [
      ["공지", "9월 정기 안전점검 일정 안내"],
      ["서식", "근태 매트릭스 최신 양식 업로드"],
      ["공유", "추석 연휴 물류 일정 조정 건"],
      ["서식", "사고경위서 작성 양식(개정판)"],
      ["공유", "아워홈 WMS 점검 안내(9/25 새벽)"],
    ];
    samples.forEach(([category, title]) => {
      stmt.insertPost.run(category, title, "admin", "관리자", now);
    });
  }
  if (stmt.countLinks.get().c === 0) {
    const now = new Date().toISOString();
    const samples = [
      ["아워홈 WMS", "물류관리시스템", "https://example.com"],
      ["QR 출퇴근 시스템", "직원 출근체크", "https://example.com"],
      ["채용 관리", "지원자 현황", "https://example.com"],
      ["전자결재", "그룹웨어", "https://example.com"],
    ];
    samples.forEach(([name, desc, url]) => {
      stmt.insertLink.run(name, desc, url, now);
    });
  }
}
seedBoard();

app.use(cors());               // 대시보드가 다른 도메인(GitHub Pages)에서 호출하므로 CORS 허용
// 대시보드가 text/plain으로 보내는 경우(CORS preflight 회피)도 JSON으로 파싱되게 처리
app.use(express.json({ limit: "5mb", type: ["application/json", "text/plain"] }));

// ---------- 인증 미들웨어 ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
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
app.post("/api/login", (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !password) {
    return res.status(400).json({ ok: false, error: "센터 ID와 비밀번호를 입력하세요." });
  }
  const user = stmt.getUserById.get(id);
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
app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  res.json(stmt.listUsers.all());
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const { id, password, name, centerName, role } = req.body || {};
  if (!id || !password || !name) {
    return res.status(400).json({ ok: false, error: "센터 ID, 이름, 비밀번호는 필수입니다." });
  }
  const exists = stmt.getUserById.get(id);
  if (exists) {
    return res.status(409).json({ ok: false, error: "이미 존재하는 센터 ID입니다." });
  }
  const hash = bcrypt.hashSync(password, 10);
  stmt.insertUser.run(id, hash, name, centerName || "", role === "admin" ? "admin" : "general", new Date().toISOString());
  res.json({ ok: true });
});

app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const existing = stmt.getUserById.get(targetId);
  if (!existing) return res.status(404).json({ ok: false, error: "계정을 찾을 수 없습니다." });

  const { password, name, centerName, role } = req.body || {};
  const newName = name || existing.name;
  const newCenter = centerName != null ? centerName : existing.centerName;
  const newRole = role === "admin" ? "admin" : "general";
  const newHash = password ? bcrypt.hashSync(password, 10) : existing.passwordHash;

  stmt.updateUser.run(newHash, newName, newCenter, newRole, targetId);
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const adminCount = stmt.countAdmins.get().c;
  const target = stmt.getUserById.get(targetId);
  if (!target) return res.status(404).json({ ok: false, error: "계정을 찾을 수 없습니다." });
  if (target.role === "admin" && adminCount <= 1) {
    return res.status(400).json({ ok: false, error: "마지막 관리자 계정은 삭제할 수 없습니다." });
  }
  stmt.deleteUser.run(targetId);
  res.json({ ok: true });
});

// ---------- 게시판 ----------
app.get("/api/posts", requireAuth, (req, res) => {
  res.json(stmt.listPosts.all());
});

app.post("/api/posts", requireAuth, (req, res) => {
  const { category, title } = req.body || {};
  if (!title) {
    return res.status(400).json({ ok: false, error: "제목을 입력하세요." });
  }
  stmt.insertPost.run(category || "공유", title, req.user.id, req.user.name, new Date().toISOString());
  res.json({ ok: true });
});

app.delete("/api/posts/:id", requireAuth, (req, res) => {
  const post = stmt.getPostById.get(req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "게시글을 찾을 수 없습니다." });
  if (req.user.role !== "admin" && post.authorId !== req.user.id) {
    return res.status(403).json({ ok: false, error: "본인 글만 삭제할 수 있습니다." });
  }
  stmt.deletePost.run(req.params.id);
  res.json({ ok: true });
});

// ---------- 자주쓰는 사이트 ----------
app.get("/api/links", requireAuth, (req, res) => {
  res.json(stmt.listLinks.all());
});

app.post("/api/links", requireAuth, (req, res) => {
  const { name, desc, url } = req.body || {};
  if (!name || !url) {
    return res.status(400).json({ ok: false, error: "사이트 이름과 URL은 필수입니다." });
  }
  stmt.insertLink.run(name, desc || "", url, new Date().toISOString());
  res.json({ ok: true });
});

app.delete("/api/links/:id", requireAuth, (req, res) => {
  stmt.deleteLink.run(req.params.id);
  res.json({ ok: true });
});

// 헬스체크
app.get("/", (req, res) => {
  res.json({ ok: true, service: "attendance-dashboard-backend" });
});

// 조회
app.get("/api", (req, res) => {
  const { date } = req.query;
  let row;
  if (date) {
    row = stmt.getStateByDate.get(date);
  }
  if (!row) {
    row = stmt.getLatestState.get();
  }
  if (!row) return res.json({});
  try {
    res.json(JSON.parse(row.json));
  } catch (e) {
    res.status(500).json({ error: "저장된 데이터를 읽는 중 오류가 발생했습니다." });
  }
});

// 저장 (업서트)
app.post("/api", (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "invalid JSON body" });
  }
  const workDateStr = payload.workDateStr || new Date().toISOString().slice(0, 10);
  const json = JSON.stringify(payload);
  const updatedAt = new Date().toISOString();

  stmt.upsertState.run({ workDateStr, json, updatedAt });

  res.json({ ok: true, workDateStr, updatedAt });
});

// 지난 기록 목록 (일별 로그 카드에서 활용 가능)
app.get("/api/list", (req, res) => {
  res.json(stmt.listState.all());
});

app.listen(PORT, () => {
  console.log(`Attendance dashboard backend listening on port ${PORT}`);
});
