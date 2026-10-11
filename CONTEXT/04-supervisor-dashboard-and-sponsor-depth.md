# The Supervisor Harness, the Dashboard, and Sponsor Depth
October 11, 2026

---

## What this round covers

This document responds to the workflow you dictated after document 03: a launch screen, a 3D-to-worker-view dashboard, and a supervisor agent that is the harness. It also folds in two new inputs, the final-round and first-round judge photos you sent, and fresh documentation research on Raindrop and on a MongoDB product that did not exist in document 02's research. Nothing here overwrites documents 01 through 03; it answers your open questions and extends the design onto the new surface you described. The sponsor-tool sections below combine what I confirmed directly with three parallel research passes run specifically to verify and extend them, so every sponsor claim below is checked against current documentation, not carried forward from memory.

---

## Answering your three questions directly

The workflow is not too small, and the supervisor framing actually makes the tree cleaner rather than wider. Its three jobs, reading what happened, comparing it against the human playbook and the hard metrics, and updating the brain, are the same gate-and-improver loop document 02 already designed, now given one voice and a phone number instead of being split across an anonymous pipeline. That means the trunk stays the same single vertical line, brain, shift, traces, decide, update, and the two branches stay the same two branches, the human playbook feeding in from the top and the approval call joining on the right. Nothing in your notes adds a third branch, it only names the thing walking the trunk, which is exactly what the tree criterion is asking for.

On visual, your notes make the demo more visual, not less. The switch between the 3D view and the worker views, the vertically scrolling trajectory under each worker's camera, and the brain lighting up a node when an agent reads it are three new moments, and all three are cheap to build because they are events your backend already produces, not new computation. The risk has flipped from too little to show to too much to show in three minutes, so the demo script should pick exactly one of these three as its featured beat rather than touring the whole dashboard. My recommendation is the node lighting up, because it is the single clearest visual proof that the brain graph is a real, live, queried thing and not a static diagram.

Re-run against your criteria, point by point:
- Genuinely good product: yes, unchanged from document 02's verdict.
- Demoable in 2-3 minutes: yes, if the script picks one dashboard beat, not all three.
- Sponsor tools load-bearing: stronger now, see the sponsor sections below.
- Clear tree, few branches: unchanged, two branches as above.
- Track fit: unchanged, still a direct answer to Track 1.

---

## The supervisor is the harness, and it should be a tool-calling loop

Calling the supervisor agent the harness is the right move, and you should say it in exactly those words during the demo, because Track 1 asks for a harness that evolves its own rules, context policies, guardrails, and tool access, and the supervisor is the one piece of your system that actually touches all four. Framing it as a Claude Code or Devin style loop over a fixed toolbelt is also the right move, and I would go further than you proposed: make the supervisor's entire job a sequence of tool calls with no hardcoded four-step script behind it, so the order of operations is a property of what the supervisor decides to do next, not a diagram written in advance. That is a stronger answer for the Implementation Difficulty criterion than a fixed pipeline, because a judge who asks "what if it finds two different kinds of failure in the same shift" gets a real answer, it calls whichever tool the situation calls for, rather than "the pipeline doesn't handle that." The four-step shape you described, inspect, diagnose against human footage, call the human, update the brain, becomes the typical path through the tools rather than the only path.

Here is the toolbelt I would give it, each one a real function the supervisor can call in any order:
- `get_trajectories(shift_id)` and `get_signals(shift_id)`: pull the shift's step-by-step record and Raindrop's categorized signals for it.
- `get_playbook(task_node)`: read the human habits that apply to a task node.
- `run_experiment(baseline_filter, experiment_filter)`: ask Raindrop to compare two brain versions over logged traffic and return its verdict.
- `propose_edit(component)`, `run_gate(candidate, seeds)`, `commit_brain_version(diff, evidence)`: draft, test, and promote one typed change to the brain.
- `call_robotics_lead(summary, questions)`: place the ElevenLabs approval call when a change needs authority the supervisor doesn't have.

---

## What a worker agent can actually do

