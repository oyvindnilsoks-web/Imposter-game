(() => {
  const STORE_KEY = 'imposter-host';
  const api = window.ImposterApi;
  const fx = window.ImposterFx;
  const $ = (id) => document.getElementById(id);

  let state = null;
  let photos = {}; // spillerens id -> bilde, delt live og aldri lagret
  let info = null; // { code, secret, joinUrl, qr }
  let watcher = null;
  let lastKey = '';
  let picker = { open: false, shown: false, draft: new Set() }; // impostor-dialogen, skjult til læreren trykker Show
  let killer = { open: false, target: null }; // dialogen for hvem som ble drept
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
    closePicker();
    closeKiller();
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

  function playerRow(player, index, { result, showImpostors }) {
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

    return `<li class="${classes.join(' ')}" style="--i:${index}">${inner}</li>`;
  }

  // Effekter når noe skjer live (på tavla). Første tegning, for eksempel etter en omlasting, spilles ikke av.
  const played = new Set();
  let effectsReady = false;
  function once(key, play) {
    if (played.has(key)) return;
    played.add(key);
    if (effectsReady) play();
  }

  function playEffects(killed) {
    const { phase, result } = state;
    const byId = new Map(state.players.map((player) => [player.id, player]));

    for (const player of killed) {
      once(`kill-${state.code}-${player.id}`, () => fx.kill({ avatar: avatarHtml(player), title: `${player.name} was killed` }));
    }
    if ((phase === 'result' || phase === 'over') && result) {
      once(`result-${state.code}-${result.round}`, () => {
        const out = result.eliminatedId ? byId.get(result.eliminatedId) : null;
        const tied = state.players.filter((player) => (result.runoffIds || []).includes(player.id) && !player.eliminated);
        if (out) fx.reveal({ avatars: [avatarHtml(out)], title: `${out.name} is out!`, text: `Got the most votes (${result.counts[out.id]})` });
        else if (tied.length >= 2) fx.reveal({ avatars: tied.map((player) => avatarHtml(player)), title: 'Tie!', text: 'A runoff vote is next' });
        else fx.reveal({ avatars: ['🤝'], title: 'Tie', text: 'Nobody was voted out' });
      });
    }
    if (phase === 'over') once(`over-${state.code}`, () => fx.confetti({ dark: state.winner !== 'crew' }));
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
    // I rekkefølgen spillerne ble med, så teksten alltid er lik for alle.
    let tied = result && result.runoffIds ? state.players.filter((player) => result.runoffIds.includes(player.id) && !player.eliminated) : [];
    if (tied.length < 2) tied = []; // en drept spiller kan ha tatt plassen i omavstemmingen

    // Impostorene vises aldri på hovedskjermen før spillet er slutt. De velges i en egen, skjult dialog.
    const showImpostors = phase === 'over';

    const validPick = impostorIds.length >= 1 && impostorIds.length < state.players.length - impostorIds.length;
    const enoughToStart = state.players.length >= state.minPlayers;
    const canVote = state.activeCount >= 2 && (phase !== 'ready' || validPick);

    // Header
    if (phase === 'lobby') setHero('', `Game ${state.code}`, 'Lobby', 'Waiting for students to scan the QR code.');
    else if (phase === 'ready') setHero('', `Game ${state.code}`, 'The game is on', 'Pick the impostors in secret, then open the vote.');
    else if (phase === 'voting') setHero('orange', `Game ${state.code}`, state.inRunoff ? `Round ${round} · Runoff` : `Round ${round}`, 'The vote is open.');
    else if (phase === 'result') setHero(result.eliminatedId ? 'sage' : 'orange', `Game ${state.code}`, `Round ${round}`, 'Result');
    else if (phase === 'over') setHero(crewWon ? 'sage' : 'orange', `Game ${state.code}`, crewWon ? 'Crew wins!' : 'Impostors win!', 'The game is over.');
    else setHero('', `Game ${state.code}`, 'The game has ended', 'Thanks for playing!');

    // Hvem som er drept før denne avstemmingen
    const killed = state.players.filter((player) => (state.killedIds || []).includes(player.id));
    $('kill-note').hidden = killed.length === 0 || !['ready', 'voting', 'result'].includes(phase);
    if (killed.length) {
      const names = killed.map((player) => player.name);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      $('kill-note').textContent = `💀 ${who} ${names.length > 1 ? 'were' : 'was'} killed.`;
    }
    playEffects(killed);

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
    $('list-title').textContent = 'Players';
    $('list-count').textContent = phase === 'lobby' || phase === 'ready'
      ? `${state.players.length} joined`
      : `${state.activeCount} left of ${state.players.length}`;
    $('players').innerHTML = state.players
      .map((player, index) => playerRow(player, index, { result, showImpostors }))
      .join('');

    // Knapper
    const finished = phase === 'ended' || phase === 'over';
    $('start-btn').hidden = phase !== 'lobby';
    $('start-btn').disabled = !enoughToStart;
    $('vote-btn').hidden = phase !== 'ready' && phase !== 'result';
    $('vote-btn').textContent = tied.length && phase === 'result' ? 'Start runoff vote' : `Start round ${round + 1} vote`;
    $('vote-btn').disabled = !canVote;
    $('close-btn').hidden = phase !== 'voting';
    $('imp-btn').hidden = phase !== 'ready';
    $('imp-btn').textContent = validPick ? 'Change impostors' : 'Pick impostors';
    $('imp-btn').classList.toggle('secondary', validPick);
    $('kill-btn').hidden = !((phase === 'ready' && validPick) || phase === 'result');
    $('end-btn').hidden = finished;
    $('new-btn').hidden = !finished;

    let hint = '';
    if (phase === 'lobby' && !enoughToStart) hint = `You need at least ${state.minPlayers} players to start (${state.players.length}/${state.minPlayers}).`;
    else if (phase === 'ready') {
      hint = validPick
        ? `${impostorIds.length} ${impostorIds.length === 1 ? 'impostor' : 'impostors'} saved. They are not shown on this screen. Players can now hold a button on their own screen to see their role.`
        : 'Pick the impostors first. Nobody else will see them.';
    } else if (phase === 'voting') hint = 'The vote closes by itself when everyone has voted.';
    else if (phase === 'result' && !canVote) hint = 'Not enough players are left for another vote.';
    $('action-hint').textContent = hint;

    effectsReady = true;
    for (const key of pendingSeen) seen.add(key);
    pendingSeen = [];
  }

  // Tegner bare på nytt når noe faktisk har endret seg, så animasjonene ikke starter om igjen.
  function view() {
    if (!state || !info) return;
    const photoKey = Object.entries(photos).map(([id, photo]) => `${id}:${photo.length}`).sort().join(',');
    const key = `${JSON.stringify(state)}|${photoKey}`;
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
      onVotes(count) {
        if (!state) return;
        state = { ...state, voteCount: count };
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

  // Dialog for å velge impostorer. Innholdet er sløret til læreren trykker Show, og valget
  // sendes først når læreren trykker Save. Ingenting av det vises på hovedskjermen.
  function validDraft() {
    const count = picker.draft.size;
    return count >= 1 && count < state.players.length - count;
  }

  function renderPicker() {
    $('imp-modal').hidden = !picker.open;
    if (!picker.open || !state) return;
    $('imp-stage').classList.toggle('blurred', !picker.shown);
    $('imp-show').hidden = picker.shown;
    $('imp-hide').hidden = !picker.shown;
    // Før Show tegnes ingen valg, så ingenting kan skimtes gjennom uskarpheten.
    $('imp-list').innerHTML = state.players.map((player, index) => {
      const marked = picker.shown && picker.draft.has(player.id);
      return `<li><button type="button" class="row pick${marked ? ' imp' : ''}" style="--i:${index}" data-id="${esc(player.id)}" tabindex="${picker.shown ? 0 : -1}">
        <div class="avatar">${avatarHtml(player)}</div>
        <div class="name"><span class="t">${esc(player.name)}</span></div>
        ${marked ? '<span class="pill imp">🎭 Impostor</span>' : ''}</button></li>`;
    }).join('');
    const count = picker.draft.size;
    if (!picker.shown) $('imp-hint').textContent = '';
    else if (count === 0) $('imp-hint').textContent = 'Tap the players who are the impostors.';
    else if (validDraft()) $('imp-hint').textContent = `${count} picked. Tap Save when you are done.`;
    else $('imp-hint').textContent = 'There must be more crew than impostors.';
    $('imp-save').disabled = !picker.shown || !validDraft();
  }

  function openPicker() {
    picker = { open: true, shown: false, draft: new Set((state && state.impostorIds) || []) };
    renderPicker();
  }

  function closePicker() {
    picker = { open: false, shown: false, draft: new Set() };
    $('imp-modal').hidden = true;
  }

  $('imp-btn').addEventListener('click', openPicker);
  $('imp-show').addEventListener('click', () => {
    picker.shown = true;
    renderPicker();
  });
  $('imp-hide').addEventListener('click', () => {
    picker.shown = false;
    renderPicker();
  });
  $('imp-cancel').addEventListener('click', closePicker);
  $('imp-list').addEventListener('click', (event) => {
    const button = event.target.closest('.pick');
    if (!button || !picker.shown) return;
    const id = button.dataset.id;
    if (picker.draft.has(id)) picker.draft.delete(id);
    else picker.draft.add(id);
    renderPicker();
  });
  $('imp-save').addEventListener('click', async () => {
    if (!validDraft()) return;
    $('imp-save').disabled = true;
    try {
      await api.rpc('imposter_set_impostors', { p_code: info.code, p_host_secret: info.secret, p_ids: [...picker.draft] });
      closePicker();
    } catch (error) {
      toast(error.message);
      renderPicker();
    }
    if (watcher) watcher.refresh();
  });

  // Dialog for å markere hvem som ble drept før avstemmingen. Navnet er ikke hemmelig, siden alle får se det.
  function renderKiller() {
    $('kill-modal').hidden = !killer.open;
    if (!killer.open || !state) return;
    $('kill-list').innerHTML = state.players
      .filter((player) => !player.eliminated)
      .map((player, index) => `<li><button type="button" class="row pick${killer.target === player.id ? ' imp' : ''}" style="--i:${index}" data-id="${esc(player.id)}">
        <div class="avatar">${avatarHtml(player)}</div>
        <div class="name"><span class="t">${esc(player.name)}</span></div>
        ${killer.target === player.id ? '<span class="pill imp">💀 Killed</span>' : ''}</button></li>`)
      .join('');
    $('kill-confirm').disabled = !killer.target;
  }

  function openKiller() {
    killer = { open: true, target: null };
    renderKiller();
  }

  function closeKiller() {
    killer = { open: false, target: null };
    $('kill-modal').hidden = true;
  }

  $('kill-btn').addEventListener('click', openKiller);
  $('kill-cancel').addEventListener('click', closeKiller);
  $('kill-list').addEventListener('click', (event) => {
    const button = event.target.closest('.pick');
    if (!button) return;
    killer.target = button.dataset.id;
    renderKiller();
  });
  $('kill-confirm').addEventListener('click', async () => {
    if (!killer.target) return;
    $('kill-confirm').disabled = true;
    try {
      await api.rpc('imposter_kill_player', { p_code: info.code, p_host_secret: info.secret, p_player: killer.target });
      closeKiller();
    } catch (error) {
      toast(error.message);
      renderKiller();
    }
    if (watcher) watcher.refresh();
  });

  $('start-btn').addEventListener('click', () => act('imposter_start_game'));
  $('vote-btn').addEventListener('click', () => act('imposter_start_vote'));
  $('close-btn').addEventListener('click', () => act('imposter_close_vote'));
  $('end-btn').addEventListener('click', () => {
    if (confirm('End the game for everyone?')) act('imposter_end_game');
  });
  $('new-btn').addEventListener('click', () => {
    clearCreds();
    showCreate();
  });

  fx.setupFullscreen($('fs-btn'));
  fx.keepAwake();
  showCreate();
  const saved = loadCreds();
  if (saved && api.isReady) adopt(saved.code, saved.secret);
})();
