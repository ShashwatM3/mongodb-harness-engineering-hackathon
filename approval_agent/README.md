# approval_agent: human approval for locked brain edits (Agent Engine)

Doc 05's option 1: improvement rounds stay local next to the runner, and this deployed agent owns the human approval. When the gate gives a run the verdict `needs_approval` (an edit to a locked setting such as `class.HUM-1.max_speed`), this agent does four things:

1. **`approval_context`** loads what the Robotics Lead needs to decide:
   - the locked edit (from → to);
   - its measured effect per zone from the gate run;
   - `current_scores()`;
   - the episodes and habit clip behind the setting (`kg.explain`).
2. **`human_review`** calls `interrupt()`, which suspends the execution with that context and `allowed_decisions: ["approve", "reject"]`.
3. Person C's ElevenLabs call (or the Pending Reviews page) resumes it.
4. **`record_decision`** calls `gate.record_approval(target, value, decision, by, ref)` for each locked edit, then `gate.promote()` when the run is ready. Each `preference: ...` line in the reviewer notes goes to `gate.save_preference(...)`.

The path is fixed, so the graph makes no model calls. A planner node emits the three tool calls, and the stock `ToolNode` runs them. Every KG call therefore goes through `@app.tool`, which means it is audited and appears in Traces. The tools reach the KG only through the **gate** user (`KG_MONGODB_URI_GATE`), and only through functions; there is no raw query tool. Nothing returns held-out data.

## Invoke

Send a message containing the gate run id, for example `approve gr-76cd7ce2a5700aaaacbc7e96`. With no id, the agent picks the newest run waiting for approval.

## Resume from the phone call (Person C)

```bash
curl -X POST "https://agentengine.mongodb.com/api/v1/projects/6acbd17a528cf596070610de/executions/$EXECUTION_ID/resume?workspace_id=ws-6acbf1ccf638d6502445e49e" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"decision": "approve", "reviewer_notes": "call:<call_id>\npreference: Never send a loaded robot up the stairs at lunch"}'
```

- The body is flat: `decision` is `approve` or `reject`, and `reviewer_notes` is optional.
- `call:<id>` in the notes becomes the approval's `ref`.
- Each `preference:` line becomes a brain component.
- Resuming needs the `PROJECT_OWNER` role.

## Deployed

Workspace `ws-6acbf1ccf638d6502445e49e`, first deployed 2026-10-11 13:52. Cluster0 is linked through the Atlas service account `rsi-kg-agentengine`. Both sandboxes use `egress_mode: deny_all`, so the linked cluster is the only reachable destination.

**The platform's own database user** is `agent-engine-ws-…`. `atlas setup` created it with readWriteAnyDatabase; it now has `readWrite@mdb_store_<project>` and `readWrite@mdb_memory_<project>` only, so it can't read `heldout_results`.

**Workspace secrets** select the database:
- `KG_MONGODB_URI_GATE` and `KG_DB`.
- `LLM_API_KEY` and `ANTHROPIC_API_KEY` are placeholders: deploy refuses to run without them, even though nothing calls a model.

To switch databases without redeploying, run from `agents/kg-approval`:

```bash
printf '%s' "$GATE_URI_FOR_DB" | agentengine secret set KG_MONGODB_URI_GATE --stdin --workspace-scope
printf 'kg' | agentengine secret set KG_DB --stdin --workspace-scope --sync      # or kg_demo
```

To test from the CLI:

```bash
agentengine invoke --json --session S "approve gr-…"
agentengine invoke --json --session S --resume '{"<interrupt id>": {"decision": "approve"}}'
```

## Local

```bash
cd approval_agent/agents/kg-approval
./sync_kg.sh                     # copy ../../../kg into src/kg (the build packages only this directory)
agentengine dev up --no-egress   # UI on http://localhost:3000
```

The `.env` file is gitignored and holds:
- `KG_MONGODB_URI_GATE`: the `gate_kg_demo` user;
- `KG_DB=kg_demo` and `KG_RAINDROP=0`;
- `LLM_API_KEY=not-used-no-llm-calls`: the dev stack requires an LLM key variable even though nothing calls a model.

`../stage_pending.py` empties `kg_demo` and stages one locked edit waiting for approval. It never touches the real `kg` database.
