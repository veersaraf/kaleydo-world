# Making a game mode

A *game mode* here means a variant of a sport that already exists: tennis with different rules or
pacing, bowling with a different format. (A whole new sport is a bigger job: see
[architecture.md](architecture.md) for how the five sports are put together.)

This guide uses **Rush**, a real mode in the game, as the worked example, then sketches a second,
smaller one step by step. Read the files it points to as you go: the code is commented heavily, and
the comments are the real documentation.

- [How a mode is put together](#how-a-mode-is-put-together)
- [The worked example: Rush](#the-worked-example-rush)
- [Step by step: a new tennis mode](#step-by-step-a-new-tennis-mode)
- [Online play](#online-play)
- [If the mode needs new phone UI](#if-the-mode-needs-new-phone-ui)
- [Bowling modes](#bowling-modes)
- [Testing a mode](#testing-a-mode)
- [Checklist](#checklist)

## How a mode is put together

Four layers, and a mode usually touches the first three:

| Layer | Tennis | Bowling | What lives there |
|---|---|---|---|
| **Rules** | `src/tv/tennis/match.ts` (`Match`, `MatchConfig`), `score.ts`, `shot.ts` | `src/tv/bowling/game.ts` (`BowlingGame`), `score.ts` | Pure simulation: no three.js, no DOM. Runs headless in the sims. |
| **Menu** | `Flow.setupScreen()` and `Flow.buildConfig()` in `src/tv/flow.ts` | `Flow.bowlSetup()` and `Flow.beginBowling()` | The setup screen's rows and toggles, saved settings, building the config. |
| **Look** | `src/tv/worlds/base.ts` (`World.onEvent`, `FrameView`), `src/tv/ui/hud.ts` | `src/tv/bowling/venue.ts`, `src/tv/ui/bowlhud.ts` | What the mode looks and sounds like. |
| **Phone** | `src/shared/protocol.ts` (`PadMode`, `PadMsg`), `src/pad/main.ts`, `Flow.syncPads()` | same | Only if the mode needs a new panel or a new kind of input. |

The golden rule: **a mode must not change the game when it's off.** The rules engine is
deterministic for a seed, and the sims print a hash of every match's event stream; with your mode
switched off, those hashes must come out the same as before your change.

## The worked example: Rush

Rush makes tennis faster: every hit in a rally builds *heat* (a perfect hit more), heat speeds up the
ball and the players, and at full heat the ball catches fire. Here is everything that makes it work.

**1. The mode's own module: `src/tv/tennis/rush.ts`.** Constants (`RUSH.base` 1.15× pace for the
first rally shot, `RUSH.max` 1.45× at full heat, heat per hit, how much flatter and heavier a fast
shot flies) and three pure functions: `heatAfter(heat, hit)`, `paceAt(heat)` and `onFire(heat)`.
Keeping the numbers and the maths in one small file means the rules, the visuals and the tests all
share them.

**2. The config flag: `MatchConfig.rush` in `src/tv/tennis/match.ts`.** One optional field:

```ts
export interface MatchConfig {
  // ...
  /** Rush: rallies start faster and every hit builds heat (ball and players speed up) */
  rush?: boolean;
}
```

Optional and `undefined` by default, so every existing caller (the menus, the attract mode, the sims,
the online guest) keeps playing the standard game.

**3. The hooks in the rules.** Rush touches `Match` in four places, each guarded by `this.cfg.rush`:

- `Match.heat`: the rally's heat, a public field (0 when Rush is off).
- `setupPoint()`: a new point resets the heat (`this.setHeat(0)`).
- `resolveHit()`: a rally drive or volley goes out at the rally's pace (`rushShot(spec)` scales the
  shot's speed, lowers its net clearance and raises its gravity through `ShotSpec.gMul` in
  `shot.ts`, so a faster ball still clears the net and lands in); then the hit adds heat
  (`setHeat(heatAfter(...))`).
- `setHeat()`: everyone's running speed follows the ball's pace (`TPlayer.runMul` in `player.ts`), so
  a faster ball stays reachable.

**4. The look: from the events, not the state.** `src/tv/app.ts` sets `view.rush = !!m.cfg.rush` on
the `FrameView` every frame, and `World` in `src/tv/worlds/base.ts` works the heat out *itself* from
the `hit` events it already receives (`rushEvent()` calls the same `heatAfter`). The trail widens with
the heat, and at full heat the ball wears flames and a fiery ring, in each world's own smash colours.
Because the heat comes from events, a guest TV watching an online match draws exactly the same fire
without anything new in the match stream.

**5. The menu: `src/tv/flow.ts`.**

- `Settings.rush` (and `rush: false` in `DEFAULTS`): saved in `localStorage` with the other settings.
  (`Settings.rev` lets a release change a default for people who already have saved settings; see
  `Flow` where settings are loaded.)
- `paceTile()`: the *Pace* tile on the tennis setup screen, **Normal | Rush** side by side. Its
  `item` (with `onLeft`, `onRight`, `onSelect`) goes into the screen's `Nav` list in
  `setupScreen()`, and its element into the sheet next to the Kaleydo tile. A plain on/off mode can use
  `featureTile()` instead; a mode with several values can use the `row()` helper the other rows use
  (◀ value ▶).
- `buildConfig()`: `...(S.rush ? { rush: true } : {})` puts the flag on the match's config only when
  it's on.

**6. Online: one field.** `NetStart.rush` in `src/shared/net.ts`, set by the host
(`src/tv/net/host.ts`, where it builds the `start` message) and passed into the guest's shadow match
(`shadowMatch()` in `src/tv/net/guest.ts`). See [Online play](#online-play) for why.

**7. Tests.** `scripts/check/sim-rush.ts` plays the same seeds with Rush off and on, CPU vs CPU and a
simulated human vs each CPU level, and prints how rallies change (length, how points end, ball speed
by heat, how often the ball catches fire, how often the human reaches it). `net-codec-test.ts`
checks that a standard match's `start` carries no `rush` and a Rush match's guest has it, and
`online-e2e.mjs` takes `RUSH=1` to check it through real browsers.

That's the whole mode: ~50 lines of rules, a tile, a flag in three places, and tests.

## Step by step: a new tennis mode

As a smaller example, here is how you'd add **Golden point** (no-advantage scoring: at deuce, the next
point wins the game). This isn't in the game; it's a sketch of the steps, with code that matches the
current signatures.

### 1. Put the rule where it belongs

Scoring lives in `src/tv/tennis/score.ts`. Give `Score` an option and use it in the two places that
decide a game:

```ts
export class Score {
  constructor(
    public gamesToWin: number,
    firstServer: 0 | 1,
    public names: [string, string],
    /** Golden point: at deuce the next point wins the game */
    public noAd = false,
  ) { /* ... */ }

  gamePointFor(team: 0 | 1) {
    const me = this.points[team];
    const them = this.points[1 - team];
    return me >= 3 && (me - them >= 1 || (this.noAd && me === them));
  }

  pointTo(team: 0 | 1): PointOutcome {
    // ...
    if (me >= 4 && (me - them >= 2 || this.noAd)) {
      // game won, as before
    }
  }
}
```

(and have `call()` say "Deciding point" instead of "Deuce" when `noAd` is on).

### 2. Add the flag to `MatchConfig`

```ts
// src/tv/tennis/match.ts
export interface MatchConfig {
  // ...
  /** Golden point: no-advantage scoring */
  noAd?: boolean;
}
```

and pass it where `Match` makes its `Score` (there are two `new Score(...)` calls: the match's own,
and the attract mode's restart):

```ts
this.score = new Score(cfg.gamesToWin, cfg.firstServer ?? 0, names, !!cfg.noAd);
```

If your rule lives in `Match` itself (like Rush's), read `this.cfg.yourFlag` where the rule applies and
keep the `false` path exactly as it was.

### 3. Put it on the setup screen

In `src/tv/flow.ts`:

1. Add `noAd: boolean` to `Settings` and `noAd: false` to `DEFAULTS`.
2. In `setupScreen()`, make the control. For on/off, a feature tile:
   ```ts
   const golden = this.featureTile('kal', icon, 'Golden point', 'At deuce, the next point wins', () => S.noAd, (on) => (S.noAd = on), () => refresh());
   ```
   (the first argument is the tile's CSS class, `'kal'` or `'rush'` today: widen that union and add
   a class in `src/tv/ui/ui.css` for colours of your own). Add `golden.item` to the `Nav` list and `golden.r` to the sheet. The `Nav`
   list's order is the order ▲ ▼ moves through, so check the `nav.focus(...)` index still lands on
   the **Play** row.
3. In `buildConfig()`, add `...(S.noAd ? { noAd: true } : {})`.

Phones drive the menu with their D-pad, so a new row works on the phone with no phone changes.

### 4. Make it visible

If the mode changes what players see, prefer working it out in the world or the HUD from the match
events (`MatchEvent` in `match.ts`), as Rush does, over reading `Match` state. Events are what
replays and online guests see too. A `point` event carries the umpire's call from `Score.call()`, and
the flow shows it on the HUD and has the announcer say it, so a new call text shows up by itself.

### 5. Online (see below), then 6. test it (see [Testing a mode](#testing-a-mode)).

## Online play

Online, the **host TV runs the only simulation** and streams it to guest TVs (`src/tv/net/host.ts`
→ `src/shared/net.ts` → `src/tv/net/guest.ts`). The stream covers tennis. Two kinds of message:

- a JSON **`start`** (`NetStart`): everything a guest needs to build the same match, once;
- binary **snapshots** (~30 a second, and at every event): the score, the state, the ball's flight,
  every player's pose and the events since the last one.

A guest builds a *shadow* `Match` from `start` that nobody steps; each frame the stream writes into it
what the camera, HUD and worlds read. So for a new tennis mode, ask:

1. **Does the guest's shadow match need the flag?** If anything on the guest reads it (the world's
   visuals, the HUD, a `Score` method like `call()` or `gamePointFor()`), yes. Add an optional field
   to `NetStart` in `src/shared/net.ts`, set it in the host's start message in `src/tv/net/host.ts`
   only when it's on (`...(cfg.noAd ? { noAd: true } : {})`, as `rush` does, so a standard match's
   message is unchanged), and pass it into `new Match({...})` in `shadowMatch()` in
   `src/tv/net/guest.ts`. Golden point needs this: a guest rebuilds the umpire's call with a scratch
   `Score` of its own (`GuestStream`'s constructor makes it from `start`), so that `new Score(...)`
   needs the flag too. Rush needs it because the guest's world draws the heat.
2. **Does the mode add state the guest can't work out from the events?** Rush's heat can be worked
   out from `hit` events, so it isn't streamed. If yours can't (a timer, a moving target), it has to go
   in the snapshot: extend `Snap`, `encodeSnap` and `decodeSnap` in `net.ts`, update the byte layout
   in the comment at the top of the file, and bump `NET_VERSION`. Keep it small: snapshots go out at
   ~30 Hz to every guest.
3. **Test it:** `scripts/check/net-codec-test.ts` streams whole matches from a real `NetHost` into a
   real `GuestStream` over a jittery virtual network and checks every event arrives in order, the
   score ends the same and the ball is where the host's was. Add your flag to its `streamMatch()`
   options and a check like the Rush ones. `online-e2e.mjs` does the same through real browsers.

Phones need nothing for online play: a guest's phones join the host's room directly, as ordinary
remotes.

## If the mode needs new phone UI

Most modes don't: the phone's panels (`menu`, `play`, `serve`, `bowl`, `sword`, `bow`, `bat`, `wait`,
`watch`, `skip`, `demo`) already cover the sports' inputs, and the TV sets each panel's title and hint
text. If yours needs a new panel or a new kind of input:

1. **The protocol, `src/shared/protocol.ts`.** Add the panel to `PadMode`. If the phone has to send
   something new, add a message to `PadMsg` (and if its timing matters, give it `lat` and `ts`
   fields like the others and add its type to `TIMED` in `src/pad/link.ts`, so the TV can correct
   for its age).
2. **The phone, `src/pad/main.ts`.** Build the panel (the existing ones are a few `h(...)` calls each),
   add it to the `panels` record and to `shell`, and handle it in `setMode()`. Its styles go in
   `src/pad/pad.css`. Motion detection lives in its own modules (`swing.ts`, `bowl.ts`, `sword.ts`,
   fed by `pipeline.ts`); a new gesture gets a new detector there.
3. **The TV, `src/tv/core/input.ts`.** Each `PadMsg` type is handled in one `switch` and turned into a
   callback (`onSwing`, `onBowl`, `onSlash`…) tagged with the player's slot. Add yours, and wire it in
   `src/tv/app.ts` where the others are.
4. **Which panel a phone shows: `Flow.syncPads()` in `src/tv/flow.ts`.** It decides, for every seat,
   which `PadMode` (with a title and hint) the phone should be in right now, and sends it only when it
   changed. Add a branch for your mode's state.

Old phones may still be connected when a new TV ships, so treat new fields as optional on both ends.

## Bowling modes

Bowling follows the same shape with different names:

| Tennis | Bowling |
|---|---|
| `MatchConfig` | the arguments to `new BowlingGame(bowlers, phys)` in `App.startBowling()` (`src/tv/app.ts`) |
| `Match.resolveHit()`, `setupPoint()` | `BowlingGame.settled()` (pins counted, the mark decided), `nextBall()` (next ball, bowler, frame), `beginTurn()` |
| `Score` | `BowlScore` in `src/tv/bowling/score.ts` (ten frames, strikes, spares, the 10th frame's bonus balls) |
| `Flow.setupScreen()`, `buildConfig()` | `Flow.bowlSetup()` (Opponent and World rows, the Kaleydo tile), `Flow.beginBowling(world, cpu)` |
| `World.onEvent()` | `BowlEvent`s (`turn`, `release`, `result` with its `mark`, `over`), handled by the app, `BowlHud` and the venue |

To add a bowling mode:

1. Give `BowlingGame` an options argument (a third constructor parameter, defaulting to today's
   game), and read it where the rule applies: in `settled()` for how a ball counts, in `nextBall()`
   for how the game moves on, in `BowlScore` for how it's scored.
2. Pass it through `App.startBowling(specs, world, ...)` and `Flow.beginBowling()`.
3. Add a row to `bowlSetup()` with the `row()` helper (◀ value ▶) and put it in the `Nav` list.
4. If the remote's turn logic changes, the bowling branch of `Flow.syncPads()` is where a phone is
   told it's its turn (`bowl`), that its ball is rolling (`bowl` with `lock`), or to wait.

Bowling isn't streamed to guest TVs, so there's no online step. Pin physics is Rapier
(`src/tv/bowling/physics.ts`); the referee never touches it except to rack and read the pins.

## Testing a mode

Run these before opening a PR:

```bash
npm test              # typecheck + fast headless checks
npm run test:sims     # headless matches for every sport
npm run test:e2e      # simulated phones on the real TV page (needs Google Chrome)
```

And add tests for the mode itself:

- **A headless check** in `scripts/check/` (run with `npx tsx`): construct a `Match` (or a `Score`, or
  a `BowlingGame`) with your config and assert the rule. These scripts are plain TypeScript that print
  `✓`/`✗` lines and exit non-zero on a failure; `bowl-score-test.ts` and `score-test.ts` are short
  examples. Add it to `npm test` if it's fast.
- **A sim**, if the mode changes how matches play (pace, difficulty): copy the shape of
  `sim-rush.ts`, which plays the same seeds with the mode off and on and prints what changed. Look for
  rallies that never end, points nobody can win, or a human who can't reach the ball.
- **The off path:** run `sim.ts` (and `sim-human.ts`) before and after your change with your mode off;
  the event hashes they print must match.
- **End to end**, if there's UI: the e2e scripts in `scripts/e2e/` open the TV page and a remote page
  in headless Chrome, with a simulated phone (`scripts/lib/fake-phone.mjs`) that produces physically
  consistent motion events. The TV page exposes `window.flow` and `window.kaleido` (the `App`), so a
  test can switch a setting (`flow.settings.rush = true`, as `online-e2e.mjs` does with `RUSH=1`) and
  read the match (`kaleido.match.cfg`).
- **Online**, for a tennis mode: the `net-codec-test.ts` checks described above.

## Checklist

- [ ] The rule lives in the rules layer (`match.ts`, `score.ts`, `game.ts`), behind an optional config
      field that defaults to off.
- [ ] With the mode off, the sims' event hashes are unchanged.
- [ ] The setup screen has a control for it, it's saved in `Settings`, and `buildConfig()` /
      `beginBowling()` passes it on.
- [ ] Visuals come from match events where possible.
- [ ] Tennis: `NetStart` carries the flag if the guest's shadow match needs it; anything the guest
      can't derive is in the snapshot, with `NET_VERSION` bumped.
- [ ] New phone input or panels: `PadMode` / `PadMsg`, the panel in `src/pad/main.ts`, the handler in
      `core/input.ts`, the branch in `Flow.syncPads()`.
- [ ] A headless check, a sim if it changes how matches play, and `npm test` / `test:sims` /
      `test:e2e` pass.
- [ ] The README's controls or sports list mention it, if players need to know.
