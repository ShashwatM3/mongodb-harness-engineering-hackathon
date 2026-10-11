#!/usr/bin/env bash
# Copy the team repo's kg/ package into src/kg so the platform build can import it.
# Run after any change to kg/ and before `agentengine dev up` or `agentengine deploy`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../../kg"
rm -rf "$here/src/kg" && mkdir -p "$here/src/kg/tools"
cp "$src"/*.py "$here/src/kg/"
cp "$src"/tools/*.py "$here/src/kg/tools/"
echo "copied kg/ ($(git -C "$src" rev-parse --short HEAD)) into src/kg"
