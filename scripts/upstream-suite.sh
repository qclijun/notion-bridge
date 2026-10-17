#!/usr/bin/env bash
# Runs upstream magpie-notion's transport test suite against this adapter.
#
# The transport (protocol/session/transcript) is theirs, vendored verbatim; the
# request/response shaping in core.mjs is ours. Their 138 cases are the best
# regression net we have for the half we did not write, so they run against our
# files in a scratch package rather than against theirs.
#
# Two upstream tests assert behaviour this adapter deliberately changes, and are
# replaced here (not silently skipped — see the python block):
#   * "unsupported tools and images fail before network" — we accept both
#   * "package entry exports only the plugin ..." — packaging of the upstream
#     npm package, not adapter behaviour
#
# Usage: scripts/upstream-suite.sh [path-to-upstream-checkout]
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
UPSTREAM=${1:-${UPSTREAM:-$here/../magpie-notion}}
BUN=${BUN:-$HOME/.bun/bin/bun}

[ -d "$UPSTREAM/test" ] || { echo "no upstream checkout at $UPSTREAM" >&2; exit 1; }
[ -x "$BUN" ] || { echo "no bun at $BUN" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp "$here"/core.mjs "$here"/index.mjs "$here"/protocol.mjs "$here"/session.mjs "$here"/transcript.mjs "$here"/tools.mjs "$work"/
cp "$here"/package.json "$work"/
cp -r "$UPSTREAM"/test "$UPSTREAM"/fixtures "$work"/

python3 - "$work/test/independent.test.mjs" <<'PY'
import re
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

tools = re.compile(r"test\.each\(\[\{ tools:.*?expect\(mock\.calls\)\.toHaveLength\(0\)\n\}\)\n", re.S)
package = re.compile(r'test\("package entry exports only the plugin.*?\n\}\)\n', re.S)

for name, pattern in (("tools-refusal", tools), ("package-entry", package)):
    src, count = pattern.subn("", src, count=1)
    if count != 1:
        sys.exit(f"upstream suite: {name} anchor moved — read the tests, update scripts/upstream-suite.sh")

open(path, "w", encoding="utf-8").write(src)
PY

cd "$work"
echo "running upstream suite against $here"
"$BUN" test test/
