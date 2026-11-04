#!/usr/bin/env bash
# Creates test fixtures in $1:
#   proj/   file tree: ignored files, node_modules, empty folder, symlink
#   grepo/  git repo with a remote, branches, tags, several authors, a merge, local changes
#   mrepo/  git repo in the middle of a merge with a conflict
#   icons/  one file per WebStorm file type icon
#   stree/  tree search: more matches than fit on screen, nested folders, ignored + excluded folders
#   sbig/   tree search: more results than snacks sorts, deep folders
# run.sh builds them once per run and gives each test file its own copy.
set -euo pipefail
D="$1"
mkdir -p "$D"
cd "$D"

# --- proj ---------------------------------------------------------------------
mkdir -p proj/src/components proj/src/services proj/test proj/node_modules/lib proj/emptydir
cd proj
git init -q -b main
printf 'node_modules\n*.log\n' > .gitignore
printf 'export const a = 1;\n\nexport function add(x: number, y: number) {\n  return x + y;\n}\n' > a.ts
echo 'export const b = 2;' > b.ts
echo 'export const c = 3;' > c.ts
echo '{ "name": "proj" }' > package.json
echo 'log' > ignored.log
echo 'module.exports = {}' > node_modules/lib/index.js
ln -s a.ts link.ts
printf 'alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\nzeta six\n' > multi.txt
cp multi.txt menu.txt
cd ..

# --- grepo --------------------------------------------------------------------
git init -q --bare gremote.git
git init -q -b master grepo
cd grepo
git config user.name "Ada Example"
git config user.email ada@x.se
commit() { # name email message date
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" \
    GIT_AUTHOR_DATE="$4" GIT_COMMITTER_DATE="$4" git commit -q -m "$3"
}
mkdir -p src/services backend/scripts
echo 'export const a = 1;' > src/a.ts
echo '{"x":1}' > backend/scripts/en.json
printf 'line one\nline two\nline three\n' > blame.ts
printf 'one\ntwo\nthree\nfour\nfive\nsix\n' > diff.ts
seq -f 'line %g' 1 200 > long.ts
git add -A; commit "Aaron Sample" a@x.se "AB#100 Initial setup" "2025-01-10T10:00:00"
echo 'export const b = 2;' > src/services/b.ts
git add -A; commit "Aaron Sample" a@x.se "AB#101 Added service b" "2025-06-01T10:00:00"
git remote add origin ../gremote.git
git push -q -u origin master
git checkout -q -b factory/1237
echo '{"x":2}' > backend/scripts/en.json
echo '{"y":1}' > backend/scripts/sv.json
git add -A; commit "Max" m@x.se "fixed label typo" "2026-03-10T10:00:00"
git push -q -u origin factory/1237
git checkout -q master
echo 'export const a = 3;' > src/a.ts
printf 'line one\nline TWO\nline three\nline four\n' > blame.ts
git add -A; commit "Ada Example" ada@x.se "AB#1234 Added checkout page texts" "2026-09-01T10:00:00"
git tag v1.0
git tag backup/old-1
GIT_COMMITTER_DATE="2026-09-02T10:00:00" git merge -q --no-edit factory/1237
printf 'line one\nline TWO\nline 3 recent\nline four\n' > blame.ts
git add -A; commit "Max" m@x.se "AB#1236 Recent blame line" "$(date -v-3d +%Y-%m-%dT%H:%M:%S)"
git mv src/services/b.ts src/services/bee.ts
commit "Ada Example" ada@x.se "AB#1235 Renamed b" "2026-10-01T10:00:00"
# local changes
echo 'local change' >> src/a.ts
echo 'new' > src/new.ts
printf 'one\nTWO\nthree\nfive\nsix\nseven\n' > diff.ts # changed 2, deleted 4, added 7
{ seq -f 'line %g' 1 49; seq -f 'new %g' 1 10; seq -f 'line %g' 50 200; } > long.ts # 10 lines inserted at 50
cd ..

# --- mrepo --------------------------------------------------------------------
git init -q -b main mrepo
cd mrepo
git config user.name "Ada Example"
git config user.email ada@x.se
printf 'a\nb\nc\nd\ne\nf\n' > conflict.ts
git add -A; git commit -q -m "base"
git checkout -q -b feature
printf 'a\nB feature\nc\nd\ne\nf\nfeature end\n' > conflict.ts
git commit -q -am "feature change"
git checkout -q main
printf 'a\nB main\nc\nd\nE main\nf\n' > conflict.ts
git commit -q -am "main change"
git merge -q feature >/dev/null 2>&1 || true

# --- icons: one file per WebStorm file type icon ------------------
cd "$D"
mkdir -p icons/src
cd icons
for f in App.tsx util.ts util.test.ts index.js Button.jsx package.json tsconfig.json README.md styles.scss \
  .gitignore .env Dockerfile ci.yml logo.svg img.png eslint.config.js notes.txt run.sh query.sql; do
  echo 'x' > "$f"
done
echo 'export {}' > src/index.ts
cd ..

# --- stree: many matching files, nested folders, ignored / excluded dirs ---
cd "$D"
mkdir -p stree
cd stree
git init -q -b main
printf 'dist\n*.log\n' > .gitignore
for d in alpha beta gamma delta epsilon zeta eta theta iota kappa; do
  mkdir -p "$d/sub"
  for i in 1 2 3; do echo "export const x$i = $i;" > "$d/item$i.ts"; echo 'x' > "$d/sub/item$i.ts"; done
  echo 'other' > "$d/other.ts"
done
mkdir -p dist node_modules/pkg
echo 'x' > dist/item_built.js
echo 'x' > node_modules/pkg/item_dep.js
echo 'x' > item_root.ts
cd ..

# --- sbig: more results than snacks sorts (1000), deep folders -----------
cd "$D"
mkdir -p sbig
cd sbig
git init -q -b main
for a in 01 02 03 04 05 06 07 08 09 10 11 12; do
  for b in 01 02 03 04 05 06 07 08 09 10 11 12; do
    mkdir -p "d$a/s$b/deep"
    touch "d$a/s$b"/item{1..9}.ts "d$a/s$b/deep/item10.ts"
  done
done
cd ..
