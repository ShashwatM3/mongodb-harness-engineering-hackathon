# Knowledge Graph Info Packet

October 11, 2026, as of about 12:25 PDT · Owner: Prithviraj (knowledge graph) · Code: `kg/` in this repository

This packet describes the structure of the knowledge graph (KG) as it is built in `kg/` today, so every teammate can work against the same picture. It builds on [`brain-hierarchical-knowledge-graph.md`](brain-hierarchical-knowledge-graph.md) and keeps its design; section 12 lists exactly what was kept, added and changed. Section 11 maps the KG onto [`interface-contracts.md`](interface-contracts.md) and iteration 03. This is a focused artifact, not an iteration round, so it does not override any iteration.

**If anyone else is building the brain collections in Atlas in parallel, align on this packet first.** Two writers with different document shapes in the same database would collide, and the shapes below are already built.

Two labels are used throughout:
- **Built** means the code for it exists in `kg/`.
- **Needs team nod** means it changes or extends the brain graph document or touches someone else's work, so it stays a proposal until the team agrees (section 13).

This packet was written from reading the code. It has not been run against a live Atlas cluster by the author of this packet, and the tests in `kg/tests/` were not run as part of writing it, so "built" does not mean "verified end to end".

TwinForge, used below, is the warehouse digital twin the team built before the hackathon and is reusing here only as the simulation environment. The KG reaches it only through its runner's HTTP contract.

---

## Read this first

| You are | Read | Then |
| --- | --- | --- |
| Person B (gate and GEPA improver) | 1, 2, 5, 6, 7, 8 | Wire the evaluator and gate calls in section 7.3. Hold two clients. Never send held-out per-seed data to the KG. |
| Person C (clips, ElevenLabs, Raindrop) | 1, 4.2 (playbook), 6.3, 9, 10 | Write habits through `add_habit`, attach failure signals to the KG's `event_id`, and route the call's answer to `record_approval`. |
| Shashwat (TwinForge, dashboard) | 1, 10, 11 | Runner endpoints and hashes the KG depends on, and the node-light-up event for the dashboard. |
| Whoever builds the supervisor's tools or the ElevenLabs call | 1, 7, 11 | Use the wrappers in 11.1 for `get_brain_context` and `commit_brain_version`, and call `record_approval` with the call's answer (6.3). |
| Everyone | 1, 12, 13 | Answer the decisions in section 13. |

---

## 1. The KG in one page

The KG is where the robot's brain lives and where everything the harness learns about that brain is recorded. It is a MongoDB Atlas database accessed through a Python package, `kg/`.

**What it stores**
- A **hierarchical graph of the brain**: one site, four zones, sixteen task nodes (21 skeleton nodes), with brain components hanging below them.
- **Components**: today, rules and guardrails that each compile to one typed setting edit the TwinForge runner understands.
- **Versions**: components are never edited. Each has `since` and `until`, so brain version N is every component active at N, and old brains replay exactly.
- **Evidence**: every evaluation of a candidate brain, with the raw per-seed results and failure episodes behind it, so any rule can be explained from rule to clip to failures to gate result.
- **A concept ontology**: 48 small documents (failure types, where time goes, what can be changed) that order what the improver should try next.

**What it does**
1. **Record** every evaluation exactly, with where it came from.
2. **Order what to test next.** The improver gets the whole evidence table for the current brain, grouped and ordered by the ontology.
3. **Explain** any rule on stage.

**Numbers**

| Thing | Count |
| --- | --- |
| Skeleton nodes (1 site, 4 zones, 16 tasks) | 21 |
| Baseline (v1) components (15 rules, 4 guardrails) | 19 |
| Settings in the registry (15 editable, 4 locked, 1 fixed, 3 spec) | 23 |
| Concept documents (failure 12, time 9, outcome 3, lever 24) | 48 |
| Collections | 10 |
| Database users | 2 (`gate`, `improver`) |

---

## 2. Boundary rules

These four rules hold everywhere in the code.
1. **The gate decides; the KG records and recommends.** The KG never promotes a brain on its own. `promote()` is callable only by the gate client.
2. **The brain the runner receives is a projection of the KG** (`export_brain`). Nobody hand-builds a `Brain` JSON.
3. **Held-out data never enters a collection the improver can read.** The KG does not receive held-out per-seed results at all (section 5).
4. **Raindrop is not on the critical path.** The KG learns from the gate's numbers directly. Raindrop measures the KG and shows the trend. Every Raindrop call is wrapped so a failure cannot break the loop.

---

## 3. The structure of the graph

### 3.1 The scope skeleton

Written once by `seed()`, never changed by the improver. Skeleton nodes and components are both documents in `brain_nodes`, told apart by `kind`.

```
site:main                                   kind "site"   (the whole warehouse)
 |-- zone:B                                 kind "zone"
 |    |-- task:B:PICK  task:B:REPLENISH  task:B:TRANSPORT  task:B:RETURN
 |-- zone:C   (stairwell sits here)         kind "zone"
 |    |-- task:C:PICK  task:C:REPLENISH  task:C:TRANSPORT  task:C:RETURN
 |-- zone:D
 |    |-- task:D:PICK  ...
 |-- zone:M   (mezzanine, lift or west stairs)
      |-- task:M:PICK  task:M:REPLENISH  task:M:TRANSPORT  task:M:RETURN
```

- Every node except the site has exactly one `parent_id`. That is the only structural edge, so it stays a tree. All other relationships are plain references (3.6).
- Skeleton documents carry `kind`, `parent_id`, `label`, `order`, plus `zone` and `task_type` where they apply.
- **Zone C is an addition to the brain graph document** (which had zones B, D and M, 16 nodes). The stairwell sits in zone C, so stair changes show up there first. Needs team nod (D1).

### 3.2 Components: the four kinds

The brain graph document's four kinds are all defined, but only two are populated.

| Kind | Meaning | Status |
| --- | --- | --- |
| `rule` | A behaviour the robots follow. Here: an **editable** setting. | Built. 15 baseline rules. |
| `guardrail` | A limit the engine enforces. Here: a **locked** setting that needs a human approval to change. | Built. 4 baseline guardrails. |
| `context_policy` | What memory the agent sees at an exception point. | Kind reserved. Nothing creates one yet. Depends on D2. |
| `tool_grant` | Whether the agent may use a named tool. | Kind reserved. Nothing creates one yet. Depends on D2. |

A rule or guardrail carries `compiles_to`, the runner's own typed edit: `{op: "set", target, value}`. A free-text `when/then` on its own cannot run, so every component the engine acts on has this field. On export it becomes the node's `body`, and the runner compiles it into its settings patch (`sim`, `classes`, `zones`; `assign.W_*` compile to `sim.W_*`).

### 3.3 Where components attach: at `site:main`

The brain graph document lets components attach at site, zone or task level. **Today every component attaches at `site:main`**, including everything `promote()` creates (needs team nod, D3). The reason: the runner applies every setting fleet-wide. A rule attached to `task:M:PICK` would tell judges the change is scoped to zone M's picks when the engine applies it everywhere.

Where the problem was seen is recorded in `evidence.observed_at` (for example `zone:M`). If zone-scoped edits land in the engine later (a stretch item), components can attach lower with no schema change: the loader and the compiler mirror already apply "deeper wins".