Keep the worker agent's physical actions discrete and small in number, because that is what "deterministic, non-continuous" should mean in practice: a fixed list of named moves, not continuous joint control. TwinForge's engine already defines this list for you, since every AMR's tool grants in document 03 are move_to, pick, place, wait_at_holding_point, swap_task, reroute, and go_charge, and the language model only chooses among whichever of these its current brain has granted it. This is also why staying with wheeled AMRs matters for this exact question, because a wheeled robot's whole action space fits in seven verbs, while a hand or an arm would need continuous grasp and trajectory control that no amount of hackathon time will make deterministic enough to reason about cleanly.

Beyond physical actions, give the worker agent exactly three more tools, matching the two kinds of fetch you described plus one Raindrop gives you for free:
- `get_brain_context(task_node)`: the `$graphLookup` pipeline from document 03, which also fires the node-light-up event on the dashboard.
- `get_sop(task_type)`: a short, fixed reference page per task type, the "internal documentation, not the brain" you asked for, written once this morning and never versioned.
- `report_issue(category, detail)`: Raindrop's Self Diagnostics tool, which the SDK generates automatically from category definitions you write, covered in the Raindrop section below.

---

## How the supervisor finds failures, concretely

This was your sharpest open question, and Raindrop answers it directly rather than leaving it to bespoke code. Self Diagnostics turns into a real tool call inside the worker agent itself, not just the supervisor: when you enable it in the SDK's `wrap()` call, Raindrop auto-generates a reporting tool from category definitions you supply, and the agent calls it the moment it recognizes one of those situations, for example "I was asked to wait at a holding point but my current brain has not granted me that tool." Separately, every hard metric your engine already produces, a deadlock, a lift-queue jam, a late task, a safety event, gets sent to Raindrop as an instrumented signal, and any tool call that errors out gets pulled into a signal automatically with no extra code. The supervisor's first tool call after a shift, `get_signals(shift_id)`, returns all of this already grouped and categorized, so finding failures is a query, not an algorithm you have to invent.

Replace Raindrop's default categories, which are written for chat agents, Forgetting, User Frustration, NSFW, with your own, written for warehouse exceptions:
- `capability_gap`: the task needed a tool grant the current brain hasn't given it.
- `guardrail_conflict`: a human habit from the playbook would break a hard guardrail if followed literally.
- `repeated_failure`: the same exception type has now hit this task node twice or more in one shift.
- `sop_gap`: the worker checked both the brain and the SOP page and found no guidance for the situation.

---

## The ceiling on improvement, given fixed clips and fixed tasks

You are right that the clips and the tasks are fixed, but that does not cap the improvement the way it first sounds like it would, because what the brain learns is not the clips themselves, it is when and where to apply the handful of habits inside them. A held-out shift tests a seed the improver never trained on, not a habit it never saw, so a real gain on held-out seeds proves the brain generalized a known habit to a new situation, which is the same proof structure Ripple and Offload used in New York. The honest limit is real, though: once every zone's habits have been correctly generalized, the curve flattens, because there is nothing left in the fixed clips to extract. That is fine for a demo that only needs two or three rounds of visible climb, and worth saying out loud to the judges rather than hiding, since a team that understands its own ceiling reads as more credible than one that claims unlimited learning.

Two things push the ceiling back further if you want them. The approval call is a second, non-fixed source of new information, since a Robotics Lead's live preference was never in any clip and becomes a new brain component the moment the call ends. If a zone is still stuck after two rounds, filming one more ten-second clip targeted at exactly that failure, on the spot, during the build, is a legitimate and fast way to raise the ceiling again, and doing it live on camera is itself a strong demo beat.

---

## The approval call as a real conversation

Build this as an actual ElevenLabs conversational agent, not a one-shot announcement, because your notes describe a real back-and-forth and ElevenLabs's agent platform is built for exactly that, turn-taking, interruption handling, and tool calls, confirmed in document 02's research. Give the call agent its own small toolbelt, `get_current_scores()` and `get_failure_clip(id)` so it can answer a Robotics Lead who asks "show me what happened," and `save_preference(text)` so a new instruction the human gives mid-call is written to Atlas before the call ends, not transcribed afterward and maybe lost. The call should open with the supervisor's three-sentence report, what finished, what failed, what it wants to change, then stop talking and let the human drive, exactly like you wrote it. This is now confirmed rather than assumed: ElevenLabs's webhook tools let the agent decide mid-conversation whether to call one, based on its system prompt and what has been said so far, not only at call setup, and they support both reads and writes, so `get_current_scores` and `get_failure_clip` run as GET webhook tools and `save_preference` runs as a POST webhook tool that writes straight to your backend before the call ends. A separate mechanism called client tools exists for browser-side code and does not apply here, since this is a phone call, so webhook tools are the one primitive this piece needs.

