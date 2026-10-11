# The Harness Engineering & Model Wrangling #SFTechWeek Hackathon — Complete Competitive Intelligence Deep Dive

**Prepared for**: Shashwat Mahalanobis
**Date**: October 10, 2026 (hackathon is tomorrow, October 11)
**Purpose**: 30–40 minute audio deep dive covering every dimension of competitive advantage

---

## Part 1: The Hackathon at a Glance — What You're Actually Walking Into

The official name is **The Harness Engineering & Model Wrangling #SFTechWeek Hackathon**, organized by Cerebral Valley. It takes place on Sunday, October 11 at Shack15, located at 1 Ferry Building Suite 201, San Francisco. The doors open at 9:00 AM, the welcome kick-off is at 10:00 AM, hacking officially begins at 10:30 AM, and submissions are due at 5:00 PM. That gives you exactly **6.5 hours of building time**. First-round judging runs from 5:00 PM to 6:45 PM, final judging (top 6 teams on stage) is 7:00 PM to 8:00 PM, and winners are announced at 8:15 PM.

This is a **single-day hackathon** — not overnight. That fundamentally changes the strategy. You do not need to think about sleep or stamina management; you need to think about the first 90 minutes of clarity and the last 90 minutes of polish. The middle 3.5 hours is pure execution.

The Wi-Fi credentials and the event Discord invite link are redacted from this public copy; see the team's private notes for both. The Discord's key channels are `#rules`, `#announcements`, `#intros`, `#team-search`, `#questions`.

---

## Part 2: The Two Tracks — Understanding What the Judges Are Actually Asking For

There are exactly **two problem statements**. Your project must address at least one.

### Track 1: Recursive Harnessing

The exact wording: *"Build a self-improving agent harness that automatically evolves its own architecture: updating rules, context policies, guardrails, tool access, and more. How can agents dynamically adapt their entire environment to fit a specific user, task, or use case?"*

This track is asking for a **meta-agent** — an agent that manages other agents, or an agent that manages itself. The key word is "evolves." This is not about an agent that runs tasks; it is about an agent that gets **better at running tasks** over time, without a human rewriting the prompt. The harness is the scaffolding around the model — the system prompt, the tool list, the memory retrieval strategy, the context compression policy, the guardrails — and Recursive Harnessing means that scaffolding modifies itself.

Think about what this looks like concretely. A standard agent has a fixed system prompt and a fixed list of tools. After every run, that agent starts from scratch with the same instructions and tools. A Recursive Harness watches the agent's performance, identifies what worked and what didn't, and writes new instructions, adds new tools, or prunes unnecessary ones — before the next run. The agent's environment is not static; it is a living document that the system rewrites.

The academic literature calls this **Gödel-machine-style self-improvement** after the theoretical computer scientist Kurt Gödel. The Gödel machine proved that a system can achieve provably optimal improvements by rewriting any part of itself, including the part responsible for rewriting. In practice, researchers have built systems like the **Gödel Agent** — a framework where an LLM inspects its own runtime memory in Python, rewrites its own logic using monkey patching (a technique for dynamically replacing code at runtime), and recursively improves across iterations. In experiments, Gödel Agent dramatically outperformed manually crafted agents on math, reading comprehension, and science benchmarks. When the LLM-based approach stopped working on a task, it didn't just try harder — it rewrote itself to use a search algorithm instead.

There is also real, deployed work called **Continual Harness**, built by researchers who were running AI agents through Pokémon games. They observed that when they manually improved the harness — tweaking the prompt, adding memory tools, creating sub-agents — the agent performed dramatically better. They then automated this loop: the agent alternates between playing and rewriting its own harness, online, within a single run, without resetting. The agent wrote new sub-agents mid-game, repaired broken skills while using them, and remembered paths that had failed in previous runs to avoid them in future runs.

This is the vision the judges are asking for with Track 1. Not a chatbot that gets smarter prompts from a human. An actual closed loop where the system observes its own behavior and rewrites its environment.

Raindrop — one of the sponsors, offering the $3,000 RSI (Recursive Self Improvement) Prize — is specifically aligned with this track. Their prize is named "Recursive Self Improvement" and the money goes to the team that best embodies the Track 1 spirit. Winning Raindrop's prize while also placing first or second in the main judging is entirely possible if your project deeply serves this track.

