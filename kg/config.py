"""Configuration from environment variables (and an optional .env file).

  KG_MONGODB_URI_GATE      connection string for the `gate` user (readWrite)
  KG_MONGODB_URI_IMPROVER  connection string for the `improver` user (custom role)
  KG_MONGODB_URI           fallback for both (local development only)
  KG_DB                    database name (default "kg"; tests use "kg_test")
  KG_ENV_EPOCH             manual env epoch until the runner reports spec_hash (default "e1");
                           bump it whenever WP-T retunes the stair costs
  KG_RUNNER_URL            runner base URL, e.g. http://localhost:8787 (unset: fixtures / fake)
  KG_TRAIN_SEEDS, KG_VAL_SEEDS  comma-separated seed lists (defaults 101-112 and 201-206)
  KG_TICKS, KG_PROFILE     shift length and scenario profile (defaults 12000, "standard")
  RAINDROP_WRITE_KEY       enables Raindrop events and signals
  KG_RAINDROP              "0" disables Raindrop even when the key is set
  RAINDROP_PROJECT_ID      project slug for real-runner events, the Experiment cohorts (unset: the key's default)
  RAINDROP_DEV_PROJECT_ID  project slug for fake-runner, fixture and demo events; without it they aren't sent
  KG_RAINDROP_DEV          "1"/"0" forces the dev/real project (default: dev unless KG_RUNNER_URL is set)
  TWINFORGE_DIR            the physical-ai checkout (for the fake runner and fixtures)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .contract import DEFAULT_PROFILE, DEFAULT_TICKS

DEFAULT_TRAIN_SEEDS = list(range(101, 113))
DEFAULT_VAL_SEEDS = list(range(201, 207))


def load_dotenv(start: Optional[Path] = None, max_up: int = 3) -> Optional[Path]:
    """Load the nearest .env (cwd, then up to `max_up` parents). Existing variables win."""
    here = (start or Path.cwd()).resolve()
    for d in [here, *list(here.parents)[:max_up]]:
        p = d / ".env"
        if p.is_file():
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip().removeprefix("export ").strip()
                v = v.strip().strip('"').strip("'")
                if k and v and k not in os.environ:
                    os.environ[k] = v
            return p
    return None


def _seeds(var: str, default: list[int]) -> list[int]:
    raw = os.getenv(var, "").strip()
    return [int(x) for x in raw.split(",") if x.strip()] if raw else list(default)


@dataclass
class Config:
    db_name: str = field(default_factory=lambda: os.getenv("KG_DB", "kg"))
    gate_uri: Optional[str] = field(default_factory=lambda: os.getenv("KG_MONGODB_URI_GATE") or os.getenv("KG_MONGODB_URI"))
    improver_uri: Optional[str] = field(
        default_factory=lambda: os.getenv("KG_MONGODB_URI_IMPROVER") or os.getenv("KG_MONGODB_URI"))
    env_epoch: str = field(default_factory=lambda: os.getenv("KG_ENV_EPOCH", "e1"))
    runner_url: Optional[str] = field(default_factory=lambda: os.getenv("KG_RUNNER_URL") or None)
    train_seeds: list[int] = field(default_factory=lambda: _seeds("KG_TRAIN_SEEDS", DEFAULT_TRAIN_SEEDS))
    val_seeds: list[int] = field(default_factory=lambda: _seeds("KG_VAL_SEEDS", DEFAULT_VAL_SEEDS))
    ticks: int = field(default_factory=lambda: int(os.getenv("KG_TICKS", DEFAULT_TICKS)))
    profile: str = field(default_factory=lambda: os.getenv("KG_PROFILE", DEFAULT_PROFILE))
    raindrop_write_key: Optional[str] = field(default_factory=lambda: os.getenv("RAINDROP_WRITE_KEY") or None)
    raindrop_enabled: bool = field(default_factory=lambda: os.getenv("KG_RAINDROP", "1") not in ("0", "false", "no"))
    raindrop_project_id: Optional[str] = field(default_factory=lambda: os.getenv("RAINDROP_PROJECT_ID") or None)
    raindrop_dev_project_id: Optional[str] = field(default_factory=lambda: os.getenv("RAINDROP_DEV_PROJECT_ID") or None)
    raindrop_dev: Optional[bool] = field(
        default_factory=lambda: {"1": True, "0": False}.get(os.getenv("KG_RAINDROP_DEV", "").strip()))
    twinforge_dir: Optional[str] = field(default_factory=lambda: os.getenv("TWINFORGE_DIR") or None)

    def uri_for(self, role: str) -> str:
        uri = self.improver_uri if role == "improver" else self.gate_uri
        if not uri:
            var = "KG_MONGODB_URI_IMPROVER" if role == "improver" else "KG_MONGODB_URI_GATE"
            raise RuntimeError(f"no connection string for role {role!r}: set {var}")
        return uri

    def raindrop_target(self, dev: Optional[bool] = None) -> tuple[bool, Optional[str]]:
        """(dev, project slug). Fake-runner and demo events go to the dev project, never the real cohorts;
        a dev run with no dev project returns slug None and sends nothing."""
        if dev is None:
            dev = self.raindrop_dev if self.raindrop_dev is not None else self.runner_url is None
        return dev, (self.raindrop_dev_project_id if dev else self.raindrop_project_id)

    def seed_sets(self) -> dict[str, list[int]]:
        return {"train": self.train_seeds, "val": self.val_seeds}
