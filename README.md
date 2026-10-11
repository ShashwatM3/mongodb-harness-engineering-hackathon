# A self-improving onboarding harness for warehouse robots

This project is a self-improving onboarding harness for a fleet of warehouse robots, built for the MongoDB Harness Engineering and Model Wrangling hackathon on October 11, 2026. The supervisor agent is the harness: it is the one component that changes the robots' rules, guardrails, context policies and tool grants. The robots' brain is a versioned hierarchical knowledge graph stored in MongoDB Atlas, so every old brain can be exported and replayed exactly. Every proposed change is tested on a deterministic digital twin of the warehouse against held-out shifts that the proposer can never see, and only changes that pass a gate are promoted to a new brain version. When a change touches a locked setting, such as the robots' maximum speed, the harness routes it to a human Robotics Lead through an ElevenLabs phone call, and the human's decision flows back into the gate.

## Provenance: what existed before today

The simulator under `sitesim/` is derived from TwinForge, a spec-driven deterministic facility digital twin that team member Shashwat Mahalanobis built before the hackathon's build window opened. It was copied into this repository on October 11, 2026 in one labelled commit, `c2b5054 sitesim: copy TwinForge (pre-existing digital twin, main@60048f3) as the simulator substrate`, which you can find with `git log --oneline -- sitesim | tail -1`. Everything after that commit, in `sitesim/` and everywhere else in the repository, is new work made during the hackathon. The event's participant guide says a team may not present an existing project as its own, so this section exists to draw the line plainly.

TwinForge supplied the warehouse layout, the robot movement engine, the camera views, the 3D dashboard and the failure injection. It did not contain a robot brain, a rule graph, a gate, a runner contract, an ElevenLabs integration or any MongoDB Atlas usage. All of the following was built today on top of it:

- `sitesim/src/harness/`: the headless runner (`/health`, `/run_shift`, `/validate_brain`, `/settings`), the brain compiler, the stairs-versus-lift lever, the seven failure types, the legged `HUM-1` class with an arm and torso lift, the brain panel, the Workers tab and the worker exception mailbox.
- `kg/`: the brain as a knowledge graph in Atlas, with versions, evidence, two database roles and the held-out firewall.
- `harness/`: the Claude Agent SDK supervisor, the gate, the playbook of filmed human habits, and the HTTP routes the gateway calls.
- `gateway/`: the ElevenLabs intervention gateway and its call UI. `approval_agent/`: the Atlas Agent Engine approval agent. `worker/`: the robot-side agent on Devin.

## Architecture

```
                 MongoDB Atlas (kg: brain_nodes, brain_versions, gate_runs, shifts,
                 episodes, playbook, brain_reads, heldout_seeds, heldout_results)
                                   ^                 ^
                      improver role|                 |gate role
                                   v                 v
  Raindrop <-- one event per  +---------------------------------+
  (events, signals,           |  harness  :8000                 |
   Experiments)               |  Claude Agent SDK supervisor    |
                              |  gate.py  (training + held-out) |
                              |  routes B-F for the gateway     |
                              +----------------+----------------+
                                     |                   |
                 run_shift / validate|                   | POST /v1/incidents (A)
                                     v                   v
  +-----------------------------+          +------------------------------+
  | sitesim sim server  :8790   |          | gateway  :8787 API           |
  | runner contract, compiler   |          | call UI  :5173               |
  | /worker mailbox             |          | ElevenLabs voice agent       |
  +-------+-------------+-------+          | four webhook tools           |
          |             |                  +---------------+--------------+
          v             v                                  |
  sitesim dashboard   worker/  (Devin print mode           | B questions, C trajectory,
  :5180 (3D, Brain    + stdio MCP server) answers          | D metrics, E revisions,
  panel, Workers)     OBSTACLE_DETECTED / FLOOR_CHOICE     | F /feedback -> record_approval + promote
                                                           v
                                                       harness /feedback

  approval_agent/  Atlas Agent Engine agent (interrupt -> record_approval -> promote), the documented fallback
```

The harness holds both kg clients. The improver client records proposals and training results, and the gate client is the only one that can read held-out seeds, write verdicts, or promote a brain version.

## How the loop works

