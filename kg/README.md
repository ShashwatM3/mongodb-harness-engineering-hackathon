# kg: the robot brain as a knowledge graph in Atlas

The KG stores the robot brain and everything the harness learns about it. It covers:
- the site → zone → task skeleton and the four component kinds;
- `since`/`until` versions;
- the evidence behind each change: evaluations, shifts, failure episodes and habits;
- the held-out firewall.

The design is `reference/kg-implementation-plan.md` (outside this repo), which implements `SCRATCHPADS/brain-hierarchical-knowledge-graph.md`. The supervisor-facing calls follow `SCRATCHPADS/interface-contracts.md`. `SCRATCHPADS/knowledge-graph-info-packet.md` is the long-form guide.

**The rules it enforces:**
- The gate decides; the KG records and recommends.
- The runner only ever receives `export_brain(V)`.
- Held-out results never reach a collection the improver can read.
- Raindrop is never on the critical path.

## Setup

```bash
# from the team repo root, Python 3.11
uv venv kg/.venv --python 3.11
uv pip install -p kg/.venv --exclude-newer 2026-10-04 -r kg/requirements.txt
```

**Atlas (once, needs a Project Owner).** Atlas refuses `createUser`/`createRole` over a driver connection, so create the improver role and both users with the Atlas CLI. On M0 and Flex, roles take about 30 s to apply.

```bash
kg/.venv/bin/python -m kg atlas-commands --project-id <PROJECT_ID>   # prints the three commands
export KG_MONGODB_URI_GATE='mongodb+srv://gate:<pw>@<cluster>/?retryWrites=true'
export KG_MONGODB_URI_IMPROVER='mongodb+srv://improver:<pw>@<cluster>/?retryWrites=true'
kg/.venv/bin/python -m kg setup        # collections, indexes, seed; checks the improver can't read heldout_results
```

The MongoDB MCP server can create users (`atlas-create-db-user`), but it can't create custom roles.

**Other environment variables** (all are listed in `kg/config.py`):
- `KG_DB`: database name, default `kg`.
- `KG_ENV_EPOCH`: bump it whenever WP-T retunes the stair costs.
- `KG_RUNNER_URL`: the real runner.
- `RAINDROP_WRITE_KEY`.
- `RAINDROP_QUERY_API_KEY`: for `get_signals` only. A Query API key from auth.raindrop.ai/org/api_keys, not the write key.
- `TWINFORGE_DIR`: the physical-ai checkout, for the fake runner.

## Two clients, two roles

```python
import kg
imp  = kg.connect("improver")   # GEPA side: proposals, shifts, context, suggestions, brain reads
gate = kg.connect("gate")       # gate side: verdicts, promotion, held-out, approvals, preferences, seed
```

What each user can do:

| Collection | improver | gate |
| --- | --- | --- |
| `brain_nodes`, `brain_versions`, `envelope`, `concepts`, `playbook` | find | readWrite |
| `gate_runs`, `shifts`, `episodes` | find, insert, update | readWrite |
| `brain_reads` (dashboard feed) | find, insert | readWrite |
| `heldout_results`, `heldout_seeds` | **nothing** | readWrite |

Only the gate client writes the brain, and only through `commit_brain_version`. The improver has no remove privilege anywhere. If an LLM agent (the supervisor) uses gate-side tools, give it functions, not a raw query tool on the gate client.

With no runner given, `connect()` uses `KG_RUNNER_URL`. Without that it falls back to TwinForge's fake runner through tsx, then to the saved fixtures.

## Wiring the evaluator (Person B)

```python
p = imp.record_proposal(V, candidate, origin={"source": "gepa"}, round=r, policy="p1", split="train")
result = imp.evaluate(p)        # runs what's missing (base and/or candidate), calls record_shifts, returns numbers
# p.status: "new" (it ran), "cached" (already measured: no runner call), "invalid" (refused: p.reason)
# p.locked_edits: a locked setting; evaluate() runs it with allow_locked, the gate decides needs_approval
side_info = imp.get_context(V)["markdown"]    # sections A-C for GEPA's reflection
```

