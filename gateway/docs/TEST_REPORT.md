# Test report

Last run: 2026-10-11 13:05 PDT, after the simplification. `npm test` → **27 passed, 0 failed**. `tsc` is clean and the dashboard build succeeds.

## What the simplification changed

**Removed:**
- the identity code;
- execution tracking (no harness execution events and no RESOLVED/FAILED states);
- the HIGH-risk second factor;
- the forced "I approve revision N" read-back.

**Added:**
- plain-language opening summaries;
- full incident context given to the agent up front;
- 4 voice tools instead of 10;
- feedback (decision + the human's words) as the final output delivered to the supervisor.

The tests were rewritten to match.

## Automated tests

These run through real HTTP routes against an in-memory MongoDB replica set. The test code plays the ElevenLabs agent by calling the webhook tools, and the harness is the mock with a deterministic supervisor. No network.

| Area | Result | Asserted |
|---|---|---|
| Proactive trigger | PASS | 201 then `duplicate:true`; three concurrent placements produce one call; 401 on a bad token; 400 on a bad payload with nothing stored |
| One agent, any incident | PASS | The opening is ≤ 2 plain sentences per category (A, B, C); the context contains the robot and the current plan; wrong secret → 401; cross-incident call → 403 |
| Questions | PASS | An unscripted question reaches the supervisor and the grounded answer comes back; missing data → `INSUFFICIENT_EVIDENCE` with no answer; a slow supervisor → `PENDING`, and re-asking returns the answer without asking twice |
| Trajectory | PASS | `trajectory.focus` pushed to the dashboard; with no trajectory, the agent is told "there is none" |
| Changing the plan | PASS | The new revision comes from the supervisor and nothing is sent yet; out-of-range, wrong-unit and supervisor-refused changes create no revision; feedback on an old revision → `STALE_REVISION` with the new plan in words |
| Feedback to the supervisor | PASS | Approve plus the human's words are delivered exactly once despite tool retries and parallel dispatchers; rejection closes the incident; deferral keeps it open; a failed delivery is retried and delivered once |
| Call interruption | PASS | Hang-up → AWAITING_DECISION with nothing sent; tools refused after hang-up; a second tab can't end someone else's call (`CALL_NOT_YOURS`); no answer → one retry → UNREACHED; an answered call whose voice never connects is ended |
| Voice ↔ dashboard | PASS | A dashboard edit makes a voice decision on the old version stale, and vice versa; simultaneous approvals produce exactly one decision |
| Concurrent incidents | PASS | Feedback, plans and calls stay separate |
| Post-call webhook | PASS | Signature verified; redelivery deduped; "Human said approve" in the summary records nothing |
| Units | PASS | Parameter validation, state machine terminals, webhook signature |

## Live checks (real services)

| Check | Result |
|---|---|
| MongoDB Atlas: connect, transactions, gateway boot with indexes | ✓ (`npm run check:setup`) |
| ElevenLabs: key, agent provisioning (secret + tools + agent), signed URL, tunnel reachable | ✓ |
| Live agent, previous design: asked for the code, called `verify_identity`/`get_incident`/`get_proposal`, briefed accurately, routed an unscripted question to `ask_supervisor` | ✓ (two runs; both calls were cut by a second dashboard tab, which is now fixed server-side) |
| Live agent, **new design** | ✗ **Not run.** The session was refused with `quota_exceeded`: the ElevenLabs account is out of credits |
| Offline agent (`simulate:agent`) on the running server, new design | ✓ Scenario B: plain opening → question → no-trajectory notice → plan v2 → approved v2 with feedback → `ACKED`, incident Approved |
| Dashboard rendering (headless Chromium, :5173) | ✓ no console errors after fixing the Vite proxy bug (`'/api'` was also proxying `/api.ts`) |

## Open gaps

- **A live voice run of the new prompt needs ElevenLabs credits.** After adding them, check that:
  - the opening is two sentences;
  - follow-up answers stay short;
  - "approve" mid-sentence works;
  - the feedback text matches what was said.
- **Background-voice robustness is best effort.** It relies on patient turn-taking, interruption-ignore terms, no interruption during tools, browser noise suppression and a prompt rule. ElevenLabs offers no speaker isolation, and this has not been tested with real background talk.
- The real harness and the Claude-grounded mock supervisor are untested (no harness API yet, no Anthropic key).
