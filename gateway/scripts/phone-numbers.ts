// Lists phone numbers imported into the ElevenLabs workspace, with the id to put in ELEVENLABS_PHONE_NUMBER_ID.
//   npm run phone:numbers
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required');
const numbers = await new ElevenLabsClient({ apiKey }).conversationalAi.phoneNumbers.list();
if (!numbers.length) console.log('No phone numbers imported yet. ElevenLabs dashboard → Phone Numbers → Import (Twilio).');
for (const n of numbers as unknown as Array<Record<string, unknown>>) {
  console.log(`${n.phoneNumberId}  ${n.phoneNumber}  "${n.label}"  provider=${n.provider ?? '?'}  outbound=${n.supportsOutbound ?? '?'}  inbound=${n.supportsInbound ?? '?'}`);
}
