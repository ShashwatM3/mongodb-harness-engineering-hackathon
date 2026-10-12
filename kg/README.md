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

**What `suggest(V)` returns:** one untested setting per lever group, in section C's order, then the groups' second settings, so a round never spends every proposal on one group. Section C marks a setting as inert when every value tried on this brain changed no zone on any seed, and lists values rejected on earlier brains or superseded by a promotion in a "tried before, no good" column; those are offered last.

**Repeats:** each call is its own Raindrop event, so when GEPA re-proposes a candidate it counts as `re_proposed`. If you call `record_proposal` directly, pass `attempt=` to separate several proposals in one round. Without it, the same `(round, policy)` counts as a retry.

**The gate:**

```python
gate.record_verdict(gid, "passed" | "rejected" | "needs_approval", reason)   # sends gate_passed / gate_failed once
gate.record_heldout(gid, "heldout-a", passed, {"M": 0.21})                   # numbers stay in heldout_results
gate.promote(gid, hypothesis)        # v(N+1); needs a passed/needs_approval verdict; refuses stale bases, other envs, unapproved locked edits
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
- A component that changes a setting needs `evidence.gate_run_id` naming a run the gate has passed (or marked `needs_approval`) on the latest brain, in the current runner env, with that same edit. `force=True` is the human override.
- A locked setting needs an approval.
- An active component with the same key at the same node is retired automatically. A compiled setting is flat for the engine, so a component that sets one also retires same-key components at deeper nodes under it (they would shadow it), and the commit is refused if the new component still would not take effect.
- Components that change no setting (context policies, tool grants, notes) commit freely.
- A pending `brain_versions` row older than five minutes is an abandoned commit (a gate process died mid-write): it is rolled back and the commit proceeds.

`promote()` is `commit_brain_version` built from a gate run.

```python
imp.history("sim.STAIR_MIN_LIFT_QUEUE")     # also: python -m kg history TARGET
# -> {versions: [{version, value, component_id, ...}], changes: [{version, from, to, gate_run_id, hypothesis, signal, ...}], markdown}
```

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

### The phone bridge to the Intervention Gateway (`kg/phone.py`)

The calls themselves come from the Intervention Gateway on branch `aseel-eleven-lab`. The KG decides when to call, right after the gate decides:
- **TwinForge flags the failure.** Each shift's failure list becomes one `episodes` document per failure.
- **The improver proposes the fix, and the gate decides it.**
- **Significant decisions ring the Robotics Lead:**
  - `needs_approval`: a locked setting. The call asks for the decision.
  - a promotion: the harness changed. The call says what failed and what changed.

  Rejected runs, and runs that passed but were not promoted, stay quiet. A promotion that the Lead just approved on a call doesn't ring again.

The Lead's decision comes back to `python -m kg phone-harness`, which is contract B to F of the gateway's `docs/HARNESS_CONTRACT.md`:
- **APPROVE** on a locked fix runs `record_approval`, then `promote`.
- **REJECT** blocks that value.
- **The Lead's words on REJECT or DEFER** become a preference (`save_preference`).
- **Questions and metrics** are answered from the gate run and its episodes.
- **A different value** asked for on the call is refused, because only the tested value can be approved.

`phone_calls` keeps every incident and decision. Like Raindrop, the phone is never on the critical path: if the gateway is down, the gate still decides and the call is marked `unreachable`.

```bash
# 1. the KG side the gateway talks to
KG_PHONE_HARNESS_TOKEN=<t2> python -m kg phone-harness --port 8799
# 2. the gateway (aseel-eleven-lab checkout); 8787 is the TwinForge runner, so use 8797
PORT=8797 HARNESS_MODE=http HARNESS_BASE_URL=http://127.0.0.1:8799 HARNESS_OUTBOUND_TOKEN=<t2> \
  HARNESS_TOKEN=<t1> MONGODB_URI=<a replica set> npm run dev
