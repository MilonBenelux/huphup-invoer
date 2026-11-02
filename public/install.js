/* "Zet HUPHUP op je beginscherm" — a small banner on phones, shown once the user is signed in.
 *  - iPhone/iPad and Android get their own steps.
 *  - "Gedaan" hides it for good on this phone; "Later" hides it for 7 days.
 *  - Opened from the home-screen icon (start_url /?bron=beginscherm): never shown again.
 *  - /?installeer always shows it (handy link to send to coaches).
 */
(function () {
  const KEY = 'huphup-install';
  const get = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
  const set = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode: just don't remember */ } };

  const q = new URLSearchParams(location.search);
  if (q.get('bron') === 'beginscherm') set({ done: true, via: 'icon' });
  const force = q.has('installeer');

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!(ios || android) || standalone) return;

  const st = get();
  if (!force && (st.done || (st.later && Date.now() < st.later))) return;

  const shareIcon = '<svg width="16" height="18" viewBox="0 0 16 20" aria-hidden="true" style="vertical-align:-3px"><path d="M8 1v12M4 5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 8H2v11h12V8h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  const steps = ios
    ? (/CriOS/.test(ua)
      // Chrome on iPhone/iPad
      ? `<li>Tik op <b>Deel</b> ${shareIcon} naast de adresbalk.</li><li>Kies <b>Zet op beginscherm</b> en tik op <b>Voeg toe</b>.</li>`
      // Safari (and other iOS browsers)
      : `<li>Tik op <b>\u2022\u2022\u2022</b> naast de adresbalk en kies <b>Deel</b> ${shareIcon}.</li><li>Tik op <b>Toon meer</b> en kies <b>Zet op beginscherm</b>.</li><li>Tik op <b>Voeg toe</b>.</li>`)
    : `<li>Tik rechtsboven op <b>\u22ee</b> (Samsung Internet: <b>\u2261</b> onderaan).</li><li>Kies <b>Installeren en snelkoppeling maken</b> en daarna <b>Snelle link maken</b>.</li><li>Zie je dat niet? Kies dan <b>Toevoegen aan startscherm</b>.</li>`;

  const css = `
  #hupInstall{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:50;max-width:520px;margin:0 auto;
    background:#fff;color:#161616;border-radius:18px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:14px 16px 12px;font:14px/1.45 Montserrat,Helvetica,Arial,sans-serif;
    display:grid;grid-template-columns:52px 1fr;gap:4px 12px;transform:translateY(140%);transition:transform .35s ease}
  #hupInstall.show{transform:none}
  #hupInstall img{width:52px;height:52px;border-radius:12px;grid-row:span 2}
  #hupInstall b.t{display:block;font-size:15px}
  #hupInstall ol{margin:4px 0 0;padding-left:18px}
  #hupInstall .btns{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
  #hupInstall button{font:inherit;font-weight:700;border-radius:320px;padding:8px 16px;border:2px solid #7680ff;cursor:pointer}
  #hupInstall .later{background:#fff;color:#7680ff} #hupInstall .done{background:#7680ff;color:#fff}`;

  function show() {
    if (document.getElementById('hupInstall')) return;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    const box = document.createElement('aside');
    box.id = 'hupInstall'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'HUPHUP op je beginscherm zetten');
    box.innerHTML = `<img src="/icons/apple-touch-icon.png" alt="">
      <div><b class="t">Zet HUPHUP op je beginscherm</b>Zo vul je je cijfers in met \u00e9\u00e9n tik.</div>
      <ol>${steps}</ol>
      <div class="btns"><button type="button" class="later">Later</button><button type="button" class="done">Gedaan</button></div>`;
    document.body.appendChild(box);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('show')));
    const close = v => { set(v); box.classList.remove('show'); setTimeout(() => box.remove(), 400); };
    box.querySelector('.later').onclick = () => close({ later: Date.now() + 7 * 24 * 3600 * 1000 });
    box.querySelector('.done').onclick = () => close({ done: true, via: 'button' });
  }

  // Wait until the entry form is visible (signed in), then show it after a short pause.
  function whenSignedIn() {
    const app = document.getElementById('app');
    if (!app) return;
    const go = () => { if (!app.hidden) { obs.disconnect(); setTimeout(show, 1500); } };
    const obs = new MutationObserver(go);
    obs.observe(app, { attributes: true, attributeFilter: ['hidden'] });
    go();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenSignedIn); else whenSignedIn();
})();
