"""Sestaví instalační ZIP WordPress pluginu, případně balíček Node verze.

  python scripts/build-plugin.py [nazev-pluginu] [--fake-bank] [--example]   WP plugin (výchozí Fio, nebo falešná banka)
  python scripts/build-plugin.py --node                                      dist/mistenka-node.zip (Node verze)
  python scripts/build-plugin.py --release                                   obecné balíčky pro GitHub release

Konfigurace MO (config/organization.json) je jen lokální – není v repu. Výchozí build ji zabalí
(balíček pro vlastní MO); --example a --release použijí vzor config/organization.json.example
(obecný balíček pro libovolnou MO, údaje se doplní v portálu nebo v konfiguraci).

Výchozí plugin je `mistenka`. Do archivu se kromě PHP převezme:
  - frontend (src/frontend → mistenka/frontend), js/env.js s prefixem API WordPressu,
  - výchozí konfigurace MO (config → mistenka/config); ZIP je produkční balíček, proto má
    organization.json vždy payment.provider = "fio" (repo nechává "fake" pro lokální Node;
    falešnou banku, kde může platbu „zaplatit“ kdokoli, do ZIPu dá jen --fake-bank),
  - LICENSE.md a ochranné .htaccess (config a includes nejsou z webu dostupné).

Používá zipfile, takže výsledek nezávisí na tom, jaký `tar` je v systému,
a cesty v archivu mají vždy dopředná lomítka (nutné pro WordPress na Linuxu).
"""
import json
import os
import re
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}
unknown = flags - {"--fake-bank", "--node", "--release", "--example"}
if unknown:
    sys.exit(f"Neznámý přepínač: {', '.join(sorted(unknown))}")
name = args[0] if args else "mistenka"
out_dir = os.path.join(ROOT, "dist")
os.makedirs(out_dir, exist_ok=True)
# Node balíček: server, frontend, konfigurace a testy (bez WordPressu). Bere se z commitu HEAD (git archive),
# takže obsahuje přesně to, co je v repu – necommitnuté změny se do něj nedostanou.
NODE_PATHS = ["package.json", "README.md", "LICENSE.md", "config", "src/node", "src/frontend", "docs/API.md", "test"]

DENY = "Require all denied\nDeny from all\n"
# Statické soubory frontendu servíruje Apache přímo (pravidla .htaccess, která zapíše plugin).
FRONTEND_HTACCESS = """<IfModule mod_headers.c>
Header set Cache-Control "no-cache"
Header set Referrer-Policy "no-referrer"
Header set X-Content-Type-Options "nosniff"
</IfModule>
"""
ENV_JS = '// Prefix API ve WordPressu (plugin ho servíruje i dynamicky podle nastavení trvalých odkazů).\nwindow.MISTENKA_ENV = { apiBase: "/?rest_route=/mistenka/v1" };\n'


def walk(base):
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for f in sorted(files):
            if f.startswith(".") or f.endswith((".log", ".bak")):
                continue
            path = os.path.join(root, f)
            yield path, os.path.relpath(path, base).replace(os.sep, "/")


def version(plugin_file):
    with open(plugin_file, encoding="utf8") as fh:
        match = re.search(r"Version:\s*([\d.]+)", fh.read())
    return match.group(1) if match else "?"


ORG_LOCAL = os.path.join(ROOT, "config", "organization.json")
ORG_EXAMPLE = ORG_LOCAL + ".example"


def build_wp(fake_bank, listing=True, example=False):
    src = os.path.join(ROOT, "src", "wordpress-plugin", name)
    if not os.path.isdir(src):
        sys.exit(f"Plugin nenalezen: {src}")
    org_file = ORG_EXAMPLE if example else ORG_LOCAL
    if not os.path.exists(org_file):
        sys.exit("Chybí config/organization.json (konfigurace MO je jen lokální). Zkopírujte config/organization.json.example "
                 "a upravte, nebo sestavte obecný balíček se vzorem: --example")
    # Testovací balíček s falešnou bankou má jiný název souboru, aby se nezaměnil s produkčním.
    out = os.path.join(out_dir, f"{name}-fake-bank.zip" if fake_bank else f"{name}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        write_wp(z, src, fake_bank, org_file)
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"Poškozený soubor v archivu: {bad}")
        names = z.namelist()
        plugin_file = os.path.join(src, f"{name}.php")
        print(f"OK {out} · verze {version(plugin_file) if os.path.exists(plugin_file) else '?'} · {len(names)} souborů")
        if name == "mistenka":
            print(f"  platby: {'fake (POZOR: jen pro test, platby jde simulovat)' if fake_bank else 'fio (nutný MISTENKA_FIO_TOKEN ve wp-config.php)'}")
            print(f"  konfigurace: {'vzor organization.json.example (obecný balíček)' if example else 'lokální organization.json'}")
        if listing:
            for n in names:
                print("  " + n)


def build_node():
    out = os.path.join(out_dir, "mistenka-node.zip")
    dirty = subprocess.run(["git", "status", "--porcelain", "--", *NODE_PATHS], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    if dirty:
        print("  POZOR: necommitnuté změny se do Node balíčku nedostanou (bere se HEAD):\n    " + dirty.replace("\n", "\n    "))
    subprocess.run(["git", "archive", "--format=zip", "--prefix=mistenka-node/", "-o", out, "HEAD", *NODE_PATHS], cwd=ROOT, check=True)
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"Poškozený soubor v archivu: {bad}")
        print(f"OK {out} · commit {commit} · {len(z.namelist())} souborů")
        print("  spuštění: rozbalit, npm run seed && npm start (Node >= 22.13, bez závislostí)")


def write_wp(z, src, fake_bank, org_file):
    for path, rel in walk(src):
        z.write(path, f"{name}/{rel}")
    if name == "mistenka":
        for path, rel in walk(os.path.join(ROOT, "src", "frontend")):
            if rel == "js/env.js":
                z.writestr(f"{name}/frontend/js/env.js", ENV_JS)
            else:
                z.write(path, f"{name}/frontend/{rel}")
        z.writestr(f"{name}/frontend/.htaccess", FRONTEND_HTACCESS)
        for path, rel in walk(os.path.join(ROOT, "config")):
            if rel in ("organization.json", "organization.json.example"):
                continue  # konfigurace MO se zapíše zvlášť (lokální, nebo vzor)
            z.write(path, f"{name}/config/{rel}")
        with open(org_file, encoding="utf8") as fh:
            org = json.load(fh)
        org["payment"]["provider"] = "fake" if fake_bank else "fio"
        z.writestr(f"{name}/config/organization.json", json.dumps(org, ensure_ascii=False, indent=2) + chr(10))
        z.writestr(f"{name}/config/.htaccess", DENY)
        z.writestr(f"{name}/includes/.htaccess", DENY)
        z.write(os.path.join(ROOT, "LICENSE.md"), f"{name}/LICENSE.md")


if "--release" in flags:
    # Obecný release: konfigurace ze vzoru (žádné údaje konkrétní MO).
    build_wp(False, listing=False, example=True)
    build_wp(True, listing=False, example=True)
    build_node()
elif "--node" in flags:
    build_node()
else:
    build_wp("--fake-bank" in flags, example="--example" in flags)