### 3.4 Keys, precedence, and the v1 baseline

- **`key` equals the setting target** for rule and guardrail components (for example `sim.STAIR_MIN_LIFT_QUEUE`), with a readable `label`. So the brain graph document's "two components with the same key: the deeper one wins" is identical to the compiler's "same target: the deeper node wins". A tie goes to the later node, mirroring TwinForge's `fake.ts`.
- **The envelope still wins over any component.** It holds each setting's min, max, v1 and status plus approval history (section 4.2).
- **Every setting the brain may carry gets a v1 baseline component**, at `site:main` with `since: 1`. 19 in total. Without them, a setting missing from the brain falls back to the engine default, and that is wrong in two ways:
  - `sim.STAIR_MIN_LIFT_QUEUE` would become 0 (always take the stairs) instead of v1's 99 (never).
  - An unapproved `class.HUM-1.max_speed` would be rejected with a 422.
  The fake runner hides both problems, which is why the baseline is explicit.
- Of the 19 baseline components, 17 are *levers* (the brain can change them). Two are baseline only: `class.HUM-1.capacity` (range fixed at 1) and `sim.MIN_SEP` (range fixed at 0.9).

### 3.5 Versions: `since` and `until`

- A component is active at version V when `since <= V` and (`until` is null or `until > V`). This is the filter in the brain graph document's pipeline.
- `promote(gate_run_id)` creates version N+1: it adds a component per edit (`since: N+1`), retires the replaced component at the same node and key (`until: N+1`), and writes the `brain_versions` document. Nothing is edited in place.
- **Replay** is the same loader with V set to the old version. **Compare** v1 with v3 is `graph_snapshot(3, compare_to=1)`. **Ablation** (remove one learned rule, show the score falls) is `ablate(V, component_id)`, which reverts the key to the component it replaced. A plain exclude would let the engine default leak in instead.
- Version numbers are claimed by inserting the `vN` document first with `status: "pending"`, then flipped to `"committed"`. `latest_version()` ignores pending ones. If the candidate was evaluated against a base that is no longer the latest, `promote` raises `StalePromotion`: re-evaluate on the latest brain.

### 3.6 Evidence: the extra graph edges

The `parent_id` links form a tree. Each component's `evidence` field holds references that turn it into a graph. They are followed only when someone asks for an explanation, so they never slow brain loading.

```
evidence: {
  gate_run_id:  "gr-…",                       the evaluation that proved it
  signal:       "LIFT_QUEUE_JAM",             the failure type the edit reduced most
  episode_ids:  ["ep:sh-…:LIFT_QUEUE_JAM:4120", …],   up to 10 failures of that type on the base brain
  observed_at:  "zone:M",                     where it was seen (an addition to the brain graph document)
  origin:       "habit",                      who proposed it: gepa, habit, sweep, suggestion
  habit_id:     "habit:skip-lift-when-queued" only when the proposal came from a playbook habit
}
```

Baseline components carry `{origin: "baseline"}` instead.

`explain(component_id)` walks it in one aggregation: component, then the playbook habit and its clip timestamps, then the episodes, then the gate run, then the version's `heldout_passed`. That is the brain graph document's four-hop click path, and it returns both structured data and a short markdown summary for the screen.

### 3.7 The concept ontology

Two hierarchies live side by side. **Scope** (3.1) says where a component applies. **Concepts** say what went wrong, where time goes, and what can be changed. They are static documents in `concepts`, seeded once.

