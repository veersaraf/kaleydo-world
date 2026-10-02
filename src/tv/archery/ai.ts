// CPU archers. Each arrow they shoot at the main face: they work out the aim
// that puts a full-draw arrow in its centre — the drop allowed for, the wind as
// well as they can judge it, and a lead if the face is moving — and then shoot
// with the steadiness their skill gives them. Each end they misjudge the new
// distance and wind a little at first and halve that error arrow by arrow, like
// someone reading where their last one went. They nock, look at the target a
// moment, draw, bring the bow up and settle onto their aim at full draw, and let
// go. Skill 0..1 (the menu: Rookie 0.3, Pro 0.65, Ace 0.9) sets how steady, how
// good at reading the wind and how quick.

import { RANGE } from './range';
import { aimFor, clampAim, flyTo, targetX, type Aim } from './physics';
import type { ArcheryGame } from './game';
import { Rng, clamp, lerp, smooth } from '../core/math';

export interface CpuProfile {
  /** the release: aim error σ, radians (each of yaw and pitch) */
  aimErr: number;
  /** misjudging a new end (the distance, the light): σ radians, halved with each arrow after the first */
  bias: number;
  /** misreading the wind: σ, as a share of its drift */
  windErr: number;
  /** misjudging a moving face's lead: σ, as a share of the flight time */
  leadErr: number;
  /** looking at the target before drawing, s */
  think: number;
  /** at full draw before letting go, s */
  hold: number;
  /** how far the bow wanders while it settles (σ, radians), gone by the release */
  settle: number;
}

/**
 * Each number at skill 0, then the menu's Rookie (0.3), Pro (0.65) and Ace
 * (0.9), then 1 — tuned with scripts/check/archery-sim.ts to average about 6.5, 8 and
 * 9.2 points an arrow over the three standard ends.
 */
const SKILLS = [0, 0.3, 0.65, 0.9, 1];
export const CPU_TABLE: Record<'aimErrMrad' | 'biasMrad' | 'windErr' | 'leadErr' | 'think' | 'hold' | 'settleMrad', number[]> = {
  aimErrMrad: [9.5, 7.0, 4.3, 1.8, 1.3],
  biasMrad: [8, 6, 3.6, 1.6, 1.1],
  windErr: [0.7, 0.55, 0.28, 0.1, 0.06],
  leadErr: [0.45, 0.3, 0.12, 0.05, 0.03],
  think: [1.4, 1.2, 1.0, 0.85, 0.8],
  hold: [0.7, 0.9, 1.1, 1.2, 1.2],
  settleMrad: [22, 18, 12, 8, 7],
};

function at(v: number[], s: number) {
  let n = 0;
  while (n < SKILLS.length - 2 && SKILLS[n + 1] < s) n++;
  return lerp(v[n], v[n + 1], clamp((s - SKILLS[n]) / (SKILLS[n + 1] - SKILLS[n])));
}

export function cpuProfile(skill: number): CpuProfile {
  const s = clamp(skill);
  const T = CPU_TABLE;
  return {
    aimErr: at(T.aimErrMrad, s) / 1000,
    bias: at(T.biasMrad, s) / 1000,
    windErr: at(T.windErr, s),
    leadErr: at(T.leadErr, s),
    think: at(T.think, s),
    hold: at(T.hold, s),
    settle: at(T.settleMrad, s) / 1000,
  };
}

export class ArcheryCpu {
  readonly p: CpuProfile;
  private rng: Rng;
  /** the aim it'll let go on (its errors included) */
  readonly plan: Aim = { yaw: 0, pitch: 0 };
  /** this end's misjudgement (radians), halved arrow by arrow */
  private biasYaw = 0;
  private biasPitch = 0;
  /** when it starts drawing and lets go */
  drawAt = 0;
  releaseAt = 0;
  /** the bow's wander while settling: phases, and where it came up from */
  private ph = [0, 0, 0, 0];
  private from: Aim = { yaw: 0, pitch: 0 };
  private wob = 0;

  constructor(
    readonly skill: number,
    seed: number,
  ) {
    this.p = cpuProfile(skill);
    this.rng = new Rng(seed);
  }

  /** a new arrow is up (the game has just nocked it): decide the aim and the timing */
  begin(g: ArcheryGame) {
    const p = this.p;
    const r = this.rng;
    if (g.arrowNo === 1) {
      this.biasYaw = r.gauss() * p.bias;
      this.biasPitch = r.gauss() * p.bias;
    }
    const k = Math.pow(0.5, g.arrowNo - 1);
    this.drawAt = g.nockAt + p.think * r.range(0.75, 1.3);
    this.releaseAt = this.drawAt + RANGE.drawT + p.hold * r.range(0.7, 1.35);
    const face = g.mainTarget();
    const wind = g.wind * (1 + p.windErr * r.gauss());
    // a moving face: aim where it will be when the arrow gets there
    let x = face.x;
    if (face.swayX) {
      const guess = aimFor(face.x, face.y, face.z, RANGE.fullSpeed, wind);
      const T = flyTo(guess.yaw, guess.pitch, RANGE.fullSpeed, face.z, wind).t;
      x = targetX(face, this.releaseAt + T * (1 + p.leadErr * r.gauss()) - g.endT0);
    }
    aimFor(x, face.y, face.z, RANGE.fullSpeed, wind, this.plan);
    this.plan.yaw += r.gauss() * p.aimErr + this.biasYaw * k;
    this.plan.pitch += r.gauss() * p.aimErr + this.biasPitch * k;
    clampAim(this.plan);
    for (let i = 0; i < 4; i++) this.ph[i] = r.range(0, Math.PI * 2);
    this.wob = p.settle * r.range(0.6, 1.2);
  }

  /** its hands this frame, while it's the one aiming: the aim, and the string */
  update(g: ArcheryGame) {
    const a = g.archer;
    const t = g.t;
    if (a.phase === 'nock') {
      // looking at the target, bow down
      g.cpuAim(g.home.yaw, g.home.pitch);
      this.from.yaw = g.home.yaw;
      this.from.pitch = g.home.pitch;
      if (t >= this.drawAt) g.cpuDraw(true);
      return;
    }
    if (a.phase !== 'draw' && a.phase !== 'hold') return;
    // the bow comes up onto the aim as the string comes back, wandering a little,
    // and is still (exactly on the plan) by the release
    const u = clamp((t - this.drawAt) / Math.max(0.1, this.releaseAt - this.drawAt));
    const come = smooth(clamp(u * 1.6));
    const w = this.wob * (1 - u) * (1 - u);
    const ph = this.ph;
    const tt = t - this.drawAt;
    const yaw = lerp(this.from.yaw, this.plan.yaw, come) + w * Math.sin(2 * Math.PI * 1.3 * tt + ph[0]) * 0.7 + w * Math.sin(2 * Math.PI * 3.1 * tt + ph[1]) * 0.3;
    const pitch = lerp(this.from.pitch, this.plan.pitch, come) + w * Math.sin(2 * Math.PI * 1.1 * tt + ph[2]) * 0.7 + w * Math.sin(2 * Math.PI * 2.7 * tt + ph[3]) * 0.3;
    g.cpuAim(yaw, pitch);
    if (a.phase === 'hold' && t >= this.releaseAt) {
      g.cpuAim(this.plan.yaw, this.plan.pitch);
      g.cpuDraw(false);
    }
  }
}
