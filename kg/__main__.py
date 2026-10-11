"""Command line for the KG. Run from the team repo root: python -m kg <command> ...

  setup [--self-managed]      collections, indexes and seed (gate URI); prints Atlas CLI commands for the users
  atlas-commands              the Atlas CLI commands for the improver role and both users
  seed [--v1-brain FILE]      idempotent seed; --v1-brain takes v1 values from brains/v1.json
  sync-settings               refresh the envelope from the runner's GET /settings
  context V | suggest V       what the improver sees for brain V
  brain-context NODE [-v V]   the supervisor's get_brain_context
  explain ID | lineage V      the demo's click path and version chain
  signals SHIFT_ID [--json]   Raindrop's signals for one shift, by category (needs RAINDROP_QUERY_API_KEY)
  snapshot V [--compare-to N] nodes and links for the stage view (JSON)
  export V [--out FILE]       the contract Brain the runner receives
  check-v1 FILE               go/no-go: export_brain(1) vs brains/v1.json through /validate_brain
  demo [--db kg_demo]         the presentable story on the fake runner

Connection: KG_MONGODB_URI_GATE / KG_MONGODB_URI_IMPROVER (see kg/config.py), or --uri for both (local only).
"""
from __future__ import annotations

import argparse
import json
import sys

from . import Config, connect, load_dotenv


def _cfg(args) -> Config:
    cfg = Config()
    if args.uri:
        cfg.gate_uri = cfg.improver_uri = args.uri
    if args.db:
        cfg.db_name = args.db
    return cfg


def _print(obj):
    print(obj if isinstance(obj, str) else json.dumps(obj, indent=2, default=str))


