# Iteration 04: Robot Form, the Clips, and Syncing with the Team
October 11, 2026

---

## What this round covers

This document responds to your read-through of iteration 03, Prithviraj's knowledge-graph info packet, his separate expanded-implementation-plan draft, and your questions about the robot form, the clips, and the agent architecture. It also reports one concrete finding from checking TwinForge's actual code directly: the robot class your teammate's settings registry was built against, HUM-1, does not exist in TwinForge today, and the section on robot form below turns that into a plan rather than a problem. Nothing here overwrites earlier iterations; where Prithviraj's packet already answers something iteration 03 left open, this document says so and moves on rather than repeating it.

---

## The demo structure

Your three-beat structure, statistics, then a visual demo using agents launched live plus existing recorded footage so nobody waits, then before-and-after statistics, is a real improvement on the single continuous walkthrough iteration 03 assumed, and it does answer the "demoable in 2-3 minutes" concern, because each beat is short and self-contained rather than one long unbroken run. Mentioning the node light-up in five to seven seconds while explaining what the agents can access, rather than stopping to narrate it, is exactly the right amount of attention for a detail that should read as a visual flourish, not a feature pitch. The one risk in a "go through the whole workflow, naming the sponsor tool at each step" structure is that it can turn into a tour of your architecture instead of a story about the robot getting better, so keep each sponsor mention to the same five to seven seconds you're giving the node light-up, one sentence of what the tool did, not how it works.

Using existing recorded footage for the visual demo beat is the right call given the time pressure, and it is honest as long as you say so, "here is this morning's run" rather than implying it is happening live, since judges have seen enough hackathon demos to forgive a recording and not forgive being misled about one. I'd suggest locking the exact beat order now rather than at 3:30, because "statistics, then visual, then before-and-after statistics" means the before number appears twice, once at the start and once in the comparison, so decide now whether beat 1 is the overall picture and beat 3 is the proof, or cut beat 1 down to one sentence so it doesn't duplicate beat 3.

---

## Direct retrieval over the HKG

I agree with you, and the design already does what you're asking for, which is worth saying plainly so there's no daylight between us on this. get_brain_context(task_node) is not a generalized or fuzzy retrieval, it is the $graphLookup pipeline from the brain graph document, run fresh on every call: it walks up from the exact task node to site:main and returns the exact components attached to those exact nodes, nothing inferred and nothing summarized. Prithviraj's load_brain(V, node_id), which his packet confirms is built and working, is the same thing under a different name, and it even returns which node each component came from, so an agent reading the result can see "this came from zone:M" or "this came from site:main" directly.

The one place I'd push back, gently, is on doing this as several small tool calls where the agent itself walks from task to zone to site one hop at a time, because that would need the agent to re-implement the override rule, deeper node wins, in its own reasoning, and a single wrong inference there is a wrong brain read with no error to catch it. Keeping it as one call that runs the full traversal server-side and returns the exact nodes with their provenance gets you the same directness, the agent is still reading real graph nodes, not a summary of them, while keeping the override logic in code where it can be tested rather than in a language model's judgment on every call.

---

## Robot form: what TwinForge actually has

I checked TwinForge's actual code directly rather than guessing, and found something the team needs to know today. Prithviraj's settings registry is built around a robot class called HUM-1, for example class.HUM-1.max_speed, and his own packet calls this "TwinForge's humanoid overlay." TwinForge's real warehouse spec, the one that actually runs, defines exactly one robot class, AMR-L, wheeled, capacity 4, max speed 1.5 meters a second, and HUM-1 does not exist anywhere in the codebase. This is not a bug in Prithviraj's work, it is an assumption his registry was built on that the live simulator doesn't yet satisfy, and it needs to be resolved before the real runner is wired in, or every locked-setting check and every envelope bound in his registry is checking a robot class that doesn't exist.

