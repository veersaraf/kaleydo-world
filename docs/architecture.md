# Architecture

Kaleydo World is three programs and a relay between them:

```
  phone (src/pad)  ──►  relay  ──►  TV page (src/tv)  ──►  relay  ──►  guest TVs (online)
   motion → small        local: server/server.mjs           the whole game:
   messages; shows       online: cloud/worker.ts            rules, physics, CPU,
   the panel the TV      (a Durable Object per room)        rendering, audio
   asks for
```

- The **TV page** is the game. It runs every rule, physics step and CPU player and draws everything.
- A **phone** is a remote. It turns its motion sensors into a few small messages (a swing with its
  power and spin, a bowling release, a sword slash, a bow draw) and shows whichever panel the TV
  asks for.
- The **relay** only routes and stamps. Locally it's a Node server on your computer; online it's a
  Cloudflare Worker with a Durable Object per room. Both speak the same protocol
  (`src/shared/protocol.ts`), so the TV and the phones don't care which one they're on (the TV asks
  `/api/info` at startup: the cloud answers `{ cloud: true }`).

Everything here is TypeScript, built by Vite into three pages: `index.html` (the TV), `controller.html`
(the remote) and `capture.html` (a motion recorder for tuning detectors).

## The TV page (`src/tv`)

`main.ts` makes two objects and starts the loop:

- **`App`** (`app.ts`): the renderer, the main loop and each sport's lifecycle (`startBowling()`,
  `startDuel()`…, and the tennis match). Every frame it reads input, steps the active game, poses the
  characters, points the camera and asks the `Stage` to draw. Tennis steps in small fixed sub-steps
  (`Match.step(h)`), capped after a hitch so the game falls slightly behind instead of jumping.
- **`Flow`** (`flow.ts`): everything around the play. Menus and setup screens, saved settings, starting
  and ending matches, scores and celebrations, Kaleydo shifts, online rooms and quick match, and
  `syncPads()`, which decides which panel each phone shows.

### Sports

Each sport is a folder with the same split, so the rules run headless in the sims:

| File | Role | Three.js? |
|---|---|---|
| `game.ts` / `match.ts` | the referee: states, turns, scoring, what an input does; emits events | no |
| `physics.ts` / `ball.ts`, `shot.ts` | flight, bounces, pins (bowling uses Rapier, the rest is closed-form) | no |
| `ai.ts` | CPU players by level | no |
| `venue.ts` | the set for this sport, built from the world's materials | yes |
| `anim.ts` | the characters' animation from the game's state | yes |
| `camera.ts` | the cameras | yes |

Tennis (`src/tv/tennis/`) is the deepest: closed-form ball flight with spin and bounces (`ball.ts`), a
shot solver that turns a swing's timing, power and spin into a target and a trajectory that clears the
net (`shot.ts`), the rules and point flow (`match.ts`, with scoring in `score.ts`), the Rush pace
(`rush.ts`), CPU players (`ai.ts`) and the first-time demo (`demo.ts`).

### Worlds, the stage and the shatter

A world (`src/tv/worlds/`) is a scene and a render pipeline in one art style; see
[worlds.md](worlds.md). The **`Stage`** (`src/tv/render/stage.ts`) owns the live world and
composites the **kaleidoscope shatter**: during a Kaleydo shift both worlds render and a shader breaks
the old one into Voronoi prism shards that fall away from a point on screen to reveal the new one.
Worlds are compiled ahead of time where possible (`World.compileAsync()`, `watchMaterials()`) so a
shift doesn't stall on shader compilation.

### Quality

`src/tv/render/quality.ts` keeps the frame rate steady: it measures GPU time per frame (timer queries
where the browser has them) and walks a ladder of render scale and effects tiers, stepping down fast
and up reluctantly, only at safe moments (between points, in menus). The level that worked is
remembered per world.

### Audio

`src/tv/audio/` is a small synthesiser and sequencer on Web Audio: instruments made from oscillators
and noise (`engine.ts`), each world's song as a compact score (`songs.ts`), and the music layering up as
a rally gets longer (`music.ts`). During a rally every hit plays the next note of the song's melody.
Sound effects and the crowd are synthesised too (`sfx.ts`).

### Input

