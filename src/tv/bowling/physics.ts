// Bowling physics.
//
// On the lane the ball is our own model — a rolling sphere with sliding
// friction on an oil pattern — so the skid → hook → roll shape of a throw is
// fully under control and cheap. Just before the pins it becomes a Rapier
// rigid body, and Rapier does the ball–pin and pin–pin collisions, the deck,
// gutters, kickbacks and pit.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { EventQueue, RigidBody, World } from '@dimforge/rapier3d-compat';
import { FOUL_Z, HEAD_Z, LANE, PIN_PROFILE, PIT_Z, pinSpots } from './lane';
import type { BallThrow, BodyPose, BowlPhysicsEvent, BowlView } from './types';

type Rapier = typeof RAPIER;

/** fixed sub-step, s */
const H = 1 / 240;
const G = 9.81;

// --- The lane (our ball model) ---
/** friction on the oiled heads: the ball skids */
const MU_OIL = 0.02;
/** friction on the dry back end: the ball grips and hooks */
const MU_DRY = 0.2;
/** the oil thins out over the last metres of the pattern, so the hook starts smoothly */
const OIL_FADE = 1.5;
/** forward roll at release, as a fraction of the rolling rate (the rest is skid) */
const ROLL0 = 0.5;
/** side-rotation surface speed at spin 1 and 7.5 m/s: this is what hooks the ball.
 *  It scales with √speed — a slower arm swing puts fewer revs on the ball. */
const SIDE = 2.7;
/** vertical-axis share of the spin — only the look (it doesn't bend the path) */
const TILT = 0.3;
/** rolling resistance, m/s² */
const ROLL_DECEL = 0.06;
/** the ball becomes a Rapier body this far before the head pin */
const HANDOVER = 0.6;
/** depth of the gutter channel below the lane surface */
const GUTTER_DEPTH = 0.048;

// --- Rapier materials: each pair gets exactly these values (the static parts
// combine with Min, and the ball has separate colliders for the lane and the pins) ---
const BALL_PIN_FRICTION = 0.1;
/** lively pins: the ball deflects off them, so only a ball with entry angle drives on through the 5 */
const BALL_PIN_RESTITUTION = 0.75;
const PIN_PIN_FRICTION = 0.35;
const PIN_PIN_RESTITUTION = 0.4;
/** pins and the ball on the deck (the ball matches the dry back end) */
const DECK_FRICTION = MU_DRY;
const DECK_RESTITUTION = 0.15;
/** kickbacks: hard side plates the pins bounce back off into the deck */
const KICK_FRICTION = 0.2;
const KICK_RESTITUTION = 0.45;
const KICK_H = 0.6;

/** pins' damping on the deck (settles spinning dead wood) and in the pit (the rubber mat) */
const PIN_LIN_DAMP = 0.05;
const PIN_ANG_DAMP = 0.4;
const PIT_DAMP = 3;
/** pin centre of mass above the base, m (a real pin's is 0.143–0.151) */
const PIN_COM = 0.145;

// collision groups: the ball's lane collider only meets the static lane, its pin collider only the pins
const G_STATIC = 1;
const G_PIN = 2;
const G_BALL_LANE = 4;
const G_BALL_PIN = 8;
const groups = (member: number, filter: number) => (member << 16) | filter;

// --- Settling and events ---
const REST_LIN = 0.05;
const REST_ANG = 0.3;
/** everything must stay at rest this long (a wobbling pin is briefly still at each end of its wobble) */
const REST_HOLD = 0.35;
const SETTLE_TIMEOUT = 4;
/** after a rack the solver keeps stepping this long, so the pins seat on the deck before the idle skip may apply */
const RACK_SEAT = 0.5;
/** impact speeds worth a sound: ball–pin, and pin–pin (quieter clacks are dropped) */
const HIT_MIN = 0.5;
const HIT_MIN_PINS = 0.8;
/** at most one hit event per pair of bodies in this long */
const HIT_GAP = 0.08;
/** a pin stands if its axis is within 20° of vertical */
const UPRIGHT = Math.cos((20 * Math.PI) / 180);

/** collider id for the pit floor and back cushion (0 = ball, 1..10 = pins) */
const PIT = 11;

