#!/usr/bin/env bash
# Copy the team repo's kg/ package into src/kg so the platform build can import it.
# Run after any change to kg/ and before `agentengine dev up` or `agentengine deploy`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../../kg"
# Refresh only the .py files: the dev container writes root-owned __pycache__ here.
mkdir -p "$here/src/kg/tools"
find "$here/src/kg" -name "*.py" -user "$(id -u)" -delete
cp "$src"/*.py "$here/src/kg/"
cp "$src"/tools/*.py "$here/src/kg/tools/"
echo "copied kg/ ($(git -C "$src" rev-parse --short HEAD)) into src/kg"
