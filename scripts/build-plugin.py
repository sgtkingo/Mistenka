"""Sestaví instalační ZIP WordPress pluginu, případně balíček Node verze.

  python scripts/build-plugin.py [nazev-pluginu] [--example]                 WP plugin (ostrý i testovací web)
  python scripts/build-plugin.py --node                                      dist/mistenka-node.zip (Node verze)
  python scripts/build-plugin.py --release                                   obecné balíčky pro GitHub release

Konfigurace MO (config/organization.json → revíry → mapy revírů) je jen lokální – není v repu. Výchozí build
ji zabalí (balíček pro vlastní MO); --example a --release použijí vzor config/example/organization.json
(obecný balíček pro libovolnou MO, údaje se doplní v portálu nebo v konfiguraci).

Výchozí plugin je `mistenka`. Do archivu se kromě PHP převezme:
  - frontend (src/frontend → mistenka/frontend), js/env.js s prefixem API WordPressu,
  - výchozí konfigurace MO v jednotném tvaru: config/organization.json, config/reviry/<id>.json,
    config/maps/<id>.json a config/species/<soubor> (odkazy se přepíšou na tyto cesty). ZIP je jeden pro ostrý
    i testovací web, proto má organization.json vždy payment.provider = "fio" (repo nechává "fake" pro lokální
    Node). Testovací web zapne testovací režim v portálu (Admin → Testování: oddělená databáze, simulované
    nebo ostré platby) – zvláštní balíček s falešnou bankou už není,
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
unknown = flags - {"--node", "--release", "--example"}
if "--fake-bank" in flags:
    sys.exit("--fake-bank už není: balíček je jeden, testovací web zapne testovací režim v portálu (Admin → Testování).")
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
ORG_EXAMPLE = os.path.join(ROOT, "config", "example", "organization.json")


def build_wp(listing=True, example=False):
    src = os.path.join(ROOT, "src", "wordpress-plugin", name)
    if not os.path.isdir(src):
        sys.exit(f"Plugin nenalezen: {src}")
    org_file = ORG_EXAMPLE if example else ORG_LOCAL
    if not os.path.exists(org_file):
        sys.exit("Chybí config/organization.json (konfigurace MO je jen lokální). Zkopírujte vzor z config/example "
                 "(organization.json, reviry/, maps/) a upravte, nebo sestavte obecný balíček se vzorem: --example")
    out = os.path.join(out_dir, f"{name}.zip")
    stale = os.path.join(out_dir, f"{name}-fake-bank.zip")
    if os.path.exists(stale):
        os.remove(stale)  # starý testovací balíček (do 1.6.x) – ať se omylem nenahraje
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        write_wp(z, src, org_file)
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"Poškozený soubor v archivu: {bad}")
        names = z.namelist()
        plugin_file = os.path.join(src, f"{name}.php")
        print(f"OK {out} · verze {version(plugin_file) if os.path.exists(plugin_file) else '?'} · {len(names)} souborů")
        if name == "mistenka":
            print("  platby: fio (nutný MISTENKA_FIO_TOKEN ve wp-config.php); testovací web: Admin → Testování v portálu")
            print(f"  konfigurace: {'vzor config/example (obecný balíček)' if example else 'lokální config/organization.json'}")
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


def bundle_config(z, org_file):
    """Konfigurace MO do ZIPu v jednotném tvaru (organizace → revíry → mapy, pravidla druhů ryb).
    Odkazy ve zdroji jsou relativní ke složce organization.json; revír může být i přímo objekt v seznamu
    a mapa bez odkazu se hledá v maps/<id>.json (stejně jako při načítání v Node/PHP)."""
    base = os.path.dirname(org_file)
    dump = lambda data: json.dumps(data, ensure_ascii=False, indent=2) + chr(10)

    def read(rel, what):
        path = os.path.normpath(os.path.join(base, rel))
        try:
            with open(path, encoding="utf8") as fh:
                return json.load(fh)
        except (OSError, ValueError) as error:
            sys.exit(f"Nelze načíst {what} ({path}): {error}")

    species_written = {}

    def species_ref(ref):
        target = "species/" + os.path.basename(ref)
        source = os.path.normpath(os.path.join(base, ref))
        if species_written.get(target, source) != source:
            sys.exit(f"Dvě různá pravidla druhů se stejným názvem souboru: {target}")
        if target not in species_written:
            if not os.path.exists(source):
                sys.exit(f"Chybí pravidla druhů ryb: {source}")
            z.write(source, f"{name}/config/{target}")
            species_written[target] = source
        return target

    with open(org_file, encoding="utf8") as fh:
        org = json.load(fh)
    if org.get("speciesRules"):
        org["speciesRules"] = species_ref(org["speciesRules"])
    entries = []
    for entry in org.get("reviry", []):
        revir = read(entry, f"revír {entry}") if isinstance(entry, str) else dict(entry)
        rid = revir.get("id")
        if not rid:
            sys.exit(f"Revír bez id v konfiguraci: {entry}")
        map_ref = revir.pop("map", None)
        if map_ref is None and os.path.exists(os.path.join(base, "maps", f"{rid}.json")):
            map_ref = f"maps/{rid}.json"
        if map_ref:
            map_doc = map_ref if isinstance(map_ref, dict) else read(map_ref, f"mapa revíru {rid}")
            z.writestr(f"{name}/config/maps/{rid}.json", dump(map_doc))
            revir["map"] = f"maps/{rid}.json"
        if revir.get("speciesRules"):
            revir["speciesRules"] = species_ref(revir["speciesRules"])
        z.writestr(f"{name}/config/reviry/{rid}.json", dump(revir))
        entries.append(f"reviry/{rid}.json")
    org["reviry"] = entries
    org["payment"]["provider"] = "fio"
    z.writestr(f"{name}/config/organization.json", dump(org))


def write_wp(z, src, org_file):
    for path, rel in walk(src):
        z.write(path, f"{name}/{rel}")
    if name == "mistenka":
        for path, rel in walk(os.path.join(ROOT, "src", "frontend")):
            if rel == "js/env.js":
                z.writestr(f"{name}/frontend/js/env.js", ENV_JS)
            else:
                z.write(path, f"{name}/frontend/{rel}")
        z.writestr(f"{name}/frontend/.htaccess", FRONTEND_HTACCESS)
        bundle_config(z, org_file)
        z.writestr(f"{name}/config/.htaccess", DENY)
        z.writestr(f"{name}/includes/.htaccess", DENY)
        z.write(os.path.join(ROOT, "LICENSE.md"), f"{name}/LICENSE.md")


if "--release" in flags:
    # Obecný release: konfigurace ze vzoru (žádné údaje konkrétní MO).
    build_wp(listing=False, example=True)
    build_node()
elif "--node" in flags:
    build_node()
else:
    build_wp(example="--example" in flags)
