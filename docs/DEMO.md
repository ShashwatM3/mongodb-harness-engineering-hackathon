# Demo script

All incident data is synthetic (mock scenarios A–E). TwinForge is the team's pre-existing warehouse twin; it is mentioned only as the simulator, and none of its code is in this repo.

## Setup (once)

```bash
npm install
cp .env.example .env        # MONGODB_URI (Atlas), ELEVENLABS_API_KEY
npm run dev                 # gateway :8787 + dashboard http://localhost:5173
npm run tunnel              # copy the https URL into PUBLIC_BASE_URL in .env
npm run provision:agent     # first time: put the printed ELEVENLABS_AGENT_ID in .env
npm run check:setup         # every line should be ✓
npm run reset:db -- --yes   # optional: start with an empty incident list
```

- **Use a headset.** It's the best protection against background voices.
- **Keep one dashboard tab open.**

## The call (about 2 minutes)

1. In the top bar, pick **Trajectory deviation in the zone M lift lobby** → **Simulate incident**. This acts as the harness supervisor raising an incident. **The softphone rings on its own: the AI is calling you.**
2. **Answer** and allow the microphone. The agent opens with exactly:
   > "Hi Robotics Lead, this is the fleet supervisor. Robot AMR-07 cut a corner in the lift area and came within 62 centimetres of a worker, when it should keep at least a metre away. The proposed fix: give the robot a wider safety margin in the lift area, 0.65 metres instead of 0.45, which adds about 2 seconds per trip. Do you want to approve it, change it, or ask me anything?"
3. Ask anything, in your own words: *"Why did it do that?"*, *"Was anyone hurt?"*, *"How close has it got before?"* The answers come from the incident context in one or two sentences. Anything not in the context goes to the supervisor (`ask_supervisor`).
4. *"Show me the path."* The **Robot path** card opens on the dashboard.
5. *"Make it 0.6 metres instead."* The agent confirms, and the plan becomes **version 2** on the dashboard immediately.
6. *"Yes, approve that — but keep an eye on the trip times."* You can say this at any point, even mid-sentence. **Sent to the supervisor** shows *Approved, version 2*, your words, and **✓ delivered**.
7. *"That's all."* The agent ends the call.

## Other things to show

- **Another incident type, same agent:** pick *Tote latch failure* (grip force) or *Zone M pick* (slow). No trajectory exists for these, and the agent says so instead of inventing one.
- **Uncertain cause:** pick *Deadlock* and ask *"What did the lidar show?"* The agent says that data wasn't kept. Then say *"not now"*: the incident shows Postponed.
- **Decide on the dashboard instead:** type feedback, then Approve, Reject or Not now. The same engine handles both.
- **Hang up without deciding:** the incident shows *Needs your decision*, with nothing assumed. Use **Call me** to call again.

## Without voice (no ElevenLabs credits)

```bash
npm run trigger -- A                                  # prints the incident id
npm run simulate:agent -- <incident_id> approve       # or reject | defer | hangup
```

The script plays the agent's side through the real tool endpoints, and the dashboard updates live. Don't answer the call in the browser while the script runs.