`src/tv/core/input.ts` turns phone messages, mouse flicks and the keyboard into one set of events
(`onSwing`, `onBowl`, `onSlash`, `onDraw`…), each tagged with the player's slot (seat). Up to four
seats, each with a colour. It also works out how old each phone event is (see
[Latency](#latency-compensation)).

## The phone remote (`src/pad`)

- **Sensors** (`pipeline.ts`, `orient.ts`): raw `devicemotion` / `deviceorientation` events in, angular
  velocity and a fused orientation out. Nothing allocates per event, because a garbage-collection pause
  on a phone drops sensor events.
- **Detectors**: `swing.ts` (tennis and batting: power from the peak angular speed, forehand /
  backhand / overhead from the rotation about the vertical, topspin or slice from the angle of attack,
  and a backswing as a hint of which side you're setting up on), `bowl.ts` (the arm's pendulum and the
  release: speed, line, wrist twist), `sword.ts` (slash direction, thrust, guard angle), `lift.ts` (the
  serve toss). All measure against the real world, not the phone, so they work however it's held.
- **Panels** (`main.ts`, `pad.css`): `menu` (a D-pad and A / B), `play`, `serve`, `bowl`, `sword`, `bow`,
  `bat`, `wait`, `watch`, `skip`, `demo`. The TV sends a `mode` message with the panel, a title and a
  hint; the phone never decides on its own what's happening.
- **Transport** (`link.ts`): a WebSocket if it opens; otherwise HTTPS POST up and Server-Sent Events
  down. (iOS Safari refuses `wss://` to a certificate that was only tapped through, but allows ordinary
  requests from a page it accepted, so the fallback is what makes the local server work without the
  optional certificate setup.)
- **Captures**: `/rec` on the local server records a phone's raw motion to `captures/*.jsonl`;
  `scripts/tools/replay-capture.ts` replays one through the same pipeline and detectors, so a swing
  that was misread can be reproduced exactly.

## The local server (`server/`)

`server/server.mjs` is plain Node (http, https, `ws`):

| Address | Who | What |
|---|---|---|
| `http://localhost:3000/` | this computer only | the TV page (the built `dist/`, or Vite's dev middleware with `--dev`) |
| `http://<lan-ip>:3000/join` | the LAN | what the QR code opens: the join page |
| `https://<lan-ip>:3443/c` | the LAN | the remote (`controller.html`) |
| `/ws?role=tv` | loopback only | the TV's WebSocket |
| `/ws?role=pad`, `/api/pad/events`, `/api/pad/send` | phones | the remote's WebSocket, or its SSE + POST fallback |
| `/kaleido.mobileconfig`, `/kaleido-ca.crt` | the LAN | the iOS profile and the CA certificate (public data) |
| `/api/info`, `/api/qr.svg` | loopback | the addresses, the QR code |

On plain http the LAN is only ever given the join page, its two images, the profile and the
certificate; the TV page, its socket and the API stay loopback-only (checked by address and by `Host`
header).

**Certificates** (`certs.mjs`): phones only give motion sensors to https pages, so on first run the
server makes a local certificate authority (`server/.certs/ca.*`, "KALEIDO Local CA (<hostname>)") and a
certificate for this machine's LAN addresses signed by it, remade by itself when the addresses change
or it nears expiry. The CA stays, so a phone that trusted it keeps trusting it.

**The join page** (`join-page.mjs`) is self-contained (a strict Content-Security-Policy, no outside
scripts). It checks whether the phone already trusts the CA (a CORS fetch to the https port only
succeeds if it does) and goes straight to the remote if so; otherwise it offers the one-time setup or
lets the player tap through the browser's warning.

**`server/doctor.mjs`** (`npm run doctor`) checks all of the above from the outside: Node, the build,
the ports, the LAN address, the firewall, the certificates.

## The cloud (`cloud/`)

`cloud/worker.ts` is a Cloudflare Worker that serves `dist/` (Workers static assets) and routes:

- `/ws?room=CODE`: into that room's **`Room`** Durable Object.
- `/c?room=CODE`: the remote, in that room.
- `/mm`: quick match, into the single **`Lobby`** Durable Object (`cloud/lobby.ts`).
- `/api/info`: `{ cloud: true }`, so the TV page knows to make a room.

A TV makes up a five-letter room code and shows it with a QR code that opens `/c?room=CODE`. A room
belongs to the first TV that claims it (it keeps a random key), so a guessed code can't take over
someone's game.

### Rooms and guest TVs

Online play adds a third role. A **guest TV** (a friend's laptop, anywhere) joins a room by its code;
the **host TV stays the only simulation**. The guest's own phones open the same `/c?room=CODE` from the
guest's QR code (with `&via=<guest id>`) and join the host directly as ordinary remotes: they play on
the host, and the relay remembers which guest they came from. The relay:

- tells the host who joined, and forwards the host's messages to every guest (JSON, plus binary match
  snapshots forwarded untouched);
- echoes a guest's phones' swings, slashes, releases and draws to that guest at once (`pad-echo`), so
  the guest's TV makes the swing's sound without waiting for the host's judgement to come back;
- moves phones between rooms: a TV that joins another's room sends its phones a `move` message and
  they reconnect there by themselves (and back home when it leaves).

The match stream covers tennis (`src/shared/net.ts`, see below).

### Quick match

**Quick match** puts a TV in a queue held by the `Lobby` object. On each arrival, and when a waiting TV
reaches 20 s, it pairs the longest-waiting TV with the earliest other one on the same continent (as
Cloudflare's edge reports it; after 20 s, with anyone). The one that waited longer **hosts**: its room
already exists, so the other simply joins it as a guest, its phone follows, and the host starts a
singles match by itself. Afterwards: **Play again** or **Leave**. The pairing rule is a pure function
(`pickPair()`), tested headlessly.

### Idle costs nothing (WebSocket Hibernation)

Both Durable Objects use Cloudflare's WebSocket Hibernation API. A classic WebSocket keeps its object
in memory, and an object in memory is billed for its wall-clock time: a TV parked on the home screen
would use most of the free plan's daily allowance by itself. With hibernation the runtime holds the
sockets and the object sleeps (nothing billed) until a message arrives. What it must remember lives in
storage (the room's key, code and origin) and in each socket's attachment (role, id, name, `via`); the
in-memory view is rebuilt from those at the top of every handler.

What wakes it: any message except the exact text `ka`, which the runtime answers itself
(`setWebSocketAutoResponse`). So clients send only `ka` every 40 s while idle, and the timed
`{type:'ping'}` (which needs the relay's clock) only while active:

- **TV** (`src/tv/core/link.ts`): every 2 s while a match runs or in the minute after the room last had
  something to say; otherwise `ka`. It also drops identical repeats of a phone's `mode` message.
- **Phone** (`src/pad/link.ts`): every 2 s while in a play panel or after it moved in the last 30 s;
  otherwise `ka`. The pose stream doesn't run in menus.
- **Lobby**: the queue is a row per TV in storage; an alarm is set only while someone waits.

`wrangler dev --var DEV:1` makes each room count what reaches its handlers (`/api/room-stats?room=CODE`),
and the hibernation e2e test parks a TV and a phone for a minute and asserts the count stays 0. With
`--var HIBERNATE_DEBUG:1` every handler rebuilds its state from storage, as after an eviction.

## Latency compensation

Every timed phone message (`swing`, `bowl`, `slash`, `draw`, `toss`…) carries:

- `age`: how long ago, on the phone, the motion happened (the detector needs a few tens of ms after a
  swing's peak to be sure it was one);
- `lat`: the phone's measured one-way delay to the relay;
- `ts`: the relay's clock when the phone sent it, once the phone has learned its clock offset.

The relay stamps each message with its own clock as it forwards it, and the TV knows its offset to the
relay's clock from its own pings. So the TV can add up detector + uplink + relay-to-TV and know how old
the swing really is (up to 250 ms; `SWING_AGE_MAX` in `core/input.ts`). The match then **resolves the
swing as of when it happened**: timing is judged at that moment, the stroke is drawn from the past, and
a ball that's already gone past is drawn back to the racket for a beat. Locally that's a few
milliseconds; over the internet a friend 100 ms away swings as accurately as you do, to within the
line's jitter (±10 to 30 ms). The TV's latency readout (`LatencyPanel` in `ui/hud.ts`) shows the parts.

## The online match stream

`src/shared/net.ts` is shared by the host (`src/tv/net/host.ts`) and the guests (`src/tv/net/guest.ts`):

- A JSON **`start`** message has everything needed to build the same match (players, looks, world,
  format, seed, flags like Rush).
- **Binary snapshots**, ~30 a second and at every match event, each a whole picture of one instant: the
  score, the state, the ball's flight *segment* (its launch point, velocity and spin in full precision,
  so the guest evaluates the ball's position exactly as the host does, at any time), every player's
  pose, and the events since the last one. Two players: about 250 bytes. A lost or late snapshot only
  costs a little smoothness.

A guest **never simulates**. It builds a *shadow* `Match` nobody steps and plays the snapshots a
moment behind the host: poses are interpolated, the ball is its segment evaluated at the shown time,
events fire when the shown time reaches them. The **buffer** follows the connection: one snapshot
interval plus the 95th percentile of how late snapshots arrived over the last few seconds (never under
50 ms), rising at most 60 ms per second and falling at most 20, so it's never seen as a jump. Measured:
about 110 ms behind for a friend 40 ± 8 ms away, 190 ms at 90 ± 15 ms, 330 to 400 ms at 150 ± 30 ms
with lost packets. A snapshot that still comes late freezes the picture for a moment; nothing ever
teleports.

## Testing

| What | Where | How |
|---|---|---|
| Rules, scoring, detectors, the snapshot codec | `scripts/check/` | headless TypeScript (`npx tsx`), in `npm test` |
| Whole matches, CPU vs CPU and simulated players | `scripts/check/` sims | `npm run test:sims`; tennis sims print a hash of the event stream, so a refactor that shouldn't change the game can prove it didn't |
| The real TV and remote pages | `scripts/e2e/` | `npm run test:e2e`: headless Chrome via `playwright-core`, with a simulated phone (`scripts/lib/fake-phone.mjs`) producing physically consistent motion events |
| Rooms, quick match, the online stream, hibernation | `scripts/e2e/` | `npm run test:cloud`, against a local `wrangler dev`; a lag proxy (`scripts/lib/lag-proxy.mjs`) adds delay, jitter and spikes to every WebSocket frame |
| Frame time, GPU, allocations | `scripts/perf/` | measuring tools, run by hand |
| Screenshots | `scripts/shots/` | deterministic renders (seeded randomness, a stepped clock) for visual comparison |