1. The supervisor reads the state of the fleet with `current_scores` and `get_trajectories`, which return per-zone scores for zones A, B, C, D and M across the task types PICK, REPLENISH, TRANSPORT and RETURN, plus the failure episodes behind the worst zone.
2. It reads `get_playbook` for that zone's task node, which returns human habits taken from filmed clips, and `get_brain_context`, which walks the graph from task to zone to site and returns every component that applies. Each call to `get_brain_context` is logged to the `brain_reads` collection, which is what lights up nodes on the dashboard's Brain panel.
3. It calls `propose_edit`, which runs `record_proposal` and then `evaluate` on the improver client. `evaluate` runs the base brain and the candidate brain on the training seeds through the deterministic sim server and returns per-zone before and after numbers. The same candidate on the same brain is content-hashed, so a repeat is counted as `re_proposed` and not re-run.
4. It calls `run_gate`, which is `harness/gate.py::decide`. The training verdict refuses the candidate if any zone fell by more than `GATE_TOLERANCE` (default 0.01), refuses it if no zone rose by at least `GATE_MIN_GAIN` (default 0.005), and returns `needs_approval` instead of `passed` if the candidate touches a locked setting.
5. If the training verdict is `passed` or `needs_approval`, `heldout_check` runs base and candidate on the locked `heldout-a` seeds through the gate client only, with `held_out=true` sent to the runner. The numbers are written to `heldout_results` and the supervisor learns only a boolean and a one-line reason. A disagreement turns the verdict into `rejected`.
6. If the verdict is `passed`, the supervisor calls `commit_brain_version`, which is `gate.promote` built from the gate run, and brain version N+1 is written with `since` and `until` fields so nothing is edited in place.
7. If the verdict is `needs_approval`, the supervisor calls `call_robotics_lead`, which posts an incident to the gateway. The human answers the phone, may ask questions (route B), see the trajectory and metrics (C, D), change a value (E), and approve, reject or defer (F). The harness's `/feedback` handler calls `record_approval` and then `promote`, and every sentence the human says is saved as a brain component through `save_preference`.

## The held-out firewall

The proposer must never see the shifts it is judged on, otherwise it could tune to them. The `kg/` package enforces this in five layers:

1. The improver database user has no privileges at all on the `heldout_seeds` and `heldout_results` collections.
2. `record_shifts` accepts only the `train` and `val` splits, so held-out per-seed results can never be stored where the improver reads.
3. On the gate client, `record_shifts` also refuses any seed that is listed in `heldout_seeds`.
4. No view and no context function ever reads held-out data, so `get_brain_context`, `brain_context_markdown` and `current_scores` cannot leak it.
5. Version documents keep only a pass flag; the per-zone held-out numbers live in `heldout_results`, which is gate-only.

## Sponsor usage

- MongoDB Atlas holds the brain, every version, the playbook, the evidence and the locked held-out seeds, and Atlas Agent Engine runs the deployed approval agent in `approval_agent/`, which is kept as the documented fallback approval path.
- Raindrop receives one event per evaluated candidate from `kg/raindrop_sink.py`, with the instrumented signals `gate_passed`, `gate_failed`, `re_proposed` and `invalid_proposal`, and `get_signals(shift_id)` reads them back; Raindrop Experiments compares the v1 and vN cohorts.
- ElevenLabs provides the voice agent and its four webhook tools (`ask_supervisor`, `show_trajectory`, `change_plan`, `send_feedback`) for the approval call in `gateway/`.
- AWS and Modelence are not used.

## Run it

The quickest path is `./dev.sh`, which performs every step below in order, writes logs to `.logs/`, and prints the URLs. `./dev.sh status` shows what is listening and `./dev.sh stop` kills what it started. The manual steps, in dependency order, are:

```bash
# 1. MongoDB. Either set the Atlas URIs in .env, or start a local MongoDB 7.0 in Docker:
kg/tools/test_mongo.sh                       # 127.0.0.1:27027

# 2. Python environments
uv venv kg/.venv --python 3.11
uv pip install -p kg/.venv --exclude-newer 2026-10-04 -r kg/requirements.txt
uv venv harness/.venv --python 3.11
uv pip install -p harness/.venv --exclude-newer 2026-10-04 -r kg/requirements.txt \
  claude-agent-sdk fastapi 'uvicorn[standard]' httpx python-dotenv

# 3. Node packages
(cd sitesim && npm ci) && (cd gateway && npm ci)

# 4. Seed the brain (v1) and the playbook of human habits
kg/.venv/bin/python -m kg seed --v1-brain sitesim/brains/v1.json
harness/.venv/bin/python -m harness.playbook

# 5. Services, each in its own terminal
(cd sitesim && PORT=8790 npx tsx src/harness/server.ts)             # sim server, runner contract
unset ANTHROPIC_API_KEY; harness/.venv/bin/python -m uvicorn harness.app:app --port 8000
(cd gateway && npm run dev:server) ; (cd gateway && npm run dev:web)  # :8787 API, :5173 call UI
(cd sitesim && npx vite --port 5180)                                  # dashboard

# 6. Optional: the live Devin worker for the demo shift
SIM_SERVER_URL=http://localhost:8790 worker/.venv/bin/python worker/driver.py
```

