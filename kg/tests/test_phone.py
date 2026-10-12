"""The phone bridge (kg/phone.py): which gate decisions ring the Robotics Lead, what the gateway receives, and what
the Lead's feedback does to the brain. The gateway is a fake that records POST /v1/incidents."""
from __future__ import annotations

import threading

import httpx
import pytest

from kg.phone import COLLECTION, GatewayPhone, NullPhone, PhoneHarness, build_incident, make_server

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"
SPEED = "class.HUM-1.max_speed"

INCIDENT_KEYS = {"schema_version", "event_id", "incident_id", "task_id", "robot_id", "timestamp", "severity",
                 "category", "observed_behavior", "expected_behavior", "failure_summary", "root_cause_hypothesis",
                 "proposal", "responsible_supervisor", "escalation"}
PROPOSAL_KEYS = {"proposal_id", "revision", "source_agent", "summary", "changes", "editable_parameters",
                 "justification", "risk", "created_at"}


class Resp:
    def __init__(self, code=201, body=None):
        self.status_code, self._body = code, body or {"duplicate": False}
        self.text = str(self._body)

    def json(self):
        return self._body


class FakeGateway:
    def __init__(self, fail: Exception | None = None):
        self.posts, self.fail, self.seen = [], fail, set()

    def post(self, url, json=None, headers=None):
        if self.fail:
            raise self.fail
        self.posts.append({"url": url, "json": json, "headers": headers})
        dup = json["event_id"] in self.seen
        self.seen.add(json["event_id"])
        return Resp(200 if dup else 201, {"incident_id": json["incident_id"], "duplicate": dup})


@pytest.fixture
def gw(gate):
    fake = FakeGateway()
    gate.phone = GatewayPhone("http://gateway.test", "harness-token", lead="Sam", client=fake)
    return fake


def feedback(inc: dict, decision: str, words: str | None = None, key: str = "idem-0001") -> dict:
    return {"feedback_id": f"fb-{key}", "idempotency_key": key, "incident_id": inc["incident_id"],
            "proposal_id": inc["proposal"]["proposal_id"], "revision": 1, "decision": decision, "feedback": words,
            "proposal": inc["proposal"], "supervisor_id": "robotics-lead", "channel": "VOICE",
            "decided_at": "2026-10-11T17:50:00-07:00"}


def locked_run(improver, gate, value=1.35):
    p = improver.record_proposal(1, {SPEED: value}, origin="gepa", round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "needs_approval", reason=f"locked: max_speed {value}")
    return p


def test_without_a_gateway_nothing_rings(gate, improver, play):
    assert isinstance(gate.phone, NullPhone)
    play(improver, gate, 1, {STAIR: 3})
    assert gate.db[COLLECTION].count_documents({}) == 0


def test_a_promotion_calls_with_the_update(gate, improver, play, gw):
    out = play(improver, gate, 1, {STAIR: 3})
    assert out["promoted"]["version"] == 2
    assert len(gw.posts) == 1
    post = gw.posts[0]
    inc = post["json"]
    assert post["url"] == "http://gateway.test/v1/incidents"
    assert post["headers"]["authorization"] == "Bearer harness-token"
    assert INCIDENT_KEYS <= set(inc) and PROPOSAL_KEYS <= set(inc["proposal"])
    gid = out["proposal"].gate_run_id
    assert inc["event_id"] == f"kg:update:{gid}" and inc["incident_id"] == f"kg-update-{gid}"
    assert inc["category"] == "harness.brain_updated" and inc["proposal"]["revision"] == 1
    assert inc["responsible_supervisor"]["name"] == "Sam" and inc["synthetic"] is True
    assert len(inc["plain_summary"]) <= 400 and len(inc["proposal"]["plain_summary"]) <= 400
    assert "version 2" in inc["plain_summary"]
    assert inc["proposal"]["changes"] == [{"op": "set_param", "key": STAIR, "value": 3}]
    (param,) = inc["proposal"]["editable_parameters"]
    assert param["key"] == STAIR and param["current_value"] == 99 and param["proposed_value"] == 3
    assert param["min"] <= 3 <= param["max"] and param["type"] == "integer"
    assert inc["metadata"]["kg_gate_run_id"] == gid and inc["metadata"]["kg_version"] == 2
    call = gate.db[COLLECTION].find_one({"_id": inc["incident_id"]})
    assert call["status"] == "posted" and call["kind"] == "update" and call["version"] == 2


def test_rejected_and_unpromoted_runs_stay_quiet(gate, improver, play, gw):
    play(improver, gate, 1, {STAIR: 3}, verdict="rejected")
    play(improver, gate, 1, {STAIR: 2}, policy="p2", promote=False)
    assert gw.posts == []


def test_a_retried_verdict_calls_once(gate, improver, gw):
    p = locked_run(improver, gate)
    gate.record_verdict(p.gate_run_id, "needs_approval", reason="again")
    assert len(gw.posts) == 1


