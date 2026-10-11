# Warehouse Robot Onboarding: Evaluation 02
October 11, 2026

---

## What I researched

Before answering your questions, I went through four bodies of evidence, and every claim below traces back to one of them. I read the developer documentation for each partner tool, pulled the finalists of the New York edition of this same hackathon, read research on robots that learn from human video, and inspected and benchmarked your TwinForge project on this laptop.
- Atlas Agent Engine docs: the agent contract, memory, policies and human approval, network egress, and preview limits.
- Raindrop docs: Signals, Self Diagnostics, Experiments, the self-healing loop cookbook, and plan limits.
- ElevenLabs docs: the Twilio outbound call API, webhook tools, dynamic variables, and post-call webhooks.
- The New York edition on September 26 (98 teams), plus SeeDo, NVIDIA Mega, and the Isaac Sim hardware requirements.

---

## Should we still do this idea

Yes, and the research made the case stronger rather than weaker. The New York edition shows that a self-improving harness with a test gate is now the default entry, because nearly every finalist built that same core, so the core alone will not stand out in San Francisco. What none of the six New York finalists had was a fleet of robots, human demonstrations as the source of new rules, and a phone call that is a required step of the loop. Your idea has all three, and your TwinForge project removes the biggest risk, which was not having a simulator that runs on a Mac. The complexity you are feeling is real, but most of it disappears once the robot, the tasks, and the failures are pinned to what TwinForge already does, which is what this document does.

---

## What won in New York

The New York edition had 98 teams, and its top three all evolved their own harness against a grader that the agent could not see. Ripple, which won first, designs circuit boards from plain English and went "from 0/4 to 3/4 on held-out specs with the same model", where held-out means test cases the harness never trained on. Offload, which came second, evolves its own harness "(rules, guardrails, tool scopes, context policy) against a held-out task suite with a no-regression gate", where a no-regression gate rejects any change that breaks a test that used to pass. Sightline, a finalist, "can't cheat because MongoDB locks the answers away", which means the answers sat in a collection the improving agent had no permission to read. Ripple's most memorable moment was killing its worker mid-build and showing the run resume from MongoDB and pass every hidden check.

The lesson for us is that judges rewarded a number they could trust more than a clever loop. Every winner reported a before and after score on unseen cases with the model held fixed, so the only thing that could explain the gain was the harness. Relay, another New York project, already used ElevenLabs to phone residents, and CyclopsDiary, a finalist built around factory workers wearing smart glasses, showed that a physical-world domain can reach the final round. The New York brief did not mention Atlas Agent Engine, while the San Francisco brief names it as the product MongoDB wants to see, so using it well will set us apart from the New York pattern.

---

## Answer 1: How we prove the improvement is ours

You are not overthinking this, because proof of cause is exactly what separated the New York winners from everyone else. TwinForge gives us an unusually strong form of proof, because its engine is deterministic, meaning the same random seed always produces exactly the same shift, robot for robot and tick for tick. That lets us run brain version 1 and brain version 3 on the identical shift with the identical model, so the brain is the only thing that changed. We can prove the gain four ways, and the demo should show at least the first two.
- Held-out shifts: the improver trains on some seeds and is scored on seeds and incidents it never saw, as Ripple did.
- Counterfactual replay: the exact failing shift is rerun with the new brain, and the failure no longer happens.
- Ablation: one learned rule is removed, the score falls back, and that proves the rule itself caused the gain.
- Locked answers: the held-out seeds live in an Atlas collection that the improver's database role cannot read.

---

## The simulator (Answers 4 and 5)

We should use TwinForge, your project in Desktop/main/physical-ai, and drop Isaac Sim and MuJoCo. Isaac Sim needs at least a GeForce RTX 4080 with 16 GB of video memory on Linux or Windows, so it cannot run on a Mac at all. MuJoCo does run on a Mac, but it simulates contact physics for arms and hands, and building a multi-zone warehouse in it would take most of the day. TwinForge already has a 100 by 70 metre warehouse with 20 robots, 2 floors, 2 freight lifts, 184 racks, 16 CCTV cameras, and failure injection, and I measured it simulating a 20-minute shift in 1.4 seconds without rendering, which is about 850 times faster than real time. That speed means an improvement round is limited by the language model calls, not by the simulator.

On industry relevance, the simulator is not the product, and the architecture around it matches what industry already uses. NVIDIA's Mega Omniverse blueprint, which KION and Accenture have adopted, tests "robot brains" for warehouse fleets inside a digital twin before deployment, and its fleet manager talks to robots through VDA 5050, an open standard for commands between a fleet manager and its robots. TwinForge's warehouse layout comes from WareTwin, an open-source reference twin under the MIT license, which answers your question about a popular blueprint, and our harness talks to the twin through one adapter, so the same harness could later target Isaac Sim. One rule needs care: the guide says we "may not present an existing project as your own work", so the demo should state plainly that TwinForge existed before today and that everything that learns was built today.

