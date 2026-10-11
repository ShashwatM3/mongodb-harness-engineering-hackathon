import { Conversation } from '@elevenlabs/client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { startRingtone } from '../audio';

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
 * Simulated phone leg, styled like a real phone call. The gateway "calls" by ringing this screen; answering starts a real
 * ElevenLabs voice conversation with the same agent, dynamic variables and tools a telephone call would use.
 * Captions are display-only — decisions are recorded exclusively through the agent's tool calls.
 */
export function Softphone({ ring, onClose, onOpenIncident, onAnswered }: { ring: Ringing; onClose: () => void; onOpenIncident: (id: string) => void; onAnswered: (callId: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>('ringing');
  const [mode, setMode] = useState<string>('');
  /** Manual mute, and optional half-duplex: mic muted while the agent is speaking so room noise can't cut it off. */
  const [muted, setMuted] = useState(false);
  const [autoMute, setAutoMute] = useState(true);
  const [loud, setLoud] = useState(true);
  const [caption, setCaption] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const conv = useRef<Conversation | null>(null);
  const ended = useRef(false);
  const unmounted = useRef(false);
  const reportedEnd = useRef(false);
  /** Only the softphone that actually answered may end the call; a failed answer (e.g. answered in another tab) must not. */
  const answered = useRef(false);
  const token = useRef<string | undefined>(undefined);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Ring (sound + vibration) while incoming.
  useEffect(() => {
    if (phase !== 'ringing') return;
    return startRingtone();
  }, [phase]);

  // Call timer and keep the screen awake during the call.
  useEffect(() => {
    if (phase !== 'live') return;
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    let lock: { release(): Promise<void> } | null = null;
    let disposed = false;
    void (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock
      ?.request('screen')
      .then((l) => {
        if (disposed) void l.release().catch(() => {});
        else lock = l;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      window.clearInterval(id);
      void lock?.release().catch(() => {});
    };
  }, [phase]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      void conv.current?.endSession();
      void reportEnd('call screen closed');
    };
  }, []);

  const micOff = muted || (autoMute && mode === 'speaking');
  useEffect(() => {
    if (phase === 'live') conv.current?.setMicMuted(micOff);
  }, [micOff, phase]);
  useEffect(() => {
    if (phase === 'live') conv.current?.setVolume({ volume: loud ? 1 : 0.35 });
  }, [loud, phase]);

  // After the call ends, show "Call ended" briefly, then close.
  useEffect(() => {
    if (phase !== 'ended') return;
    const id = window.setTimeout(() => closeRef.current(), error ? 6000 : 2200);
    return () => window.clearTimeout(id);
  }, [phase, error]);

  const reportEnd = async (reason: string) => {
    if (!answered.current || reportedEnd.current) return;
    reportedEnd.current = true;
    await api('POST', `/api/calls/${ring.call_id}/end`, { reason, answer_token: token.current }).catch((e) => setError(String(e)));
  };

  const end = async (reason: string) => {
    if (ended.current) return;
    ended.current = true;
    setPhase('ended');
    try {
      await conv.current?.endSession();
    } catch {
      /* already closed */
    }
    await reportEnd(reason);
  };

  const answer = async () => {
    setPhase('connecting');
    setError(null);
    onAnswered(ring.call_id); // before the request: the server's call.answered event can arrive before the response
    try {
      const s = await api<Session>('POST', `/api/calls/${ring.call_id}/answer`);
      answered.current = true;
      token.current = s.answer_token;
      if (ended.current || unmounted.current) {
        await reportEnd('call screen closed while connecting');
        return;
      }
      onOpenIncident(ring.incident_id);
      if (s.mode === 'unconfigured') {
        setPhase('unconfigured');
        return;
      }
      // Check permission, then release the preflight stream; the SDK opens its own microphone stream.
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      mic.getTracks().forEach((track) => track.stop());
      if (ended.current || unmounted.current) {
        await reportEnd('call screen closed while connecting');
        return;
      }
      conv.current = await Conversation.startSession({
        signedUrl: s.signed_url,
        connectionType: 'websocket',
        dynamicVariables: s.dynamic_variables,
        onConnect: ({ conversationId }) => {
          if (ended.current || unmounted.current) return;
          setPhase('live');
          void api('POST', `/api/calls/${ring.call_id}/connected`, { conversation_id: conversationId, answer_token: token.current }).catch((e) => setError(String(e)));
        },
        onMessage: (m) => {
          if (ended.current || unmounted.current) return;
          const role = (m as { role?: string }).role ?? (m.source === 'ai' ? 'agent' : 'user');
          if (role !== 'user') setCaption(m.message);
          void api('POST', `/api/calls/${ring.call_id}/transcript`, { role, text: m.message, answer_token: token.current }).catch(() => {});
        },
        onModeChange: ({ mode }) => { if (!ended.current && !unmounted.current) setMode(mode); },
        onError: (message) => setError(message),
        onDisconnect: () => void end('conversation ended'),
      });
      if (ended.current || unmounted.current) {
        await conv.current.endSession();
        await reportEnd('call screen closed while connecting');
      }
    } catch (e) {
      if (!answered.current) onAnswered(null);
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      await end('failed to connect');
    }
  };

  const decline = async () => {
    try {
      await api('POST', `/api/calls/${ring.call_id}/decline`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const speaking = phase === 'live' && mode === 'speaking';
  const inCall = phase === 'connecting' || phase === 'live' || phase === 'unconfigured';
  const [captions, setCaptions] = useState(true);
  const subtitle =
    phase === 'ringing' ? 'Fleet supervisor AI' : phase === 'connecting' ? 'calling…' : phase === 'live' ? fmtDuration(seconds) : phase === 'unconfigured' ? 'voice not configured' : 'Call Ended';

  return (
    <div className="call-backdrop">
      <div className={`iphone phase-${phase}`} role="dialog" aria-label="Phone call">
        <div className="iphone-statusbar" aria-hidden>
          <span>{clock()}</span>
          <span className="island" />
          <span className="sb-icons">
            <Bars /> <Wifi /> <Battery />
          </span>
        </div>

        <div className="ios-top">
          <div className="ios-name">Fleet Supervisor</div>
          <div className={`ios-sub ${phase === 'ended' ? 'ended' : ''}`}>{subtitle}</div>
          {phase === 'ringing' && <div className="ios-note">{ring.robot_id} · {ring.severity.toLowerCase()} severity</div>}
        </div>

        <div className="ios-middle">
          {phase === 'ringing' && <p className="ios-preview">{ring.summary}</p>}
          {phase === 'ringing' && error && <p className="ios-error" role="alert">{error}</p>}
          {phase === 'live' && captions && (
            <p className={`ios-caption ${speaking ? 'speaking' : ''}`}>{caption || 'Listening…'}</p>
          )}
          {phase === 'live' && (
            <div className="ios-turn">
              <span className={`turn-dot ${speaking ? 'agent' : 'you'}`} /> {speaking ? 'Agent speaking' : 'Your turn'}
              {micOff && ' · mic off'}
            </div>
          )}
          {phase === 'unconfigured' && <p className="ios-preview">ElevenLabs isn’t configured, so there’s no voice. Use the dashboard, then end the call.</p>}
          {inCall && error && <p className="ios-error" role="alert">{error}</p>}
          {phase === 'ended' && <p className="ios-preview">{error ?? 'Nothing is assumed from a call ending.'}</p>}
        </div>

        {phase === 'ringing' && (
          <div className="ios-bottom">
            <div className="ios-shortcuts">
              <IosShortcut label="Incident details" onClick={() => onOpenIncident(ring.incident_id)}>
                <InfoIcon />
              </IosShortcut>
            </div>
            <div className="ios-answer">
              <IosButton kind="decline" label="Decline" onClick={decline}>
                <PhoneIcon down />
              </IosButton>
              <IosButton kind="accept" label="Accept" onClick={answer}>
                <PhoneIcon />
              </IosButton>
            </div>
          </div>
        )}

        {inCall && (
          <div className="ios-bottom">
            <div className="ios-grid">
              <IosButton label="mute" active={muted} disabled={phase !== 'live'} onClick={() => setMuted((m) => !m)}>
                <MicIcon off={muted} />
              </IosButton>
              <IosButton label="volume" active={loud} disabled={phase !== 'live'} onClick={() => setLoud((l) => !l)} title={loud ? 'Lower call volume' : 'Raise call volume'}>
                <SpeakerIcon loud={loud} />
              </IosButton>
              <IosButton label="auto-mute" active={autoMute} disabled={phase !== 'live'} onClick={() => setAutoMute((x) => !x)} title="Mute your mic while the agent is talking">
                <AutoMuteIcon />
              </IosButton>
              <IosButton label="captions" active={captions} disabled={phase !== 'live'} onClick={() => setCaptions((c) => !c)}>
                <CaptionIcon />
              </IosButton>
              <IosButton label="details" onClick={() => onOpenIncident(ring.incident_id)}>
                <InfoIcon />
              </IosButton>
            </div>
            <div className="ios-end">
              <IosButton kind="decline" label="" onClick={() => end('hung up by human')}>
                <PhoneIcon down />
              </IosButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function clock() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}

function fmtDuration(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function IosButton(props: { label: string; kind?: 'accept' | 'decline'; active?: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <div className="ib">
      <button
        className={`ib-btn ${props.kind ?? ''} ${props.active ? 'active' : ''}`}
        onClick={props.onClick}
        disabled={props.disabled}
        aria-label={props.label || 'end call'}
        aria-pressed={props.kind ? undefined : props.active}
        title={props.title ?? (props.label || 'End call')}
      >
        {props.children}
      </button>
      {props.label && <span className="ib-label">{props.label}</span>}
    </div>
  );
}

function IosShortcut(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="ios-shortcut" onClick={props.onClick}>
      {props.children}
      <span>{props.label}</span>
    </button>
  );
}

const S = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function PhoneIcon({ down }: { down?: boolean }) {
  return (
    <svg {...S} style={down ? { transform: 'rotate(135deg)' } : undefined}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}
function MicIcon({ off }: { off?: boolean }) {
  return (
    <svg {...S}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
function AutoMuteIcon() {
  return (
    <svg {...S}>
      <path d="M4 10v4M8 7v10M12 4v16" />
      <rect x="15" y="8" width="5" height="8" rx="2.5" />
    </svg>
  );
}
function SpeakerIcon({ loud }: { loud?: boolean }) {
  return (
    <svg {...S}>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      {loud && <path d="M19 5a10 10 0 0 1 0 14" />}
    </svg>
  );
}
function CaptionIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
function Bars() {
  return (
    <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
      <rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" />
    </svg>
  );
}
function Wifi() {
  return (
    <svg width="15" height="11" viewBox="0 0 16 12" fill="currentColor">
      <path d="M8 2.2c2.4 0 4.6.9 6.3 2.5l1.2-1.3A10.6 10.6 0 0 0 8 .5C5.1.5 2.5 1.6.5 3.4l1.2 1.3A9 9 0 0 1 8 2.2zm0 3.4c1.5 0 2.9.6 3.9 1.5l1.2-1.3A7.4 7.4 0 0 0 8 3.9c-2 0-3.8.7-5.1 1.9l1.2 1.3c1-.9 2.4-1.5 3.9-1.5zm0 3.3c-.6 0-1.2.2-1.6.6L8 11.3l1.6-1.8c-.4-.4-1-.6-1.6-.6z" />
    </svg>
  );
}
function Battery() {
  return (
    <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
      <rect x="0.5" y="0.5" width="21" height="11" rx="3" stroke="currentColor" opacity="0.4" />
      <rect x="2" y="2" width="16" height="8" rx="1.6" fill="currentColor" />
      <path d="M23 4v4" stroke="currentColor" strokeWidth="1.4" opacity="0.4" strokeLinecap="round" />
    </svg>
  );
}
