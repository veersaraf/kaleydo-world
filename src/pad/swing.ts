// Swing detection from raw phone motion.
//
// Everything is measured relative to the real world, not the phone, so it
// works whichever way the phone is gripped:
//
//  • power    — peak angular speed of the swing.
//  • side     — forehand / backhand / overhead, from the rotation about the
//               world's vertical axis (a right-hander's forehand sweeps
//               right→left = counter-clockwise seen from above).
//  • spin     — the racket's angle of attack at contact: vertical speed of the
//               phone (integrated from the moment the swing started) divided
//               by its speed along the arc. Brushing up = topspin, chopping
//               down = slice — for gentle and hard swings alike.
//  • prep     — a wind-up (backswing) before the swing tells the game which
//               side you're setting up on, so your player can get there.
//
// Vertical acceleration = dot(acceleration, g) with g = accelerationIncludingGravity
// − acceleration from the same event. iOS reports both with the opposite sign to
// the W3C spec, so the product is the same everywhere. For the rotation we need a
// true "up", which comes from the device orientation (β, γ) when available.

export type Side = 'fh' | 'bh' | 'oh';

export interface MotionSample {
  t: number;
  rx: number;
  ry: number;
  rz: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  /** true up vector in device coordinates (from orientation), if known */
  up?: [number, number, number];
  /** device→earth orientation quaternion at this sample, if known */
  q?: [number, number, number, number];
}

export interface SwingEvent {
  /** timestamp of the peak angular speed (≈ racket-ball contact) */
  t: number;
  power: number;
  spin: number;
  peak: number;
  duration: number;
  side: Side;
  /** −1..1: share of the rotation about the vertical axis (+ = counter-clockwise from above) */
  yaw: number;
  /** angle of attack, degrees (+ = brushing up) */
  attack: number;
  /** angular velocity (device frame, rad/s) and orientation at the peak */
  omega: [number, number, number];
  q: [number, number, number, number] | null;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const N = 96;
/**
 * A swing's peak is past once its speed is below 80% of it, or 70 ms have gone by — or, for a swing
 * that counts, once the speed has fallen FALLS samples running over at least FALL_MS (the second
 * fall comes a sample sooner than the 80% mark does, ~17 ms at 60 Hz; the time keeps a fast sensor's
 * noise, or samples handed over in a bunch, from calling a peak early).
 */
const FALLS = 2;
const FALL_MS = 25;

/**
 * The swing's ONSET (onStart): the first sample at which a swing that has begun (state 1, speed above
 * START) is also clearly accelerating, ~100 ms (tennis-strength swings: 115) before the peak that
 * confirms it. The TV starts the character's stroke on it and lets the confirmed swing decide everything
 * else. It fires when the speed is at a new high, has only risen over the last `span` ms of samples
 * (2 samples at 60 Hz, whatever the sensor's rate), is gaining at least `slope` rad/s², and — a
 * projection: the speed `hor` seconds on at that rate — would reach `proj` × MIN_PEAK (so a fast
 * riser fires while it is still slow, and a wobble that crawls over START doesn't). A swing that opens
 * already at `entry` × MIN_PEAK fires on its first sample. Slope and levels are per sensitivity, like
 * the detector's own (÷ k). Tuned on captures/veer-20260928-193627 (scripts/tools/replay-capture.ts): with
 * `hor` × `proj` any looser, false starts pass 5% for a few more ms of lead.
 *   side   |yaw share| needed to call forehand / backhand at the onset (below: undecided)
 */
export const ONSET = { slope: 40, span: 24, hor: 0.08, proj: 1.4, entry: 0.75, side: 0.3 };

export class SwingDetector {
  /** 0.7 = needs big swings … 1.4 = very light swings trigger */
  sensitivity = 1;
  /** +1 right-handed, −1 left-handed */
  handed = 1;
  /** sign relating (accG − acc) to true up when no orientation is known (iOS: −1) */
  upSign = 1;
  onSwing: (e: SwingEvent) => void = () => {};
  onPrep: (side: 'fh' | 'bh') => void = () => {};
  /** a swing has started (its speed is climbing fast): once per swing, before it is confirmed. `w` rad/s at that sample */
  onStart: (e: { t: number; side?: 'fh' | 'bh'; w: number; dw: number }) => void = () => {};
  /** live angular speed (rad/s) for UI meters */
  live = 0;

