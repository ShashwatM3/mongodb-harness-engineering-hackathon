# sitesim — the warehouse digital twin the harness runs inside

**Provenance.** This directory is a copy of TwinForge, a spec-driven deterministic facility digital twin that
Shashwat Mahalanobis (a member of this team) built before the hackathon's build window opened on October 11, 2026.
It was copied into this repository on October 11, 2026 at about 15:10 PDT from the `main` branch of that project
(commit `60048f3`), in one commit, so that everything after that commit in this directory is new work made today.
TwinForge itself contained no self-improving brain, no rule graph, no gate, no runner contract, no ElevenLabs
integration and no MongoDB Atlas usage; all of that is built here, on top of it, from inside the build window.

TwinForge's warehouse layout is generated from [WareTwin](https://github.com/WayneChou-bot/WareTwin) (MIT).

**What this directory adds today** (everything under `src/harness/` and every change listed in the commit log after
the copy): the headless runner (`/health`, `/run_shift`, `/validate_brain`, `/settings`) that the `kg/` package
calls, the brain compiler, the stairs-versus-lift lever, the seven failure types, the legged `HUM-1` class with an
arm and torso lift, the brain panel, and the worker exception hook.

```bash
npm install
npm run dev        # dashboard on http://localhost:5180 (?spec=warehouse)
npm run serve      # sim server (runner contract) on http://localhost:8790
npm test
```
