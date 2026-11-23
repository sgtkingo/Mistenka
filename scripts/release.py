"""Vydání nové verze jedním příkazem: testy → bump verze → commit → push → GitHub release → lokální build.

  python scripts/release.py patch -m "Zpráva commitu" -c "Změna 1" -c "Změna 2"
  python scripts/release.py minor -m "…" --notes-file zmeny.md
  python scripts/release.py 2.0.0 -m "…" -c "…" --skip-tests --dry-run

Verze: patch | minor | major (od verze v mistenka.php), nebo přesná verze X.Y.Z.
Změny do poznámek release: opakované -c/--change (každá = jedna odrážka, Markdown), nebo --notes-file
(obsah sekce „Změny“). Tabulku „Ke stažení“ a řádek o aktualizaci databáze skript doplní sám – podle toho,
jestli se od předchozího tagu změnilo Db::SCHEMA_VERSION.

Postup:
  1. npm test (přeskočí --skip-tests)
  2. verze v src/wordpress-plugin/mistenka/mistenka.php (hlavička i MISTENKA_VERSION)
  3. git add (sledované změny + nové soubory v src, docs, test, config, scripts) a commit; --co-author přidá
     řádek „Co-Authored-By: …“
  4. git push
  5. python scripts/build-plugin.py --release → gh release create vX.Y.Z se 3 balíčky
  6. python scripts/build-plugin.py → dist/mistenka.zip s lokální konfigurací MO

--dry-run jen vypíše, co by se stalo (nic nemění).
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, "src", "wordpress-plugin", "mistenka", "mistenka.php")
DB_PHP = "src/wordpress-plugin/mistenka/includes/Db.php"
STAGE_DIRS = ["src", "docs", "test", "config", "scripts"]
ASSETS = ["dist/mistenka.zip", "dist/mistenka-fake-bank.zip", "dist/mistenka-node.zip"]


def run(cmd, *, capture=False, check=True, dry=False):
    shown = " ".join(cmd) if isinstance(cmd, list) else cmd
    print(f"$ {shown}")
    if dry:
        return ""
    result = subprocess.run(cmd, cwd=ROOT, text=True, encoding="utf-8", capture_output=capture, shell=isinstance(cmd, str))
    if check and result.returncode != 0:
        if capture:
            sys.stderr.write((result.stdout or "") + (result.stderr or ""))
        sys.exit(f"Selhalo: {shown}")
    return (result.stdout or "").strip() if capture else ""


def current_version():
    m = re.search(r"define\('MISTENKA_VERSION', '(\d+)\.(\d+)\.(\d+)'\)", open(PLUGIN, encoding="utf-8").read())
    if not m:
        sys.exit("Ve mistenka.php chybí MISTENKA_VERSION.")
    return tuple(int(x) for x in m.groups())


def next_version(cur, spec):
    major, minor, patch = cur
    if spec == "patch":
        return f"{major}.{minor}.{patch + 1}"
    if spec == "minor":
        return f"{major}.{minor + 1}.0"
    if spec == "major":
        return f"{major + 1}.0.0"
    if re.fullmatch(r"\d+\.\d+\.\d+", spec):
        return spec
    sys.exit("Verze: patch | minor | major | X.Y.Z")


def schema_at(ref):
    try:
        text = subprocess.run(["git", "show", f"{ref}:{DB_PHP}"], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, check=True).stdout
    except subprocess.CalledProcessError:
        return None
    m = re.search(r"SCHEMA_VERSION = (\d+);", text)
    return int(m.group(1)) if m else None


def release_notes(changes_md, prev_tag):
    now_schema = schema_at("HEAD")
    prev_schema = schema_at(prev_tag) if prev_tag else None
    prev_label = prev_tag.lstrip("v") if prev_tag else "předchozí verze"
    if prev_schema is not None and now_schema is not None and now_schema != prev_schema:
        update = f"Aktualizace z {prev_label}: nahrajte nový ZIP – databáze se sama rozšíří (schéma {now_schema})."
    else:
        update = f"Aktualizace z {prev_label}: nahrajte nový ZIP, databáze se nemění."
    return f"""## Ke stažení

