// Ten-pin scoring: strikes, spares, the 10th frame's bonus balls, and the
// marks a scoreboard shows ('X', '/', '-', digits).

export interface FrameMarks {
  /** the boxes of the frame, e.g. ['X'], ['7', '/'], ['9', '-'], ['X', '7', '/'] */
  rolls: string[];
  /** cumulative score up to this frame once it is known (null while rolls or bonus balls are pending) */
  total: number | null;
}

/** Where the next roll goes. */
interface Cursor {
  frame: number;
  ball: number;
  standing: number;
  fresh: boolean;
  done: boolean;
}

export class BowlScore {
  /** pins knocked down per roll, in order */
  rolls: number[] = [];

  /** Record a roll. Throws if the game is over or more pins fall than were standing. */
  add(pins: number): void {
    const c = this.cursor();
    if (c.done) throw new Error('BowlScore: the game is over');
    if (!Number.isInteger(pins) || pins < 0 || pins > c.standing) {
      throw new RangeError(`BowlScore: ${pins} pins, but ${c.standing} were standing`);
    }
    this.rolls.push(pins);
  }

  /** current frame index 0..9 (stays 9 while finishing the 10th, and after the game) */
  get frame(): number {
    return this.cursor().frame;
  }

  /** roll index within the current frame (0, 1, or 2 in the 10th) */
  get ball(): number {
    return this.cursor().ball;
  }

  get done(): boolean {
    return this.cursor().done;
  }

  /** pins standing for the next roll (10 on a fresh rack, 0 once the game is over) */
  standingBeforeRoll(): number {
    return this.cursor().standing;
  }

  /** The next roll starts with a new rack of 10: a new frame, or a 10th-frame bonus ball after a strike or spare. */
  needsFreshRack(): boolean {
    return this.cursor().fresh;
  }

  /** Scoreboard marks and cumulative totals — always 10 entries. */
  frames(): FrameMarks[] {
    const r = this.rolls;
    const out: FrameMarks[] = [];
    let i = 0;
    let sum = 0;
    let known = true; // once a frame's total is unknown, every later total is too
    for (let f = 0; f < 10; f++) {
      if (i >= r.length) {
        out.push({ rolls: [], total: null });
        known = false;
        continue;
      }
      if (f < 9) {
        if (r[i] === 10) {
          const bonus = r.length >= i + 3;
          if (bonus) sum += 10 + r[i + 1] + r[i + 2];
          known &&= bonus;
          out.push({ rolls: ['X'], total: known ? sum : null });
          i += 1;
          continue;
        }
        const marks = [mark(r[i])];
        if (i + 1 >= r.length) {
          out.push({ rolls: marks, total: null });
          known = false;
          i += 1;
          continue;
        }
        const spare = r[i] + r[i + 1] === 10;
        marks.push(spare ? '/' : mark(r[i + 1]));
        const complete = !spare || r.length >= i + 3;
        if (complete) sum += r[i] + r[i + 1] + (spare ? r[i + 2] : 0);
        known &&= complete;
        out.push({ rolls: marks, total: known ? sum : null });
        i += 2;
        continue;
      }
      // 10th frame: up to three balls; a ball after a strike or a spare is on a fresh rack
      const t = r.slice(i, i + 3);
      const marks: string[] = [];
      let fresh = true;
      let prev = 0;
      for (const p of t) {
        if (fresh) {
          marks.push(p === 10 ? 'X' : mark(p));
          fresh = p === 10;
          prev = p === 10 ? 0 : p;
        } else {
          marks.push(prev + p === 10 ? '/' : mark(p));
          fresh = prev + p === 10;
          prev = 0;
        }
      }
      const complete = t.length === 3 || (t.length === 2 && t[0] + t[1] < 10);
      if (complete) sum += t.reduce((a, b) => a + b, 0);
      known &&= complete;
      out.push({ rolls: marks, total: known ? sum : null });
    }
    return out;
  }

  /**
   * Running total so far: every pin knocked down plus the strike/spare bonuses
   * from balls already rolled (so it never waits for a pending bonus). Equals
   * the final score once the game is done.
   */
  total(): number {
    const r = this.rolls;
    let i = 0;
    let sum = 0;
    for (let f = 0; f < 10 && i < r.length; f++) {
      if (f === 9) {
        for (let k = i; k < r.length; k++) sum += r[k];
        break;
      }
      if (r[i] === 10) {
        sum += 10 + (r[i + 1] ?? 0) + (r[i + 2] ?? 0);
        i += 1;
      } else if (i + 1 < r.length) {
        const spare = r[i] + r[i + 1] === 10;
        sum += r[i] + r[i + 1] + (spare ? (r[i + 2] ?? 0) : 0);
        i += 2;
      } else {
        sum += r[i];
        i += 1;
      }
    }
    return sum;
  }

  private cursor(): Cursor {
    const r = this.rolls;
    let i = 0;
    for (let f = 0; f < 9; f++) {
      if (i >= r.length) return { frame: f, ball: 0, standing: 10, fresh: true, done: false };
      if (r[i] === 10) {
        i += 1;
        continue;
      }
      if (i + 1 >= r.length) return { frame: f, ball: 1, standing: 10 - r[i], fresh: false, done: false };
      i += 2;
    }
    const t = r.slice(i);
    const over: Cursor = { frame: 9, ball: 2, standing: 0, fresh: false, done: true };
    if (t.length === 0) return { frame: 9, ball: 0, standing: 10, fresh: true, done: false };
    if (t.length === 1) {
      return t[0] === 10
        ? { frame: 9, ball: 1, standing: 10, fresh: true, done: false }
        : { frame: 9, ball: 1, standing: 10 - t[0], fresh: false, done: false };
    }
    if (t.length === 2) {
      if (t[0] === 10) {
        // bonus ball after a strike: fresh rack if the 2nd ball was a strike too
        return t[1] === 10
          ? { frame: 9, ball: 2, standing: 10, fresh: true, done: false }
          : { frame: 9, ball: 2, standing: 10 - t[1], fresh: false, done: false };
      }
      if (t[0] + t[1] === 10) return { frame: 9, ball: 2, standing: 10, fresh: true, done: false };
      return over;
    }
    return over;
  }
}

function mark(p: number): string {
  return p === 0 ? '-' : String(p);
}
