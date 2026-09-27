// Contracts between the baseball pieces: phone ↔ game ↔ rendering ↔ animation.
// World coordinates as everywhere: x right (as the batting camera sees it), y up,
// the batter faces the pitcher down −z. See field.ts for the layout.

import type { Look } from '../chars/look';

export type PitchKind = 'fastball' | 'curve' | 'slider' | 'changeup';

/** A pitch as the game throws it. */
export interface Pitch {
  kind: PitchKind;
  /** average speed over its flight, m/s (world) */
  speed: number;
  /** the speed the HUD shows, km/h (a real pitch's: the diorama's pitch is a little short) */
  kmh: number;
  /** where it crosses the contact plane (FIELD.contactZ): x across, y height */
  px: number;
  py: number;
  /** game time it leaves the hand, and when it crosses the contact plane */
  t0: number;
  tc: number;
  /** does it cross the strike zone */
  strike: boolean;
}

/** A swing, from the phone (a tennis-style swing message), the mouse, the keyboard or a CPU. */
export interface BatSwing {
  /** 0..1: how hard */
  power: number;
  /** −1..1: the swing's plane — + an uppercut, − chopping down */
  lift: number;
  /** how long ago (seconds) the swing's fastest moment was, when it got here */
  age: number;
}

/** What became of a pitch. */
export type PitchOutcome = 'strike' | 'foul' | 'hit' | 'homerun';

/** A batted ball, worked out when the bat meets it. Distances are real metres (see field.ts). */
export interface BattedBall {
  /** seconds early (−) or late (+) against a perfect swing */
  timing: number;
  /** met on the sweet spot: the perfect crack */
  sweet: boolean;
  /** off the bat, real m/s */
  exitSpeed: number;
  /** radians up from level */
  launch: number;
  /** radians from straight away, + = towards +x */
  spray: number;
  /** where it comes down (or meets the fence), real metres from home plate */
  distance: number;
  /** seconds in the air, as flown (game time) */
  hang: number;
  foul: boolean;
  homeRun: boolean;
  /** hit the fence without clearing it */
  wall: boolean;
  /** where it comes down, world metres: on the field, in the stands or out of the stadium */
  landX: number;
  landY: number;
  landZ: number;
  /** its highest point, world y */
  apex: number;
}

/** The ball, for the renderer. */
export interface FieldBall {
  x: number;
  y: number;
  z: number;
  /** in the pitcher's hand or the catcher's mitt (the gear draws it there), pitched, batted, or gone */
  phase: 'hand' | 'pitch' | 'play' | 'mitt' | 'gone';
  /** world m/s (for the streak) */
  speed: number;
}

/** Effects starting this frame (world positions). */
export type FieldFx =
  /** the bat meets the ball */
  | { type: 'contact'; x: number; y: number; z: number; power: number; sweet: boolean }
  /** into the catcher's mitt */
  | { type: 'catch'; x: number; y: number; z: number }
  /** the batted ball's first touch down (the field, the stands, beyond) */
  | { type: 'land'; x: number; y: number; z: number; homeRun: boolean }
  /** it hit the fence */
  | { type: 'wall'; x: number; y: number; z: number }
  /** a home run: the celebration where it went out */
  | { type: 'homerun'; x: number; y: number; z: number };

/** Everything the field needs for one frame. */
export interface FieldView {
  ball: FieldBall;
  /** show the last batted ball's path as a tracer, from the bat to where the ball is (it's
   *  kept until the next pitch leaves the hand) */
  tracer: boolean;
  /** the batter's colour: the tracer, the marks */
  color: string;
  /** this turn's home runs, where each came down (little stars in the stands) */
  marks: { x: number; y: number; z: number }[];
  /** the camera's position: the ball is drawn bigger far away so it never shrinks to a speck */
  eye: { x: number; y: number; z: number };
  fx: FieldFx[];
}

/** Somewhere a character looks (world), or null to look ahead. */
export type LookAt = { x: number; y: number; z: number } | null;

