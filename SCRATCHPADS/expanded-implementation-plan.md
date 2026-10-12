# Expanded Implementation Plan: Document 07
October 11, 2026 · Owner: Prithviraj · **Theoretical draft. Nothing in this plan has been executed or agreed by the team.**

---

## What this document is

Document 06 (`kg-implementation-plan.md`) is the build plan for the knowledge graph and the improvement loop around it. This document is a second version of that plan. It keeps everything in document 06 and adds the sponsor ideas from this afternoon's brainstorm, using each sponsor tool for something it wasn't designed for.

- **Everything in document 06 still applies** unless a section here says it changed. Its data model, `kg` interface, tests and decisions are not repeated; this document only lists what is added or changed.
- **The centrepiece is idea 6, the adversary agent.** It gives the project a second self-improvement loop: the brain gets better *and* the tests it is trained on get harder. That is the strongest addition for the Raindrop RSI prize.
- Clock times follow documents 05 and 06: trunk until 13:15, go/no-go 13:15–13:45, branches until the 14:30 feature freeze, final rounds 14:30–15:30.

**A warning on scope.** Document 06 already fills the day. This plan adds roughly 7 to 9 person-hours of new work. It cannot all fit before 14:30, so section 9 gives a strict cut order. The adversary has a cheap version ("adversary-lite", section 3.6) that survives every cut.

---

## 1. The ideas, tiered

The shortlist is now six ideas. Idea 6 has been added and is first in priority.

| # | Idea | Tier | Phase | Owner | Size |
| --- | --- | --- | --- | --- | --- |
| **6** | **Adversary agent that writes scenarios to break the current brain** | **Core** | 1–2 | Prithviraj (+ TwinForge owner for WP-C2) | L |
| 1 | Guardrails as a firewall on brain edits | Shortlist | 0–1 | Person B | S |
| 5 | Vector search over `time_split` profiles | Shortlist | 1–2 | Prithviraj | S |
| 8 | Raindrop Experiment as the release check | Shortlist | 2 | Person C | M |
| 11 | Narration on human clips, transcribed by ElevenLabs | Shortlist | 1 | Person C | S |
| 15 | Harness pipeline that releases brain versions | Shortlist | 2 | **unassigned** (decision E3) | M–L |
| 2 | Policy Engine as the improver's list of permitted edits | Stretch | 3 | Person B | M |
| 3 | Each humanoid is a memory user | Stretch | 3 | Prithviraj | S |
| 4 | REINFORCE counts as confidence scores | Stretch | 3 | Prithviraj | S |
| 7 | Improver writes its own Raindrop failure detectors | Stretch | 3 | Person C | M |
| 10 | Robots as Raindrop users | Stretch | 3 | Person C | S |
| 12 | Inbound "ask the fleet" calls | Stretch | 3 | Person C | M |
| 13 | Approval call can propose new limits | Stretch | 3 | Person C | S |
| 14 | Spoken robot callouts in the replay | Polish | after 14:30 rehearsal only if pre-generated | TwinForge owner | S |
| 9 | Raindrop replay suite holds the held-out set | **Parked** | — | — | — |

### What changed from the brainstorm

Four ideas changed once they were checked against document 06's rules:
- **Idea 1:** locked settings get `log_only`, not `require_review`. A reviewer needs the predicted effect of the edit, and that only exists after the gate has simulated it with `allow_locked: true`. Approval therefore stays on the existing `interrupt()` path. Only the never-approvable settings are hard-blocked by the guardrail.
- **Idea 6:** the adversary is rewarded for **regret**, not for raw failure. Regret is how much better some known brain does on a scenario than the current brain. A scenario that every brain fails is rejected as impossible. Without this rule the adversary just breaks the world (both lifts down all shift) and teaches nothing.
- **Idea 8:** Raindrop decides **releases**, not every candidate. Document 06's rule is that Raindrop is not on the critical path, and per-candidate samples are too small for Raindrop to give a verdict anyway.
- **Idea 9 is parked.** With the Harness pipeline holding the release seeds, a third lock on test data adds work without a better story. It also needs the TypeScript replay harness and a tunnel.

---

## 2. How the pieces fit

