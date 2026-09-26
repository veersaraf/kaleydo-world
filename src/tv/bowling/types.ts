// Contracts between the bowling pieces: physics ↔ game ↔ rendering ↔ animation.

/** A throw, as measured from the player's swing (or a CPU / keyboard throw). */
export interface BallThrow {
  /** world x of the ball at release (the foul line is at FOUL_Z) */
  x: number;
  /** speed along the throw direction, m/s (a typical good throw is 7–8.5) */
  speed: number;
  /** direction, radians from straight down the lane (−z); + = towards +x (the bowler's right) */
  angle: number;
  /** −1..1 side spin: + hooks to the LEFT late in the lane (a right-hander's hook), − to the right */
  spin: number;
}

/** Position + rotation of a rigid body in world space. */
export interface BodyPose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Everything the renderer needs to draw the bowling objects for one frame. */
export interface BowlView {
  ball: BodyPose & { visible: boolean; gutter: boolean };
  /** 10 pins in pin-number order (index 0 = pin 1) */
  pins: (BodyPose & { visible: boolean })[];
}

/** Things the physics reports (for sound, camera and effects). */
export type BowlPhysicsEvent =
  /** the ball touched down on the lane */
  | { type: 'roll'; speed: number }
  /** the ball dropped into a gutter */
  | { type: 'gutter'; x: number; z: number }
  /** a collision worth a sound: ball–pin or pin–pin (impact = relative speed, m/s) */
  | { type: 'hit'; impact: number; x: number; z: number; ballOnPin: boolean }
  /** the ball (or a pin) fell into the pit */
  | { type: 'pit'; impact: number }
  /** everything has stopped moving (or timed out): pins can be counted */
  | { type: 'settled' };

/** What the bowler is doing — the input to the bowler animator. */
export interface BowlerState {
  /** world position of the character's root, and facing (0 = facing −z, down the lane) */
  x: number;
  z: number;
  yaw: number;
  handed: 1 | -1;
  phase: 'idle' | 'ready' | 'approach' | 'release' | 'follow' | 'watch' | 'cheer' | 'sad';
  /** seconds since the phase began */
  t: number;
  /** the bowling arm's pendulum angle, radians: 0 = hanging straight down,
   *  + = swung forward/up, − = back swing (behind the body) */
  arm: number;
  /** approach progress 0..1 (the steps towards the foul line) */
  step: number;
  /** the ball is in the hand */
  holding: boolean;
  /** −1..1: the spin put on the ball (the wrist turns through it after release) */
  spin: number;
}
