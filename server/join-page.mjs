// The page the TV's QR code opens: http://<lan-ip>:3000/join
//
// iPhones only give motion sensors to secure (https) pages, and our https is
// signed by a certificate authority made on this Mac, so Safari calls it "not
// private" until the phone trusts that CA. This plain-http page makes that
// painless: it first checks whether the phone already trusts us (a CORS fetch
// to the https port only succeeds if the certificate is trusted) and if so
// goes straight to the remote. If not, it walks the player through the
// one-time setup (download the profile, install it, turn on full trust), or
// lets them skip it and tap through Safari's warning instead.
//
// Self-contained on purpose: no scripts or styles from elsewhere, so the only
// things the LAN can reach over plain http are this page, the profile and the
// certificate (see server.mjs).

import crypto from 'node:crypto';

/** The page, and a Content-Security-Policy that lets only its own script run and only talk to https. */
export function joinPage({ httpsPort, caName }) {
  const hash = crypto.createHash('sha256').update(JS).digest('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'connect-src https:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html: page({ httpsPort, caName }), csp };
}

function page({ httpsPort, caName }) {
  const cfg = JSON.stringify({ httpsPort, caName }).replace(/</g, '\\u003c');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0b12">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<title>Join Kaleydo World</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON)}">
<style>${CSS}</style>
</head>
<body>
<main>
  <div class="logo" aria-label="KALEIDO">${'KALEIDO'.split('').map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>

  <section id="checking" class="card center on" aria-live="polite">
    <div class="spinner"></div>
    <h1>Connecting…</h1>
    <p class="muted">Finding the game on your Mac</p>
  </section>

  <section id="ok" class="card center" aria-live="polite">
    <div class="tick big">${CHECK}</div>
    <h1>You’re all set</h1>
    <p class="muted">Opening your remote…</p>
  </section>

  <section id="setup">
    <div class="card intro">
      <h1>One-time setup</h1>
      <p>So Safari trusts the game running on your Mac. It takes about a minute, and you only do it once on this phone.</p>
      <p class="why">Why? Your phone’s motion sensors only work on secure pages, and this game’s security certificate was made on your Mac, not bought from a company.</p>
    </div>

    <p class="warn" id="notSafari" hidden>Setup only works in <b>Safari</b>. <a id="openSafari" href="#">Open this page in Safari</a>, or copy the address into it.</p>

    <ol class="steps">
      <li class="step" id="s1">
        <i class="n">1</i>
        <div>
          <h2>Download the profile</h2>
          <p>Tap the button, then <b>Allow</b>, then <b>Close</b>.</p>
          <a class="btn" id="dl" href="/kaleido.mobileconfig">${DOWNLOAD}<span>Download profile</span></a>
        </div>
      </li>
      <li class="step" id="s2">
        <i class="n">2</i>
        <div>
          <h2>Install it</h2>
          <p>Open <b>Settings</b> → <b>General</b> → <b>VPN &amp; Device Management</b> → <b>KALEIDO Local CA</b> → <b>Install</b>.</p>
          <p class="small">Or tap <b>Profile Downloaded</b> at the top of Settings. Enter your passcode and tap <b>Install</b> again. It says “Not Verified”: that’s expected, it was made on your Mac.</p>
        </div>
      </li>
      <li class="step" id="s3">
        <i class="n">3</i>
        <div>
          <h2>Turn on trust</h2>
          <p><b>Settings</b> → <b>General</b> → <b>About</b> → <b>Certificate Trust Settings</b> (at the very bottom) → turn on <b>KALEIDO Local CA</b> → <b>Continue</b>.</p>
          <p class="small">Its full name is “${esc(caName)}”.</p>
        </div>
      </li>
    </ol>

    <p class="warn" id="notYet" hidden role="status">Not trusted yet. Check step 3 (the switch must be green), then tap Continue again.</p>
    <button class="btn primary" id="cont"><span>Continue</span></button>
    <button class="btn ghost" id="skip"><span>Skip for now</span></button>
    <p class="small center-text">Come back to this page any time to finish setting up.</p>
  </section>

  <section id="skipped" class="card">
    <h1>Skip the setup</h1>
    <p>Safari will say <b>“This Connection Is Not Private”</b>. That’s expected.</p>
    <ol class="mini">
      <li>Tap <b>Show Details</b></li>
      <li>Tap <b>visit this website</b></li>
      <li>Tap <b>Visit Website</b></li>
    </ol>
    <p class="small" id="androidNote" hidden>On Android: tap <b>Advanced</b> → <b>Proceed</b>.</p>
    <a class="btn primary" id="go" href="#"><span>Open the remote</span></a>
    <button class="btn ghost" id="back"><span>Set it up instead</span></button>
  </section>

  <footer><a href="/kaleido-ca.crt">Certificate file</a> · for Android and computers</footer>
</main>
<script id="cfg" type="application/json">${cfg}</script>
<script>${JS}</script>
</body>
</html>`;
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 4 58 19v26L32 60 6 45V19z" fill="#8a7dff"/><circle cx="32" cy="32" r="9" fill="#d8ff3a" stroke="#fff" stroke-width="3"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOWNLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const CSS = `
:root{--bg:#0c0b12;--card:rgba(255,255,255,.07);--line:rgba(255,255,255,.12);--pc:#8a7dff;--ok:#3ee08f;--warn:#ffc53d;
  --ui:ui-rounded,'SF Pro Rounded',system-ui,-apple-system,sans-serif}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg);color:#fff;font:17px/1.4 var(--ui);-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:radial-gradient(120% 60% at 50% -10%,rgba(138,125,255,.45),transparent 70%),var(--bg)}
main{max-width:460px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 22px) 18px calc(env(safe-area-inset-bottom) + 24px);display:flex;flex-direction:column;gap:14px}
.logo{display:flex;justify-content:center;gap:2px;font-weight:800;font-size:44px;line-height:1;margin:6px 0 4px}
.logo span{color:hsl(calc(var(--i)*48 + 330) 95% 66%);text-shadow:0 3px 0 hsl(calc(var(--i)*48 + 330) 70% 38%)}
h1{margin:0;font-size:26px;line-height:1.15}
h2{margin:0 0 4px;font-size:19px}
p{margin:0}
b{font-weight:700}
a{color:#9fd4ff}
.muted{opacity:.7}
.small{font-size:14px;opacity:.72;margin-top:6px}
.center-text{text-align:center}
section{display:none;flex-direction:column;gap:14px}
section.on{display:flex;animation:in .35s cubic-bezier(.2,1.2,.4,1)}
@keyframes in{from{opacity:0;transform:translateY(10px)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:26px;padding:20px}
.card.center{align-items:center;text-align:center;padding:34px 20px}
.intro{display:flex;flex-direction:column;gap:8px}
.why{font-size:14px;opacity:.65}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.step{display:grid;grid-template-columns:40px 1fr;gap:12px;align-items:start;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:16px 16px 16px 14px}
.step p{font-size:16px}
.n{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-weight:800;font-size:20px;background:var(--pc);box-shadow:0 3px 0 #5a4fd0}
.step.done .n{background:var(--ok);box-shadow:0 3px 0 #1f9a5c;font-size:0}
.step.done .n::after{content:'';width:14px;height:8px;border:solid #0c0b12;border-width:0 0 3.5px 3.5px;transform:translateY(-2px) rotate(-45deg)}
.btn{appearance:none;border:0;font:inherit;color:#fff;display:flex;align-items:center;justify-content:center;gap:10px;min-height:58px;padding:14px 20px;border-radius:20px;font-size:20px;font-weight:700;text-decoration:none;background:rgba(255,255,255,.12);box-shadow:0 4px 0 rgba(0,0,0,.35);transition:transform .08s,box-shadow .08s;cursor:pointer}
.btn:active{transform:translateY(3px);box-shadow:0 1px 0 rgba(0,0,0,.35)}
.btn svg{width:24px;height:24px}
.step .btn{margin-top:12px;background:var(--pc);box-shadow:0 4px 0 #5a4fd0}
.btn.primary{background:linear-gradient(110deg,#f0457a,#f09a1c,#23c486,#3b8ff0,#8a63f0);font-size:22px;min-height:64px;text-shadow:0 2px 0 rgba(0,0,0,.3),0 0 12px rgba(0,0,0,.25)}
.btn.ghost{background:none;box-shadow:none;border:2px solid var(--line);font-size:18px;min-height:54px}
.btn[aria-busy=true]{opacity:.7;pointer-events:none}
.warn{background:rgba(255,197,61,.14);border:1px solid rgba(255,197,61,.4);color:#ffe3a1;border-radius:18px;padding:12px 14px;font-size:15px}
.mini{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px;font-size:18px}
#skipped{gap:14px}
.spinner{width:56px;height:56px;border-radius:50%;background:conic-gradient(var(--pc),transparent 70%);-webkit-mask:radial-gradient(closest-side,transparent 62%,#000 65%);mask:radial-gradient(closest-side,transparent 62%,#000 65%);animation:spin 1s linear infinite;margin-bottom:8px}
@keyframes spin{to{transform:rotate(1turn)}}
.tick{color:#0c0b12;background:var(--ok);border-radius:50%;width:64px;height:64px;display:grid;place-items:center;margin-bottom:8px;animation:pop .4s cubic-bezier(.2,2,.4,1)}
.tick svg{width:34px;height:34px}
@keyframes pop{from{transform:scale(.4)}}
footer{text-align:center;font-size:13px;opacity:.5;margin-top:6px}
`;

const JS = `
(function(){
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var host = location.hostname.indexOf(':') >= 0 ? '[' + location.hostname + ']' : location.hostname;
  var origin = 'https://' + host + ':' + cfg.httpsPort;
  var remote = origin + '/controller.html';
  var $ = function(id){ return document.getElementById(id); };
  var ua = navigator.userAgent;
  var iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var otherBrowser = iOS && /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\\//.test(ua);
  var android = /Android/.test(ua);
  var store = { get: function(k){ try { return localStorage.getItem('kaleido.' + k); } catch (e) { return null; } },
                set: function(k, v){ try { localStorage.setItem('kaleido.' + k, v); } catch (e) {} } };

  function show(id){
    var all = document.querySelectorAll('main > section');
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i].id === id);
    window.scrollTo(0, 0);
  }

  // Trusted? A CORS fetch to the https port only gets through if the phone
  // accepts the certificate (an untrusted one fails the TLS handshake).
  function trusted(ms){
    return new Promise(function(done){
      var ctl = window.AbortController ? new AbortController() : null;
      var t = setTimeout(function(){ if (ctl) ctl.abort(); done(false); }, ms || 3500);
      fetch(origin + '/api/trust?t=' + Date.now(), { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ clearTimeout(t); done(!!(j && j.ok)); })
        .catch(function(){ clearTimeout(t); done(false); });
    });
  }

  function forward(){
    show('ok');
    setTimeout(function(){ location.replace(remote); }, 450);
  }

  $('go').href = remote;
  if (otherBrowser) {
    $('notSafari').hidden = false;
    $('openSafari').href = 'x-safari-' + location.href;
  }
  $('androidNote').hidden = !android;

  // the profile only means something to an iPhone / iPad
  if (!iOS) {
    $('s1').querySelector('p').innerHTML = 'This profile is for iPhone and iPad. On other phones, <b>Skip for now</b>, or install the <a href="/kaleido-ca.crt">certificate file</a> as a CA certificate in your settings.';
  }

  $('dl').addEventListener('click', function(){
    $('s1').classList.add('done');
    store.set('profile', String(Date.now()));
  });
  if (store.get('profile')) $('s1').classList.add('done');

  $('cont').addEventListener('click', function(){
    var b = $('cont');
    b.setAttribute('aria-busy', 'true');
    b.querySelector('span').textContent = 'Checking…';
    $('notYet').hidden = true;
    trusted(4000).then(function(ok){
      b.removeAttribute('aria-busy');
      b.querySelector('span').textContent = 'Continue';
      if (ok) { store.set('trusted', '1'); forward(); }
      else { $('notYet').hidden = false; $('notYet').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
  });
  $('skip').addEventListener('click', function(){ store.set('skipped', '1'); show('skipped'); });
  $('back').addEventListener('click', function(){ show('setup'); });

  // coming back from Settings: check again by itself
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState !== 'visible' || !$('setup').classList.contains('on')) return;
    trusted(2500).then(function(ok){ if (ok) forward(); });
  });

  trusted(3500).then(function(ok){
    if (ok) return forward();
    // chose to skip before (and never set it up): straight to the tap-through note
    show(store.get('skipped') && !store.get('profile') && !location.search.match(/setup/) ? 'skipped' : 'setup');
  });
})();
`;