```
 ┌─────────────────────── Atlas Agent Engine (one project) ─────────────────────────┐
 │  improver agent                                  adversary agent                 │
 │   - writes candidate brains (GEPA reflection)     - writes scenario scripts      │
 │   - guardrails: block forbidden targets  ──A2A──>   - memory: what broke before   │
 │   - policy caps = compute budget per epoch        - policy caps on its own calls │
 │   - approval: interrupt() → call → resume                                         │
 │   memory (standalone SDK, explicit user_id): round episodes, adversary episodes, │
 │                                              the Robotics Lead's preferences     │
 └───────▲──────────────────────────────┬───────────────────────────────▲───────────┘
         │ reflection prompt            │ candidate / scenarios         │ resume
         │                              ▼                               │
 local loop: GEPA epoch ──> runner POST /run_shift (seeds × scenarios) ─┼─> KG in Atlas
         │                     (TwinForge, deterministic)                │   (brain, gate_runs,
         │                                                              │    scenarios,
         └─> gate: promote vN ──> release PR ──> Harness pipeline       │    time_profiles + vector index)
                                    1. OPA: locked edits need approvals │
                                    2. release seeds (gate-only)        │
                                    3. Raindrop Experiment verdict ─────┘
                                    4. merge → `releases` → change stream → stage view
 ElevenLabs: approval call (doc 05) + narration transcripts on human clips
 Raindrop: one event per evaluation (doc 05), scenario signals, guardrail blocks, release cohorts
```

### Where the loop runs: option 1b

Document 05 recommends option 1: improvement rounds run locally, and Agent Engine handles approvals, memory and policies. Guardrails and policy caps only apply to calls that go through Agent Engine, so this plan changes that slightly:

- **Option 1b (recommended):** the runner calls (the hot path, many per second) stay local. GEPA's reflection step, which proposes each new candidate, is passed as a callable `reflection_lm` that invokes the deployed improver agent through the REST API. Every proposal is then guardrail-checked, capped by policy and traced. There are far fewer reflection calls than runner calls, so the extra latency is acceptable.
- While building, point the callable at `agentengine dev up` on `:3000`. **Not yet verified:** whether the local stack enforces guardrails and policies. If it doesn't, test them against the cloud deploy only.

---

## 3. Idea 6 in detail: the adversary

### 3.1 The idea

Two agents improve against each other:
- The **improver** proposes brains that score higher on the training scenarios.
- The **adversary** proposes scenarios (lift faults, people blocking zones, task bursts) on which the current brain does much worse than some other known brain.

Accepted scenarios join the training set, which becomes a **curriculum** that grows harder as the brain improves. A scenario "graduates" once the current brain handles it. The method is borrowed from unsupervised environment design, in particular PAIRED's regret objective (Dennis et al., 2020), and should be credited as such on stage.

The RSI story: "the harness improves its brain, and a second agent improves the exam. Both loops are scored by the same deterministic twin."

### 3.2 What TwinForge needs: WP-C2 (S, harness track, TwinForge owner)

WP-C already builds per-seed scenario scripts from a profile. WP-C2 lets the caller supply the script instead:

- `POST /run_shift` accepts an optional `scenario_script: Injection[]`. When present it replaces the profile, and the same script runs on every seed, so the seed only changes demand.
- `POST /validate_scenario` checks a script against the **scenario envelope** below and returns `{ ok, rejected: [{ index, reason }], scenario_hash }`.
- `/run_shift` refuses an out-of-envelope script with HTTP 422, like a locked brain edit.
- Every response includes `scenario_hash`: a stable hash of the sorted injection list, or the profile name when no script is given.

Injection shapes reuse WP-C's kinds:
```json
{ "kind": "LIFT_FAULT", "lift_id": "LIFT-1", "at_tick": 4800, "clear_at_tick": 6600 }
{ "kind": "HUMAN_INTRUSION", "zone": "C", "at_tick": 3000, "duration_ticks": 900 }
{ "kind": "TASK_BURST", "zone": "M", "at_tick": 7200, "count": 8 }
```

**Scenario envelope** (first proposal, to be tuned at go/no-go; 10 ticks = 1 simulated second):

| Rule | Value |
| --- | --- |
| `LIFT_FAULT` per shift | at most 2, each lasting 600 to 3,000 ticks (1 to 5 minutes) |
| Lifts down at the same time | at most 1 |
| `HUMAN_INTRUSION` per shift | at most 2, each lasting 600 to 1,800 ticks, in any zone |
| `TASK_BURST` per shift | at most 2, each of 4 to 10 tasks |
| `at_tick` | between 600 and `ticks − 1,200`, so every disruption starts after warm-up and ends before the shift does |

**Done when:** the same script and seed give a byte-identical response; an out-of-envelope script returns 422 with reasons; and the `scenario_hash` doesn't depend on the order of the injections.

### 3.3 Regret and acceptance