  // ring buffer
  private T = new Float64Array(N);
  private W = new Float32Array(N);
  private WU = new Float32Array(N);
  private AU = new Float32Array(N);
  private Q = new Float32Array(N * 4);
  private OM = new Float32Array(N * 3);
  private hasQ = new Uint8Array(N);
  private head = 0;
  private count = 0;

  private state: 0 | 1 | 2 = 0; // idle, swinging, follow-through
  private peak = 0;
  private peakT = 0;
  private peakIdx = 0;
  private start = 0;
  private lastT = 0;
  private cooldownUntil = 0;
  private followUntil = 0;
  private prevW = 0;
  private lastPeak = 0;
  private minSince = 0;
  /** consecutive samples the speed has fallen since its peak */
  private falls = 0;
  // wind-up tracking
  private windPeak = 0;
  private windYaw = 0;
  private windW = 0;
  private windSent = 0;
  // onset tracking (per swing in progress)
  private onsetSent = false;
  private onsetYaw = 0;
  private onsetW = 0;

  reset() {
    this.state = 0;
    this.cooldownUntil = 0;
  }

  /**
   * Forget everything: the swing in progress, the history, the wind-up. For when the detector
   * has been left unfed (the phone was in another sport) and its ring holds old motion.
   */
  restart() {
    this.reset();
    this.count = 0;
    this.lastT = 0;
    this.prevW = 0;
    this.live = 0;
    this.peak = this.peakT = this.peakIdx = this.start = 0;
    this.followUntil = 0;
    this.lastPeak = this.minSince = 0;
    this.falls = 0;
    this.windPeak = this.windYaw = this.windW = 0;
    this.windSent = 0;
    this.onsetSent = false;
  }

  private idx(back: number) {
    return (this.head - 1 - back + N * 4) % N;
  }