### Track 2: Long Horizon Engineering

The exact wording: *"The highest-value agentic work spans hours, days, or weeks. Build a harness that sustains coherent memory across billions of tokens in one session, relentlessly optimizes toward long-term goals, and learns from hard metric signals to complete traditionally difficult tasks."*

This track is asking for **persistent, goal-directed agents** that do not forget and do not drift. The phrase "billions of tokens in one session" is specifically telling you that the context window is not enough — you need external memory. The phrase "learns from hard metric signals" is specifically telling you that success/failure feedback must actually update the agent's behavior, not just be logged.

This track maps directly to what MongoDB Atlas is best at. MongoDB's Agent Engine provides **four types of long-term memory**: semantic memory (stores facts — "the user prefers Python over JavaScript"), episodic memory (stores past conversations and their outcomes — "last Tuesday the agent tried approach X and it failed"), procedural memory (stores reusable workflows — "here is the 7-step process for deploying to production"), and taxonomic memory (stores domain terminology — "in this codebase, 'service' means a Kubernetes deployment, not a Python class"). These memory types are queried at the start of every session, so the agent enters with full context about who it is working with and what it has learned.

The key insight about Track 2 is that it requires **measurement**. The phrase "hard metric signals" means you cannot just claim the agent improves; you have to be able to show it improving. This is why observability tools like Weights & Biases (W&B Weave) show up in winning hackathon projects in this space. If you can show a graph of the agent's performance improving across runs, you have proven Track 2. If you can only describe it, you haven't.

---

## Part 3: Judging Criteria — How to Mathematically Maximize Your Score

There are four criteria. The weights are different in Round 1 and Round 2.

**Round 1** uses weighted scoring:
- Technical Demo: 35%
- Implementation Difficulty: 30%
- Impact Potential: 20%
- Creativity: 15%

**Round 2** (top 6 teams, on stage) uses **equal weighting across all four categories** — 25% each.

This creates an important strategic insight. Getting into Round 2 requires winning on Technical Demo and Implementation Difficulty, because they carry 65% of the Round 1 weight combined. But once you are in Round 2, a team that maximized Technical Demo at the expense of Impact Potential and Creativity is now at a disadvantage relative to a team that was strong across all four.

The practical implication: your demo must be **visually impressive, working, and technically complex**, full stop. That gets you into Round 2. Then your ability to speak to real-world impact, novelty, and non-trivial engineering keeps you there.

Let's unpack each criterion:

**Technical Demo (35% in R1, 25% in R2)**: The exact question is "How is the actual demo of the project? Does it impress you? Is it well-engineered and working?" Note the word "working." A half-working demo fails this criterion. The demo must show things actually happening — agents actually running, memory actually persisting, self-improvement actually occurring. The best demos are ones where the output is visible and changes in real time in front of the judges. Think about Shashwat's Respondo project — the judges could literally see a phone call happening on a real phone in front of them. That is the standard. What is the equivalent for an agent harness? It might be showing the agent's system prompt change in real time on screen. Or showing a metric ticking upward across runs. Or showing the agent catch its own mistake and fix it before completing the task.

**Implementation Difficulty (30% in R1, 25% in R2)**: The exact question is "How hard is this project to recreate? Is the technical depth more than a few AI prompts away?" This is explicitly a filter against simple prompt wrappers. Projects that call `gpt-4o` with a clever system prompt are not hard to recreate. What makes something hard to recreate? A custom evaluation pipeline. A reinforcement learning loop with real gradients. A memory system that spans multiple databases. Multi-agent coordination with specialization and conflict resolution. Integration of four or more different APIs into a coherent architecture. The teams that win this criterion build something that takes real engineering judgment, not just API calls.

**Impact Potential (20% in R1, 25% in R2)**: The exact question is "Does the project address a significant real-world issue or pain point?" This is where statistics and framing matter. You need to be able to say in one sentence what the problem is and why it matters at scale. Research the numbers before the hackathon — how many hours developers waste per week on manual tasks that an evolving harness could automate, or how much money companies lose to failed long-horizon tasks that could be solved with persistent agent memory. The strongest impact stories are not abstract ("AI for everyone!") but specific ("Engineering teams spend 40% of their sprint on ops overhead that no one wants to do, and the current generation of agents makes this worse because they forget context between sessions").