---

## The dashboard: what to strip, and the two new views

Strip anything that authors or edits the scenario, a zone editor, a seed picker beyond the one launch screen, a raw engine console, because those are tools for someone building TwinForge, not for someone watching your harness run. Keep anything that narrates what is happening right now, the camera, the per-robot status list, the live KPI numbers, the event log, since those are exactly what a judge watching the demo needs to read without narration. Whoever owns the dashboard should spend five minutes looking at TwinForge's actual component tree before cutting anything, since I have not inspected it directly and don't want to guess at file names.

Rank the three new pieces by demo value per minute of build time, highest first:
- The brain node lighting up on a fetch: highest value, lowest cost, since it is one websocket event plus a pulse effect on an existing graph view.
- The worker-view trajectory feed: good value, moderate cost, and TwinForge's existing 16 CCTV cameras from document 02 do most of the hard part already.
- The launch screen for picking agent count and tasks: lowest priority, build the real thing if time allows, but the actual demo run can use a hardcoded selection without losing anything judges can see.

---

## Workspace, tasks, and robot form, decided together

Stay with TwinForge's wheeled AMRs, zones B, D, and M, and the four task types from document 02, and treat this as settled rather than open, because every hour spent on this round of design is an hour not spent building, and changing the robot's physical form now would mean redoing engine work with no time left to recover. A wheeled AMR's action space is seven discrete verbs, which is exactly the "deterministic, non-continuous" shape you asked for, where a hand or a humanoid would need continuous grasp and balance control no one on the team has time to make legible on stage today. The on-camera views of AMRs moving through aisles, queuing at the lift, and yielding at a doorway are already visually rich enough for the worker-view grid and for a direct side-by-side against the human clips, so nothing about the new UI plan argues for a different robot form either.

If the team still wants a physical hardware beat at the very end of the demo, the Sim2Real pattern from your NotebookLM brainstorm still works on top of this, verified kinematic parameters push to one real AMR or rover for a few seconds at the end, but that is a finale decision for the last hour, not a build-order decision for right now.

---

## Raindrop, used to its full depth

Raindrop supports almost the entire supervisor loop natively, and three findings from this morning's research change how I'd wire it up. Raindrop exposes its own MCP server at `https://mcp.raindrop.ai/mcp`, reachable by API key for a non-interactive backend agent, not only for a human in Slack or an IDE, which means `run_experiment` in the supervisor's toolbelt can be a literal call to Raindrop's `ask_agent_question` tool, phrased in plain language such as "compare brain_version:1 against brain_version:3 on held-out seeds," and Raindrop's own Triage agent turns that into a saved comparison and a verdict. The same MCP server also exposes direct query tools, `list_events`, `search_events`, `get_trace`, and others, for anything the supervisor needs to read without going through Triage. This is as load-bearing as sponsor integration gets: Raindrop's own agent is doing real reasoning inside your agent's loop, not just storing logs for you to query yourself.

Two things need correcting from my earlier assumption. First, calling Triage costs a separate messages quota, fifteen a month on the free Hobby plan, five hundred on Pro, distinct from the event quota, so running a comparison after every improvement round all morning would exhaust Hobby's fifteen before the live demo even starts; start the fourteen-day Pro trial directly rather than waiting on an email reply, since Pro's five hundred messages and full Experiments access removes this risk entirely. Second, Raindrop's Trajectories view has no embed or widget API, so the worker-view trajectory feed should be built from your own episode records already written to Atlas, not from a Raindrop panel projected onto the dashboard; keep Raindrop's own view as an internal debugging surface for your team, not something judges see directly.

Two build details worth having in hand:
- Tag every event with a custom property, for example `properties: { brain_version: 3, seed_set: "heldout" }`, passed on the SDK's `begin()` or `trackAi()` call, since that property is what Experiments filters on.
- If the agents run on the Claude Agent SDK, the `@raindrop-ai/claude-managed-agents` wrapper auto-traces tool calls and injects the self-diagnostics reporting tool automatically, which is less code than wiring the plain SDK by hand.

---

## MongoDB's new Managed MCP Server, and two build rules

