// Lift to toss (Switch Sports-style): while it's your serve, raising the phone
// tosses the ball.
//
// The phone's vertical acceleration (gravity taken out) integrates to its vertical
// speed. A toss is the phone moving up: the speed passes LIFT_V. The integration
// is kept honest rather than leaky — the speed is pulled back to zero whenever
// the phone is still (it can't be moving then), and leaks only slowly otherwise
// — because bringing the phone down and stopping it at the bottom pushes upward
// too (the braking), and a leaky estimate forgets the way down and reads that
// braking as a lift. That's what used to toss the ball as the phone came back
// down. A toss has to start from a phone held fairly still, so waving it about
// while you wait doesn't toss; a big swing doesn't either.

/** how fast the phone has to be rising, m/s */
export const LIFT_V = 0.42;
/** the phone was still this recently (ms) when the lift began */
const STILL_WINDOW = 1000;
/** no second toss within this long (ms) */
const REFRACTORY = 1000;

export class LiftDetector {
  /** vertical speed, m/s (+ up) */
  v = 0;
  private lastStill = -1e9;
  private lastLift = -1e9;
  /** since when it's been still, continuously (ms), or −1 */
  private stillSince = -1;
  /** recent speeds, to know whether the phone was just on its way down */
  private hist: { t: number; v: number }[] = [];

  reset() {
    this.v = 0;
    this.hist.length = 0;
  }

  /**
   * One motion sample: `aUp` the upward acceleration (m/s², gravity removed),
   * `w` how fast the phone's turning (rad/s), `dt` seconds since the last sample.
   * Returns true when this sample is a toss.
   */
  push(now: number, aUp: number, w: number, dt: number): boolean {
    if (!(dt > 0) || dt > 0.2) return false;
    const still = w < 1.2 && Math.abs(aUp) < 0.9;
    if (still) {
      this.lastStill = now;
      if (this.stillSince < 0) this.stillSince = now;
    } else this.stillSince = -1;
    this.v = this.v * Math.exp(-dt / 2) + aUp * dt;
    // held still for a while: it isn't moving, whatever the sum says (sensor bias can't
    // pile up). (Not after a moment's quiet: a hand moving at a steady speed feels no
    // acceleration either.)
    if (this.stillSince >= 0 && now - this.stillSince > 180) this.v *= Math.exp(-dt / 0.08);
    this.hist.push({ t: now, v: this.v });
    while (this.hist.length && this.hist[0].t < now - 450) this.hist.shift();
    if (this.v > LIFT_V && w < 9 && now - this.lastStill < STILL_WINDOW && now - this.lastLift > REFRACTORY) {
      // the phone was on its way down a moment ago: this is it stopping, not a lift
      let low = 0;
      for (const h of this.hist) low = Math.min(low, h.v);
      if (low < -0.45) return false;
      this.lastLift = now;
      this.v = 0;
      return true;
    }
    return false;
  }
}
