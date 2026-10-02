# How a world is built

Every world is the same court, players, ball and effects, drawn in a different medium. A world is one
TypeScript file in `src/tv/worlds/` (plus a `<name>-env/` folder when its scenery is big) that
subclasses `World` from `src/tv/worlds/base.ts` and swaps the materials, scenery, lighting and
post-processing. Nothing is loaded from files: geometry is built in code, textures are drawn on
canvases or computed in shaders, and the music is a short score in `src/tv/audio/songs.ts`.

## The nine worlds

| id | World | Look | Twist |
|---|---|---|---|
| `park` | Sports Park | smooth shading, soft sun, a coral court in a modern plaza | the default |
| `plaza` | Sunny Plaza | cel-shaded and outlined | the classic |
| `ink` | Inkwell | sumi-e ink wash on rice paper; only vermilion survives | ink splats where the ball lands |
| `neon` | Neon Drive | synthwave grid, striped sun, bloom, a mirrored glass floor | everything pulses to the beat |
| `pixel` | Bit Kingdom | 270p, a 16-colour palette, dithering | a square ball, chiptune |
| `paper` | Paper Isles | a pop-up book; players are paper cut-outs | clouds on strings |
| `clay` | Clayland | stop-motion plasticine at 12 fps, tilt-shift | a clay court that keeps ball marks |
| `water` | Aquarelle | watercolour (Kuwahara filter, pigment, paper) | hot-air balloons |
| `cosmic` | Starfall | a court on an asteroid | low gravity: the ball floats |

## The two halves: `WorldDef` and `World`

A world exports a **`WorldDef`**, a plain object the menus and the game read without building anything:

```ts
export const NEON: WorldDef = {
  id: 'neon',                       // used in settings, the online stream, tests
  name: 'Neon Drive',
  tagline: 'Rallies at the edge of the night',
  blurb: 'A synthwave sunset, an endless grid and players drawn in light.',
  ui: { accent, accent2, ink, paper, font, display, panel },  // its colours and fonts (the world picker, the match banner)
  song: 'neon',                     // a key of SONGS in src/tv/audio/songs.ts
  surface: 1.03,                    // how fast the ball comes off the court (1 = hard court)
  // gravity: 0.5,                  // optional: Starfall's low gravity (the flow sets COURT.gravity from it)
  make: (r) => new NeonWorld(NEON, r),
};
```

and registers it in **`src/tv/worlds/index.ts`** by adding it to `WORLDS`. That's all the menus,
Kaleydo mode's shuffles and the world picker need: a new entry there shows up everywhere.

`make()` builds the **`World`**: a three.js scene and the passes that draw it. The `Stage`
(`src/tv/render/stage.ts`) owns the live world (two during a Kaleydo shatter) and calls into it.

## What a `World` subclass provides

`World` does almost everything; a subclass fills in the look. Using `src/tv/worlds/neon.ts` as the
example:

### `kit: MaterialKit` (required)

How every character part is drawn in this world. `char(role, color)` returns a material for a role
(`skin`, `shirt`, `hair`, `eye`, `racket`, `strings`…, see `CharRole` in `src/tv/worlds/types.ts`), and
the kit sets the characters' outline (`outline`, `outlineColor`), whether they're flat paper cut-outs
(`flat`) and their shadow. Neon makes bodies dark with a faint glow, eyes and rackets bright HDR
colours, and outlines each player in light in their shirt's hue.

The kit matters beyond tennis: the **bowling alley, duel arena, archery range and ballpark are built
from the same kit** the first time their sport comes to a world (`World.setSport()`), so they match its
style with no extra work. Each venue documents which roles it borrows for what (for example,
`src/tv/bowling/venue.ts`: `racket` for pins and accents, `hair` for the lane wood).

### `build()` (required)

Called once. It sets up the scene with the helpers `World` provides:

- `buildCourt({ inner, outer, line, innerPad, outerSize, lineWidth, wobble? })`: the court from three
  materials.
- `buildNet({ post, mesh, band })`, with `netTexture()` for the mesh.
- `buildBall(material, trailStyle, shadowColor?, shadowOpacity?)`, with `tennisBallTexture()` if you
  want felt and a seam. The trail style sets its colours, width and length.
