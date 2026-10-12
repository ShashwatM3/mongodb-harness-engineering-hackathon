# Getting a real phone to ring: options, costs, and setup

Researched 2026-10-11 from the official docs of Twilio, ElevenLabs, Vapi, Telnyx, Vonage and Plivo. ElevenLabs, Vapi and Telnyx pages were read as raw markdown from their `llms.txt` indexes; links are under each finding. Everything here was read today, not recalled.

## TL;DR

| Route | Out-of-pocket | Works for "AI calls you"? | Code ready? |
|---|---|---|---|
| **A. Telnyx Trial + ElevenLabs SIP trunk** | **$0** (no card; Telnyx gives $5 test credit) | **Yes**, to your one verified phone | **Yes** (`CALL_MODE=twilio`, `PHONE_ROUTE=sip`) |
| B. Twilio paid + ElevenLabs native | **$20 minimum deposit** (shown in the Twilio Console upgrade screen; not in the public docs), then $1.15/mo number + $0.014/min from that balance | Yes, any number | Yes (`PHONE_ROUTE=twilio`) |
| C. Twilio **trial** + anything | — | **No.** The trial strips `<Stream>` | — |
| D. Vapi (ElevenLabs as voice only) | Still needs a Telnyx/Twilio/DIDWW number; Vapi ≈ $0.05/min + model costs | Yes, with an imported number | **No**, it needs a rebuild |
| E. ElevenLabs WhatsApp calling | Meta charges; payment method required | Yes, rings WhatsApp | No; needs Meta setup and template approval |
| F. Dashboard softphone on your phone's browser | $0 | Rings a browser, not a phone line | Yes, works today |

**Recommendation: A.** It's free, it's an officially documented ElevenLabs integration, and it keeps everything we built. The trial limits (verified number only, 10 min per call, 10 calls per hour) don't matter for a demo. If Telnyx's account review stalls, fall back to B (pay) or F (free).

---

## 1. Why the Twilio trial fails: verified, not a guess

