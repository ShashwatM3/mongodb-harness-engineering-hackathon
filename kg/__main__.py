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
  adversary turn|graduate|curriculum|show|trace|context|stress|stress-report
                              the adversary agent (document 07, idea 6): see `python -m kg adversary -h`
  epoch [--epochs N] [--improver suggest|claude]
                              improver and adversary in turn (document 07, section 3.4)

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
    p = sub.add_parser("adversary", help="the adversary agent: scenarios that break the current brain")
    asub = p.add_subparsers(dest="acmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--seeds", help="scoring seeds, e.g. 101-112 (default: the KG's training seeds)")
    common.add_argument("--no-raindrop", action="store_true", help="send no Raindrop events")
    common.add_argument("--dev-events", action="store_true", help="send Raindrop events to the dev project")
    common.add_argument("--json", action="store_true", help="full JSON output")
    for name, hlp in (("turn", "one turn: propose scripts against vN, score them, accept or reject"),
                      ("stress", "the stress set (gate-only), generated against v1 with a fresh prompt"),
                      ("context", "print what the proposer would see for vN")):
        q = asub.add_parser(name, help=hlp, parents=[common])
        q.add_argument("--against", type=int, help="brain version (default: the latest; stress: 1)")
        if name != "context":
            q.add_argument("--proposer", choices=("claude", "random", "hand"), default="claude")
            q.add_argument("--script", help="hand: a JSON file of [{script, rationale}] or of scripts")
            q.add_argument("-m", type=int, help="scripts per turn (default 4)")
        if name == "turn":
            q.add_argument("--epoch", type=int, default=0)
    q = asub.add_parser("graduate", help="after a promotion: re-score the active scenarios against vN", parents=[common])
    q.add_argument("version", type=int, nargs="?")
    q = asub.add_parser("stress-report", help="score versions once on the stress set (held-out seeds)", parents=[common])
    q.add_argument("versions", type=int, nargs="+")
    asub.add_parser("curriculum", help="the active scenarios, hardest first", parents=[common])
    q = asub.add_parser("show", help="the latest scenarios with their status and regret", parents=[common])
    q.add_argument("--limit", type=int, default=20)
    asub.add_parser("trace", help="the curriculum chart's numbers, one row per turn", parents=[common])
    q = asub.add_parser("replay", help="the compare.html URL that replays a scenario under v1 and v2", parents=[common])
    q.add_argument("scenario_id")
    q.add_argument("--seed", type=int, help="default: the seed where the best alternative gains most")
    q.add_argument("--base-url", default="http://localhost:5174", help="TwinForge's dev server (npm run dev)")
    p = sub.add_parser("epoch", help="epochs: improver step, gate, graduation, adversary turn", parents=[common])
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--improver", choices=("suggest", "claude"), default="suggest")
    p.add_argument("--proposer", choices=("claude", "random"), default="claude", help="the adversary's proposer")
    p.add_argument("--k", type=int, default=3, help="improver candidates per epoch")
    p.add_argument("--no-adversary", action="store_true", help="skip the adversary turn")
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
        from .raindrop_sink import EVENT_NAME, RaindropSink, RecordingSink
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
                def event(self, e, props, name=EVENT_NAME):
                    super().event(e, props, name)
                    real.event(e, props, name)

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

    if args.cmd == "adversary":
        return _adversary(args, cfg, ap)
    if args.cmd == "epoch":
        return _epoch(args, cfg, ap)

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


def _epoch(args, cfg, ap) -> int:
    from . import adversary as A
    from . import epoch as E
    from .raindrop_sink import NullSink, sink_from_config
    if not cfg.runner_url:
        ap.error("epochs run on the runner: set KG_RUNNER_URL (a TwinForge runner with WP-C2)")
    if args.dev_events:
        cfg.raindrop_dev = True
    g = connect("gate", cfg, sink=NullSink() if args.no_raindrop else sink_from_config(cfg))
    conf = A.AdversaryConfig.from_env()
    if args.seeds:
        conf.seeds = A.parse_seeds(args.seeds)
    adv = A.Adversary(g, A.ClaudeProposer() if args.proposer == "claude" else A.RandomProposer(), conf)
    imp = E.ClaudeImprover() if args.improver == "claude" else E.SuggestImprover()
    ep = E.Epochs(g, adv, imp, E.EpochConfig(k=args.k))
    for _ in range(args.epochs):
        res = ep.run(adversary_turn=not args.no_adversary)
        if args.json:
            _print(res)
            continue
        print(f"Epoch {res['k']} on v{res['base_version']} ({res['wall_s']} s): "
              + (f"promoted v{res['promoted_to']}" if res["promoted_to"] else "nothing promoted"))
        for c in res["candidates"]:
            t = c["train"].get("all")
            print(f"  [{'pass' if c['passed'] else 'fail'}] {c['edits']}  train {('%+.3f' % t) if t is not None else '-'}"
                  f"  · {c['reason']}")
        if res["graduated"]:
            print(f"  graduated: {', '.join(res['graduated'])}")
        if res["adversary_turn"]:
            print(f"  adversary turn {res['adversary_turn']}: {res['adversary_counts']}")
        a = res["active_after"]
        print(f"  curriculum: {a['active']} active"
              + (f", mean regret {a['mean_active_regret']:+.3f}" if a["mean_active_regret"] is not None else "")
              + f"; {a['graduated_total']} graduated")
    return 0