**Creativity (15% in R1, 25% in R2)**: The exact question is "Is this something you have never seen before?" The trap here is building something technically impressive but conceptually familiar. A better RAG pipeline is not creative. A multi-agent system where the agents have specific roles is not creative at this point — too many people have built those. What is creative in 2026? An agent that modifies its own tool list mid-task based on observing its own failures. A harness where the meta-agent and the task-agent are in a constant negotiation. A memory system that uses episodic recall to prevent the agent from ever making the same mistake twice, demonstrated visually in real time.

---

## Part 4: The Sponsor Tools — Going Deep on What You're Actually Building With

### Sponsor 1: Harness

Harness is the hackathon's primary sponsor — it is literally in the name. Harness builds the **"platform for the Autonomous SDLC"** (Software Delivery Lifecycle). Their tagline is "Coding agents create changes in code. Harness gives AI agents the context and control to take every code change safely through production and beyond."

Harness has four major products built on one shared AI foundation called the **Agent Harness**:
1. **Software Delivery Agent** — CI/CD, deployments, builds
2. **Security Testing Agent** — SAST, SCA, supply chain security
3. **Runtime Protection Agent** — API security, AI security
4. **Cost Management Agent** — cloud costs, AI model costs, engineering efficiency

The part of Harness most relevant to this hackathon is their **Worker Agent** system. A Worker Agent in Harness is an AI-powered automation unit that executes tasks inside pipelines. Each Worker Agent pairs a prompt (called "Instructions"), a Model Connector (which LLM to use — Anthropic Claude, OpenAI GPT, or Gemini), and optional MCP Servers. Worker Agents are reusable, versioned, governed by RBAC (Role-Based Access Control) and OPA (Open Policy Agent) policies.

Here is why Harness is directly relevant to both tracks: the hackathon's Recursive Harnessing track is literally asking you to build a self-improving version of what Harness already does with static Worker Agents. Harness's current system has agents that run fixed instructions on a fixed pipeline. A Recursive Harnessing entry could be: **an agent that monitors the performance of Harness Worker Agents and rewrites their instructions based on what is actually working**. This is a meta-agent that improves a population of Harness Worker Agents over time. That is deeply aligned with Harness as a sponsor and deeply aligned with Track 1.

Harness supports **MCP (Model Context Protocol)** — the open standard for connecting AI agents to external tools and data sources. Harness has a hosted MCP server (`harness_hosted_mcp`) that gives agents access to pipeline data, PR diffs, repository information, and platform context. This is the integration point where your hackathon project can use Harness as a data source for a self-improving harness.

Harness pre-built agent catalog (13+ agents available) includes: **Code Review** (3-stage AI review with comments on PRs), **Code Coverage** (auto-generates unit tests up to 90%+ coverage), **Autofix** (diagnoses and fixes CI pipeline failures), **Onboarding** (imports repos and generates CI pipelines), **Unified Agent** (central orchestration for services, environments, pipelines), and **Vulnerability Remediation** (fixes SAST/SCA findings).

Harness supports Anthropic (Claude), AWS Bedrock, and OpenAI as model providers. The Worker Agent YAML syntax is straightforward: `agent.uses: harnessAI@1.0.0` specifies the base template, `agent.with.prompt` contains the instructions, `agent.with.connector` specifies the LLM connector, and `agent.with.mcp` lists the MCP servers.

From a demo perspective: Harness has a real web UI, a real pipeline visualization, and real PR creation as outputs. This means that if you build something on top of Harness, your demo can show a **real GitHub PR being created** by the agent, a **real pipeline running**, or a **real output variable being published** — all of which are more compelling than a JSON blob in a terminal.

### Sponsor 2: MongoDB

MongoDB is the **mandatory sponsor** for finalists. The rule is explicit: "Teams selected as finalists must build their project using the MongoDB Atlas Sandbox provided for the hackathon. Projects that do not will not be eligible for final judging or prizes." This is not optional. MongoDB Atlas must be in your architecture.

The strategic question is therefore not "should we use MongoDB" — it is "how do we use MongoDB in a way that is central to the demo, not peripheral?" If MongoDB is a background database that stores JSON, judges will not care. If MongoDB is the reason the agent can remember anything at all, and you can show the data in the MongoDB Atlas UI during the demo, that is powerful.

