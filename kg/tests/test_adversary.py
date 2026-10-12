"""The adversary (document 07, idea 6) on a Node-free stub runner: every status, the cache, graduation, the
curriculum cap, the stress-set firewall, Raindrop events, and the Claude proposer's command and parsing."""
from __future__ import annotations

import copy
import json
import subprocess

import pytest
from conftest import DB, reset
from pymongo.errors import OperationFailure

import kg.adversary as adversary
from kg.adversary import (ACTIVE, Adversary, AdversaryConfig, ClaudeProposer, FixedProposer, ProposerError,
                          RandomProposer, check_script_local, clean_script, curriculum, default_envelope,
                          describe_script, get_adversary_context, normalize_script, parse_seeds, scenario_hash, trace)
from kg.contract import BrainRejection, HealthResponse, RunShiftResponse, ValidateScenarioResponse
from kg.core import KG, KGError
from kg.db import connect as db_connect
from kg.db import probe_heldout_denied
from kg.epoch import ClaudeImprover, EpochConfig, Epochs, FixedImprover, SuggestImprover
from kg.hashing import effective_edits
from kg.raindrop_sink import ADVERSARY_EVENT, RecordingSink
from kg.runner import FIXTURES_DIR, ScenarioRejected, stair_threshold

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"
COUNTS = ("offered", "on_time", "late", "failed", "dropped", "censored", "safety_events")

# Scripts whose outcome against v1 the stub fixes (see StubRunner.effect)
ACCEPT = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 2400, "clear_at_tick": 5400}]
ACCEPT_SMALLER = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 2400, "clear_at_tick": 4800}]
EASY = [{"kind": "TASK_BURST", "at_tick": 3000, "count": 5}]
SPLIT_SEEDS = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-2", "at_tick": 2400, "clear_at_tick": 5400}]
NOT_AN_ATTACK = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 2400, "clear_at_tick": 4800},
                 {"kind": "HUMAN_INTRUSION", "zone_id": "C", "at_tick": 3000, "duration_ticks": 1800},
                 {"kind": "HUMAN_INTRUSION", "zone_id": "D", "at_tick": 3000, "duration_ticks": 1800}]
IMPOSSIBLE = [{"kind": "TASK_BURST", "at_tick": 3000, "count": 10}, {"kind": "TASK_BURST", "at_tick": 6000, "count": 10}]
INVALID = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 100, "clear_at_tick": 900}]


