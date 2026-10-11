import { Conversation } from '@elevenlabs/client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';

export interface Ringing {
  call_id: string;
  incident_id: string;
  supervisor: string;
  severity: string;
  robot_id: string;
  summary: string;
  ring_deadline: string;
}

type Session = { answer_token?: string } & (
  | { mode: 'elevenlabs'; call_id: string; signed_url: string; dynamic_variables: Record<string, string> }
  | { mode: 'unconfigured'; call_id: string; dynamic_variables: Record<string, string> }
);

type Phase = 'ringing' | 'connecting' | 'live' | 'unconfigured' | 'ended';

/**
 * Simulated phone leg. The gateway "calls" by ringing this softphone; answering starts a real ElevenLabs voice
 * conversation with the same agent, dynamic variables and webhook tools a telephone call would use.
 * The transcript shown here is display-only — decisions are recorded exclusively through the agent's tool calls.
 */
export function Softphone({ ring, onClose, onOpenIncident, onAnswered }: { ring: Ringing; onClose: () => void; onOpenIncident: (id: string) => void; onAnswered: (callId: string) => void }) {
  const [phase, setPhase] = useState<Phase>('ringing');
  const [mode, setMode] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(() => Math.max(0, Math.round((new Date(ring.ring_deadline).getTime() - Date.now()) / 1000)));
  const conv = useRef<Conversation | null>(null);
  const ended = useRef(false);
  /** Only the softphone that actually answered may end the call; a failed answer (e.g. answered in another tab) must not. */
  const answered = useRef(false);
  const token = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'ringing') return;
    const ctx = new AudioContext();
    let stop = false;
    const beep = () => {
      if (stop) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 440;
      g.gain.value = 0.05;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    };
    const id = setInterval(() => {
      beep();
      setLeft((l) => Math.max(0, l - 1));
    }, 1000);
    return () => {
      stop = true;
      clearInterval(id);
      void ctx.close();
    };
  }, [phase]);

  useEffect(() => () => void conv.current?.endSession(), []);

  const end = async (reason: string) => {
    if (ended.current) return;
    ended.current = true;
    setPhase('ended');
    try {
      await conv.current?.endSession();
    } catch {
      /* already closed */
    }
    if (answered.current) await api('POST', `/api/calls/${ring.call_id}/end`, { reason, answer_token: token.current }).catch((e) => setError(String(e)));
  };

  const answer = async () => {
    setPhase('connecting');
    setError(null);
    onAnswered(ring.call_id); // before the request: the server's call.answered event can arrive before the response
    try {
      const s = await api<Session>('POST', `/api/calls/${ring.call_id}/answer`);
      answered.current = true;
      token.current = s.answer_token;
      onOpenIncident(ring.incident_id);
      if (s.mode === 'unconfigured') {
        setPhase('unconfigured');
        return;
      }
      // Ask for the browser's echo cancellation / noise suppression so background noise reaches the agent less.
      await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      conv.current = await Conversation.startSession({
        signedUrl: s.signed_url,
        connectionType: 'websocket',
        dynamicVariables: s.dynamic_variables,
        onConnect: ({ conversationId }) => {
          setPhase('live');
          void api('POST', `/api/calls/${ring.call_id}/connected`, { conversation_id: conversationId, answer_token: token.current }).catch((e) => setError(String(e)));
        },
        onMessage: (m) => {
          const role = (m as { role?: string }).role ?? (m.source === 'ai' ? 'agent' : 'user');
          void api('POST', `/api/calls/${ring.call_id}/transcript`, { role, text: m.message, answer_token: token.current }).catch(() => {});
        },
        onModeChange: ({ mode }) => setMode(mode),
        onError: (message) => setError(message),
        onDisconnect: () => void end('conversation ended'),
      });
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
      await end('failed to connect');
    }
  };

  const decline = async () => {
    await api('POST', `/api/calls/${ring.call_id}/decline`).catch((e) => setError(String(e)));
    onClose();
  };

  return (
    <div className={`phone ${phase === 'ringing' ? 'ringing' : ''}`}>
      <div className="row">
        <span className="phone-title">{phase === 'ringing' ? 'Incoming call' : phase === 'live' ? 'On the call' : phase === 'connecting' ? 'Connecting…' : 'Call ended'}</span>
        <span className="spacer" />
        {phase === 'ringing' && <span className="muted small">{left}s</span>}
        {phase === 'live' && <span className={`talk ${mode === 'speaking' ? 'on' : ''}`}>{mode === 'speaking' ? 'speaking' : 'listening'}</span>}
      </div>
      <p className="phone-sub">Fleet supervisor · {ring.robot_id}</p>
      <p className="small">{ring.summary}</p>

      {phase === 'ringing' && (
        <div className="row">
          <button className="ok" onClick={answer}>Answer</button>
          <button className="ghost" onClick={decline}>Decline</button>
        </div>
      )}
      {phase === 'unconfigured' && <p className="small error">Voice isn't configured (ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID). Use the dashboard, then hang up.</p>}
      {(phase === 'live' || phase === 'unconfigured' || phase === 'connecting') && (
        <div className="row">
          <button className="bad" onClick={() => end('hung up by human')}>Hang up</button>
          <span className="muted small">Tip: a headset keeps background voices out.</span>
        </div>
      )}
      {phase === 'ended' && (
        <div className="row">
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      )}
      {error && <p className="small error">{error}</p>}
    </div>
  );
}
