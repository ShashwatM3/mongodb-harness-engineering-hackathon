/**
 * Step-zero landing page: lists every registered environment as a row and
 * hosts the create-environment conversation. Environments are still just
 * spec files — the chat fills a rubric, generation emits a spec document,
 * and the console loads it exactly like the bundled ones.
 */
import { useEffect, useRef, useState } from "react";
import { SPECS, loadCustomSpecs, saveCustomSpec, switchSpec } from "../../spec/registry";
import { EMPTY_RUBRIC, RUBRIC_ITEMS, generateSpec, rubricComplete, verifySpec, type Rubric } from "../../spec/customGen";

// ── Scripted rubric-driven conversation ───────────────────────
interface Msg { from: "agent" | "user"; text: string }
interface Step {
  key: keyof Rubric;
  prompt: string;
  options?: { label: string; value: string }[];
  parse?: (input: string) => string | null;
}

const STEPS: Step[] = [
  {
    key: "domain",
    prompt: "Let's design your environment. What kind of facility is it? This picks the proven base template the spec is generated from.",
    options: [
      { label: "Offshore oil & gas platform", value: "offshore" },
      { label: "Warehouse / fulfillment", value: "warehouse" },
      { label: "Retail store", value: "retail" },
    ],
  },
  {
    key: "name",
    prompt: "What should we call it? Type a name for the environment.",
    parse: (s) => (s.trim().length >= 2 ? s.trim() : null),
  },
  {
    key: "scale",
    prompt: "Site layout & scale — should throughput targets match the full template, or a compact operation?",
    options: [
      { label: "Standard (full template)", value: "standard" },
      { label: "Compact operation", value: "compact" },
    ],
  },
  {
    key: "fleet",
    prompt: "Robot fleet — deploy the full mixed fleet (wheeled, legged, Ex-crawler, drone, fixed sensors where the template has them), or a lean one-of-each fleet?",
    options: [
      { label: "Full fleet", value: "full" },
      { label: "Lean (one per class)", value: "lean" },
    ],
  },
  {
    key: "tempo",
    prompt: "Tasks & operational tempo — how busy should the facility be?",
    options: [
      { label: "Calm (fewer tasks)", value: "calm" },
      { label: "Busy (more tasks)", value: "busy" },
    ],
  },
  {
    key: "conditions",
    prompt: "Environmental conditions — include the marine environment (animated sea, seabed, subsea assets, weather) or keep it standard indoor/onshore?",
    options: [
      { label: "Marine / offshore conditions", value: "marine" },
      { label: "Standard", value: "standard" },
    ],
  },
];

// ── Phase-wise generation workflow ────────────────────────────
const PHASES = [
  "Compile rubric into EnvSpec document",
  "Generate zones, fixtures & fleet",
  "Compile navigation grids",
  "Validate physics & determinism",
  "Register environment",
];