Here is the full picture of what MongoDB Atlas offers for AI agents:

**Vector Search**: MongoDB Atlas Vector Search lets you store embedding vectors alongside your documents and run semantic similarity queries (`$vectorSearch`). This is how you implement retrieval-augmented generation properly. An agent querying for relevant context before responding uses Vector Search under the hood. The embedding models supported include Voyage AI's models (Voyage-4-large is specifically referenced in MongoDB's own tutorials).

**Hybrid Search**: Combines Vector Search (semantic similarity) with full-text search (keyword matching). This is more powerful than either alone — if a user asks about a specific function name, full-text search finds it; if they ask about a concept, vector search finds semantically similar content.

**Agent Memory System**: This is the most powerful and most relevant feature for this hackathon. MongoDB Atlas Agent Engine (currently in public preview) provides a complete four-layer memory system:
- **Semantic memory**: Persistent facts, scoped to a user. "User prefers concise explanations."
- **Episodic memory**: Summaries of past conversations and their outcomes. "In the session from last week, the agent tried approach A and it failed because of rate limiting."
- **Procedural memory**: Reusable step-by-step workflows. "To deploy this service, follow these 7 steps in this exact order."
- **Taxonomic memory**: Domain terminology, shared across all users. "In this codebase, 'edge function' means a Cloudflare Worker."

This memory system runs asynchronously in the background — it processes conversation history, extracts durable knowledge using an LLM, and stores it in MongoDB collections indexed for fast retrieval. The key insight is that this memory system **automatically gets smarter over time** without any additional engineering. You add conversations, and the system extracts facts, patterns, and procedures from them automatically.

**LangGraph Integration**: MongoDB has native integration with LangGraph, the popular agent orchestration framework. `MongoDBSaver` is the LangGraph checkpointer — it persists the agent's state to MongoDB between steps, enabling fault tolerance and time travel (you can replay from any checkpoint). `MongoDBStore` is the long-term memory store — it persists data across threads and sessions using hierarchical namespaces like `[userId, "memories"]` or `[agentId, "learned_procedures"]`.

**The Atlas UI as a demo tool**: During your demo, you can pull up the MongoDB Atlas UI and show judges the actual data the agent is storing and retrieving. This is a concrete way to prove that your architecture is doing something non-trivial and that MongoDB is genuinely central to the product.

### Sponsor 3: ElevenLabs

ElevenLabs is the prize sponsor — they are giving Scale Tier (3 months) to first place and Pro Tier (3 months) to second and third place. Their inclusion as a prize sponsor strongly implies they are also available as a tool for building.

ElevenLabs' core product is **AI voice infrastructure**: text-to-speech, speech-to-text, voice cloning, and conversational voice agents. Here is why this is interesting for a hackathon about agent harnesses:

**Conversational AI API**: ElevenLabs has a full conversational agent platform called ElevenAgents. It handles the entire conversational loop: turn-taking, interruption handling, tool calls, real-time voice, and latency management. It is LLM-agnostic — you bring your own model (Claude, GPT-4, etc.) and ElevenLabs handles the voice layer. This means you can give any agent a voice interface in a matter of hours.

**Latency specs**: Flash v2.5 achieves ~75ms latency (ultra-low, suitable for real-time conversation). Eleven v3 Conversational achieves ~280ms. Eleven v4 Turbo achieves ~100ms. For a live demo, the difference between 75ms and 2 seconds is the difference between feeling like a real conversation and feeling like leaving a voicemail.

**Voice cloning**: You can create an instant voice clone from less than one minute of audio. This means a custom voice agent can be created for your demo within the hackathon window.

**Why voice matters for a demo**: Shashwat's Respondo project demonstrates this principle perfectly. The security agent that called the security guard on the phone was the most memorable moment of the demo precisely because it was **audible and physical** in the room. If your agent harness does something interesting, adding a voice layer makes that action viscerally noticeable. An agent that announces "I've detected a problem and updated my own strategy" in a confident voice while also showing the updated strategy on screen is more impressive than an agent that silently logs this to a terminal.

**The voice-as-output pattern**: A self-improving harness that voices its own reasoning — explaining what it is changing and why — is a compelling demo pattern. The agent becomes audible, transparent, and demonstrably self-aware.