const W2 = LANE.width / 2;
const GUTTER_X = W2 + LANE.gutter / 2;
const KICK_X = W2 + LANE.gutter;
const BACK_Z = PIT_Z - LANE.pitLength;

let rapierP: Promise<Rapier> | null = null;
function loadRapier(): Promise<Rapier> {
  rapierP ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    const R = ((m as { default?: Rapier }).default ?? m) as Rapier;
    await R.init();
    return R;
  });
  return rapierP;
}

/** Oil → dry friction by distance from the foul line (smoothstep over the pattern's tail). */
function laneMu(dist: number): number {
  const t = Math.min(1, Math.max(0, (dist - (LANE.oilLength - OIL_FADE)) / OIL_FADE));
  return MU_OIL + (MU_DRY - MU_OIL) * t * t * (3 - 2 * t);
}

/** the pin's neck: the profile is split here into two convex hulls (one hull would fill the neck in) */
const NECK_H = 0.258;
/** segments around each ring of the pin hull (32 or 64 made no difference to how the pins carry) */
const PIN_SEG = 16;

/**
 * One convex part of the pin collider: the profile between heights h0 and h1
 * spun into rings. The base is a square of the same area as the round base:
 * Rapier builds face contacts from at most 4 vertices, so a round base would
 * only be propped up on one side and the pin would topple by itself. Each pin
 * gets its own `yaw` for the square, so they don't all tip alike.
 */
function pinHullPoints(h0: number, h1: number, yaw: number, seg = PIN_SEG): Float32Array {
  const pts: number[] = [];
  for (const [r, h] of PIN_PROFILE) {
    if (h < h0 || h > h1) continue;
    if (r === 0) {
      if (h > 0) pts.push(0, h, 0);
      continue;
    }
    const base = h === 0;
    const n = base ? 4 : seg;
    const rr = base ? r * Math.sqrt(Math.PI / 2) : r;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (base ? yaw : 0);
      pts.push(rr * Math.cos(a), h, rr * Math.sin(a));
    }
  }
  return new Float32Array(pts);
}

/** Inertia of the pin as a solid of revolution of the real profile (maple, ~700 kg/m³). */
function pinInertia(): { axial: number; transverse: number } {
  let V = 0;
  let My = 0;
  let Iax = 0;
  let Ib = 0;
  for (let i = 0; i < PIN_PROFILE.length - 1; i++) {
    const [r0, h0] = PIN_PROFILE[i];
    const [r1, h1] = PIN_PROFILE[i + 1];
    if (h1 <= h0) continue;
    const n = 24;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const r = r0 + (r1 - r0) * t;
      const h = h0 + (h1 - h0) * t;
      const dV = (Math.PI * r * r * (h1 - h0)) / n;
      V += dV;
      My += dV * h;
      Iax += 0.5 * r * r * dV;
      Ib += (0.25 * r * r + h * h) * dV;
    }
  }
  const rho = LANE.pinMass / V;
  const com = My / V;
  return { axial: rho * Iax, transverse: rho * Ib - LANE.pinMass * com * com };
}

interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

type Phase = 'ready' | 'lane' | 'pins' | 'settled';

export class BowlPhysics {
  /** centre of the active lane: set it before rack(), which moves the lane there */
  laneX = 0;
  onEvent: (e: BowlPhysicsEvent) => void = () => {};
  phase: Phase = 'ready';
  readonly view: BowlView;

  private readonly R: Rapier;
  private readonly world: World;
  private readonly queue: EventQueue;
  private readonly ground: RigidBody;
  private groundX = 0;
  private readonly ballBody: RigidBody;
  private readonly pins: RigidBody[] = [];
  /** collider handle → 0 ball, 1..10 pins, PIT for the pit floor and cushion */
  private readonly who = new Map<number, number>();
  private readonly racked: boolean[] = new Array(10).fill(false);

  /** where the ball is simulated: in the bowler's hand, our lane model, the gutter channel, or Rapier */
  private mode: 'hand' | 'lane' | 'gutter' | 'rapier' = 'hand';
  private readonly b: BallState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private gutterSide = 1;

