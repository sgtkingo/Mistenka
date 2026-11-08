const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "mistenka.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    license TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    email TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    returned_at TEXT
  );
  CREATE TABLE IF NOT EXISTS catches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_code TEXT NOT NULL,
    species TEXT NOT NULL,
    length_cm REAL NOT NULL,
    weight_kg REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let value = "";
  req.on("data", (chunk) => { value += chunk; });
  req.on("end", () => { try { resolve(JSON.parse(value || "{}")); } catch (error) { reject(error); } });
  req.on("error", reject);
});
const makeCode = () => {
  let code;
  do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (db.prepare("SELECT 1 FROM tickets WHERE code = ?").get(code));
  return code;
};
const publicTicket = (ticket) => ({ code: ticket.code, license: ticket.license, firstName: ticket.first_name, lastName: ticket.last_name, birthDate: ticket.birth_date, email: ticket.email, date: ticket.date, status: ticket.status });

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  try {
    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    if (pathname === "/api/tickets" && req.method === "POST") {
      const body = await readBody(req);
      const required = ["license", "firstName", "lastName", "birthDate", "email", "date"];
      if (required.some((key) => !String(body[key] || "").trim())) return json(res, 400, { error: "Vyplňte všechna povinná pole." });
      const code = makeCode();
      db.prepare("INSERT INTO tickets (code, license, first_name, last_name, birth_date, email, date) VALUES (?, ?, ?, ?, ?, ?, ?)").run(code, body.license.trim().toUpperCase(), body.firstName.trim(), body.lastName.trim(), body.birthDate, body.email.trim(), body.date);
      return json(res, 201, publicTicket(db.prepare("SELECT * FROM tickets WHERE code = ?").get(code)));
    }
    const ticketMatch = pathname.match(/^\/api\/tickets\/([A-Z0-9]{6})$/);
    if (ticketMatch && req.method === "GET") {
      const ticket = db.prepare("SELECT * FROM tickets WHERE code = ?").get(ticketMatch[1]);
      return ticket ? json(res, 200, publicTicket(ticket)) : json(res, 404, { error: "Místenka nebyla nalezena." });
    }
    if (ticketMatch && req.method === "PATCH") {
      const ticket = db.prepare("SELECT * FROM tickets WHERE code = ?").get(ticketMatch[1]);
      if (!ticket) return json(res, 404, { error: "Místenka nebyla nalezena." });
      if (ticket.status !== "active") return json(res, 409, { error: "Místenka už není aktivní." });
      const body = await readBody(req);
      if (!Array.isArray(body.catches) || body.catches.length === 0) return json(res, 400, { error: "Vyplňte alespoň jeden úlovek." });
      if (body.catches.some((item) => !String(item.species || "").trim() || !Number(item.length) || Number(item.length) <= 0)) return json(res, 400, { error: "Každý úlovek musí mít druh a délku." });
      const insertCatch = db.prepare("INSERT INTO catches (ticket_code, species, length_cm, weight_kg) VALUES (?, ?, ?, ?)");
      db.exec("BEGIN");
      try {
        body.catches.forEach((item) => insertCatch.run(ticketMatch[1], String(item.species).trim(), Number(item.length), item.weight == null ? null : Number(item.weight)));
        db.prepare("UPDATE tickets SET status = 'returned', returned_at = CURRENT_TIMESTAMP WHERE code = ?").run(ticketMatch[1]);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, publicTicket(db.prepare("SELECT * FROM tickets WHERE code = ?").get(ticketMatch[1])));
    }
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    const safePath = path.normalize(path.join(root, file));
    if (!safePath.startsWith(root) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) return json(res, 404, { error: "Nenalezeno." });
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    res.writeHead(200, { "Content-Type": types[path.extname(safePath)] || "application/octet-stream" });
    fs.createReadStream(safePath).pipe(res);
  } catch (error) {
    json(res, 500, { error: "Lokální server nedokázal požadavek dokončit." });
    console.error(error);
  }
});
server.listen(3000, () => console.log("Místenka demo běží na http://localhost:3000"));
