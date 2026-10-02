// A running hash of a match's event stream (type, time, who, where, how fast), so two runs of the
// same seed can be compared bit for bit: a refactor that only moves allocations must print the same
// hashes; a change to the rules will not. Used by sim.ts, sim-human.ts and sim-smash.ts.
import type { MatchEvent } from '../../src/tv/tennis/match';

export class EventHash {
  h = 0x811c9dc5;
  n = 0;
  private mix(s: string) {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i);
      this.h = Math.imul(this.h, 0x01000193) >>> 0;
    }
  }
  add(t: number, e: MatchEvent) {
    const f = (v: number | undefined) => (v === undefined ? '-' : v.toFixed(5));
    let s = `${e.type}@${t.toFixed(5)}`;
    const pos = (e as { pos?: { x: number; y: number; z: number } }).pos;
    if (pos) s += `:${f(pos.x)},${f(pos.y)},${f(pos.z)}`;
    const p = (e as { p?: { id: number } }).p;
    if (p) s += `#${p.id}`;
    if (e.type === 'hit') s += `/${e.kind}/${f(e.kph)}/${f(e.tau)}/${f(e.power)}/${e.perfect ? 1 : 0}`;
    if (e.type === 'whiff') s += `/${f(e.tau)}/${e.why ?? ''}`;
    if (e.type === 'point') s += `/${e.winner}/${e.reason}/${e.rally}`;
    if (e.type === 'bounce') s += `/${f(e.impact)}/${e.live ? 1 : 0}${e.out ? 1 : 0}`;
    this.mix(s);
    this.n++;
  }
  toString() {
    return `${this.h.toString(16).padStart(8, '0')}/${this.n}`;
  }
}

/** the tennis code has a few Math.random() calls (a lob's height...): seed them so a run repeats exactly */
export function seedMathRandom(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 1;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