class StubRunner:
    """Deterministic, no Node. Every brain gets the same base shift (the fake runner's lifts-only fixture,
    mapped onto any seed), so brains differ only through the script. Per minute: a lift fault costs zone M
    0.04 under a lifts-only brain and 0.005 under a stairs brain, except that a LIFT-2 fault only bites on even
    seeds (at 0.08) and not at all on odd ones (for the seed-agreement rule); a person raises the zone's score
    by 0.04 for everyone (the twin's no-path artifact); a burst costs every zone 0.004 per task, and two bursts
    of 10 collapse every zone by 0.6 (nobody can handle it). On the standard profile every brain scores the
    same, except that sim.WAIT_REPLAN_TICKS = 15 costs every zone 0.02 (a regression for the epoch gate)."""

    def __init__(self, validate: bool = True):
        fx = json.loads((FIXTURES_DIR / "fake_q99_train.json").read_text())["response"]
        self.base = {int(r["seed"]): r for r in fx["per_seed"]}
        self.template = fx
        self.validate = validate
        self.calls: list[dict] = []

    def health(self):
        return HealthResponse(ok=True, engine_sha="stub", spec_id="warehouse-humanoid", spec_hash=None, mode="fake")

    def settings(self):
        return None

    def validate_brain(self, brain):
        return None

    def scenario_envelope(self, ticks=None):
        return None

    def validate_scenario(self, script, ticks=None):
        if not self.validate:
            return None
        norm, probs = check_script_local(script, ticks or 12000)
        h = scenario_hash(norm) if not probs else None
        return ValidateScenarioResponse(ok=not probs, rejected=probs, scenario_hash=h,
                                        scenario_profile=f"script:{h}" if h else None, scenario_script=norm)

    @staticmethod
    def effect(script, q, seed) -> dict:
        lifts_only = q >= 99
        d = {z: 0.0 for z in "ABCDM"}
        for e in script:
            if e["kind"] == "LIFT_FAULT":
                minutes = (e["clear_at_tick"] - e["at_tick"]) / 600
                if e["lift_id"] == "LIFT-2":
                    if seed % 2 == 0:
                        d["M"] -= (0.08 if lifts_only else 0.005) * minutes
                else:
                    d["M"] -= (0.04 if lifts_only else 0.005) * minutes
            elif e["kind"] == "HUMAN_INTRUSION":
                d[e["zone_id"]] += 0.04 * e["duration_ticks"] / 600
            elif e["kind"] == "TASK_BURST":
                for z in d:
                    d[z] -= 0.004 * e["count"]
        if sum(1 for e in script if e["kind"] == "TASK_BURST" and e["count"] == 10) >= 2:
            for z in d:
                d[z] -= 0.6
        return d

    def run_shift(self, brain, seeds, ticks=None, profile=None, allow_locked=False, held_out=False, scenario_script=None):
        ticks = ticks or 12000
        q = stair_threshold(brain)
        norm = None
        if scenario_script is not None:
            norm, probs = check_script_local(scenario_script, ticks)
            if probs:
                raise ScenarioRejected(BrainRejection(error="rejected_scenario", message="out of envelope",
                                                      scenario_rejected=probs))
            h = scenario_hash(norm)
            prof = f"script:{h}"
        else:
            prof = h = profile or "standard"
        self.calls.append({"q": q, "seeds": list(seeds), "profile": prof, "held_out": held_out})
        regress = effective_edits(brain).get("sim.WAIT_REPLAN_TICKS", {}).get("value") == 15
        per_seed = []
        for s in seeds:
            r = copy.deepcopy(self.base[101 + (int(s) - 101) % 12])
            r["seed"] = int(s)
            delta = self.effect(norm, q, int(s)) if norm is not None else {z: (-0.02 if regress else 0.0) for z in "ABCDM"}
            for z, zm in r["zones"].items():
                # counts that give exactly the score, so the KG's own pooling (from counts) agrees with it
                on = round(min(1.0, max(0.0, zm["score"] + delta.get(z, 0.0))) * 1000)
                zm.update(offered=1000, on_time=on, late=1000 - on, failed=0, dropped=0, censored=0, safety_events=0,
                          score=on / 1000)
            if norm is not None:
                r["scenario"] = norm
            per_seed.append(r)
        zones = list(per_seed[0]["zones"])
        pooled = {}
        for z in zones:
            sums = {k: sum(r["zones"][z][k] for r in per_seed) for k in COUNTS}
            pooled[z] = {**sums, "score": round(sums["on_time"] / sums["offered"], 3)}
        resp = {**self.template, "engine_sha": "stub", "spec_hash": None, "brain_version": brain.version,
                "patch_hash": f"stub-q{q:g}", "ticks": ticks, "scenario_profile": prof, "scenario_hash": h,
                "per_seed": per_seed, "pooled": {"zones": pooled}, "warnings": [],
                "mean": {"zones": {z: {"score": pooled[z]["score"]} for z in zones}, "fleet": self.template["mean"]["fleet"]}}
        return RunShiftResponse.model_validate(resp)


@pytest.fixture
def stub():
    return StubRunner()


@pytest.fixture
def agate(user_uris, sink, stub):
    """A gate client on the stub runner, on a freshly emptied test database."""
    db = db_connect(user_uris["gate"], DB, app="kg-test-adversary")
    reset(db)
    g = KG(db, "gate", sink=sink)
    g.use_runner(stub)
    g.seed()
    return g


def adv(gate, batches, **cfg):
    return Adversary(gate, FixedProposer(batches), AdversaryConfig(**cfg))


def promote_stairs(gate) -> int:
    p = gate.record_proposal(gate.latest_version(), {STAIR: 1}, origin="test", round=1, policy="t")
    gate.evaluate(p)
    gate.record_verdict(p.gate_run_id, "passed")
    return gate.promote(p.gate_run_id, "stairs at queue 1")["version"]


# ── scripts ──────────────────────────────────────────────────

