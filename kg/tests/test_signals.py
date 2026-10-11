"""get_signals(shift_id): a shift maps to its gate runs, their Raindrop events, and the signals on them,
grouped by category. The Query API is faked from what the RecordingSink saw, so the rows are exactly
what the KG would have sent."""
from __future__ import annotations

from collections import defaultdict

import httpx
import pytest

from kg.config import Config
from kg.raindrop_query import QueryClient, query_client_from_config

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"


class FakeRaindrop:
    """GET /v1/events over the sink's events and signals, plus extra rows; `page` rows per page."""

    def __init__(self, sink, extra=(), page=50, status=200):
        sigs = defaultdict(list)
        for eid, name in sink.signals:
            sigs[eid].append({"id": f"uuid-{name}", "name": name, "score": 1})
        self.rows = [{"id": eid, "event_name": "candidate_brain", "timestamp": f"2026-10-11T12:00:{i:02d}Z",
                      "properties": {k: str(v) for k, v in props.items()}, "signals": sigs[eid]}
                     for i, (eid, props) in enumerate(sink.events)]
        self.rows += list(extra)
        self.page, self.status, self.requests = page, status, []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "unavailable"})
        q = request.url.params
        rows = [r for r in self.rows if "event_name" not in q or r["event_name"] == q["event_name"]]
        for k, v in q.items():
            if k.startswith("properties["):
                rows = [r for r in rows if str(r["properties"].get(k[11:-1])) == v]
        start = int(q.get("cursor", 0))
        more = start + self.page < len(rows)
        return httpx.Response(200, json={"data": rows[start:start + self.page],
                                         "meta": {"cursor": str(start + self.page) if more else None, "has_more": more}})

    def client(self, project="kg-dev") -> QueryClient:
        return QueryClient("query-key", project_id=project, transport=httpx.MockTransport(self.handler))


def shifts_of(kg, gate_run_id):
    return kg.db.gate_runs.find_one({"_id": gate_run_id})["shift_ids"]


def test_candidate_shift_gets_its_gate_signal(gate, improver, play, sink):
    r = play(improver, gate, 1, {STAIR: 5})
    p = r["proposal"]
    fake = FakeRaindrop(sink)
    res = improver.get_signals(shifts_of(gate, p.gate_run_id)["cand"][0], client=fake.client())
    assert res["categories"]["gate"] == {"gate_passed": {"count": 1, "event_ids": [p.event_id]}}
    assert res["categories"]["hard_metrics"] == res["categories"]["self_diagnostics"] == {}
    assert [(e["id"], e["side"], e["gate_run_id"]) for e in res["events"]] == [(p.event_id, "cand", p.gate_run_id)]
    assert res["shift"]["split"] == "train" and res["error"] is None
    assert "gate: gate_passed ×1" in res["markdown"] and "hard metrics: none" in res["markdown"]
    sent = fake.requests[0]
    assert sent.headers["Authorization"] == "Bearer query-key" and sent.headers["X-Raindrop-Project-Id"] == "kg-dev"


def test_base_shift_collects_every_run_that_used_it_across_pages(gate, improver, play, sink):
    a = play(improver, gate, 1, {STAIR: 5}, promote=False)["proposal"]
    b = play(improver, gate, 1, {STAIR: 3}, promote=False, verdict="rejected")["proposal"]
    base = shifts_of(gate, a.gate_run_id)["base"][0]
    assert base in shifts_of(gate, b.gate_run_id)["base"]
    fake = FakeRaindrop(sink, page=1)
    res = improver.get_signals(base, client=fake.client())
    assert {e["id"] for e in res["events"]} == {a.event_id, b.event_id}
    assert {e["side"] for e in res["events"]} == {"base"}
    assert res["categories"]["gate"] == {"gate_passed": {"count": 1, "event_ids": [a.event_id]},
                                         "gate_failed": {"count": 1, "event_ids": [b.event_id]}}
    assert len(fake.requests) > 2  # followed the cursor


