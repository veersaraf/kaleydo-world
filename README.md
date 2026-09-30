# KALEIDO — World Sports

Motion-controlled **tennis**, **bowling**, **sword duels**, **archery** and **baseball** in the spirit of Wii Sports,
played across nine worlds that each look like a different medium: a Switch
Sports-style park, a cel-shaded plaza, a sumi-e ink painting, a synthwave
night drive, an 8-bit castle, a paper pop-up book, a stop-motion clay set, a
watercolour garden and a court adrift in space.

**Your iPhone is the remote. Your Mac is the TV.** In tennis, swing your phone
like a racket: timing aims the shot, swing speed sets the power, and brushing
up or chopping down adds topspin or slice. In bowling, hold the ball on the
screen, swing your arm and let go — twist your wrist to hook it. In a sword
duel the phone is your sword: swing to strike, hold GUARD to block. In archery,
point the phone at the target, hold DRAW and let go. At bat, hold the phone like a
bat and swing as the ball reaches the plate. Up to four phones can join,
each with a character you make on the phone (⚙ → Your character).

Everything — characters, courts, shaders, music, sound effects — is generated
in code. There are no image, model or audio files.

## Play

Two ways:

- **Online:** open the hosted game in any computer's browser (a laptop, or a TV
  with a browser), and scan the QR code with your phone. The phone becomes a
  remote at once — no app, no setup, no certificate — and friends can join the
  same room from their phones. (See *Hosting it* below.)
- **On your own Mac**, no internet needed (phones on the same Wi-Fi):

```bash
npm install
npm start
```

`npm start` builds the game, starts the local server and opens
<http://localhost:3000> on your Mac. Click once to start (browsers need one
click before they'll play sound) and press **F** for full screen.

### Connect your iPhone

1. Make sure the phone is on the **same Wi‑Fi** as the Mac.
2. Scan the QR code on screen with the Camera app.
3. Safari will say **"This Connection Is Not Private"** — that's expected: the
   game serves itself from your Mac with a certificate it made for itself.
   Tap **Show Details → visit this website → Visit Website**.
4. Type your name, pick your hand, tap **Join game**, and allow motion access.
5. If macOS asks whether `node` may accept incoming connections, choose **Allow**.

The remote shows a Wii-Remote-style pad in menus and a swing meter while you
play. When it's your serve, **lift the phone** to toss (or tap the big
button), then swing. It plays the racket "pok" through the phone speaker,
like the Wii Remote did.

**Optional — faster connection, no warning:** on the phone's join screen open
*"Optional: remove the security warning"* and follow the three steps to trust
the KALEIDO certificate. This lets the remote use WebSockets (lower latency).

### Tennis controls

| | Phone | Mac |
|---|---|---|
| Hit | swing like a racket | flick the mouse (up = topspin, down = slice) |
| Aim | swing early → cross-court, late → down the line | same |
| Power | swing speed | flick speed, or <kbd>Shift</kbd>+<kbd>J</kbd> |
| Spin | brush up = topspin, chop down = slice | <kbd>J</kbd> flat · <kbd>K</kbd> topspin · <kbd>L</kbd> slice |
| Lob / drop | soft upward / soft downward swing | <kbd>U</kbd> lob · <kbd>I</kbd> drop |
| Serve | lift the phone to toss (or tap), then swing at the top — nail the top for a **rocket serve** | <kbd>Space</kbd> or click to toss, then swing |
| Menus | D-pad, **A**, **B** | arrows, <kbd>Enter</kbd>, <kbd>Esc</kbd> |
| Pause | Home | <kbd>Esc</kbd> / <kbd>P</kbd> |

Your player runs to the ball automatically — you only decide *when* and *how*
to swing. Balls at the edge of reach get a lunge or a flying dive. Run your
opponent corner to corner and they tire: slower, sweating, and floating weak
"wobbly" returns — swing hard at those for a **SMASH**. Local versus gives
each side its own half of the screen.

### Bowling controls

| | Phone | Mac |
|---|---|---|
| Bowl | **hold** the ball on the screen, swing your arm back and through, **let go** at the bottom | hold <kbd>Space</kbd> (or the mouse button), let go — or flick the mouse up |
| Speed | how fast you swing | flick speed |
| Hook | twist your wrist as you let go (turn it left to hook left) | <kbd>J</kbd> straight · <kbd>K</kbd> hook left · <kbd>L</kbd> hook right |
| Move / aim | ◀ ▶ step, ↺ ↻ turn the aim line — one board per tap | arrow keys |

You start where a straight ball meets the pocket. A hook curves late, so to
hook into the pocket move right (left-handers: left) and aim out a little.
The ball takes only a little of your swing's sideways drift — keep it
straight and it goes where the line points.