def test_script_hash_and_check_match_twinforge():
    """Hashes computed by TwinForge's scenario.ts (WP-C2, physical-ai 4e64813) for the same scripts."""
    a = [{"kind": "TASK_BURST", "at_tick": 7200, "count": 8},
         {"kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 4800, "clear_at_tick": 6600},
         {"kind": "HUMAN_INTRUSION", "zone_id": "C", "at_tick": 3000, "duration_ticks": 900}]
    shuffled = [{"duration_ticks": 900, "zone_id": "C", "at_tick": 3000, "kind": "HUMAN_INTRUSION"},
                {"priority": "HIGH", "count": 8, "at_tick": 7200.0, "kind": "TASK_BURST"},
                {"clear_at_tick": 6600, "at_tick": 4800, "lift_id": "LIFT-1", "kind": "LIFT_FAULT"}]
    na, pa = check_script_local(a, 12000)
    nb, pb = check_script_local(clean_script(shuffled), 12000)
    assert pa == pb == [] and scenario_hash(na) == scenario_hash(nb) == "ae0bbc89dda50792"
    assert scenario_hash(normalize_script([])) == "4f53cda18c2baa0c"
    four = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-2", "at_tick": 3000, "clear_at_tick": 6000},
            {"kind": "TASK_BURST", "at_tick": 3000, "count": 10},
            {"kind": "HUMAN_INTRUSION", "zone_id": "M", "at_tick": 3000, "duration_ticks": 1800},
            {"kind": "TASK_BURST", "at_tick": 3000, "count": 4}]
    assert scenario_hash(check_script_local(four, 12000)[0]) == "938c10beb187deb0"
    _, probs = check_script_local([{"kind": "TASK_BURST", "zone": "M", "at_tick": 7200, "count": 8}], 12000)
    assert probs == [{"index": 0, "reason": "TASK_BURST has unknown field(s) zone (fields: kind, at_tick, count, priority)"}]
    _, probs = check_script_local(ACCEPT + [{**ACCEPT[0], "lift_id": "LIFT-2", "at_tick": 5000, "clear_at_tick": 6000}], 12000)
    assert probs[0]["index"] == 1 and "at most 1 lift may be down" in probs[0]["reason"]
    assert describe_script(ACCEPT + EASY) == "LIFT-1 down 04:00–09:00; burst of 5 at 05:00"
    assert describe_script([{"kind": "LIFT_FAULT"}, "junk"]) == "None down ?–?; junk"
    assert parse_seeds("101-103,110") == [101, 102, 103, 110]


def test_random_proposer_stays_inside_the_envelope():
    env = default_envelope(12000)
    for turn in range(40):
        props = RandomProposer(seed=7).propose({"data": {"turn": turn, "envelope": env}}, 4)
        for s in props.scenarios:
            _, probs = check_script_local(s["script"], 12000)
            assert probs == [], (s["script"], probs)


# ── turns ────────────────────────────────────────────────────

def test_a_turn_produces_every_status_and_records_evidence(agate, stub, sink):
    a = adv(agate, [[ACCEPT, EASY, SPLIT_SEEDS, NOT_AN_ATTACK, IMPOSSIBLE, INVALID]])
    t = a.turn(m=6)
    statuses = [o["status"] for o in t["outcomes"]]
    assert statuses == ["accepted", "too_easy", "too_easy", "too_easy", "impossible", "invalid"], t["outcomes"]
    acc, easy, split, nota, imp, bad = t["outcomes"]
    assert acc["regret"] == pytest.approx(0.035, abs=0.002) and acc["agree"] == 12 and acc["harm"] > 0
    assert "below 0.02" in easy["reason"]
    assert "ahead on only 6 of 12 seeds" in split["reason"]
    assert "not an attack" in nota["reason"] and nota["regret"] >= 0.02
    assert "no known brain does well" in imp["reason"]
    assert "outside [600, 10800]" in bad["reason"]
    assert t["alternatives"] == ["v1 + stairs at queue 1, no load on stairs", "v1 + stairs at queue 2", "v1 + stairs at queue 1"]
    assert t["counts"] == {"accepted": 1, "too_easy": 3, "impossible": 1, "invalid": 1} and t["active"] == 1

    doc = agate.c("scenarios").find_one({"_id": acc["scenario_id"]})
    assert doc["status"] == ACTIVE and doc["profile"] == f"script:{doc['scenario_hash']}"
    assert doc["against"]["version"] == 1 and doc["best_alternative"] and len(doc["evals"]) == 1
    assert set(doc["evals"][0]["scores"]) == {"v1", *t["alternatives"]}
    # scripted shifts live under the script's env; the quiet baseline and the standard profile under theirs
    profiles = set(agate.c("shifts").distinct("env.profile"))
    assert {f"script:{doc['scenario_hash']}", f"script:{scenario_hash([])}", "standard"} <= profiles
    assert agate.c("adversary_turns").find_one({"turn": 1})["status"] == "done"
    assert agate.c("scenarios").count_documents({}) == 6

    # Raindrop: one adversary_scenario event per proposal, against_version and never brain_version
    names = sink.signal_names()
    for s in ("scenario_accepted", "scenario_too_easy", "scenario_impossible", "scenario_invalid"):
        assert s in names
    adv_events = [(eid, p) for eid, p in sink.events if sink.event_names.get(eid) == ADVERSARY_EVENT]
    assert len(adv_events) == 6
    assert all("brain_version" not in p and p["against_version"] == 1 for _, p in adv_events)


