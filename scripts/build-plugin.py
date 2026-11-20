"""Sestaví instalační ZIP WordPress pluginu: python scripts/build-plugin.py [nazev-pluginu]

Výchozí plugin je `mistenka`. Do archivu se kromě PHP převezme:
  - frontend (src/frontend → mistenka/frontend), js/env.js s prefixem API WordPressu,
  - výchozí konfigurace MO (config → mistenka/config),
  - LICENSE.md a ochranné .htaccess (config a includes nejsou z webu dostupné).

Používá zipfile, takže výsledek nezávisí na tom, jaký `tar` je v systému,
a cesty v archivu mají vždy dopředná lomítka (nutné pro WordPress na Linuxu).
"""
import os
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
name = sys.argv[1] if len(sys.argv) > 1 else "mistenka"
src = os.path.join(ROOT, "src", "wordpress-plugin", name)
out_dir = os.path.join(ROOT, "dist")
out = os.path.join(out_dir, f"{name}.zip")

if not os.path.isdir(src):
    sys.exit(f"Plugin nenalezen: {src}")
os.makedirs(out_dir, exist_ok=True)

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


with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
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
            z.write(path, f"{name}/config/{rel}")
        z.writestr(f"{name}/config/.htaccess", DENY)
        z.writestr(f"{name}/includes/.htaccess", DENY)
        z.write(os.path.join(ROOT, "LICENSE.md"), f"{name}/LICENSE.md")

with zipfile.ZipFile(out) as z:
    bad = z.testzip()
    if bad:
        sys.exit(f"Poškozený soubor v archivu: {bad}")
    names = z.namelist()
    plugin_file = os.path.join(src, f"{name}.php")
    print(f"OK {out} · verze {version(plugin_file) if os.path.exists(plugin_file) else '?'} · {len(names)} souborů")
    for n in names:
        print("  " + n)
