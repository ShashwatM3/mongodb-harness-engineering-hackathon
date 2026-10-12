# Prompt for Prithviraj's coding agent: two small additions to kg/

## Context to give the agent

`kg/` in this repository is a built, tested Python package that is the robot's brain, a hierarchical knowledge graph in MongoDB Atlas, documented in full in `SCRATCHPADS/knowledge-graph-info-packet.md`. It's in excellent shape. Two small gaps were found against the supervisor's planned toolbelt in `SCRATCHPADS/iteration-03-supervisor-dashboard-and-sponsor-depth.md` and `SCRATCHPADS/iteration-04-robot-form-clips-and-team-sync.md`. Neither is required for a working demo; do them only if there's spare time.

## Addition 1: a get_signals(shift_id) wrapper

Raindrop already has every signal this needs, tagged with `brain_version` and reachable by its MCP server or SDK, per the Raindrop research in iteration 04. What's missing is a single function in `kg/` with the same shape as the package's other reads, so the supervisor has one call instead of needing to know Raindrop's own query API directly:

```python
def get_signals(shift_id: str) -> dict:
    """Returns the categorized Raindrop signals for one shift: hard metrics
    (deadlocks, lift jams, late tasks) and self-diagnostics reports, already
    grouped by category."""
```

Implementation sketch: query Raindrop (via its MCP server's `list_events` / `search_events`, or the `raindrop-ai` Python SDK already a dependency per the info packet) filtered to the `shift_id` property already being written on events, and return the matching signals grouped by category. Match the return shape to how `get_context` already returns `{markdown, data}` if that's more consistent with the rest of the package's API.

## Addition 2: the two-minute Atlas MCP role check

From iteration 04 and from the info packet's section 5: it's unconfirmed whether a custom, collection-scoped MongoDB role can be assigned as the "Atlas role" on an Atlas Managed MCP Server configuration. If it can, brain-reading agents could go through MCP while `heldout_seeds` stays unreachable by construction instead of only by the gate's native-connection convention.

Steps:
1. In Atlas, create a test custom role granting `find` on `brain_nodes`, `brain_versions`, `envelope`, `concepts`, `gate_runs`, `shifts`, `episodes`, and `playbook` only, explicitly excluding `heldout_results` and `heldout_seeds`.
2. When creating or editing an Atlas Managed MCP Server configuration, check whether that custom role appears as an assignable option, not just the built-in Atlas roles like `readWrite` or `read`.
3. Report back yes or no. If no, no further action is needed, since the gate's existing native, collection-scoped connection already enforces the held-out firewall correctly without MCP's help.

## Done when

`get_signals(shift_id)` is callable and returns real Raindrop data for a shift that has events, and the MCP role question has a definite yes or no answer written down somewhere the team can see it.
