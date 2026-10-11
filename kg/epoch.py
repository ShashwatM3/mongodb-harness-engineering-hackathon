"""Epochs (document 07, section 3.4): the improver and the adversary take turns on one deterministic twin.

    epoch k:
      1. the improver proposes candidate edits for the current brain vN (the KG's suggest(), or Claude reading
         get_context(vN) plus the curriculum); each is measured on the training seeds on the standard profile
         and on every active curriculum scenario
      2. the gate promotes the best one only if it improves the curriculum on the validation seeds AND does not
         regress the standard profile there by more than the tolerance: adversarial training can't trade away
         ordinary shifts
      3. graduate(vN+1): re-score the curriculum; solved scenarios graduate
      4. an adversary turn against the current brain adds new scenarios

    python -m kg epoch --epochs 3 --improver claude          # KG_RUNNER_URL: a TwinForge runner with WP-C2

Step 1 is pluggable: anything with candidates(kg, V, curriculum, k) -> [{"edits": {target: value}, "why": str}]
(GEPA included). Gate runs measured on a script live in that scenario's env (profile "script:<hash>"), and
their Raindrop events go to the dev project only.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from typing import Any, Optional, Protocol

from .adversary import Adversary, ProposerError, curriculum, scenario_kg
from .core import KG, now

log = logging.getLogger("kg.epoch")


@dataclass
class EpochConfig:
    k: int = 3                 # candidates per epoch
    val_top: int = 2           # best training candidates checked on the validation seeds
    tolerance: float = 0.01    # allowed drop of the standard profile's mean zone score on the validation seeds
    min_gain: float = 0.0      # required gain on the curriculum (or on the standard profile when it is empty)


class Improver(Protocol):
    name: str

    def candidates(self, kg: KG, V: int, active: list[dict], k: int) -> list[dict]: ...


class SuggestImprover:
    """The KG's own next steps (get_context section C): one untested setting each, no phone call needed."""
    name = "suggest"

    def candidates(self, kg, V, active, k):
        return [{"edits": {c["target"]: c["value"]}, "why": c.get("why") or f"untested {c['target']}"}
                for c in kg.suggest(V, k)["candidates"] if not c["needs_call"]]


class FixedImprover:
    """Given candidates, in order (tests and demos)."""
    name = "fixed"

    def __init__(self, cands: list[dict]):
        self.cands = list(cands)

    def candidates(self, kg, V, active, k):
        out, self.cands = self.cands[:k], self.cands[k:]
        return [c if "edits" in c else {"edits": c, "why": "given"} for c in out]


IMPROVER_SYSTEM = """You are the improver in a two-agent self-improvement loop for a fleet of legged warehouse robots in a deterministic digital twin. You edit the fleet's "brain": typed settings, each with a target name and a value. A second agent, the adversary, writes disruption scenarios where the current brain does worse than other brains; the active ones form a curriculum.

A candidate is promoted only if it raises the mean zone score on the curriculum scenarios AND does not lower it on the standard profile (ordinary shifts) by more than 0.01, both on held-back validation seeds. Propose small, targeted edits with a clear mechanism. Only use settings listed in the context's section C, within their min and max. Avoid settings marked "locked: needs a call". Don't repeat candidates that section B shows were already evaluated."""


def improver_schema() -> dict:
    edit = {"type": "object", "additionalProperties": False, "required": ["target", "value"],
            "properties": {"target": {"type": "string"}, "value": {"type": "number"}}}
    cand = {"type": "object", "additionalProperties": False, "required": ["why", "edits"],
            "properties": {"why": {"type": "string"}, "edits": {"type": "array", "items": edit}}}
    return {"type": "object", "additionalProperties": False, "required": ["candidates"],
            "properties": {"candidates": {"type": "array", "items": cand}}}