# 3. any gate client with these set calls the Lead: the demo, epochs, GEPA
export KG_GATEWAY_URL=http://127.0.0.1:8797 KG_GATEWAY_TOKEN=<t1> KG_PHONE_LEAD="Robotics Lead"
python -m kg demo --phone                       # the locked edit then waits for the call instead of auto-approving
python -m kg phone-call <gate_run_id>           # call about one existing needs_approval or promoted run
```

Without ElevenLabs, `npm run simulate:agent -- <incident_id> approve|reject|defer` on the gateway plays the voice agent over the same tool endpoints. `KG_PHONE=0` turns the calls off.

## For the demo

```bash
python -m kg demo --uri <local or demo cluster>    # the whole story on the fake runner, in ~3 s
python -m kg brain-context task:M:PICK
python -m kg explain rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2   # rule → clip → episodes → gate run
python -m kg lineage 4
python -m kg history sim.STAIR_MIN_LIFT_QUEUE   # one setting across every version, with the evidence behind each change
python -m kg snapshot 4 --compare-to 1     # nodes/links JSON for React Flow or the diff viewer
python -m kg export 1 --out /tmp/v1.json   # the exact brain the runner gets
```

`gate.ablate(V, component_id)` returns brain V with one learned rule reverted to the value it replaced. That's doc 03's ablation, minus the engine-default leak.

## Go/no-go with the real runner (13:15-13:45)

1. Set `KG_RUNNER_URL`, and bump `KG_ENV_EPOCH` if WP-T retuned the stair costs. The env key changes, so fake and real results never mix.
2. Run `python -m kg check-v1 ../physical-ai/brains/v1.json`. It uses the runner's `/validate_brain`, or TwinForge's own compiler through tsx when no runner is set. If `ok` is false, the output lists every differing setting; fix them with `python -m kg seed --v1-brain ...` on a fresh database before any real round. At 2253f36 (plus the uncommitted WP-B files) it passes: both brains compile to `59d237854b19a5d2`.
3. Run `python -m kg sync-settings` to pull the runner's `GET /settings` into the envelope.
4. After the first real shifts, `kg.tools.checks.capped_report(kg)` lists failure types that hit 25 per seed. Show those flagged on screen.

## The adversary and epochs (document 07, idea 6)

A second agent writes disruption scripts (lift faults, people blocking zones, task bursts) on which the current brain does much worse than some other known brain. Accepted scripts form a curriculum, and a scenario graduates once a promoted brain handles it. `kg/adversary.py` is the adversary, and `kg/epoch.py` alternates it with an improver step and the gate.

It needs a runner with WP-C2 (TwinForge branch `hackathon/wp-c2`), which takes `scenario_script` and serves `/validate_scenario` and `/scenario_envelope`. Scripted runs get their own env (`scenario_profile` is `script:<hash>`), so they never mix with standard-profile results.

```bash
export KG_RUNNER_URL=http://localhost:8788                     # a TwinForge runner with WP-C2
python -m kg adversary context                                 # what the proposer sees for the latest brain
python -m kg adversary turn                                    # Claude proposes 4 scripts; each is scored and judged
python -m kg adversary turn --proposer random                  # the no-LLM baseline
python -m kg adversary turn --proposer hand --script s.json    # [{"script": [...], "rationale": "..."}]
python -m kg adversary show | curriculum | trace               # scenarios, the active ones, the chart's numbers
python -m kg adversary graduate 2                              # after promote(): re-score the active scenarios
python -m kg adversary replay sc-<hash>                        # TwinForge's compare.html URL: v1 and v2 on that script
python -m kg epoch --epochs 3 --improver claude                # improver step, gate, graduation, adversary turn
                                                               # (on the real `kg` database it needs --real: it promotes)