/** What the batter (or a hitter waiting their turn) is doing — the input to the batter animator. */
export interface BatterState {
  x: number;
  z: number;
  handed: 1 | -1;
  /**
   * idle: waiting their turn off to the side (facing `yaw`), bat on the shoulder
   * stance: in the box, ready (a waggle)
   * load: the pitch is coming: the stride and the hands back
   * swing: `t` from the swing's start; the bat meets the ball at SWING.contact
   * watch: after the swing, watching where it went (bat in hand)
   * cheer: a home run (a bat flip is welcome) · sad: a miss / not far enough
   */
  phase: 'idle' | 'stance' | 'load' | 'swing' | 'watch' | 'cheer' | 'sad';
  /** seconds since the phase began */
  t: number;
  /** 'swing': its plane (+ uppercut) and how hard, 0..1 */
  lift: number;
  power: number;
  /** where the swing is aimed: the pitch's crossing of the contact plane (world x, y) */
  aimX: number;
  aimY: number;
  /** 'idle': which way to face (radians about +y, 0 = facing −z) */
  yaw: number;
  look: LookAt;
}

/** What the pitcher is doing — the input to the pitcher animator. The pitcher faces +z. */
export interface PitcherState {
  x: number;
  z: number;
  handed: 1 | -1;
  /**
   * idle: on the mound, between batters · set: ball in the glove, reading the sign
   * windup: `t` from its start; the ball leaves the hand at DELIVERY.release, at the
   * release point (field.ts) · follow: after DELIVERY.end, finishing
   * watch: turned to follow a batted ball (`look`)
   */
  phase: 'idle' | 'set' | 'windup' | 'follow' | 'watch';
  t: number;
  kind: PitchKind | null;
  look: LookAt;
  /**
   * The catcher's throw back, coming to the pitcher (from when the catcher starts
   * the throw till the ball's in the glove): where it'll reach him (world) and
   * in how many seconds (≤ 0: it's there). The glove goes up to meet it, its
   * pocket exactly there at eta = 0. Absent / null: nothing's coming.
   */
  toss?: { x: number; y: number; z: number; eta: number } | null;
}

/** What the catcher is doing — the input to the catcher animator. The catcher faces −z. */
export interface CatcherState {
  x: number;
  z: number;
  /**
   * crouch: squatting, the mitt up as a target · catch: `t` from the pitch leaving the
   * hand; the mitt meets the ball at (targetX, targetY) on FIELD.catcherZ − 0.35 at the
   * pitch's arrival (`arrive` seconds in) · throw: tossing it back to the pitcher
   * watch: standing, following a batted ball (`look`)
   */
  phase: 'crouch' | 'catch' | 'throw' | 'watch';
  t: number;
  targetX: number;
  targetY: number;
  arrive: number;
  look: LookAt;
}

/** Someone batting: a person on an input seat, or a CPU. */
export interface Hitter {
  name: string;
  color: string;
  look: Look;
  handed: 1 | -1;
  /** input seat, or −1 for a CPU */
  slot: number;
  /** CPU skill 0..1 (null = a person) */
  cpu: number | null;
}

/** What the game reports (sounds, HUD, camera, the phones). */
export type BaseballEvent =
  /** a batter steps in, with this many pitches to come */
  | { type: 'turn'; who: number; pitches: number }
  | { type: 'windup'; kind: PitchKind }
  /** the ball leaves the pitcher's hand */
  | { type: 'pitch'; pitch: Pitch }
  /** a swing: how early (−) or late (+), seconds, and whether it'll meet the ball */
  | { type: 'swing'; who: number; timing: number; contact: boolean; power: number }
  /** the crack of the bat */
  | { type: 'contact'; who: number; ball: BattedBall }
  /** into the catcher's mitt */
  | { type: 'catch'; strike: boolean }
  /** the batted ball came down (or went out) */
  | { type: 'land'; who: number; ball: BattedBall }
  /** how the pitch ended */
  | { type: 'result'; who: number; outcome: PitchOutcome; distance: number; homeRuns: number; pitchesLeft: number }
  | { type: 'over'; ranking: number[] };