MongoDB announced the Atlas Managed MCP Server as generally available on August 13, 2026, a MongoDB-hosted remote server that lets an agent read and write Atlas data as tool calls, with nothing for you to run, and its tool list is confirmed and specific: find, aggregate, count, insert-many, update-one, update-many, delete-many, plus collection and index management. The aggregate tool runs arbitrary pipelines, which means document 03's `$graphLookup` brain-loading pipeline is callable as a single MCP tool call, so the brain itself becomes something your agents reach through a tool rather than a database query, exactly the kind of tool-access depth Track 1 is asking for. For a programmatic agent, an Atlas Organization or Project Owner creates an MCP configuration scoped to a chosen Atlas role, with a read-only flag that simply removes write tools from what the client sees when set, and your agent authenticates with the client credentials that configuration issues.

Two rules protect you once this is wired up. The access-control limit I flagged before is real and confirmed current, the Managed MCP Server's configuration only scopes at the project level in the documented path, so the safe default stays what document 03 already assumed: give the gate's one read of `heldout_seeds` a direct, collection-scoped native connection outside MCP entirely, never through a configuration a worker or the improver could also reach. There may be a narrower path around this, since MongoDB's native custom database roles support collection-level scoping independent of MCP and the MCP configuration's "Atlas role" field may accept one, but this is unconfirmed, so whoever owns the brain's permissions should spend two minutes checking it against the live Atlas UI rather than assuming it. Separately, never write to the brain through aggregate with a `$merge` or `$out` stage, even though aggregate is marked read-only, because a `$merge` stage can write to any collection the identity can reach regardless of what the pipeline looks like on its face; use `insert-many` and `update-many` for every brain write instead, so the permission boundary stays legible to anyone reading the code.

Agent Engine itself is confirmed still in public preview, needs at least an Atlas Flex cluster with M10 or larger recommended, and is a distinct, complementary product from the Managed MCP Server, a full agent lifecycle platform next to a hosted data-access layer, which matches the split document 03 already proposed: Agent Engine for the Robotics Lead's preferences and similar episodes, plain collections reached through the MCP server for the brain itself.

---

## The judge panel, and what AWS and Modelence are for

Your photos confirm the final round judges exactly as document 01 already had them: Steffan Mejia from MongoDB, Jackson Ferrigno from Raindrop, Bosco Albuquerque from AWS, and Aram Shatakhtsyan from Modelence, so nothing changes there. The first round has a much larger panel, mostly MongoDB staff plus one more name each from AWS and Raindrop, and four guest judges from OpenAI, krea.ai, Apple, and two smaller companies, none of whom bring a sponsor tool into this hackathon's stack. None of this adds a fifth sponsor to design around; being well-engineered is what satisfies those four guest judges, not a forced integration.

This morning's research confirms both AWS and Modelence stay exactly where document 02 placed them, with more precision than before. Kiro, AWS's offering, is confirmed by AWS's own documentation to not be an AWS service at all, it is a cloud-agnostic, spec-driven coding IDE meant to help you write code faster, so there is no AWS runtime API this hackathon is asking you to embed, and forcing one in would be exactly the sidecar you told me to avoid. Modelence is confirmed as a real TypeScript and MongoDB framework with its own auth and database conventions, and deploying on it is close to free only if a service is built against those conventions from the start, not if an already-built Node service is retrofitted onto it later, so treat it as a same-day decision for whoever starts the backend, not a last-hour add-on.

---

## Open decisions for you

- Do you want the supervisor's tool-calling loop fully open-ended, or should it keep a default order it can deviate from, since a demo audience follows a typical path more easily than a fully free one.
- Has the team started Raindrop's fourteen-day Pro trial yet, since Hobby's fifteen Triage messages a month will not survive a full morning of improvement rounds.
- Who owns the Managed MCP Server setup, since it needs an Atlas Organization or Project Owner to create the configuration before anyone else can use it, and who will spend the two minutes checking whether a custom collection-scoped role closes the `heldout_seeds` gap.
- Should the `sop_docs` collection be written by a person this morning, or should the improver draft it from the human clips for a person to edit.
- Are the worker and supervisor agents built on the Claude Agent SDK, since if so the `@raindrop-ai/claude-managed-agents` wrapper is less code than wiring Raindrop's plain SDK by hand.