function GenerationDialog({ rubric, onDone }: { rubric: Rubric; onDone: (key: string) => void }) {
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const result = useRef<{ key: string } | null>(null);
  useEffect(() => {
    if (error) return;
    if (phase >= PHASES.length) {
      const t = setTimeout(() => onDone(result.current!.key), 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      try {
        if (phase === 0) result.current = generateSpec(rubric);
        if (phase === 3) verifySpec(generateSpec(rubric).spec);
        if (phase === 4) {
          const { key, spec } = generateSpec(rubric);
          saveCustomSpec(key, spec);
        }
        setPhase((p) => p + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 900);
    return () => clearTimeout(t);
  }, [phase, rubric, onDone, error]);
  return (
    <div className="gen-overlay">
      <div className="gen-dialog">
        <h3>Creating “{rubric.name}”</h3>
        <ul className="gen-phases">
          {PHASES.map((p, i) => (
            <li key={p}>
              {i < phase ? (
                <span className="gen-dot done">✓</span>
              ) : (
                <span className={"gen-dot pending" + (i === phase && !error ? " active" : "")} />
              )}
              <span className={i < phase ? "done" : i === phase ? "current" : ""}>{p}</span>
            </li>
          ))}
        </ul>
        {error ? <p className="gen-error">{error}</p> : phase >= PHASES.length ? <p className="gen-ok">Environment ready — opening…</p> : null}
      </div>
    </div>
  );
}

// ── Chat interface ────────────────────────────────────────────
function CreateChat({ onCancel }: { onCancel: () => void }) {
  const [rubric, setRubric] = useState<Rubric>(EMPTY_RUBRIC);
  const [msgs, setMsgs] = useState<Msg[]>([{ from: "agent", text: STEPS[0].prompt }]);
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stepIdx = STEPS.findIndex((s) => rubric[s.key] === null);
  const step = stepIdx >= 0 ? STEPS[stepIdx] : null;
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e6 }); }, [msgs]);

  const answer = (display: string, value: string) => {
    if (!step) return;
    const next = { ...rubric, [step.key]: value } as Rubric;
    const nextStep = STEPS.find((s) => next[s.key] === null);
    setRubric(next);
    setMsgs((m) => [
      ...m,
      { from: "user", text: display },
      nextStep
        ? { from: "agent", text: nextStep.prompt }
        : { from: "agent", text: "That covers the whole rubric. Ready to generate the environment spec?" },
    ]);
  };
  const submitText = () => {
    if (!step || !input.trim()) return;
    const parsed = step.parse ? step.parse(input) : null;
    if (step.parse && parsed === null) {
      setMsgs((m) => [...m, { from: "user", text: input }, { from: "agent", text: "Could you give me a slightly longer name?" }]);
    } else if (step.parse) {
      answer(input, parsed!);
    } else if (step.options) {
      const hit = step.options.find((o) => o.label.toLowerCase().includes(input.trim().toLowerCase()) || o.value === input.trim().toLowerCase());
      if (hit) answer(hit.label, hit.value);
      else setMsgs((m) => [...m, { from: "user", text: input }, { from: "agent", text: `I need one of: ${step.options!.map((o) => o.label).join(" · ")}` }]);
    }
    setInput("");
  };

  return (
    <div className="create-shell">
      <div className="create-chat">
        <div className="create-head">
          <h2>New environment</h2>
          <button className="btn ghost" onClick={onCancel}>← Back</button>
        </div>
        <div className="chat-scroll" ref={scrollRef}>
          {msgs.map((m, i) => <div key={i} className={"chat-msg " + m.from}>{m.text}</div>)}
        </div>
        {step?.options && (
          <div className="chat-options">
            {step.options.map((o) => <button key={o.value} className="btn" onClick={() => answer(o.label, o.value)}>{o.label}</button>)}
          </div>
        )}
        {step && (
          <div className="chat-input">
            <input value={input} placeholder={step.parse ? "Type a name…" : "Type or pick an option…"} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitText()} />
            <button className="btn" onClick={submitText}>Send</button>
          </div>
        )}
        {!step && (
          <div className="chat-input">
            <button className="btn primary wide" onClick={() => setGenerating(true)}>Generate environment</button>
          </div>
        )}
      </div>
      <aside className="rubric-panel">
        <h3>Design rubric</h3>
        <ul>
          {RUBRIC_ITEMS.map((it) => {
            const v = rubric[it.key];
            const active = step?.key === it.key;
            return (
              <li key={it.key}>
                {v !== null ? <span className="gen-dot done">✓</span> : <span className={"gen-dot pending" + (active ? " active" : "")} />}
                <span className={v !== null ? "done" : active ? "current" : ""}>{it.label}</span>
                {v !== null && <em>{String(v)}</em>}
              </li>
            );
          })}
        </ul>
      </aside>
      {generating && rubricComplete(rubric) && <GenerationDialog rubric={rubric} onDone={(key) => switchSpec(key)} />}
    </div>
  );
}

// ── Landing page ──────────────────────────────────────────────
export function Landing() {
  const [creating, setCreating] = useState(false);
  if (creating) return <CreateChat onCancel={() => setCreating(false)} />;
  const custom = loadCustomSpecs();
  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="brand big"><span className="ai">Twin</span><span>Forge</span></div>
        <p className="landing-sub">Spec-driven deterministic digital twins. Pick an environment, or describe a new one — every environment is just a spec file.</p>
        <div className="env-rows">
          {Object.entries(SPECS).map(([k, s]) => (
            <button key={k} className="env-row" onClick={() => switchSpec(k)}>
              <span className="env-vertical">{s.meta.vertical}</span>
              <span className="env-name">{s.meta.name}</span>
              <span className="env-desc">{s.meta.description}</span>
              <span className="env-meta">{s.floors.length} floor{s.floors.length > 1 ? "s" : ""} · {s.fleet.spawns.length} robots · {s.zones.length} zones{k in custom ? " · custom" : ""}</span>
              <span className="env-go">Open →</span>
            </button>
          ))}
        </div>
        <button className="btn primary create-btn" onClick={() => setCreating(true)}>＋ Create new environment</button>
      </div>
    </div>
  );
}