---

## What the robot is, and how it fails

The robot is one of TwinForge's autonomous mobile robots, called AMRs, which are wheeled robots that carry loads between shelf, packing, sorting, and dock stations. The warehouse already has five zones (A, B, C, and D on the ground floor, and M on a mezzanine reached by lift) and four task types: PICK, REPLENISH, TRANSPORT, and RETURN. I suggest we score three zones, B, D, and M, because M forces every robot through a lift, which gives a naturally low starting score like the 30 percent in your example. A zone's score would be the share of its tasks finished on time, minus a penalty for every safety event. The engine already produces concrete, countable failures that we can show on screen and in the logs:
- Deadlocks, where two robots block each other until the engine's 8-second back-off breaks the tie.
- Lift queue jams, where robots wait in a traffic lane for a freight lift and block other robots.
- Human intrusion events, where a simulated worker enters a zone and robots must replan around them.
- Battery strandings and late tasks, where a robot runs low mid-task or a task misses its on-time limit.

---

## The robot's brain, and where the language model sits

The brain is the set of things Track 1 lists: rules, context policies, guardrails, and tool access, stored as versioned documents in Atlas. Rules and guardrails compile into the engine's existing settings for each zone, for example a lower speed near the lift, a smaller zone capacity, or a longer wait before replanning, so most robot behaviour stays deterministic and fast. The language model acts only at exception points, which are moments the engine flags as abnormal, such as a robot blocked for more than 2.5 seconds, a lift fault, or a worker in the zone. At those moments the robot agent chooses from the tools its brain grants it, such as reroute, wait at a holding point, swap task, or go charge, and the context policy decides which memories it sees. This design keeps a shift to tens of model calls instead of thousands, and it gives the improver four clear things to change.

In Atlas, the brain is the hierarchical graph from the first document: a warehouse node, zone nodes under it, task-type nodes under each zone, and rule, guardrail, and tool-grant nodes under each task type. Each node is a document with a parent_id field, and MongoDB's $graphLookup stage follows those links, so loading everything that applies to a PICK in zone M is one query. Every promoted change creates a new brain version with its diff, the evidence behind it, and its held-out scores, and those versions are the snapshots we compare on stage.

---

## The human footage

The human footage should be clips we film ourselves this morning, because the guide disqualifies projects that "use code, data, or assets you do not have the rights to", and our own clips remove that risk. Each clip shows a teammate doing a warehouse-style task with a cart or a box, for example stopping before a blind corner, waiting beside a doorway instead of in it, or letting a loaded cart pass first. A vision model, meaning a model that reads video or images, turns each clip into a list of named steps and the habits behind them, and those land in Atlas as the human playbook for that task. This matches published research, because SeeDo from NYU turns human demonstration videos into robot task plans with a vision language model and runs them in PyBullet and on a real arm.

The key design choice is that human habits are hypotheses, not answers. A robot cannot copy a person's motion, because the two bodies differ, but it can adopt a person's habits, such as yielding at a blind corner, and the twin then tests whether each habit actually helps. The improver compares the robot's step trace for a failed task with the human playbook for that task, proposes the rule that would close the gap, and the gate keeps the rule only if the held-out score rises. That gives the judges a one-line story: humans show, the robot hypothesises, and the twin decides.

---

## The end-to-end workflow

```
 [Human clips] --vision model--> HUMAN PLAYBOOK (Atlas)
                                        |
 BRAIN vN (Atlas) --compile--> TWIN SHIFT (TwinForge, headless, training seeds)
      ^                                 |  exception point -> robot agent uses a granted tool
      |                                 v
      |                        TRACES + METRICS --> Raindrop signals, Atlas episodic memory
      |                                 |
      |                                 v
      |                        IMPROVER: robot trace vs human playbook,
      |                                  typed edits (rule, guardrail, context, tool)
      |                                 |
      |                                 v
      |                        GATE: replay same seeds + locked held-out seeds
      |                           |                          |
      |                    inside envelope            needs new authority
      |                           |                          |
      |                           |              Agent Engine human approval
      |                           |              --> ElevenLabs call to Robotics Lead
      |                           |              <-- answer saved as preference memory
      |                           v                          |
      +------------ promote BRAIN vN+1 (diff, evidence, scores) <------+
```

