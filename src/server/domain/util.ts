export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * Heuristic guard for voice decisions: the human's confirmation must name the decision and the exact revision number,
 * e.g. "I approve revision 2". This does not replace identity verification; it prevents a casual "yes" from counting.
 */
export function confirmationMatches(utterance: string, decision: 'APPROVE' | 'REJECT', revision: number): boolean {
  const u = utterance.toLowerCase();
  const verb = decision === 'APPROVE' ? /\bapprov/ : /\breject/;
  if (!verb.test(u)) return false;
  if (decision === 'APPROVE' && /\b(not|don't|do not|never)\b[^.]{0,20}approv/.test(u)) return false;
  const nums = [...u.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]));
  for (const [w, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`).test(u)) nums.push(n);
  return nums.includes(revision);
}
