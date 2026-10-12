# Iteration 05: Robot Form, the Clips, and the Agent Runtime
October 11, 2026

---

## What this round covers

This document responds to your inline feedback on iteration 04, three of it directly: a real brainstorm on robot form instead of a naming shortcut, a faster and more concrete plan for the clips, and a genuine answer on whether the supervisor should run on Devin, Claude Code, or Codex rather than the Agent SDK. The two small prompts you asked for, for Aseel's real phone call and for Prithviraj's two small additions, are written as their own files, prompt-for-aseel-real-phone-call.md and prompt-for-prithviraj-small-additions.md, both in this folder, ready to send as is.

---

## Robot form, actually deliberated this time

You're right that I converged too fast last round, reusing the name HUM-1 because it was convenient for Prithviraj's registry, not because the team had actually chosen a humanoid form. Here are three real options, with the engineering cost of each, since cost is what actually matters with the hours left.

Option A, a wheeled cart with a visible arm: the AMR-L base unchanged, one arm with a gripper, one grasp-and-place animation. Lowest cost of the three, reads as a competent warehouse robot, not a standout.

Option B, a box-rover with an internal scoop or drawer, your own earlier idea: a sealed body on wheels, a lid or drawer that opens to receive or release an item, no arm at all. Possibly even cheaper to rig than an arm, but the moment itself is quieter, an opening lid reads as efficient, not as a worker doing a task, which is the emotional core of the whole human-habits story.

Option C, a Sunday-Robotics-style torso on a wheeled base, your other earlier idea: the same wheeled, point-mass navigation as AMR-L underneath, nothing new in the engine, but a torso on top carrying two arms and a head or sensor pod. More mesh and rig work than A, two arms instead of one, a torso, a head, but zero new physics, since the base still moves exactly like AMR-L does today.

My recommendation is option C, and here's the actual reasoning, not just a preference. It's the only one of the three that's honestly humanoid enough to call HUM-1, which settles the naming question on its own merits instead of by convenience. It's the most legible on camera next to the human clips, since a human-shaped arm reaching for an item reads the same way to an audience watching both side by side, which is the whole point of the comparison. And the extra cost over option A is bounded and known, more mesh and one more animation, not new engine logic, so it's a real but contained addition given the hours left, not an open-ended one.

Whichever option the team picks, if it isn't genuinely humanoid-shaped, Prithviraj's registry should get its class id renamed to match reality, a small find-and-replace, rather than call something HUM-1 that isn't one. That fully removes the naming objection regardless of which option wins.

---

## Workspace and tasks, now that robot form has real options

You asked for these three decided together against three criteria: on-robot camera detail, failures, and tasks that are multi-faceted and sensible in the real world. The split from the last round still holds under any of the three robot-form options, since it depends on what TwinForge's engine actually does, not on the robot's visual form: PICK and REPLENISH are rack interactions, a grasp against a real, positioned box is the whole story, and TRANSPORT and RETURN are a navigation story, stairs versus lift, queueing, yielding. What does depend on the robot-form choice is how much the camera has to show. Option C's two arms and head give the PICK and REPLENISH beat genuine detail, a two-handed grasp for something that reads as heavier, a single-handed one for something that reads as light, which option A's one arm can't show and option B can't show at all. Lock the robot form first, since the task-and-zone pairing from last round is already a sound answer underneath whichever one you pick.

---

## The clips, properly brainstormed this time

You're right that "somewhere random" was a bad way to leave it, and that wasn't the actual plan, just a plan I undersold. The clips don't need a warehouse, they need a stairwell, an elevator, a hallway, and a doorway, since the habits are about human behavior, choosing stairs when a line looks long, slowing near a blind corner, yielding to someone carrying something, not about warehouse set dressing, and most multi-floor buildings have all four within a two-minute walk of wherever you're sitting right now. One person, one phone, three clips of ten to fifteen seconds each, filmed back to back in one trip: that's a ten-minute errand, not a production, and it doesn't block anyone else's work, since it needs exactly one person for ten minutes, not a team meeting.

One more thing worth saying plainly: the grasp-story clips, for PICK and REPLENISH, don't need the robot-form decision finalized first, since a human clip only needs to show a human habit, careful with something fragile, two-handed with something heavy, not anything about what the robot will eventually look like. That means filming can start in parallel with the robot-form decision rather than waiting on it, which claws back the time this round's back-and-forth cost.

Stock or borrowed footage stays off the table, not because it's slower, because the event's own rules say a team can't use assets it doesn't have the rights to, which is the exact reason document 02 called for filming your own clips in the first place. Skipping video entirely and writing the playbook as plain text without any real clip would be faster still, but it trades away the single most differentiated part of the idea, learning from real human footage rather than training weights, which no team studied in the New York edition did; I wouldn't cut it unless the ten minutes genuinely isn't there.

---

## The agent runtime: Claude Code and the Agent SDK are the same thing, and that changes my answer

You're making a real point and I conceded it too fast to reasoning instead of to fact, so let me be precise this time. Claude Code and the Claude Agent SDK are not two different things to choose between, the SDK is the same engine Claude Code itself runs on, exposed as a library you call from your own code instead of a chat interface you type into. What I was actually objecting to last round was Claude Code's default toolset, file editing, bash, the coding-assistant system prompt, which is wrong for a warehouse supervisor, not the engine underneath it.

Claude Code supports MCP as a first-class extension point and can run headlessly, non-interactively, scripted from your own backend. Point a headless Claude Code session, or the SDK directly, at a custom MCP server that exposes only the supervisor's toolbelt, get_trajectories, get_brain_context, and so on, with no file or bash access at all, and you get something that is honestly "the same harness Claude Code runs on, re-tooled for a warehouse instead of a codebase," which is a more literal, more defensible answer to "is this harness-y enough" than building something unrelated from scratch would be.

On the money question, which is the real constraint, not the conceptual one: Claude Code's CLI can log in with an existing Claude.ai subscription rather than a separate metered API key, and I believe headless, scripted invocations under that same login still draw from the subscription's included usage rather than new billing, though I'd want someone to confirm that holds for repeated automated calls specifically, not just interactive sessions, before the whole architecture leans on it; that's a two-minute check, not a research project. If it holds, running the supervisor as the Agent SDK under your existing login costs nothing beyond what you already pay for, and reaches for Devin or Codex only buys you the same uncertainty about whether either one supports this same pattern as cleanly, which I haven't verified for either and wouldn't want to promise.

My recommendation: use the Agent SDK package directly, not repeated CLI subprocess calls, since a long-lived process avoids the startup cost of launching a fresh Claude Code session for every one of the tens of exception-point decisions a shift makes, while still being the exact same engine and, if the subscription question checks out, the exact same billing you already have.
