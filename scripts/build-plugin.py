"""Sestaví instalační ZIP WordPress pluginu: python scripts/build-plugin.py [nazev-pluginu]

Používá zipfile, takže výsledek nezávisí na tom, jaký `tar` je v systému,
a cesty v archivu mají vždy dopředná lomítka (nutné pro WordPress na Linuxu).
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
name = sys.argv[1] if len(sys.argv) > 1 else "mistenka-demo"
src_base = os.path.join(ROOT, "wordpress-plugin")
src = os.path.join(src_base, name)
out_dir = os.path.join(ROOT, "dist")
out = os.path.join(out_dir, f"{name}.zip")

if not os.path.isdir(src):
    sys.exit(f"Plugin nenalezen: {src}")
os.makedirs(out_dir, exist_ok=True)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            path = os.path.join(root, f)
            z.write(path, os.path.relpath(path, src_base).replace(os.sep, "/"))

with zipfile.ZipFile(out) as z:
    bad = z.testzip()
    if bad:
        sys.exit(f"Poškozený soubor v archivu: {bad}")
    print(f"OK {out}")
    for n in z.namelist():
        print("  " + n)
