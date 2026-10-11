import type { SupervisorAnswer } from '../../../shared/schemas';
import type { Scenario } from './scenario';

/** Stand-in for the harness supervisor's reasoning. Answers ONLY from the scenario's evidence pack. */
export interface SupervisorBrain {
  readonly name: string;
  answer(s: Scenario, question: string): Promise<SupervisorAnswer>;
}

const STOP = new Set(
  'the a an and or of to in on at for is was were be been it its this that what why how when which who did does do can could would should there their about from with by as are i you me my we our robot please tell'.split(
    ' ',
  ),
);
const stem = (t: string) => t.replace(/\.$/, '').replace(/(ing|ed|es|s)$/, '');
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((t) => !STOP.has(t))
      .map(stem)
      .filter((t) => t.length >= 3),
  );

/**
 * Deterministic fallback used in tests and when no LLM key is configured. Scores evidence facts by term overlap. It is
 * deliberately conservative: below the threshold it reports INSUFFICIENT_EVIDENCE instead of guessing.
 */
export class FactLookupSupervisor implements SupervisorBrain {
  readonly name = 'fact-lookup';

  async answer(s: Scenario, question: string): Promise<SupervisorAnswer> {
    const q = tokens(question);
    const score = (tags: string[], text: string) => {
      const tagHits = new Set(tags.map((t) => stem(t.toLowerCase())).filter((t) => q.has(t))).size;
      const textHits = [...tokens(text)].filter((t) => q.has(t)).length;
      return tagHits * 2 + textHits;
    };
    const missing = s.evidence.unavailable
      .map((u) => ({ u, sc: score(u.tags, u.topic) }))
      .filter((x) => x.sc >= 2)
      .sort((a, b) => b.sc - a.sc)[0];
    const facts = s.evidence.facts
      .map((f) => ({ f, sc: score(f.tags, f.text) }))
      .filter((x) => x.sc >= 3)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 3);

    if (missing && (!facts.length || missing.sc >= facts[0].sc)) {
      return {
        status: 'INSUFFICIENT_EVIDENCE',
        evidence_refs: [],
        limitations: `${missing.u.topic}: ${missing.u.reason}`,
        confidence: s.evidence.overall_confidence,
      };
    }
    if (!facts.length) {
      return {
        status: 'INSUFFICIENT_EVIDENCE',
        evidence_refs: [],
        limitations:
          'The supervisor has no evidence that addresses this question. Available evidence covers: ' +
          [...new Set(s.evidence.facts.flatMap((f) => f.tags.slice(0, 2)))].slice(0, 8).join(', ') +
          '.',
      };
    }
    return {
      status: 'ANSWERED',
      answer: facts.map(({ f }) => `[${f.kind}] ${f.text}`).join(' '),
      evidence_refs: facts.map(({ f }) => f.id),
      confidence: s.evidence.overall_confidence,
      limitations: 'Answer assembled from matching evidence records (fact-lookup mock, no reasoning).',
    };
  }
}
