"""Phase 3 (stretch): learned lever-group order and its prequential check."""
from __future__ import annotations

from kg import learn
from kg.raindrop_sink import RecordingSink
from kg.tools.demo import run_demo


def test_learned_order_and_prequential_check(gate, improver):
    run_demo(gate, improver, say=lambda *_: None, sink=RecordingSink())
    wins = learn.winners(gate)
    assert [w["version"] for w in wins] == [2, 3, 4]
    assert wins[0]["groups"] == ["floor_change"] and wins[2]["groups"] == ["motion"]
    pq = learn.prequential(gate)
    assert pq["summary"]["promotions"] == 3 and "proxy" in pq["note"]
    assert all(r["hand_rank"] >= 1 and r["learned_rank"] >= 1 for r in pq["rows"])
    stored = learn.store(gate)
    assert stored["c:time/non_productive/lift_wait"][0] == "c:lever/floor_change"
    ctx = improver.get_context(4, use_learned=True)
    assert ctx["data"]["C"]["lever_group_order"][0]["group"] in ("floor_change", "motion")


def test_demo_tells_the_whole_story(gate, improver):
    lines = []
    out = run_demo(gate, improver, say=lines.append, sink=RecordingSink())
    text = "\n".join(lines)
    assert out["version"] == 4
    for beat in ("promote → v2", "promote → v3", "[cached, repeat]", "[invalid]", "needs_approval",
                 "with approvals", "7-12.5 s", "Lineage: v1: baseline"):
        assert beat in text, beat