For a scenario `s`, the current brain `c`, and a set of known alternative brains `A`:

```
score(b, s)  = mean over the scenario's seeds of the mean zone score, for brain b on scenario s
regret(s)    = max over b in A of score(b, s) − score(c, s)
```

- `A` is the top three distinct candidates from the last GEPA epoch's Pareto set, plus the two best variants from WP-T's sweep grid. Early on, before any epochs have run, `A` is just the sweep grid.
- Each proposed scenario runs on 3 training seeds for each brain in `{c} ∪ A`. With M = 4 scenarios per adversary turn and up to 5 alternatives, a turn is at most 72 shifts, or roughly a minute at WP-R's speed.

| Outcome | Rule | Status |
| --- | --- | --- |
| Runner refuses it | 422 from `/validate_scenario` | `invalid` |
| Seen before | same `scenario_hash` already in `scenarios` | `cached`, plus a `re_proposed` signal |
| Nobody can handle it | `max over A of score(b, s) < 0.35` | `impossible` |
| Not hard enough | `regret < 0.05` | `too_easy` |
| Otherwise | | `accepted` |

- **Curriculum cap:** at most 6 active scenarios. When the cap is full, a new accepted scenario replaces the active one with the lowest regret.
- **Graduation:** after each promotion, re-score the active scenarios. One whose regret against the new brain is below 0.01 becomes `graduated`, and records the version that solved it.
- The 0.35 floor and the 0.05 and 0.01 thresholds are first guesses. Set them at go/no-go from the WP-T sweep numbers (decision E4).

**Known limit:** the floor only knows about brains we have already found, so it can reject a scenario that some undiscovered brain could handle. That is accepted, because the alternative is training on scenarios that may be unwinnable.

### 3.4 Epochs: how the two loops alternate

```
epoch k:
  1. GEPA run, seeded with the current best brain
       dataset = training seeds × (standard profile + active curriculum)
       valset  = validation seeds × (standard profile + active curriculum)
       budget  = max_metric_calls (start at 40; measure the epoch's wall time at go/no-go)
  2. The gate promotes as in doc 06, with one extra rule:
       a candidate must improve on the curriculum validation set
       AND must not regress on the standard-profile validation set beyond the existing tolerance
  3. Re-score the curriculum against the new brain; graduate scenarios that are solved
  4. Adversary turn against the new current brain (section 3.3) → accept up to 4 new scenarios
```

GEPA's dataset can't change in the middle of a run, so each epoch is a fresh `optimize_anything` call. Dataset items become `(seed, scenario_id)` pairs instead of bare seeds.

### 3.5 The adversary agent (Agent Engine)

- **A separate deployed agent** in the same project as the improver, with an `a2a` block that sets `allowed_callers: [improver]`.
- **How it is called:** at the start of each adversary turn, the local loop invokes the improver agent in a `plan_turn` mode, and the improver calls the adversary over A2A. This puts both executions in one linked trace on the Traces page, and the adversary's tokens count toward the improver session's token cap, so both agents share one compute budget. If A2A causes trouble, fall back to the local loop invoking the adversary directly over REST.
- **Input:** `kg.get_adversary_context(V)` (section 5), plus `build_context` from the adversary's own episodic memory.
- **Output:** a fenced JSON block with M scripts, each with a one-line rationale ("lift 1 fails just as the zone M burst arrives, so the lift queue jams").
- **Memory:** after each turn, the local loop writes one episode per scenario (accepted or rejected, with its regret) through the **standalone memory SDK** with `user_id: "adversary"`. Next turn, the adversary recalls which kinds of attack worked. A service-account invocation would share one memory scope across both agents (document 04, §1.4), which is why we pass explicit user ids.
- **Policies on the adversary:** `MAX_LLM_CALLS_PER_EXECUTION` and `MAX_TOKENS_PER_EXECUTION`, so the adversary can't burn the budget.

### 3.6 Adversary-lite (the fallback that survives every cut)

This is the same loop as section 3.4 with no Agent Engine dependency:
- The adversary is one local LLM call with the same prompt and output format.
- Its memory is the `scenarios` collection itself: the last 10 scenarios with their outcomes go into the prompt.

**Build this version first, in Phase 1, against the fake runner.** The Agent Engine version in Phase 2 only replaces the LLM call and the memory source. Everything else (WP-C2, regret, acceptance, epochs, the gate rule) is shared.

### 3.7 Keeping the evaluation honest