- `buildParticles({ additive?, fog? })` for hits, bounces and celebrations.
- `addCrowd(new Crowd({...}))` for spectators in stands you build (`src/tv/worlds/crowd.ts`).
- Lights, fog and everything else in the scene: add them to `this.scene`. After `build()`, `init()`
  moves all the scenery into `this.env` and **batches everything static** into a few big meshes, so
  thousands of objects cost dozens of draw calls. Mark anything that moves `userData.noBatch = true`.
  Scenery that only belongs to tennis (an umpire's chair) goes in `this.tennisOnly`; scenery where the
  ballpark goes, in `this.notBaseball`.

Then the look of the frame:

- `this.final.u`: the final pass's uniforms (`uExposure`, `uTonemap`, `uSat`, `uContrast`,
  `uVignette`, `uGrain`, `uAberration`, `uScan`, `uBloom`…), from `src/tv/render/post.ts`.
- `this.bloom = new Bloom(levels)` for glow; `bloomIsLook = true` if the glow is the style (the lowest
  quality tier then keeps a short one instead of dropping it).
- `this.effects`: opt-in lighting and screen effects from `src/tv/render/effects.ts` (sky light, AO,
  sun glare and shafts, colour grade, contact shadows, a fitted sun shadow, depth of field for
  replays). The quality ladder (`src/tv/render/quality.ts`) turns them down on slower machines.
- `this.smashStyle`: the colours and shapes of a smash's fire, sparks, ring and scorch mark.
- `this.flashColor`: the colour the screen flashes on big moments.

### Optional hooks

- `animate(v: FrameView)`: every frame. `FrameView` has the time, the ball, the players' poses, the
  crowd's excitement, the music's `beat` (1 on each beat, decaying), and the state of whichever sport is
  on. Neon pulses its lines, light sticks and bloom on `v.beat`. Note `init()` also calls `animate()` a
  few times with made-up frames before batching, so it must cope with that.
- `fx(e: MatchEvent)`: tennis events (`hit`, `bounce`, `point`…) for world-specific effects. Neon
  bursts neon sparks on hits and draws light rings where the ball bounces; Inkwell splats ink.
- `onDetail(d)`: scale optional scenery (grass, traffic, clouds) to the quality ladder's detail level,
  0..1.
- `onResize(w, h)` and `setFxTier(t)`: for anything sized to the screen or tied to the effects tier
  (Neon's floor reflection).
- `render(cam, target)`: override to add passes. Neon renders its reflection first, then calls
  `super.render()`. A world with its own pipeline (Inkwell's ink pass, Bit Kingdom's palette) should
  call `this.post?.plan(cam)` before drawing and `this.post?.render(...)` after, then draw through
  `this.final`, so the shared effects still work.
- `dispose()`: free what you made beyond the scene (render targets), then `super.dispose()`.

## Adding a world

1. Copy the smallest world that's close to what you want (`cosmic.ts` and `neon.ts` are compact) to
   `src/tv/worlds/<id>.ts`, rename the class and the `WorldDef`, give it a unique `id`.
2. Add it to `WORLDS` in `src/tv/worlds/index.ts`.
3. Give it a song: add an entry to `SONGS` in `src/tv/audio/songs.ts` (a tempo, a scale, a chord
   loop and a few tracks built from the synthesised instruments in `src/tv/audio/engine.ts`) and set
   `song` to its key, or reuse an existing one (Sports Park plays Sunny Plaza's).
4. `npm run dev`, open <http://localhost:3000>, and in the browser console:
   ```js
   kaleido.stage.setWorld('<id>', { transition: true })
   ```
   to shatter into it from wherever you are. Play a match in it, then try every sport (the venues are
   built from your kit), Kaleydo mode, and split screen (the far player's half turns the scenery
   180°: check the backdrop from both ends).
5. Check performance: the frame rate should hold on a laptop with the quality ladder at a middle rung.
   `scripts/perf/` has the measuring tools.
6. Screenshots for the PR: `scripts/shots/world-shots.mjs` renders every world from fixed cameras with
   seeded randomness, so two builds can be compared pixel for pixel (`WORLDS=<id>` for just yours).

Keep it all code: no image, model or audio files. A world's character comes from its materials,
shaders and post-processing, which is also what lets every sport's venue take on its style for free.