### Sword duel controls

| | Phone | Mac |
|---|---|---|
| Strike | swing the phone in any direction (across, down, diagonally) | the arrow keys, or drag the mouse |
| Thrust | push the phone towards the screen | <kbd>X</kbd> |
| Guard | hold **GUARD** and hold the sword *across* their swing — upright stops side swings, flat stops chops | hold <kbd>Space</kbd> (angled for you) or the right mouse button (the blade points at the cursor) |
| Re-center | point the phone at the screen and tap ⌖ | |

A blocked attacker is stunned for a moment — strike back. Flailing tires your
arm and weakens your hits. Knock them off the end of the platform to take the
round; best of three. Two phones get a split screen.

### Archery controls

| | Phone | Mac |
|---|---|---|
| Draw | hold **DRAW** (the string comes back over about a second) | hold the mouse button or <kbd>Space</kbd> |
| Aim | point the phone — the sight starts on the target and follows your turn | the cursor; arrow keys fine-tune |
| Shoot | let go | let go |

The sight allows for the drop; the wind (flags and gauge) is yours to judge.
Balloons are worth bonus points. Three ends of three arrows.

### Baseball controls (Home Run Derby)

| | Phone | Mac |
|---|---|---|
| Swing | hold the phone in both hands like a bat and swing through as the ball reaches the plate | <kbd>Space</kbd>, or flick the mouse (up = an uppercut) |

Timing is everything: right on time goes to centre field, early pulls it, late
pushes it the other way — too early or late is foul. Swing speed is distance;
an uppercut lifts it. The fence is 100 m down the lines and 122 m to centre.
After each swing a meter shows how early or late you were.

## Modes

- **Quick Match** — singles or doubles, vs CPU or friends (up to 4 phones),
  1 / 3 / 5 games, four CPU levels, any world.
- **Bowling** — ten frames for up to four players, with an optional CPU
  (Rookie, Pro or Ace), in any world. Pins are real rigid-body physics.
- **Sword Duel** — you against a CPU (Rookie, Pro or Ace) or a friend on a
  second phone, on a platform over the water in any world.
- **Archery** — everyone on their own phone, plus an optional CPU: three ends
  at 15, 22 and 30 m with wind, raised and swaying targets, and balloons.
- **Home Run Derby** — everyone bats in turn against a CPU pitcher (friendly,
  tricky or nasty: fastballs, curves, sliders, changeups), 5, 10 or 15 pitches
  each, with an optional CPU slugger. Most home runs wins.
- **World Tour** — the Great Prism shattered into eight worlds. Beat each
  world's champion to restore its shard, then face the Prism King.
- **Kaleido Rally** — every couple of points, or any PERFECT shot deep in a
  rally, the court shatters like a kaleidoscope into the next world.

## Worlds

| World | Look | Twist |
|---|---|---|
| Sports Park | Switch Sports-style: smooth shading, soft sun, coral court in a modern plaza | the default |
| Sunny Plaza | cel-shaded, outlined, sunny | the classic |
| Inkwell | sumi-e ink wash on rice paper; only vermilion survives | ink splats where the ball lands |
| Neon Drive | synthwave grid, striped sun, bloom | everything pulses to the beat |
| Bit Kingdom | 270p, 16-colour palette, dithering | square ball, chiptune |
| Paper Isles | pop-up book; players are paper cut-outs | clouds on strings |
| Clayland | stop-motion plasticine at 12 fps, tilt-shift | a real clay court that keeps ball marks |
| Aquarelle | watercolour (Kuwahara + pigment + paper) | hot-air balloons |
| Starfall | a court on an asteroid | **low gravity** — the ball floats |

Each world has its own music. During a rally, every hit plays the next note
of the song, and the arrangement builds as the rally gets longer.

## Troubleshooting

- **The phone can't reach the game** — same Wi‑Fi? No VPN on either device?
  macOS firewall allowed `node`? The address is printed in the terminal.
- **No sound on the Mac** — click the game window once.
- **No sound on the phone** — turn the volume up; KALEIDO plays through the
  silent switch on iOS 17+.
- **Swings aren't detected** — allow Motion & Orientation access when asked.
  If you denied it: Settings → Apps → Safari → Advanced → Website Data, remove
  the entry for the game's address, then rejoin. On the remote, the ⚙ menu has
  a sensitivity setting (*Big swings / Normal / Light swings*).
- **Too hard / too easy** — change the CPU level in Quick Match.

## Hosting it

The game is static files plus a tiny relay: `cloud/worker.ts` is a Cloudflare
Worker that serves `dist/` and gives each TV a room (a Durable Object) that its
phones join — the same relay `server/server.mjs` runs on a Mac. A TV makes up a
5-letter room code; its QR code opens `/c?room=CODE` on the phone. With a real
domain the site has a real certificate, so phones get motion sensors with no
setup.