  push(s: MotionSample) {
    const dt = this.lastT ? clamp((s.t - this.lastT) / 1000, 0.004, 0.05) : 1 / 60;
    this.lastT = s.t;
    const raw = Math.hypot(s.rx, s.ry, s.rz);
    const w = 0.6 * raw + 0.4 * this.prevW;
    this.prevW = raw;
    const falling = w < this.live;
    this.live = w;

    const gl = Math.hypot(s.gx, s.gy, s.gz);
    const aUp = gl > 1 ? (s.ax * s.gx + s.ay * s.gy + s.az * s.gz) / gl : 0;
    let ux: number, uy: number, uz: number;
    if (s.up) {
      ux = s.up[0];
      uy = s.up[1];
      uz = s.up[2];
    } else if (gl > 1) {
      ux = (s.gx / gl) * this.upSign;
      uy = (s.gy / gl) * this.upSign;
      uz = (s.gz / gl) * this.upSign;
    } else [ux, uy, uz] = [0, 1, 0];
    const wUp = s.rx * ux + s.ry * uy + s.rz * uz;

    const i = this.head;
    this.T[i] = s.t;
    this.W[i] = w;
    this.WU[i] = wUp;
    this.AU[i] = aUp;
    this.OM[i * 3] = s.rx;
    this.OM[i * 3 + 1] = s.ry;
    this.OM[i * 3 + 2] = s.rz;
    if (s.q) {
      this.Q.set(s.q, i * 4);
      this.hasQ[i] = 1;
    } else this.hasQ[i] = 0;
    this.head = (this.head + 1) % N;
    this.count = Math.min(N, this.count + 1);

    const k = this.sensitivity;
    const START = 4.2 / k;
    const MIN_PEAK = 7.0 / k;
    const FULL = 22 / Math.sqrt(k);
    const END = 3.0;
    const WIND = 2.4 / k;

    if (this.state === 0) {
      // wind-up: a gentler rotation with a clear direction = the backswing
      if (w > WIND) {
        this.windPeak = Math.max(this.windPeak, w);
        this.windYaw += wUp * dt;
        this.windW += w * dt;
      } else if (this.windPeak > 0) {
        const ratio = this.windW > 0 ? this.windYaw / this.windW : 0;
        if (this.windPeak < MIN_PEAK && Math.abs(ratio) > 0.45 && s.t - this.windSent > 250) {
          // turning clockwise (for a right-hander) winds up a forehand
          this.onPrep(ratio * this.handed < 0 ? 'fh' : 'bh');
          this.windSent = s.t;
        }
        this.windPeak = this.windYaw = this.windW = 0;
      }
      if (w > START && s.t >= this.cooldownUntil) {
        this.state = 1;
        this.start = s.t;
        this.peak = w;
        this.peakT = s.t;
        this.peakIdx = i;
        this.falls = 0;
        // (the rotation already accumulated in this run above WIND is the swing's first part)
        this.beginOnset(this.windYaw, this.windW);
        this.checkOnset(s.t, w, dt, wUp, k, true);
      }
      return;
    }

    if (this.state === 1) {
      if (w >= this.peak) {
        this.peak = w;
        this.peakT = s.t;
        this.peakIdx = i;
        this.falls = 0;
        this.checkOnset(s.t, w, dt, wUp, k, false);
      } else if (
        (falling ? ++this.falls : (this.falls = 0)) >= FALLS && s.t - this.peakT >= FALL_MS && this.peak >= MIN_PEAK ||
        w < this.peak * 0.8 ||
        s.t - this.peakT > 70
      ) {
        if (this.peak >= MIN_PEAK) {
          this.emit(MIN_PEAK, FULL);
          this.state = 2;
          this.followUntil = Math.max(s.t, this.peakT + 50) + 380;
          this.lastPeak = this.peak;
          this.minSince = this.peak;
          this.windPeak = this.windYaw = this.windW = 0;
        } else {
          this.state = 0;
          this.cooldownUntil = s.t + 40;
        }
      }
      if (this.state === 1 && s.t - this.start > 650) this.state = 0;
      return;
    }

    // follow-through: ignore the racket coming back until motion settles…
    this.minSince = Math.min(this.minSince, w);
    // …unless that was a backswing: the motion stopped, turned round and is
    // now accelerating again — that's the real swing
    if (this.minSince < this.lastPeak * 0.45 && w > START && w > this.minSince * 2.2) {
      this.state = 1;
      this.start = s.t;
      this.peak = w;
      this.peakT = s.t;
      this.peakIdx = i;
      this.falls = 0;
      this.beginOnset(0, 0);
      this.checkOnset(s.t, w, dt, wUp, k, true);
      return;
    }
    if ((w < END && s.t > this.peakT + 140) || s.t > this.followUntil) {
      this.state = 0;
      this.cooldownUntil = s.t + 80;
    }
  }

  private beginOnset(yaw: number, wsum: number) {
    this.onsetSent = false;
    this.onsetYaw = yaw;
    this.onsetW = wsum;
  }

  /** Called on each new speed high of a swing in progress (state 1); fires onStart once. */
  private checkOnset(t: number, w: number, dt: number, wUp: number, k: number, entry: boolean) {
    if (this.onsetSent) return;
    if (!entry) {
      this.onsetYaw += wUp * dt;
      this.onsetW += w * dt;
    }
    const minPeak = 7.0 / k;
    let fire = entry && w >= ONSET.entry * minPeak;
    let dw = 0;
    if (!fire) {
      // the samples the slope is read over: the newest at least `span` ms back (of the last few)
      const ti = this.T[this.idx(0)];
      let j = -1;
      for (let b = 1; b < Math.min(this.count, 7); b++) {
        const tb = this.T[this.idx(b)];
        if (ti - tb > 90) break;
        if (ti - tb >= ONSET.span) {
          j = b;
          break;
        }
      }
      if (j > 0) {
        // (monotone: none of the samples between fell)
        let up = true;
        for (let b = j; b > 0 && up; b--) if (this.W[this.idx(b - 1)] < this.W[this.idx(b)] - 0.05) up = false;
        const slope = ((w - this.W[this.idx(j)]) / (ti - this.T[this.idx(j)])) * 1000;
        dw = slope;
        fire = up && slope >= ONSET.slope / k && w + slope * ONSET.hor >= ONSET.proj * minPeak;
      }
    }
    if (!fire) return;
    this.onsetSent = true;
    const ratio = this.onsetW > 0 ? this.onsetYaw / this.onsetW : 0;
    const side = Math.abs(ratio) < ONSET.side ? undefined : ratio * this.handed > 0 ? 'fh' : 'bh';
    this.onStart({ t, side, w, dw });
  }

