#!/usr/bin/env bash
# A throwaway MongoDB with auth for the KG tests (mongomock can't run $graphLookup).
#
#   kg/tools/test_mongo.sh          start (or reuse) the container on 127.0.0.1:27027
#   kg/tools/test_mongo.sh stop     remove it
#
# Why mongo:7.0 and a raised file limit:
#  - MongoDB 8.x refuses to start (8.0) or segfaults (8.2) on Linux kernels 6.19 and newer
#    (SERVER-121912). 7.0 runs everything the KG uses: $graphLookup, $lookup with let/pipeline,
#    positional updates. Atlas runs 8.0, which behaves the same for these.
#  - Docker's default open-file limit makes WiredTiger abort with EMFILE once tests have created
#    enough collections and indexes.
# Override with KG_TEST_MONGO_IMAGE=mongo:8.0 on an older kernel.
set -euo pipefail
NAME="${KG_TEST_MONGO_NAME:-kg-test-mongo}"
IMAGE="${KG_TEST_MONGO_IMAGE:-mongo:7.0}"
PORT="${KG_TEST_MONGO_PORT:-27027}"

if [ "${1:-start}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null && echo "removed $NAME"
  exit 0
fi

if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; then
  echo "$NAME already running on 127.0.0.1:$PORT"
else
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --ulimit nofile=64000:64000 -p "127.0.0.1:$PORT:27017" \
    -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=kgtestroot "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$NAME" mongosh --quiet -u root -p kgtestroot --eval 'db.runCommand({ping: 1}).ok' >/dev/null 2>&1 && break
    sleep 1
  done
  echo "started $NAME ($IMAGE) on 127.0.0.1:$PORT"
fi
echo "admin URI: mongodb://root:kgtestroot@127.0.0.1:$PORT/?authSource=admin (the conftest default)"
