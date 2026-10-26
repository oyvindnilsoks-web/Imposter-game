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
    setHero('', 'Imposter', 'Create a game', 'Students scan a QR code to join.');
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
      pill = `<span class="pill${out ? ' out' : ' soft'}">${result.counts[player.id]} ${result.counts[player.id] === 1 ? 'vote' : 'votes'}</span>`;
    } else if (player.eliminated) {
      pill = '<span class="pill out">Out</span>';
    } else if (!player.connected) {
      pill = '<span class="pill soft">Offline</span>';
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
    if (phase === 'lobby') setHero('', `Game ${state.code}`, 'Lobby', 'Waiting for students to scan the QR code.');
    else if (phase === 'ready') setHero('', `Game ${state.code}`, 'The game is on', 'Pick the impostors, then open the vote.');
    else if (phase === 'voting') setHero('orange', `Game ${state.code}`, `Round ${round}`, 'The vote is open.');
    else if (phase === 'result') setHero(result.eliminatedId ? 'sage' : 'orange', `Game ${state.code}`, `Round ${round}`, 'Result');
    else setHero('', `Game ${state.code}`, 'The game is over', 'Thanks for playing!');

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
      $('banner-title').textContent = out ? `${out.name} is out!` : 'Tie';
      $('banner-text').textContent = out
        ? `Got the most votes (${result.counts[out.id]}) and is crossed out.`
        : 'Nobody was voted out this round.';
    }

    // Fremdrift under avstemming
    $('vote-progress').hidden = phase !== 'voting';
    if (phase === 'voting') {
      $('vote-progress-text').textContent = `${state.voteCount} of ${state.activeCount} have voted`;
      $('vote-progress-bar').style.width = `${state.activeCount ? (state.voteCount / state.activeCount) * 100 : 0}%`;
    }

    // Spillerliste
    $('list-title').textContent = 'Players';
    $('list-count').textContent = phase === 'lobby'
      ? `${state.players.length} joined`
      : `${state.activeCount} left of ${state.players.length}`;
    $('players').innerHTML = state.players.map((player, index) => playerRow(player, index, result)).join('');

    // Knapper
    const ended = phase === 'ended';
    $('start-btn').hidden = phase !== 'lobby';
    $('start-btn').disabled = !enoughToStart;
    $('vote-btn').hidden = phase !== 'ready' && phase !== 'result';
    $('vote-btn').textContent = `Start round ${round + 1} vote`;
    $('vote-btn').disabled = !canVote;
    $('close-btn').hidden = phase !== 'voting';
    $('end-btn').hidden = ended;
    $('new-btn').hidden = !ended;

    let hint = '';
    if (phase === 'lobby' && !enoughToStart) hint = `You need at least ${state.minPlayers} players to start (${state.players.length}/${state.minPlayers}).`;
    else if (phase === 'voting') hint = 'The vote closes by itself when everyone has voted.';
    else if ((phase === 'ready' || phase === 'result') && !canVote) hint = 'Not enough players are left for another vote.';
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
    if (confirm('End the game for everyone?')) act('host:end');
  });
  $('new-btn').addEventListener('click', () => {
    clearCreds();
    showCreate();
  });

  showCreate();
})();
