## What this changes

<!-- What a player or a developer will notice, and why. Link the issue if there is one. -->

## How it was tested

<!-- The checks you ran, and anything tried by hand (which phone, which browser, local or online). -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run test:sims` / `test:e2e` / `test:cloud` pass, if the change touches what they cover
- [ ] Rules unchanged when a new mode is off (the sims' event hashes match)
- [ ] Tried on a real phone, if it touches the remote, motion detection or latency
- [ ] New protocol fields are optional (an older phone or guest TV still works)
- [ ] No new image, model or audio files
- [ ] Docs updated if players or contributors need to know
- [ ] Screenshots or a short clip, for anything visual
