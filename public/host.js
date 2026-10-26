(() => {
  const STORE_KEY = 'imposter-host';
  const api = window.ImposterApi;
  const $ = (id) => document.getElementById(id);

  let state = null;
  let photos = {}; // spillerens id -> bilde, delt live og aldri lagret
  let info = null; // { code, secret, joinUrl, qr }
  let watcher = null;
  let lastKey = '';
  let lastPhase = null;
  let reveal = false; // vis impostorene mens avstemmingen pågår (iPaden kan være speilet på tavla)
  let picking = false;
  const seen = new Set();
  let pendingSeen = [];

  function loadCreds() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
  }
  function saveCreds() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ code: info.code, secret: info.secret })); } catch { /* ignorer */ }
  }
  function clearCreds() {
    if (watcher) watcher.stop();
    watcher = null;
    info = null;
    state = null;
    photos = {};
    lastKey = '';
    lastPhase = null;
    reveal = false;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignorer */ }
  }

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Bildet hvis spilleren har delt et, ellers emoji-avataren.
  function avatarHtml(player) {
    const photo = photos[player.id];
    return photo ? `<img src="${esc(photo)}" alt="">` : esc(player.avatar);
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

  function showCreate(error = '') {
    $('screen-create').hidden = false;
    $('screen-game').hidden = true;
    setHero('', 'Teacher view', 'Create a game', 'Students scan a QR code to join.');
    $('setup-warn').hidden = api.isReady;
    $('create-btn').disabled = !api.isReady;
    $('create-error').textContent = error;
  }

  function makeQr(url) {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }).replace('fill="black"', 'fill="#3A211B"');
  }

  async function act(fn) {
    try {
      await api.rpc(fn, { p_code: info.code, p_host_secret: info.secret });
    } catch (error) {
      toast(error.message);
    }
    if (watcher) watcher.refresh();
  }

  // Rader som vises for første gang i en fase eller runde får en liten inngangsanimasjon.
  function isFresh(id) {
    const key = `${state.phase}:${state.round}:${id}`;
    if (seen.has(key)) return false;
    pendingSeen.push(key);
    return true;
  }

  function playerRow(player, index, { result, pickable, showImpostors }) {
    const impostor = showImpostors && (state.impostorIds || []).includes(player.id);
    const classes = ['row'];
    if (isFresh(player.id)) classes.push('fresh');
    if (player.eliminated) classes.push('out');
    if (impostor) classes.push('imp');
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
    if (impostor) pill += '<span class="pill imp">🎭 Impostor</span>';

    const inner = `${bar}
      <div class="num">${String(index + 1).padStart(2, '0')}</div>
      <div class="avatar">${avatarHtml(player)}</div>
      <div class="name"><span class="t">${esc(player.name)}</span></div>${pill}`;

    if (pickable) {
      return `<li><button type="button" class="${classes.join(' ')} pick" style="--i:${index}" data-id="${esc(player.id)}">${inner}</button></li>`;
    }
    return `<li class="${classes.join(' ')}" style="--i:${index}">${inner}</li>`;
  }

  function render() {
    if (!state || !info) return;
    pendingSeen = [];
    $('screen-create').hidden = true;
    $('screen-game').hidden = false;

    const { phase, round, result } = state;
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const impostorIds = state.impostorIds || [];
    const crewWon = state.winner === 'crew';
    const tied = result && result.runoffIds ? result.runoffIds.map((id) => byId.get(id)).filter(Boolean) : [];

    // Impostorene skjules som standard når avstemmingen er i gang, men vises mens du velger og når spillet er slutt.
    if (phase !== lastPhase) {
      if (phase === 'voting' && lastPhase === 'ready') reveal = false;
      lastPhase = phase;
    }
    const showImpostors = phase === 'ready' || phase === 'over' || reveal;

    const validPick = impostorIds.length >= 1 && impostorIds.length < state.players.length - impostorIds.length;
    const enoughToStart = state.players.length >= state.minPlayers;
    const canVote = state.activeCount >= 2 && (phase !== 'ready' || validPick);

    // Header
    if (phase === 'lobby') setHero('', `Game ${state.code}`, 'Lobby', 'Waiting for students to scan the QR code.');
    else if (phase === 'ready') setHero('', `Game ${state.code}`, 'The game is on', 'Tap the impostors, then open the vote.');
    else if (phase === 'voting') setHero('orange', `Game ${state.code}`, state.inRunoff ? `Round ${round} · Runoff` : `Round ${round}`, 'The vote is open.');
    else if (phase === 'result') setHero(result.eliminatedId ? 'sage' : 'orange', `Game ${state.code}`, `Round ${round}`, 'Result');
    else if (phase === 'over') setHero(crewWon ? 'sage' : 'orange', `Game ${state.code}`, crewWon ? 'Crew wins!' : 'Impostors win!', 'The game is over.');
    else setHero('', `Game ${state.code}`, 'The game has ended', 'Thanks for playing!');

    // QR vises i lobbyen
    $('qr-block').hidden = phase !== 'lobby';
    $('qr-img').innerHTML = info.qr;
    $('qr-code').textContent = info.code;
    $('qr-url').textContent = info.joinUrl;

    // Resultat og vinner
    $('result-banner').hidden = phase !== 'result' && phase !== 'over';
    if (phase === 'result') {
      const out = result.eliminatedId ? byId.get(result.eliminatedId) : null;
      $('banner-avatar').innerHTML = out ? avatarHtml(out) : '🤝';
      if (out) {
        $('banner-title').textContent = `${out.name} is out!`;
        $('banner-text').textContent = `Got the most votes (${result.counts[out.id]}) and is crossed out.`;
      } else if (tied.length) {
        $('banner-title').textContent = 'Tie!';
        $('banner-text').textContent = `Next: a runoff vote between ${tied.map((player) => player.name).join(' and ')}.`;
      } else {
        $('banner-title').textContent = 'Tie';
        $('banner-text').textContent = 'Nobody was voted out this round.';
      }
    } else if (phase === 'over') {
      $('banner-avatar').textContent = crewWon ? '🏆' : '🕵️';
      $('banner-title').textContent = crewWon ? 'The crew wins!' : 'The impostors win!';
      $('banner-text').textContent = crewWon ? 'All the impostors are out.' : 'The impostors have taken over.';
    }

    // Fremdrift under avstemming
    $('vote-progress').hidden = phase !== 'voting';
    if (phase === 'voting') {
      $('vote-progress-text').textContent = `${state.voteCount} of ${state.activeCount} have voted`;
      $('vote-progress-bar').style.width = `${state.activeCount ? (state.voteCount / state.activeCount) * 100 : 0}%`;
    }

    // Spillerliste
    $('list-title').textContent = phase === 'ready' ? 'Who are the impostors?' : 'Players';
    $('list-count').textContent = phase === 'lobby'
      ? `${state.players.length} joined`
      : phase === 'ready'
        ? `${impostorIds.length} picked`
        : `${state.activeCount} left of ${state.players.length}`;
    $('players').innerHTML = state.players
      .map((player, index) => playerRow(player, index, { result, pickable: phase === 'ready', showImpostors }))
      .join('');

    // Knapper
    const finished = phase === 'ended' || phase === 'over';
    $('start-btn').hidden = phase !== 'lobby';
    $('start-btn').disabled = !enoughToStart;
    $('vote-btn').hidden = phase !== 'ready' && phase !== 'result';
    $('vote-btn').textContent = tied.length && phase === 'result' ? 'Start runoff vote' : `Start round ${round + 1} vote`;
    $('vote-btn').disabled = !canVote;
    $('close-btn').hidden = phase !== 'voting';
    $('reveal-btn').hidden = !(phase === 'voting' || phase === 'result') || impostorIds.length === 0;
    $('reveal-btn').textContent = reveal ? 'Hide impostors' : 'Show impostors';
    $('end-btn').hidden = finished;
    $('new-btn').hidden = !finished;

    let hint = '';
    if (phase === 'lobby' && !enoughToStart) hint = `You need at least ${state.minPlayers} players to start (${state.players.length}/${state.minPlayers}).`;
    else if (phase === 'ready') {
      if (impostorIds.length === 0) hint = 'Tap the players who are the impostors.';
      else if (!validPick) hint = 'There must be more crew than impostors.';
      else hint = `${impostorIds.length} ${impostorIds.length === 1 ? 'impostor' : 'impostors'} picked. Start the vote when you are ready.`;
    } else if (phase === 'voting') hint = 'The vote closes by itself when everyone has voted.';
    else if (phase === 'result' && !canVote) hint = 'Not enough players are left for another vote.';
    $('action-hint').textContent = hint;

    for (const key of pendingSeen) seen.add(key);
    pendingSeen = [];
  }

  // Tegner bare på nytt når noe faktisk har endret seg, så animasjonene ikke starter om igjen.
  function view() {
    if (!state || !info) return;
    const photoKey = Object.entries(photos).map(([id, photo]) => `${id}:${photo.length}`).sort().join(',');
    const key = `${JSON.stringify(state)}|${photoKey}|${reveal}`;
    if (key === lastKey) return;
    lastKey = key;
    render();
  }

  function follow() {
    if (watcher) watcher.stop();
    watcher = api.watchGame({ code: info.code, secret: null, hostSecret: info.secret }, {
      onState(next) {
        state = next;
        view();
      },
      onPhotos(next) {
        photos = next;
        view();
      },
      onGone() {
        clearCreds();
        showCreate('That game is gone. You can create a new one.');
      },
    });
  }

  function adopt(code, secret) {
    const joinUrl = `${location.origin}/?code=${code}`;
    info = { code, secret, joinUrl, qr: makeQr(joinUrl) };
    saveCreds();
    follow();
  }

  $('create-btn').addEventListener('click', async () => {
    $('create-btn').disabled = true;
    try {
      const secret = api.newSecret();
      const code = await api.rpc('imposter_create_game', { p_host_secret: secret });
      $('create-error').textContent = '';
      adopt(code, secret);
    } catch (error) {
      $('create-error').textContent = error.message;
    }
    $('create-btn').disabled = !api.isReady;
  });

  // Trykk på en spiller for å merke eller fjerne impostor. Visningen oppdateres med en gang.
  $('players').addEventListener('click', async (event) => {
    const button = event.target.closest('.pick');
    if (!button || picking || !state) return;
    picking = true;
    const chosen = new Set(state.impostorIds || []);
    if (chosen.has(button.dataset.id)) chosen.delete(button.dataset.id);
    else chosen.add(button.dataset.id);
    state.impostorIds = [...chosen];
    view();
    try {
      await api.rpc('imposter_set_impostors', { p_code: info.code, p_host_secret: info.secret, p_ids: [...chosen] });
    } catch (error) {
      toast(error.message);
    }
    picking = false;
    watcher.refresh();
  });

  $('start-btn').addEventListener('click', () => act('imposter_start_game'));
  $('vote-btn').addEventListener('click', () => act('imposter_start_vote'));
  $('close-btn').addEventListener('click', () => act('imposter_close_vote'));
  $('reveal-btn').addEventListener('click', () => {
    reveal = !reveal;
    view();
  });
  $('end-btn').addEventListener('click', () => {
    if (confirm('End the game for everyone?')) act('imposter_end_game');
  });
  $('new-btn').addEventListener('click', () => {
    clearCreds();
    showCreate();
  });

  showCreate();
  const saved = loadCreds();
  if (saved && api.isReady) adopt(saved.code, saved.secret);
})();
