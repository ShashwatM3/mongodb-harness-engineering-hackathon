<div align="center">

<img src="docs/readme/banner.svg" alt="Self-Improving Warehouse Robots: the robots' brain lives in MongoDB Atlas and rewrites itself" width="100%">

<br/>

[![MongoDB Atlas](https://img.shields.io/badge/MongoDB_Atlas-brain_graph-00684A?logo=mongodb&logoColor=white)](#-the-brain-is-a-knowledge-graph)
[![Atlas Agent Engine](https://img.shields.io/badge/Atlas_Agent_Engine-approval_agent-00684A?logo=mongodb&logoColor=white)](#-a-human-signs-off-by-phone)
[![ElevenLabs](https://img.shields.io/badge/ElevenLabs-voice_approval-111111?logo=elevenlabs&logoColor=white)](#-a-human-signs-off-by-phone)
[![Raindrop](https://img.shields.io/badge/Raindrop-signals_%26_experiments-6d28d9)](#-architecture)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](#-run-it)
[![TypeScript](https://img.shields.io/badge/TypeScript-twin_%26_gateway-3178C6?logo=typescript&logoColor=white)](#-run-it)

**[The idea](#-the-idea-in-30-seconds)** ·
**[See it](#-see-it-running)** ·
**[First result](#-the-first-result-measured)** ·
**[How it works](#-how-it-works)** ·
**[Architecture](#-architecture)** ·
**[Run it](#-run-it)** ·
**[Repo map](#-where-everything-lives)**

</div>

> [!NOTE]
> Built at the **Harness Engineering & Model Wrangling #SFTechWeek Hackathon** (hosted by MongoDB, organized by Cerebral Valley, Shack15 San Francisco, October 11, 2026), for **Track 1: Recursive Harnessing**.

<br/>

## 🧭 Pick your path

| If you have… | Read this |
| --- | --- |
| ⏱️ 30 seconds | [The idea in 30 seconds](#-the-idea-in-30-seconds) |
| ☕ 3 minutes | [See it running](#-see-it-running), then [the first result](#-the-first-result-measured), then [How it works](#-how-it-works) |
| 💻 15 minutes and a terminal | [Run it](#-run-it) |
| 📚 an afternoon | [The design docs, in reading order](#-design-docs) |

<br/>

## 💡 The idea in 30 seconds

New warehouse workers don't learn the job from a manual. They watch the people around them: take the stairs when the lift line is long, slow down at a blind corner, give way to someone carrying something heavy. Robots get a config file.

We built a **harness** around a fleet of robot worker agents. Their shared **brain** is a hierarchical knowledge graph in **MongoDB Atlas**, and it improves after every shift:

| | Step | What happens |
| :-: | --- | --- |
| 🚀 | **Launch** | On the dashboard, choose how many robot agents to run and give each one a task. |
| 🤖 | **Work** | The agents work a shift in the TwinForge digital twin, using small, discrete physical actions. They can look things up in the internal docs or in the brain, and every brain lookup lights up that node on screen. |
| 🔍 | **Review** | When the shift ends, each agent's trajectory and report go to the **supervisor agent**. It checks whether the tasks were completed, reads the metrics, and walks every trajectory step by step to find the failures. |
| 🎥 | **Learn** | For each failure, the supervisor checks CCTV clips of people doing the same work and drafts a change to the brain. |
| 📞 | **Call** | The supervisor phones the Robotics Lead through **ElevenLabs**: here is what went wrong, and here is what I want to change. The Lead can ask questions, push back, or add new instructions. |
| 🧬 | **Update** | The supervisor writes the agreed change into the brain as a new version, with its evidence. The next shift starts from the improved brain. |

The model underneath stays fixed. What evolves is the harness around it: its rules, guardrails and tool access. That is what Track 1 asks for.

<br/>

## 🎬 See it running

The dashboard wraps TwinForge. A launch screen sets the number of agents and each one's task. The shift then runs in a stripped-down 3D view with per-agent stats. A switch moves between the **3D view** and the **worker views**, a grid of each robot's on-camera view with its live, scrollable trajectory. The **brain panel** lets you navigate the knowledge graph, and a node lights up whenever an agent reads it.

<div align="center">
<img src="docs/readme/brain-live.gif" alt="Brain Live: the knowledge graph improving from brain v1 to v5" width="100%">
<br/>
<sub><b>Brain Live</b>, the brain improving itself from v1 to v5. Hexagons are brain components, the ring marks the human-set limits, and the right column streams the loop's reasoning.<br/>
</sub>
</div>

<br/>

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/readme/twinforge-3d.png" alt="TwinForge 3D warehouse with a legged robot fleet, two floors and two freight lifts">
<p><b>The digital twin.</b> TwinForge's 100 × 70 m warehouse has two floors, two freight lifts, 184 racks and 20 robots, and every shift is deterministic per seed. We added a stairwell and a legged robot class that can climb it.</p>
</td>
<td width="50%" valign="top">
<img src="docs/readme/twinforge-compare.png" alt="The same shift replayed under brain v1 and brain v2 side by side">
<p><b>Same shift, two brains.</b> Held-out seed <code>208299103</code> replayed under brain v1 (lifts only) and v2 (take the stairs when someone is already at the lift). Zone M's end-of-shift score goes from <b>0.42 to 0.65</b>.</p>
</td>
</tr>
</table>

<details>
<summary><b>🔍 Click to open: how one learned rule explains itself</b></summary>
<br/>

<img src="docs/readme/brain-live-explain.png" alt="Brain Live explain panel for the learned stairs rule">

Click any hexagon and the brain walks its evidence in four hops. This is a single aggregation in Atlas (`kg.explain`):

1. **Learned from** the human clip and the habit it produced, with that habit's helpful and harmful counters.
2. **Fixed** the failure episodes it targeted, here `LIFT_QUEUE_JAM` in zone M, with seed and tick for each.
3. **Proved by** the gate run that measured it, with per-zone deltas and how many seeds improved.
4. **Held-out** check: pass or fail only. The numbers stay sealed in the vault.

</details>

<br/>

## 📈 The first result (measured)

The first lever we tested is the one a person spots first. In brain v1 the fleet **never** takes the stairs (`sim.STAIR_MIN_LIFT_QUEUE = 99`), so robots on the mezzanine (zone M) queue for the freight lift and fall behind the ground-floor zones.

<table>
<tr>
<td align="center" width="33%"><h3>0.481 → 0.529</h3><sub>Zone M score on 12 <b>held-out</b> seeds,<br/>brain v1 → v2</sub></td>
<td align="center" width="33%"><h3>1–5 → 0</h3><sub>Lift-queue jams per held-out seed.<br/>v2 has zero on <b>all 12</b></sub></td>
<td align="center" width="33%"><h3>−0.002</h3><sub>Worst change in any other zone.<br/>Nothing else got worse</sub></td>
</tr>
</table>

The sweep also showed why the held-out gate exists. **The best setting on training seeds did not hold up on held-out seeds:**

| Brain variant | Zone M, training seeds 1–12 | Zone M, 12 held-out seeds | |
| --- | ---: | ---: | --- |
| v1: lifts only | 0.417 | 0.481 | baseline |
| Stairs when ≥ 1 robot is at the lift, empty-handed robots only | **0.495** 🥇 | 0.481 | best on training, gain gone on held-out ❌ |
| Stairs when ≥ 2 robots are at the lift | 0.473 | 0.489 | gain mostly gone ❌ |
| **Stairs when ≥ 1 robot is at the lift** (brain v2) | 0.459 | **0.529** 🥇 | holds up, so it was promoted ✅ |

> [!IMPORTANT]
> These numbers come from a hand-run sweep in the twin (`npm run sweep`, work package WP-T), which uses the same runner contract the loop calls. The gain is about one standard error (zone M sees about 190 tasks over 12 seeds), and single seeds move either way (7 up, 1 level, 4 down). The steadier effect is on the lifts: zero jams on every held-out seed. Full tables are in TwinForge's README.

<br/>

## 🔁 How it works

### The workflow

```mermaid
flowchart TB
    launch["🚀 Launch screen<br/>number of agents, a task each"]:::human
    subgraph shift["🏭 In the twin"]
        agents["🤖 Robot worker agents<br/>discrete physical actions"]:::harness
        sop["📄 Internal docs"]:::twin
        brainq[("🧠 The brain<br/>hierarchical knowledge graph")]:::atlas
    end
    sup["🕵️ Supervisor agent<br/>tasks · metrics · trajectories"]:::gate
    cctv["🎥 Human CCTV clips"]:::human
    phone["📞 ElevenLabs call<br/>with the Robotics Lead"]:::human
    update[("🧬 Brain v N+1<br/>in MongoDB Atlas")]:::atlas
    ui["✨ Dashboard<br/>3D view · worker views · brain"]:::obs

    launch --> agents
    agents -->|"look up"| sop
    agents -->|"look up: the node lights up"| brainq
    agents -->|"trajectories + reports"| sup
    sup -->|"failures"| cctv
    cctv -->|"learnable insight,<br/>proposed change"| phone
    phone -->|"agreed change<br/>+ the Lead's preferences"| update
    update -->|"next shift"| agents
    agents -.-> ui
    brainq -.-> ui

    classDef atlas fill:#00684A,stroke:#00ED64,color:#ffffff
    classDef harness fill:#1e3a8a,stroke:#60a5fa,color:#ffffff
    classDef twin fill:#334155,stroke:#94a3b8,color:#ffffff
    classDef gate fill:#92400e,stroke:#f59e0b,color:#ffffff
    classDef human fill:#9a3412,stroke:#fb923c,color:#ffffff
    classDef obs fill:#5b21b6,stroke:#a78bfa,color:#ffffff
```

### One shift, call by call

```mermaid
sequenceDiagram
    autonumber
    actor U as 👤 Operator
    participant D as ✨ Dashboard
    participant W as 🤖 Worker agents
    participant K as 🍃 Brain in Atlas
    participant S as 🕵️ Supervisor
    actor L as 👷 Robotics Lead

    U->>D: launch: number of agents, a task each
    D->>W: start the shift in the twin
    W->>K: get_brain_context(task node)
    K-->>D: brain_reads: that node lights up
    W->>W: discrete actions: move, pick, place, wait, charge
    W->>S: trajectories + reports
    S->>S: tasks done? metrics? step-by-step trajectories
    S->>K: human habits from the CCTV clips for each failure
    S->>L: call: these failed, I want to change this. Any preferences?
    L-->>S: questions, feedback, approval
    S->>K: commit_brain_version(add, retire, evidence)
```

### Under the hood: checking a change before it lands

Every brain change is a typed setting edit, and the knowledge graph only commits one that names the evaluation behind it. A change can be replayed in the twin on training seeds and on sealed held-out seeds before it becomes a new version.

<details>
<summary><b>🔁 Click to open: the life of one gate run</b></summary>
<br/>

```mermaid
stateDiagram-v2
    direction LR
    [*] --> invalid: refused at proposal
    [*] --> cached: same candidate already measured
    [*] --> new
    new --> evaluated: runner numbers filled in
    evaluated --> passed
    evaluated --> rejected
    evaluated --> needs_approval: touches a locked setting
    needs_approval --> ready_to_promote: Robotics Lead approves
    needs_approval --> rejected: Robotics Lead declines
    passed --> promoted: promote, new version
    ready_to_promote --> promoted
    promoted --> [*]
```

- **`invalid`**: unparseable, unknown setting, out of range, a `spec` or `fixed` setting, or a no-op. It never reaches the runner.
- **`cached`**: the same candidate proposed twice is one gate run, so a repeat never earns a second "pass" in Raindrop.
- **`needs_approval`**: a locked edit is not refused. The runner simulates it anyway (`allow_locked`), so the phone call can quote its effect.

</details>

<details>
<summary><b>🧪 Click to open: the worked example, brain v1 → v2, as documents</b></summary>
<br/>

In v1 the fleet never takes the stairs. Robots queue for the lift, and the jams land in `episodes` as `LIFT_QUEUE_JAM`, mostly in zone M. A habit from the clips says "skip the lift when it is queued." The improver proposes a threshold, the gate passes it, and `promote` writes v2. Nothing is edited in place:

```jsonc
// v1 component, retired (until: 2)
{ "_id": "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1", "compiles_to": { "op": "set", "target": "sim.STAIR_MIN_LIFT_QUEUE", "value": 99 },
  "since": 1, "until": 2 }

// v2 component, added (values illustrative)
{ "_id": "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2",
  "kind": "rule", "parent_id": "site:main", "key": "sim.STAIR_MIN_LIFT_QUEUE",
  "label": "Take the stairs when 2+ robots wait for the lift",
  "compiles_to": { "op": "set", "target": "sim.STAIR_MIN_LIFT_QUEUE", "value": 2 },
  "since": 2, "until": null,
  "evidence": { "gate_run_id": "gr-…", "signal": "LIFT_QUEUE_JAM",
                "episode_ids": ["ep:sh-…:LIFT_QUEUE_JAM:4120", "…"],
                "observed_at": "zone:M", "origin": "habit",
                "habit_id": "habit:skip-lift-when-queued" } }
```

`load_brain(2, "task:M:PICK")` returns the v2 rule. `load_brain(1, "task:M:PICK")` still returns the v1 rule, so every old brain replays exactly.

</details>

<br/>

## 🧠 The brain is a knowledge graph

The brain is not a prompt or a weights file. It is a **tree of scopes** with **typed components** hanging off it, plus **evidence edges** that make it a graph. It lives in one Atlas database, and one `$graphLookup` + `$lookup` aggregation loads everything that applies to a task.

```mermaid
flowchart TB
    site(["🏭 site:main"]):::scope
    site --> zB["zone:B"]:::scope
    site --> zC["zone:C<br/>stairwell"]:::scope
    site --> zD["zone:D"]:::scope
    site --> zM["zone:M<br/>mezzanine"]:::scope
    zM --> t1["task:M:PICK"]:::task
    zM --> t2["task:M:REPLENISH"]:::task
    zM --> t3["task:M:TRANSPORT"]:::task
    zM --> t4["task:M:RETURN"]:::task

    site -.- r2{{"📐 rule · v2 →<br/>STAIR_MIN_LIFT_QUEUE = 2"}}:::rule
    site -.- g1{{"🔒 guardrail · v1 →<br/>HUM-1.max_speed = 1.2"}}:::guard
    site -.- r1{{"🦴 rule · v1 → v2<br/>STAIR_MIN_LIFT_QUEUE = 99"}}:::fossil

    r2 -. "evidence" .-> gr[("⚖️ gate run")]:::ev
    r2 -. "evidence" .-> ep[("💥 10 episodes<br/>LIFT_QUEUE_JAM")]:::ev
    r2 -. "evidence" .-> hb[("🎥 habit<br/>skip the lift when queued")]:::ev

    classDef scope fill:#0f766e,stroke:#5eead4,color:#ffffff
    classDef task fill:#134e4a,stroke:#2dd4bf,color:#ffffff
    classDef rule fill:#1d4ed8,stroke:#93c5fd,color:#ffffff
    classDef guard fill:#b45309,stroke:#fcd34d,color:#ffffff
    classDef fossil fill:#475569,stroke:#94a3b8,color:#e2e8f0,stroke-dasharray: 4 3
    classDef ev fill:#6d28d9,stroke:#c4b5fd,color:#ffffff
```

<sub>Every zone has the same four task nodes. Only zone M's are drawn. Today every component attaches at `site:main`, because the engine applies each setting fleet-wide. Where a problem was seen is kept in `evidence.observed_at`.</sub>

| Idea | How it works |
| --- | --- |
| **Four component kinds** | `rule` (an editable setting) and `guardrail` (a locked setting that needs a human) are populated. `context_policy` and `tool_grant` are reserved. |
| **Typed, runnable edits** | Every component carries `compiles_to: {op: "set", target, value}`. Free-text "when/then" can't run, so the engine only ever sees typed edits. |
| **Versions without edits** | Components are never changed. Each has `since` and `until`, so brain *N* is every component active at *N*, and any old brain replays exactly. |
| **Content-addressed IDs** | Shifts, gate runs and episodes are hashes of what produced them (engine SHA, spec hash, brain patch hash, seed). Re-running the same thing is a cache hit, never a duplicate. |
| **A concept ontology** | Trees of failure types, where time goes, outcomes and levers rank what the improver should try next. The worst zone's biggest non-productive time sink comes first. |
| **One projection** | The runner only ever receives `export_brain(V)`. Nobody hand-builds a brain JSON. |

<details>
<summary><b>🎛️ Click to open: everything the brain is allowed to change</b></summary>
<br/>

```mermaid
mindmap
  root((The brain's levers))
    floor_change
      STAIR_MIN_LIFT_QUEUE
      STAIR_MAX_LOAD
      LIFT_RETRY_TICKS
      LIFT_XFLOOR_PENALTY_M
    waiting
      WAIT_REPLAN_TICKS
      WAIT_BACKOFF_TICKS
    energy
      CHARGE_AT_PCT
      assign.W_BATTERY
    dispatch
      assign.W_DISTANCE, W_WORKLOAD
      assign.W_CONGESTION, W_HEALTH
      zone capacities
      IDLE_TO_PARK_TICKS
    motion 🔒 needs a phone call
      HUM-1 max_speed
      PERC_STOP and PERC_SLOW
    yielding
      empty on purpose, a capability gap
    manipulation
      GRASP_SPEED_PCT per shelf level, placeholder
```

Each setting has a **status**: `editable` (the brain may set it within [min, max]), `locked` (it may differ from v1 only after a human approves the exact value), `fixed` (never approvable, for example the minimum robot separation) or `spec` (describes the building, like stair climb time, so the brain never sets it).

The **`yielding`** group is empty on purpose. No setting expresses "give way to another robot", so a habit from the clips that lands there is reported as a *capability gap* rather than hidden.

</details>

<details>
<summary><b>🗄️ Click to open: the collections and how they connect</b></summary>
<br/>

```mermaid
erDiagram
    brain_versions ||--o{ brain_nodes : "since / until"
    brain_nodes ||--o{ brain_nodes : "parent_id"
    envelope ||--o{ brain_nodes : "bounds and approvals"
    gate_runs ||--o{ shifts : "measured by"
    shifts ||--o{ episodes : "one per failure"
    brain_nodes }o--o| gate_runs : "evidence.gate_run_id"
    brain_nodes }o--o| playbook : "evidence.habit_id"
    gate_runs ||--o| heldout_results : "gate only"
    concepts ||--o{ concepts : "ontology tree"
    brain_reads }o--|| brain_nodes : "dashboard feed"
```

| Collection | Holds |
| --- | --- |
| `brain_nodes` | The scope skeleton plus every component, versioned |
| `brain_versions` | One document per version: parent, added, retired, hypothesis, approvals, `heldout_passed` |
| `envelope` | Bounds, status and approval history for each setting |
| `concepts` | The ontology: failures, time, outcomes, levers |
| `gate_runs` | One per evaluated candidate, with per-zone base, candidate and delta |
| `shifts`, `episodes` | Raw per-seed results for training and validation seeds, and one document per failure |
| `playbook` | Human habits from the clips, with helpful and harmful counters |
| `brain_reads` | Every `get_brain_context` read, so a dashboard can light up the node being read |
| `heldout_results`, `heldout_seeds` | 🔒 Gate only. The improver cannot read them at all |

</details>

<br/>

## 🔒 The held-out firewall

Promising "we test on data the optimizer never saw" is easy. Our guarantee is that **MongoDB itself refuses the read**. The knowledge graph opens one client per database user:

```mermaid
flowchart LR
    I["🤖 Improver<br/>user improver · role kgImprover"]:::harness
    G["⚖️ Gate<br/>user gate · readWrite"]:::gate
    subgraph db["🍃 Atlas database"]
        B[("brain_nodes · brain_versions<br/>envelope · concepts · playbook")]:::atlas
        E[("gate_runs · shifts<br/>episodes · brain_reads")]:::atlas
        H[("🔒 heldout_results<br/>heldout_seeds")]:::sealed
    end
    I -->|"find"| B
    I -->|"find · insert · update"| E
    I -. "✖ no privileges at all" .-x H
    G -->|"readWrite"| B
    G -->|"readWrite"| E
    G -->|"readWrite"| H

    classDef atlas fill:#00684A,stroke:#00ED64,color:#ffffff
    classDef sealed fill:#7f1d1d,stroke:#fca5a5,color:#ffffff
    classDef harness fill:#1e3a8a,stroke:#60a5fa,color:#ffffff
    classDef gate fill:#92400e,stroke:#f59e0b,color:#ffffff
```

It has five layers, so no single mistake breaks it:

1. **Database**: the improver's role has no privilege on `heldout_*`, and `probe_heldout_denied` checks for the "unauthorized" error.
2. **Code, on input**: `record_proposal` and `record_shifts` accept only `split="train"` or `"val"`.
3. **Code, on the gate side**: `record_shifts` refuses to store a shift for any seed listed in `heldout_seeds`.
4. **Code, on output**: `get_context` and every view never read `heldout_*`.
5. **Shape**: `brain_versions` keeps only the boolean `heldout_passed`. The per-zone numbers go to the sealed collection.

> [!TIP]
> We checked whether Atlas's new Managed MCP Server could be scoped to these collection-level roles. It can't: an MCP configuration gets project-level roles only. So no agent in the improver loop gets an MCP configuration with data access, and the gate keeps its own native connection.

<br/>

## 📞 A human signs off by phone

After every shift, the supervisor phones the **Robotics Lead**. It says what the agents did, what failed, and what it wants to change in the brain, then lets the person drive the conversation. Edits to locked safety settings, like raising the fleet's top speed (`class.HUM-1.max_speed`), cannot land without that approval.

```mermaid
sequenceDiagram
    autonumber
    participant S as 🕵️ Supervisor
    participant W as 📞 Intervention<br/>Gateway
    participant E as 🗣️ ElevenLabs<br/>voice agent
    actor L as 👷 Robotics Lead
    participant K as 🍃 Brain in Atlas

    S->>W: POST /v1/incidents: failures + proposed change
    W->>E: start the call with the briefs
    E->>L: "Your agents finished. Here's what failed, and here's what I'd change…"
    L->>E: "Why? Show me what happened."
    E->>W: ask_supervisor, show_trajectory
    L->>E: "Make it 1.3 instead."
    E->>W: change_plan, proposal revision 2
    L->>E: "Approve that, but keep an eye on trip times."
    E->>W: send_feedback(revision 2, APPROVE, their words)
    W->>S: decision + feedback, sent exactly once
    S->>K: update the brain: new version + the Lead's preferences
```

<sub>Values are illustrative.</sub>

There are two pieces:

- **The Intervention Gateway** ([`aseel-eleven-lab`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/aseel-eleven-lab)) is a Fastify + React app. It places the call, gives the voice agent four webhook tools, records **APPROVE / REJECT / DEFER** against an exact plan revision, and delivers the decision back to the harness exactly once through an outbox. Silence or a dropped call is never read as a decision.
- **The `kg-approval` agent** ([`approval_agent/`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/kg/integration/approval_agent)) is a LangGraph workflow deployed on **Atlas Agent Engine**, with durable state and `deny_all` egress. It holds a change to a locked setting: it pauses at a `human_review` interrupt, then writes the approval and promotes the brain. It makes no model calls. An approval covers one exact value inside the setting's bounds and can never move the bounds.

<details>
<summary><b>🛠️ Click to open: the voice agent's tools and the incident lifecycle</b></summary>
<br/>

| Tool | What it does |
| --- | --- |
| `ask_supervisor(question)` | Asks the harness. Returns `ANSWERED`, `INSUFFICIENT_EVIDENCE`, `PENDING` (after 8 s) or `UNAVAILABLE`, so the agent never makes up an answer. |
| `show_trajectory(segment?)` | Pushes the robot's path onto the Robotics Lead's dashboard. |
| `change_plan(parameter_key, new_value, unit?, reason?)` | Creates a new revision of the proposal. |
| `send_feedback(revision, APPROVE \| REJECT \| DEFER, feedback?)` | Records the decision against that exact revision, with the person's own words. |

```mermaid
stateDiagram-v2
    direction LR
    [*] --> CALL_PENDING: POST /v1/incidents
    CALL_PENDING --> CALLING
    CALLING --> UNREACHED: no answer
    CALLING --> IN_CALL: answered
    IN_CALL --> APPROVED: APPROVE
    IN_CALL --> REJECTED: REJECT
    IN_CALL --> DEFERRED: DEFER
    IN_CALL --> AWAITING_DECISION: hung up undecided
    AWAITING_DECISION --> CALLING: "Call me" redial
    AWAITING_DECISION --> APPROVED: decided on dashboard
    AWAITING_DECISION --> REJECTED: decided on dashboard
    APPROVED --> [*]
    REJECTED --> [*]
```

<sub>Simplified. Two partial unique indexes in MongoDB enforce one active call and one final decision per incident.</sub>

Telephony has three modes. `simulated` (the default) rings a softphone in the dashboard and opens a real ElevenLabs browser session. `twilio` places a real outbound call through ElevenLabs' Twilio integration or a SIP trunk, and only to allow-listed numbers. `scripted` is for tests.

</details>

<br/>

## 🧩 Architecture

```mermaid
flowchart TB
    subgraph dash["✨ Dashboard"]
        launch["🚀 Launch screen"]:::obs
        views["3D view · worker views<br/>brain panel"]:::obs
    end

    subgraph agents["🤖 Agents"]
        workers["Robot worker agents"]:::harness
        sup["🕵️ Supervisor agent"]:::gate
    end

    subgraph twin["🏭 TwinForge · pre-existing"]
        engine["Simulation engine<br/>+ runner API"]:::twin
    end

    subgraph atlas["🍃 MongoDB Atlas"]
        kgdb[("The brain · HKG<br/>+ evidence")]:::atlas
        ae["Agent Engine<br/>kg-approval agent"]:::atlas
    end

    subgraph voice["📞 Intervention Gateway"]
        gw["Fastify API<br/>+ dashboard"]:::human
        el["🗣️ ElevenLabs<br/>voice agent"]:::human
    end

    cctv["🎥 Human CCTV clips"]:::human
    lead["👷 Robotics Lead"]:::human
    rd["📈 Raindrop"]:::obs

    launch --> workers
    workers <--> engine
    workers -->|"get_brain_context"| kgdb
    workers -->|"trajectories, reports"| sup
    cctv --> sup
    sup -->|"call"| gw
    gw <--> el
    el <-->|"phone or softphone"| lead
    sup -->|"commit_brain_version"| kgdb
    sup -.->|"locked settings"| ae
    kgdb -.->|"brain_reads"| views
    engine -.-> views
    sup -.->|"events, signals"| rd

    classDef atlas fill:#00684A,stroke:#00ED64,color:#ffffff
    classDef harness fill:#1e3a8a,stroke:#60a5fa,color:#ffffff
    classDef twin fill:#334155,stroke:#94a3b8,color:#ffffff
    classDef gate fill:#92400e,stroke:#f59e0b,color:#ffffff
    classDef human fill:#9a3412,stroke:#fb923c,color:#ffffff
    classDef obs fill:#5b21b6,stroke:#a78bfa,color:#ffffff
```

<sub>Dotted lines are designed or prototype connections.</sub>

### What each sponsor tool does here

| Tool | Its job in this project |
| --- | --- |
| 🍃 **MongoDB Atlas** | Holds the whole brain: scope tree, versioned components, evidence, ontology, playbook. `$graphLookup` loads a task's brain in one aggregation, and collection-level roles enforce the held-out firewall. Brain writes use insert-many and update-many only, never `$merge` or `$out`, so the write path stays easy to audit. |
| 🤖 **Atlas Agent Engine** | Runs `kg-approval`, the durable approval workflow that pauses for a human before a locked setting changes. |
| 🗣️ **ElevenLabs** | The conversational voice agent that phones the Robotics Lead, answers questions through webhook tools, and records the decision. |
| 📈 **Raindrop** | Gets one `candidate_brain` event per proposal and signals (`gate_passed`, `gate_failed`, `re_proposed`, `invalid_proposal`), so the pass rate per round, repeats and wasted proposals are visible. Real and dev projects are kept apart. `get_signals(shift_id)` reads them back by category. Raindrop is never on the critical path. |
| 🧠 **Claude** | The model behind the agents and the gateway's voice agent. The model is held fixed while the harness around it improves. |

<br/>

## 📂 Where everything lives

The work is split across branches. This README is on `main`.

| Where | What's there |
| --- | --- |
| [`main`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/main) | This README, the design docs ([`CONTEXT/`](CONTEXT/), [`SCRATCHPADS/`](SCRATCHPADS/)) and an early snapshot of `kg/` |
| [`kg/integration`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/kg/integration) | 📦 The current [`kg/`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/kg/integration/kg) knowledge-graph package and its tests, plus [`approval_agent/`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/kg/integration/approval_agent) for Atlas Agent Engine |
| [`aseel-eleven-lab`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/tree/aseel-eleven-lab) | 📞 The Intervention Gateway: ElevenLabs approval call, dashboard and softphone |
| TwinForge, `hackathon/humanoid-twin` | 🏭 The simulator and today's additions to it. A separate, private repository (`ShashwatM3/physical-ai`), kept out of this repo's history on purpose |

<details>
<summary><b>📁 Click to open: the folder tree</b></summary>

```text
mongodb-harness-engineering-hackathon/
├── README.md                     ← you are here (main)
├── CONTEXT/                      fixed background: brainstorm, research brief, planning chat
├── SCRATCHPADS/                  the live design docs (iteration rounds + focused docs)
├── docs/readme/                  images for this README
│
├── kg/                           (kg/integration) the brain as a knowledge graph
│   ├── core.py                   connect(), proposals, evaluate, verdicts, promote, contract calls
│   ├── ontology.py, registry.py  scope skeleton, concept trees, settings registry
│   ├── views.py                  get_context, explain, lineage, graph snapshot
│   ├── db.py, hashing.py         collections, roles, indexes, content-addressed ids
│   ├── runner.py                 HttpRunner → fake runner → fixtures
│   ├── raindrop_sink.py          events and signals, never on the critical path
│   ├── gepa_adapter.py           evaluators for a GEPA optimizer
│   └── tests/                    unit and phase tests on a real MongoDB 7.0
├── approval_agent/               (kg/integration) LangGraph agent on Atlas Agent Engine
│
└── src/server, src/web, agent/   (aseel-eleven-lab) Intervention Gateway + ElevenLabs agent config
```

</details>


<br/>

## 🚀 Run it

Each piece runs on its own. Start with the knowledge graph: it needs only Docker and Python.

<details open>
<summary><h3>1. The knowledge graph (60-second demo)</h3></summary>

```bash
git clone https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon.git
cd mongodb-harness-engineering-hackathon
git checkout kg/integration

# Python 3.11 environment
uv venv kg/.venv --python 3.11
uv pip install -p kg/.venv --exclude-newer 2026-10-04 -r kg/requirements.txt

# a throwaway MongoDB 7.0 on 127.0.0.1:27027
kg/tools/test_mongo.sh

# the whole story on the fake runner, in about 3 seconds
kg/.venv/bin/python -m kg demo --uri "mongodb://root:kgtestroot@127.0.0.1:27027/?authSource=admin"

# the tests
kg/.venv/bin/python -m pytest kg/tests -q
```

> [!WARNING]
> MongoDB 8.x won't start on Linux kernels 6.19 and newer (SERVER-121912), so the script uses `mongo:7.0`. Set `KG_TEST_MONGO_IMAGE=mongo:8.0` on an older kernel. `mongomock` can't run `$graphLookup`, so the tests need a real MongoDB.

**Against Atlas** (once, needs a Project Owner). Atlas refuses `createUser` and `createRole` over a driver connection, so the CLI prints Atlas CLI commands instead:

```bash
kg/.venv/bin/python -m kg atlas-commands --project-id <PROJECT_ID>
export KG_MONGODB_URI_GATE='mongodb+srv://gate:<pw>@<cluster>/'
export KG_MONGODB_URI_IMPROVER='mongodb+srv://improver:<pw>@<cluster>/'
kg/.venv/bin/python -m kg setup      # collections, indexes, seed, and a check that the firewall holds
```

<details>
<summary><b>The <code>python -m kg</code> commands</b></summary>

| Command | What it does |
| --- | --- |
| `setup` | Creates collections and indexes, seeds the brain, checks the held-out firewall |
| `atlas-commands` | Prints the Atlas CLI commands for the improver role and both users |
| `seed` | Idempotent seed of skeleton, concepts, envelope and brain v1 |
| `sync-settings` | Pulls the runner's `GET /settings` into the envelope |
| `context V` / `suggest V` | What the improver sees for version V, and what to try next |
| `brain-context NODE [-v V]` | The supervisor's read of one task node |
| `explain ID` / `lineage V` | Rule → clip → episodes → gate run, and the version chain |
| `signals SHIFT_ID` | Raindrop's signals for one shift, by category |
| `snapshot V [--compare-to N]` | Nodes and links JSON for a UI |
| `export V` | The brain exactly as the runner receives it |
| `check-v1 FILE` | Go/no-go hash check against TwinForge's `brains/v1.json` |
| `demo` | The whole story on the fake runner (the database name must contain "demo") |

</details>

<details>
<summary><b>The Python API in five lines</b></summary>

```python
import kg
imp  = kg.connect("improver")   # proposals, shifts, context, brain reads
gate = kg.connect("gate")       # verdicts, promotion, held-out, approvals

p = imp.record_proposal(1, {"sim.STAIR_MIN_LIFT_QUEUE": 2}, origin={"source": "habit"}, round=1, policy="p1", split="train")
imp.evaluate(p)                                  # runs only what is missing on the runner
gate.record_verdict(p.gate_run_id, "passed"); gate.promote(p.gate_run_id)
```

The supervisor-facing contract calls are `get_brain_context(task_node_id, version?)`, `commit_brain_version(add, retire, evidence)`, `get_signals(shift_id)`, `record_approval(target, value, decision, by, ref)` and `save_preference(text, by, ref)`.

</details>

<details>
<summary><b>Environment variables (names only)</b></summary>

| Variable | Purpose |
| --- | --- |
| `KG_MONGODB_URI_GATE`, `KG_MONGODB_URI_IMPROVER` | One connection string per database user |
| `KG_DB` | Database name (default `kg`) |
| `KG_RUNNER_URL` | The real TwinForge runner. Without it, the fake runner, then saved fixtures |
| `TWINFORGE_DIR` | The TwinForge checkout, for the fake runner |
| `KG_ENV_EPOCH` | Bump when the twin's stair costs are retuned |
| `RAINDROP_WRITE_KEY`, `RAINDROP_PROJECT_ID`, `RAINDROP_DEV_PROJECT_ID` | Raindrop events, routed to the real or the dev project |
| `RAINDROP_QUERY_API_KEY` | Reading signals back for `get_signals` |
| `KG_RAINDROP=0` | Turn Raindrop off |

</details>
</details>

<details>
<summary><h3>2. The TwinForge runner</h3></summary>

TwinForge is a private repository. With access:

```bash
npm install
npm run serve        # runner on :8787  (POST /run_shift, /validate_brain, GET /settings, /health)
npm run dev          # the 3D twin on :5174
npm run -s shift -- --brain brains/v2.json --seeds 1,2,3     # one batch from the command line
npm run -s sweep     # the go/no-go table
```

Then open `http://localhost:5174/compare.html?start_tick=5200` for the side-by-side replay, and point the knowledge graph at the runner with `export KG_RUNNER_URL=http://localhost:8787`.

</details>

<details>
<summary><h3>3. The Intervention Gateway (ElevenLabs)</h3></summary>

```bash
git checkout aseel-eleven-lab
npm install
cp .env.example .env
npm run dev                         # API + dashboard on :5173, in-memory MongoDB by default
npm run trigger -- A                # simulate an incident (scenarios A–E)
npm run simulate:agent -- <incident_id> approve    # an offline call: approve / reject / defer / hangup
npm test
```

For a live voice call, set `MONGODB_URI` (Atlas), `ELEVENLABS_API_KEY`, an https `PUBLIC_BASE_URL` (`npm run tunnel`) and `TOOL_SECRET`, then run `npm run provision:agent` and `npm run check:setup`. `docs/DEMO.md` on that branch has the full call script.

> [!CAUTION]
> The gateway's API defaults to port **8787**, the same port as the TwinForge runner. If both are running, start the gateway with `PORT=8797 npm run dev`. The dashboard proxy follows `PORT`, but `npm run tunnel` is hard-wired to 8787.

</details>

<details>
<summary><h3>4. The approval agent (Atlas Agent Engine)</h3></summary>

```bash
git checkout kg/integration
cd approval_agent/agents/kg-approval
./sync_kg.sh                       # copy kg/ into src/kg (the build packages only this directory)
agentengine dev up --no-egress     # local playground on http://localhost:3000

# approve a waiting gate run from the CLI
agentengine invoke --json --session S "approve gr-…"
agentengine invoke --json --session S --resume '{"<interrupt id>": {"decision": "approve"}}'
```

`approval_agent/stage_pending.py` empties the `kg_demo` database and stages one locked edit waiting for approval. It never touches the real `kg` database.

The agent reaches the knowledge graph only through the gate client, with Raindrop off. Re-run `sync_kg.sh` and redeploy whenever `kg/` changes.

</details>

<br/>

## 🎤 The demo, in three minutes

- [ ] **Launch.** Pick the number of agents, give each a task, and launch.
- [ ] **Watch.** The 3D view, then the switch to worker views: each robot's camera and its live, scrollable trajectory.
- [ ] **The brain lights up.** An agent reads the brain, and that node lights up in the brain panel.
- [ ] **Review.** The shift ends. The supervisor reads the reports, metrics and trajectories, and finds the failures, for example robots jammed at the zone M lift.
- [ ] **Learn.** It matches the failure to a CCTV clip: people skip the lift when it's queued.
- [ ] **Call.** The phone rings. The Robotics Lead asks why, adjusts the change, and approves.
- [ ] **Update.** Brain v2 appears. Click the new rule: clip → failures it fixed → evidence.

<br/>

## 📚 Design docs

All design thinking is in the repo, written as it happened. When two documents disagree, the later one wins.

| # | Document | Read it for |
| :-: | --- | --- |
| 1 | [`iteration-05`](SCRATCHPADS/iteration-05-robot-form-and-build-decisions.md) | The latest round: robot form, the clips, the agent runtime |
| 2 | [`iteration-04`](SCRATCHPADS/iteration-04-robot-form-clips-and-team-sync.md) | Robot form, clips and team sync, with the team's inline feedback |
| 3 | [`knowledge-graph-info-packet`](https://github.com/ShashwatM3/mongodb-harness-engineering-hackathon/blob/kg/integration/SCRATCHPADS/knowledge-graph-info-packet.md) | The knowledge graph as built: collections, permissions, API, decisions |
| 4 | [`iteration-03`](SCRATCHPADS/iteration-03-supervisor-dashboard-and-sponsor-depth.md) | The supervisor as a tool-calling harness, the dashboard, Raindrop and MongoDB in depth |
| 5 | [`interface-contracts`](SCRATCHPADS/interface-contracts.md) | The exact shapes of `place_approval_call`, `get_brain_context`, `commit_brain_version` |
| 6 | [`brain-hierarchical-knowledge-graph`](SCRATCHPADS/brain-hierarchical-knowledge-graph.md) | The brain's original design |
| 7 | [`iteration-02`](SCRATCHPADS/iteration-02-warehouse-idea-research-and-workflow.md) | Why TwinForge, how improvement is proven, the team split |
| 8 | [`iteration-01`](SCRATCHPADS/iteration-01-warehouse-idea-evaluation.md) | The first verdict on the idea |
| 9 | [`CONTEXT/`](CONTEXT/README.md) | The brainstorm, research brief and planning chat that started it |

<br/>


<br/>

<div align="center">
<sub>Built in one day at Shack15, San Francisco · Thanks to MongoDB, Cerebral Valley, ElevenLabs and Raindrop</sub>
</div>
