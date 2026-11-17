"use strict";
// Správa rolí z příkazové řádky – hlavně jmenování prvního admina (nikdo jiný ho jmenovat nemůže).
//
//   npm run user -- list
//   npm run user -- setup                          (nový odkaz na průvodce založením admina, jen když žádný admin není)
//   npm run user -- roles <email> admin            (role oddělené čárkou: warden,manager,admin; "member" = jen uživatel)
//
// Prvního admina zakládá průvodce (setup.html, odkaz vypíše server při startu). "roles" je nouzová cesta;
// účet musí existovat a admin si pak musí zapnout 2FA.
// Ve WordPressu tuto roli dostává administrátor webu.
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const { openDatabase } = require("../lib/db");
const { createAccounts, ROLES } = require("../lib/accounts");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "..", "data"));
const [command, email, roleList] = process.argv.slice(2);
const db = openDatabase(DATA_DIR);

if (command === "list") {
  const rows = db.prepare("SELECT email, first_name, last_name, member_id, roles, email_verified_at, totp_enabled_at FROM users ORDER BY roles DESC, email").all();
  for (const r of rows) console.log(`${r.email.padEnd(32)} ${`${r.first_name} ${r.last_name}`.padEnd(24)} ${(r.member_id || "—").padEnd(8)}  ${r.roles}${r.email_verified_at ? "" : "  (neověřený)"}${r.totp_enabled_at ? "  2FA" : ""}`);
  if (!rows.length) console.log("Žádné účty.");
} else if (command === "setup") {
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
  const setup = createAccounts({ db, config: loadConfig(), appUrl }).createSetupToken();
  if (!setup) { console.log("Admin už existuje – průvodce je vypnutý. Další adminy jmenuje admin v manažerském portálu."); process.exit(0); }
  console.log(`Odkaz na průvodce založením admina (platí ${setup.minutes} minut, jen jednou):
${setup.link}`);
} else if (command === "roles" && email && roleList) {
  const roles = roleList.split(",").map((role) => role.trim()).filter(Boolean);
  const unknown = roles.filter((role) => !ROLES.includes(role));
  if (unknown.length) { console.error(`Neznámá role: ${unknown.join(", ")}. Povolené: ${ROLES.join(", ")}`); process.exit(1); }
  const accounts = createAccounts({ db, config: loadConfig(), appUrl: "" });
  try {
    const user = accounts.forceRoles(email, roles);
    console.log(`${user.email}: ${user.roles.join(", ")}`);
    if (user.roles.includes("admin") && !user.twoFactor) console.log("Admin si musí po přihlášení v účtu zapnout dvoufázové ověření (2FA), jinak nemůže nic spravovat.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else {
  console.log("Použití: npm run user -- list | setup | roles <email> <role,role>");
  process.exit(command ? 1 : 0);
}