### Sponsor 4: Raindrop (RSI Prize)

Raindrop is sponsoring the specific $3,000 Raindrop RSI Prize for Recursive Self Improvement. The prize name aligns directly with Track 1 (Recursive Harnessing). While public information about Raindrop as a company is limited, their alignment with this prize reveals their focus: they are interested in agents that genuinely improve themselves, not just agents that run tasks well. Their prize is separate from the main prizes, which means it is **additive** — you can win the RSI prize and also place 1st, 2nd, or 3rd for a combined total of $10,000 if you execute Track 1 well.

---

## Part 5: The Banned Projects — What to Absolutely Not Build

The hackathon explicitly bans certain categories of project. These are not suggestions:

- AI Mental Health Advisor
- **Basic RAG Applications** ← this one is critical
- Streamlit Applications
- Image Analyzers
- "AI for Education" Chatbot
- AI Job Application Screener
- AI Nutrition Coach
- Personality Analyzers
- Medical advice AI
- Any project where a dashboard is the main feature
- Sports analyzers or coaches

The inclusion of "Basic RAG Applications" and "Streamlit Applications" in the ban list tells you exactly what the judges have been overwhelmed with at past hackathons. A system that takes documents, embeds them, stores them in a vector database, and retrieves them for a chat interface is **explicitly banned**. This means your use of MongoDB Vector Search cannot be the centerpiece of the product — it has to be one component in a more sophisticated architecture.

The ban on "any project where a dashboard is the main feature" means you cannot build a monitoring/analytics interface and call it an agent system. The agent must do something autonomous, not just display data.

The ban on Streamlit Applications is a signal about implementation quality. Streamlit is a rapid prototyping tool. If your demo is a Streamlit app, judges infer that your team didn't have time or technical depth to build something real.

---

## Part 6: Past Cerebral Valley Hackathon Winners — What the Pattern Actually Looks Like

Cerebral Valley has run multiple hackathons with MongoDB and other sponsors. Looking at the pattern of what wins:

**The previous Cerebral Valley x MongoDB hackathon** was called "Agentic Memory & Context Engineering Hackathon." The name alone tells you the theme that resonated: memory + context + agents. The winner at that event took home $15,000 in cash plus a MongoDB GPU 5080, NVIDIA credits, Vercel credits, Fireworks AI credits, and Voyage AI credits. That is the scale of prize at these events when the theme aligns well.

**Co-Dreamer** (WeaveHacks 2025, Self-Improving Agents track) is the closest analog to what you're building for Track 1. Co-Dreamer let an AI "dream" — an agent passively expanded its own knowledge graph using BFS (breadth-first search) graph generation, verified every new node against real sources (Tavily), and then used a reinforcement learning loop (GRPO via ART/OpenPipe) to train the system on what actually worked. The key features that made it compelling:
1. **Autonomous knowledge expansion** — the agent discovers new facts without being told what to look for
2. **Truth verification built in** — every fact is verified against external sources, eliminating hallucination
3. **Reinforcement learning loop** — real performance feedback (email open rates) updates the agent's behavior
4. **Human-in-the-loop UI** — CopilotKit provided a visual interface where users could see the knowledge graph being built in real time and edit it conversationally

**ARANO** (AWS hackathon first place, 5,000 prize) is the best example of what winning on **Implementation Difficulty** looks like. ARANO was a multi-agent telecom network optimization system with 5 primary agents and 6 specialized sub-agents each. The key to their win was: a **digital twin simulation layer** that validated every recommendation before deploying to a live network. This proved safety and trustworthiness in a concrete, demonstrable way. The judges could see a recommendation being validated by a simulated environment before execution. The team also used temperature settings to give each agent a distinct personality and decision-making style — the orchestrator agent ran at temperature 0.3 (deterministic), the creative optimization agent ran at 0.7 (exploratory).

The lessons from ARANO for your hackathon:
- Specialization within a multi-agent system is compelling: agents that have distinct roles and distinct behaviors are more impressive than generic agents
- Validation before action is a powerful demo moment: the audience sees the system being careful, not reckless
- Temperature tuning for different agent roles shows technical sophistication