- **The headline number does not change:** v1 against vN on the standard-profile held-out seeds, run once, as in document 06. Adversarial training can make the brain worse on ordinary shifts, and the gate's no-regression rule plus this headline number both guard against that.
- **Secondary number: the stress set.** At go/no-go, before any epoch runs, run one adversary turn against v1 with a fresh prompt and accept up to 4 scenarios into `heldout_stress`. That collection is gate-only, in the same way as `heldout_results`: the improver never sees it, and these scenarios never enter the curriculum. At the end, score v1 and vN on it once.
- **Caveat to say on stage:** the stress set was generated against v1, so it measures how much of v1's weakness was fixed, not robustness in general.
- **What the curriculum chart shows:** by epoch, the current brain's mean regret on active scenarios, the number of graduated scenarios, and the adversary's acceptance rate. Present it as a training trace, not proof. The held-out numbers are the proof.

### 3.8 Done when

- Adversary-lite on the fake runner produces scenarios with each status, and a repeated scenario returns `cached`.
- On the real runner, at least one scenario is accepted against v1 and later graduates after a promotion.
- The improver client is refused on `heldout_stress`.
- The Agent Engine version shows an improver → adversary linked execution on the Traces page.

**Presentable:** "The adversary found that a lift fault during a zone M burst cost v3 a fifth of its on-time rate. Two epochs later v5 handles it, so the scenario graduated, and the adversary moved on to human intrusions in zone C."

---

## 4. The other shortlist ideas

### 4.1 Idea 1: guardrails as a firewall on brain edits (Person B, S)

These are guardrails on the improver agent, matched against `llm_output`:

| Pattern (on the candidate JSON) | Action | Why |
| --- | --- | --- |
| `"target"\s*:\s*"sim\.(HUMAN_CLEARANCE_M\|MIN_SEP)"` | `block` | Never approvable (`twinforge-humanoid-plan.md` §6). MongoDB enforces it, not our code. |
| `"target"\s*:\s*"(class\.HUM-1\.max_speed\|sim\.PERC_(STOP\|SLOW))"` | `log_only` | Shows the locked edit in the trace. Approval stays on the existing gate → `interrupt()` path. |

- **The output format has to be strict.** The improver must put the candidate in one fenced JSON block, and the patterns are anchored on the `"target":` key. Without that, a sentence in the reasoning like "I won't touch `max_speed`" could trigger a false block. Test both cases on `dev up`.
- A blocked proposal comes back to the local loop as an error. The loop logs the candidate's event with a `guardrail_blocked` signal (NEGATIVE) and gives GEPA a minimum score with `side_info` saying why.
- **Policy caps:** set `MAX_LLM_CALLS_PER_EXECUTION` and `MAX_TOKENS_PER_SESSION` on the improver, so each epoch has a fixed compute budget. A `policy_denied` result ends the epoch early, and that is logged too.
- **Done when:** on `dev up` or the cloud deploy, a hand-written candidate that sets `sim.MIN_SEP` is blocked, a candidate that sets `max_speed` passes with a guardrail step in its trace, and reasoning text that mentions `MIN_SEP` outside the JSON block is not blocked.
- **Presentable:** a guardrail step in the Agent Engine trace, and a Raindrop chart of `guardrail_blocked` per epoch going down. The improver's episodic memory of past blocks should mean it stops trying.

### 4.2 Idea 5: vector search over `time_split` profiles (Prithviraj, S)

- **New collection `time_profiles`:** one document per (shift, zone) for robot runs, and one per playbook habit for humans.
  ```python
  {"_id": "tp:<shift_id>:M", "source": "robot", "zone": "M", "ts_vec": [travel, lift_wait, lift_ride, stairs, blocked, pick_drop],
   "score": 0.47, "patch_hash": "...", "scenario": "<scenario_hash>", "gate_run_id": "..."}
  {"_id": "tp:habit:skip-lift-when-queued", "source": "human", "zone": "M", "ts_vec": [...], "habit_id": "habit:..."}
  ```
- **Vector index:** no embedding model is needed. The vectors are the 6 shares themselves, which sum to 1, so euclidean distance fits:
  ```json
  { "fields": [
      { "type": "vector", "path": "ts_vec", "numDimensions": 6, "similarity": "euclidean" },
      { "type": "filter", "path": "source" },
      { "type": "filter", "path": "zone" } ] }
  ```
- `record_shifts` writes the robot profiles. Person C's clip pipeline adds the human vector: Gemini labels each habit step with one of the six states, and the step durations become shares. These are approximate, because a person doesn't ride lifts the way a robot does, so call them "time profiles" rather than measurements.
- **New `get_context` section D:**
  - the two human habits closest to the worst zone's profile;
  - the three past robot shifts closest to it whose brain was later beaten by a promoted edit, along with that edit.
