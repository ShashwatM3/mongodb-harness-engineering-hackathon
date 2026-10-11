"""Raindrop: one event per evaluation, plus four instrumented signals.

  candidate_brain   track_ai, one per proposal event, sent once its outcome is known
  gate_passed       POSITIVE, when the gate decides (first proposal event per policy only)
  gate_failed       NEGATIVE, likewise
  re_proposed       NEGATIVE, a candidate already proposed under the same policy
  invalid_proposal  NEGATIVE, a refused candidate

The adversary (kg/adversary.py) sends its own event, adversary_scenario, one per proposed or re-scored
scenario, with scenario_accepted / scenario_graduated (POSITIVE) and scenario_too_easy / scenario_impossible /
scenario_invalid / re_proposed (NEGATIVE). Its events carry against_version, never brain_version, so they
can't fall into a brain_version cohort.

Raindrop is never on the critical path: every call is wrapped, and the KG keeps
its own record of what was sent in `gate_runs.events`.
"""
from __future__ import annotations

import logging
from typing import Any, Optional, Protocol

log = logging.getLogger("kg.raindrop")

EVENT_NAME = "candidate_brain"
ADVERSARY_EVENT = "adversary_scenario"
POSITIVE = {"gate_passed", "scenario_accepted", "scenario_graduated"}
SIGNALS = ("gate_passed", "gate_failed", "re_proposed", "invalid_proposal")
ADVERSARY_SIGNALS = ("scenario_accepted", "scenario_graduated", "scenario_too_easy", "scenario_impossible",
                     "scenario_invalid", "re_proposed")


def clean_properties(props: dict[str, Any]) -> dict[str, Any]:
    """Raindrop properties must be str, int, float or bool: join lists, drop None, stringify the rest."""
    out: dict[str, Any] = {}
    for k, v in props.items():
        if v is None:
            continue
        if isinstance(v, (bool, int, float, str)):
            out[k] = v
        elif isinstance(v, (list, tuple, set)):
            out[k] = ",".join(str(x) for x in v)
        else:
            out[k] = str(v)
    return out


class Sink(Protocol):
    def event(self, event_id: str, properties: dict[str, Any], name: str = EVENT_NAME) -> None: ...
    def signal(self, event_id: str, name: str) -> None: ...
    def flush(self) -> None: ...


class NullSink:
    def event(self, event_id, properties, name=EVENT_NAME):
        pass

    def signal(self, event_id, name):
        pass

    def flush(self):
        pass


class RecordingSink:
    """For tests and dry runs: keeps everything in memory."""

    def __init__(self):
        self.events: list[tuple[str, dict]] = []
        self.event_names: dict[str, str] = {}
        self.signals: list[tuple[str, str]] = []

    def event(self, event_id, properties, name=EVENT_NAME):
        self.events.append((event_id, clean_properties(properties)))
        self.event_names[event_id] = name

    def signal(self, event_id, name):
        self.signals.append((event_id, name))

    def flush(self):
        pass

    def signal_names(self) -> list[str]:
        return [n for _, n in self.signals]


class RaindropSink:
    """The real SDK (raindrop-ai 0.0.73), instance-based so it never touches global state."""

    def __init__(self, write_key: str, user_id: str = "kg-improver", project_id: Optional[str] = None):
        from raindrop import Raindrop  # imported lazily: the SDK pulls in OpenTelemetry

        self.user_id = user_id
        self.client = Raindrop(api_key=write_key, project_id=project_id, tracing_enabled=False,
                               auto_instrument=False, app_git=False)

    def event(self, event_id, properties, name=EVENT_NAME):
        try:
            self.client.track_ai(user_id=self.user_id, event=name, event_id=event_id,
                                 properties=clean_properties(properties))
        except Exception as e:  # never let observability break the loop
            log.warning("raindrop track_ai failed: %s", e)

    def signal(self, event_id, name):
        try:
            self.client.track_signal(event_id=event_id, name=name,
                                     sentiment="POSITIVE" if name in POSITIVE else "NEGATIVE")
        except Exception as e:
            log.warning("raindrop track_signal failed: %s", e)

    def flush(self):
        try:
            self.client.flush()
        except Exception as e:
            log.warning("raindrop flush failed: %s", e)


def sink_from_config(cfg, dev: Optional[bool] = None) -> Sink:
    if not (cfg.raindrop_enabled and cfg.raindrop_write_key):
        return NullSink()
    dev, project = cfg.raindrop_target(dev)
    if dev and not project:
        log.warning("raindrop: dev run (no KG_RUNNER_URL) and no RAINDROP_DEV_PROJECT_ID, so nothing is sent")
        return NullSink()
    return RaindropSink(cfg.raindrop_write_key, project_id=project)