| Soubor | K čemu |
| --- | --- |
| `mistenka.zip` | WordPress plugin pro ostrý provoz – platby přes Fio API. |
| `mistenka-fake-bank.zip` | WordPress plugin jen pro testovací web – platby se simulují. |
| `mistenka-node.zip` | Node.js verze (Node ≥ 22.13, bez závislostí). |

Balíčky jsou obecné se vzorovou konfigurací (`config/example`); údaje své MO upravte v portálu, nebo plugin sestavte s vlastní konfigurací. {update}

## Změny
{changes_md.strip()}
"""


def main():
    parser = argparse.ArgumentParser(description="Commit + bump verze, push, GitHub release, lokální build.")
    parser.add_argument("version", help="patch | minor | major | X.Y.Z")
    parser.add_argument("-m", "--message", required=True, help="zpráva commitu (verze se připojí: '; version X.Y.Z')")
    parser.add_argument("-c", "--change", action="append", default=[], help="odrážka do poznámek release (opakovat)")
    parser.add_argument("--notes-file", help="soubor s obsahem sekce „Změny“ (Markdown)")
    parser.add_argument("--co-author", help='např. "Claude Opus 5.5 <noreply@anthropic.com>"')
    parser.add_argument("--skip-tests", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    a = parser.parse_args()
    if not a.change and not a.notes_file:
        sys.exit("Zadejte změny: -c \"…\" (i víckrát), nebo --notes-file.")
    changes_md = open(a.notes_file, encoding="utf-8").read() if a.notes_file else "\n".join(f"- {c}" for c in a.change)
    dry = a.dry_run

    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture=True)
    if branch != "main":
        sys.exit(f"Vydává se z větve main (teď {branch}).")
    run(["git", "fetch", "-q", "--tags", "origin"])
    prev_tag = run(["git", "describe", "--tags", "--abbrev=0"], capture=True, check=False) or None
    version = next_version(current_version(), a.version)
    tag = f"v{version}"
    if run(["git", "tag", "-l", tag], capture=True):
        sys.exit(f"Tag {tag} už existuje.")
    print(f"Verze {'.'.join(map(str, current_version()))} → {version} (předchozí tag {prev_tag or '–'})")

    if not a.skip_tests:
        run("npm test", dry=dry)

    # Bump verze (hlavička pluginu i konstanta).
    text = open(PLUGIN, encoding="utf-8").read()
    bumped = re.sub(r"(\* Version: )\d+\.\d+\.\d+", rf"\g<1>{version}", text)
    bumped = re.sub(r"(define\('MISTENKA_VERSION', ')\d+\.\d+\.\d+('\))", rf"\g<1>{version}\g<2>", bumped)
    print(f"bump {os.path.relpath(PLUGIN, ROOT)} → {version}")
    if not dry:
        open(PLUGIN, "w", encoding="utf-8", newline="").write(bumped)

    # Commit a push.
    run(["git", "add", "-u"], dry=dry)
    run(["git", "add", "--", *STAGE_DIRS], dry=dry)
    message = f"{a.message}; version {version}"
    if a.co_author:
        message += f"\n\nCo-Authored-By: {a.co_author}"
    run(["git", "commit", "-q", "-m", message], dry=dry)
    run(["git", "push", "-q", "origin", "main"], dry=dry)

    # Obecné balíčky → GitHub release.
    run([sys.executable, "scripts/build-plugin.py", "--release"], dry=dry)
    notes = release_notes(changes_md, prev_tag)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(notes)
        notes_path = f.name
    try:
        if dry:
            print("--- poznámky release ---\n" + notes + "------------------------")
        run(["gh", "release", "create", tag, *ASSETS, "--target", "main", "--title", f"Místenka {version}", "--notes-file", notes_path], dry=dry)
    finally:
        os.unlink(notes_path)
    if not dry:
        run(["git", "fetch", "-q", "--tags", "origin"])

    # Lokální build s konfigurací MO (přepíše dist/mistenka.zip).
    run([sys.executable, "scripts/build-plugin.py"], dry=dry)
    print(f"\nHotovo: {tag} · https://github.com/sgtkingo/Mistenka/releases/tag/{tag}")


if __name__ == "__main__":
    main()
