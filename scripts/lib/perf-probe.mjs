// Page-side probe for the perf scripts: shader programs that got built (or rebuilt) after
// the probe went in — each one is a driver stall the first time it draws. Install it once the
// game is on screen and settled (`await tv.evaluate(programProbe)`), then read the report
// with `await tv.evaluate(programReport)`.
export function programProbe() {
  const k = window.kaleido;
  const r = k.renderer;
  const seen = new Set(r.info.programs.map((p) => p.id));
  const t00 = performance.now();
  window.__newProgs = [];
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    const t0 = performance.now();
    orig(now);
    const dt = performance.now() - t0;
    for (const p of r.info.programs)
      if (!seen.has(p.id)) {
        seen.add(p.id);
        // who uses it? (a material somewhere in the scenes on screen)
        let who = '';
        for (const w of k.stage.shown)
          w.scene.traverse((o) => {
            const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
            for (const m of ms) if (!who && r.properties.get(m).currentProgram === p) who = `${m.type}${m.name ? ':' + m.name : ''} on ${o.name || o.type}${o.parent?.name ? ' in ' + o.parent.name : ''}`;
          });
        window.__newProgs.push({ t: +((performance.now() - t00) / 1000).toFixed(1), ms: +dt.toFixed(1), who: `${who || `pass ${p.cacheKey.slice(0, 60)}`} [${p.cacheKey.replace(/false,/g, 'f,').slice(-90)}]`, world: k.stage.current?.def.id, sport: k.sport });
      }
  };
}
export function programReport() {
  return (window.__newProgs || []).map((p) => `t=${p.t}s ${p.who} (${p.world}/${p.sport}, frame ${p.ms} ms)`);
}