The trunk is the vertical line: brain, shift, traces, improver, gate, and new brain. The two branches are the human playbook at the top and the phone approval on the right, and each branch joins the trunk at exactly one point. A policy envelope, as used here, is the set of limits that humans set once and the robot can never change on its own, such as the minimum distance to people, and Agent Engine's product page describes exactly this, with policies that "can't be overridden downstream" and the ability to "route risky actions to human approval". When an edit stays inside the envelope, the gate alone decides, and when an edit needs new authority, the robot calls a human. That second path is what makes the phone call part of the product rather than decoration.

---

## Each sponsor's load-bearing job

- MongoDB: Atlas holds the brain graph, every version, the playbooks, and the locked seeds, and Agent Engine runs the improver.
- Raindrop: each exception decision is an event, failures become signals, and Experiments compare brain versions.
- ElevenLabs: the Twilio outbound-call API places the approval call, and a webhook tool saves the answer to Atlas.
- Modelence (optional): it hosts the headless twin as an API for the agent, which also earns $100 in credits.

Raindrop's Self Diagnostics deserves a specific mention, because its built-in capability_gap category fires when "the task requires a tool, permission, or capability that you do not have". That is precisely the trigger for a tool-access change in Track 1, so the Raindrop judge would see their own feature driving the robot's evolution. Two plan limits matter, because the free plan stops at 1,000 events a month and Experiments needs Pro, so we should start Pro's 14-day free trial or email support@raindrop.ai with "HACKATHON" in the subject, as the resource guide offers.

---

## Your Technical Demo concern

The demo will not be slow, because nothing on stage waits for a full shift to run. The improvement rounds run headless before the demo at about 850 times real time, and on stage we replay only the seconds that matter, at 10 times speed, from a replay that the deterministic engine makes exact. Compared with the New York finalists, most of whom showed dashboards and text diffs, a 3D warehouse with moving robots, a CCTV clip, and a phone ringing in the room give us more to look at, not less. The real risk is the opposite one, which is too many screens, so the 3-minute script should move through five fixed beats:
- 0:00 to 0:20: the problem, then brain v1 on a shift with a lift jam in zone M.
- 0:20 to 0:50: the human clip, the habit the vision model extracted, and the proposed edit.
- 0:50 to 1:30: the gate replaying the failing and held-out shifts, then the approval phone call.
- 1:30 to 2:30: brain v1 against brain vN on a held-out shift, side by side, with zone scores.
- 2:30 to 3:00: the brain diff in Atlas, the Raindrop Experiment, and the sponsor line, then questions.

---

## The impact number

The best sourced numbers I found are useful but come from industry guides rather than primary research, so we should present them carefully. A 2026 guide from Robotomated puts warehouse AMR deployments at 8 to 16 weeks from contract to go-live, and it names system integration and workflow configuration as where "most deployments hit delays". Industry 4.1 reported in July 2026 that about 18 percent of AMR deployments in 2024 and 2025 needed 12 or more weeks of extra integration work, and it concluded that "the robots themselves are reliable. The deployment process is the variable." That last line is close to our pitch in one sentence. A primary source such as an Interact Analysis or McKinsey report would be stronger, but my search tool hit its rate limit before I could find one.

---

## Answers to the questions from document 01

- Robot: one of TwinForge's AMRs, with no physical hardware anywhere on the critical path.
- Zones and tasks: zones B, D, and M across all four task types, with M as the hard zone because of the lift.
- Footage: two to four short clips we film ourselves this morning, one for each habit we want the robot to learn.
- Owners: the team split is in the next section.
- Next document: it should draft the brain schema, the improver prompt, and the gate's exact pass rule.

---

## Team split

- You: the twin adapter, which covers the headless runner, the brain compiler, zone scoring, and the replay view.
- Person B: the improver and the gate, the brain graph and its versions in Atlas, and the Agent Engine deployment.
- Person C: the clip pipeline, the ElevenLabs approval call, Raindrop wiring, and the demo script from 3:30.

The contract between you and Person B is one function that takes a brain and a list of seeds and returns zone scores, failures, and exception traces as JSON. If that contract is written down in the first 30 minutes, Person B can build against a fake runner while you connect the real one, which is the dependency analysis you asked for in your original message.

---

## Open risks to check first

- Agent Engine is in public preview, and its memory needs at least an Atlas Flex cluster, so the sandbox tier must be confirmed.
- Agent Engine sandboxes block outbound traffic by default, so the twin's API host must go on the egress allow-list.
- The phone call needs a Twilio number or a verified caller ID, and a Twilio trial can only call verified numbers.
- TwinForge is prior work, so the repository must show clearly which commits were made today.
- Model calls at every exception could slow a round, so we should cap calls per shift and cache repeated situations.
