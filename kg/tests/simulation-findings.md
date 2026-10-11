# Simulation of the KG against a synthetic twin: findings

Date: 2026-10-11. Branch `kg/integration` at `be75973` plus the changes listed under "Issues found and fixed".
Everything found was fixed to the standard of "works for the demo, no egregious mistakes"; what is left is a
short list of known limits that need a team decision or belong to another component.

## What was simulated

The saved fixtures only react to `sim.STAIR_MIN_LIFT_QUEUE`, so they can't show the KG telling a helpful edit
from a harmful one on any other lever, nor a world that changes under the brain. `kg/tools/sim_runner.py` is a
closed-form twin with a known ground truth (the docstring lists what each setting does; the optimum stair
threshold is 2, and 3 after a "stairs got slower" retune that changes the spec_hash). It implements the runner
contract: `/health`, `/run_shift` with a 422 on unapproved locked edits, patch hashes in the runner's scheme.
Per-seed jitter is fixed by the seed and identical for every brain, as in a real twin with a fixed scenario,
so a strictly better brain is better on every seed.

`kg/tests/test_simulation.py` (27 tests, ~15 s) drives the real `KG` code on MongoDB through three groups:

1. **The graph updates:** a helpful edit becomes v2 with evidence, old version replays byte for byte; a
   two-setting candidate adds two components; a zone-scoped component shows up under its zone only; a
   deeper rule shadows a site rule.
2. **The graph corrects itself:** a harmful edit is rejected and nothing changes; a no-effect edit shows as
   "no zone changed"; stale runs are refused and re-evaluation reuses shifts; the world retunes and the brain
   reverts through `ablate()`; held-out failure is visible everywhere; an abandoned commit is rolled back; two
   racing promotions produce one v2; a nondeterministic twin is reported; a runner refusal marks the run
   invalid; a locked edit goes through the call and then runs with no `allow_locked`.
3. **Information comes back out:** eight rounds driven only by `suggest()` and the toy gate converge on the
   known optimum with zone M never regressing across promoted versions; section A-C markdown tells the story;
   `history(target)`; `explain`/`lineage`/`graph_snapshot` agree with each other.

Run them with the rest: `kg/.venv/bin/python -m pytest kg/tests -q` (needs `kg/tools/test_mongo.sh`).

## Issues found and fixed

| # | Severity | What the simulation showed | Fix |
|---|---|---|---|
| 1 | **High** | Once any rule for a compiled setting existed at a zone node (deeper than `site:main`), every later site-level candidate for that setting came back `invalid: no-op`. `_apply_edits` only replaced site-level components, so the deeper rule still won the compile and the improver could never change that setting again. | `_apply_edits` now replaces every component that sets an edited target, at any depth, with the candidate's site-level component. |
| 2 | **High** | The same shadowing on the write side: `commit_brain_version` only auto-retired a same-key component at the *same* node, so a site-level promotion under an existing zone-level rule would have committed a version whose effective value was not the one the gate measured. | A compiled component now also retires same-key compiled components at the target node's descendants (the engine's patch is flat, so a deeper one would shadow it). Before writing, the new brain is compiled locally and the commit is refused if any added component would not take effect. |
| 3 | **High** | A gate process dying between inserting the pending `brain_versions` row (the commit lock) and committing left the lock behind. Every later `promote()`/`commit_brain_version()` failed forever with "being created by another commit". Half-written components (`since == N`, `until == N`) stayed in `brain_nodes`. | `_recover_abandoned(N)`: a pending row older than `KG.ABANDONED_COMMIT_S` (300 s) is deleted, its components (`since == N`) dropped and the ones it retired (`until == N`) un-retired, then the commit proceeds. A fresh pending row is still respected. |
| 4 | **Medium** | After the runner's `spec_hash` changed (the stair retune), a gate run measured in the old env could still be promoted: `_check_promotable` compared patch hashes but not env keys. Results never mixed, but a promotion could carry an old-world verdict into the new world. | `_check_promotable` raises `EnvMismatch` when the run's `env_key` differs from the current runner env (skipped on a client with no runner env, see known limit 3). |
| 5 | **Medium** | `suggest()` returned the first untested value of the first three rows, and rows were ordered by lever group, so all three proposals per round probed the same group. In the 8-round simulation the improver spent rounds 2-8 on `floor_change` (each stair value worse than the last, two settings with no effect at all) and never reached `waiting`, where the next gain was: **one promotion in eight rounds**. | `suggest()` takes one setting per lever group in section C's order, then the groups' second settings. Section C marks a setting **inert** (every value tried on this brain changed no zone on any seed) and sorts it last. Same eight rounds: three promotions, stair optimum found, zone M monotone. |
| 6 | **Medium** | Section C had no memory across versions: a value rejected on v1 was offered again on v2, v3, ..., and the value a promotion had just moved away from (back to 99) was offered too. | Rows carry `rejected_before` (rejected on another brain in this env) and `superseded` (base value of a promotion in this env); those sort to the end of `untested` and appear in a "tried before, no good" column. `suggest()` prefers a setting with fresh values over one with only old ones. |
| 7 | **Medium** | `promote()` accepted a run the gate had never decided on: only `invalid`/`rejected` were refused, so a merely `evaluated` run could become a brain version. Harmless while only the gate calls it; an egregious mistake the day a supervisor agent gets `promote`. | `_check_promotable` requires verdict `passed` or `needs_approval` ("the gate has not decided yet"). Applies to `commit_brain_version(evidence={gate_run_id})` too. |
| 8 | **Medium** | Zone A had no skeleton node (doc 03 listed B, D, M; C was added for the stairwell), but the runner, the fixtures and the sim score zone A on every shift. A fix observed in A fell back to `observed_at: site:main`, the dashboard could not light zone A up, and `get_brain_context("task:A:PICK")` was a `KeyError`. | `SKELETON_ZONES` is now A, B, C, D, M (26 skeleton nodes). `seed()` is idempotent, so an existing database gains the five nodes on its next `seed()`. |
| 9 | **Low** | The evidence `signal` was "the failure type whose count fell most", which is almost always `LATE_TASK`: late tasks are the symptom of nearly every fix, so `explain()` said "Fixed: LATE_TASK" for a stair-threshold change that removed lift jams. | `_evidence_for` ranks throughput leaves (`LATE_TASK`, `DROPPED_DEMAND`) after any other failure type that also fell. |
| 10 | **Low** | `evidence.observed_at` was the zone with the most base-brain episodes of the signal type, and the 10 example episodes were the first by seed and tick, so `explain()` on a fix that helped zones B and D said "seen at zone:B" and listed zone A examples. | `observed_at` is the zone where the candidate removed the most episodes of that type (base minus candidate), and the examples come from that zone first. |
| 11 | **Gap** | There was no one call for "what has this setting been across versions, and why did it move?"; the dashboard would have had to loop `export_brain` over every version. | `kg.history(target)` / `python -m kg history TARGET`: per-version value, and per change the component, gate run, hypothesis, origin, habit, signal, zone M delta and held-out result. |