def test_a_repeated_scenario_is_cached_and_counts_as_re_proposed(agate, stub, sink):
    a = adv(agate, [[ACCEPT], [list(reversed(ACCEPT)), INVALID], [INVALID]])
    a.turn(m=1)
    runs = len(stub.calls)
    t2 = a.turn(m=2)
    assert [o["status"] for o in t2["outcomes"]] == ["cached", "invalid"]
    assert len(stub.calls) == runs + 1  # only the standard-profile context run: the cached scenario ran nothing
    t3 = a.turn(m=1)
    assert t3["outcomes"][0]["status"] == "cached"  # the same invalid script again
    doc = agate.c("scenarios").find_one({"_id": t2["outcomes"][0]["scenario_id"]})
    assert [p["outcome"] for p in doc["proposals"]] == ["new", "cached"] and len(doc["evals"]) == 1
    assert sink.signal_names().count("re_proposed") == 2
    assert agate.c("scenarios").count_documents({}) == 2


def test_graduation_after_a_promotion(agate, sink):
    a = adv(agate, [[ACCEPT]])
    a.turn(m=1)
    V = promote_stairs(agate)
    assert V == 2
    g = a.graduate(V)
    assert g["rescored"] == 1 and len(g["graduated"]) == 1
    doc = agate.c("scenarios").find_one({"status": "graduated"})
    assert doc["graduated_by"]["version"] == 2
    assert [h["phase"] for h in doc["regret_history"]] == ["proposed", "rescore"]
    assert doc["regret_history"][-1]["regret"] < 0.01
    assert "scenario_graduated" in sink.signal_names()
    assert curriculum(agate) == []
    rows = trace(agate)
    assert [r["kind"] for r in rows] == ["curriculum", "graduate"] and rows[-1]["graduated_total"] == 1
    # against v2, v1 is an alternative and the stairs variant equal to v2 drops out
    assert [x.label for x in a.alternatives(a.brain_ref(2))] == ["v1", "v1 + stairs at queue 1, no load on stairs",
                                                                  "v1 + stairs at queue 2"]


def test_the_curriculum_cap_displaces_the_lowest_regret(agate):
    a = adv(agate, [[ACCEPT_SMALLER], [ACCEPT]], cap=1)
    first = a.turn(m=1)["outcomes"][0]
    second = a.turn(m=1)["outcomes"][0]
    assert first["status"] == second["status"] == "accepted" and second["regret"] > first["regret"]
    assert second["displaced"] == [first["scenario_id"]]
    assert agate.c("scenarios").find_one({"_id": first["scenario_id"]})["status"] == "displaced"
    assert [c["scenario_id"] for c in curriculum(agate)] == [second["scenario_id"]]


def test_without_the_runner_check_the_local_port_decides(user_uris, sink):
    db = db_connect(user_uris["gate"], DB, app="kg-test-adversary")
    reset(db)
    g = KG(db, "gate", sink=sink)
    g.use_runner(StubRunner(validate=False))
    g.seed()
    t = adv(g, [[ACCEPT, INVALID]]).turn(m=2)
    assert [o["status"] for o in t["outcomes"]] == ["accepted", "invalid"]


