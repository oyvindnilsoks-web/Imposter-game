(() => {
  const STORE_KEY = 'imposter-host';
  const socket = io();
  const $ = (id) => document.getElementById(id);

  let state = null;
  let info = null; // { code, hostToken, joinUrl, qr }

  function loadCreds() {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || null; } catch { return null; }
  }
  function saveCreds() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ code: info.code, hostToken: info.hostToken })); } catch { /* ignorer */ }
  }
  function clearCreds() {
    info = null;
    state = null;
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignorer */ }
  }

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function setHero(color, eyebrow, title, sub) {
    $('hero').className = `hero ${color}`;
    $('hero-eyebrow').textContent = eyebrow;
    $('hero-title').textContent = title;
    $('hero-sub').textContent = sub;
  }

  function showCreate() {
    $('screen-create').hidden = false;
    $('screen-game').hidden = true;
    setHero('', 'Imposter', 'Lag et spill', 'Elevene scanner en QR-kode for å bli med.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    $('localhost-warn').hidden = !local;
  }

  function act(event) {
    socket.emit(event, {}, (res) => {
      if (!res.ok) toast(res.error);
    });
  }

  function playerRow(player, index, result) {
    const classes = ['row'];
    if (player.eliminated) classes.push('out');
    if (!player.connected && state.phase === 'lobby') classes.push('offline');

    let bar = '';
    let pill = '';
    if (state.phase === 'result' && result && player.id in result.counts) {
      const max = Math.max(1, ...Object.values(result.counts));
      bar = `<div class="bar" style="width:${(result.counts[player.id] / max) * 100}%"></div>`;
      const out = player.id === result.eliminatedId;
      pill = `<span class="pill${out ? ' out' : ' soft'}">${result.counts[player.id]} ${result.counts[player.id] === 1 ? 'stemme' : 'stemmer'}</span>`;
    } else if (player.eliminated) {
      pill = '<span class="pill out">Ute</span>';
    } else if (!player.connected) {
      pill = '<span class="pill soft">Frakoblet</span>';
    }

    return `<li class="${classes.join(' ')}">${bar}
      <div class="num">${String(index + 1).padStart(2, '0')}</div>
      <div class="avatar">${player.avatar}</div>
      <div class="name">${esc(player.name)}</div>${pill}</li>`;
  }

  function render() {
    if (!state || !info) return;
    $('screen-create').hidden = true;
    $('screen-game').hidden = false;

    const { phase, round, result } = state;
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const enoughToStart = state.players.length >= state.minPlayers;
    const canVote = state.activeCount >= 2;

    // Header
    if (phase === 'lobby') setHero('', `Spill ${state.code}`, 'Lobby', 'Venter på at elevene scanner QR-koden.');
    else if (phase === 'ready') setHero('', `Spill ${state.code}`, 'Spillet er i gang', 'Finn impostorene, og åpne så avstemmingen.');
    else if (phase === 'voting') setHero('orange', `Spill ${state.code}`, `Runde ${round}`, 'Avstemmingen er åpen.');
    else if (phase === 'result') setHero(result.eliminatedId ? 'sage' : 'orange', `Spill ${state.code}`, `Runde ${round}`, 'Resultat');
    else setHero('', `Spill ${state.code}`, 'Spillet er over', 'Takk for denne gangen!');

    // QR vises i lobbyen
    $('qr-block').hidden = phase !== 'lobby';
    $('qr-img').src = info.qr;
    $('qr-code').textContent = info.code;
    $('qr-url').textContent = info.joinUrl;

    // Resultat
    $('result-banner').hidden = phase !== 'result';
    if (phase === 'result') {
      const out = result.eliminatedId ? byId.get(result.eliminatedId) : null;
      $('banner-avatar').textContent = out ? out.avatar : '🤝';
      $('banner-title').textContent = out ? `${out.name} er ute!` : 'Uavgjort';
      $('banner-text').textContent = out
        ? `Fikk flest stemmer (${result.counts[out.id]}) og er krysset ut.`
        : 'Ingen ble stemt ut denne runden.';
    }

    // Fremdrift under avstemming
    $('vote-progress').hidden = phase !== 'voting';
    if (phase === 'voting') {
      $('vote-progress-text').textContent = `${state.voteCount} av ${state.activeCount} har stemt`;
      $('vote-progress-bar').style.width = `${state.activeCount ? (state.voteCount / state.activeCount) * 100 : 0}%`;
    }

    // Spillerliste
    $('list-title').textContent = 'Spillere';
    $('list-count').textContent = phase === 'lobby'
      ? `${state.players.length} med`
      : `${state.activeCount} igjen av ${state.players.length}`;
    $('players').innerHTML = state.players.map((player, index) => playerRow(player, index, result)).join('');

    // Knapper
    const ended = phase === 'ended';
    $('start-btn').hidden = phase !== 'lobby';
    $('start-btn').disabled = !enoughToStart;
    $('vote-btn').hidden = phase !== 'ready' && phase !== 'result';
    $('vote-btn').textContent = `Start runde ${round + 1} avstemming`;
    $('vote-btn').disabled = !canVote;
    $('close-btn').hidden = phase !== 'voting';
    $('end-btn').hidden = ended;
    $('new-btn').hidden = !ended;

    let hint = '';
    if (phase === 'lobby' && !enoughToStart) hint = `Trenger minst ${state.minPlayers} spillere for å starte (${state.players.length}/${state.minPlayers}).`;
    else if (phase === 'voting') hint = 'Avstemmingen lukkes av seg selv når alle har stemt.';
    else if ((phase === 'ready' || phase === 'result') && !canVote) hint = 'Det er ikke nok spillere igjen til en ny avstemming.';
    $('action-hint').textContent = hint;
  }

  function adopt(res) {
    info = res;
    saveCreds();
    render();
  }

  function resume(creds) {
    socket.emit('host:resume', { ...creds, baseUrl: location.origin }, (res) => {
      if (!res.ok) {
        clearCreds();
        showCreate();
        return;
      }
      adopt(res);
    });
  }

  socket.on('room:state', (next) => {
    if (info && next.code !== info.code) return;
    state = next;
    render();
  });

  socket.on('connect', () => {
    const creds = info ? { code: info.code, hostToken: info.hostToken } : loadCreds();
    if (creds) resume(creds);
    else showCreate();
  });

  $('create-btn').addEventListener('click', () => {
    $('create-btn').disabled = true;
    socket.emit('host:create', { baseUrl: location.origin }, (res) => {
      $('create-btn').disabled = false;
      if (!res.ok) {
        $('create-error').textContent = res.error;
        return;
      }
      $('create-error').textContent = '';
      adopt(res);
    });
  });

  $('start-btn').addEventListener('click', () => act('host:start'));
  $('vote-btn').addEventListener('click', () => act('host:startVote'));
  $('close-btn').addEventListener('click', () => act('host:closeVote'));
  $('end-btn').addEventListener('click', () => {
    if (confirm('Avslutte spillet for alle?')) act('host:end');
  });
  $('new-btn').addEventListener('click', () => {
    clearCreds();
    showCreate();
  });

  showCreate();
})();