def _adversary(args, cfg, ap) -> int:
    from . import adversary as A
    from .raindrop_sink import NullSink, sink_from_config
    if args.dev_events:
        cfg.raindrop_dev = True
    if args.acmd in ("curriculum", "show", "trace", "replay"):  # reads: any client, no runner
        g = connect("gate", cfg, sink=NullSink(), with_runner=False)
        if args.acmd == "replay":
            d = g.c("scenarios").find_one({"_id": args.scenario_id})
            if d is None or not d.get("scenario_hash"):
                ap.error(f"no valid scenario {args.scenario_id!r}")
            _print(A.replay_url(d, seed=args.seed, base_url=args.base_url, runner=cfg.runner_url))
        elif args.acmd == "curriculum":
            rows = A.curriculum(g)
            _print(rows if args.json else "\n".join(f"{r['regret']:+.3f} vs v{r['against_version']}  {r['description']}"
                                                     for r in rows) or "no active scenarios")
        elif args.acmd == "trace":
            _print(A.trace(g))
        else:
            docs = list(g.c("scenarios").find({}, {"evals": 0, "proposals": 0}).sort("updated_at", -1).limit(args.limit))
            _print(docs if args.json else "\n".join(
                f"[{d['status']:<10}] {('%+.3f' % d['regret']) if d.get('regret') is not None else '   -  '} "
                f"vs v{(d.get('against') or {}).get('version', '-')}  {d.get('description')}  · {d.get('reason') or ''}"
                for d in docs) or "no scenarios yet")
        return 0
    if not cfg.runner_url:
        ap.error("the adversary scores scenarios on the runner: set KG_RUNNER_URL (a TwinForge runner with WP-C2)")
    g = connect("gate", cfg, sink=NullSink() if args.no_raindrop else sink_from_config(cfg))
    conf = A.AdversaryConfig.from_env()
    if args.seeds:
        conf.seeds = A.parse_seeds(args.seeds)
    proposer = None
    if args.acmd in ("turn", "stress"):
        if args.proposer == "claude":
            proposer = A.ClaudeProposer()
        elif args.proposer == "random":
            proposer = A.RandomProposer()
        else:
            if not args.script:
                ap.error("--proposer hand needs --script FILE")
            with open(args.script) as f:
                batch = json.load(f)
            proposer = A.FixedProposer([batch])
        if args.m:
            conf.m = args.m
    adv = A.Adversary(g, proposer, conf)
    if args.acmd == "context":
        V = args.against or g.latest_version()
        cur = adv.brain_ref(V)
        _print(A.get_adversary_context(adv, cur, adv.alternatives(cur), turn=0)["markdown"])
        return 0
    if args.acmd == "graduate":
        res = adv.graduate(args.version)
        _print(res if args.json else "\n".join([f"Re-scored {res['rescored']} active scenario(s) against v{res['version']}:"] + [
            f"  [{r['status']}] regret {r['regret_before']:+.3f} -> {r['regret']:+.3f}  {r['description']}" for r in res["rows"]]
            + [f"Curriculum: {res['active']} active, {res['graduated_total']} graduated"]))
        return 0
    if args.acmd == "stress-report":
        _print(adv.stress_report(args.versions))
        return 0
    if args.acmd == "stress":
        _print(adv.stress_turn(against=args.against or 1))
        return 0
    res = adv.turn(against=args.against, epoch=args.epoch)
    if args.json:
        _print(res)
        return 0
    pr = res["proposer"]
    print(f"Turn {res['turn']} against v{res['against_version']} ({pr['name']}"
          + (f", {pr['model']}, {pr['seconds']} s" if pr.get("model") else "") + f"; turn {res['wall_s']} s)")
    print("Alternatives: " + "; ".join(res["alternatives"]))
    for o in res["outcomes"]:
        reg = f"regret {o['regret']:+.3f}" if o.get("regret") is not None else "            "
        print(f"  [{o['status']:<10}] {reg}  {o.get('description') or ''}\n               {o.get('reason') or ''}")
    print(f"Curriculum: {res['active']} active"
          + (f", mean regret {res['mean_active_regret']:+.3f}" if res.get("mean_active_regret") is not None else "")
          + f"; {res['graduated_total']} graduated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