def test_hard_metrics_self_diagnostics_and_the_heldout_firewall(gate, improver, play, sink):
    p = play(improver, gate, 1, {STAIR: 5})["proposal"]
    sid = shifts_of(gate, p.gate_run_id)["cand"][0]
    sink.signal(p.event_id, "LIFT_QUEUE_JAM")  # Person C's failure-type signal, on the KG's event id
    env_key = sink.events[0][1]["env_key"]
    extra = [
        {"id": "worker-1", "event_name": "worker_step", "timestamp": "2026-10-11T12:01:00Z",
         "properties": {"shift_id": sid}, "signals": [{"id": "u1", "name": "capability_gap"},
                                                       {"id": "u2", "name": "tool_error"}]},
        {"id": "heldout-1", "event_name": "candidate_brain", "timestamp": "2026-10-11T12:02:00Z",
         "properties": {"gate_run_id": p.gate_run_id, "env_key": env_key, "split": "heldout"},
         "signals": [{"id": "u3", "name": "gate_failed"}]},
        {"id": "heldout-2", "event_name": "gate_heldout", "timestamp": "2026-10-11T12:02:30Z",  # iteration 03's tags
         "properties": {"shift_id": sid, "brain_version": "2", "seed_set": "heldout"},
         "signals": [{"id": "u5", "name": "LATE_TASK"}]},
        {"id": "other-run", "event_name": "candidate_brain", "timestamp": "2026-10-11T12:03:00Z",
         "properties": {"gate_run_id": "gr-unrelated", "env_key": env_key, "split": "train"},
         "signals": [{"id": "u4", "name": "gate_failed"}]},
    ]
    res = improver.get_signals(sid, client=FakeRaindrop(sink, extra).client())
    cats = res["categories"]
    assert cats["hard_metrics"] == {"LIFT_QUEUE_JAM": {"count": 1, "event_ids": [p.event_id]}}
    assert cats["self_diagnostics"] == {"capability_gap": {"count": 1, "event_ids": ["worker-1"]}}
    assert cats["other"] == {"tool_error": {"count": 1, "event_ids": ["worker-1"]}}
    assert cats["gate"] == {"gate_passed": {"count": 1, "event_ids": [p.event_id]}}
    assert res["dropped_other_splits"] == 2
    assert {e["id"] for e in res["events"]} == {p.event_id, "worker-1"}


def test_raindrop_down_is_reported_not_raised(gate, improver, play, sink):
    p = play(improver, gate, 1, {STAIR: 5})["proposal"]
    res = improver.get_signals(shifts_of(gate, p.gate_run_id)["cand"][0],
                               client=FakeRaindrop(sink, status=503).client())
    assert res["error"].startswith("Raindrop query failed") and res["events"] == []
    assert [r["gate_run_id"] for r in res["gate_runs"]] == [p.gate_run_id]


def test_unknown_shift(improver, sink):
    with pytest.raises(KeyError):
        improver.get_signals("sh-nope", client=FakeRaindrop(sink).client())


def cfg(**kw):
    base = dict(raindrop_query_key="q", raindrop_project_id="kg-real", raindrop_dev_project_id="kg-dev",
                raindrop_dev=None, runner_url=None)
    return Config(**{**base, **kw})


def test_query_client_reads_the_project_the_sink_writes():
    assert query_client_from_config(cfg()).project_id == "kg-dev"
    assert query_client_from_config(cfg(runner_url="http://localhost:8787")).project_id == "kg-real"
    assert query_client_from_config(cfg(), dev=False).project_id == "kg-real"


def test_query_client_needs_its_own_key_and_a_dev_project():
    with pytest.raises(RuntimeError, match="RAINDROP_QUERY_API_KEY"):
        query_client_from_config(cfg(raindrop_query_key=None))
    with pytest.raises(RuntimeError, match="RAINDROP_DEV_PROJECT_ID"):
        query_client_from_config(cfg(raindrop_dev_project_id=None))