  private t = 0;
  private acc = 0;
  private tThrow = 0;
  private tPins = 0;
  /** when the pins were last racked (a pin put to sleep right after a teleport has no deck yet) */
  private tRack = -1e9;
  private restT = 0;
  private snapshot: boolean[] | null = null;
  /** per-body velocity before the current step, for impact speeds (0 = ball, 1..10 = pins) */
  private readonly pre = new Float64Array(33);
  private readonly lastHit = new Float64Array(121);
  private readonly inPit: boolean[] = new Array(11).fill(false);
  private readonly tv = { x: 0, y: 0, z: 0 };
  private readonly tq = { x: 0, y: 0, z: 0, w: 1 };
  /** one callback for every step (no closure per step) */
  private readonly onCollision = (h1: number, h2: number, started: boolean) => {
    if (started) this.contact(this.who.get(h1) ?? -1, this.who.get(h2) ?? -1);
  };

  /** Loads Rapier (once) and builds the lane. Works in the browser (Vite) and in Node (tsx). */
  static async load(): Promise<BowlPhysics> {
    return new BowlPhysics(await loadRapier());
  }

  private constructor(R: Rapier) {
    this.R = R;
    const world = new R.World({ x: 0, y: -G, z: 0 });
    world.timestep = H;
    this.world = world;
    this.queue = new R.EventQueue(true);

    // static lane: one fixed body so the whole thing can be moved to another lane
    this.ground = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(this.laneX, 0, 0));
    this.buildLane();

