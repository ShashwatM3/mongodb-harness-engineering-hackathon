"""Clients for the TwinForge runner contract.

  HttpRunner     the real runner (WP-R), or kg/tools/fake_runner.mts --serve
  TsxFakeRunner  TwinForge's fakeRunShift through tsx, one process per call
  FixtureRunner  saved fake-runner responses (kg/tests/fixtures), no Node needed

The fake runner only reads sim.STAIR_MIN_LIFT_QUEUE (default 99), so a fixture
recorded for one stair threshold answers for every brain with that threshold.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Optional, Protocol

from .contract import (Brain, BrainRejection, HealthResponse, RunShiftResponse, ScenarioEnvelope, SettingsResponse,
                       ValidateBrainResponse, ValidateScenarioResponse)
from .hashing import effective_edits

KG_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = KG_DIR / "tests" / "fixtures"


class RunnerError(RuntimeError):
    pass


class BrainRejected(RunnerError):
    """HTTP 422: the runner refused the brain (locked or rejected edits)."""

    def __init__(self, rejection: BrainRejection):
        super().__init__(f"{rejection.error}: {rejection.message}")
        self.rejection = rejection


class ScenarioRejected(BrainRejected):
    """HTTP 422 rejected_scenario: the scenario_script is outside the runner's scenario envelope (WP-C2)."""


class Runner(Protocol):
    def health(self) -> HealthResponse: ...

    def run_shift(self, brain: Brain, seeds: list[int], ticks: Optional[int] = None,
                  profile: Optional[str] = None, allow_locked: bool = False,
                  held_out: bool = False, scenario_script: Optional[list[dict]] = None) -> RunShiftResponse: ...

    def validate_brain(self, brain: Brain) -> Optional[ValidateBrainResponse]: ...

    def settings(self) -> Optional[SettingsResponse]: ...

    #: WP-C2; None when the runner predates caller-supplied scripts
    def validate_scenario(self, script: list[dict], ticks: Optional[int] = None) -> Optional[ValidateScenarioResponse]: ...

    def scenario_envelope(self, ticks: Optional[int] = None) -> Optional[ScenarioEnvelope]: ...


def _request(brain: Brain, seeds, ticks, profile, allow_locked, held_out, scenario_script=None) -> dict:
    req = {"brain": brain.model_dump(mode="json", exclude_none=True), "seeds": [int(s) for s in seeds]}
    if ticks is not None:
        req["ticks"] = int(ticks)
    if scenario_script is not None:  # WP-C2: the script replaces the profile
        req["scenario_script"] = scenario_script
    elif profile is not None:
        req["scenario_profile"] = profile
    if allow_locked:
        req["allow_locked"] = True
    if held_out:
        req["held_out"] = True
    return req


class HttpRunner:
    def __init__(self, base_url: str, timeout: float = 300.0):
        import httpx

        self.base_url = base_url.rstrip("/")
        self.http = httpx.Client(base_url=self.base_url, timeout=timeout)

    def health(self) -> HealthResponse:
        r = self.http.get("/health")
        r.raise_for_status()
        return HealthResponse.model_validate(r.json())

    def run_shift(self, brain, seeds, ticks=None, profile=None, allow_locked=False, held_out=False,
                  scenario_script=None):
        r = self.http.post("/run_shift", json=_request(brain, seeds, ticks, profile, allow_locked, held_out,
                                                       scenario_script))
        if r.status_code == 422:
            rej = BrainRejection.model_validate(r.json())
            raise (ScenarioRejected if rej.error == "rejected_scenario" else BrainRejected)(rej)
        r.raise_for_status()
        return RunShiftResponse.model_validate(r.json())

    def validate_scenario(self, script, ticks=None):
        body = {"scenario_script": script, **({"ticks": int(ticks)} if ticks is not None else {})}
        r = self.http.post("/validate_scenario", json=body)
        if r.status_code in (404, 405, 501):
            return None  # a runner without WP-C2
        r.raise_for_status()
        return ValidateScenarioResponse.model_validate(r.json())

    def scenario_envelope(self, ticks=None):
        r = self.http.get("/scenario_envelope", params={"ticks": int(ticks)} if ticks is not None else None)
        if r.status_code in (404, 405, 501):
            return None
        r.raise_for_status()
        return ScenarioEnvelope.model_validate(r.json())

    def validate_brain(self, brain):
        r = self.http.post("/validate_brain", json={"brain": brain.model_dump(mode="json", exclude_none=True)})
        if r.status_code in (404, 405, 501):
            return None  # a fake runner without the compiler: the KG hashes locally
        r.raise_for_status()
        return ValidateBrainResponse.model_validate(r.json())

    def settings(self):
        r = self.http.get("/settings")
        if r.status_code in (404, 405, 501):
            return None
        r.raise_for_status()
        return SettingsResponse.model_validate(r.json())