This turns out to resolve your robot-form question too, in one move. TwinForge's robot classes are data, defined in the spec JSON, not hardcoded in the engine, and the code comment next to the type says plainly that a class you don't define "retains the original wheeled AMR behavior," which means a new class can override just the visual mesh and keep AMR-L's navigation, physics, and determinism untouched. My recommendation: add one new robot class to the warehouse spec, named exactly HUM-1 so Prithviraj's registry needs zero changes, keep its locomotion identical to AMR-L, and give it a distinctive shell, a visible one or two segment arm with a gripper or suction end effector that plays a short canned animation on pick and place, and a sensor-pod "head" that can double as the status light for the node-light-up moment. That gives you a robot that reads as a real, working machine on camera, doing a visible reach-and-grab instead of a box gliding into and out of existence, without any of the continuous-control or bipedal-balance cost of an actual humanoid, and the on-robot camera now has something worth showing: the arm entering frame, closing on an item, and placing it.

Who does what:
- TwinForge owner (you): add the HUM-1 class to warehouse.json, visual mesh plus arm overlay only, same nav and physics as AMR-L, and wire the canned pick and place animation to the existing pick and place events.
- Prithviraj: no registry change needed, the class id already matches; recheck the five HUM-1 values against whatever you actually ship.
- A real discrepancy to settle either way: AMR-L carries 4 items in the live spec, but the registry's HUM-1 has capacity locked at 1, so decide which is true for the robot you build and fix whichever side is wrong.

---

## Workspace and tasks, given the new robot form