    const ballBody = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setCcdEnabled(true).setCanSleep(true).setEnabled(false),
    );
    // two copies of the sphere so ball–deck and ball–pin get their own friction and
    // restitution: friction 1 / restitution 0.3 take the static part's (Min) value;
    // on the pin side Min picks our friction and Max our restitution
    const ballLane = R.ColliderDesc.ball(LANE.ballR)
      .setMass(LANE.ballMass)
      .setFriction(1)
      .setRestitution(0.3)
      .setCollisionGroups(groups(G_BALL_LANE, G_STATIC));
    const ballPin = R.ColliderDesc.ball(LANE.ballR)
      .setDensity(0)
      .setFriction(BALL_PIN_FRICTION)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(BALL_PIN_RESTITUTION)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Max)
      .setCollisionGroups(groups(G_BALL_PIN, G_PIN));
    for (const desc of [ballLane, ballPin]) {
      desc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
      this.who.set(world.createCollider(desc, ballBody).handle, 0);
    }
    this.ballBody = ballBody;

    const inertia = pinInertia();
    for (let i = 0; i < 10; i++) {
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setCcdEnabled(true)
          .setCanSleep(true)
          .setLinearDamping(PIN_LIN_DAMP)
          .setAngularDamping(PIN_ANG_DAMP)
          .setEnabled(false),
      );
      // body (base to neck) and head (neck to crown); base squares turned by a
      // golden-ish angle per pin: varied but repeatable
      const lower = R.ColliderDesc.convexHull(pinHullPoints(0, NECK_H, i * 2.4));
      const upper = R.ColliderDesc.convexHull(pinHullPoints(NECK_H, LANE.pinH, 0));
      if (!lower || !upper) throw new Error('BowlPhysics: pin hull failed');
      lower.setMassProperties(
        LANE.pinMass,
        { x: 0, y: PIN_COM, z: 0 },
        { x: inertia.transverse, y: inertia.axial, z: inertia.transverse },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      upper.setDensity(0);
      for (const desc of [lower, upper]) {
        desc
          .setFriction(PIN_PIN_FRICTION)
          .setRestitution(PIN_PIN_RESTITUTION)
          .setCollisionGroups(groups(G_PIN, G_STATIC | G_PIN | G_BALL_PIN))
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
        this.who.set(world.createCollider(desc, body).handle, i + 1);
      }
      this.pins.push(body);
    }

    const pose = (): BodyPose => ({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
    this.view = {
      ball: { ...pose(), visible: false, gutter: false },
      pins: Array.from({ length: 10 }, () => ({ ...pose(), visible: false })),
    };
    this.rack();
  }

  /** Deck, gutters, kickbacks, pit and cushion — relative to the lane centre. */
  private buildLane() {
    const R = this.R;
    const w = this.world;
    const g = this.ground;
    const bottom = -LANE.pitDepth - 0.1;
    const z0 = FOUL_Z + 0.5;
    const len = z0 - PIT_Z;
    const MIN = R.CoefficientCombineRule.Min;
    // static parts win the pairing with Min, so each surface sets its own values
    const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number, friction: number, restitution: number) =>
      w.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setFriction(friction)
          .setRestitution(restitution)
          .setFrictionCombineRule(MIN)
          .setRestitutionCombineRule(MIN)
          .setCollisionGroups(groups(G_STATIC, G_PIN | G_BALL_LANE)),
        g,
      );

    // the lane and pin deck: top at y = 0, its end face is the front wall of the pit
    box(W2, -bottom / 2, len / 2, 0, bottom / 2, z0 - len / 2, DECK_FRICTION, DECK_RESTITUTION);
    // gutters: a flat channel bottom GUTTER_DEPTH below the lane
    const gTop = -GUTTER_DEPTH;
    for (const s of [-1, 1]) {
      box(LANE.gutter / 2, (gTop - bottom) / 2, len / 2, s * GUTTER_X, (gTop + bottom) / 2, z0 - len / 2, 0.2, 0.1);
    }
    // kickbacks: side plates from a little before the pins to the back of the pit
    const kz0 = HEAD_Z + 2.5;
    const kz1 = BACK_Z - 0.1;
    for (const s of [-1, 1]) {
      box(0.05, (KICK_H - bottom) / 2, (kz0 - kz1) / 2, s * (KICK_X + 0.05), (KICK_H + bottom) / 2, (kz0 + kz1) / 2, KICK_FRICTION, KICK_RESTITUTION);
    }
    // pit floor (a padded mat) and the back cushion (a heavy curtain): both soak up energy
    const pitFloor = box(KICK_X, 0.05, LANE.pitLength / 2 + 0.05, 0, -LANE.pitDepth - 0.05, PIT_Z - LANE.pitLength / 2 - 0.05, 0.5, 0.1);
    const cushion = box(KICK_X, (1 - bottom) / 2, 0.05, 0, (1 + bottom) / 2, BACK_Z - 0.05, 0.5, 0.05);
    this.who.set(pitFloor.handle, PIT);
    this.who.set(cushion.handle, PIT);
    // the masking unit above the deck keeps flying pins in the lane
    box(KICK_X, 0.05, (HEAD_Z + 1 - BACK_Z) / 2, 0, 0.95, (HEAD_Z + 1 + BACK_Z) / 2, 0.3, 0.1);
  }

  /** Rack the pins (standing[i] = pin i+1 on its spot; omit for a full rack) and take the ball back. */
  rack(standing?: boolean[]): void {
    if (this.laneX !== this.groundX) {
      this.ground.setTranslation({ x: this.laneX, y: 0, z: 0 }, false);
      this.groundX = this.laneX;
    }
    const spots = pinSpots(this.laneX);
    for (let i = 0; i < 10; i++) {
      const on = standing ? !!standing[i] : true;
      const body = this.pins[i];
      this.racked[i] = on;
      body.setEnabled(on);
      if (on) {
        // left awake: a pin put to sleep straight after a teleport gets no deck
        // contact when it wakes and sinks; racked pins fall asleep by themselves in ~0.5 s
        body.setTranslation({ x: spots[i].x, y: 0, z: spots[i].z }, true);
        body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        body.setLinearDamping(PIN_LIN_DAMP);
        body.setAngularDamping(PIN_ANG_DAMP);
      }
    }
    this.ballBody.setEnabled(false);
    this.ballBody.setLinearDamping(0);
    this.ballBody.setAngularDamping(0);
    this.tRack = this.t;
    this.mode = 'hand';
    this.phase = 'ready';
    this.restT = 0;
    this.snapshot = null;
    this.acc = 0;
    this.lastHit.fill(-1e9);
    this.inPit.fill(false);
    this.queue.clear();
    this.view.ball.visible = false;
    this.view.ball.gutter = false;
    this.updateView();
  }

  /** Release the ball at the foul line. */
  throw(t: BallThrow): void {
    const R = LANE.ballR;
    const speed = clamp(t.speed, 2, 14);
    const angle = clamp(t.angle, -0.35, 0.35);
    const spin = clamp(t.spin, -1, 1);
    // (also works as a re-throw without a rack: the ball starts over, the pins stay)
    this.ballBody.setEnabled(false);
    this.ballBody.setLinearDamping(0);
    this.ballBody.setAngularDamping(0);
    this.inPit[0] = false;
    const b = this.b;
    b.x = clamp(t.x, this.laneX - KICK_X + R, this.laneX + KICK_X - R);
    b.y = R;
    b.z = FOUL_Z - 0.05;
    const sa = Math.sin(angle);
    const ca = Math.cos(angle);
    b.vx = speed * sa;
    b.vy = 0;
    b.vz = -speed * ca;
    // some forward roll about the axis across the throw, plus side rotation about
    // the throw direction (the tilted axis of a hook ball)
    const ws = (spin * SIDE * clamp(Math.sqrt(speed / 7.5), 0.7, 1.2)) / R;
    b.wx = (ROLL0 * b.vz) / R - ws * sa;
    b.wz = (-ROLL0 * b.vx) / R + ws * ca;
    b.wy = TILT * ws;
    b.qx = b.qy = b.qz = 0;
    b.qw = 1;
    this.mode = 'lane';
    this.phase = 'lane';
    this.tThrow = this.t;
    this.restT = 0;
    this.snapshot = null;
    this.view.ball.visible = true;
    this.view.ball.gutter = false;
    this.onEvent({ type: 'roll', speed });
    if (Math.abs(b.x - this.laneX) > W2) this.enterGutter();
    this.updateView();
  }

  /** Advance by dt seconds of real time (clamped to 0.1), in fixed 1/240 s sub-steps. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    this.acc += Math.min(dt, 0.1);
    // round to the nearest whole sub-step so a steady 60 fps is always exactly 4 of them
    while (this.acc >= H * 0.5) {
      this.acc -= H;
      this.sub();
    }
    this.updateView();
  }

  /** Which pins stand (upright, base on the deck). After 'settled' this is the count at the moment it settled. */
  standing(): boolean[] {
    if (this.phase === 'settled' && this.snapshot) return this.snapshot.slice();
    return this.countStanding();
  }

  dispose(): void {
    this.queue.free();
    this.world.free();
  }

  // --- simulation ---

  private sub() {
    this.t += H;
    if (this.mode === 'lane') this.laneStep();
    else if (this.mode === 'gutter') this.gutterStep();
    // stepped unless nothing in the world can move: fresh racks settle onto the deck first
    if (!this.worldIdle()) this.worldStep();
    if (this.phase === 'lane') {
      const bz = this.mode === 'rapier' ? this.ballBody.translation(this.tv).z : this.b.z;
      // the ball's front reaches the head pin (or a gutter ball reaches the pit)
      if ((this.mode === 'rapier' && bz < HEAD_Z + LANE.ballR + LANE.pinMaxR) || this.t - this.tThrow > 25) this.enterPins();
    } else if (this.phase === 'pins') {
      this.restT = this.allAtRest() ? this.restT + H : 0;
      if (this.restT >= REST_HOLD || this.t - this.tPins >= SETTLE_TIMEOUT) this.settle();
    }
  }

  /** Our rolling-sphere model: sliding friction at the contact point until the ball rolls. */
  private laneStep() {
    const b = this.b;
    const R = LANE.ballR;
    // slip of the contact point: u = v + ω × (0, −R, 0)
    const ux = b.vx + b.wz * R;
    const uz = b.vz - b.wx * R;
    const u = Math.hypot(ux, uz);
    // friction impulse per unit mass; slip changes 3.5× faster than v (1 + mR²/I),
    // so u/3.5 is exactly what stops the slip — if friction can supply it, the ball grips
    const cap = laneMu(FOUL_Z - b.z) * G * H;
    const rolling = u / 3.5 <= cap;
    if (u > 1e-9) {
      const k = rolling ? 1 / 3.5 : cap / u;
      const dvx = -k * ux;
      const dvz = -k * uz;
      b.vx += dvx;
      b.vz += dvz;
      // dω = r × F / I, r = (0, −R, 0), I = 0.4 m R²
      b.wx -= dvz / (0.4 * R);
      b.wz += dvx / (0.4 * R);
    }
    if (rolling) {
      const v = Math.hypot(b.vx, b.vz);
      if (v > 1) {
        const s = 1 - (ROLL_DECEL * H) / v;
        b.vx *= s;
        b.vz *= s;
        b.wx *= s;
        b.wz *= s;
      }
    }
    b.wy *= 1 - 0.3 * H;
    b.x += b.vx * H;
    b.z += b.vz * H;
    spin(b, H);
    if (Math.abs(b.x - this.laneX) > W2) this.enterGutter();
    else if (b.z < HEAD_Z + HANDOVER) this.toRapier();
  }

  private enterGutter() {
    const b = this.b;
    this.mode = 'gutter';
    this.gutterSide = b.x >= this.laneX ? 1 : -1;
    this.view.ball.gutter = true;
    this.onEvent({ type: 'gutter', x: b.x, z: b.z });
  }

  /** In the gutter: drop into the channel, settle to its middle and roll straight on to the pit. */
  private gutterStep() {
    const b = this.b;
    const R = LANE.ballR;
    const tx = this.laneX + this.gutterSide * GUTTER_X;
    const nx = b.x + (tx - b.x) * (1 - Math.exp(-10 * H));
    b.vx = (nx - b.x) / H;
    b.x = nx;
    const rest = R - GUTTER_DEPTH;
    if (b.y > rest) {
      b.vy -= G * H;
      b.y = Math.max(rest, b.y + b.vy * H);
      if (b.y === rest) b.vy = 0;
    }
    b.vz = -Math.max(1, -b.vz - 0.15 * H);
    // whatever spin it had gives way to a plain forward roll along the channel
    const k = 1 - Math.exp(-4 * H);
    b.wx += (b.vz / R - b.wx) * k;
    b.wy -= b.wy * k;
    b.wz += (-b.vx / R - b.wz) * k;
    b.z += b.vz * H;
    spin(b, H);
    if (b.z < PIT_Z) {
      this.toRapier();
      this.enterPins();
    }
  }

  private toRapier() {
    const b = this.b;
    const body = this.ballBody;
    body.setEnabled(true);
    body.setTranslation({ x: b.x, y: b.y, z: b.z }, true);
    body.setRotation({ x: b.qx, y: b.qy, z: b.qz, w: b.qw }, true);
    body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
    body.setAngvel({ x: b.wx, y: b.wy, z: b.wz }, true);
    this.mode = 'rapier';
  }

  private enterPins() {
    if (this.phase !== 'lane') return;
    this.phase = 'pins';
    this.tPins = this.t;
    this.restT = 0;
  }

  private settle() {
    this.snapshot = this.countStanding();
    this.phase = 'settled';
    this.onEvent({ type: 'settled' });
  }

  /**
   * True when a solver step would change nothing: the ball is not a Rapier body (it is in
   * the hand or on our lane model), every pin in play is asleep, and the last rack is old
   * enough for the pins to have seated. A step with no awake body moves nothing and raises no
   * events. (Rapier keeps some hidden state that counts solver steps, so a throw after skipped
   * steps can scatter the pins differently in the last digits: the same physics, another draw.)
   */
  private worldIdle(): boolean {
    if (this.ballBody.isEnabled() || this.t - this.tRack < RACK_SEAT) return false;
    for (let i = 0; i < 10; i++) {
      const body = this.pins[i];
      if (body.isEnabled() && !body.isSleeping()) return false;
    }
    return true;
  }

  private worldStep() {
    const pre = this.pre;
    const v = this.tv;
    for (let i = 0; i < 11; i++) {
      const body = i === 0 ? this.ballBody : this.pins[i - 1];
      if (!body.isEnabled()) continue;
      body.linvel(v);
      pre[i * 3] = v.x;
      pre[i * 3 + 1] = v.y;
      pre[i * 3 + 2] = v.z;
    }
    this.world.step(this.queue);
    this.queue.drainCollisionEvents(this.onCollision);
    // anything that fell out of the lane altogether is taken out of play
    for (let i = 0; i < 11; i++) {
      const body = i === 0 ? this.ballBody : this.pins[i - 1];
      if (body.isEnabled() && body.translation(v).y < -2) body.setEnabled(false);
    }
  }

  private contact(a: number, c: number) {
    if (a < 0 || c < 0) return;
    if (a === PIT || c === PIT) {
      const i = a === PIT ? c : a;
      if (i === PIT || this.inPit[i]) return;
      this.inPit[i] = true;
      const body = i === 0 ? this.ballBody : this.pins[i - 1];
      body.setLinearDamping(PIT_DAMP);
      body.setAngularDamping(PIT_DAMP);
      const p = this.pre;
      this.onEvent({ type: 'pit', impact: Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) });
      return;
    }
    const lo = Math.min(a, c);
    const hi = Math.max(a, c);
    const p = this.pre;
    const impact = Math.hypot(p[lo * 3] - p[hi * 3], p[lo * 3 + 1] - p[hi * 3 + 1], p[lo * 3 + 2] - p[hi * 3 + 2]);
    if (lo === 0 && this.phase === 'lane') this.enterPins();
    if (impact < (lo === 0 ? HIT_MIN : HIT_MIN_PINS)) return;
    const k = lo * 11 + hi;
    if (this.t - this.lastHit[k] < HIT_GAP) return;
    this.lastHit[k] = this.t;
    const pa = (lo === 0 ? this.ballBody : this.pins[lo - 1]).translation(this.tv);
    const ax = pa.x;
    const az = pa.z;
    const pb = this.pins[hi - 1].translation(this.tv);
    this.onEvent({ type: 'hit', impact, x: (ax + pb.x) / 2, z: (az + pb.z) / 2, ballOnPin: lo === 0 });
  }

  private allAtRest(): boolean {
    const v = this.tv;
    for (let i = 0; i < 11; i++) {
      const body = i === 0 ? this.ballBody : this.pins[i - 1];
      if (!body.isEnabled() || body.isSleeping()) continue;
      body.linvel(v);
      if (v.x * v.x + v.y * v.y + v.z * v.z > REST_LIN * REST_LIN) return false;
      body.angvel(v);
      if (v.x * v.x + v.y * v.y + v.z * v.z > REST_ANG * REST_ANG) return false;
    }
    return true;
  }

  private countStanding(): boolean[] {
    const out: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const body = this.pins[i];
      if (!this.racked[i] || !body.isEnabled()) {
        out.push(false);
        continue;
      }
      const p = body.translation(this.tv);
      const x = p.x;
      const y = p.y;
      const z = p.z;
      const q = body.rotation(this.tq);
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      out.push(upY >= UPRIGHT && Math.abs(y) < 0.03 && Math.abs(x - this.laneX) < W2 && z > PIT_Z);
    }
    return out;
  }

  private updateView() {
    const vb = this.view.ball;
    if (this.mode === 'rapier') {
      if (this.ballBody.isEnabled()) setPose(vb, this.ballBody.translation(this.tv), this.ballBody.rotation(this.tq));
      else vb.visible = false;
    } else if (this.mode !== 'hand') {
      const b = this.b;
      vb.x = b.x;
      vb.y = b.y;
      vb.z = b.z;
      vb.qx = b.qx;
      vb.qy = b.qy;
      vb.qz = b.qz;
      vb.qw = b.qw;
    }
    for (let i = 0; i < 10; i++) {
      const vp = this.view.pins[i];
      const body = this.pins[i];
      vp.visible = this.racked[i] && body.isEnabled();
      if (vp.visible) setPose(vp, body.translation(this.tv), body.rotation(this.tq));
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2;
}

function setPose(out: BodyPose, p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }) {
  out.x = p.x;
  out.y = p.y;
  out.z = p.z;
  out.qx = q.x;
  out.qy = q.y;
  out.qz = q.z;
  out.qw = q.w;
}

/** Turn the ball's orientation by its world angular velocity over h (exact for constant ω). */
function spin(b: BallState, h: number) {
  const w = Math.hypot(b.wx, b.wy, b.wz);
  if (w < 1e-9) return;
  const half = w * h * 0.5;
  const s = Math.sin(half) / w;
  const dx = b.wx * s;
  const dy = b.wy * s;
  const dz = b.wz * s;
  const dw = Math.cos(half);
  const { qx, qy, qz, qw } = b;
  let x = dw * qx + qw * dx + (dy * qz - dz * qy);
  let y = dw * qy + qw * dy + (dz * qx - dx * qz);
  let z = dw * qz + qw * dz + (dx * qy - dy * qx);
  let ww = dw * qw - (dx * qx + dy * qy + dz * qz);
  const n = 1 / Math.hypot(x, y, z, ww);
  x *= n;
  y *= n;
  z *= n;
  ww *= n;
  b.qx = x;
  b.qy = y;
  b.qz = z;
  b.qw = ww;
}
