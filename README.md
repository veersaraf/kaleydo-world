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
