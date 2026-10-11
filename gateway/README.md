# Robotics Intervention Gateway

A human-in-the-loop voice gateway between an autonomous robotics harness and a human Robotics Lead.

When the harness supervisor finds a problem it can't fix on its own authority, it POSTs a structured incident here. The gateway then:
1. Proactively calls the human. The phone leg is simulated in the dashboard; the voice is a real ElevenLabs agent.
2. Explains the incident.
3. Answers arbitrary questions by querying the supervisor through generic tools.
4. Takes modifications as new proposal revisions.
5. Records an explicit decision against an **exact revision**.
6. Sends that feedback (decision + the human's own words) back to the supervisor exactly once. Executing it is the harness's job.

A live dashboard shows the same state.

Built at the MongoDB "Harness Engineering" hackathon (SF, 2026-10-11) as the approval-call component of the team's self-improving warehouse harness (see `CONTEXT/`).

## Quick start

```bash
npm install
npm test                      # 27 tests (in-memory MongoDB, scripted calls, mock harness) — no network
npm run dev                   # gateway http://localhost:8787 + dashboard http://localhost:5173
```

In the dashboard, pick a scenario and click **Simulate incident**. The softphone rings, and answering starts the voice agent.

Without ElevenLabs credentials, run `npm run simulate:agent -- <incident_id>` to play the agent's tool calls.

## Configuration

Copy `.env.example` to `.env`. The defaults run fully locally:
- `MONGODB_URI=memory` uses an in-process replica set, so **nothing persists**. Set an Atlas URI for durability.
- `HARNESS_MODE=mock`
- `CALL_MODE=simulated`

For live voice, see [docs/ELEVENLABS_SETUP.md](docs/ELEVENLABS_SETUP.md): run `ngrok`, then `npm run provision:agent`.

## Commands

| Command | What |
|---|---|
| `npm run dev` | Gateway (watch) + Vite dashboard |
| `npm test` | All tests |
| `npm run typecheck` / `npm run build` | tsc / production dashboard build into `dist/web` (served by the gateway) |
| `npm start` | Production server (`NODE_ENV=production`; refuses default secrets) |
| `npm run trigger -- <A-E> [--twice]` | Act as the harness: POST a synthetic incident |
| `npm run simulate:agent -- <incident_id> [approve\|reject\|hangup]` | Act as the voice agent over the real tool endpoints |
| `npm run provision:agent` | Create or update the ElevenLabs agent, tools and secret |

## Docs

- [FEASIBILITY](docs/FEASIBILITY.md): what is verified, and how.
- [ARCHITECTURE](docs/ARCHITECTURE.md): boundaries, state machines, data model, failure handling.
- [HARNESS_CONTRACT](docs/HARNESS_CONTRACT.md): what the robotics team must expose.
- [ELEVENLABS_SETUP](docs/ELEVENLABS_SETUP.md)
- [DEMO](docs/DEMO.md)
- [TEST_REPORT](docs/TEST_REPORT.md)
- [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md)

## Not in scope (deliberately)

- Twilio/PSTN (the provider stub is documented).
- Production auth (SSO, signed approvals).
- Multi-instance deployment.
- The supervisor's own reasoning (it is mocked).
