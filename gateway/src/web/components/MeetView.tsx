import { useEffect, useRef } from 'react';
import type { Aggregate } from '../api';
import { SeverityBadge, StatusPill } from './bits';
import { DecisionPanel } from './DecisionPanel';
import { inCall, type Phone } from './Softphone';

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * "Meet-like" call screen: shown in place of the incident detail while the softphone is ringing or on a call for this
 * incident. Two participant tiles (the human lead and the voice agent), a live transcript strip, the call controls, and
 * the decision panel docked on the right. Decisions still go through the same DecisionPanel / tool endpoints.
 */
export function MeetView({ agg, phone, notify }: { agg: Aggregate; phone: Phone; notify: (m: string) => void }) {
  const ring = phone.ring!;
  const i = agg.incident;
  const plan = agg.revisions.at(-1)!.content;
  const call = agg.calls.find((c) => c._id === ring.call_id) ?? agg.calls.at(-1);
  const transcript = call?.transcript ?? [];
  const live = phone.phase === 'live';
  const agentSpeaking = live && phone.mode === 'speaking';
  const humanTalking = live && !phone.muted && phone.micLevel > 0.08;
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stripRef.current?.scrollTo({ top: stripRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript.length]);

  const status =
    phone.phase === 'ringing' ? `Incoming call · ${phone.left}s` : phone.phase === 'connecting' ? 'Connecting…' : phone.phase === 'live' ? `On the call · ${fmtClock(phone.elapsed)}` : phone.phase === 'unconfigured' ? `On the call (voice not configured) · ${fmtClock(phone.elapsed)}` : 'Call ended';

  return (
    <div className="meet">
      <header className="meet-head">
        <div className="row">
          <StatusPill state={agg.state} />
          <SeverityBadge severity={i.severity} />
          <span className="meet-robot">{i.robot_id}</span>
          <span className="spacer" />
          <span className={`meet-status ${live ? 'live' : ''}`}>{status}</span>
        </div>
        <h2 className="meet-summary">{i.plain_summary ?? i.failure_summary}</h2>
      </header>

      <section className="meet-stage">
        <div className={`tile ${humanTalking ? 'talking' : ''} ${phone.muted ? 'muted' : ''}`}>
          <div className="avatar human" style={{ ['--level' as string]: live ? phone.micLevel : 0 }}>
            <span>{initials(ring.supervisor)}</span>
          </div>
          <div className="tile-name">
            {ring.supervisor}
            <span className="tile-role">Robotics Lead · you</span>
          </div>
          <div className="tile-meter" aria-label="microphone level">
            {live ? <MicBars level={phone.muted ? 0 : phone.micLevel} /> : <span className="muted small">{phone.phase === 'ringing' ? 'ringing…' : 'no microphone yet'}</span>}
            {phone.muted && <span className="tile-badge">muted</span>}
          </div>
        </div>

        <div className={`tile agent ${agentSpeaking ? 'speaking' : ''}`}>
          <div className="avatar bot" style={{ ['--level' as string]: live ? Math.max(phone.agentLevel, agentSpeaking ? 0.35 : 0) : 0 }}>
            <span>FS</span>
          </div>
          <div className="tile-name">
            Fleet Supervisor
            <span className="tile-role">voice agent</span>
          </div>
          <div className="tile-meter">
            {phone.phase === 'ringing' && <span className="muted small">calling you</span>}
            {phone.phase === 'connecting' && <span className="muted small">joining…</span>}
            {phone.phase === 'unconfigured' && <span className="muted small">no voice: use the panel on the right</span>}
            {live && <span className={`speak-dot ${agentSpeaking ? 'on' : ''}`}>{agentSpeaking ? 'speaking' : 'listening'}</span>}
          </div>
        </div>
      </section>

      <section className="meet-strip" ref={stripRef}>
        {transcript.length === 0 ? (
          <span className="muted">{phone.phase === 'ringing' ? 'Answer to start the conversation.' : 'Live transcript will appear here.'}</span>
        ) : (
          transcript.slice(-12).map((l, idx) => (
            <div key={idx} className={`line ${l.role === 'user' ? 'user' : 'agent'}`}>
              <b>{l.role === 'user' ? ring.supervisor.split(' ')[0] : 'Supervisor'}</b> {l.text}
            </div>
          ))
        )}
      </section>

      <footer className="meet-bar">
        <span className="meet-bar-info">{i.robot_id} · {i.category}</span>
        <span className="spacer" />
        {phone.phase === 'ringing' && (
          <>
            <button className="ctl answer" onClick={() => void phone.answer()} autoFocus title="Answer">Answer</button>
            <button className="ctl" onClick={() => void phone.decline()} title="Decline">Decline</button>
          </>
        )}
        {inCall(phone.phase) && (
          <>
            <button className={`ctl ${phone.muted ? 'off' : ''}`} onClick={phone.toggleMute} disabled={!live} title={phone.muted ? 'Unmute microphone' : 'Mute microphone'}>
              {phone.muted ? 'Unmute' : 'Mute'}
            </button>
            <button className="ctl hangup" onClick={() => void phone.end('hung up by human')} title="Hang up">Hang up</button>
          </>
        )}
        <span className="spacer" />
        <span className="meet-bar-info">{phone.error ? <span className="error">{phone.error}</span> : 'Tip: a headset keeps background voices out.'}</span>
      </footer>

      <aside className="meet-dock">
        <p className="dock-plan">{plan.plain_summary ?? plan.summary}</p>
        <DecisionPanel agg={agg} notify={notify} />
      </aside>
    </div>
  );
}

function MicBars({ level }: { level: number }) {
  const n = 7;
  const lit = Math.round(Math.min(1, level * 2.5) * n);
  return (
    <span className="bars">
      {Array.from({ length: n }, (_, k) => (
        <i key={k} className={k < lit ? 'on' : ''} />
      ))}
    </span>
  );
}

function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || 'RL';
}