def test_the_adversary_needs_the_gate_client(agate, user_uris, stub):
    imp = KG(db_connect(user_uris["improver"], DB, app="kg-test-adversary-imp"), "improver")
    imp.use_runner(stub)
    with pytest.raises(KGError):
        Adversary(imp)


# ── the stress set and its firewall ─────────────────────────

def test_the_stress_set_is_gate_only_and_never_enters_the_curriculum(agate, stub, user_uris):
    stress_script = [{"kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 3000, "clear_at_tick": 6000}]
    a = adv(agate, [[stress_script, EASY], [stress_script]])
    st = a.stress_turn(against=1)
    assert [r["status"] for r in st["rows"]] == ["accepted", "too_easy"] and st["stress_set"] == 1
    h = st["rows"][0]["scenario_hash"]
    # never recorded in the KG, never cached by the runner
    assert agate.c("shifts").count_documents({"env.profile": f"script:{h}"}) == 0
    assert all(c["held_out"] for c in stub.calls if c["profile"] == f"script:{h}")
    # a curriculum turn proposing the same script withholds it, and leaves no trace of the script anywhere
    t = a.turn(m=1)
    assert t["withheld"] == 1 and t["outcomes"] == []
    assert agate.c("scenarios").count_documents({"scenario_hash": h}) == 0
    turn_doc = agate.c("adversary_turns").find_one({"turn": t["turn"]})
    assert turn_doc["proposals"] == [] and "raw" not in turn_doc and json.dumps(stress_script) not in json.dumps(turn_doc, default=str)
    # even if one leaked into scenarios, curriculum() on the gate drops it
    agate.c("scenarios").insert_one({"_id": f"sc-{h}", "scenario_hash": h, "status": ACTIVE, "regret": 0.5, "script": stress_script})
    assert all(c["scenario_hash"] != h for c in curriculum(agate))
    # the improver can't read heldout_stress at all, but can read the curriculum
    imp = KG(db_connect(user_uris["improver"], DB, app="kg-test-adversary-imp"), "improver")
    with pytest.raises(OperationFailure):
        imp.c("heldout_stress").find_one({})
    assert probe_heldout_denied(imp.db) is None
    assert imp.c("scenarios").count_documents({}) >= 1 and imp.c("adversary_turns").count_documents({}) >= 1

    V = promote_stairs(agate)
    rep = a.stress_report([1, V])
    assert rep["mean"]["v2"] > rep["mean"]["v1"] and len(rep["rows"]) == 1
    seeds = agate.c("heldout_seeds").find_one({"_id": "stress"})["seeds"]
    calls = [c for c in stub.calls if sorted(c["seeds"]) == sorted(seeds)]
    assert len(seeds) == 12 and len(calls) == 2 and all(c["held_out"] for c in calls)
    assert agate.c("heldout_stress").count_documents({"kind": "report"}) == 1


# ── what the proposer sees, and the Claude proposer ─────────

def test_the_context_shows_the_brain_the_alternatives_and_the_history(agate):
    a = adv(agate, [[ACCEPT, INVALID]])
    a.turn(m=2)
    cur = a.brain_ref(1)
    ctx = get_adversary_context(a, cur, a.alternatives(cur), turn=2)
    md = ctx["markdown"]
    for s in ("## The current brain: v1", "A scenario must push the score below this", "Lift-queue jams by lift",
              "### The other brains", "sim.STAIR_MIN_LIFT_QUEUE 1 (v1: 99)", "[accepted] LIFT-1 down 04:00–09:00",
              "[invalid]", "### Rules", "never more than 1 lift down at a time"):
        assert s in md, s
    assert ctx["data"]["kinds"]["LIFT_FAULT"] == {"proposed": 2, "accepted": 1} and "hint" not in ctx["data"]
    a.proposer = FixedProposer([[EASY]])
    a.turn(m=1)  # nothing accepted against v1: the next context asks for a different structure
    assert "Change the structure of your attack" in get_adversary_context(a, cur, a.alternatives(cur), turn=4)["markdown"]
    fresh = get_adversary_context(a, cur, a.alternatives(cur), turn=3, fresh=True)
    assert "Your last scenarios" not in fresh["markdown"] and "history" not in fresh["data"]


class FakeCompleted:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def test_claude_proposer_command_and_parsing(monkeypatch, agate):
    seen = {}

    def fake_run(cmd, input, text, capture_output, timeout, cwd):
        seen["cmd"], seen["input"], seen["cwd"] = cmd, input, cwd
        out = {"type": "result", "is_error": False, "total_cost_usd": 0.12, "duration_ms": 9000,
               "usage": {"output_tokens": 900},
               "modelUsage": {"claude-haiku-4-5": {"outputTokens": 10}, "claude-opus-5-5": {"outputTokens": 900}},
               "structured_output": {"scenarios": [
                   {"rationale": "lift 1 fails while the lifts-only brain queues", "script": ACCEPT},
                   {"rationale": "a float tick", "script": [{"kind": "TASK_BURST", "at_tick": 3000.0, "count": 5}]}]}}
        return FakeCompleted(0, json.dumps(out))

    monkeypatch.setattr(adversary.subprocess, "run", fake_run)
    p = ClaudeProposer()
    a = Adversary(agate, p, AdversaryConfig(m=2))
    t = a.turn()
    cmd = seen["cmd"]
    assert cmd[:2] == ["claude", "-p"] and cmd[cmd.index("--model") + 1] == "claude-opus-5-5"
    assert cmd[cmd.index("--tools") + 1] == "" and "--safe-mode" in cmd and "--strict-mcp-config" in cmd
    assert json.loads(cmd[cmd.index("--json-schema") + 1])["required"] == ["scenarios"]
    assert "### Rules" in seen["input"] and "Propose exactly 2 scenario scripts" in seen["input"]
    assert t["proposer"]["model"] == "claude-opus-5-5"
    assert [o["status"] for o in t["outcomes"]] == ["accepted", "too_easy"]
    turn = agate.c("adversary_turns").find_one({"turn": t["turn"]})
    assert turn["proposals"][0]["rationale"].startswith("lift 1") and turn["context_markdown"].startswith("## The current brain")

    monkeypatch.setattr(adversary.subprocess, "run", lambda *a, **k: FakeCompleted(0, "[1, 2]"))
    with pytest.raises(ProposerError, match="unexpected output"):
        ClaudeProposer(retries=0).propose({"markdown": "x"}, 2)
    monkeypatch.setattr(adversary.subprocess, "run", lambda *a, **k: FakeCompleted(1, "", "rate limited"))
    with pytest.raises(ProposerError):
        ClaudeProposer(retries=1).propose({"markdown": "x"}, 2)
    with pytest.raises(ProposerError):
        a.turn()
    assert agate.c("adversary_turns").find_one({}, sort=[("turn", -1)])["status"] == "failed"


# ── epochs: the two loops in turn ───────────────────────────

def test_an_epoch_promotes_a_curriculum_win_then_graduates_and_attacks_again(agate):
    a = adv(agate, [[ACCEPT], [EASY]])
    a.turn(m=1)
    ep = Epochs(agate, a, FixedImprover([{STAIR: 1}, {"sim.LIFT_RETRY_TICKS": 30}]), EpochConfig(k=2))
    res = ep.run()
    assert res["promoted_to"] == 2 and agate.latest_version() == 2
    win, other = res["candidates"]
    assert win["passed"] and win["train"]["curriculum"] == pytest.approx(0.035, abs=0.003)
    assert win["val"]["std"]["delta"] == pytest.approx(0, abs=1e-9) and win["val"]["curriculum"] > 0
    assert not other["passed"] and "no gain on the training seeds" in other["reason"]
    assert len(res["graduated"]) == 1 and res["adversary_turn"] == 3 and res["adversary_counts"] == {"too_easy": 1}
    doc = agate.c("epochs").find_one({"k": 1})
    assert doc["status"] == "done" and doc["promoted_to"] == 2 and doc["curriculum"] == res["graduated"]
    # candidates measured on the curriculum live in the scenario's env, with their own gate runs
    scen = agate.c("scenarios").find_one({"_id": res["graduated"][0]})
    runs = list(agate.c("gate_runs").find({"env.profile": f"script:{scen['scenario_hash']}"}))
    assert {r["split"] for r in runs} == {"train", "val"}
    promoted = agate.c("gate_runs").find_one({"promoted_to": 2})
    assert promoted["env"]["profile"] == "standard" and promoted["split"] == "val"


def test_the_gate_refuses_a_curriculum_win_that_regresses_ordinary_shifts(agate):
    a = adv(agate, [[ACCEPT]])
    a.turn(m=1)
    ep = Epochs(agate, a, FixedImprover([{STAIR: 1, "sim.WAIT_REPLAN_TICKS": 15}]), EpochConfig(k=1))
    res = ep.run(adversary_turn=False)
    (c,) = res["candidates"]
    assert c["train"]["curriculum"] > 0 and c["train"]["all"] > 0  # it wins on the curriculum...
    assert not c["passed"] and "regresses the standard profile" in c["reason"]  # ...but not on ordinary shifts
    assert res["promoted_to"] is None and agate.latest_version() == 1
    assert agate.c("gate_runs").find_one({"_id": c["val"]["std"]["gate_run_id"]})["verdict"] == "rejected"
    assert curriculum(agate)[0]["regret"] > 0  # the scenario stays active


def test_an_epoch_with_no_curriculum_needs_a_standard_gain(agate):
    a = adv(agate, [])
    res = Epochs(agate, a, SuggestImprover(), EpochConfig(k=2)).run(adversary_turn=False)
    assert res["promoted_to"] is None
    assert all("no gain on the training seeds" in c["reason"] for c in res["candidates"])


def test_claude_improver_prompt_and_parsing(monkeypatch, agate):
    a = adv(agate, [[ACCEPT]])
    a.turn(m=1)
    seen = {}

    def fake_run(cmd, input, text, capture_output, timeout, cwd):
        seen["cmd"], seen["input"] = cmd, input
        out = {"is_error": False, "modelUsage": {"claude-opus-5-5": {"outputTokens": 500}}, "total_cost_usd": 0.05,
               "structured_output": {"candidates": [
                   {"why": "take the stairs when one robot already waits", "edits": [{"target": STAIR, "value": 1}]},
                   {"why": "empty", "edits": []}]}}
        return FakeCompleted(0, json.dumps(out))

    monkeypatch.setattr(adversary.subprocess, "run", fake_run)
    imp = ClaudeImprover()
    cands = imp.candidates(agate, 1, curriculum(agate), 3)
    assert cands == [{"edits": {STAIR: 1}, "why": "take the stairs when one robot already waits"}]
    assert "### C. Untested settings" in seen["input"] and "LIFT-1 down 04:00–09:00" in seen["input"]
    assert "v1 + stairs" not in seen["input"]  # the improver never sees the alternatives the regret came from
    assert imp.last["model"] == "claude-opus-5-5"


# ── fixes from the review ───────────────────────────────────

SPEED = "class.HUM-1.max_speed"


def test_locked_candidates_go_to_the_call_only_when_they_pass_on_the_numbers(agate):
    a = adv(agate, [[ACCEPT]])
    a.turn(m=1)
    regress = {STAIR: 1, SPEED: 1.35, "sim.WAIT_REPLAN_TICKS": 15}
    res = Epochs(agate, a, FixedImprover([{STAIR: 1, SPEED: 1.35}, regress]), EpochConfig(k=2)).run(adversary_turn=False)
    good, bad = res["candidates"]
    assert good["verdict"] == "needs_approval" and "needs the Robotics Lead's approval" in good["reason"]
    assert bad["verdict"] == "rejected" and "regresses the standard profile" in bad["reason"]
    assert res["promoted_to"] is None
    assert agate.c("gate_runs").find_one({"_id": good["val"]["std"]["gate_run_id"]})["verdict"] == "needs_approval"
    assert agate.c("gate_runs").find_one({"_id": bad["val"]["std"]["gate_run_id"]})["verdict"] == "rejected"
    # the Robotics Lead declines; the improver tries the same change again: no second call
    agate.record_approval(SPEED, 1.35, "reject", by="Robotics Lead", ref="call:test")
    again = Epochs(agate, a, FixedImprover([{STAIR: 1, SPEED: 1.35}]), EpochConfig(k=1)).run(adversary_turn=False)
    (c,) = again["candidates"]
    assert c["verdict"] == "rejected" and "declined by the Robotics Lead" in c["reason"]
    assert agate.c("gate_runs").find_one({"_id": c["val"]["std"]["gate_run_id"]})["verdict"] == "rejected"


def test_candidates_that_compile_to_the_same_brain_share_one_verdict(agate):
    a = adv(agate, [[ACCEPT], [EASY]])
    a.turn(m=1)
    res = Epochs(agate, a, FixedImprover([{STAIR: 1}, {STAIR: 1.0}, {STAIR: 1}]), EpochConfig(k=3)).run()
    assert res["promoted_to"] == 2 and res["status"] == "done"
    assert [c["verdict"] for c in res["candidates"]] == ["passed", "duplicate"]  # the exact repeat is dropped


def test_a_failed_adversary_turn_keeps_the_promotion_and_graduation(agate):
    a = adv(agate, [[ACCEPT]])  # no batch left for the epoch's turn: the proposer raises
    a.turn(m=1)
    res = Epochs(agate, a, FixedImprover([{STAIR: 1}]), EpochConfig(k=1)).run()
    assert res["status"] == "done_without_adversary_turn" and "no batches left" in res["adversary_error"]
    assert res["promoted_to"] == 2 and len(res["graduated"]) == 1
    doc = agate.c("epochs").find_one({"k": 1})
    assert doc["promoted_to"] == 2 and doc["graduated"] == res["graduated"]


def test_an_epoch_regrades_the_curriculum_after_a_promotion_outside_the_loop(agate):
    a = adv(agate, [[ACCEPT]])
    a.turn(m=1)
    promote_stairs(agate)  # e.g. the phone-call path promoted v2
    res = Epochs(agate, a, FixedImprover([]), EpochConfig(k=1)).run(adversary_turn=False)
    doc = agate.c("epochs").find_one({"k": 1})
    assert len(doc["regraded"]) == 1 and doc["curriculum"] == [] and res["promoted_to"] is None
    assert agate.c("scenarios").find_one({"status": "graduated"})["graduated_by"]["version"] == 2


def test_a_scenario_displaced_on_arrival_is_not_reported_as_accepted(agate, sink):
    a = adv(agate, [[ACCEPT], [ACCEPT_SMALLER]], cap=1)
    a.turn(m=1)
    t = a.turn(m=1)
    (o,) = t["outcomes"]
    assert o["status"] == "displaced" and o["displaced"] == [] and "holds 1 harder" in o["reason"]
    assert t["counts"] == {"displaced": 1} and sink.signal_names().count("scenario_accepted") == 1


def test_stored_evals_count_only_for_the_same_env_and_seeds(agate):
    a = adv(agate, [[ACCEPT], [ACCEPT]])
    first = a.turn(m=1)["outcomes"][0]
    agate.c("scenarios").update_one({"_id": first["scenario_id"]}, {"$set": {"evals.0.env_key": "env-older-engine"}})
    again = a.turn(m=1)["outcomes"][0]
    assert again["status"] == ACTIVE  # re-measured, not cached
    assert len(agate.c("scenarios").find_one({"_id": first["scenario_id"]})["evals"]) == 2


def test_seeds_outside_the_splits_are_scored_but_not_recorded_and_held_out_seeds_are_refused(agate):
    t = adv(agate, [[ACCEPT]], seeds=[901, 902, 903]).turn(m=1)
    assert t["outcomes"][0]["status"] in (ACTIVE, "too_easy")
    assert agate.c("shifts").count_documents({"seed": {"$in": [901, 902, 903]}}) == 0
    agate.c("heldout_seeds").insert_one({"_id": "test-locked", "seeds": [777]})
    with pytest.raises(KGError, match="held-out seeds"):
        adv(agate, [], seeds=[101, 777])


def test_malformed_scripts_never_crash_the_check():
    _, probs = check_script_local([{"kind": ["LIFT_FAULT"], "at_tick": 900}, {"kind": {"x": 1}}], 12000)
    assert [p["index"] for p in probs] == [0, 1] and all("not allowed" in p["reason"] for p in probs)
