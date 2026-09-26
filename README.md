# KALEIDO — World Tennis

A motion-controlled tennis game in the spirit of Wii Sports, played across
eight worlds that each look like a different medium: a cel-shaded plaza, a
sumi-e ink painting, a synthwave night drive, an 8-bit castle, a paper pop-up
book, a stop-motion clay set, a watercolour garden and a court adrift in space.

**Your iPhone is the remote. Your Mac is the TV.** Swing your phone like a
racket; timing aims the shot, swing speed sets the power, and brushing up or
chopping down adds topspin or slice. Up to four phones can join.

Everything — characters, courts, shaders, music, sound effects — is generated
in code. There are no image, model or audio files.

## Play

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

The remote shows a Wii-Remote-style pad in menus, a swing meter while you
play, and a big **TAP TO TOSS** button when it's your serve. It plays the
racket "pok" through the phone speaker, like the Wii Remote did.

**Optional — faster connection, no warning:** on the phone's join screen open
*"Optional: remove the security warning"* and follow the three steps to trust
the KALEIDO certificate. This lets the remote use WebSockets (lower latency).

### Controls

| | Phone | Mac |
|---|---|---|
| Hit | swing like a racket | flick the mouse (up = topspin, down = slice) |
| Aim | swing early → cross-court, late → down the line | same |
| Power | swing speed | flick speed, or <kbd>Shift</kbd>+<kbd>J</kbd> |
| Spin | brush up = topspin, chop down = slice | <kbd>J</kbd> flat · <kbd>K</kbd> topspin · <kbd>L</kbd> slice |
| Lob / drop | soft upward / soft downward swing | <kbd>U</kbd> lob · <kbd>I</kbd> drop |
| Serve | tap **TAP TO TOSS** (or swing), then swing at the top | <kbd>Space</kbd> or click to toss, then swing |
| Menus | D-pad, **A**, **B** | arrows, <kbd>Enter</kbd>, <kbd>Esc</kbd> |
| Pause | Home | <kbd>Esc</kbd> / <kbd>P</kbd> |

Your player runs to the ball automatically — you only decide *when* and *how*
to swing.

## Modes

- **Quick Match** — singles or doubles, vs CPU or friends (up to 4 phones),
  1 / 3 / 5 games, four CPU levels, any world.
- **World Tour** — the Great Prism shattered into eight worlds. Beat each
  world's champion to restore its shard, then face the Prism King.
- **Kaleido Rally** — every couple of points, or any PERFECT shot deep in a
  rally, the court shatters like a kaleidoscope into the next world.

## Worlds

| World | Look | Twist |
|---|---|---|
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

## Development

```bash
npm run dev        # dev server with hot reload (no auto-open)
npm run typecheck
npx tsx scripts/sim.ts        # headless CPU-vs-CPU matches (rules/physics check)
npx tsx scripts/sim-human.ts  # simulated human vs each CPU level
```

- `server/` — Node server: HTTP on localhost for the TV, HTTPS on the LAN for
  phones (with a locally generated certificate authority), and a hub that
  relays remote input over WebSockets or HTTPS+Server-Sent Events.
- `src/pad/` — the phone remote: swing detection, transport, sounds, UI.
- `src/tv/tennis/` — closed-form ball physics, shot solver, rules, AI, camera.
- `src/tv/chars/` — procedural characters and animation.
- `src/tv/worlds/` — one file per world: scenery, materials and its own
  post-processing pipeline.
- `src/tv/audio/` — synthesised instruments, sequencer, songs, SFX, crowd.
- `src/tv/flow.ts` — menus, match lifecycle, World Tour, Kaleido Rally.
