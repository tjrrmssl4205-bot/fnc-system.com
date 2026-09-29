/**
 * 동서울 물류센터 일일 출근 현황 대시보드 - 자체 서버 백엔드
 *
 * 대시보드 HTML(BACKEND_URL)이 호출하는 API:
 *   GET  /api?date=YYYY-MM-DD   -> 해당 날짜 데이터 반환 (없으면 최신 데이터)
 *   GET  /api                   -> 최신(가장 최근 날짜) 데이터 반환
 *   POST /api  (JSON body)      -> workDateStr 기준으로 저장(있으면 덮어씀, 없으면 새로 추가)
 *
 * 데이터는 이 서버의 SQLite 파일(data.sqlite)에 저장됩니다. (구글시트 대신 직접 관리하는 DB)
 */
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    workDateStr TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

app.use(cors());               // 대시보드가 다른 도메인(GitHub Pages)에서 호출하므로 CORS 허용
// 대시보드가 text/plain으로 보내는 경우(CORS preflight 회피)도 JSON으로 파싱되게 처리
app.use(express.json({ limit: "5mb", type: ["application/json", "text/plain"] }));

// 헬스체크
app.get("/", (req, res) => {
  res.json({ ok: true, service: "attendance-dashboard-backend" });
});

// 조회
app.get("/api", (req, res) => {
  const { date } = req.query;
  let row;
  if (date) {
    row = db.prepare("SELECT * FROM state WHERE workDateStr = ?").get(date);
  }
  if (!row) {
    row = db.prepare("SELECT * FROM state ORDER BY workDateStr DESC LIMIT 1").get();
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

  db.prepare(`
    INSERT INTO state (workDateStr, json, updatedAt)
    VALUES (@workDateStr, @json, @updatedAt)
    ON CONFLICT(workDateStr) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt
  `).run({ workDateStr, json, updatedAt });

  res.json({ ok: true, workDateStr, updatedAt });
});

// 지난 기록 목록 (일별 로그 카드에서 활용 가능)
app.get("/api/list", (req, res) => {
  const rows = db.prepare("SELECT workDateStr, updatedAt FROM state ORDER BY workDateStr DESC LIMIT 90").all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`Attendance dashboard backend listening on port ${PORT}`);
});
