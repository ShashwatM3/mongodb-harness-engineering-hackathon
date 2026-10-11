#!/usr/bin/env bash
# Regenerates kg/tests/fixtures/ by running TwinForge's fakeRunShift (no HTTP runner needed).
# One file per stair threshold and split; the fake runner reads nothing else from the brain.
#
#   TWINFORGE_DIR=../physical-ai kg/tools/make_fixtures.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TWINFORGE_DIR="${TWINFORGE_DIR:-$(cd "$HERE/../../../physical-ai" && pwd)}"
TSX="$TWINFORGE_DIR/node_modules/.bin/tsx"
OUT="$HERE/../tests/fixtures"
mkdir -p "$OUT"
[ -x "$TSX" ] || { echo "tsx not found at $TSX (run npm ci in $TWINFORGE_DIR)" >&2; exit 1; }

TRAIN="101,102,103,104,105,106,107,108,109,110,111,112"
VAL="201,202,203,204,205,206"
SHA="$(git -C "$TWINFORGE_DIR" rev-parse --short HEAD)"
BRANCH="$(git -C "$TWINFORGE_DIR" rev-parse --abbrev-ref HEAD)"

for q in 0 1 2 3 4 5 10 99; do
  for split in train val; do
    seeds=$([ "$split" = train ] && echo "$TRAIN" || echo "$VAL")
    req=$(cat <<EOF
{"brain":{"version":1,"nodes":[{"node_id":"site:main","parent_id":null,"level":"site"},
 {"node_id":"fixture:q","parent_id":"site:main","level":"rule","body":{"op":"set","target":"sim.STAIR_MIN_LIFT_QUEUE","value":$q}}]},
 "seeds":[$seeds],"ticks":12000,"scenario_profile":"standard"}
EOF
)
    resp=$(printf '%s' "$req" | TWINFORGE_DIR="$TWINFORGE_DIR" "$TSX" "$HERE/fake_runner.mts" --stdin)
    printf '{"source":{"twinforge_commit":"%s","branch":"%s","generator":"kg/tools/make_fixtures.sh"},"request":%s,"response":%s}\n' \
      "$SHA" "$BRANCH" "$req" "$resp" > "$OUT/fake_q${q}_${split}.json"
    echo "wrote fake_q${q}_${split}.json"
  done
done