  private emit(minPeak: number, full: number) {
    // walk back from the peak to where this swing began (the turnaround)
    const peakBack = (this.head - 1 - this.peakIdx + N) % N;
    let startBack = peakBack;
    let minW = Infinity;
    for (let b = peakBack; b < Math.min(this.count - 1, peakBack + 30); b++) {
      const j = this.idx(b);
      if (this.T[this.idx(peakBack)] - this.T[j] > 450) break;
      if (this.W[j] < minW) {
        minW = this.W[j];
        startBack = b;
      }
      if (this.W[j] < this.peak * 0.18) break;
    }
    // bias: mean vertical acceleration just before the swing
    let bias = 0,
      nb = 0;
    for (let b = startBack + 1; b < Math.min(this.count, startBack + 6); b++) {
      bias += this.AU[this.idx(b)];
      nb++;
    }
    bias = nb ? bias / nb : 0;
    if (Math.abs(bias) > 3) bias = 0; // the "rest" was itself moving; don't trust it
    let vUp = 0,
      yaw = 0,
      wsum = 0;
    for (let b = startBack; b >= peakBack; b--) {
      const j = this.idx(b);
      const jn = this.idx(Math.max(peakBack, b - 1));
      const dt = b === peakBack ? 1 / 60 : clamp((this.T[jn] - this.T[j]) / 1000, 0.004, 0.05);
      vUp += (this.AU[j] - bias) * dt;
      yaw += this.WU[j] * dt;
      wsum += this.W[j] * dt;
    }
    const yawRatio = wsum > 0 ? clamp(yaw / wsum, -1, 1) : 0;
    // speed along the arc at contact ≈ ω × effective radius (forearm + hand ≈ 0.5 m)
    const arc = Math.max(1.5, this.peak * 0.5);
    const ratio = vUp / arc;
    const attack = (Math.asin(clamp(ratio, -1, 1)) * 180) / Math.PI;
    const dead = 0.07;
    const spin = Math.abs(ratio) < dead ? 0 : clamp((ratio - Math.sign(ratio) * dead) / 0.24, -1, 1);
    const side: Side = Math.abs(yawRatio) < 0.35 ? 'oh' : yawRatio * this.handed > 0 ? 'fh' : 'bh';
    const p = clamp((this.peak - minPeak) / (full - minPeak), 0, 1);
    this.onSwing({
      t: this.peakT,
      power: Math.pow(p, 0.85),
      spin,
      peak: this.peak,
      duration: this.peakT - this.T[this.idx(startBack)],
      side,
      yaw: yawRatio,
      attack,
      omega: [this.OM[this.peakIdx * 3], this.OM[this.peakIdx * 3 + 1], this.OM[this.peakIdx * 3 + 2]],
      q: this.hasQ[this.peakIdx] ? [this.Q[this.peakIdx * 4], this.Q[this.peakIdx * 4 + 1], this.Q[this.peakIdx * 4 + 2], this.Q[this.peakIdx * 4 + 3]] : null,
    });
  }
}

/** True up in device coordinates from DeviceOrientation β, γ (degrees). */
export function upFromOrientation(betaDeg: number, gammaDeg: number): [number, number, number] {
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}
