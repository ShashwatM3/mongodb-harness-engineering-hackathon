import { Conversation } from '@elevenlabs/client';
import { useCallback, useEffect, useRef, useState } from 'react';
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

export type Phase = 'ringing' | 'connecting' | 'live' | 'unconfigured' | 'ended';

/** Everything the UI needs to render a call, plus the actions that drive it. */
export interface Phone {
  ring: Ringing | null;
  phase: Phase;
  /** ElevenLabs client mode: 'speaking' while the agent talks, 'listening' otherwise. */
  mode: string;
  error: string | null;
  /** Seconds left before the ring times out. */
  left: number;
  muted: boolean;
  /** 0–1 microphone input level, sampled from the live conversation. */
  micLevel: number;
  /** 0–1 agent output level, sampled from the live conversation. */
  agentLevel: number;
  /** Seconds since the call was answered. */
  elapsed: number;
  answer: () => Promise<void>;
  decline: () => Promise<void>;
  end: (reason: string) => Promise<void>;
  toggleMute: () => void;
}

/** Call is answered and the session is (or is about to be) running. */
export const inCall = (p: Phase) => p === 'connecting' || p === 'live' || p === 'unconfigured';

interface CallState {
  call_id: string | null;
  phase: Phase;
  mode: string;
  error: string | null;
  left: number;
  muted: boolean;
  elapsed: number;
}

const fresh = (ring: Ringing | null): CallState => ({
  call_id: ring?.call_id ?? null,
  phase: 'ringing',
  mode: '',
  error: null,
  left: ring ? Math.max(0, Math.round((new Date(ring.ring_deadline).getTime() - Date.now()) / 1000)) : 0,
  muted: false,
  elapsed: 0,
});

/**
 * Simulated phone leg. The gateway "calls" by ringing this softphone; answering starts a real ElevenLabs voice
 * conversation with the same agent, dynamic variables and webhook tools a telephone call would use.
 * The transcript shown here is display-only — decisions are recorded exclusively through the agent's tool calls.
 *
 * State is keyed by `ring.call_id`: a new call starts from a clean state without remounting the host component.
 */
