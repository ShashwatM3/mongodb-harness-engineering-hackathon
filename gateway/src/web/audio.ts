// Browsers (especially on phones) only allow sound after a user gesture. We create one shared AudioContext and resume it
// on the first tap/click/keypress, so a later incoming call can ring even though the call itself arrives with no gesture.

let ctx: AudioContext | null = null;
const listeners = new Set<(unlocked: boolean) => void>();

export function audioContext(): AudioContext {
  ctx ??= new AudioContext();
  return ctx;
}

export const isAudioUnlocked = () => ctx?.state === 'running';

export function onAudioUnlockChange(fn: (unlocked: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installAudioUnlock(): () => void {
  const unlock = () => {
    const c = audioContext();
    void c.resume().then(() => {
      listeners.forEach((fn) => fn(c.state === 'running'));
      if (c.state === 'running') ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.removeEventListener(e, unlock));
    }).catch(() => {});
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  return () => ['pointerdown', 'keydown', 'touchend'].forEach((e) => window.removeEventListener(e, unlock));
}

/** An original, soft marimba-style ring (not Apple's ringtone), repeated, with vibration on phones that support it. Returns stop(). */
/** The ring is audible by default; add `?ring=0` to silence it. The visual ring and vibration are unaffected. */
const RING_MUTED = new URLSearchParams(location.search).get("ring") === "0"; // audible unless ?ring=0

export function startRingtone(): () => void {
  if (RING_MUTED) return () => {};
  const c = audioContext();
  const output = c.createGain();
  output.connect(c.destination);
  let stopped = false;
  const pluck = (at: number, freq: number) => {
    for (const [mult, gain] of [[1, 0.09], [4, 0.015]] as const) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      o.connect(g).connect(output);
      o.start(at);
      o.stop(at + 0.5);
    }
  };
  // C major arpeggio up and back: C5 E5 G5 C6 G5 E5 — two phrases, then a pause.
  const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25];
  const cycle = () => {
    if (stopped) return;
    const t = c.currentTime + 0.05;
    notes.forEach((f, i) => pluck(t + i * 0.13, f));
    notes.forEach((f, i) => pluck(t + 0.95 + i * 0.13, f));
    navigator.vibrate?.([700, 300, 700]);
  };
  cycle();
  const id = window.setInterval(cycle, 3200);
  return () => {
    stopped = true;
    window.clearInterval(id);
    output.gain.setValueAtTime(0, c.currentTime);
    output.disconnect();
    navigator.vibrate?.(0);
  };
}
