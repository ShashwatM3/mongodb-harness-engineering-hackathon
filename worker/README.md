# worker: the robot-side agent

The sim server posts an exception (`OBSTACLE_DETECTED`, `FLOOR_CHOICE`) to its mailbox whenever a HUM-1 robot
reaches a decision point. This directory answers those exceptions with one discrete action each.

- `driver.py`: the long-running loop. It long-polls `GET /worker/exceptions?wait=ms`, builds a short prompt
  (robot, kind, ctx, the brain context for `task:<zone>:<type>` from the KG, the SOP), picks an action, and
  `POST`s `/worker/decisions`. One line is printed per decision.
- `mcp_server.py`: a stdio MCP server exposing `get_brain_context`, `get_sop`, `get_playbook`, `report_issue`,
  `get_pending_exceptions`, `decide`. The devin backend attaches it through `.devin/mcp_config.json`.

## Setup

```bash
uv venv worker/.venv --python 3.11
uv pip install -p worker/.venv --exclude-newer 2026-10-04 "mcp<2" httpx raindrop-ai==0.0.73 -r kg/requirements.txt
```

`mcp` is pinned below 2.0 because 2.x renamed `FastMCP`; the resolver picks 1.30.0 under the date cutoff.

## Run

```bash
# against the sim server (default http://localhost:8790)
SIM_SERVER_URL=http://localhost:8790 worker/.venv/bin/python worker/driver.py

# deterministic rules only, no model
WORKER_BACKEND=rules worker/.venv/bin/python worker/driver.py

# offline self-test: one built-in exception, no network, no KG
WORKER_BACKEND=rules worker/.venv/bin/python worker/driver.py --once --fake
```

`--once` handles a single poll and exits; `--wait-ms` sets the long-poll length (default 5000).

## Backends

- `devin` (default): runs `devin -p --model $WORKER_MODEL --respect-workspace-trust false -- "<prompt>"` with
  `cwd=worker/`, so the CLI loads `worker/.devin/mcp_config.json` (the MCP server) and
  `worker/.devin/config.json` (allow-lists the `mcp__twin-worker__*` tools so they run without a prompt). The
  last stdout line is parsed as `{"action", "rationale"}`. Any failure, timeout or bad answer falls back to the
  rules. One devin call is in flight at a time; other pending exceptions are answered by the rules meanwhile.
- `rules`: `battery < 20 → go_charge`; `OBSTACLE_DETECTED`: `wait_ticks > 60 and loaded → wait_at_holding_point`
  else `reroute`; `FLOOR_CHOICE`: `loaded and lift_queue ≤ 1 → take_lift`, `lift_queue ≥ 3 → take_stairs`, else
  `continue`.

## Environment

| Variable | Meaning |
| --- | --- |
| `SIM_SERVER_URL` | mailbox base URL (default `http://localhost:8790`) |
| `WORKER_BACKEND` | `devin` (default) or `rules` |
| `WORKER_MODEL` | model for the devin backend (default `gpt-5-mini`) |
| `WORKER_DEVIN_TIMEOUT` | seconds before a devin call is abandoned (default 90) |
| `WORKER_ROBOT_ID` | reader id for `brain_reads` and Raindrop `user_id` in the MCP server; the driver sets it per exception |
| `KG_MONGODB_URI_IMPROVER`, `KG_DB` | KG connection (read via `kg.load_dotenv()` from the repo `.env`) |
| `RAINDROP_WRITE_KEY`, `RAINDROP_DEV_PROJECT_ID` / `RAINDROP_PROJECT_ID` | enable `report_issue` events |

## Notes

- The devin CLI has no per-project tool-deny switch that we could verify: `permissions.deny` and
  `disabled_tools` in `worker/.devin/config.json` did not stop `echo` in a probe. In `-p` mode with the default
  `--permission-mode auto`, however, only read-only tools are auto-approved, so writes and mutating shell
  commands are rejected anyway (verified: no files were created when asked). Do not pass `--permission-mode dangerous`.
- If the KG is unreachable the driver still answers (brain context is empty); if Raindrop fails nothing is raised.