class ClaudeImprover:
    """Claude through a headless `claude -p` call (the user's subscription), like the adversary's proposer. It sees
    get_context(vN) (improver-visible collections only) and the curriculum's scripts and outcomes for vN, never
    the alternative brains the regret was measured against."""
    name = "claude"

    def __init__(self, model: Optional[str] = None, effort: Optional[str] = None, timeout: float = 600.0,
                 cli: Optional[str] = None, retries: int = 1):
        self.model = model or os.getenv("KG_IMPROVER_MODEL", "claude-opus-5-5")
        self.effort = effort or os.getenv("KG_IMPROVER_EFFORT", "high")
        self.timeout, self.retries = timeout, retries
        self.cli = cli or os.getenv("KG_ADVERSARY_CLI", "claude")
        self.last: dict = {}

    def prompt(self, kg, V, active, k) -> str:
        lines = [kg.get_context(V)["markdown"], "", "## The curriculum (adversary scenarios the brain must also handle)"]
        for s in active:
            lines.append(f"- {s['description']} · v{s['against_version']}'s regret {s['regret']:+.3f} "
                         f"(another known brain does that much better)")
        if not active:
            lines.append("- none yet: improve the standard profile")
        lines += ["", f"## Your task\nPropose {k} candidates, each a small set of setting edits with a one-sentence why."]
        return "\n".join(lines)

    def candidates(self, kg, V, active, k):
        cmd = [self.cli, "-p", "--model", self.model, "--effort", self.effort, "--output-format", "json",
               "--json-schema", json.dumps(improver_schema()), "--tools", "", "--safe-mode", "--strict-mcp-config",
               "--no-session-persistence", "--permission-prompts", "none", "--system-prompt", IMPROVER_SYSTEM]
        prompt = self.prompt(kg, V, active, k)
        last: Optional[Exception] = None
        for _ in range(self.retries + 1):
            t0 = time.monotonic()
            try:
                with tempfile.TemporaryDirectory(prefix="kg-improver-") as cwd:
                    p = subprocess.run(cmd, input=prompt, text=True, capture_output=True, timeout=self.timeout, cwd=cwd)
                if p.returncode != 0:
                    raise ProposerError(f"claude exited {p.returncode}: {(p.stderr or p.stdout).strip()[-400:]}")
                out = json.loads(p.stdout)
                if not isinstance(out, dict):
                    raise ProposerError(f"unexpected output: {p.stdout[:200]}")
                so = out.get("structured_output")
                if out.get("is_error") or not isinstance(so, dict) or not isinstance(so.get("candidates"), list):
                    raise ProposerError(f"no structured output: {str(out.get('result') or out)[:400]}")
                usage = out.get("modelUsage") or {}
                self.last = {"model": max(usage, key=lambda m: usage[m].get("outputTokens", 0)) if usage else self.model,
                             "seconds": round(time.monotonic() - t0, 1), "cost_usd": out.get("total_cost_usd"), "raw": so}
                cands = []
                num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
                for c in so["candidates"][:k]:
                    if not isinstance(c, dict) or not isinstance(c.get("edits"), list):
                        continue
                    edits = {e["target"]: e["value"] for e in c["edits"]
                             if isinstance(e, dict) and isinstance(e.get("target"), str) and num(e.get("value"))}
                    if edits:
                        cands.append({"edits": edits, "why": str(c.get("why") or "")})
                return cands
            except (ProposerError, json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as e:
                last = e
                log.warning("improver failed: %s", e)
        raise ProposerError(str(last))


def mean_delta(result: dict) -> Optional[float]:
    zones = result.get("zones") or {}
    if not zones:
        return None
    return sum(z["cand"] for z in zones.values()) / len(zones) - sum(z["base"] for z in zones.values()) / len(zones)


def _mean(xs: list[float]) -> Optional[float]:
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


class Epochs:
    """The two loops in turn. One gate client does the bookkeeping; the improver step only ever sees
    improver-visible data (get_context and the curriculum)."""

    def __init__(self, kg: KG, adversary: Adversary, improver: Improver, config: Optional[EpochConfig] = None):
        kg._require_gate("an epoch (it records verdicts and promotes)")
        self.kg, self.adv, self.improver = kg, adversary, improver
        self.cfg = config or EpochConfig()

    def measure(self, V: int, edits: dict, active: list[dict], split: str, k: int, why: str) -> dict:
        """One candidate on the standard profile and on every active scenario, on one seed split."""
        origin = {"source": f"epoch:{self.improver.name}", "ref": f"epoch {k}"}
        p = self.kg.record_proposal(V, edits, origin=origin, round=k, policy="epoch", split=split, hypothesis=why)
        if p.status == "invalid":
            return {"invalid": p.reason, "std": {"gate_run_id": p.gate_run_id}}
        std = self.kg.evaluate(p)
        if std.get("verdict") == "invalid":
            return {"invalid": std.get("reason"), "std": {"gate_run_id": p.gate_run_id}}
        out = {"std": {"gate_run_id": p.gate_run_id, "delta": mean_delta(std)}, "scenarios": [],
               "locked": [e["target"] for e in p.locked_edits]}
        for s in active:
            skg = scenario_kg(self.kg, s["script"], s["scenario_hash"], runner=self.adv.runner)
            q = skg.record_proposal(V, edits, origin=origin, round=k, policy="epoch", split=split, hypothesis=why)
            r = skg.evaluate(q)
            out["scenarios"].append({"scenario_id": s["scenario_id"], "gate_run_id": q.gate_run_id, "delta": mean_delta(r)})
        out["curriculum"] = _mean([x["delta"] for x in out["scenarios"]])
        out["all"] = _mean([out["std"]["delta"]] + [x["delta"] for x in out["scenarios"]])
        return out

    def gate(self, active: list[dict], c: dict) -> tuple[str, str]:
        """Document 07's extra rule, on the validation seeds: better on the curriculum AND no worse than the
        tolerance on ordinary shifts. Returns (verdict, reason): "passed", "needs_approval" (passed on the numbers
        but changes a locked setting: the Robotics Lead's call), "rejected" or "invalid"."""
        val = c["val"]
        if val.get("invalid"):
            return "invalid", f"invalid: {val['invalid']}"
        std = val["std"]["delta"] or 0.0
        if std < -self.cfg.tolerance:
            return "rejected", f"regresses the standard profile on the validation seeds by {-std:.3f} (tolerance {self.cfg.tolerance})"
        gain = val["curriculum"] if active else std
        if gain is None or gain <= self.cfg.min_gain:
            what = "the curriculum" if active else "the standard profile"
            return "rejected", f"does not improve {what} on the validation seeds ({(gain or 0):+.3f})"
        why = (f"curriculum {val['curriculum']:+.3f}, standard {std:+.3f} on the validation seeds" if active
               else f"standard {std:+.3f} on the validation seeds (no curriculum yet)")
        if val.get("locked"):
            env = self.kg._envelope()
            for t in val["locked"]:
                v = c["edits"].get(t)
                if any(a.get("decision") == "reject" and v is not None and abs(float(a["value"]) - float(v)) < 1e-9
                       for a in (env.get(t) or {}).get("approvals") or []):
                    return "rejected", f"{t}={v} was declined by the Robotics Lead on the call"
            return "needs_approval", f"passed on the numbers ({why}) but changes locked settings ({', '.join(val['locked'])}): needs the Robotics Lead's approval"
        return "passed", why

    def _ensure_graded(self, V: int) -> Optional[dict]:
        """Re-grade the curriculum when the brain changed since it was scored (a promotion outside the loop, or a
        graduation that failed): the improver must train against scenarios measured on the current brain."""
        ph = self.adv.brain_ref(V).patch_hash
        stale = self.kg.c("scenarios").count_documents({"status": "accepted", "against.patch_hash": {"$ne": ph}})
        return self.adv.graduate(V) if stale else None

    def _save(self, doc_id: str, **fields):
        self.kg.c("epochs").update_one({"_id": doc_id}, {"$set": fields})

    def run(self, k: Optional[int] = None, adversary_turn: bool = True) -> dict:
        t0 = time.monotonic()
        if k is None:
            last = self.kg.c("epochs").find_one({}, {"k": 1}, sort=[("k", -1)])
            k = int(last["k"]) + 1 if last else 1
        V = self.kg.latest_version()
        doc_id = f"epoch-{k:03d}"
        self.kg.c("epochs").replace_one({"_id": doc_id}, {"_id": doc_id, "k": k, "base_version": V, "improver": self.improver.name,
                                                          "started_at": now(), "status": "running"}, upsert=True)
        promoted, grad, turn, cands = None, None, None, []
        try:
            regraded = self._ensure_graded(V)
            active = curriculum(self.kg)
            self._save(doc_id, curriculum=[a["scenario_id"] for a in active],
                       regraded=[g["scenario_id"] for g in (regraded or {}).get("rows", [])])
            seen_edits = set()
            for c in self.improver.candidates(self.kg, V, active, self.cfg.k):
                key = json.dumps(c["edits"], sort_keys=True)
                if key not in seen_edits:
                    seen_edits.add(key)
                    cands.append(c)
            for c in cands:
                c["train"] = self.measure(V, c["edits"], active, "train", k, c.get("why", ""))
            # best training gain first, one candidate per brain: two edit sets that compile to the same patch share
            # their gate runs, and a gate run can carry only one verdict
            ranked, seen_runs = [], set()
            for c in sorted((c for c in cands if not c["train"].get("invalid") and (c["train"].get("all") or 0) > 0),
                            key=lambda c: -c["train"]["all"]):
                gid = c["train"]["std"]["gate_run_id"]
                if gid in seen_runs:
                    c["verdict"], c["reason"] = "duplicate", "compiles to the same brain as a better-ranked candidate"
                    continue
                seen_runs.add(gid)
                ranked.append(c)
            ranked = ranked[: self.cfg.val_top]
            for c in ranked:
                c["val"] = self.measure(V, c["edits"], active, "val", k, c.get("why", ""))
                c["verdict"], c["reason"] = self.gate(active, c)
                if c["verdict"] == "invalid":
                    continue
                run = self.kg.c("gate_runs").find_one({"_id": c["val"]["std"]["gate_run_id"]}, {"verdict": 1, "promoted_to": 1})
                if run and run.get("verdict") == "promoted":  # the brain came back to a patch it had before
                    c["verdict"], c["reason"] = "kept", f"this exact change was already promoted to v{run['promoted_to']}"
                elif run and run.get("verdict") == "needs_approval" and c["verdict"] == "needs_approval":
                    c["verdict"], c["reason"] = "kept", "its approval call is already pending"
            for c in cands:
                if "verdict" not in c:
                    c["verdict"] = "invalid" if c["train"].get("invalid") else "rejected"
                    c["reason"] = (f"invalid: {c['train']['invalid']}" if c["train"].get("invalid")
                                   else f"no gain on the training seeds ({(c['train'].get('all') or 0):+.3f})"
                                   if c not in ranked else "not validated")
            winners = sorted((c for c in ranked if c["verdict"] == "passed"),
                             key=lambda c: (-(c["val"]["curriculum"] or 0), -(c["val"]["std"]["delta"] or 0)))
            for c in ranked:
                gid = c["val"]["std"]["gate_run_id"]
                if c["verdict"] in ("invalid", "kept"):
                    continue
                if winners and c is winners[0]:
                    self.kg.record_verdict(gid, "passed", reason=f"epoch {k}: {c['reason']}")
                    promoted = self.kg.promote(gid, hypothesis=c.get("why") or None)
                elif c["verdict"] == "needs_approval":
                    self.kg.record_verdict(gid, "needs_approval", reason=f"epoch {k}: {c['reason']}")
                else:
                    if c["verdict"] == "passed":
                        c["verdict"], c["reason"] = "rejected", f"passed, but another candidate did better ({c['reason']})"
                    self.kg.record_verdict(gid, "rejected", reason=f"epoch {k}: {c['reason']}")
            self._save(doc_id, status="decided", promoted_to=promoted["version"] if promoted else None,
                       candidates=self._candidates_doc(cands))  # persisted before anything else can fail
            if promoted:
                grad = self.adv.graduate(promoted["version"])
                self._save(doc_id, graduated=[g["scenario_id"] for g in grad.get("graduated", [])])
        except Exception as e:
            self._save(doc_id, status="failed", error=str(e)[:1000], finished_at=now())
            raise
        turn_error = None
        if adversary_turn:
            try:
                turn = self.adv.turn(epoch=k)
            except Exception as e:  # the promotion and graduation stand; the next epoch's turn tries again
                turn_error = str(e)[:1000]
                log.warning("epoch %s: adversary turn failed: %s", k, e)
        summary = {
            "status": "done" if not turn_error else "done_without_adversary_turn",
            "promoted_to": promoted["version"] if promoted else None, "candidates": self._candidates_doc(cands),
            "improver_meta": {k_: v for k_, v in getattr(self.improver, "last", {}).items() if k_ != "raw"},
            "graduated": [g["scenario_id"] for g in (grad or {}).get("graduated", [])],
            "adversary_turn": turn["turn"] if turn else None, "adversary_counts": turn["counts"] if turn else None,
            "adversary_error": turn_error, "active_after": self.adv.snapshot(), "finished_at": now(),
            "wall_s": round(time.monotonic() - t0, 1)}
        self._save(doc_id, **summary)
        return {"k": k, "base_version": V, **summary}

    @staticmethod
    def _candidates_doc(cands: list[dict]) -> list[dict]:
        return [{"edits": c["edits"], "why": c.get("why"), "passed": c.get("verdict") == "passed",
                 "verdict": c.get("verdict"), "reason": c.get("reason"), "train": c.get("train"), "val": c.get("val")}
                for c in cands]