- **Not yet checked:** the sandbox tier's limit on search indexes. M0 has a low cap.
- **Done when:** a `$vectorSearch` with `filter: {source: "human", zone: "M"}` returns the stairs habit for v1's zone M profile.

### 4.3 Idea 8: Raindrop Experiment as the release check (Person C, M)

- **Release seeds:** a new set of 30 seeds in `heldout_seeds`, readable by the gate only, used only by the release check (section 4.5). That makes four seed sets: training, validation, held-out and final, plus release. 30 seeds give Raindrop enough events to give a verdict, where 12 validation seeds would not.
- **Events:** each release run logs one event per seed, `event="release_shift"`, with properties `brain_version`, `release_id` and `split: "release"`. It gets the instrumented signal `zone_target_missed` (NEGATIVE) when the worst zone's score is below v1's mean on that zone.
- **Check:** the pipeline creates an Experiment with baseline `brain_version = <currently released>` and experiment `brain_version = N`, filtered on `release_id` and using `zone_target_missed` as the outcome. Release requires "likely better". A "mixed" or inconclusive verdict blocks the release and is shown as such.
- **Firewall, new and important:** release events must go to a **separate Raindrop project** (`X-Raindrop-Project-Id`). Document 05 has the improver reading Raindrop over MCP. If release results were in the improver's project, it could read test results it isn't allowed to see. **Not yet verified:** whether the MCP server can be limited to one project. If it can't, the improver doesn't get the MCP server, and `get_context` stays its only view of the evidence.
- **Not yet verified:** Experiments are created through the UI, the Triage agent or MCP, and the docs list no plain REST endpoint. The pipeline step therefore needs a small MCP client script (`create_experiment`, then poll `get_experiment`). The fallback is creating the Experiment by hand in the UI during the release, which still puts Raindrop's verdict on screen.
- **Done when:** a release of a brain known to be better gets "likely better", and a release of v1 against itself is refused as inconclusive.

### 4.4 Idea 11: narration on human clips (Person C, S)

- While filming the 2 to 4 human clips, the person explains out loud what they're doing and why ("I wait here because the lift's slow at shift change").
- ElevenLabs speech-to-text (Scribe) returns a transcript with word timestamps. Each Gemini step `[t0, t1]` collects the words spoken in that window as its `why`.
- **Playbook step shape:** `{t0, t1, action, state, why}`. `state` is one of the six time-split states, which also feeds idea 5.
- **Be honest about it:** Gemini can also transcribe the audio track. We use ElevenLabs for its word-level timestamps and because it puts the sponsor in the data pipeline, not just the phone call. Say so if asked.
- **Done when:** `explain()` on a promoted rule returns the clip timestamp *and* the worker's own words for that step.

### 4.5 Idea 15: Harness release pipeline (owner unassigned, M–L)

**H0, at kickoff:** confirm we have Harness accounts and can run a pipeline step on infrastructure that can reach the runner. That means either a Harness delegate on the demo laptop or the runner hosted on Modelence; we don't yet know which Harness supports for us. **If there is no access, the same four checks run as a local `release.py` and we don't claim Harness.**

The flow:
- On promotion, the gate writes `brains/vN.json` (the `export_brain(N)` output) plus `release.json` (the edits, approvals and gate run id) to a small `brain-releases` git repo, and opens a pull request.
- The Harness pipeline runs four stages:
  1. **OPA policy:** locked edits need a matching approval, and never-approvable edits are refused. A draft in Rego v1 syntax (check which OPA version Harness runs):
     ```rego
     package brain.release

     locked := {"class.HUM-1.max_speed", "sim.PERC_STOP", "sim.PERC_SLOW"}
     never := {"sim.HUMAN_CLEARANCE_M", "sim.MIN_SEP"}

     deny contains msg if {
       some e in input.edits
       never[e.target]
       msg := sprintf("%s can never change", [e.target])
     }

     deny contains msg if {
       some e in input.edits
       locked[e.target]
       not approved(e)
       msg := sprintf("%s=%v has no matching approval", [e.target, e.value])
     }

     approved(e) if {
       some a in input.approvals
       a.target == e.target
       a.value == e.value
     }
     ```
  2. **Release seeds:** run the release seeds with the gate's database credentials. Those credentials live only in Harness secrets, so no developer laptop can read the release seeds.
  3. **Raindrop Experiment verdict** (idea 8).
  4. **Merge:** write a `releases` document in Atlas. A change stream pushes it to the stage view.
