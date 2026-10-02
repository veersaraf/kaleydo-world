# Contributing to Kaleydo World

Thanks for wanting to help. Bug reports, new game modes, new worlds, better motion detection,
performance work and doc fixes are all welcome. By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node 20.19 or newer (22+ recommended; the Cloudflare commands need 22+), and a phone on the
same Wi-Fi to play with motion. The browser tests need Google Chrome installed.

```bash
git clone https://github.com/veersaraf/kaleydo-world.git
cd kaleydo-world
npm install
npm run doctor     # checks your setup; prints a fix for anything that's off
npm run dev        # live-reload server: http://localhost:3000, phones scan the QR code
```

`npm run dev` serves the TV page through Vite with hot reload, and the phone remote from the same
server. Every sport can also be played with the mouse and keyboard, which is the quickest way to try a
change. The TV page exposes `window.kaleido` (the `App`) and `window.flow` (the `Flow`) in the
console for poking at things.

Read [docs/architecture.md](docs/architecture.md) first; it's the map. The code is heavily commented,
and the comment at the top of each file says what it's for.

## The checks to run

```bash
npm test             # typecheck + fast headless checks; run before every commit
npm run test:sims    # headless matches for every sport; run if you touched rules, physics or CPU players
npm run test:e2e     # simulated phones on the real TV page (starts its own server, needs Chrome)
npm run test:cloud   # rooms, quick match, online play; run if you touched cloud/, src/tv/net/ or the protocol
```

CI runs the same checks on every pull request.

Two rules the tests protect:

- **Determinism.** The tennis rules are deterministic for a seed, and the sims print a hash of each
  match's event stream. A change that isn't meant to change the game (a refactor, a performance fix)
  must leave those hashes unchanged; say so in the PR.
- **The phone and the TV can be different versions.** Someone may have a phone open from before your
  change. New protocol fields should be optional on both ends.

## Commit style

Look at `git log` for the house style. A commit subject is one plain sentence that says what changed
from a player's or developer's point of view, often with the area first:

```
Bowling remote: the Move and Aim pills fit side by side on a narrow phone (SE)
Tennis setup: the button reads "Play ▶" while Kaleido mode is on (it skips the world picker)
Rooms and lobby on the WebSocket Hibernation API: an idle TV or phone bills no duration
```

- Say what it does, not "fix stuff" or "update file".
- Details, numbers and the reasoning go in the body.
- One logical change per commit.

## Proposing a game mode or a world

Open an issue first with the **New game mode** template (or a feature request for a world), so we can
agree on the idea before you build it. Then:

- **Game modes:** follow [docs/game-modes.md](docs/game-modes.md). The rule goes behind an optional
  config flag that defaults to off, it gets a control on the setup screen, it works online (tennis),
  and it comes with a headless check and, if it changes how matches play, a sim showing what changed.
- **Worlds:** follow [docs/worlds.md](docs/worlds.md). Everything in code (no image, model or audio
  files), every sport's venue checked in it, split screen checked from both ends, and the frame rate
  holding on an ordinary laptop. Include screenshots.

## Reporting bugs

Use the **Bug report** template. The most useful things to include: the phone and its browser, the
computer and its browser, whether you're on the local server or online (and, for the local server,
whether the phone uses WebSocket or the HTTPS fallback: press <kbd>;</kbd> on the TV for the swing
latency readout, which shows it), and what `npm run doctor` says. For a swing that's misread, a motion capture helps a lot: open
`/rec` on the local server from the phone, swing, and attach the file from `captures/`.

## Pull request checklist

- [ ] `npm test` passes; `npm run test:sims` / `test:e2e` / `test:cloud` too if your change touches
      what they cover.
- [ ] With any new mode switched off, the sims' event hashes are unchanged.
- [ ] Tried on a real phone if it touches the remote, motion detection or latency.
- [ ] New protocol fields are optional; online play still works between a new host and an older guest
      where it reasonably can.
- [ ] No new asset files (images, models, audio): the game is made in code.
- [ ] Docs updated (README controls, `docs/`) if players or contributors need to know.
- [ ] Commits follow the style above.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