**What a candidate can look like:** `{target: value}`, `[{target, value}]`, `{"edits": [...]}`, a whole brain, or JSON text of any of those. Omitted settings keep their base value; they never fall back to the engine default.

**Running the twin yourself:** run `p.brain` (and `p.base_brain` when `p.need_base` is set), then call `imp.record_shifts(response, "train", gate_run_id=p.gate_run_id, side="cand")`.

**GEPA:** `kg/gepa_adapter.py` has `make_evaluator` (single-task mode) and `make_batch_evaluator` (generalization mode). Each measures a candidate once per split.

**Repeats:** each call is its own Raindrop event, so when GEPA re-proposes a candidate it counts as `re_proposed`. If you call `record_proposal` directly, pass `attempt=` to separate several proposals in one round. Without it, the same `(round, policy)` counts as a retry.

**The gate:**

```python
gate.record_verdict(gid, "passed" | "rejected" | "needs_approval", reason)   # sends gate_passed / gate_failed once
gate.record_heldout(gid, "heldout-a", passed, {"M": 0.21})                   # numbers stay in heldout_results
gate.promote(gid, hypothesis)        # v(N+1); refuses stale bases and unapproved locked edits
gate.record_final(N, passed, zone_delta)   # after the freeze: the final seed set, v1 against vN
```

Never pass held-out per-seed results to the KG: `record_shifts` refuses any split except train and val, and on the gate client it also refuses seeds listed in `heldout_seeds`.

## The supervisor's calls (interface-contracts.md)

```python
gate.get_brain_context("task:M:PICK", version=None)
# -> {version, scope, components: [{kind, key, when, then, since, until, evidence, _id, label, compiles_to}]}
# Also logs the read to brain_reads, which the dashboard can watch to light up the nodes.

gate.commit_brain_version(add=[{kind, parent_id, key, ...}], retire=[ids], evidence={habit_id, episode_ids, signal, gate_run_id})
# -> {version, added, retired, approvals}
```

`commit_brain_version` writes with insert-many and update-many, never `$merge`/`$out`. It enforces the following:
- A component that changes a setting needs `evidence.gate_run_id` naming an evaluated, non-rejected run on the latest brain with that same edit. `force=True` is the human override.
- A locked setting needs an approval.
- An active component with the same key at the same node is retired automatically.
- Components that change no setting (context policies, tool grants, notes) commit freely.

`promote()` is `commit_brain_version` built from a gate run.

```python
imp.get_signals("sh-...")     # also: python -m kg signals SHIFT_ID [--json]
# -> {shift, gate_runs, events, categories: {gate, hard_metrics, self_diagnostics, other}, error, markdown}
```

Raindrop events are per proposal, not per shift, so `get_signals` goes shift → the gate runs that used it (base or candidate side) → their `candidate_brain` events → the signals Raindrop matched on them. Events that carry a `shift_id` property (worker agents, Self Diagnostics) match directly. It reads the project the sink writes to (`kg-dev` for fake-runner runs) and drops events whose `split` or `seed_set` is anything but train or val. If Raindrop is unreachable, the result carries `error` and nothing is raised.

## The phone call (Person C)

```python
gate.record_approval("class.HUM-1.max_speed", 1.35, "approve" | "reject", by="Robotics Lead", ref="call:<id>")
# -> {ready_to_promote: [gate_run_ids], rejected: [...]}   then the gate calls promote()
gate.save_preference("Never send a loaded robot up the stairs at lunch", by="Robotics Lead", ref="call:<id>")
# -> a new brain version with a non-compiling rule; pending gate runs stay promotable (same patch)
gate.current_scores()                        # per-zone scores for get_current_scores (training seeds only)
gate.add_habit("habit:...", text, clip={"uri", "t0", "t1"}, steps=[...], lever_group=..., applies_to=["zone:M"])
gate.get_playbook("task:M:PICK")              # habits for a node, best evidence first
```

The playbook's `helpful`/`harmful` counters belong to the KG. Every verdict on a run whose `origin.ref` is a habit updates them.

## For the demo