- Twilio's **"Custom TwiML during trial"** reference lists verbs that are *"stripped from TwiML during trial and replaced with a message"*, among them **`<Stream>`**, **`<ConversationRelay>`**, `<VirtualAgent>`, `<Record>`, and `<Dial><Number>`/`<Dial><Sip>`. ([Try out Twilio Voice](https://www.twilio.com/docs/usage/trials/try-out-voice), page dated 2026-09-25)
- AI voice platforms carry call audio over a media stream. ElevenLabs' register-call guide says it *"returns TwiML that connects the call to your agent via WebSocket."* ([register call](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call))
- ElevenLabs' help center states the requirement directly: *"All you need is a **paid Twilio account** and an active Twilio phone number."* ([Can I connect Twilio to ElevenAgents?](https://elevenlabs.io/docs/help-center/product/eleven-agents/can-i-connect-twilio-to-eleven-agents))
- Other trial rules: verified recipients only, sign-up country only, 75 free voice minutes, 30-day expiry, and *"You don't choose a trial phone number during sign-up."* ([trial account](https://www.twilio.com/docs/usage/trials), [free trial guide](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account))

**Conclusion:** no Twilio trial setup can carry an AI voice agent, whether through ElevenLabs or Vapi. Upgrading is required.

## 2. Twilio paid: costs

- Upgrade flow: *"Fund your account… select how much would you like to start your account balance with."* The public docs and help articles state no minimum, but **the Console upgrade screen requires a $20 minimum deposit** (confirmed by the user, 2026-10-11). Some accounts must upload government ID. ([upgrade article](https://help.twilio.com/articles/223183208), [billing](https://help.twilio.com/articles/223135487))
- Prices: **local number $1.15/month**; **outbound $0.0140/min** (US). ([US voice pricing](https://www.twilio.com/en-us/voice/pricing/us))
- A demo of about 20 minutes uses roughly $1.15 + $0.30 of the $20 deposit; the remaining ~$18.55 stays as account balance.

## 3. ElevenLabs: every phone path it supports

From the official index ([llms.txt](https://elevenlabs.io/docs/llms.txt)):

| Path | Outbound API | Notes |
|---|---|---|
| Twilio native | `POST /v1/convai/twilio/outbound-call` | Paid Twilio. Purchased number (in + out) or verified caller ID (out only). ([native integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration)) |
| Twilio register-call | your own Twilio webhook + `POST /v1/convai/twilio/register-call` | Paid Twilio. You host the TwiML webhook; no call transfer. |
| **SIP trunk** (Telnyx, Plivo, Bandwidth, Sinch, Vonage, others) | **`POST /v1/convai/sip-trunk/outbound-call`** | Same fields as Twilio: `agent_id`, `agent_phone_number_id`, `to_number`, `conversation_initiation_client_data`; returns `conversation_id` and `sip_call_id`. ([SIP outbound API](https://elevenlabs.io/docs/eleven-agents/api-reference/sip-trunk/outbound-call), [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking)) |
| WhatsApp | `POST /v1/convai/whatsapp/outbound-call` | Needs a Meta business portfolio, a number not used on WhatsApp, a **Meta-approved call-permission template** (*"minutes to hours"*), and a **payment method in WhatsApp Manager**, because *"Meta bills these separately."* The user must also grant call permission. ([WhatsApp](https://elevenlabs.io/docs/eleven-agents/whatsapp), [getting started](https://elevenlabs.io/docs/eleven-agents/whatsapp/getting-started)) |

ElevenLabs sells no phone numbers itself; you bring Twilio, a SIP trunk, or WhatsApp.

**Agent pricing** ([ElevenAgents pricing](https://elevenlabs.io/pricing/agents)):
- Free plan: **15 call minutes**, 4 concurrent calls. Starter is $6 ($1 the first month) for 75 minutes.
- Extra minutes cost **$0.08/min**, and phone calls cost the same as web calls: *"no telephony fee."*
- LLM usage is deducted from credits.
- **Watch the free plan's 15 minutes.** Our live tests on the new account used about 3.

## 4. Vapi + ElevenLabs

- **ElevenLabs inside Vapi is text-to-speech only:** `voice.provider: "11labs"`, `voiceId`, `model` (e.g. `eleven_flash_v2_5`). Vapi runs speech-to-text, the LLM, tools and the call. Default ElevenLabs voices are billed through Vapi. Custom or cloned voices need your own key **and** *"An API subscription is required"* on ElevenLabs. ([Vapi ElevenLabs voice](https://docs.vapi.ai/providers/voice/elevenlabs), [custom voices](https://docs.vapi.ai/customization/custom-voices/elevenlabs))
- **Numbers:** *"Free Vapi phone numbers use US area codes, and only inbound calls are supported. To make outbound calls, import a number from Twilio, Telnyx, or DIDWW."* One free number per account. ([Phone calling](https://docs.vapi.ai/phone-calling), [free numbers](https://docs.vapi.ai/free-telephony))
- **Outbound API:** `POST https://api.vapi.ai/call` with `{ assistantId, phoneNumberId, customer: { number }, assistantOverrides: { variableValues } }`. ([outbound calling](https://docs.vapi.ai/calls/outbound-calling), [variables](https://docs.vapi.ai/assistants/dynamic-variables))
- **Tools** POST `{"message":{"type":"tool-calls","toolCallList":[…]}}` to your server and expect HTTP 200 with `{"results":[{"toolCallId","result"}]}`, where the result must be a **flat string**. Our tools return JSON objects, so they'd need an adapter route. ([function tools](https://docs.vapi.ai/tools/custom-tools))
- **Call status** comes from server events: `status-update` (`ringing`, `in-progress`, `ended`) and `end-of-call-report`. ([server events](https://docs.vapi.ai/server-url/events))
- **Pricing:** $0.05/min hosting plus transcriber, model and voice at cost, $5 free credit for new sign-ups, and 1 free (inbound-only) number. ([vapi.ai/pricing](https://vapi.ai/pricing), [pricing & packages](https://docs.vapi.ai/billing/pricing-and-success-packages))

**Verdict:** Vapi doesn't remove the need for an outbound-capable number. With Telnyx Trial it could also be free, but it means rebuilding the agent, tools and call tracking (about 1.5–2 hours), and ElevenLabs drops to voice only. **Not worth it today.**

## 5. Telnyx: the free option

From Telnyx's account-tier docs ([pretrial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/pretrial), [trial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/trial), [using a trial account](https://developers.telnyx.com/docs/account-setup/using-trial-account), [account upgrade](https://developers.telnyx.com/docs/account-setup/account-upgrade)):

| Tier | How you get it | Credit | Numbers | Voice |
|---|---|---|---|---|
| Pretrial | Verified email | $25 *AI* credits | 1 US local, reclaimed after 30 days | Verified number only, 10 min per call, 10 calls per day. **SIP connections not listed; Call Control "No access."** |
| **Trial** | Verified email + **fraud review (LinkedIn/GitHub verification or AI agent eval)**. **No card.** | **$5 testing credit** | 1 local number (country of sign-up); reclaimed after 30 days if not upgraded | *"Full access except otherwise specified"*; **1 instance per connection type** (so SIP trunking is allowed), 1 outbound voice profile, **outbound only to the verified number**, 2 concurrent calls, 10 min per call, 100 calls per day, 10 per hour |
| Paid | + verified mobile, card payment, 2FA, service address | — | Full | Full |

- Telnyx's trial note: *"Regardless of how the call is created, the destination is limited to the verified phone number."* The verified number is your own mobile, which is exactly who we call.
- Telnyx prepends a spoken "automated call generated on the Telnyx platform" notice to its **own** speech APIs (`/v2/calls`, TeXML `Say`/`Play`). SIP-trunk traffic from ElevenLabs isn't on that list. Unverified: we'll hear on the first call whether the notice plays.
- Prices: SIP outbound from **$0.005/min**, inbound from $0.0032/min; numbers are a monthly charge plus one-time fees where applicable. ([Telnyx pricing](https://developers.telnyx.com/pricing.md))
- Alternatives checked:
  - **Vonage trial:** voice only to your registered or test numbers, and *"You cannot use trial credit to buy virtual phone numbers."* ([Vonage trial limits](https://api.support.vonage.com/hc/en-us/articles/212554438-What-are-the-limitations-of-a-trial-account))
  - **Plivo trial:** calls only to verified sandbox numbers; trial numbers are documented only in older articles. ([Plivo limits](https://www.plivo.com/docs/voice/concepts/account-limits))
  - Telnyx is the clearest free path.

---

## 6. Setup for Route A (Telnyx Trial → ElevenLabs SIP trunk)

Sources: [ElevenLabs Telnyx guide](https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/telnyx), [ElevenLabs SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [Telnyx SIP trunking](https://developers.telnyx.com/docs/voice/sip-trunking/get-started).

**Telnyx (portal.telnyx.com):**
1. Sign up and verify your email. Complete the **fraud review** (LinkedIn or GitHub verification) to reach **Trial**. *(Account → Levels)*
2. **Verified numbers:** add your own mobile, the phone that should ring.
3. **Numbers → Buy:** one local number, paid from the $5 trial credit.
4. **Voice → SIP Trunking → Create SIP Connection**, type **FQDN**:
   - *Authentication & Routing*: Outbound Calls Authentication → **Credentials**, set a username and password. **Add FQDN** `sip.rtc.elevenlabs.io`.
   - *Inbound* tab: number format **+E.164**, transport **TCP**, your region.
   - *Outbound* tab: create or select an **Outbound Voice Profile** that allows your country.
   - *Numbers* tab: assign the number you bought.

**ElevenLabs (new account) → Phone Numbers → Import number → From SIP Trunk:**
- Label; phone number in E.164 (`+1…`, matching Telnyx's format).
- **Outbound:** address `sip.telnyx.com` (hostname only, no `sip:` prefix), transport **TCP**, codecs PCMU/PCMA, and digest username/password = the Telnyx credentials from step 4.
- Inbound settings aren't needed for our outbound-only use.
- Optional sanity check: that number's **Outbound call** button, once, to your verified mobile.

**Gateway `.env`, then restart:**
```
CALL_MODE=twilio            # the "real phone" provider
PHONE_ROUTE=sip             # use POST /v1/convai/sip-trunk/outbound-call
ELEVENLABS_PHONE_NUMBER_ID=  # from: npm run phone:numbers
SUPERVISOR_PHONE=+1…         # your verified mobile
CALL_ALLOWED_NUMBERS=+1…     # same number
```
Then run `npm run check:setup` and trigger one incident.

**What could still go wrong (and the fix):**
- **Fraud review delay:** use Route F meanwhile, or pay (Route B).
- **The outbound voice profile doesn't allow your country:** enable it in the profile.
- **Format mismatch:** a SIP 404 or 484 usually means the `+` prefix differs between Telnyx and ElevenLabs.
- **The Telnyx notice plays at the start of the call:** cosmetic.
- **ElevenLabs free minutes run out:** Starter is $1 for the first month (75 minutes).

## 7. Route B setup (if you'd rather pay Twilio)

1. Upgrade the Twilio account and fund it.
2. Buy a number with Voice capability ($1.15/month).
3. ElevenLabs → Phone Numbers → Import → Twilio, with the Account SID and Auth Token.
4. In `.env`: `CALL_MODE=twilio`, `PHONE_ROUTE=twilio`, plus the same three phone variables as Route A.