- **Optional:** Harness's Code Review agent comments on the PR with a plain-English diff of the brain.
- **This gives two levels of promotion:**
  - `promote` (document 06) creates an internal version, and happens often.
  - A **release** goes through the pipeline and is the brain shown as "in production", which happens 2 or 3 times in the afternoon.
- **Done when:** a PR that changes `max_speed` without an approval fails at stage 1, and an approved, better brain passes all four stages.

---

## 5. Data model and interface additions

All of document 06's collections stay. These are added:

| Collection | Holds | Written by | Improver access | Phase |
| --- | --- | --- | --- | --- |
| `scenarios` | Every adversary proposal: script, `scenario_hash`, rationale, round, epoch, `against` version, regret, status | KG | read | 1 |
| `heldout_stress` | The stress set from v1, plus the final v1/vN results on it | gate | **none** | go/no-go |
| `time_profiles` | Robot and human time-split vectors (idea 5) | KG, clip pipeline | read | 1 |
| `releases` | One per release: PR, pipeline run, Raindrop experiment id, verdict | release pipeline | read | 2 |

**Changes to document 06's model:**
- **The env key gains `scenario`** (the profile name or `scenario_hash`). Without it, `shifts` and `gate_runs` would treat the same brain on different scenarios as one cached result. This is a correctness fix, not an option.
- `heldout_seeds` gains a `release` set (idea 8).
- Playbook steps gain `state` and `why` (ideas 5 and 11).
- The improver's database role gets read access on `scenarios`, `time_profiles` and `releases`, and no access on `heldout_stress`.

**`kg` interface additions:**

| Function | Called by | Does | Phase |
| --- | --- | --- | --- |
| `get_adversary_context(V)` | adversary | The current brain's worst zone and time profile; failures by type, lift, zone and tick window across the standard profile and the curriculum; the last 10 scenarios with status and regret. | 1 |
| `record_scenario(script, rationale, against, round, epoch)` | adversary turn | Validates through the runner, hashes, returns `new` / `cached` / `invalid`. | 1 |
| `record_regret(scenario_id, scores_by_brain)` | adversary turn | Applies section 3.3's rules and sets the status. Enforces the curriculum cap. | 1 |
| `curriculum(V)` | GEPA epoch setup | The active scenarios for the next epoch. | 1 |
| `graduate(V)` | after `promote` | Re-scores active scenarios and marks the solved ones `graduated`. | 2 |
| `similar_profiles(zone, vec, source, k)` | `get_context` section D | Wraps `$vectorSearch`. | 2 |
| `record_release(...)` | release pipeline | Writes `releases`. | 2 |

---

## 6. Raindrop additions

Document 05's rule still holds: **one event per evaluation**, not per seed or per tick. These are added on top:

| Event or signal | Kind | When |
| --- | --- | --- |
| `adversary_scenario` event | one per proposed scenario | adversary turn; properties `epoch`, `against_version`, `regret`, `scenario_hash` |
| `scenario_accepted`, `scenario_graduated` | instrumented, POSITIVE | on accept or graduate |
| `scenario_too_easy`, `scenario_impossible`, `scenario_invalid`, `re_proposed` | instrumented, NEGATIVE | on reject |
| `guardrail_blocked` | instrumented, NEGATIVE, on the candidate's event | idea 1 |
| `release_shift` events + `zone_target_missed` | one per release seed, **separate project** | idea 8 |

Plan check: everything above is instrumented, so none of it uses a custom-signal slot.

---

## 7. Revised phases and timeline

Document 06's phase contents are kept and marked "(doc 06)". Additions are in **bold**.

### Before 12:00: accounts and setup
- (doc 05) Atlas tier, the Agent Engine Hello World and first cloud deploy, the Raindrop Pro trial, Twilio caller ID, the MongoDB MCP server.
- **H0: confirm Harness access, and assign an owner (E3).**
- **Create the second Raindrop project for release events. Check whether the MCP server can be limited to one project.**
- **Person C films the clips with narration** (idea 11).

### Phase 0: the brain lives in Atlas (11:45–12:30)
- (doc 06) `kg/` package, contract models, collections, two database users, `seed()`, `load_brain`, `export_brain`, fixtures.
- **Add `scenarios`, `heldout_stress`, `time_profiles` and their indexes, including the vector index. Extend the improver role (section 5).**
- **Person B writes the guardrails and policy caps, and tests them on `dev up`** (idea 1).
- **TwinForge owner: WP-C2**, next to WP-C on the harness track. The engine track is ahead of schedule according to document 05.

