"""The knowledge graph (KG): the robot brain and everything the harness learns about it.

    import kg
    gate = kg.connect("gate")          # gate process: seed, verdicts, promote, held-out, approvals
    imp = kg.connect("improver")       # GEPA side: proposals, shifts, context, suggestions

See kg/README.md for the evaluator wiring, and reference/kg-implementation-plan.md for the design.
"""
from __future__ import annotations

from typing import Optional

from .config import Config, load_dotenv
from .core import KG, EnvMismatch, KGError, NeedsApproval, PermissionDenied, Proposal, StalePromotion

__all__ = ["KG", "Config", "connect", "load_dotenv", "KGError", "PermissionDenied", "StalePromotion",
           "NeedsApproval", "EnvMismatch", "Proposal"]


def connect(role: str, config: Optional[Config] = None, *, sink=None, runner=None, env_epoch: Optional[str] = None,
            with_runner: bool = True) -> KG:
    """A KG bound to one database user. `role` is "improver" or "gate"; each gets its own MongoClient.
    With no runner given: KG_RUNNER_URL if set, else TwinForge's fake runner, else the saved fixtures."""
    from .db import connect as db_connect
    from .raindrop_sink import sink_from_config
    from .runner import runner_from_config

    cfg = config or Config()
    db = db_connect(cfg.uri_for(role), cfg.db_name, app=f"kg-{role}")
    g = KG(db, role, sink=sink if sink is not None else sink_from_config(cfg), config=cfg)
    if with_runner:
        g.use_runner(runner or runner_from_config(cfg), env_epoch)
    return g
