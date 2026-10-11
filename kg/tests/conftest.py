"""Test setup: a throwaway `kg_test` database, one client per database user.

Local (default): a self-managed MongoDB from kg/tools/test_mongo.sh; the role and users are
created here. Atlas sandbox: set KG_TEST_GATE_URI and KG_TEST_IMPROVER_URI to users created
with the Atlas CLI (see kg/README.md), and KG_TEST_ADMIN_URI is not needed.
mongomock can't run $graphLookup, so there is no in-memory fallback.
"""
from __future__ import annotations

import os

import pytest
from pymongo import MongoClient

from kg.core import KG
from kg.db import connect as db_connect
from kg.db import create_roles_and_users
from kg.raindrop_sink import RecordingSink
from kg.runner import FixtureRunner

ADMIN_URI = os.getenv("KG_TEST_ADMIN_URI", "mongodb://root:kgtestroot@127.0.0.1:27027/?authSource=admin")
HOST = os.getenv("KG_TEST_HOST", "127.0.0.1:27027")
DB = os.getenv("KG_TEST_DB", "kg_test")


@pytest.fixture(scope="session")
def user_uris():
    gate, imp = os.getenv("KG_TEST_GATE_URI"), os.getenv("KG_TEST_IMPROVER_URI")
    if gate and imp:
        return {"gate": gate, "improver": imp}
    admin = MongoClient(ADMIN_URI, serverSelectionTimeoutMS=3000)
    try:
        admin.admin.command("ping")
    except Exception as e:  # pragma: no cover - environment
        pytest.skip(f"no test MongoDB at {ADMIN_URI} ({e}); start one with kg/tools/test_mongo.sh")
    create_roles_and_users(admin, DB, "improver-test-pw", "gate-test-pw", prefix="kgtest_")
    return {"gate": f"mongodb://kgtest_gate:gate-test-pw@{HOST}/?authSource=admin",
            "improver": f"mongodb://kgtest_improver:improver-test-pw@{HOST}/?authSource=admin"}


def reset(db):
    """Empty every collection but keep it and its indexes: far fewer storage files than drop and recreate."""
    for name in db.list_collection_names():
        db[name].delete_many({})


@pytest.fixture
def sink():
    return RecordingSink()


@pytest.fixture
def runner():
    return FixtureRunner()


@pytest.fixture
def gate(user_uris, sink, runner):
    db = db_connect(user_uris["gate"], DB, app="kg-test-gate")
    reset(db)
    g = KG(db, "gate", sink=sink)
    g.use_runner(runner)
    g.seed()
    return g


@pytest.fixture
def improver(user_uris, gate, sink, runner):
    db = db_connect(user_uris["improver"], DB, app="kg-test-improver")
    k = KG(db, "improver", sink=sink)
    k.use_runner(runner)
    return k


def run_round(improver, gate, base_V, edits, *, origin="gepa", round_=1, policy="p1", promote=True, verdict="passed"):
    """Evaluator side on the improver client, decisions on the gate client."""
    p = improver.record_proposal(base_V, edits, origin=origin, round=round_, policy=policy)
    res = improver.evaluate(p)
    out = {"proposal": p, "result": res}
    if p.status != "invalid" and verdict:
        gate.record_verdict(p.gate_run_id, verdict)
        if promote and verdict == "passed":
            out["promoted"] = gate.promote(p.gate_run_id, f"try {edits}")
    return out


@pytest.fixture
def play():
    return run_round