On workspace and tasks, keep the structure exactly as it is, zones B, C, D and M (Prithviraj's packet already added zone C for the stairwell, and I'd accept that, it's already built and it gives the harness a genuine stairs-versus-lift decision to learn, which is a good story beat on its own), and the four task types, PICK, REPLENISH, TRANSPORT, RETURN, since reopening either would mean re-deriving the scoring, the episode types, and the ontology Prithviraj's packet already built around them, for no benefit to the actual complaint, which was about the robot, not the warehouse. But structure isn't the same as emphasis, and two things I checked directly in TwinForge's code change how I'd feature that structure once HUM-1 exists.

First, a robot's capacity in the engine is one scalar compared against one task's load_units, not a count of separate items carried at once, so a realistic animation is one reach, grasp, and place cycle per task, not a tray run collecting several objects in sequence. Second, the rack rendering already places real, distinct cargo boxes at specific heights on every shelf level, seed-stable per run, which means an arm reaching toward a specific box on a specific shelf is something the environment already supports today, not new art anyone has to build.

Those two facts split the four task types into two different visual stories the robot's new form can tell, rather than four roughly equal beats: PICK and REPLENISH are rack interactions, where the arm's grasp against a visible box is the whole story, while TRANSPORT and RETURN are mostly about getting a held item between stations, which is a navigation story, stairs versus lift, queueing, yielding at a doorway. My recommendation is to pair each story with the zone that shows it most cleanly: PICK and REPLENISH in zones B and D, where there's no lift or stairs to complicate the shot, and TRANSPORT (and RETURN where it touches the mezzanine) in zone M against zone C's stairwell, so the demo gets one clean clip-to-habit example from each side instead of diluting across all four task types evenly.

The pairing, concretely:
- PICK, REPLENISH, in zones B and D: the grasp story, the arm reaching a visible shelf box.
- TRANSPORT, and RETURN where it touches the mezzanine, in zone M against zone C: the navigation story, stairs versus lift, queueing, yielding at a doorway.

One more lever exists if you want it, though I wouldn't spend time on it: TwinForge's rack rendering supports three visual themes already, pallet for an industrial warehouse look, gondola for a more colorful retail look, and cold_case for a refrigerated case, so a different visual flavor is a data change, not new engine work, if the team ever wants one. All the scoring, episodes, and ontology are built against the warehouse domain specifically, though, so this is a cosmetic option to keep in your back pocket, not something worth touching given the hours left.

---

## How the supervisor finds failures

No action needed from you here, noted that you'd rather react to a working version than a written plan. The design from iteration 03, Self Diagnostics as a tool call plus the four warehouse-specific categories, stands as the starting point, and Prithviraj's packet confirms the mechanism it depends on, Raindrop signals tagged with brain_version, is already built and working today.

---

## The clips

Filming cannot be delegated to Devin or any coding agent, and that's worth saying plainly since the question deserves a direct answer: Devin writes and tests code, it has no body and no camera, so the two to four short clips of a person doing a warehouse-style action have to be filmed by an actual teammate, right now, on a phone. What is automatable is everything after the raw video exists: turning a clip into a structured habit, steps, timing, the lever it suggests, is exactly the kind of task you can hand to Claude Code or Devin, since it's reading frames and writing structured output to a database, not acting in the physical world.

For what to film, keep it to two or three clips, ten to fifteen seconds each, each showing one specific habit tied to a setting the brain can actually change, for example someone choosing the stairs over a long lift queue (maps to sim.STAIR_MIN_LIFT_QUEUE), someone slowing down and giving way near a person or a blind corner (maps to the locked speed and clearance settings), and someone pausing before a loaded cart rather than cutting in front of it. One addition worth taking from Prithviraj's bigger plan at near zero cost: have the filmed person narrate out loud while they do it, "I'm taking the stairs because the lift line looks long," since a speech-to-text pass on the audio turns into the plain-English reason attached to the habit, which is a better four-hop click path on stage than steps alone.

For storage, Prithviraj's playbook collection is already built and expects exactly this: add_habit(habit_id, text, clip, steps, lever_group) where clip is {uri, t0, t1}, so the video itself needs to live somewhere with a stable URL, not as raw bytes inside a MongoDB document. The fastest option today is MongoDB's own GridFS, which is built into the driver specifically for files too large for a normal document and needs no third-party bucket or API key, so the clip stays inside Atlas and the uri just points at the GridFS file id; whoever is free first should write the upload-and-extract script, since add_habit is already the only interface it needs to call.

---

## Correcting the "ceiling" framing

You're right, and I framed that badly. The approval call isn't an optional lever for pushing the ceiling back, it is core to the workflow, the branch on the right of the trunk in every diagram since iteration 02, always present, not something to reach for only if the fixed clips run out. The only genuinely optional lever is the second one, filming one more clip mid-build if a zone is still stuck after two rounds, and I should have separated that from the call instead of listing them together under one heading.

---

## The ElevenLabs piece, Aseel's branch

The review is back, and this is in much better shape than a first-slice stimulus, it's a full, independently built system: a Fastify gateway, a React dashboard, MongoDB with real transactions, PIN-based identity verification, a browser softphone, ten ElevenLabs webhook tools, and Aseel's own contract document, docs/HARNESS_CONTRACT.md, inside that branch, specifying seven endpoints end to end. Thirty-nine tests pass against real MongoDB transactions with zero external calls, it type-checks clean, and the dashboard builds, so this is tested work, not a prototype.

Nothing on the branch is literally named place_approval_call or save_preference, but the trigger is already a real function that posts a full incident, task, robot, proposal, evidence, not a button wired to nothing, so the contract's actual requirement is already met and exceeded. My recommendation: adopt Aseel's HARNESS_CONTRACT.md as the authoritative shape for this piece instead of retrofitting his branch down to interface-contracts.md's simpler version, since his is built, tested, and strictly more capable, and throwing that away to match a document I wrote as a quick stopgap would be the wrong trade.

What's missing is not on Aseel's side: nobody has built the supervisor's half yet, the code that receives an incident, answers HARNESS_CONTRACT.md's questions about trajectory and metrics, and sends back a decision, since this branch only ships a mock stand-in for that. Whoever owns the supervisor should read docs/HARNESS_CONTRACT.md on that branch directly and build to it, and separately, nobody has run this against a real ElevenLabs key or a real Atlas cluster yet, since the tests use mocked providers and an in-memory database, so a live end-to-end run with real credentials needs to happen before anyone trusts it on stage.

One decision needs your direct answer, and I'd treat it as the most important item in this whole section: the team built the phone leg as a browser softphone, not a real call over a phone network, to avoid Twilio trial-number risk while keeping live voice and tool calls. That is a reasonable engineering trade, but it changes the actual demo moment, a real phone ringing in the room is the specific thing every document since iteration 01 has pointed to as this project's Respondo moment, the audible, physical thing judges remember. Decide now, with the team, whether a laptop or phone screen showing a softphone call still reads as that moment, or whether someone should get a real number working before 3:30, because this is exactly the kind of thing that's cheap to fix today and expensive to discover during rehearsal.

---

## The dashboard: readability as a hard constraint

Noted as a hard constraint, not a preference: whatever ships, no screen shows more than four or five numbers at once, each in large type with one word of label, and nothing competes with the 3D view or the worker-view grid for attention at the same time. The zone scores, the brain version number, and the before and after comparison are the only numbers that need to survive at a glance, everything else, Raindrop quotas, event ids, patch hashes, belongs in a secondary view a judge never has to read.

---

## Raindrop, condensed

Not much to add here, since Prithviraj's packet shows the real integration already goes deeper than iteration 03 assumed: one event per evaluated candidate carrying brain_version and the full edit list, four instrumented signals (gate_passed, gate_failed, re_proposed, invalid_proposal) that need no custom-signal slots, and every send claimed in Atlas first so a signal can never fire twice even with two evaluators running at once. Your Pro trial being active means run_experiment can now call Raindrop's own Triage agent freely for the on-stage comparison without worrying about the fifteen-message Hobby cap. The one gap left against iteration 03's design is get_signals(shift_id) as a single supervisor tool call, since right now the signals exist in Raindrop but nothing wraps them into one read the supervisor can call by shift id, which is a small, low-risk thing to add whenever someone is free. I'd leave Raindrop's scope exactly where it is otherwise; the expanded plan's idea 8, using a second Experiment as a release gate, is worth a look but belongs in the section on that plan below, not as a Raindrop feature in its own right. If you do want one more feature and have the spare half hour, wiring report_issue so it writes through Raindrop's Self Diagnostics tool exactly as iteration 03 specified would close the loop between the worker agent's own capability_gap reports and the supervisor's get_signals call, but it is not required for a working demo.

---

## MongoDB's Managed MCP Server, condensed

Also not much to add, since Prithviraj's packet independently reached the same two build rules iteration 03 flagged, gate stays on a native collection-scoped connection outside MCP, and writes never use aggregate with $merge or $out, which is good confirmation from two directions rather than something either of us assumed alone. The one still-open piece is the same one iteration 03 left open: whether a custom, collection-scoped database role can be assigned to an MCP configuration, which would let the brain-reading agents go through MCP while heldout_seeds stays unreachable by construction instead of by convention; that's the two-minute Atlas UI check nobody has done yet. Creating the MCP configuration itself needs an Atlas Organization or Project Owner, so once you tell me who that is for your team, I can fold that into who owns the setup rather than leaving it as an open question. Beyond that, the brain's aggregate pipeline, including $graphLookup, is confirmed callable through the MCP server's aggregate tool exactly as hoped, so there's a real tool-access story to tell on stage once someone wires it. I'd call MongoDB's depth here settled rather than needing new features, the remaining work is plumbing, not design.

---

## AWS and Modelence

No on AWS, and I'd hold that position firmly: Kiro is confirmed by AWS's own documentation to not be an AWS service, it's a coding IDE for writing your code faster, and there is no AWS runtime API this hackathon asks you to embed in the product. Forcing one in now, with limited hours left, would be exactly the sidecar-for-sanity you told me to avoid, and the AWS judge evaluates engineering quality generally, not a specific AWS integration. So: skip it, and don't spend a minute of build time on it.

Modelence is a maybe, not a yes: it's a real TypeScript and MongoDB framework, but deploying on it cleanly only works if a service is built against its own conventions from the start, and your backend almost certainly isn't that at this point in the day. If whoever owns the backend has ten free minutes near the end and the deploy is genuinely a one-command thing, the $100 credit and the Modelence-judge goodwill make it worth trying, but it should never block or delay anything else, and if it takes longer than ten minutes to find out, stop and skip it.

---

## Open decisions, explained plainly

"Fully open-ended" means the supervisor has no fixed script of which tool to call first, second, third; at every turn it looks at what it knows so far and decides the next tool call itself, the same way Claude Code decides whether to read a file, run a search, or edit next, rather than following a numbered checklist written into the application code. The alternative, "a default order it can deviate from," means the supervisor's instructions describe a typical path, read the shift, compare to the playbook, propose an edit, test it, maybe call the human, commit, as a suggestion in its system prompt, but the model is still free to skip a step, repeat one, or do them in a different order if the situation calls for it; the difference from fully open-ended is only that there's a recommended path written down, not that anything is hardcoded in code. My recommendation is the second one, a default order the model can deviate from, because a demo audience follows a supervisor that roughly walks the trunk you've already designed far more easily than one that could legitimately do anything in any order, and it's still genuinely agentic since the model, not your code, decides whether to follow the order or not.

sop_docs would be a small, separate collection holding one short, fixed reference page per task type, written once this morning, for example a paragraph describing the normal steps of a PICK in plain language, completely separate from the brain's learned rules. The point of it is a fallback: if a worker agent hits an exception and the brain graph has no rule covering it yet, it can check this page instead of guessing from nothing, the same way a new human hire might check an instruction sheet before improvising. Prithviraj's packet already proposes adding it as additive and low-risk, his decision D8, so this is close to settled, not something that needs more design, just someone to write the four short paragraphs.

---

## What are the agents: not wrappers over Devin, Claude Code, or Codex

Not wrappers over Devin, Claude Code, or Codex, and I want to be direct about this because building it that way would be a real mistake: those three are end-user coding-assistant products, built for writing and testing software over a codebase, not for a lightweight agent that needs to make one small decision from a fixed toolbelt every time a robot hits an exception, many times a minute, cheaply and fast. The right building block is the Claude Agent SDK, the same underlying engine Claude Code itself is built on, called directly from your own backend code with your own system prompt and your own tool list, get_trajectories, get_brain_context, and so on, not the Claude Code CLI or app.

This also matches what's already built: Prithviraj's bigger plan deploys the improver as an agent on MongoDB Atlas Agent Engine, using GEPA (a method for having a model reflect on its own attempts and rewrite its approach) as the reflection step, which is a genuinely different and lighter-weight thing than Devin or Claude Code, built specifically for exactly this kind of narrow, repeated, tool-calling loop. If you have Devin and Claude Code open on your machine right now, use them the way you're using me, to write the supervisor and worker agent code, not as the runtime the agents themselves run on.

---

## Prithviraj's knowledge-graph packet

Prithviraj's packet is excellent and unusually honest about what's verified versus assumed, labeling everything "Built" or "needs team nod" rather than presenting a plan as done. It already answers nearly everything iteration 03 and the interface contracts left open: the held-out firewall is real and five layers deep, not just a permission grant, promote() is the only path to a new version and it's gate-only, and the four-hop explain-a-rule click path from the brain graph document is built and returns both data and a markdown summary for the screen. The one correction worth making to his own packet: his "robot form" note frames HUM-1 as an open team-wide question, but having now checked TwinForge directly, it isn't really open, HUM-1 simply doesn't exist yet, and the robot-form section above turns that into exactly what to build.

On his numbered decisions: D1, D3, D4, D5, and D7 are all straightforward yes, accept them as built, they're sound engineering calls and re-litigating them costs time for no benefit. D2, whether context policies and tool grants describe the robot agent or the improver, take his recommendation, the improver, since that's the only version where all four Track 1 items, rules, guardrails, context policies, tool access, actually run as working code rather than two of the four staying theoretical. D6, whether learned-ordering analysis can run after the 14:30 freeze, yes, since it only analyzes data you already have, that's the same rule iteration 03 would apply to any polish step. D8, D9, and D10, the sop_docs collection, the preferences collection, and commit_brain_version as a wrapper over promote rather than a free add or retire call, all yes, they're small, additive, and already match what the interface contracts need.

---

## The expanded-implementation-plan.md: a flag, not an endorsement

One more thing, unprompted, because I think you need to see it before the team commits more hours to it: there's a second document from Prithviraj sitting in SCRATCHPADS/, expanded-implementation-plan.md, that you didn't mention and that I don't think you've seen yet. It proposes a second self-improving loop, an adversary agent that writes harder test scenarios, plus a Harness release pipeline with policy checks, a second Raindrop project, and vector search over time profiles, and it says plainly up front that none of it is agreed by the team and it adds, by its own estimate, seven to nine more person-hours of work on top of an already full day.

My honest read: the adversary idea is genuinely clever and the strongest single addition for the Raindrop RSI prize if it fits, two self-improving loops scored by the same deterministic twin is a real, creditable idea, and its own fallback version, adversary-lite, is small enough to be low-risk. The rest of it, the Harness release pipeline with OPA policies, the second Raindrop project with its own firewall, and the vector-search layer, is a lot of new surface area for the time that's left, and I'd want the whole team to look at it and explicitly say yes before anyone builds toward it, not have it absorbed by default because it's sitting in the repo. If you want my single recommendation: decide on adversary-lite only, today, out loud with the team, and leave the rest as a stretch nobody is building toward unless everything else finishes early.