Issues 1-3 are behaviour bugs, 4-8 keep the demo from doing something silly, 9-10 make `explain()` tell the
truth, 11 is a missing read (`views.history`, `KG.history`, `python -m kg history`).

## Confirmed working (no change needed)

- `since`/`until` versioning: after five promotions every earlier `export_brain(V)` is byte-identical to its
  snapshot at the time, and `get_brain_context(node, version=V)` reads history unchanged.
- The stale-base rule: a run passed on v1 is refused after an unrelated promotion changed the patch, and the
  re-proposal on v2 reuses v2's own shifts as the base (one runner call, not two). A saved preference (no
  patch change) does not stale pending runs.
- Content-addressed ids: a candidate re-proposed is `cached` + `re_proposed`; a value that equals an earlier
  version's patch finds those shifts without re-running.
- Locked edits: simulated with `allow_locked`, `needs_approval`, approval, promotion with the approval
  attached, and the next candidate on that base is no longer flagged. The twin then accepts the approved brain
  without `allow_locked`.
- The held-out firewall: results and seeds never reach the improver client; only the boolean is visible, in
  `brain_versions`, `explain()` and `lineage()`.
- Two threads promoting two passed runs at once: exactly one v2, no pending row left, no duplicate component.
- A runner 422 marks the run `invalid` with the runner's message; the base shifts recorded before it stay.
- A nondeterministic twin is reported per seed in `record_shifts()['nondeterministic']`; the first stored
  result stays the result of record (see "Known limits").
- `ablate(V, component)` is a usable revert path: proposing the ablated brain as the candidate yields exactly
  the edit `target: current -> previous` and promotes normally, as its own component with its own evidence
  (history is never revived or rewritten).
- Raindrop signals: exactly one `gate_passed`/`gate_failed`/`invalid_proposal` per proposal event.

## Known limits (team decisions or other components)

These need a team decision or belong to another component; they are listed so nobody is surprised.

1. **Zone-scoped compiled rules are global for the engine.** The compiled patch is flat (`sim.X`, not
   `zone.M.sim.X`), so a rule at `zone:M` sets the setting for the whole site. Its scope is documentation of
   where the problem was seen. Fix 2 keeps commits consistent with that; the engine would have to grow
   per-zone settings for scope to mean more.
2. **A client without a runner has no env to check against.** The approval agent connects with
   `with_runner=False` and promotes after the call, so fix 4 cannot apply there. `approval_agent/stage_pending.py`
   already calls `use_runner()`; the agent's `kg_calls.py` should do the same when a runner URL is set.
3. **Section C's ranking can pin itself to the consequence of a fix.** After moving to the stairs, "stairs is
   14% of task time" in zone M ranks `floor_change` first for every later version, because the ontology maps
   stair time to that group. Fixes 5 and 6 limit the damage (the improver still explores other groups), but
   the ranking itself is the ontology's; Phase 3's `learn.py` is the intended way to re-rank from promotions.
4. **"rejected" conflates harmful and no-effect.** The gate's reason string says which; section C's inert
   marking covers only the current base and single-edit runs.
5. **A nondeterministic twin is detected but not resolved.** The first stored result per shift id is used for
   every later comparison; the warning and the `nondeterministic` list are the only signals. If the real
   runner turns out nondeterministic, the gate should re-run and compare, or the shift id should include a
   run counter.
6. **The approval agent carries a copy of `kg/`** (`approval_agent/agents/kg-approval/src/kg`, synced by
   `sync_kg.sh`). The sync was rerun with these changes; the deployed agent still needs a redeploy.
7. **Multi-edit candidates are not credited per setting.** A candidate that changes two settings counts both
   as "tested" at their values, but a no-effect result is attributed to neither (we can't tell which was
   inert), and `history()` attributes the change to the one promoting gate run, as it should.
8. **`history()` compiles every version once** (one aggregation per version). Fine for tens of versions; a
   dashboard polling it every second over hundreds of versions should cache by `latest_version()`.