def main(argv=None) -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(prog="python -m kg", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uri", help="one connection string for both roles (local development only)")
    ap.add_argument("--db", help="database name (default KG_DB or 'kg')")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("setup")
    p.add_argument("--self-managed", action="store_true", help="also create the role and users (not on Atlas)")
    p.add_argument("--improver-password")
    p.add_argument("--gate-password")
    p = sub.add_parser("atlas-commands")
    p.add_argument("--project-id", default="<PROJECT_ID>")
    p = sub.add_parser("seed")
    p.add_argument("--v1-brain")
    sub.add_parser("sync-settings")
    for name in ("context", "suggest", "lineage", "export"):
        p = sub.add_parser(name)
        p.add_argument("version", type=int)
        if name == "export":
            p.add_argument("--out")
    p = sub.add_parser("snapshot")
    p.add_argument("version", type=int)
    p.add_argument("--compare-to", type=int)
    p = sub.add_parser("explain")
    p.add_argument("component_id")
    p = sub.add_parser("signals")
    p.add_argument("shift_id")
    p.add_argument("--dev", action="store_true", default=None, help="read the dev project (default: as the sink)")
    p.add_argument("--json", action="store_true", help="the full result, not just the summary")
    p = sub.add_parser("brain-context")
    p.add_argument("node")
    p.add_argument("-v", "--version", type=int)
    p = sub.add_parser("check-v1")
    p.add_argument("v1_json")
    p = sub.add_parser("demo")
    p.add_argument("--raindrop", action="store_true", help="send events to Raindrop's dev project (needs RAINDROP_WRITE_KEY and RAINDROP_DEV_PROJECT_ID)")
    p.add_argument("--keep", action="store_true", help="don't empty the demo database first")
    args = ap.parse_args(argv)
    cfg = _cfg(args)

    if args.cmd == "atlas-commands":
        from .db import atlas_cli_commands
        _print("\n".join(atlas_cli_commands(cfg.db_name, args.project_id)))
        return 0

    if args.cmd == "setup":
        from .db import atlas_cli_commands, create_roles_and_users, probe_heldout_denied
        gate = connect("gate", cfg, with_runner=False)
        report = gate.seed()
        _print({"seed": report})
        if args.self_managed:
            if not (args.improver_password and args.gate_password):
                ap.error("--self-managed needs --improver-password and --gate-password")
            _print(create_roles_and_users(gate.db.client, cfg.db_name, args.improver_password, args.gate_password))
        else:
            print("\nOn Atlas, create the role and users with the Atlas CLI (Project Owner), then set "
                  "KG_MONGODB_URI_IMPROVER / KG_MONGODB_URI_GATE:")
            print("\n".join(atlas_cli_commands(cfg.db_name)))
        if cfg.improver_uri and cfg.improver_uri != cfg.gate_uri:
            imp = connect("improver", cfg, with_runner=False)
            denied = probe_heldout_denied(imp.db)
            print("\nfirewall:", "improver is denied on heldout_results" if denied is None else denied)
        return 0

    if args.cmd == "demo":
        from .core import KG
        from .db import connect as db_connect
        from .raindrop_sink import RaindropSink, RecordingSink
        from .runner import runner_from_config
        from .tools.demo import run_demo
        cfg.db_name = args.db or "kg_demo"
        if not args.keep and "demo" not in cfg.db_name:
            ap.error(f"demo empties its database first; refusing {cfg.db_name!r} (use a name containing 'demo')")
        sink = RecordingSink()
        if args.raindrop:
            if not cfg.raindrop_write_key:
                ap.error("--raindrop needs RAINDROP_WRITE_KEY")
            if not cfg.raindrop_dev_project_id:
                ap.error("--raindrop needs RAINDROP_DEV_PROJECT_ID: demo events must stay out of the real cohorts")
            real = RaindropSink(cfg.raindrop_write_key, project_id=cfg.raindrop_dev_project_id)

            class Tee(RecordingSink):
                def event(self, e, props):
                    super().event(e, props)
                    real.event(e, props)

                def signal(self, e, name):
                    super().signal(e, name)
                    real.signal(e, name)

                def flush(self):
                    real.flush()
            sink = Tee()
        runner = runner_from_config(cfg)
        gdb = db_connect(cfg.uri_for("gate"), cfg.db_name, app="kg-demo-gate")
        if not args.keep:
            for name in gdb.list_collection_names():
                gdb[name].delete_many({})
        gate = KG(gdb, "gate", sink=sink, config=cfg)
        gate.use_runner(runner)
        imp = KG(db_connect(cfg.uri_for("improver"), cfg.db_name, app="kg-demo-improver"), "improver", sink=sink,
                 config=cfg)
        imp.use_runner(runner)
        print(f"runner: {type(runner).__name__}, env {gate.env.key}, database {cfg.db_name}\n")
        run_demo(gate, imp, sink=sink)
        sink.flush()
        return 0

    role = "gate" if args.cmd in ("seed", "sync-settings") else "improver"
    needs_runner = args.cmd in ("context", "suggest", "sync-settings")
    from .raindrop_sink import NullSink
    g = connect(role, cfg, sink=NullSink(), with_runner=needs_runner)  # CLI commands never send Raindrop events
    if args.cmd == "seed":
        _print(g.seed(v1_brain=args.v1_brain))
    elif args.cmd == "sync-settings":
        _print(g.sync_settings())
    elif args.cmd == "context":
        _print(g.get_context(args.version)["markdown"])
    elif args.cmd == "suggest":
        _print(g.suggest(args.version))
    elif args.cmd == "lineage":
        _print(g.lineage(args.version)["markdown"])
    elif args.cmd == "explain":
        _print(g.explain(args.component_id)["markdown"])
    elif args.cmd == "signals":
        res = g.get_signals(args.shift_id, dev=args.dev)
        _print(res if args.json else res["markdown"])
    elif args.cmd == "snapshot":
        _print(g.graph_snapshot(args.version, args.compare_to))
    elif args.cmd == "brain-context":
        _print(g.get_brain_context(args.node, args.version, reader="cli"))
    elif args.cmd == "export":
        brain = g.export_brain(args.version).model_dump(mode="json", exclude_none=True)
        if args.out:
            with open(args.out, "w") as f:
                json.dump(brain, f, indent=2)
            print(f"wrote {args.out}")
        else:
            _print(brain)
    elif args.cmd == "check-v1":
        from .tools.checks import check_v1
        runner = None
        if cfg.runner_url:
            from .runner import HttpRunner
            runner = HttpRunner(cfg.runner_url)
        _print(check_v1(g, runner, args.v1_json))
    return 0


if __name__ == "__main__":
    sys.exit(main())
