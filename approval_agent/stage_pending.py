"""Stage a locked edit waiting for approval, for testing the approval agent without the real loop.

    kg/.venv/bin/python approval_agent/stage_pending.py         # from the team repo root

Uses KG_DEMO_GATE_URI and database kg_demo (emptied first, never the real `kg`), the fake runner, and the
demo's stand-in gate. Prints the gate_run_id to pass to the agent.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("KG_RAINDROP", "0")

from kg import KG, load_dotenv  # noqa: E402
from kg.config import Config  # noqa: E402
from kg.db import connect as db_connect  # noqa: E402
from kg.runner import runner_from_config  # noqa: E402
from kg.tools.demo import toy_gate  # noqa: E402

load_dotenv()
uri = os.environ["KG_DEMO_GATE_URI"]
cfg = Config(db_name="kg_demo", gate_uri=uri, improver_uri=uri)
db = db_connect(uri, "kg_demo", app="kg-stage")
for name in db.list_collection_names():
    db[name].delete_many({})
gate = KG(db, "gate", config=cfg)
gate.use_runner(runner_from_config(cfg))
imp = KG(db, "improver", config=cfg)
imp.use_runner(runner_from_config(cfg))
gate.seed()
p = imp.record_proposal(1, {"class.HUM-1.max_speed": 1.35}, origin={"source": "gepa"}, round=1, policy="stage")
imp.evaluate(p)
print("verdict:", toy_gate(gate, p.gate_run_id))
print("gate_run_id:", p.gate_run_id)