The supervisor runs on the Claude subscription login, so run `claude setup-token` once, export `CLAUDE_CODE_OAUTH_TOKEN`, and keep `ANTHROPIC_API_KEY` unset, because that key would silently outrank the token and bill per token.

### Environment variables

The repository `.env` (gitignored) is read by `kg.load_dotenv()`; the gateway reads its own `gateway/.env`, with `gateway/.env.atlas.example` as the template. For a local MongoDB the two `KG_MONGODB_URI_*` values point at `127.0.0.1:27027`; for the Atlas Sandbox they are replaced by the `mongodb+srv://gate:...` and `mongodb+srv://improver:...` URIs printed by `python -m kg atlas-commands`.

| Variable | File | Meaning |
| --- | --- | --- |
| `KG_MONGODB_URI_GATE` | `.env` | Connection string for the `gate` user, which can read held-out data, write verdicts and promote. |
| `KG_MONGODB_URI_IMPROVER` | `.env` | Connection string for the `improver` user, which has no privileges on held-out collections. |
| `KG_DB` | `.env` | Database name (default `kg`). |
| `KG_RUNNER_URL`, `SIM_SERVER_URL` | `.env` | The sitesim sim server (default `http://localhost:8790`). |
| `GATEWAY_URL`, `GATEWAY_WEB_URL` | `.env` | The gateway API (`:8787`) and call UI (`:5173`). |
| `HARNESS_TOKEN` | both | Bearer the harness sends on `POST /v1/incidents`. |
| `HARNESS_OUTBOUND_TOKEN` | both | Bearer the gateway sends on routes B to F. |
| `KG_RAINDROP`, `RAINDROP_WRITE_KEY`, `RAINDROP_PROJECT_ID`, `RAINDROP_QUERY_API_KEY` | `.env` | Raindrop on/off switch, write key, project, and the separate Query API key for `get_signals`. |
| `HELDOUT_SEEDS`, `FINAL_SEEDS`, `GATE_TOLERANCE`, `GATE_MIN_GAIN` | `.env` | Gate configuration (defaults 301-310, 401-410, 0.01, 0.005). |
| `MONGODB_URI`, `MONGODB_DB` | `gateway/.env` | Gateway persistence; `memory` or an Atlas URI. |
| `HARNESS_MODE`, `HARNESS_BASE_URL` | `gateway/.env` | `http` and `http://localhost:8000` to talk to the real harness. |
| `CALL_MODE`, `TOOL_SECRET`, `PUBLIC_BASE_URL` | `gateway/.env` | `simulated` rings the softphone; the webhook bearer; the https tunnel URL for ElevenLabs. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | `gateway/.env` | Empty means the human decides on the dashboard without voice. |

### Tests

```bash
(cd sitesim && npx vitest run)
(cd gateway && npm test)
kg/.venv/bin/python -m pytest kg/tests -q      # needs kg/tools/test_mongo.sh or KG_TEST_*_URI
```

## Demo script

**Beat 1, statistics.** Open the dashboard at `http://localhost:5180/?spec=warehouse` and show the per-zone scores of brain v1 on the training seeds. Name the worst zone, which is M on the mezzanine, and its dominant failure type, which is the lift queue. Say in one sentence that the brain is a knowledge graph in MongoDB Atlas and that this is version 1.

**Beat 2, a live round.** Press start on the loop (`POST /api/loop/round`) and watch the supervisor transcript stream in. When it calls `get_brain_context`, the nodes light up in the Brain panel from the `brain_reads` collection, and the Workers tab shows the Devin worker answering `FLOOR_CHOICE` exceptions at `?spec=warehouse&worker=1`. If the proposal touches a locked setting, the phone rings at `http://localhost:5173` and the Robotics Lead approves on the call.

**Beat 3, before and after.** Call `GET http://localhost:8000/api/proof`, which runs v1 and the latest brain on the final held-out seed set through the gate client and returns per-zone deltas and a pass flag. Show the Raindrop Experiment comparing the two cohorts. State honestly that the ceiling is set by how many habits the clips contain.

## Team and ownership

- Shashwat Mahalanobis: TwinForge and `sitesim/`, the dashboard, and the overall direction.
- Prithviraj: `kg/` and `approval_agent/`.
- Aseel: `gateway/`.
- The supervisor in `harness/` and the robot-side agent in `worker/` were built in-session on October 11.