```bash
python -m kg demo --uri <local or demo cluster>    # the whole story on the fake runner, in ~3 s
python -m kg brain-context task:M:PICK
python -m kg explain rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2   # rule → clip → episodes → gate run
python -m kg lineage 4
python -m kg snapshot 4 --compare-to 1     # nodes/links JSON for React Flow or the diff viewer
python -m kg export 1 --out /tmp/v1.json   # the exact brain the runner gets
```

`gate.ablate(V, component_id)` returns brain V with one learned rule reverted to the value it replaced. That's doc 03's ablation, minus the engine-default leak.

## Go/no-go with the real runner (13:15-13:45)

1. Set `KG_RUNNER_URL`, and bump `KG_ENV_EPOCH` if WP-T retuned the stair costs. The env key changes, so fake and real results never mix.
2. Run `python -m kg check-v1 ../physical-ai/brains/v1.json`. It uses the runner's `/validate_brain`, or TwinForge's own compiler through tsx when no runner is set. If `ok` is false, the output lists every differing setting; fix them with `python -m kg seed --v1-brain ...` on a fresh database before any real round. At 2253f36 (plus the uncommitted WP-B files) it passes: both brains compile to `59d237854b19a5d2`.
3. Run `python -m kg sync-settings` to pull the runner's `GET /settings` into the envelope.
4. After the first real shifts, `kg.tools.checks.capped_report(kg)` lists failure types that hit 25 per seed. Show those flagged on screen.

## Tests

```bash
kg/tools/test_mongo.sh                       # MongoDB 7.0 in Docker on 127.0.0.1:27027
kg/.venv/bin/python -m pytest kg/tests -q    # ~8 s
```

To test against Atlas instead, set `KG_TEST_GATE_URI` and `KG_TEST_IMPROVER_URI` (use database `kg_test`); `test_mongo.sh` isn't needed then. On this team's laptops, MongoDB 8.x won't run under Linux kernels 6.19 and newer (SERVER-121912), hence 7.0 locally.

`kg/tools/make_fixtures.sh` regenerates `tests/fixtures/` from TwinForge's `fakeRunShift`. The fake only reads `sim.STAIR_MIN_LIFT_QUEUE`, so one fixture per threshold serves any brain.

## Where the code differs from the plan, on purpose

- **The improver writes `gate_runs`, `shifts` and `episodes`.** The plan's table says read-only, but `record_proposal` and `record_shifts` run on the evaluator side, which holds only the improver client.
- **The improver has no write access to `brain_nodes`.** The plan allows insert and update. The interface contract makes `commit_brain_version` (gate) the only brain write, and the extra privileges would let the improver retire history.
- **There is an extra verdict, `passed`.** It means passed but not promoted, which `suggest()` lists.
- **Brain v1 has two components, not one per setting.** It sets exactly the settings whose v1 differs from the engine default: the stair threshold (0 → 99) and `max_speed` (1.5 → 1.2). That keeps the plan's guard against engine defaults leaking in, and it makes `export_brain(1)` compile to the same patch hash as `brains/v1.json`, which the plan's go/no-go requires. `seed(v1_brain=path)` takes v1 from that file verbatim. The envelope and the lever tree still list every setting.
- **The registry mirrors TwinForge's `src/harness/settings.ts`, not the plan's draft table.** That means capacities for every zone, `sim.MIN_SEP` as fixed, its ranges, and its whole-number flags. `sync_settings()` replaces the registry with `GET /settings` once the runner serves it.
- **The concept ontology has 53 documents, not "about 40".**
- **Components carry `when`/`then` next to `compiles_to`.** `when`/`then` are for people and agents; only `compiles_to` runs on the engine.
- **The stale-base check compares patch hashes, not version numbers.** So a saved preference doesn't invalidate pending runs.
- **Some fields and collections are additions:** `brain_versions.status` (pending/committed), `gate_runs.env_key`, `hash_source`, `gate_decision`, `context`, and the `brain_reads` collection.
- **Patch hashes computed locally use the runner's own scheme** (SHA-256 of key-sorted compact JSON, 16 hex characters). So `brain_versions.patch_hash` matches what the runner and the replay HUD show. The env key still keeps fake and real results apart.
- **The env key uses the runner's `spec_hash`** when `/health` reports one (the contract gained it at 2253f36); `KG_ENV_EPOCH` only applies to runners without it.
