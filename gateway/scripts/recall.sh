#!/bin/bash
cd /Users/gobus/orca/mongodb-harness-engineering-hackathon && set -a; . ./.env; set +a; unset ANTHROPIC_API_KEY
harness/.venv/bin/python - <<'PY'
from harness.state import State
from harness import tools as T
import httpx, time
st = State()
gid = "gr-cd193e93f97d74d44ae96883"
sfx = str(int(time.time()))[-5:]
b = T.build_incident(st, gid, questions=["Is 1.35 m/s acceptable with people on the floor?"])
b["incident_id"] = f"inc-speed-{sfx}"; b["event_id"] = f"evt-speed-{sfx}"; b["proposal"]["proposal_id"] = f"prop-speed-{sfx}"
st.incidents[b["incident_id"]] = {"incident": b, "gate_run_id": gid, "revisions": [b["proposal"]], "decision": None}
r = httpx.post(f"{st.cfg.gateway_url}/v1/incidents", json=b, headers={"authorization": f"Bearer {st.cfg.harness_token}"}, timeout=20)
print(r.text, "http://localhost:5173/?incident=" + b["incident_id"])
PY
sleep 3; curl -s localhost:8787/api/calls/ringing | python3 -c "import json,sys; d=json.load(sys.stdin); print('ringing:', d and d.get('incident_id'))"