| Tree | Documents | Contents |
| --- | --- | --- |
| failure | 12 | 4 groups, 7 leaves (the runner's failure types) |
| time | 9 | productive (`travel`, `pick_drop`) and non-productive (`lift_wait`, `blocked`, `stairs`, `lift_ride`) |
| outcome | 3 | late and dropped counts in the worst zone |
| lever | 24 | 6 groups, 17 leaves (every setting the brain can change) |

The failure groups and leaves, the six time states and the two outcome leaves carry `candidate_lever_groups`, the lever groups most likely to help (empty for the two productive time states). The full tree is in Appendix B.

**How it is used.** Section C of `get_context` (section 8) orders untested settings by:
1. the worst zone's largest non-productive time state, then
2. that zone's late and dropped counts, then
3. the top failure group.

`lift_ride` never ranks ahead of `lift_wait`, because riding the lift is an unavoidable cost of changing floors.

**The `yielding` lever group is empty on purpose.** No setting expresses "give way to another robot". A habit from the clips that lands there is a *capability gap*: the robot cannot express that behaviour yet. That is a result worth showing, not a defect to hide.

### 3.8 The settings registry

The registry is the list of what the brain may change. Each setting has a status that decides what happens when the brain edits it:

| Status | Meaning | Count |
| --- | --- | --- |
| `editable` | The brain may set it within [min, max]. | 15 |
| `locked` | Differs from v1 only with a human approval (the phone call). | 4 |
| `fixed` | Locked and never approvable. Any edit is rejected. | 1 |
| `spec` | Describes the building or robot. Never set by the brain. | 3 |

Until the runner serves `GET /settings`, the registry is a static table copied from TwinForge's humanoid overlay. `sync_settings()` replaces it with the runner's own registry once that endpoint exists, refreshes the envelope bounds and lever leaves, and reports every difference. It never touches existing components, because they are history. The full table is Appendix A. Two bounds (`sim.PERC_STOP` max 3.0 and `sim.PERC_SLOW` max 5.0) are placeholders until `/settings` settles them.

---

## 4. Collections and document shapes

### 4.1 The ten collections

| Collection | Holds | Written by | Improver access | Ring |
| --- | --- | --- | --- | --- |
| `brain_nodes` | The skeleton plus all components, versioned | KG: `seed`, `promote` (gate) | find, insert, update | 0 |
| `brain_versions` | One document per version | KG: `seed`, `promote`, `record_heldout`, `record_final` (gate) | find | 0 |
| `envelope` | Bounds, status and approval history per setting | KG: `seed`, `sync_settings`, `record_approval` (gate) | find | 0 |
| `concepts` | The ontology | KG: `seed` | find | 0 |
| `gate_runs` | One per evaluated candidate | KG: `record_proposal`, `record_shifts`, `record_verdict`, `promote` | find, insert, update | 1 |
| `shifts` | Raw per-seed result for training and validation seeds | KG: `record_shifts` | find, insert, update | 1 |
| `episodes` | One per failure entry, derived from `shifts` | KG: `record_shifts` | find, insert, update | 1 |
| `playbook` | Human habits from the clips, plus helpful/harmful counters | Person C's pipeline via `add_habit`; KG updates counters | find | 2 |
| `heldout_results` | Held-out verdict per (gate run, seed set) | KG: `record_heldout` (gate) | **none** | 2 |
| `heldout_seeds` | The locked test seeds and the `final` set | Gate owner | **none** | gate owner |

### 4.2 Document shapes

Skeleton node:
```
{ _id: "task:M:PICK", kind: "task", parent_id: "zone:M", zone: "M", task_type: "PICK",
  label: "PICK in zone M", order: 130 }
```

Component (a v1 baseline):
```
{ _id: "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1", kind: "rule", parent_id: "site:main",
  key: "sim.STAIR_MIN_LIFT_QUEUE",
  label: "Take the stairs only when 99+ wait for the lift (never)",
  compiles_to: { op: "set", target: "sim.STAIR_MIN_LIFT_QUEUE", value: 99 },
  lever: "c:lever/floor_change/sim.STAIR_MIN_LIFT_QUEUE",
  since: 1, until: null, evidence: { origin: "baseline" }, origin: { source: "baseline" } }
```
Component ids are `<kind>:<target>@<parent_id>:v<since>`. The brain graph document's examples used short ids such as `rule:014`; the readable form makes the data explorer self-explanatory.

`brain_versions`:
```
{ _id: "v3", version: 3, parent: "v2", status: "committed",
  added: ["rule:…:v3"], retired: ["rule:…:v2"], hypothesis: "…",
  promoted_by: "gr-…", patch_hash: "kg-…", approvals: [],
  scores: { train: { A: 0.81, M: 0.60 }, val: { … } },
  heldout_passed: true,      // true, false or null (not recorded). A boolean only; the numbers are in heldout_results.
  final: null }              // set once after the freeze: { vs, seed_set, passed, zone_delta, at }
```

`gate_runs` (one per evaluated candidate; the brain graph document's `gate_run_id` points here):
```
{ _id: "gr-…", base: "v2", base_version: 2, base_patch_hash: "…", cand_patch_hash: "…",
  edits: [ { target: "sim.STAIR_MIN_LIFT_QUEUE", value: 2, base_value: 99, scope: "fleet",
             lever_group: "floor_change" } ],
  origin: { source: "gepa" | "habit" | "sweep" | "suggestion", ref: null | "habit:…" },
  split: "train" | "val",
  env: { engine_sha, spec_id, spec_hash_or_epoch, ticks, profile, seeds: [101, …] },
  env_key: "env-…", hash_source: "runner" | "local",
  locked_edits: [], warnings: [],
  shift_ids: { base: […], cand: […] },
  zones: { M: { base, cand, delta, seeds_better, seeds_worse } },
  outcomes, time_split, failures: { LIFT_QUEUE_JAM: { base: 22, cand: 6 } }, fleet,
  context: { worst_zone, worst_score, time_state, late_dropped, failure_group },
  verdict: "invalid" | "evaluated" | "passed" | "needs_approval" | "rejected" | "promoted",
  reason, promoted_to, gate_decision, hypothesis,
  events: [ { event_id, round, policy, origin, at, signals_sent: […] } ] }
```

`shifts`: `{ _id: "sh-…", env_key, env, patch_hash, seed, split, brain_version, result: <the runner's SeedResult, unchanged>, warnings, recorded_at }`. The raw result is kept so later phases can recompute things (for example, which scenario was active during a failure) without re-running the twin.

`episodes`: `{ _id: "ep:<shift_id>:<TYPE>:<tick>", shift_id, env_key, patch_hash, seed, split, type, zone, tick, robots, detail, task_id, capped }`. `capped` is true when the runner cut that failure type at 25 entries for the seed (the per-entry list then undercounts).

`envelope` (one per setting, `_id` is the setting target):
```
{ _id: "class.HUM-1.max_speed", target, description, status: "locked", min: 0, max: 1.5, v1: 1.2,
  engine_default: 1.5, lever_group: "motion", note,
  approved_value: 1.2,
  approvals: [ { value: 1.35, decision: "approve", approved_by: "…", ref: "call:…", at: … } ] }
```

`playbook` (Person C's shape): `{ _id: "habit:skip-lift-when-queued", text, clip: { uri, t0, t1 }, steps: […], lever_group: "floor_change", helpful: 0, harmful: 0 }`. `add_habit` writes everything except the counters, which the KG owns.

`heldout_results`: `{ _id: "ho-…", gate_run_id, seed_set, passed, zone_delta: { M: 0.08 }, recorded_at }`.

`heldout_seeds`: the KG only reads this on the gate side, as a safety check, and expects documents with a `seeds` array (or a single `seed`). The gate owner creates them.

### 4.3 IDs are content hashes

Every id the KG mints is a hash of what the thing *is*, so recording the same evaluation twice lands on the same document.

| Id | Hash of |
| --- | --- |
| `env-…` (env key) | engine SHA, spec id, spec hash (or manual epoch), ticks, profile |
| `sh-…` (shift) | env key, patch hash, seed |
| `gr-…` (gate run) | env key, sorted seeds, base patch hash, candidate patch hash |
| event id (UUID-shaped, for Raindrop) | gate run, round, policy |
| `ep:…` (episode) | shift id, failure type, tick |

Consequences:
- A candidate evaluated twice is stored once. The second proposal returns status `cached` with the stored numbers.
- Results from different environments never mix. `record_shifts` raises `EnvMismatch` if a response's engine, spec, ticks or profile differ from the gate run's. This keeps fake and real runner results apart, and results from before and after a stair-cost retune apart.
- A re-run seed whose result differs from the stored one is reported as `nondeterministic` and logged, because the twin is supposed to be deterministic.
- Until the runner serves `/validate_brain`, patch hashes are computed locally by a mirror of the compiler and start with `kg-`. Once it does, the runner's hash is used, and a mismatch between what was proposed and what the runner ran raises an error.

### 4.4 Indexes

- `brain_nodes`: `{parent_id, kind, since}`, `{key}`
- `brain_versions`: `{version}`
- `gate_runs`: `{base_patch_hash}`, `{env.spec_hash_or_epoch}`, `{edits.target}`, `{env_key, base_patch_hash}`, `{cand_patch_hash}`
- `shifts`: `{env_key, patch_hash, split}`
- `episodes`: `{shift_id, type, zone}`
- `heldout_results`: `{gate_run_id}`

---

## 5. Permissions and the held-out firewall

MongoDB permissions apply to whole collections, so the data is split into collections by who may write it. There are two database users, and the KG opens one `MongoClient` per role.

| User | Privileges |
| --- | --- |
| `improver` (custom role `kgImprover`) | `find` on every collection except `heldout_*`. `insert` and `update` on `brain_nodes`, `gate_runs`, `shifts`, `episodes`. No `remove` anywhere. **Nothing at all on `heldout_results` and `heldout_seeds`.** |
| `gate` | `readWrite` on the database. |

The held-out firewall has five layers, so no single mistake breaks it:
1. **Database**: the improver user has no privileges on `heldout_*`. Privileges only add, so it simply never gets them. There is a probe, `probe_heldout_denied`, that confirms an "unauthorized" error.
2. **Code, on input**: `record_proposal` and `record_shifts` accept only `split="train"` or `"val"`, and raise otherwise. Held-out results never enter the KG.
3. **Code, on the gate side**: `record_shifts` refuses to store a shift for any seed listed in `heldout_seeds`.
4. **Code, on output**: `get_context` and every other view never read `heldout_*`, so none of them can leak a held-out seed or score.
5. **Shape**: `brain_versions` keeps only the boolean `heldout_passed`. The per-zone numbers go to `heldout_results`.

**Honest limits**
- Collection-level permissions cannot make a collection append-only. The improver has `update` on `brain_nodes`, `gate_runs`, `shifts` and `episodes`, so "history is never rewritten" is enforced by the KG code (writes use `$setOnInsert`, `promote()` is gate-only) and not by Atlas. In the current code the improver client never writes `brain_nodes`, so its `insert` and `update` there could be tightened to `find`. This follows the brain graph document's wording, and is worth revisiting.
- `brain_versions.final` holds the final-set verdict and zone deltas, and the improver can read it. It is written once, after the 14:30 freeze, when the improver loop has stopped.
- On Atlas, users and roles cannot be created by `createUser`/`createRole` over a driver connection (Atlas rolls them back). `kg.db.atlas_cli_commands()` prints the Atlas CLI commands instead. Roles take about 30 seconds to apply on M0 and Flex. Creating them needs Project Owner.
- **Managed MCP Server** (iteration 03). **Can a custom, collection-scoped role be assigned to it? No** (checked 2026-10-11 against MongoDB's docs and the Admin API schema). A Managed MCP configuration is granted Atlas *project roles* such as `GROUP_OWNER` or `GROUP_DATA_ACCESS_READ_ONLY`, not database roles, and its data access is at most project-wide: "Up to project-level dataplane access" ([overview](https://www.mongodb.com/docs/mcp-server/overview/), [access models](https://www.mongodb.com/docs/mcp-server/remote-mcp/access-models.md)). The create call (`POST /api/atlas/v2/groups/{groupId}/mcpConfigs`) takes only `mcpConfigName`, `roles` ("List of project roles") and `ipAccessList`. So an MCP configuration with data access can read `heldout_results` and `heldout_seeds`: no agent in the improver loop should get one. The gate keeps its native connection, any MCP configuration should be read-only, and the brain is never written through `aggregate` with `$merge` or `$out`.

---

## 6. How the loop runs through the KG

### 6.1 The lifecycle

```
 setup (gate)      seed()                    skeleton, concepts, envelope, 19 v1 components, brain_versions v1

 each candidate    record_proposal(base_V, candidate, origin, round, policy, split)      improver client
                      -> diffs the candidate against brain base_V into `edits`,
                         creates the gate run, returns Proposal{status: new | cached | invalid, brain, ...}
                   evaluate(proposal)        runs only what is missing on the runner
                      -> record_shifts(response, split)   writes shifts + episodes, fills the gate run's numbers
                   get_context(base_V)       what has been tried, what to try next

 gate decides      record_verdict(gate_run_id, "passed" | "rejected" | "needs_approval", reason)   gate client
                   record_heldout(gate_run_id, seed_set, passed, zone_delta)                        gate client
                   promote(gate_run_id, hypothesis)  -> brain version N+1                           gate client

 after the freeze  record_final(version, passed, zone_delta)                                         gate client
```

### 6.2 Verdicts

A gate run starts with no verdict, then moves through these states:
- `invalid`: refused at proposal time (unparseable, unknown setting, out of range, a spec or fixed setting, or a no-op). It never runs. A runner 422 also lands here.
- `evaluated`: the base and candidate numbers are filled in.
- `passed`, `rejected` or `needs_approval`: the gate's decision (`record_verdict`).
- `promoted`: a new version exists (`promote`).

`record_proposal` refuses only invalid candidates. A **locked edit is not refused**: it comes back in `locked_edits`, and the proposal asks the runner to simulate it anyway (`allow_locked`), so the call can quote the effect.

### 6.3 Locked settings and the phone approval

This is how a change that needs authority the robot does not have goes through:
1. The improver proposes, for example, `class.HUM-1.max_speed` 1.2 to 1.35. It is evaluated with `allow_locked`.
2. The gate records `needs_approval`.
3. The harness pauses, Agent Engine routes to human approval, and ElevenLabs phones the Robotics Lead.
4. The answer is routed to `record_approval(target, value, decision, by, ref)`.
5. **Approve**: the answer is written to `envelope.approvals`, and matching `needs_approval` runs come back as `ready_to_promote`. **Decline**: those runs become `rejected`.
6. `promote` then succeeds. Without an approval for that exact value it raises `NeedsApproval`. The approval is copied into `brain_versions.approvals` and travels with the exported brain, so the runner accepts it.

Approvals apply only to `locked` settings, and the value must lie inside the setting's [min, max]. No approval can move the envelope's bounds, and `fixed` settings are never approvable.

### 6.4 A worked example (values are illustrative, not measured)

In v1 the fleet never takes the stairs (`sim.STAIR_MIN_LIFT_QUEUE = 99`). Robots queue for the lift, and the jams show up in the `episodes` collection as `LIFT_QUEUE_JAM`, mostly in zone M. The improver proposes 2, from the habit "skip the lift when it is queued". The gate passes it and `promote` writes v2:

```
v1 component, retired:
{ _id: "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1", …, compiles_to: {…, value: 99}, since: 1, until: 2 }

v2 component, added:
{ _id: "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2", kind: "rule", parent_id: "site:main",
  key: "sim.STAIR_MIN_LIFT_QUEUE", label: "Take the stairs when 2+ robots wait for the lift",
  compiles_to: { op: "set", target: "sim.STAIR_MIN_LIFT_QUEUE", value: 2 },
  since: 2, until: null,
  evidence: { gate_run_id: "gr-…", signal: "LIFT_QUEUE_JAM", episode_ids: ["ep:sh-…:LIFT_QUEUE_JAM:4120", …],
              observed_at: "zone:M", origin: "habit", habit_id: "habit:skip-lift-when-queued" },
  origin: { source: "habit", ref: "habit:skip-lift-when-queued" } }
```

`load_brain(2, "task:M:PICK")` returns the v2 rule (two hops above the task node). `load_brain(1, "task:M:PICK")` still returns the v1 rule, so replay works. Because the proposal's `origin.ref` was a habit, the habit's `helpful` counter went up when the gate decided.

The brain graph document's own worked example (wait at a holding point when the lift queue is 2 or more) cannot be expressed today, because no setting maps to it. It would land in the empty `yielding` group.

### 6.5 Repeated proposals

The same candidate proposed twice is one gate run, status `cached`, and the second proposal is flagged as a repeat. A different `policy` arm proposing the same candidate is not a repeat. Repeats never produce a second gate signal in Raindrop (section 9), so the pass rate stays honest.

---

## 7. The `kg` package: API

### 7.1 Connecting

```python
import kg
gate = kg.connect("gate")         # the gate process: seed, verdicts, promote, held-out, approvals
imp  = kg.connect("improver")     # the GEPA side: proposals, shifts, context, suggestions
```

`connect` opens a separate `MongoClient` per role and picks a runner: `KG_RUNNER_URL` if set (HTTP), else TwinForge's fake runner through `tsx`, else the saved fixtures. Calling a gate-only method on the improver client raises `PermissionDenied`.

### 7.2 Methods

| Method | Client | What it does |
| --- | --- | --- |
| `seed(v1_brain=None)` | gate | Writes skeleton, concepts, envelope, v1 components and `brain_versions` v1. Idempotent: a second run changes nothing. Never overwrites a v1 component. |
| `sync_settings(runner=None)` | gate | Replaces the static registry with the runner's `GET /settings`. Reports differences. |
| `latest_version()` | any | The newest committed version number. |
| `load_brain(V, node_id, exclude=())` | any | The brain graph document's two-stage pipeline (`$graphLookup` up the parents, `$lookup` of the active components on that path). Returns `{node_id, version, scope, components, shadowed}`: one winning component per key, each with its `distance` and `envelope`, plus the components that lost to a deeper one. |
| `export_brain(V, exclude=())` | any | The contract `Brain` the runner receives: skeleton plus active components, with approvals from the envelope. |
| `ablate(V, component_id)` | any | Brain V without one learned component; the key reverts to the component it replaced. |
| `validate(brain)` | any | The runner's `/validate_brain` when it exists, else the local compiler mirror. Returns patch hash, effective edits, locked and rejected edits, warnings. |
| `record_proposal(base_V, candidate, origin, round, policy, split, seeds, hypothesis)` | improver | Diffs the candidate against base_V into `edits` and records the gate run before anything runs. Returns a `Proposal`. |
| `evaluate(proposal, runner=None)` | improver | Runs whatever the proposal still needs (base, candidate, or neither), records it, returns the numbers. |
| `record_shifts(response, split, gate_run_id=, side=, brain=)` | improver | Writes `shifts` and `episodes` for training and validation seeds, and fills the gate run once base and candidate are both present. |
| `record_verdict(gate_run_id, verdict, reason)` | gate | The gate's decision. Sends the Raindrop gate signal once and updates habit counters. |
| `promote(gate_run_id, hypothesis)` | gate | Creates version N+1 (section 3.5). Raises `StalePromotion` or `NeedsApproval` where relevant. |
| `record_heldout(gate_run_id, seed_set, passed, zone_delta)` | gate | Writes `heldout_results`. Sets `brain_versions.heldout_passed` if already promoted. |
| `record_final(version, passed, zone_delta, vs=1, seed_set="final")` | gate | Stores the once-only final-set result on the version. |
| `record_approval(target, value, decision, by, ref)` | gate | The Robotics Lead's answer (section 6.3). |
| `add_habit(habit_id, text, clip, steps, lever_group, **extra)` | gate | Writes a playbook habit. The improver user is read-only on `playbook`, so this needs the gate client or a third user. |
| `get_context(V, split="train")` | any | Sections A to C (section 8) as `{markdown, data}`. |
| `suggest(V, k=3, split="train")` | any | Top untested candidates, plus candidates that passed but were not promoted. |
| `explain(component_id)` | any | Rule, habit and clip, episodes, gate run, held-out flag (section 3.6). |
| `lineage(V)` | any | `$graphLookup` over `brain_versions.parent`, joined to the promoting runs and habits, as a chain plus a one-line markdown. |
| `graph_snapshot(V, compare_to=None)` | any | Nodes and links for one version, with added and retired components marked, and evidence as extra nodes and links. This is what a tree view reads. |

`record_proposal` accepts a candidate as `{target: value}`, a list of `{target, value}`, `{"edits": […]}`, a `Brain` or brain dict, or JSON text of any of these. Booleans and non-numbers are rejected.

Exceptions: `KGError` (base), `PermissionDenied`, `StalePromotion`, `NeedsApproval`, `EnvMismatch`.

### 7.3 Wiring the evaluator and the gate (Person B)

```python
import kg
imp  = kg.connect("improver")
gate = kg.connect("gate")

def evaluate_candidate(candidate, base_V, round_, policy, origin):
    p = imp.record_proposal(base_V, candidate, origin=origin, round=round_, policy=policy, split="train")
    result = imp.evaluate(p)              # cached and invalid proposals return at once
    ctx = imp.get_context(base_V)         # {"markdown": …, "data": …}: pass into GEPA's side_info
    return result, ctx, p

# gate side, after its own held-out check:
gate.record_verdict(p.gate_run_id, "passed", reason="…")
gate.record_heldout(p.gate_run_id, "heldout", passed=True, zone_delta={"M": 0.08})
gate.promote(p.gate_run_id, hypothesis="…")
```

Rules for the caller:
- Call `record_proposal` before **every** evaluation, and pass every runner response through `record_shifts` (or use `evaluate`, which does).
- Set `origin={"source": "habit", "ref": "habit:<id>"}` when a proposal comes from a playbook habit, so the habit's counters update. Use `"gepa"`, `"sweep"` or `"suggestion"` otherwise.
- The GEPA side holds only the improver client. The gate holds the other.
- Never pass held-out per-seed data to the KG.

---

## 8. What the improver sees: `get_context(V)`

One call returns markdown for the improver prompt and a structured dict for GEPA's `side_info`. It has three sections.

**A. The current brain.** Per-zone score (pooled across seeds), on-time, late, dropped and offered counts, and the worst zone. The worst zone's `time_split`. Failures per type, uncapped and fleet-wide, plus per-zone counts flagged when the runner capped the list.

**B. Everything evaluated on this brain.** Filtered to the current environment, grouped by lever group. For each run: the edits, per-zone delta with seeds better and worse, failure deltas, and the verdict with its reason. A candidate proposed more than once says so.

**C. Untested settings, in the order to try them.**
- Ordered by the ontology (section 3.7), then in default group order for anything left.
- Editable settings first, then locked ones marked "locked: needs a call".
- Values already tested on this brain are excluded.
- Each row shows min, max, v1, the current value, what was tried, and up to five values to try next (the sweep grid first, then a spread around v1).

If the runner's `time_split` is unavailable (it is on the cut list), section C falls back to the outcome and failure keys.

---

## 9. Raindrop

Raindrop measures the KG; the KG never waits on it. The Python SDK (`raindrop-ai` 0.0.73) is used through a sink that is a no-op without `RAINDROP_WRITE_KEY`.

- **One event per proposal**: `candidate_brain`, sent once the outcome is known. Properties include `brain_version`, `base_patch_hash`, `cand_patch_hash`, `lever_groups`, `edits`, `time_state`, `origin`, `policy`, `split`, `round`, `gate_run_id`, `status`, `repeat`, `zone_M_score`, `zone_M_delta`.
- **Four signals, all instrumented** (so no custom slots are used):

| Signal | Sentiment | When |
| --- | --- | --- |
| `gate_passed` | positive | The gate decides (first proposal per policy only) |
| `gate_failed` | negative | Same |
| `re_proposed` | negative | A candidate already proposed under the same policy |
| `invalid_proposal` | negative | A refused candidate |

- Each send is claimed in Atlas first (`gate_runs.events[].signals_sent`), so a signal goes out at most once even with parallel evaluators.
- **Person C's failure-type signals** (`LIFT_QUEUE_JAM` and so on) should attach to the same event id. It is on the `Proposal` as `event_id` and stored in `gate_runs.events`.
- The KG tags events with `brain_version` and `split` (train or val). Held-out never passes through the KG, so a Raindrop Experiment on held-out seeds has to be fed by the gate itself.

---

## 10. What the KG needs from each teammate

**TwinForge owner (Shashwat)**
- The HTTP runner with `/health`, `/run_shift`, `/validate_brain` and `/settings` (work package WP-R).
- A v1 brain file (WP-B). The KG will check that the runner's patch hash for `export_brain(1)` equals the hash of that file. If it does not, stop and fix it before any real round, because otherwise every trial runs the wrong fleet or gets a 422.
- A `spec_hash` in `/health` and responses, or an agreed manual epoch (`KG_ENV_EPOCH`) that gets bumped whenever the stair costs are retuned (WP-T).
- An `engine_sha` that carries a `-dirty` suffix when the working tree has uncommitted changes.
- Before the stretch ring: a `max_failures` request field for uncapped training runs.

**Person B (gate and GEPA improver)**
- Everything in section 7.3.
- Create `heldout_seeds` documents (a `seeds` array) so the gate-side safety check works.
- Keep the `final` seed set and run it once after the freeze, then call `record_final`.

**Person C (clips, ElevenLabs, Raindrop)**
- The Raindrop write key, the Query API key and the Pro trial (Triage messages are 15 a month on Hobby).
- Playbook habits in the shape in section 4.2, written through `add_habit`.
- Failure-type signals on the KG's `event_id`.
- The ElevenLabs decision routed to `record_approval`, through the Agent Engine resume handler.

**Dashboard owner**
- A `graph_snapshot(V)` consumer for the tree view, and the node-light-up event (section 11).

Work-package labels such as WP-R, WP-B and WP-T come from a TwinForge work plan that is not in this repository. The plain-language description beside each is what matters.

---

## 11. Fit with the interface contracts and iteration 03

### 11.1 The interface contracts

[`interface-contracts.md`](interface-contracts.md) fixes two function shapes the supervisor will call. The KG covers both, but not byte for byte, and the differences need a team answer (D10).

| Contract | KG equivalent | Differences |
| --- | --- | --- |
| `get_brain_context(task_node_id, version?)` returns `{components: [{kind, key, when, then, since, until, evidence}]}` | `load_brain(V, node_id)` | Arguments are in the other order, and `version` defaults to the newest, which is `latest_version()`. Components carry `label` and `compiles_to` (`{op, target, value}`) in place of free-text `when` and `then`, because only a typed edit runs on the engine. `kind`, `key`, `since`, `until` and `evidence` are the same. The result also returns `scope`, `distance`, the `envelope` and the `shadowed` components. |
| `commit_brain_version(add, retire, evidence)` returns `{version}` | `promote(gate_run_id, hypothesis)` | The KG derives what to add and retire from the gate run's typed `edits`, and builds `evidence` itself (habit, episodes, signal, gate run). It also enforces what a generic add/retire call would skip: gate-only access, a stale-base check, and approvals for locked settings. |

A thin wrapper gives the supervisor the contract's names without changing the KG:

```python
def get_brain_context(task_node_id, version=None):
    V = version or imp.latest_version()
    return {"components": imp.load_brain(V, task_node_id)["components"]}

def commit_brain_version(gate_run_id, hypothesis=None):
    return {"version": gate.promote(gate_run_id, hypothesis)["version"]}
```

The contract's build rule is already met: `promote` writes with `insert_one`/`update_one` upserts and never uses an aggregate with `$merge` or `$out`. The contract also says these two calls should be the only way anything touches the brain collections. The KG does not work that way. The evaluator, `get_context`, `explain` and `graph_snapshot` also read `brain_nodes`, and every learned change is written through a gate run so that it carries a verdict and evidence. If the supervisor should hold only those two tools, that is a wrapper-level choice and needs no change in the KG.

### 11.2 Iteration 03: the supervisor and worker toolbelts

Iteration 03 names a supervisor toolbelt and a worker agent's tools. This is how each maps onto the KG today.

| Iteration 03 tool | KG today |
| --- | --- |
| `get_brain_context(task_node)` | `load_brain(V, node_id)`. Its `scope` field lists the node ids from task to site, and the components carry ids, so a wrapper can emit the node-light-up event with exactly the nodes that were read. The KG has no websocket by design. |
| `get_trajectories(shift_id)` | The data is in `shifts` (raw result) and `episodes`. No wrapper function yet. |
| `get_signals(shift_id)` | `kg.get_signals(shift_id)` (or `python -m kg signals SHIFT_ID`): the shift's gate runs, their Raindrop events, and the signals on them, grouped as `gate`, `hard_metrics`, `self_diagnostics` and `other`. Reads Raindrop's Query API, so it needs `RAINDROP_QUERY_API_KEY`. Events that carry a `shift_id` property (worker agents, Self Diagnostics) match directly. |
| `report_issue`, `run_experiment` | Raindrop. The KG tags events with `brain_version` so Experiments can filter. |
| `get_playbook(task_node)` | `playbook` exists, but habits carry `lever_group`, not a task node. Needs an optional `applies_to` field (additive). Proposed, not built. |
| `propose_edit`, `run_gate`, `commit_brain_version` | `record_proposal` and `evaluate`, the gate (Person B), and `promote`. |
| `call_robotics_lead` | ElevenLabs. The answer goes to `record_approval`. |
| `get_sop(task_type)` | `sop_docs` is not a KG collection. Proposed as a plain, unversioned collection (D8). |
| `save_preference(text)` (the call agent) | No destination exists in the KG yet. Proposed: a `preferences` collection (D9). |

**Managed MCP Server rules from iteration 03, applied here**
- Reads through the MCP `aggregate` tool are fine: `load_brain` is a single read pipeline, so the brain can be reached as a tool call.
- Writes go through the `kg` package, which uses `$setOnInsert` upserts and gate-only promotion. Never use `$merge` or `$out`.
- Keep the gate on a native, collection-scoped connection, as the KG already does.
- A custom collection-scoped role cannot be assigned to an MCP configuration (section 5), so `heldout_*` is out of an MCP agent's reach only by convention. Give MCP only to agents that may see the whole project.

Iteration 03's four Track 1 items map to KG kinds as: rules, guardrails (live), context policies and tool grants (reserved, D2).

---

## 12. How this relates to the brain graph document

**Kept as written:** the site, zone and task skeleton; the four component kinds; `key` precedence (deeper wins); the two-stage `$graphLookup` and `$lookup` load; `since` and `until` versioning; `evidence` references as the extra edges; per-collection permissions; the worked-example idea.

**Added**

| Addition | Why |
| --- | --- |
| `compiles_to` on rules and guardrails | The runner only understands typed setting edits. A free-text `when/then` alone cannot run. |
| A v1 baseline component for every setting, at `site:main` | A missing setting falls back to the engine default, which is wrong (3.4). |
| `shifts` (raw per-seed results) | The ground truth. Later phases can recompute things without re-running the twin. |
| `gate_runs` | One per evaluated candidate, with full provenance, so a candidate is evaluated once. |
| `heldout_results`, gate-only | Showing held-out numbers to the improver over about a hundred candidates would tune it to the test set. |
| `concepts` (the ontology) | Orders what to test next, and is where self-improvement attaches later. |
| Zone C | The stairwell is there. |
| `observed_at` in `evidence` | Records where a problem was seen while components attach at the site. |

**Changed**
- Held-out scores leave `brain_versions`. It keeps only `heldout_passed`.
- For components that compile to a setting, `key` equals the setting target.
- Skeleton is 21 nodes (1 site, 4 zones, 16 tasks), not 16.
- Components attach at `site:main`, not at task nodes.

**The brain graph document's four open decisions, as answered by the build**
1. *Three levels or a fourth for stations?* Three. The runner cannot scope a setting to one lift, and failures only carry a zone.
2. *Attach only at task nodes first?* No: attach at `site:main` until zone-scoped edits exist (3.3).
3. *Plain collections only, Agent Engine memory just for preferences and episodes?* Yes. Agent Engine memory may mirror the Robotics Lead's preferences and round summaries later (ring 3), if the cluster tier allows it.
4. *Who owns the graph?* Prithviraj.

---

## 13. Decisions for the team

| # | Question | Recommended | Built that way? |
| --- | --- | --- | --- |
| D1 | Accept the answers to the brain graph document's four open decisions in section 12, including adding zone C. | Yes | Yes |
| D2 | Do context policies and tool grants describe the **robot agent** (no effect until model decisions at exception points are built, which is cut) or the **improver** (`get_context` settings, and which lever groups it may propose)? | The improver, so all four Track 1 items actually run. | No. Kinds reserved. |
| D3 | Until zone-scoped edits exist, attach at `site:main`, or at zone and task nodes with an "applies fleet-wide" badge? | `site:main`: it is accurate. | Yes |
| D4 | Move held-out scores out of `brain_versions` into `heldout_results`. | Yes | Yes |
| D5 | Use the brain graph document's collection names. | Yes | Yes |
| D6 | May the learned-ordering analysis (ring 3) run after the 14:30 freeze, since it analyses our own data and is not a new integration? | Yes, if ring 2 is done. | Not started |
| D7 | The KG is a Python package in this repository, mirroring the runner contract with Pydantic. | Yes | Yes |
| D8 | Add `sop_docs` (iteration 03's open question) as a plain, unversioned KG collection? | Yes, additive. | No |
| D9 | Where does `save_preference` write? Add a `preferences` collection? | Yes, additive. | No |
| D10 | Components carry `label` and `compiles_to` in place of the interface contract's `when` and `then`, and `commit_brain_version` is a wrapper over `promote(gate_run_id)` rather than a free add/retire call (11.1). | Yes: free text cannot run on the engine, and a free add/retire would skip the gate. | Yes, as the KG's native API |

Also open from iteration 03: who owns the Managed MCP Server setup. Whether a custom collection-scoped role works for it is answered: no (section 5).

**Robot form.** Iterations 02 and 03 describe wheeled AMRs. The KG's settings registry is built on TwinForge's humanoid overlay (`class.HUM-1.*` keys). The KG's structure is identical either way, and only a handful of registry keys and notes would change. This needs one team-wide answer.

---

## 14. Build rings and status

The KG is built in rings that only add collections or fields and never reshape an earlier ring, so something is always ready to present.

| Ring | What it adds | Status in code | Demo line |
| --- | --- | --- | --- |
| 0 | The brain lives in Atlas: `seed`, `load_brain`, `export_brain`. | Built | "The brain lives in Atlas as a hierarchical knowledge graph. One aggregation loads what applies to a PICK in zone M." Show it in the Data Explorer. |
| 1 | The evidence trunk: `record_proposal`, `record_shifts`, `evaluate`, `record_verdict`, `promote`, `get_context`, Raindrop. | Built | "The improver asks the brain what it already tried. Here is the v1 to v3 diff, and Raindrop counts passes, repeats and invalid proposals per round." |
| 2 | Humans, explanations and the firewall: `add_habit`, `explain`, `lineage`, `graph_snapshot`, `suggest`, `record_heldout`, `record_final`, `record_approval`. | Built | "A rule in Atlas, the clip it came from, the lift jams it fixed, the gate result, and the phone approval for a locked setting." |
| 3 | The ontology improves itself: learn candidate lever groups from promoted runs, score them on past rounds. | Not started (stretch). `get_context` already accepts a `learned` ordering. | "The harness also improves how it decides what to try." Call the result a proxy measure, not proof. |

Plan clock: ring 0 by about 12:30, ring 1 by 13:15, go/no-go with the real runner 13:15 to 13:45, ring 2 by 14:30, freeze at 14:30.

**What is still waiting on the real runner:** the patch-hash cross-check against the v1 brain file, the `capped` flags on real episodes, and the first real rounds. Until then the fake runner only reads `sim.STAIR_MIN_LIFT_QUEUE`, so with fixtures only edits to that one setting change the results. Every other setting returns identical numbers.

---

## 15. Risks and fallbacks

| Risk | Fallback |
| --- | --- |
| The real runner arrives late | Keep working on fixtures and the fake runner. The env key keeps fake and real results apart once it lands. |
| No `/validate_brain` yet | The KG hashes exported nodes locally. Run the v1 hash check as soon as the v1 brain file exists. |
| GEPA changes several settings at once | Stored as one gate run with an `edits` list. Credit per setting needs ablation. |
| `time_split` gets cut | Section C falls back to the outcome and failure keys. |
| Per-zone failure counts hit the runner's cap of 25 per type per seed | They are shown flagged. The gate and the ranking use the uncapped zone metrics. |
| Few promotions (5 to 10), so ring 3 learning is thin | Call it a proxy. Show the Raindrop trend in repeats and invalid proposals instead. |
| The cluster is M0 | The KG does not need Agent Engine memory. Skip the ring 3 mirror. |
| Other people or agents editing the same files | Small commits. Re-check files before editing or deleting them. |

---

## 16. Known gaps and discrepancies

- **No end-to-end run is recorded.** Whether the sandbox cluster has been seeded is not recorded in this repository. `seed()` is idempotent, so running it answers that.
- **Tests exist but were not run for this packet.** `kg/tests/` has unit tests and tests for rings 0 to 2, matching the plan's test table. MongoDB cannot be faked: `mongomock` cannot run `$graphLookup`, so tests need a real MongoDB (a local one, or Atlas test users via `KG_TEST_GATE_URI` and `KG_TEST_IMPROVER_URI`).
- **`kg/__init__.py` points to a `kg/README.md` that has not been written.** Section 7 of this packet covers the evaluator wiring in the meantime.
- **Skeleton size differs from the brain graph document** (21 nodes against 16), because of zone C.
- **The brain graph document's holding-point example is not expressible** until some setting maps to it (3.7, 6.4).
- **The improver's database privileges are wider than the code needs** on `brain_nodes` (section 5).
- **`add_habit` needs the gate client**, because the improver user is read-only on `playbook`.
- **Every edit is recorded with `scope: "fleet"`**, because the runner applies every setting fleet-wide today.

---

## 17. Setup

**Python 3.11** with `pymongo`, `pydantic`, `httpx` and `raindrop-ai==0.0.73` (plus `pytest` for the tests). A virtual environment lives wherever you like; `kg/.venv` is ignored by git.

**Environment variables.** `kg.connect` reads the process environment only. To use a `.env` file, call `kg.load_dotenv()` first: it loads the nearest `.env` (the current directory, then up to three parents) and never overrides a variable that is already set.

| Variable | Meaning | Default |
| --- | --- | --- |
| `KG_MONGODB_URI_GATE` | Connection string for the `gate` user | none |
| `KG_MONGODB_URI_IMPROVER` | Connection string for the `improver` user | none |
| `KG_MONGODB_URI` | Fallback for both. Local development only. | none |
| `KG_DB` | Database name (tests use `kg_test`) | `kg` |
| `KG_ENV_EPOCH` | Manual epoch until the runner reports `spec_hash`. Bump it when the stair costs are retuned. | `e1` |
| `KG_RUNNER_URL` | Runner base URL, for example `http://localhost:8787`. Unset: the fake runner or fixtures. | unset |
| `KG_TRAIN_SEEDS`, `KG_VAL_SEEDS` | Comma-separated seed lists | 101 to 112, 201 to 206 |
| `KG_TICKS`, `KG_PROFILE` | Shift length and scenario profile | 12000, `standard` |
| `RAINDROP_WRITE_KEY` | Enables Raindrop events and signals | unset (off) |
| `KG_RAINDROP` | `0` disables Raindrop even when the key is set | on |
| `RAINDROP_QUERY_API_KEY` | Query API key for `get_signals` (from auth.raindrop.ai/org/api_keys; not the write key) | unset |
| `TWINFORGE_DIR` | Path to the TwinForge checkout, for the fake runner and fixtures | `../physical-ai` |

Never commit connection strings or keys.

**Create the two database users on Atlas** (needs Project Owner): run `python -c "from kg.db import atlas_cli_commands; print('\n'.join(atlas_cli_commands('kg', '<PROJECT_ID>')))"` and fill in the two passwords. The role is `kgImprover`.

**First run**

```python
import kg
kg.load_dotenv()              # only if your connection strings are in a .env file
gate = kg.connect("gate")
print(gate.seed())            # idempotent; prints what it inserted
print(gate.load_brain(1, "task:M:PICK")["scope"])   # ['task:M:PICK', 'zone:M', 'site:main']
```

**Fixtures.** No HTTP runner exists yet, so `kg/tools/make_fixtures.sh` runs TwinForge's fake runner from outside this repository and saves its responses to `kg/tests/fixtures/`. `kg/tools/fake_runner.mts` can also serve the contract's endpoints in fake mode. Both need a TwinForge checkout with its dependencies installed.

---

## Appendix A: the settings registry

Groups are the lever groups. A dash means the brain never sets it. v1 is the baseline value, and "engine default" is what applies if a setting is missing from the brain.

| Setting | Group | Status | v1 | Min | Max | Engine default |
| --- | --- | --- | --- | --- | --- | --- |
| `sim.STAIR_MIN_LIFT_QUEUE` | floor_change | editable | 99 | 0 | 99 | 0 |
| `sim.STAIR_MAX_LOAD` | floor_change | editable | 99 | 0 | 99 | 99 |
| `sim.LIFT_RETRY_TICKS` | floor_change | editable | 50 | 20 | 200 | 50 |
| `sim.LIFT_XFLOOR_PENALTY_M` | floor_change | editable | 40 | 0 | 100 | 40 |
| `sim.WAIT_REPLAN_TICKS` | waiting | editable | 25 | 10 | 80 | 25 |
| `sim.WAIT_BACKOFF_TICKS` | waiting | editable | 80 | 30 | 200 | 80 |
| `sim.CHARGE_AT_PCT` | energy | editable | 35 | 25 | 60 | 35 |
| `assign.W_BATTERY` | energy | editable | 0.25 | 0 | 1 | 0.25 |
| `assign.W_DISTANCE` | dispatch | editable | 0.35 | 0 | 1 | 0.35 |
| `assign.W_WORKLOAD` | dispatch | editable | 0.15 | 0 | 1 | 0.15 |
| `assign.W_CONGESTION` | dispatch | editable | 0.15 | 0 | 1 | 0.15 |
| `assign.W_HEALTH` | dispatch | editable | 0.1 | 0 | 1 | 0.1 |
| `sim.IDLE_TO_PARK_TICKS` | dispatch | editable | 300 | 100 | 1200 | 300 |
| `zone.M.capacity` | dispatch | editable | 8 | 2 | 12 | 8 |
| `class.HUM-1.capacity` | dispatch | editable | 1 | 1 | 1 | 1 |
| `class.HUM-1.max_speed` | motion | locked | 1.2 | 0 | 1.5 | 1.5 |
| `sim.PERC_STOP` | motion | locked | 1.7 | 1.2 | 3 | 1.7 |
| `sim.PERC_SLOW` | motion | locked | 2.8 | 1.7 | 5 | 2.8 |
| `sim.MIN_SEP` | motion | locked | 0.9 | 0.9 | 0.9 | 0.9 |
| `sim.HUMAN_CLEARANCE_M` | - | fixed | 2 | 2 | 2 | 2 |
| `sim.STAIR_CAPACITY` | - | spec | 2 | 2 | 2 | 99 |
| `sim.STAIR_LOAD_TICKS` | - | spec | 40 | 40 | 40 | 0 |
| `sim.BATTERY_STAIR` | - | spec | 0.01 | 0.01 | 0.01 | 0 |

`zone.M.capacity` is a weak lever: it changes a congestion reading that feeds assignment scoring, not how many robots may enter the zone.

---

## Appendix B: the concept trees

Ids are `c:<tree>/…`. `->` lists the candidate lever groups.

```
c:failure                                   What went wrong
  c:failure/congestion                      -> floor_change, waiting, yielding
    LIFT_QUEUE_JAM       a robot stayed in a lift queue for more than 30 s            -> floor_change
    STAIR_QUEUE          a robot waited because the stairwell was full                -> floor_change
    DEADLOCK_BACKOFF     the engine's collision back-off fired                        -> waiting, yielding
  c:failure/throughput                      -> dispatch, energy
    LATE_TASK            a task finished after its deadline                           -> dispatch, energy
    DROPPED_DEMAND       a task was dropped because the waiting queue was full        -> dispatch
  c:failure/energy                          -> energy
    BATTERY_STRANDING    a robot hit critical battery while carrying a load           -> energy
  c:failure/disruption                      -> waiting, dispatch
    HUMAN_REPLAN         a robot rerouted around a zone blocked by a person           -> waiting, dispatch

c:time                                      Where task time goes (time_split)
  c:time/productive:      travel, pick_drop
  c:time/non_productive:  lift_wait -> floor_change      blocked -> waiting, yielding
                          stairs -> floor_change         lift_ride -> floor_change (ranked after lift_wait)

c:outcome                                   Outcomes in the worst zone (second ranking key)
  late, dropped                             -> dispatch, energy      (uncapped, from the zone metrics)

c:lever                                     What the brain can change
  floor_change (4 settings)   waiting (2)   energy (2)   dispatch (6)   motion (3, locked)
  yielding (0: capability gap)
  leaves: c:lever/<group>/<setting target>, carrying target, min, max, v1 and status
```

---

## Appendix C: glossary

| Term | Meaning |
| --- | --- |
| Brain | The set of components active at one version: rules, guardrails, context policies and tool grants. |
| Component | One brain document of kind rule, guardrail, context policy or tool grant. |
| Skeleton | The 21 fixed scope nodes: site, zones, tasks. |
| Key | The short name for the behaviour a component controls. For rules and guardrails it equals the setting target. |
| Lever | A setting the brain can change. Lever groups cluster them by purpose. |
| Envelope | The limits humans own: each setting's bounds, status and approval history. It wins over any component. |
| Gate run | One evaluated candidate: edits, base and candidate numbers, verdict, provenance. |
| Shift | One twin run for one seed on one brain. |
| Episode | One failure entry from a shift. |
| Habit | A behaviour extracted from the human clips, stored in `playbook`. |
| Patch hash | A hash of the settings a brain compiles to. Two brains with the same effective settings share it. |
| Env key | A hash of where a result was measured (engine, spec, ticks, profile). Results from different env keys never mix. |
| Split | `train` or `val`. Held-out is a third category that never enters the KG. |
| Held-out | The locked test seeds only the gate may use. |
