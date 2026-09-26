import type { V3 } from '../core/math';

export type EyeState = 'open' | 'happy' | 'closed' | 'focus' | 'sad' | 'wide';
export type MouthState = 'smile' | 'open' | 'flat' | 'frown' | 'grin' | 'o';

/** Everything a rig needs to draw a character for one frame. Local space: x right, y up, -z forward. */
export interface Pose {
  x: number;
  z: number;
  yaw: number;
  hop: number;
  body: V3;
  bodyPitch: number;
  bodyYaw: number;
  bodyRoll: number;
  squash: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  /** [racket hand, off hand] in root space */
  hands: [V3, V3];
  racketDir: V3;
  racketFace: V3;
  feet: [V3, V3];
  footPitch: [number, number];
  legLift: number;
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
  blink: number;
  /** the off hand is holding the ball (serve) */
  holdingBall: boolean;
  handed: 1 | -1;
}

export function newPose(): Pose {
  return {
    x: 0,
    z: 0,
    yaw: 0,
    hop: 0,
    body: { x: 0, y: 0.2, z: 0 },
    bodyPitch: 0,
    bodyYaw: 0,
    bodyRoll: 0,
    squash: 1,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    hands: [
      { x: 0.3, y: 0.9, z: -0.3 },
      { x: -0.1, y: 0.9, z: -0.35 },
    ],
    racketDir: { x: 0, y: 1, z: 0 },
    racketFace: { x: 0, y: 0, z: -1 },
    feet: [
      { x: -0.14, y: 0, z: 0 },
      { x: 0.14, y: 0, z: 0 },
    ],
    footPitch: [0, 0],
    legLift: 0,
    eyes: 'open',
    mouth: 'smile',
    brow: 0,
    blink: 0,
    holdingBall: false,
    handed: 1,
  };
}

const cp = (d: V3, s: V3) => {
  d.x = s.x;
  d.y = s.y;
  d.z = s.z;
};

/** Copy a pose into an existing one (no allocation — used for replay recording). */
export function copyPose(d: Pose, s: Pose): Pose {
  d.x = s.x;
  d.z = s.z;
  d.yaw = s.yaw;
  d.hop = s.hop;
  cp(d.body, s.body);
  d.bodyPitch = s.bodyPitch;
  d.bodyYaw = s.bodyYaw;
  d.bodyRoll = s.bodyRoll;
  d.squash = s.squash;
  d.headPitch = s.headPitch;
  d.headYaw = s.headYaw;
  d.headRoll = s.headRoll;
  cp(d.hands[0], s.hands[0]);
  cp(d.hands[1], s.hands[1]);
  cp(d.racketDir, s.racketDir);
  cp(d.racketFace, s.racketFace);
  cp(d.feet[0], s.feet[0]);
  cp(d.feet[1], s.feet[1]);
  d.footPitch[0] = s.footPitch[0];
  d.footPitch[1] = s.footPitch[1];
  d.legLift = s.legLift;
  d.eyes = s.eyes;
  d.mouth = s.mouth;
  d.brow = s.brow;
  d.blink = s.blink;
  d.holdingBall = s.holdingBall;
  d.handed = s.handed;
  return d;
}
