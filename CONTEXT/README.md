# Context: Idea Iteration for the MongoDB SFTechWeek Hackathon

The Harness Engineering & Model Wrangling #SFTechWeek Hackathon, organized by Cerebral Valley with MongoDB as host, Sunday October 11, 2026, Shack15, San Francisco.

## Status: iteration is still in progress

This folder is a snapshot of the team's thinking, not a final decision. The current working idea is a self-improving onboarding harness for warehouse robots. It learns habits from clips of humans, tests every proposed brain change inside a warehouse digital twin, and phones a Robotics Lead through ElevenLabs when a change needs authority the robot does not have. Document 03 ends with four open decisions about the brain's graph that the team has not yet settled, so later documents may still revise what is written here. Each round of feedback produces a new numbered evaluation document, earlier documents are never overwritten, and where two documents disagree, the later one wins.

---

## A note on TwinForge, read this before anyone edits this repository

TwinForge is a pre-existing software project that belongs to Shashwat Mahalanobis, one of this team's own members, kept in its own separate repository on his machine, built before this hackathon's build window opened at 10:30 AM on October 11, 2026. It is not a third party's code and not an open-source project the team found and is appropriating, so no question of rights or permission applies to using it. Inside this hackathon, TwinForge is used strictly as the physics and warehouse simulation substrate: it supplies the warehouse layout, the robot movement engine, the camera views, and the failure injection that the harness is scored against. TwinForge itself contains no self-improving brain, no rule graph, no gate, no ElevenLabs integration, and no MongoDB Atlas usage, because none of that existed before today.

Everything that is new, and everything that is the actual subject of this hackathon submission, is written from inside today's build window. That includes the brain's hierarchical knowledge graph, the versioned rules, guardrails, context policies, and tool grants, the improver that proposes changes to them, the gate that tests those changes against held-out shifts the improver cannot see, the MongoDB Atlas collections that hold all of it, the Raindrop instrumentation, and the ElevenLabs approval call. The event's own participant guide says a team "may not present an existing project as your own work," so the team's obligation is disclosure, not avoidance. The honest way to meet it is to keep TwinForge out of this repository's own commit history and call it from the outside as a simulator the harness runs inside, through the one adapter function the team has already designed, so that every commit in this repository's history is new work made today. Anyone writing the submission's write-up, README, or demo script should describe TwinForge the same way every time, as a warehouse digital twin the team built before the hackathon and is reusing here only as the simulation environment, and should never describe it as something built for this event or leave it unmentioned.

---

## What is in this folder

| File | What it is | What it is for |
| --- | --- | --- |
| `01-warehouse-idea-evaluation.md` (+ `.txt`) | Evaluation round 1 of the warehouse robot onboarding idea. | First fact-based verdict, the correction that Harness the company is not a sponsor, who owns which layer among the sponsor tools, the first brain-graph proposal, and open questions. |
| `02-warehouse-idea-research-and-workflow.md` (+ `.txt`) | Evaluation round 2, built on partner documentation, the New York edition's finalists, and a benchmark of TwinForge. | Chooses TwinForge as the simulator, explains how the improvement will be proven, and gives the end-to-end workflow, sponsor roles, demo script, and team split. |
| `03-brain-hierarchical-knowledge-graph.md` (+ `.txt`) | Evaluation round 3, the detailed design of the robot's brain. | Describes the brain as a hierarchical knowledge graph, its MongoDB collections, the aggregation pipeline that loads it, versioning, permissions, a worked example, and four open decisions. |
| `04-supervisor-dashboard-and-sponsor-depth.md` (+ `.txt`) | Evaluation round 4, written after the team's own workflow notes on a supervisor agent, a launch screen, and a 3D/worker-view dashboard. | Scores that workflow against the criteria, designs the supervisor as a tool-calling harness, researches Raindrop's and MongoDB's newest tools in depth (including Raindrop's own MCP server and MongoDB's new Atlas Managed MCP Server), confirms the judge panel from the team's own photos, and closes with five open decisions. |
| `notebooklm-transcript-formatted.md` | A formatted copy of the brainstorm held the day before the hackathon, in a NotebookLM notebook. The wording is unchanged from the original. | Shows how the idea moved from CI/CD agents, to robotics, to simulation-first robotics, ending on an unrelated gripper concept the team later replaced with the warehouse idea. |
| `hackathon_deep_dive.md` | The research brief an earlier planning session wrote the night before, uploaded as a source to the same NotebookLM notebook. | Background on the event's tracks, judging weights, sponsor tools, past winners, and demo strategy. Read it with the correction below in mind; the Wi-Fi credentials and Discord invite it originally held are redacted from this public copy. |
| `chat-export.txt` | A raw transcript of the team's planning session with Claude Code on the morning of the hackathon. | Shows the actual working process: finding and reading the sources above, correcting the Harness mistake, researching sponsor tools and past winners, and drafting documents 01 through 03. |

## Suggested reading order

1. `04-supervisor-dashboard-and-sponsor-depth.md`, the most current and most detailed document.
2. `03-brain-hierarchical-knowledge-graph.md`, for the brain's design in full.
3. `02-warehouse-idea-research-and-workflow.md`, for the research, workflow, and team split behind it.
4. `01-warehouse-idea-evaluation.md`, for the first verdict and the reasoning that led here.
5. `notebooklm-transcript-formatted.md` and `hackathon_deep_dive.md`, for how the idea got here, with the corrections below in mind.
6. `chat-export.txt`, for the full working process behind all of the above.

## Where new documents go from here

Every document in this list, including this README, is written directly into this folder, `CONTEXT/` at the root of this repository. There is no separate working copy anywhere else; this is the one place to look.

## Known corrections to the earlier material

- Harness (harness.io) is not a sponsor, judge, or partner of this event, even though the deep dive and the NotebookLM brainstorm both say it is. "Harness engineering" in the event's name is the technical concept of engineering the systems around a model: its rules, context policies, guardrails, and tool access.
- The real host is MongoDB, and the product it wants teams to use is Atlas Agent Engine. The judges come from Raindrop, AWS, MongoDB, and Modelence. The partners are Modelence, Raindrop, AWS (Kiro), ElevenLabs, and Cursor.
- The previous edition of this hackathon ran in New York on September 26, 2026, with 98 teams. Its top finishers, Ripple, Offload, and Sightline, all proved their harness's gain on held-out tests with the underlying model held fixed. Document 02 has the details and what it means for this team's approach.
