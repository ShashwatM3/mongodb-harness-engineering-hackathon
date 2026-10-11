# Demo script

All data is **synthetic**: mock scenarios A–E, labelled SYNTHETIC in the UI. TwinForge is the team's pre-existing warehouse twin. It is referenced only as the simulator the harness runs in, and none of its code is in this repository.

## 0. Setup (once)

```bash
npm install
cp .env.example .env              # set MONGODB_URI (Atlas) or leave `memory`
npm test                          # 39 tests, no network needed
```

For live voice, also follow `docs/ELEVENLABS_SETUP.md`:

```bash
ngrok http 8787                   # copy the https URL into PUBLIC_BASE_URL
npm run provision:agent           # put the printed ELEVENLABS_AGENT_ID into .env
```

## 1. Start

```bash
npm run dev                       # gateway :8787 + dashboard :5173 (open http://localhost:5173)
```

The top bar shows `live`, `harness: mock`, `calls: simulated` and `voice: ElevenLabs` (or `not configured`).

## 2. Main flow: scenario A, trajectory deviation (about 3 minutes)

| Step | Action | What to point at |
|---|---|---|
| 1 | Click **A · Trajectory deviation** in the top bar. This plays the harness supervisor, posting through the same validated path as `POST /v1/incidents`. Alternatively run `npm run trigger -- A --twice`, whose second POST shows `duplicate:true`. | The incident appears and the state goes `calling`. **The softphone rings by itself**: the AI initiated the call. |
| 2 | **Answer** and allow the microphone. | The agent asks for the supervisor code before sharing anything. |
| 3 | Say "two four six eight". | Audit: `identity.verified`. |
| 4 | Agent briefs. Ask an unscripted question: "Why did the robot slow down before it passed the worker?" | Audit: `agent.tool_call ask_supervisor`, then `supervisor.answer`. The answer is labelled measured or hypothesis and comes from the harness, not the agent. |
| 5 | "Was this localization or a planner constraint?" | The supervisor says localization is unlikely (covariance < 3 cm) and gives the evidence id. |
| 6 | "Can I see the trajectory?" | The dashboard jumps to the incident and highlights the lift-lobby segment. Deviation markers at 30 s and 41.2 s. |
| 7 | "What happens if we use 0.6 metres instead of 0.65?" then "Make it 0.6 metres." | The agent confirms the value and unit, then calls `revise_proposal`. **Revision 2** appears live in the dashboard. Nothing is executed (decision table shows MODIFY only). |
| 8 | Optional conflict demo: edit the speed cap in the dashboard and press *Request revision* while the agent still talks about rev 2. Then say "I approve revision 2". | The agent gets `STALE_REVISION`, re-reads, and presents rev 3. A stale approval is impossible. |
| 9 | "I approve revision N." | Decision recorded → "queued for the harness, not applied yet". Banner: *Approved and sent to the harness — not applied until the harness confirms.* |
| 10 | "Has it been applied?" | Execution timeline RECEIVED → VALIDATING → ACCEPTED → EXECUTING → **APPLIED**, plus a result metric (1.03 m separation). Banner turns green. The agent now says it was applied. |
| 11 | Hang up. | The call ends. The incident stays RESOLVED. |

## 3. Generality: same agent, different incidents

- **B · Tote latch** (manipulation): ask "What was the measured grip force and the threshold? When did it fail?" There is no trajectory, and the agent says so instead of inventing a path. Approving leads the harness to report **FAILED** ("rolled back"), and the dashboard turns red.
- **C · Zone M pick** (performance): ask "How does this compare with previous shifts?" The metrics history sparkline goes 140 → 312 s.
- **D · Deadlock** (incomplete evidence): ask "What did the lidar scans show?" The answer is **insufficient evidence** (logs not retained). Ask "Is it localization or the planner?" The supervisor takes 12 s: the agent says it is still analysing (PENDING), then answers that the two can't be distinguished. Expected outcome: *request more information* or *defer*.
- **E · Improver wants…** (envelope change, HIGH risk): a voice approval is **held**. The dashboard shows *Confirm approval*, and only that sends it to the harness.

## 4. Failure demos

- **Hang up mid-call** before deciding: the state goes to *awaiting decision* with the banner "No decision is inferred from a call ending". Use *Call supervisor again* to retry.
- **Don't answer** for 45 s: one automatic retry, then *unreached*.
- **Casual "yes"**: the tool returns `CONFIRMATION_REQUIRED`, and the agent asks for "I approve revision N".

## 5. Without ElevenLabs (offline fallback)

The softphone shows "ElevenLabs is not configured". The loop still runs through the same tool endpoints:

```bash
npm run trigger -- A
npm run simulate:agent -- <incident_id> approve      # or: reject | hangup
```

The script plays the agent's tool calls (verify → incident → question → trajectory → metrics → proposal → revise → decide → execution status). Watch the dashboard update live. Every decision control on the dashboard also works directly.

## 6. Real harness instead of the mock

Set `HARNESS_MODE=http`, `HARNESS_BASE_URL` and `HARNESS_OUTBOUND_TOKEN`, then have the harness POST to `/v1/incidents` with `HARNESS_TOKEN`. See `docs/HARNESS_CONTRACT.md`. No voice or UI changes are needed.
