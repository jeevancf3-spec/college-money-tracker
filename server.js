const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

// Load local .env without an extra dependency. Host environment variables take priority.
try {
  const envText = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !match[1].startsWith("#") && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "money-tracker-data.json");
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_COOKIE = "mct.sid";
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const DATABASE_URL = process.env.DATABASE_URL;

const USERS = [
  { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, role: "admin" },
  { username: process.env.DAD_USERNAME, password: process.env.DAD_PASSWORD, role: "dad" }
].filter(user => user.username && user.password);

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error("Missing/weak SESSION_SECRET. Set a random secret of at least 32 characters in .env or the host environment.");
  process.exit(1);
}
if (USERS.length !== 2 || USERS[0].username === USERS[1].username) {
  console.error("Set distinct ADMIN_USERNAME/ADMIN_PASSWORD and DAD_USERNAME/DAD_PASSWORD values in .env.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL. Add your Neon connection string to .env as DATABASE_URL=... . Do not share it publicly.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon requires TLS. The connection string should be kept private.
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function emptyData() {
  return {
    dad: [], expenses: [], semesterDad: [], semesterPayments: [],
    nextDadId: 1, nextExpenseId: 1, nextSemesterDadId: 1, nextSemesterPaymentId: 1
  };
}

function loadLocalData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...emptyData(), ...parsed };
  } catch {
    return emptyData();
  }
}

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["true", "1", "yes", "on", "checked"].includes(value.trim().toLowerCase());
  return false;
}
function normalizedAmount(row) {
  const raw = row?.amount ?? row?.value ?? row?.total ?? row?.money;
  const n = Number(String(raw ?? 0).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function hasCollegeFlag(row) {
  // Some earlier builds stored the checkbox under different names; accept any affirmative legacy field.
  return [row?.collegeMoney, row?.college_money, row?.forCollege, row?.isCollegeMoney, row?.is_college_money, row?.moneyToCollege, row?.money_to_college, row?.for_college, row?.college].some(truthyFlag);
}
function normalizeData(input) {
  const d = { ...emptyData(), ...(input || {}) };
  d.dad = Array.isArray(d.dad) ? d.dad : [];
  d.expenses = Array.isArray(d.expenses) ? d.expenses : [];
  d.semesterDad = Array.isArray(d.semesterDad) ? d.semesterDad : [];
  d.semesterPayments = Array.isArray(d.semesterPayments) ? d.semesterPayments : [];
  // Normalize legacy field names without dropping any saved transactions.
  d.dad = d.dad.map(x => ({ ...x, amount: normalizedAmount(x), collegeMoney: hasCollegeFlag(x) }));
  d.expenses = d.expenses.map(x => ({ ...x, amount: normalizedAmount(x) }));
  d.semesterDad = d.semesterDad.map(x => ({ ...x, amount: normalizedAmount(x) }));
  d.semesterPayments = d.semesterPayments.map(x => ({ ...x, amount: normalizedAmount(x) }));
  d.nextDadId = Math.max(Number(d.nextDadId) || 1, ...d.dad.map(x => Number(x.id) + 1 || 1));
  d.nextExpenseId = Math.max(Number(d.nextExpenseId) || 1, ...d.expenses.map(x => Number(x.id) + 1 || 1));
  d.nextSemesterDadId = Math.max(Number(d.nextSemesterDadId) || 1, ...d.semesterDad.map(x => Number(x.id) + 1 || 1));
  d.nextSemesterPaymentId = Math.max(Number(d.nextSemesterPaymentId) || 1, ...d.semesterPayments.map(x => Number(x.id) + 1 || 1));

  // Move old Semester Fee rows into the dedicated section on first import only.
  const oldDad = d.dad.filter(x => x.reason === "Semester Fee");
  const oldExpenses = d.expenses.filter(x => x.category === "Semester Fee");
  for (const x of oldDad) {
    d.semesterDad.push({ id: d.nextSemesterDadId++, amount: Number(x.amount), date: x.date, semester: x.semester || "", note: x.custom_reason || "" });
  }
  for (const x of oldExpenses) {
    d.semesterPayments.push({ id: d.nextSemesterPaymentId++, amount: Number(x.amount), date: x.date, semester: x.semester || "", note: x.note || "" });
  }
  if (oldDad.length) d.dad = d.dad.filter(x => x.reason !== "Semester Fee");
  if (oldExpenses.length) d.expenses = d.expenses.filter(x => x.category !== "Semester Fee");
  return d;
}

let data = emptyData();
let writeQueue = Promise.resolve();

async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS college_money_tracker_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const existing = await pool.query("SELECT data FROM college_money_tracker_state WHERE id = 1");
  if (existing.rowCount > 0) {
    // Once initialized, the database is authoritative; never overwrite it with an old local file.
    data = normalizeData(existing.rows[0].data);
    console.log("Loaded tracker data from PostgreSQL.");
  } else {
    // First run: preserve and import existing local JSON records if the file exists.
    data = normalizeData(loadLocalData());
    await pool.query(
      "INSERT INTO college_money_tracker_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(data)]
    );
    const confirmed = await pool.query("SELECT data FROM college_money_tracker_state WHERE id = 1");
    data = normalizeData(confirmed.rows[0].data);
    console.log("Initialized PostgreSQL tracker data. Existing local JSON data was imported if present.");
  }
}

function saveData() {
  const snapshot = JSON.stringify(data);
  writeQueue = writeQueue.then(() => pool.query(
    "UPDATE college_money_tracker_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1",
    [snapshot]
  ));
  return writeQueue;
}

app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));
app.use((req, res, next) => {
  req.sessionUser = readSession(req.headers.cookie || "");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function readSession(cookieHeader) {
  const token = cookieHeader.split(";").map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now() || !payload.user?.username) return null;
    return payload.user;
  } catch { return null; }
}
function setSessionCookie(res, user) {
  const value = signSession({ user, exp: Date.now() + SESSION_MAX_AGE });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}${secure}`);
}
function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
function requireLogin(req, res, next) {
  if (req.sessionUser) return next();
  if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Please log in to continue." });
  return res.redirect("/login");
}
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get("/login", (req, res) => {
  if (req.sessionUser) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/api/auth/me", (req, res) => res.json({ authenticated: !!req.sessionUser, user: req.sessionUser || null }));
app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const user = USERS.find(candidate => safeEqual(candidate.username, username) && safeEqual(candidate.password, password));
  if (!user) return res.status(401).json({ error: "Username or password is incorrect." });
  const sessionUser = { username: user.username, role: user.role };
  setSessionCookie(res, sessionUser);
  res.json({ ok: true, user: sessionUser });
});
app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", requireLogin);
const dadReasons = ["Print", "Text", "Food", "Fine", "Other"];
const expenseCategories = ["Print", "Text", "Food", "Fine", "Other"];
const validAmount = v => Number.isFinite(Number(v)) && Number(v) > 0;
const validDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
function validReceipt(value) {
  return typeof value === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 7_000_000;
}
function validateDad(b) {
  if (!validAmount(b.amount) || !validDate(b.date) || !dadReasons.includes(b.reason)) return "Amount, date and a valid reason are required.";
  if (b.reason === "Other" && !String(b.customReason || "").trim()) return "Custom reason is required when Other is selected.";
  return null;
}
function validateExpense(b) {
  if (!validAmount(b.amount) || !validDate(b.date) || !expenseCategories.includes(b.category)) return "Amount, date and a valid category are required.";
  if (b.category === "Other" && !String(b.customCategory || "").trim()) return "Custom category is required when Other is selected.";
  return null;
}
function validateSemester(b) {
  if (!validAmount(b.amount) || !validDate(b.date)) return "Amount and date are required.";
  return null;
}
function filterRows(rows, q) {
  let r = [...rows];
  const today = new Date().toISOString().slice(0, 10);
  if (q.preset === "today") r = r.filter(x => x.date === today);
  if (q.preset === "month") r = r.filter(x => x.date.slice(0, 7) === today.slice(0, 7));
  if (q.preset === "year") r = r.filter(x => x.date.slice(0, 4) === today.slice(0, 4));
  if (q.from) r = r.filter(x => x.date >= q.from);
  if (q.to) r = r.filter(x => x.date <= q.to);
  if (q.search) {
    const s = String(q.search).toLowerCase();
    r = r.filter(x => JSON.stringify(x).toLowerCase().includes(s));
  }
  if (q.sort === "oldest") r.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  else if (q.sort === "highest") r.sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date));
  else if (q.sort === "lowest") r.sort((a, b) => a.amount - b.amount || b.date.localeCompare(a.date));
  else r.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return r;
}
function sum(rows) { return rows.reduce((a, x) => a + normalizedAmount(x), 0); }

app.get("/api/dad", (req, res) => res.json(filterRows(data.dad, req.query)));
app.get("/api/expenses", (req, res) => res.json(filterRows(data.expenses, req.query)));
app.get("/api/semester/dad", (req, res) => res.json(filterRows(data.semesterDad, req.query)));
app.get("/api/semester/payments", (req, res) => res.json(filterRows(data.semesterPayments, req.query)));

app.post("/api/dad", asyncRoute(async (req, res) => {
  const e = validateDad(req.body); if (e) return res.status(400).json({ error: e });
  const r = { id: data.nextDadId++, amount: Number(req.body.amount), date: req.body.date, reason: req.body.reason, custom_reason: req.body.reason === "Other" ? String(req.body.customReason).trim() : null,
    collegeMoney: Boolean(req.body.collegeMoney), receipt: validReceipt(req.body.receipt) ? req.body.receipt : null };
  data.dad.push(r); await saveData(); res.status(201).json({ id: r.id });
}));
app.put("/api/dad/:id", asyncRoute(async (req, res) => {
  const e = validateDad(req.body); if (e) return res.status(400).json({ error: e });
  const r = data.dad.find(x => x.id === Number(req.params.id)); if (!r) return res.status(404).json({ error: "Transaction not found." });
  Object.assign(r, { amount: Number(req.body.amount), date: req.body.date, reason: req.body.reason, custom_reason: req.body.reason === "Other" ? String(req.body.customReason).trim() : null,
    collegeMoney: Boolean(req.body.collegeMoney), receipt: validReceipt(req.body.receipt) ? req.body.receipt : (req.body.receipt === "" ? null : r.receipt) });
  await saveData(); res.json({ ok: true });
}));
app.delete("/api/dad/:id", asyncRoute(async (req, res) => {
  const i = data.dad.findIndex(x => x.id === Number(req.params.id)); if (i < 0) return res.status(404).json({ error: "Transaction not found." });
  data.dad.splice(i, 1); await saveData(); res.json({ ok: true });
}));

app.post("/api/expenses", asyncRoute(async (req, res) => {
  const e = validateExpense(req.body); if (e) return res.status(400).json({ error: e });
  const studentPocketMoney = Math.max(0, sum(data.dad.filter(x => !hasCollegeFlag(x))) - sum(data.expenses));
  if (studentPocketMoney <= 0) return res.status(400).json({ error: "Student Pocket Money is ₹0.00. Add money from Dad without ticking ‘This money is for college’ before adding an expense." });
  if (Number(req.body.amount) > studentPocketMoney) return res.status(400).json({ error: `This expense is more than the available Student Pocket Money (${studentPocketMoney.toFixed(2)}).` });
  const r = { id: data.nextExpenseId++, amount: Number(req.body.amount), date: req.body.date, category: req.body.category, custom_category: req.body.category === "Other" ? String(req.body.customCategory).trim() : null, note: String(req.body.note || "").trim() || null, receipt: validReceipt(req.body.receipt) ? req.body.receipt : null };
  data.expenses.push(r); await saveData(); res.status(201).json({ id: r.id });
}));
app.put("/api/expenses/:id", asyncRoute(async (req, res) => {
  const e = validateExpense(req.body); if (e) return res.status(400).json({ error: e });
  const r = data.expenses.find(x => x.id === Number(req.params.id)); if (!r) return res.status(404).json({ error: "Expense not found." });
  Object.assign(r, { amount: Number(req.body.amount), date: req.body.date, category: req.body.category, custom_category: req.body.category === "Other" ? String(req.body.customCategory).trim() : null, note: String(req.body.note || "").trim() || null, receipt: validReceipt(req.body.receipt) ? req.body.receipt : (req.body.receipt === "" ? null : r.receipt) });
  await saveData(); res.json({ ok: true });
}));
app.delete("/api/expenses/:id", asyncRoute(async (req, res) => {
  const i = data.expenses.findIndex(x => x.id === Number(req.params.id)); if (i < 0) return res.status(404).json({ error: "Expense not found." });
  data.expenses.splice(i, 1); await saveData(); res.json({ ok: true });
}));

function semesterValidation(req, res) {
  const e = validateSemester(req.body);
  if (e) { res.status(400).json({ error: e }); return false; }
  return true;
}
app.post("/api/semester/dad", asyncRoute(async (req, res) => {
  if (!semesterValidation(req, res)) return;
  const r = { id: data.nextSemesterDadId++, amount: Number(req.body.amount), date: req.body.date, semester: String(req.body.semester || "").trim(), note: String(req.body.note || "").trim() || null, receipt: validReceipt(req.body.receipt) ? req.body.receipt : null };
  data.semesterDad.push(r); await saveData(); res.status(201).json({ id: r.id });
}));
app.put("/api/semester/dad/:id", asyncRoute(async (req, res) => {
  if (!semesterValidation(req, res)) return;
  const r = data.semesterDad.find(x => x.id === Number(req.params.id)); if (!r) return res.status(404).json({ error: "Semester Fee record not found." });
  Object.assign(r, { amount: Number(req.body.amount), date: req.body.date, semester: String(req.body.semester || "").trim(), note: String(req.body.note || "").trim() || null, receipt: validReceipt(req.body.receipt) ? req.body.receipt : (req.body.receipt === "" ? null : r.receipt) });
  await saveData(); res.json({ ok: true });
}));
app.delete("/api/semester/dad/:id", asyncRoute(async (req, res) => {
  const i = data.semesterDad.findIndex(x => x.id === Number(req.params.id)); if (i < 0) return res.status(404).json({ error: "Record not found." });
  data.semesterDad.splice(i, 1); await saveData(); res.json({ ok: true });
}));
app.post("/api/semester/payments", asyncRoute(async (req, res) => {
  if (!semesterValidation(req, res)) return;
  const r = { id: data.nextSemesterPaymentId++, amount: Number(req.body.amount), date: req.body.date, semester: String(req.body.semester || "").trim(), note: String(req.body.note || "").trim() || null, receipt: validReceipt(req.body.receipt) ? req.body.receipt : null };
  data.semesterPayments.push(r); await saveData(); res.status(201).json({ id: r.id });
}));
app.put("/api/semester/payments/:id", asyncRoute(async (req, res) => {
  if (!semesterValidation(req, res)) return;
  const r = data.semesterPayments.find(x => x.id === Number(req.params.id)); if (!r) return res.status(404).json({ error: "Payment not found." });
  Object.assign(r, { amount: Number(req.body.amount), date: req.body.date, semester: String(req.body.semester || "").trim(), note: String(req.body.note || "").trim() || null, receipt: validReceipt(req.body.receipt) ? req.body.receipt : (req.body.receipt === "" ? null : r.receipt) });
  await saveData(); res.json({ ok: true });
}));
app.delete("/api/semester/payments/:id", asyncRoute(async (req, res) => {
  const i = data.semesterPayments.findIndex(x => x.id === Number(req.params.id)); if (i < 0) return res.status(404).json({ error: "Record not found." });
  data.semesterPayments.splice(i, 1); await saveData(); res.json({ ok: true });
}));

app.get("/api/summary", (req, res) => {
  const received = sum(data.dad) + sum(data.semesterDad);
  const spent = sum(data.expenses) + sum(data.semesterPayments);
  const moneyToCollege = sum(data.dad.filter(x => hasCollegeFlag(x)));
  const studentPocketReceived = sum(data.dad.filter(x => !hasCollegeFlag(x)));
  const totalStudentSpent = sum(data.expenses);
  const studentPocketMoney = Math.max(0, studentPocketReceived - totalStudentSpent);
  const today = new Date().toISOString().slice(0, 10), month = today.slice(0, 7), year = today.slice(0, 4);
  const allDad = [...data.dad, ...data.semesterDad], allSpent = [...data.expenses, ...data.semesterPayments];
  const period = p => ({ received: sum(allDad.filter(x => p(x.date))), spent: sum(allSpent.filter(x => p(x.date))) });
  const group = (rows, key) => Object.values(rows.reduce((o, x) => {
    const k = x[key]; o[k] ??= { [key]: k, total: 0 }; o[k].total += Number(x.amount); return o;
  }, {}));
  res.json({ received, spent, balance: received - spent, dadSemester: sum(data.semesterDad), paidSemester: sum(data.semesterPayments), collegeMoney: moneyToCollege, studentPocketMoney, studentPocketReceived, totalStudentSpent, overallNonSemesterReceived: sum(data.dad), overallNonSemesterSpent: sum(data.expenses), periods: { today: period(d => d === today), month: period(d => d.slice(0, 7) === month), year: period(d => d.slice(0, 4) === year) }, dadByReason: Object.values(data.dad.reduce((o, x) => { const label = x.reason === "Other" ? (String(x.custom_reason || "").trim() || "Other") : x.reason; o[label] ??= { reason: label, total: 0 }; o[label].total += Number(x.amount); return o; }, {})), expenseByCategory: group(data.expenses, "category"), semesterDadCount: data.semesterDad.length, semesterPaymentCount: data.semesterPayments.length });
});

app.get("*", requireLogin, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  console.error("Request/database error:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong while saving or loading data. Please try again." });
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`My College Money Tracker running on port ${PORT}`));
  } catch (err) {
    console.error("Could not connect to PostgreSQL or initialize tracker data:", err.message);
    console.error("Check DATABASE_URL in .env. Your local JSON file has not been deleted.");
    process.exit(1);
  }
}
start();