export function useSoftphone(ring: Ringing | null, cb: { onOpenIncident: (id: string) => void; onAnswered: (callId: string) => void }): Phone {
  const [raw, setRaw] = useState<CallState>(() => fresh(ring));
  const state = raw.call_id === (ring?.call_id ?? null) ? raw : fresh(ring);
  const patch = useCallback((p: Partial<CallState>) => setRaw((s) => ({ ...(s.call_id === (ring?.call_id ?? null) ? s : fresh(ring)), ...p })), [ring]);
  const [micLevel, setMicLevel] = useState(0);
  const [agentLevel, setAgentLevel] = useState(0);

  const conv = useRef<Conversation | null>(null);
  const ended = useRef(false);
  /** Only the softphone that actually answered may end the call; a failed answer (e.g. answered in another tab) must not. */
  const answered = useRef(false);
  const token = useRef<string | undefined>(undefined);
  const callId = ring?.call_id ?? null;

  // A new call (or none): drop the previous conversation and refs.
  useEffect(() => {
    ended.current = false;
    answered.current = false;
    token.current = undefined;
    setMicLevel(0);
    setAgentLevel(0);
    return () => {
      void conv.current?.endSession().catch(() => {});
      conv.current = null;
    };
  }, [callId]);

  // Ring tone + countdown.
  useEffect(() => {
    if (!ring || state.phase !== 'ringing') return;
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
      setRaw((s) => (s.call_id === ring.call_id ? { ...s, left: Math.max(0, s.left - 1) } : s));
    }, 1000);
    return () => {
      stop = true;
      clearInterval(id);
      void ctx.close();
    };
  }, [ring, state.phase]);

  // Call timer.
  useEffect(() => {
    if (!ring || !inCall(state.phase)) return;
    const id = setInterval(() => setRaw((s) => (s.call_id === ring.call_id ? { ...s, elapsed: s.elapsed + 1 } : s)), 1000);
    return () => clearInterval(id);
  }, [ring, state.phase]);

  // Audio levels for the tiles (mic = human, output = agent).
  useEffect(() => {
    if (state.phase !== 'live') return;
    const id = setInterval(() => {
      const c = conv.current;
      if (!c) return;
      try {
        setMicLevel(Math.min(1, c.getInputVolume()));
        setAgentLevel(Math.min(1, c.getOutputVolume()));
      } catch {
        /* session closing */
      }
    }, 80);
    return () => clearInterval(id);
  }, [state.phase]);

  const end = useCallback(
    async (reason: string) => {
      if (!ring || ended.current) return;
      ended.current = true;
      patch({ phase: 'ended' });
      try {
        await conv.current?.endSession();
      } catch {
        /* already closed */
      }
      if (answered.current) await api('POST', `/api/calls/${ring.call_id}/end`, { reason, answer_token: token.current }).catch((e) => patch({ error: String(e) }));
    },
    [ring, patch],
  );

  const answer = useCallback(async () => {
    if (!ring) return;
    patch({ phase: 'connecting', error: null });
    cb.onAnswered(ring.call_id); // before the request: the server's call.answered event can arrive before the response
    try {
      const s = await api<Session>('POST', `/api/calls/${ring.call_id}/answer`);
      answered.current = true;
      token.current = s.answer_token;
      cb.onOpenIncident(ring.incident_id);
      if (s.mode === 'unconfigured') {
        patch({ phase: 'unconfigured' });
        return;
      }
      // Ask for the browser's echo cancellation / noise suppression so background noise reaches the agent less.
      await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      conv.current = await Conversation.startSession({
        signedUrl: s.signed_url,
        connectionType: 'websocket',
        dynamicVariables: s.dynamic_variables,
        onConnect: ({ conversationId }) => {
          patch({ phase: 'live' });
          void api('POST', `/api/calls/${ring.call_id}/connected`, { conversation_id: conversationId, answer_token: token.current }).catch((e) => patch({ error: String(e) }));
        },
        onMessage: (m) => {
          const role = (m as { role?: string }).role ?? (m.source === 'ai' ? 'agent' : 'user');
          void api('POST', `/api/calls/${ring.call_id}/transcript`, { role, text: m.message, answer_token: token.current }).catch(() => {});
        },
        onModeChange: ({ mode }) => patch({ mode }),
        onError: (message) => patch({ error: message }),
        onDisconnect: () => void end('conversation ended'),
      });
    } catch (e) {
      patch({ error: e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) });
      await end('failed to connect');
    }
  }, [ring, cb, patch, end]);

  const decline = useCallback(async () => {
    if (!ring) return;
    await api('POST', `/api/calls/${ring.call_id}/decline`).catch((e) => patch({ error: String(e) }));
  }, [ring, patch]);

  const toggleMute = useCallback(() => {
    const next = !state.muted;
    try {
      conv.current?.setMicMuted(next);
    } catch {
      /* no live session yet */
    }
    patch({ muted: next });
  }, [state.muted, patch]);

  return { ring, phase: state.phase, mode: state.mode, error: state.error, left: state.left, muted: state.muted, micLevel, agentLevel, elapsed: state.elapsed, answer, decline, end, toggleMute };
}

/** Floating call card: shown while ringing/ended, or when the user has navigated away from the incident on the call. */
export function Softphone({ phone, onClose, onOpenIncident }: { phone: Phone; onClose: () => void; onOpenIncident: (id: string) => void }) {
  const { ring, phase, mode, error, left } = phone;
  if (!ring) return null;
  return (
    <div className={`phone ${phase === 'ringing' ? 'ringing' : ''}`}>
      <div className="row">
        <span className="phone-title">{phase === 'ringing' ? 'Incoming call' : phase === 'live' ? 'On the call' : phase === 'connecting' ? 'Connecting…' : phase === 'unconfigured' ? 'On the call (no voice)' : 'Call ended'}</span>
        <span className="spacer" />
        {phase === 'ringing' && <span className="muted small">{left}s</span>}
        {phase === 'live' && <span className={`talk ${mode === 'speaking' ? 'on' : ''}`}>{mode === 'speaking' ? 'speaking' : 'listening'}</span>}
      </div>
      <p className="phone-sub">Fleet supervisor · {ring.robot_id}</p>
      <p className="small">{ring.summary}</p>

      {phase === 'ringing' && (
        <div className="row">
          <button className="ok" onClick={() => void phone.answer()}>Answer</button>
          <button className="ghost" onClick={() => void phone.decline().then(onClose)}>Decline</button>
          <span className="spacer" />
          <button className="link" onClick={() => onOpenIncident(ring.incident_id)}>Open</button>
        </div>
      )}
      {phase === 'unconfigured' && <p className="small error">Voice isn't configured (ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID). Use the dashboard, then hang up.</p>}
      {inCall(phase) && (
        <div className="row">
          <button className="bad" onClick={() => void phone.end('hung up by human')}>Hang up</button>
          <button className="ghost" onClick={() => onOpenIncident(ring.incident_id)}>Back to call</button>
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