def test_a_locked_fix_calls_for_approval_and_the_approval_promotes(gate, improver, gw):
    p = locked_run(improver, gate)
    (post,) = gw.posts
    inc = post["json"]
    assert inc["category"] == "harness.locked_change_needs_approval" and inc["severity"] == "HIGH"
    assert inc["escalation"]["requires_authority"] is True and inc["proposal"]["risk"] == "HIGH"
    assert inc["proposal"]["changes"][0]["unit"] == "m/s"

    h = PhoneHarness(gate, lead="Sam")
    ack = h.feedback(feedback(inc, "APPROVE", "Approved, watch the trip times"), "idem-0001")
    assert ack["accepted"] and "version 2" in ack["reason"]
    run = gate.db.gate_runs.find_one({"_id": p.gate_run_id})
    assert run["verdict"] == "promoted" and run["promoted_to"] == 2
    env = gate.db.envelope.find_one({"_id": SPEED})
    assert env["approvals"][-1]["ref"] == f"call:{inc['incident_id']}" and env["approvals"][-1]["approved_by"] == "Sam"
    assert len(gw.posts) == 1  # the promotion the Lead just approved doesn't ring again

    again = h.feedback(feedback(inc, "APPROVE", "Approved, watch the trip times"), "idem-0001")
    assert again == ack and gate.latest_version() == 2
    call = gate.db[COLLECTION].find_one({"_id": inc["incident_id"]})
    assert call["status"] == "approve" and len(call["decisions"]) == 1 and call["decisions"][0]["promoted_to"] == 2


def test_a_rejection_blocks_the_value_and_keeps_the_leads_words(gate, improver, gw):
    p = locked_run(improver, gate, value=1.5)
    inc = gw.posts[0]["json"]
    ack = PhoneHarness(gate).feedback(feedback(inc, "REJECT", "Not faster than 1.3 near people"), "idem-0002")
    assert ack["accepted"] and "instruction" in ack["reason"]
    run = gate.db.gate_runs.find_one({"_id": p.gate_run_id})
    assert run["verdict"] == "rejected"
    assert gate.db.envelope.find_one({"_id": SPEED})["approvals"][-1]["decision"] == "reject"
    pref = gate.db.brain_nodes.find_one({"key": {"$regex": "^preference:"}})
    assert pref["then"] == "Not faster than 1.3 near people" and pref["origin"]["ref"] == f"call:{inc['incident_id']}"


def test_a_deferral_leaves_the_fix_pending(gate, improver, gw):
    p = locked_run(improver, gate)
    ack = PhoneHarness(gate).feedback(feedback(gw.posts[0]["json"], "DEFER"), "idem-0003")
    assert ack["accepted"] and "pending" in ack["reason"]
    assert gate.db.gate_runs.find_one({"_id": p.gate_run_id})["verdict"] == "needs_approval"


def test_a_gateway_that_is_down_never_blocks_the_gate(gate, improver, play):
    gate.phone = GatewayPhone("http://gateway.test", "t", client=FakeGateway(fail=httpx.ConnectError("refused")))
    out = play(improver, gate, 1, {STAIR: 3})
    assert out["promoted"]["version"] == 2
    call = gate.db[COLLECTION].find_one({})
    assert call["status"] == "unreachable" and "refused" in call["error"]


def test_the_incident_names_the_failure_the_twin_flagged(gate, improver, play):
    out = play(improver, gate, 1, {STAIR: 3})
    run = gate.db.gate_runs.find_one({"_id": out["proposal"].gate_run_id})
    inc = build_incident(gate, run, "update", version=2)
    ftype = inc["metadata"]["kg_failure_type"]
    assert ftype in run["failures"]
    assert any(e["id"].startswith("ep:") and ftype in e["summary"] for e in inc["evidence_refs"]) or \
        run["failures"][ftype]["base"] == 0


def test_the_http_side_answers_the_gateway(gate, improver, gw):
    locked_run(improver, gate)
    inc = gw.posts[0]["json"]
    srv = make_server(PhoneHarness(gate), "127.0.0.1", 0, token="out-token")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    auth = {"authorization": "Bearer out-token"}
    try:
        assert httpx.post(f"{base}/feedback", json={}).status_code == 401
        m = httpx.get(f"{base}/incidents/{inc['incident_id']}/metrics", headers=auth).json()["metrics"]
        assert m and all(x["kind"] == "MEASURED" for x in m)
        assert httpx.get(f"{base}/incidents/{inc['incident_id']}/trajectory", headers=auth).status_code == 404
        q = httpx.post(f"{base}/supervisor/questions", headers=auth,
                       json={"incident_id": inc["incident_id"], "task_id": inc["task_id"], "query_id": "q1",
                             "question": "how many seeds got better?"}).json()
        assert q["status"] == "ANSWERED" and "no change on any seed" in q["answer"] and "gate run" in q["answer"]
        r = httpx.post(f"{base}/proposals/{inc['proposal']['proposal_id']}/revisions", headers=auth,
                       json={"incident_id": inc["incident_id"], "base_revision": 1, "changes": [], "rationale": "x",
                             "requested_by": "Sam"}).json()
        assert r["accepted"] is False and r["reason"]
        ack = httpx.post(f"{base}/feedback", headers={**auth, "idempotency-key": "idem-http"},
                         json=feedback(inc, "APPROVE", key="idem-http")).json()
        assert ack["accepted"] and gate.latest_version() == 2
    finally:
        srv.shutdown()
