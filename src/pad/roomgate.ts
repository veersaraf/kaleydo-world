// In the cloud a remote joins its TV's room. The QR code carries the room
// (/c?room=CODE); someone who typed the address instead is asked for the code the
// TV shows. (On a Mac's own server there are no rooms: nothing to ask.)

const params = new URLSearchParams(location.search);

if (!params.get('room')) {
  void fetch('/api/info', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j?.cloud) askRoom();
    })
    .catch(() => {});
}

function askRoom() {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;background:linear-gradient(160deg,#1d1b3a,#2b1840);font-family:Fredoka,system-ui,sans-serif;color:#fff';
  wrap.innerHTML = `
    <form style="width:min(340px,100%);display:flex;flex-direction:column;gap:14px;text-align:center">
      <img src="/brand/lockup-small.png" alt="Kaleydo World" style="display:block;width:180px;height:auto;margin:0 auto" />
      <div style="opacity:.75;font-size:16px">Enter the room code on the TV</div>
      <input name="room" autocomplete="off" autocapitalize="characters" inputmode="text" maxlength="8" placeholder="ABCDE"
        style="font:700 34px Fredoka,system-ui,sans-serif;letter-spacing:.3em;text-align:center;text-transform:uppercase;padding:14px;border-radius:16px;border:2px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;outline:none" />
      <button style="font:700 20px Fredoka,system-ui,sans-serif;padding:14px;border:0;border-radius:16px;background:linear-gradient(90deg,#ff5a8a,#ffb13d);color:#fff">Join</button>
    </form>`;
  document.body.append(wrap);
  const form = wrap.querySelector('form')!;
  const input = wrap.querySelector('input')!;
  input.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return;
    const q = new URLSearchParams(location.search);
    q.set('room', code);
    location.search = q.toString();
  });
}