FAKE_HEALTH = {"ok": True, "engine_sha": "fake", "spec_id": "warehouse-humanoid", "spec_hash": "fake", "mode": "fake"}


def stair_threshold(brain: Brain) -> float:
    """What the fake runner reads: the effective sim.STAIR_MIN_LIFT_QUEUE, 99 when absent."""
    e = effective_edits(brain).get("sim.STAIR_MIN_LIFT_QUEUE")
    return e["value"] if e else 99


def default_twinforge_dir() -> Path:
    env = os.getenv("TWINFORGE_DIR")
    return Path(env) if env else KG_DIR.parent.parent / "physical-ai"


class TsxFakeRunner:
    """Runs TwinForge's fakeRunShift via kg/tools/fake_runner.mts. Needs Node and the physical-ai checkout."""

    def __init__(self, twinforge_dir: Optional[str] = None):
        self.dir = Path(twinforge_dir) if twinforge_dir else default_twinforge_dir()
        self.tsx = self.dir / "node_modules" / ".bin" / "tsx"
        self.script = KG_DIR / "tools" / "fake_runner.mts"
        if not self.tsx.exists():
            raise RunnerError(f"tsx not found at {self.tsx}: run `npm ci` in {self.dir}")

    def health(self):
        return HealthResponse.model_validate(FAKE_HEALTH)

    def run_shift(self, brain, seeds, ticks=None, profile=None, allow_locked=False, held_out=False,
                  scenario_script=None):
        req = _request(brain, seeds, ticks, profile, allow_locked, held_out, scenario_script)
        p = subprocess.run([str(self.tsx), str(self.script), "--stdin"], input=json.dumps(req), text=True,
                           capture_output=True, env={**os.environ, "TWINFORGE_DIR": str(self.dir)}, timeout=120)
        if p.returncode != 0:
            raise RunnerError(f"fake runner failed: {p.stderr.strip()[-500:]}")
        return RunShiftResponse.model_validate(json.loads(p.stdout))

    def validate_brain(self, brain):
        return None

    def settings(self):
        return None

    def validate_scenario(self, script, ticks=None):
        return None  # the fake checks scripts inside run_shift (TwinForge with WP-C2) and fails loudly

    def scenario_envelope(self, ticks=None):
        return None


class FixtureRunner:
    """Replays responses saved by kg/tools/make_fixtures.sh. Any brain works; only its stair threshold matters."""

    def __init__(self, fixtures_dir: Optional[Path] = None):
        self.dir = Path(fixtures_dir) if fixtures_dir else FIXTURES_DIR
        self.index: dict[tuple, Path] = {}
        for p in sorted(self.dir.glob("fake_q*.json")):
            d = json.loads(p.read_text())
            req, resp = d["request"], d["response"]
            q = stair_threshold(Brain.model_validate(req["brain"]))
            key = (float(q), tuple(sorted(req["seeds"])), resp["ticks"], resp["scenario_profile"])
            self.index[key] = p
        if not self.index:
            raise RunnerError(f"no fixtures in {self.dir}: run kg/tools/make_fixtures.sh")
        self.calls: list[dict] = []

    def health(self):
        return HealthResponse.model_validate(FAKE_HEALTH)

    def run_shift(self, brain, seeds, ticks=None, profile=None, allow_locked=False, held_out=False,
                  scenario_script=None):
        if scenario_script is not None:
            raise RunnerError("the saved fixtures have no scripted scenarios: use a runner with WP-C2")
        q = float(stair_threshold(brain))
        key = (q, tuple(sorted(int(s) for s in seeds)), ticks or 12000, profile or "standard")
        p = self.index.get(key)
        if p is None:
            have = sorted({k[0] for k in self.index})
            raise RunnerError(f"no fixture for stair threshold {q:g} and seeds {list(key[1])}; have {have}")
        self.calls.append({"q": q, "seeds": list(key[1]), "version": brain.version})
        resp = json.loads(p.read_text())["response"]
        resp["brain_version"] = brain.version        # the fake echoes the request's version
        by_seed = {r["seed"]: r for r in resp["per_seed"]}
        resp["per_seed"] = [by_seed[int(s)] for s in seeds]  # keep the request's seed order
        return RunShiftResponse.model_validate(resp)

    def validate_brain(self, brain):
        return None

    def settings(self):
        return None

    def validate_scenario(self, script, ticks=None):
        return None

    def scenario_envelope(self, ticks=None):
        return None


def runner_from_config(cfg) -> Runner:
    if cfg.runner_url:
        return HttpRunner(cfg.runner_url)
    try:
        return TsxFakeRunner(cfg.twinforge_dir)
    except RunnerError:
        return FixtureRunner()