python -m kg adversary stress                                  # at go/no-go: the stress set, against v1
python -m kg adversary stress-report 1 5                       # once, at the end: v1 and v5 on the stress set
```

**How a scenario is judged.** Every brain runs the same script on the same 12 training seeds. Regret is the best alternative brain's score minus the current brain's, where a score is the mean of the pooled zone scores. The alternatives are v1, the previous version and the WP-T sweep's best variants: at most 3, deduplicated by patch hash. The thresholds come from TwinForge's `npm run -s scenarios` (physical-ai README, WP-C2 section). With no disruption at all, "regret" is already about +0.012 on 12 seeds.

| Status | Rule |
|---|---|
| `invalid` | the runner's envelope refuses it (`kg.adversary.check_script_local` is the same check, for runners without the endpoint) |
| `cached` | this script was already measured against this brain (a `re_proposed` signal) |
| `impossible` | no brain scores 0.35 on it |
| `too_easy` | regret below 0.02, or the best alternative ahead on fewer than 8 of 12 seeds, or the current brain scores *no lower* than on a quiet shift. That last rule exists because a person blocking a zone raises scores in this twin: robots with no path work where they stand. |
| `accepted` | otherwise. It joins the curriculum, which holds at most 6; the lowest regret is `displaced`. |
| `graduated` | an active scenario whose regret against a newly promoted brain is below 0.01 |

**The epoch gate** promotes a candidate only if it improves the curriculum on the validation seeds and doesn't drop the standard profile there by more than 0.01. Candidates come from `SuggestImprover` (the KG's section C) or `ClaudeImprover` (`get_context` plus the curriculum's scripts, never the alternative brains). GEPA can replace both: anything with `candidates(kg, V, curriculum, k)` works.

**The proposers** call Claude through `claude -p` on the logged-in subscription: no tools, `--safe-mode`, structured output, and a temporary working directory, so no project files are read. The model is `KG_ADVERSARY_MODEL` or `KG_IMPROVER_MODEL`, default `claude-opus-5-5`, with effort `high`. The proposer only sees `get_adversary_context()`: the current brain on a quiet shift and on the standard profile, the alternatives' settings, the curriculum, its last 10 scenarios with their outcomes, and the runner's rules. Tune the judge with `KG_ADV_SEEDS`, `KG_ADV_ACCEPT_REGRET`, `KG_ADV_AGREE_FRAC`, `KG_ADV_FLOOR`, `KG_ADV_GRADUATE_REGRET`, `KG_ADV_CAP`, `KG_ADV_M` and `KG_ADV_REQUIRE_HARM=0`.

**Collections.**
- `scenarios`: one document per distinct script, with every evaluation, the regret history and each proposal.
- `adversary_turns`: one per turn or graduation, with the proposer's raw output and the prompt.
- `epochs`: one per epoch.
- `heldout_stress`: the stress set and its reports. It is gate-only and never cached by the runner. Its own seeds are in `heldout_seeds` under the id `stress`.

The improver role gets `find` on the first three. On Atlas that is one role update per database, run by a Project Owner (`IMPROVER_PRIVILEGES` in `db.py` only drives self-managed MongoDB and `atlas-commands`):

```bash
atlas customDbRoles update kgImprover --append --privilege 'FIND@kg.scenarios,FIND@kg.adversary_turns,FIND@kg.epochs' --projectId <PROJECT_ID>
```

**Raindrop.** Each proposed or re-scored scenario is one `adversary_scenario` event, from user `kg-adversary`. It carries `against_version`, never `brain_version`, so it can't fall into the v1-vs-vN Experiment's cohorts. Its signals are `scenario_accepted` and `scenario_graduated` (POSITIVE), and `scenario_too_easy`, `scenario_impossible`, `scenario_invalid` and `re_proposed` (NEGATIVE). Gate runs measured on a script send their evaluation events to the dev project only.

## Tests

```bash
kg/tools/test_mongo.sh                       # MongoDB 7.0 in Docker on 127.0.0.1:27027
kg/.venv/bin/python -m pytest kg/tests -q    # ~20 s
```

To test against Atlas instead, set `KG_TEST_GATE_URI` and `KG_TEST_IMPROVER_URI` (use database `kg_test`); `test_mongo.sh` isn't needed then. On this team's laptops, MongoDB 8.x won't run under Linux kernels 6.19 and newer (SERVER-121912), hence 7.0 locally.

`kg/tools/make_fixtures.sh` regenerates `tests/fixtures/` from TwinForge's `fakeRunShift`. The fake only reads `sim.STAIR_MIN_LIFT_QUEUE`, so one fixture per threshold serves any brain.

`kg/tools/sim_runner.py` is a synthetic twin with a known ground truth (several settings matter, a retune changes the spec_hash, unapproved locked edits get a 422). `kg/tests/test_simulation.py` drives the whole loop on it: promotions with evidence, rejections, stale and abandoned work, a world change and the revert, held-out failure, racing promotions, and eight rounds driven only by `suggest()` that must converge on the known optimum. What it found, what was fixed and what is left is in `kg/tests/simulation-findings.md`.

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
