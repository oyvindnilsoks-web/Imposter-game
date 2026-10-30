// Effekter og små hjelpere: avsløring av hvem som er ute, drap, konfetti, fullskjerm og skjerm som ikke slukner.
// Ingenting her blokkerer knapper, og alt slås av for de som har «reduser bevegelse» på.
window.ImposterFx = (() => {
  const reduceMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Effektene spilles av etter hverandre, så de aldri kolliderer.
  const queue = [];
  let playing = false;

  function next() {
    const step = queue.shift();
    if (!step) {
      playing = false;
      return;
    }
    playing = true;
    step.play();
    setTimeout(next, step.ms);
  }

  function enqueue(play, ms) {
    if (reduceMotion()) return;
    queue.push({ play, ms });
    if (!playing) next();
  }

  function overlay(className, html, ms) {
    const el = document.createElement('div');
    el.className = `fx-overlay ${className}`;
    el.innerHTML = html;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('leaving'), ms - 350);
    setTimeout(() => el.remove(), ms);
  }

  // Avatarene er ferdig HTML fra siden (bilde eller emoji). Tittel og tekst er vanlig tekst.
  function reveal({ avatars, title, text }) {
    const faces = avatars.map((avatar) => `<div class="fx-avatar">${avatar}</div>`).join('<div class="fx-vs">VS</div>');
    enqueue(() => overlay('fx-reveal', `<div class="fx-card"><div class="fx-faces">${faces}</div><div class="fx-title">${esc(title)}</div><div class="fx-text">${esc(text)}</div></div>`, 3200), 3200);
  }

  function kill({ avatar, title }) {
    enqueue(() => overlay('fx-kill', `<div class="fx-card"><div class="fx-skull">💀</div><div class="fx-faces"><div class="fx-avatar">${avatar}</div></div><div class="fx-title">${esc(title)}</div></div>`, 3000), 3000);
  }

  function banner(text) {
    enqueue(() => {
      const el = document.createElement('div');
      el.className = 'fx-banner';
      el.textContent = text;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1800);
    }, 1800);
  }

  // Konfetti i lyse farger, eller færre og mørkere biter når impostorene vinner.
  function confetti({ dark = false } = {}) {
    enqueue(() => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.className = 'fx-confetti';
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);

      const colors = dark ? ['#b5553a', '#3a211b', '#8c7e72', '#e8a13a'] : ['#e8a13a', '#f6c36f', '#5e6e4f', '#cfe0be', '#b5553a', '#ffffff'];
      const pieces = Array.from({ length: dark ? 70 : 150 }, () => ({
        x: Math.random() * width,
        y: -20 - Math.random() * height * 0.6,
        vx: (Math.random() - 0.5) * 3,
        vy: 2 + Math.random() * 4,
        size: 7 + Math.random() * 9,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.3,
        color: colors[Math.floor(Math.random() * colors.length)],
      }));

      const start = performance.now();
      (function frame(now) {
        ctx.clearRect(0, 0, width, height);
        for (const piece of pieces) {
          piece.x += piece.vx;
          piece.y += piece.vy;
          piece.vy += 0.04;
          piece.angle += piece.spin;
          ctx.save();
          ctx.translate(piece.x, piece.y);
          ctx.rotate(piece.angle);
          ctx.fillStyle = piece.color;
          ctx.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
          ctx.restore();
        }
        if (now - start < 5500) requestAnimationFrame(frame);
        else canvas.remove();
      })(start);
    }, 0);
  }

  // Fullskjerm-knapp. Vises bare der nettleseren støtter det og siden ikke allerede er en app.
  function setupFullscreen(button) {
    if (!button) return;
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    if (!request || !exit || standalone) return;
    const active = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    const update = () => {
      button.textContent = active() ? '✕' : '⛶';
      button.setAttribute('aria-label', active() ? 'Exit fullscreen' : 'Fullscreen');
    };
    button.hidden = false;
    update();
    button.addEventListener('click', async () => {
      try {
        if (active()) await exit.call(document);
        else await request.call(root);
      } catch { /* nettleseren sa nei */ }
    });
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
  }

  // Holder skjermen våken mens siden er åpen, så den ikke slukner midt i en runde.
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    let lock = null;
    async function request() {
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch { /* ikke tillatt akkurat nå */ }
    }
    request();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !lock) request();
    });
  }

  return { reveal, kill, banner, confetti, setupFullscreen, keepAwake };
})();