```bash
npm run cloud:dev      # build, and run it locally on http://127.0.0.1:8787
npx wrangler login     # once: your Cloudflare account
npm run cloud:deploy   # build, and publish to <name>.workers.dev
```

Then point a domain at it in the Cloudflare dashboard (Workers → kaleido →
Settings → Domains & Routes). The free plan is plenty for a hobby game.
`node scripts/cloud-e2e.mjs` checks a running cloud copy end to end.

### Idle costs nothing (WebSocket Hibernation)

Both Durable Objects (`Room`, `Lobby`) use Cloudflare's WebSocket Hibernation API. A classic
WebSocket keeps its object in memory, and an object in memory bills 128 MB × wall-clock
seconds — a TV parked on the home screen would use ~10,800 of the free plan's 13,000 GB-s a
day. Now the runtime holds the sockets and the object sleeps (no duration billed) until a
message arrives; what it must remember lives in storage (the room's key, code and origin) and in
each socket's attachment (role, id, name, `via`), and the in-memory `tv` / `pads` / `guests` are
rebuilt from those by `ready()` at the top of every handler.

What wakes it: any message a client sends *except* the exact text `ka`, which the runtime
answers with `ka` itself (`setWebSocketAutoResponse`). So the clients send only `ka`, every 40 s,
while idle, and the timed `{type:'ping', t}` (which needs the relay's clock) only while active:
- **TV** (`src/tv/core/link.ts`): the connect burst, then every 2 s while *active* — `busy()`
  says a match runs, or in the 60 s after the room last had anything to say besides a keepalive
  or a pong (a phone or guest joined, left or sent something; a guest hears its host). Idle: `ka`.
  A TV also drops an identical repeat of a phone's `mode` message (the flow re-sends it every
  ~10 s), since every message to a phone is one the room wakes for.
- **Phone** (`src/pad/link.ts`, `src/pad/main.ts`): the burst, then every 2 s while its mode is a
  play mode (`play serve bowl sword bow bat`) or it moved (orientation changed > ~6°) in the last 30 s.
  Idle: `ka`. The pose stream (`ori`) no longer runs in menus (the TV draws no pose there), so a
  phone on a table in a menu sends nothing but `ka`. Becoming active sends the burst again, so
  `lat` and the clock offset are fresh before the first swing.
- **Lobby**: the queue is a row per TV in storage (mirrored in its socket's attachment); an alarm
  is set only while someone waits, for the next moment something can change by itself (a waiting
  TV reaching 20 s, else a 30 s heartbeat); TVs are told the queue's size the moment it changes.
  No one waiting, no alarm: the object sleeps.

Testing: `wrangler dev --var DEV:1` makes each room count what reaches its handlers
(`/api/room-stats?room=CODE`); `node scripts/hibernate-e2e.mjs` parks a TV and a phone for a
minute and asserts the count stays 0 (then wakes the room with a match and checks the swing's
age). Add `--var HIBERNATE_DEBUG:1` and every handler rebuilds its state from storage and
attachments, as after an eviction, so the whole e2e set can run with no memory between events.
(Local `wrangler dev` closes a hibernatable socket from the server side without ending the
TCP connection, so a Node client stays CLOSING; browsers get their close event.)

### Play online with friends

In the cloud version, **Play online** (on the home screen) lets a friend's TV
join yours. **Host a room** is what every cloud TV already is: its room code
(five letters) and QR code are on screen. A friend opens the game on their own
computer, chooses **Play online → Join a room**, and types your code (keyboard,
or the pad's ◀ ▶ ▲ ▼ and A). Their TV becomes a *guest*: its lobby shows the room,
who's in it and a QR code — their phones scan that and join **your** game
directly, as ordinary remotes; your TV stays the only place the game runs and
streams the match to theirs. B / Esc leaves. `node scripts/room-e2e.mjs`
(against `npx wrangler dev --port 8792`) checks all of it. The Mac's own server
has no rooms.

**Quick match.** Nobody to send a code to? On Play online, the third card, **Quick
match** (it needs a phone joined on your TV), puts your TV in a queue held by one
Durable Object (`cloud/lobby.ts`, the `LOBBY` binding) and shows "Looking for an
opponent… 0:07". On each arrival (and at the moment a waiting TV has waited 20 s) the lobby pairs the longest-waiting TV with
the earliest-arrived other one on the same continent (as Cloudflare's edge reports it;
after 20 s, with anyone), and the one that has waited longer **hosts**: its room already
exists, so the other TV simply joins it as a guest. The guest's phone needs no rescan: a TV that
joins another's room (this, or a code typed in) sends its phones a `move` message and they reconnect
there by themselves (`&via=` its id; the host sends them back home when the guest leaves), and once it is seated (up to 15 s) the
host starts a singles match by itself: its first phone against that one, in a random world
(Kaleido and the game count as set). Afterwards the host offers **Play again** (A: another
match, same two people) or **Leave** (B: both TVs go back to Play online). If the opponent's
TV or phone goes away mid-match the host says "Your opponent left". B cancels a search.
`npx tsx scripts/mm-pair-test.ts` checks the pairing rule; `node scripts/mm-e2e.mjs`
(against `npx wrangler dev --port 8801`; `GET /mm/stats` says how many TVs are queued)
plays it through with two TVs and their simulated phones.

**What to expect over the internet.** The host never waits for the network: it plays
at full speed, and a phone's swing is timed by when it *happened* (the phone reports
how old the swing is, plus its delay to the relay, plus the relay's to the host), not by
when it arrived — so a friend 100 ms away swings as accurately as you do (the accuracy
is the line's jitter: ±10–30 ms). What a guest *sees* is the match about `one-way delay
+ buffer` behind the host. The guest measures how late snapshots arrive over the last few
seconds and buffers that much (one snapshot interval + the 95th percentile of the lateness,
never under 50 ms; it grows ≤ 60 ms/s and shrinks ≤ 20 ms/s, so it is never seen as a jump):
measured, ~110 ms behind for a friend 40 ± 8 ms away, ~190 ms at 90 ± 15 ms, ~330–400 ms at
150 ± 30 ms with lost packets. A snapshot that still comes late freezes the picture for a
moment (never a teleport: the ball and players wait, the buffer grows by what was missing).
A guest's phones are opened from the guest's own QR code, so the guest hears each swing the
instant the relay gets it (the whoosh doesn't wait for the host), looks at the court from
its own players' end, and sees the host's Kaleido shifts shatter from the same spot in
the court. `node scripts/online-lag-e2e.mjs` proves it at those three delays, and with the
host itself 60 ms from the relay, through a lag proxy (`scripts/lib/lag-proxy.mjs`: delay,
jitter and spikes on every WebSocket frame, order kept) in front of `wrangler dev`.

## Development

```bash
npm run dev        # dev server with hot reload (no auto-open)
npm run typecheck
npx tsx scripts/sim.ts        # headless CPU-vs-CPU matches (rules/physics check)
npx tsx scripts/sim-human.ts  # simulated human vs each CPU level
npx tsx scripts/bowl-sim.ts   # bowling physics: strike % by line, splits, spares
npx tsx scripts/bowl-cpu-sim.ts  # headless bowling games per CPU level
npx tsx scripts/bowl-score-test.ts && npx tsx scripts/bowl-pad-test.ts
npx tsx scripts/duel-game-test.ts && npx tsx scripts/sword-pad-test.ts
npx tsx scripts/duel-sim.ts   # CPU duels and simulated players vs each CPU level
npx tsx scripts/archery-game-test.ts && npx tsx scripts/archery-sim.ts
npx tsx scripts/baseball-game-test.ts && npx tsx scripts/baseball-sim.ts
node scripts/baseball-phone-e2e.mjs   # a simulated phone bats on the real TV (needs npm run dev)
```

- `server/` — Node server: HTTP on localhost for the TV, HTTPS on the LAN for
  phones (with a locally generated certificate authority), and a hub that
  relays remote input over WebSockets or HTTPS+Server-Sent Events.
- `src/pad/` — the phone remote: swing, bowling-release and sword-slash
  detection, transport, sounds, UI.
- `src/tv/tennis/` — closed-form ball physics, shot solver, rules, AI, camera.
- `src/tv/bowling/` — lane model + Rapier pins, scoring, the referee and CPU
  bowlers, camera, the alley (built in each world's style) and the bowler's
  animation.
- `src/tv/duel/` — the duel's rules and CPU fighters, the arena and swords
  (in each world's style), fighter animation and camera.
- `src/tv/archery/` — arrow physics and wind, target layouts, scoring and CPU
  archers, the range and bow (in each world's style), the archer's animation
  and camera.
- `src/tv/baseball/` — the derby's rules, pitches and batted-ball flight, CPU
  hitters and pitcher, the ballpark (in each world's style), the batter,
  pitcher and catcher, and the cameras.
- `src/tv/chars/` — procedural characters and animation.
- `src/tv/worlds/` — one file per world: scenery, materials and its own
  post-processing pipeline.
- `src/tv/audio/` — synthesised instruments, sequencer, songs, SFX, crowd.
- `src/tv/flow.ts` — menus, match lifecycle, World Tour, Kaleido Rally.