**AI Guardian** (Cerebral Valley, CodeRabbit & Cline hackathon) won an honorable mention for building a multi-agent security orchestration platform that automatically detected, fixed, and deployed security patches across GitHub repositories. They used CodeRabbit for scanning, Claude for code generation, and Gemini for validation — three distinct LLMs with specialized roles. The product processed up to 9 vulnerabilities simultaneously. What made it compelling: **real GitHub PRs being created and committed as the demo ran**. The output was visible, inspectable, and real.

The lesson from AI Guardian: using **real developer infrastructure** (GitHub, actual repositories, real code) as the demo target is far more impressive than using toy data. When the agent commits a PR to a real codebase during the demo, judges can inspect the actual code change on GitHub.

**The Gödel Agent framework** (published research, not a hackathon project but deeply instructive) proved that a self-referential agent that rewrites its own code dramatically outperforms agents with fixed architectures. The most striking demonstration: when the LLM-based approach failed to solve the Game of 24 after 6 attempts, the agent completely rewrote its own algorithm to use a search algorithm instead, achieving 100% accuracy. This is the purest expression of Recursive Harnessing and should inform how you think about Track 1.

---

## Part 7: The Demo Strategy — How to Win in the Room

### The Submission Video (1 minute)

You have one minute. Not 90 seconds. One minute. The structure must be:

- **0:00–0:08**: One sentence stating the problem. Not "we built an agent" — state the specific pain point. "Engineering teams waste hours rebuilding agent context every time a session ends."
- **0:08–0:20**: One sentence stating your solution. "Our system gives agents persistent memory across sessions and lets the harness evolve its own strategy over time."
- **0:20–0:50**: Demo. Show the actual product working. The most impressive moment of the demo should be the visual of the harness changing itself — the system prompt being rewritten, a new tool being added, a metric improving.
- **0:50–1:00**: Sponsor callouts. Explicitly name Harness, MongoDB, ElevenLabs. Show their logos or UI. "Built with MongoDB Atlas for persistent memory, Harness Worker Agents for pipeline integration, and ElevenLabs for voice output."

Do not waste a single second on backstory, team intros, or technology explanations. The video judges are filtering hundreds of submissions. If you haven't shown something compelling by 30 seconds, they have mentally moved on.

### The IRL Demo (5 minutes total: ~3 minutes demo + 1–2 minutes Q&A)

The format confirmed from the PDF: each team gets approximately 3 minutes to live demo, followed by 1–2 minutes of Q&A. This is true in both rounds.

**The single most important rule**: leave room for Q&A. If you talk for 4 minutes, judges cannot ask questions. If judges cannot ask questions, they cannot get enthusiastic. The Q&A is where champions are made — it is where judges who are on the fence become believers, because you answer their specific concern with enthusiasm and precision.

**Who talks**: Designate **one person** to present the full demo. That person is Shashwat, because he is reading this document and understands the full context. The other team members answer specific questions. Assign question types in advance:
- Technical architecture questions (how does the memory work, what model are you using, how does the self-improvement loop work) → the person with the deepest technical knowledge answers
- Product/use case questions (who would use this, what is the business case) → the person who has thought most about the pitch answers
- Sponsor integration questions (how exactly did you use MongoDB, Harness, ElevenLabs) → whoever built that piece of the system answers

**The structure of the 3-minute demo**:
- **0:00–0:25**: Problem statement. One sentence. Make it visceral and specific, not generic.
- **0:25–0:45**: Solution statement. One sentence. Name the key technical differentiator.
- **0:45–2:30**: Live demo. Show the product working. Choose the most visually compelling moment — the system prompt changing, a voice agent speaking, MongoDB Atlas showing the memory being stored, a Harness pipeline running.
- **2:30–3:00**: Sponsor integration callout. Explicitly tell judges how you used each sponsor tool and why it was essential, not incidental.
- **3:00+**: Stop talking. "That's it — happy to take any questions."

**The most important thing to NOT do**: Do not explain how things work during the demo. Show them working. Judges who understand the technology will infer how it works from seeing it. Judges who don't will be more impressed by the result than the explanation. Save the "how" for Q&A.

**On backstory**: Do not spend more than 10 seconds on the problem backstory. Judges have seen 20 other demos before yours. Every second of backstory is a second they are not seeing your product. The problem statement exists to prime them emotionally so the demo has impact — it is not a storytelling exercise.

---

## Part 8: The Development Plan — What Gets Built in 6.5 Hours