### Phase 1: the evidence trunk, plus adversary-lite (12:30–13:15)
- (doc 06) gate runs, shifts, episodes, `record_*`, `promote`, `get_context` A–C, Raindrop events, GEPA wiring.
- **Add `scenario` to the env key. `record_shifts` writes `time_profiles`.**
- **Prithviraj: adversary-lite against the fake runner,** covering `get_adversary_context`, `record_scenario`, `record_regret`, `curriculum`, and the epoch loop with `(seed, scenario_id)` dataset items. The fake runner ignores scenarios, so this checks the plumbing only.
- **Person B: GEPA's `reflection_lm` goes through the improver agent on `dev up`** (option 1b).
- **Person C: STT on the narrated clips, steps with `state` and `why`, and the new Raindrop signals.**

### Go/no-go with the real runner (13:15–13:45)
- (doc 06) Switch to the real runner, the patch-hash check, capped flags, first real rounds.
- **Check WP-C2 determinism on the real runner: the same script and seed give a byte-identical body.**
- **Tune the scenario envelope and the regret thresholds (E4) from the sweep grid. Check that at least one in-envelope scenario gives v1 a regret of at least 0.05 while some alternative stays above the floor. If none does, the adversary has nothing to find: stop and tell the team, the same rule as WP-T.**
- **Generate the stress set against v1 and lock it in `heldout_stress`.**

### Phase 2: humans, the firewall, and the adversary loop (13:45–14:30)
- (doc 06) playbook counters, evidence, `explain`, `lineage`, `graph_snapshot`, `heldout_results`, `record_approval`, `suggest`.
- **The adversary loop runs on the real runner: epochs alternate, and `graduate` runs after each promotion.**
- **Second cloud deploy (~14:00): improver and adversary agents with A2A, memory and the egress allow-list.** Two builds run in parallel; the preview allows 10 at once.
- **`get_context` section D (vector search).**
- **The release pipeline (Harness, or `release.py`) with OPA, release seeds and the Raindrop Experiment.**

### 14:30: feature freeze. No new integrations after this point.

### 14:30–15:30: final epochs and evidence
- Run 3 or 4 epochs. Release vN through the pipeline once or twice.
- **Run once, at the end:** v1 and vN on the standard held-out seeds (headline), the `final` set (doc 06), and `heldout_stress` (secondary).
- Draw the curriculum chart from `scenarios`, using Atlas Charts or Recharts, not both.

### Phase 3: stretch (only if Phase 2 is done before about 14:00, otherwise after the event)
- (doc 06) learned lever ordering, prequential evaluation, `policy` arms, concept splits, the memory mirror.
- **Idea 2:** one improver tool per lever group, with `AUTHORIZED_TOOLS` as the list of what it may propose. A `capability_gap` report asks for a group, the phone call approves it, and a REST policy update grants it. This is document 06's D2 "tool grant" made real. **Not yet verified:** which role can change project policies through the REST API.
- **Idea 3:** per-robot episodes (`user_id = R-07`) from `episodes.robots`. They feed `get_adversary_context` ("lift 1 jams R-07 and R-11 every shift") rather than the fleet-wide brain.
- **Idea 4:** save each promoted rule's hypothesis as semantic memory, and save it again each time the rule survives a held-out check, then show the REINFORCE count. **Not yet verified:** whether direct `save_*` calls are reconciled, and whether the count can be read back. The fallback is the playbook counters that already exist.
- **Idea 7:** template-generated (non-LLM) shift narrations go on validation events, and the improver creates one classifier signal over MCP.
- **Idea 10:** release-run events with `user_id` = robot id, so Issue Detection sees per-robot regressions.
- **Idea 12:** an inbound ElevenLabs agent with a webhook tool that calls `explain` / `lineage` through the reserved tunnel. Atlas Search on component labels finds the rule being asked about.
- **Idea 13:** one extra question in the approval call. The answer goes into semantic memory and `envelope.proposed_limits` as *pending*, and only takes effect after a person confirms it in the UI. It never becomes a guardrail automatically.
- **Idea 14:** pre-generate a handful of TTS lines and play them in WP-V when `FLOOR_ROUTE_CHOSEN` fires.

---

## 8. Tests to add to document 06's list

