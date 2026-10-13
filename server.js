const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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
const USERS = [
  { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, role: "admin" },
  { username: process.env.DAD_USERNAME, password: process.env.DAD_PASSWORD, role: "dad" }
].filter(user => user.username && user.password);

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error("Missing/weak SESSION_SECRET. Copy .env.example to .env and set a random secret of at least 32 characters.");
  process.exit(1);
}
if (USERS.length !== 2 || USERS[0].username === USERS[1].username) {
  console.error("Set distinct ADMIN_USERNAME/ADMIN_PASSWORD and DAD_USERNAME/DAD_PASSWORD values in .env.");
  process.exit(1);
}

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { dad: [], expenses: [], semesterDad: [], semesterPayments: [], nextDadId: 1, nextExpenseId: 1, nextSemesterDadId: 1, nextSemesterPaymentId: 1 }; }
}
let data = loadData();
data.semesterDad ??= [];
data.semesterPayments ??= [];
data.nextSemesterDadId ??= Math.max(0, ...data.semesterDad.map(x=>x.id||0), 0) + 1;
data.nextSemesterPaymentId ??= Math.max(0, ...data.semesterPayments.map(x=>x.id||0), 0) + 1;
// Move older Semester Fee records into the separate section so they are not lost or double-counted.
const oldDad = data.dad.filter(x => x.reason === "Semester Fee");
const oldExp = data.expenses.filter(x => x.category === "Semester Fee");
if (oldDad.length) { oldDad.forEach(x=>data.semesterDad.push({id:data.nextSemesterDadId++,amount:Number(x.amount),date:x.date,semester:x.semester||"",note:x.custom_reason||""})); data.dad=data.dad.filter(x=>x.reason!=="Semester Fee"); }
if (oldExp.length) { oldExp.forEach(x=>data.semesterPayments.push({id:data.nextSemesterPaymentId++,amount:Number(x.amount),date:x.date,semester:x.semester||"",note:x.note||""})); data.expenses=data.expenses.filter(x=>x.category!=="Semester Fee"); }
function saveData(){ fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2),"utf8"); }
saveData();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  req.sessionUser = readSession(req.headers.cookie || "");
  next();
});
app.use(express.static(path.join(__dirname,"public"), { index: false }));

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
app.get("/login", (req, res) => {
  if (req.sessionUser) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/api/auth/me", (req, res) => res.json({ authenticated: !!req.sessionUser, user: req.sessionUser || null }));
app.post("/api/auth/login", (req, res, next) => {
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
const dadReasons=["Print","Text","Food","Fine","Other"];
const expenseCategories=["Print","Text","Food","Fine","Other"];
const validAmount=v=>Number.isFinite(Number(v))&&Number(v)>0;
const validDate=v=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v);
function validateDad(b){if(!validAmount(b.amount)||!validDate(b.date)||!dadReasons.includes(b.reason))return "Amount, date and a valid reason are required.";if(b.reason==="Other"&&!String(b.customReason||"").trim())return "Custom reason is required when Other is selected.";return null;}
function validateExpense(b){if(!validAmount(b.amount)||!validDate(b.date)||!expenseCategories.includes(b.category))return "Amount, date and a valid category are required.";if(b.category==="Other"&&!String(b.customCategory||"").trim())return "Custom category is required when Other is selected.";return null;}
function validateSemester(b){if(!validAmount(b.amount)||!validDate(b.date))return "Amount and date are required.";return null;}
function filterRows(rows,q,type){let r=[...rows],today=new Date().toISOString().slice(0,10);if(q.preset==="today")r=r.filter(x=>x.date===today);if(q.preset==="month")r=r.filter(x=>x.date.slice(0,7)===today.slice(0,7));if(q.preset==="year")r=r.filter(x=>x.date.slice(0,4)===today.slice(0,4));if(q.from)r=r.filter(x=>x.date>=q.from);if(q.to)r=r.filter(x=>x.date<=q.to);if(q.search){let s=String(q.search).toLowerCase();r=r.filter(x=>JSON.stringify(x).toLowerCase().includes(s));}if(q.sort==="oldest")r.sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id);else if(q.sort==="highest")r.sort((a,b)=>b.amount-a.amount||b.date.localeCompare(a.date));else if(q.sort==="lowest")r.sort((a,b)=>a.amount-b.amount||b.date.localeCompare(a.date));else r.sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);return r;}
function sum(rows){return rows.reduce((a,x)=>a+Number(x.amount),0)}
app.get("/api/dad",(req,res)=>res.json(filterRows(data.dad,req.query,"dad")));
app.get("/api/expenses",(req,res)=>res.json(filterRows(data.expenses,req.query,"expense")));
app.get("/api/semester/dad",(req,res)=>res.json(filterRows(data.semesterDad,req.query,"semester")));
app.get("/api/semester/payments",(req,res)=>res.json(filterRows(data.semesterPayments,req.query,"semester")));
app.post("/api/dad",(req,res)=>{let e=validateDad(req.body);if(e)return res.status(400).json({error:e});let r={id:data.nextDadId++,amount:Number(req.body.amount),date:req.body.date,reason:req.body.reason,custom_reason:req.body.reason==="Other"?String(req.body.customReason).trim():null};data.dad.push(r);saveData();res.status(201).json({id:r.id})});
app.put("/api/dad/:id",(req,res)=>{let e=validateDad(req.body);if(e)return res.status(400).json({error:e});let r=data.dad.find(x=>x.id===Number(req.params.id));if(!r)return res.status(404).json({error:"Transaction not found."});Object.assign(r,{amount:Number(req.body.amount),date:req.body.date,reason:req.body.reason,custom_reason:req.body.reason==="Other"?String(req.body.customReason).trim():null});saveData();res.json({ok:true})});
app.delete("/api/dad/:id",(req,res)=>{let i=data.dad.findIndex(x=>x.id===Number(req.params.id));if(i<0)return res.status(404).json({error:"Transaction not found."});data.dad.splice(i,1);saveData();res.json({ok:true})});
app.post("/api/expenses",(req,res)=>{let e=validateExpense(req.body);if(e)return res.status(400).json({error:e});let r={id:data.nextExpenseId++,amount:Number(req.body.amount),date:req.body.date,category:req.body.category,custom_category:req.body.category==="Other"?String(req.body.customCategory).trim():null,note:String(req.body.note||"").trim()||null};data.expenses.push(r);saveData();res.status(201).json({id:r.id})});
app.put("/api/expenses/:id",(req,res)=>{let e=validateExpense(req.body);if(e)return res.status(400).json({error:e});let r=data.expenses.find(x=>x.id===Number(req.params.id));if(!r)return res.status(404).json({error:"Expense not found."});Object.assign(r,{amount:Number(req.body.amount),date:req.body.date,category:req.body.category,custom_category:req.body.category==="Other"?String(req.body.customCategory).trim():null,note:String(req.body.note||"").trim()||null});saveData();res.json({ok:true})});
app.delete("/api/expenses/:id",(req,res)=>{let i=data.expenses.findIndex(x=>x.id===Number(req.params.id));if(i<0)return res.status(404).json({error:"Expense not found."});data.expenses.splice(i,1);saveData();res.json({ok:true})});
function semesterValidation(req,res){let e=validateSemester(req.body);if(e){res.status(400).json({error:e});return false}return true}
app.post("/api/semester/dad",(req,res)=>{if(!semesterValidation(req,res))return;let r={id:data.nextSemesterDadId++,amount:Number(req.body.amount),date:req.body.date,semester:String(req.body.semester||"").trim(),note:String(req.body.note||"").trim()||null};data.semesterDad.push(r);saveData();res.status(201).json({id:r.id})});
app.put("/api/semester/dad/:id",(req,res)=>{if(!semesterValidation(req,res))return;let r=data.semesterDad.find(x=>x.id===Number(req.params.id));if(!r)return res.status(404).json({error:"Semester Fee record not found."});Object.assign(r,{amount:Number(req.body.amount),date:req.body.date,semester:String(req.body.semester||"").trim(),note:String(req.body.note||"").trim()||null});saveData();res.json({ok:true})});
app.delete("/api/semester/dad/:id",(req,res)=>{let i=data.semesterDad.findIndex(x=>x.id===Number(req.params.id));if(i<0)return res.status(404).json({error:"Record not found."});data.semesterDad.splice(i,1);saveData();res.json({ok:true})});
app.post("/api/semester/payments",(req,res)=>{if(!semesterValidation(req,res))return;let r={id:data.nextSemesterPaymentId++,amount:Number(req.body.amount),date:req.body.date,semester:String(req.body.semester||"").trim(),note:String(req.body.note||"").trim()||null};data.semesterPayments.push(r);saveData();res.status(201).json({id:r.id})});
app.put("/api/semester/payments/:id",(req,res)=>{if(!semesterValidation(req,res))return;let r=data.semesterPayments.find(x=>x.id===Number(req.params.id));if(!r)return res.status(404).json({error:"Payment not found."});Object.assign(r,{amount:Number(req.body.amount),date:req.body.date,semester:String(req.body.semester||"").trim(),note:String(req.body.note||"").trim()||null});saveData();res.json({ok:true})});
app.delete("/api/semester/payments/:id",(req,res)=>{let i=data.semesterPayments.findIndex(x=>x.id===Number(req.params.id));if(i<0)return res.status(404).json({error:"Payment not found."});data.semesterPayments.splice(i,1);saveData();res.json({ok:true})});
app.get("/api/summary",(req,res)=>{const received=sum(data.dad)+sum(data.semesterDad),spent=sum(data.expenses)+sum(data.semesterPayments),today=new Date().toISOString().slice(0,10),month=today.slice(0,7),year=today.slice(0,4);const allDad=[...data.dad,...data.semesterDad],allSpent=[...data.expenses,...data.semesterPayments];const period=(p)=>({received:sum(allDad.filter(x=>p(x.date))),spent:sum(allSpent.filter(x=>p(x.date)))});const group=(rows,key)=>Object.values(rows.reduce((o,x)=>{const k=x[key];o[k]??={ [key]:k,total:0};o[k].total+=Number(x.amount);return o},{}));res.json({received,spent,balance:received-spent,dadSemester:sum(data.semesterDad),paidSemester:sum(data.semesterPayments),overallNonSemesterReceived:sum(data.dad),overallNonSemesterSpent:sum(data.expenses),periods:{today:period(d=>d===today),month:period(d=>d.slice(0,7)===month),year:period(d=>d.slice(0,4)===year)},dadByReason:group(data.dad,"reason"),expenseByCategory:group(data.expenses,"category"),semesterDadCount:data.semesterDad.length,semesterPaymentCount:data.semesterPayments.length})});
app.get("*",requireLogin,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`My College Money Tracker running at http://localhost:${PORT}`));