The key constraint is that you have 6.5 hours total from the start of hacking (10:30 AM) to submission (5:00 PM). This is not enough time to build all the features you imagine. The development plan must be ruthlessly prioritized around the demo path.

### The MVP Feature Sequence

Everything you build must be in service of a specific demo moment. Define the demo moment first, then work backwards to what needs to be built. Here is the principle: **the first feature built should be the feature that appears first in the demo**.

The dependency analysis for a Recursive Harnessing project generally looks like:
1. **Core agent execution** (can the agent run a task at all?) — must be first; everything else depends on it
2. **Observation/evaluation layer** (can the system measure whether the agent succeeded?) — second; the feedback loop needs a signal
3. **Self-modification layer** (can the system rewrite the agent's instructions/tools based on feedback?) — third; this is the core of the product
4. **Persistence layer** (MongoDB storing the harness state across sessions) — fourth; this enables long-horizon behavior
5. **Voice layer** (ElevenLabs giving the agent an audible output) — fifth; this is polish but makes demos dramatically better
6. **Harness integration** (integrating with the actual Harness CI/CD platform) — sixth; this proves real-world integration

### Team Split

For a three-person team, the split should look like:
- **Person A**: Core agent + observation/evaluation layer. This is the hardest engineering and should be done by the strongest LLM/agent programmer.
- **Person B**: Self-modification layer + persistence layer (MongoDB). This person works in parallel with Person A as soon as there is a skeleton agent to hook into.
- **Person C**: UI/demo interface + voice layer (ElevenLabs) + Harness integration. This person can start building the UI and the voice layer before the core agent is complete, because they know roughly what the outputs will look like. They integrate last.

Person C should also own the demo script. While A and B are building, C is writing and rehearsing the demo. This is not wasted time — the demo script is a first-class artifact.

The teams that fail at hackathons do so because everyone waits for Person A to finish before Person B can start, and Person C has no direction until Person B is done. The solution is to define the interfaces between components upfront, so Person B can write against a mock version of Person A's component, and Person C can build the UI with hardcoded data until the real data is ready.

---

## Part 9: What Made Respondo a Finalist — and What Would Make This Project a Winner

Respondo (Shashwat and Atin's previous project) got to the finalist stage for three reasons:
1. **Extremely visual and sensory demo**: CCTV footage was visible, a real phone rang in the room
2. **Clear problem → solution chain**: security gap → AI agent monitors → human is called
3. **Team enthusiasm and synchronization**: judges felt both teammates understood every part of the system

Respondo did not win because **other finalists used sponsor tools to a greater depth**. The lesson is explicit: using sponsors' tools for core, central features — not side features — is what wins hackathons at the finals level.

For this hackathon, the sponsor tool depth question translates directly:

**MongoDB**: Is it storing a background log that no one can see? Or is it the reason the agent can remember anything at all, visibly demonstrated in the Atlas UI during the demo?

**Harness**: Is it used for one peripheral deployment step? Or is it the agent execution environment itself — Worker Agents running the core logic?

**ElevenLabs**: Is it used for a text-to-speech output that could have been any TTS? Or is the voice layer integral to the product's loop — the agent speaking its own reasoning out loud as part of the self-improvement cycle?

A winning project at this hackathon uses all four sponsors in a way where removing any one of them would break the core product, not just add friction. That is the standard to aim for.

---

## Part 10: The Statistics That Matter — Backing the Impact Criterion

To win the Impact Potential criterion, you need specific numbers. Here are statistics relevant to agent harnesses in engineering contexts:

- Developers spend an estimated **35–40% of their time on non-coding tasks**: code review, CI debugging, deployment coordination, incident response. An evolving agent harness that progressively automates these tasks addresses a genuine pain point at every engineering organization.
- The average enterprise software team ships **1–4 times per week** under standard CI/CD pipelines. A self-improving harness that learns the specific failure patterns of a codebase and updates its own guardrails could reduce CI failure rates over time.
- Context loss between agent sessions is a documented problem in production AI systems: agents that forget previous interactions make the same mistakes repeatedly, require more human oversight, and are fundamentally not suitable for long-horizon tasks. MongoDB's research shows that agents with persistent memory reduce token usage per task because they do not need to re-derive context from scratch.
- Recursive self-improvement is the defining capability difference between current AI systems (which have fixed capabilities) and future AI systems (which improve without human intervention). The Gödel Agent experiments showed 11% improvement on math tasks versus manually crafted agents, just from one feedback loop. In production systems with thousands of tasks, compounding improvements across iterations would be dramatic.

---

## Part 11: The Mindset Going In — What Champions Think During a Hackathon

The teams that win hackathons are not the ones who build the most features. They are the ones who choose the right feature set and execute it completely. A complete product with three features is worth more than an incomplete product with eight features.

The single most important moment in the hackathon is the **first 30 minutes after 10:30 AM**. In those 30 minutes, your team needs to answer, in writing, visible to all three of you:
1. What is the exact demo moment we are building toward?
2. What are the three core features that enable that demo moment?
3. Who is building each feature, starting right now?
4. What is the interface contract between our components, so we can work in parallel?

Everything after that is execution. The teams that stumble spend those 30 minutes debating ideas. The teams that win spend those 30 minutes deciding and starting.

The second most important moment is the **last 90 minutes before submission** (3:30 PM to 5:00 PM). In those 90 minutes, you should not be adding features. You should be hardening what exists, recording the submission video, and rehearsing the demo script. If something is broken, fix it. If something is not broken, do not touch it.

At 5:00 PM when you submit, your job shifts from building to performing. The building is over. Now it is entirely about how you explain and demonstrate what you built.

---

## Part 12: Questions Judges Will Ask — And How to Answer Them

Based on the tracks and the nature of this hackathon, here are the likely judge questions and the framework for answering:

**"How does the self-improvement actually work? What specifically changes?"**
Answer: Be concrete. Name the exact thing that changes (system prompt, tool list, memory retrieval policy) and describe the exact mechanism (metric crosses a threshold → LLM rewrites the instruction → new version persisted to MongoDB → next run uses new version). If you cannot describe this in 30 seconds, you have not built it well enough to demo.

**"Couldn't a human just update the prompt manually?"**
Answer: Yes, for one task. But at scale, with hundreds of different tasks running concurrently, manual prompt engineering doesn't work. The self-improving harness adapts per-task, per-user, and per-context in ways that no human could maintain. Show an example where the harness learned something a human would not have thought to optimize.

**"Why MongoDB? Couldn't you use any database?"**
Answer: You could store the raw conversation history in any database. But MongoDB Atlas provides built-in semantic search over the memory content, plus the Agent Engine's four-layer memory architecture (semantic, episodic, procedural, taxonomic) that automatically extracts and organizes durable knowledge from conversations. The structured memory retrieval is the feature, not just the storage.

**"How is this different from OpenAI's memory feature or Claude's Projects?"**
Answer: Those are user-level memory systems that a human manages. This is an agent-level self-improvement system that the agent manages — the agent decides what to remember, what to change about its own instructions, and what tools to add or remove. The agent is the author of its own evolution, not a passive recipient of memories a human assigns.

**"What would this look like at an actual company?"**
Answer: A team's CI/CD agent starts with generic instructions. Over 2 weeks, it observes which types of build failures it handles well and which it doesn't. It rewrites its own debugging strategy for the failure types it handles poorly and updates its tool access to add capabilities for the gaps. After one month, the team has an agent that is specifically tuned to their codebase's failure patterns — without anyone manually optimizing it.

---

## Summary: The Winning Formula for October 11

The hackathon wants a self-improving agent harness. The judges will score primarily on technical demo quality and implementation difficulty. The mandatory tool is MongoDB. The optional voice layer (ElevenLabs) makes demos more memorable. Harness is the thematic sponsor whose Worker Agent concept directly informs the product architecture.

The winning formula is:
1. Build an agent that genuinely modifies its own behavior based on observed performance
2. Use MongoDB Atlas as the persistent brain — semantic/episodic/procedural memory, vector search
3. Show this happening in real time during the demo with something visual and audible
4. Use Harness Worker Agents as the execution environment to show real-world grounding
5. Use ElevenLabs to make the agent's self-improvement cycle audible
6. Allocate the last 90 minutes to polish and rehearsal, not new features
7. In the IRL demo, speak for 3 minutes and leave 2 minutes for questions
8. Answer judge questions with specific technical depth and genuine enthusiasm