| Test | What it protects |
| --- | --- |
| Same brain on two scenarios gives two `shifts` ids | Scenario in the env key (cache correctness) |
| `scenario_hash` doesn't depend on injection order; an out-of-envelope script gets 422 | WP-C2 contract |
| A scenario that every brain fails is `impossible`, not `accepted` | The adversary can't break the world |
| Proposing a scenario twice gives one document, `cached` and `re_proposed` | Honest acceptance rates |
| The improver client is denied on `heldout_stress` | The stress-set firewall |
| `curriculum(V)` never returns a stress-set scenario | The stress-set firewall, at the tool boundary |
| The gate refuses a candidate that improves on the curriculum but regresses on the standard validation set | Adversarial training can't trade away ordinary shifts |
| A guardrail blocks `MIN_SEP` inside the JSON block but not in the reasoning text | Idea 1 without false blocks |
| `opa test` on the Rego policy: an unapproved locked edit is denied, an approved one passes, a never-approvable one is always denied | Idea 15 |
| An MCP query using the improver's credentials can't see the release project's events | Idea 8 firewall |

---

## 9. Risks and cut order

| Risk | Fallback |
| --- | --- |
| No in-envelope scenario gives v1 any regret | Widen the envelope within plausible bounds at go/no-go. If there is still none, drop the adversary and say so; the doc 06 trunk is unaffected. |
| The adversary only finds one kind of attack | Put the per-kind counts of accepted scenarios in its context, and ask it to try a kind it hasn't used. |
| An epoch is too slow for 3–4 epochs after the freeze | Lower `max_metric_calls`, use 2 training seeds per curriculum scenario, and cap the curriculum at 4. |
| The local stack doesn't enforce guardrails or policies | Test them only on the cloud deploy. Keep the same refusals in the KG and gate, as they already are. |
| A2A or the second deploy fails | Adversary-lite, with the improver agent still on Agent Engine. |
| Raindrop gives no verdict on 30 release seeds | Show the inconclusive verdict honestly, and release on the gate's own held-out rule. |
| The MCP server can't be limited to one Raindrop project | The improver doesn't get the Raindrop MCP server. |
| No Harness access | `release.py` with the same checks, and no Harness claim. |
| The vector index won't build on the sandbox tier | Skip section D. Rank habits with document 06's lever-group mapping instead. |

**If the schedule slips, cut in this order** (first cut first). Document 06's own cut list still applies on top.
1. Idea 15, the Harness pipeline → `release.py`.
2. Idea 8 inside the pipeline → create the Experiment by hand after the freeze, as document 06 already planned.
3. The adversary on Agent Engine → adversary-lite.
4. Idea 5, `get_context` section D.
5. Idea 11 → Gemini's own transcript of the audio.
6. Idea 1, guardrails. Cut last, because it is cheap and its refusals already exist in the KG.

**Never cut:** adversary-lite, the scenario env key, the stress-set firewall, or document 06's trunk.

---

## 10. What each judge sees

| Judge | On screen |
| --- | --- |
| MongoDB | A trace with a guardrail block; the improver → adversary linked execution; the adversary recalling its past attacks from memory; `$vectorSearch` matching a robot's time profile to a human habit; `scenarios` and `releases` in Data Explorer. |
| Raindrop (RSI) | Two self-improvement loops on one dashboard: `zone_target_missed` going down across releases, scenarios graduating, `guardrail_blocked` going down, and the release Experiment's verdict with its confidence interval. |
| ElevenLabs | The approval call, and the worker's own words next to the rule they inspired. |
| Harness | A release PR blocked by OPA for an unapproved speed change, then an approved one passing every stage. |

The stage line: "Our harness improves its robots' brain, a second agent improves the exam it's trained on, and every promotion has to get past MongoDB's guardrails, a human on the phone, Raindrop's statistics and a Harness release gate."

---

## 11. Decisions for the team

- **E1:** Adopt option 1b, so GEPA's reflection goes through the improver agent while runner calls stay local.
- **E2:** The adversary's owner. Recommended: Prithviraj, since it lives next to the KG. The Agent Engine deploy could instead go to Person B.
- **E3:** Who owns the Harness pipeline, if H0 shows we have access? The TwinForge owner after WP-V is the likeliest.
- **E4:** The regret thresholds (0.35 floor, 0.05 accept, 0.01 graduate) and the curriculum cap of 6, to be confirmed from the sweep at go/no-go.
- **E5:** Is a 30-seed release set acceptable, given that each release costs 30 shifts per brain on the critical path?
- **E6:** Present the stress set as a secondary number with its caveat (recommended), or leave it out?
- **E7:** Are adversary epochs allowed to run during 14:30–15:30? They use code finished before the freeze, the same question as document 06's D6.
