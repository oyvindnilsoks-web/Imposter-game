(() => {
  const STORE_KEY = 'imposter-player';
  const api = window.ImposterApi;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['join', 'wait', 'vote', 'result'];

  let state = null; // tilstanden fra databasen
  let selected = null;
  let watcher = null;
  let session = loadSession(); // { code, secret, name } når jeg er med i et spill

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
  }
  function saveSession() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch { /* privat modus */ }
  }
  function clearSession() {
    session = null;
    try { localStorage.removeItem(STORE_KEY); } catch { /* privat modus */ }
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

  function show(name) {
    for (const screen of SCREENS) $(`screen-${screen}`).hidden = screen !== name;
  }

  function setHero(color, eyebrow, title, sub) {
    $('hero').className = `hero ${color}`;
    $('hero-eyebrow').textContent = eyebrow;
    $('hero-title').textContent = title;
    $('hero-sub').textContent = sub;
  }

  function showJoin(error = '') {
    if (watcher) watcher.stop();
    watcher = null;
    state = null;
    selected = null;
    setHero('', 'Imposter', 'Join the game', 'Enter your name to play.');
    show('join');
    $('join-btn').disabled = !api.isReady;
    $('join-error').textContent = api.isReady ? error : api.NOT_SET_UP;
  }

  function playerRow(player, extra = {}) {
    const classes = ['row'];
    if (player.id === state.meId) classes.push('me');
    if (player.eliminated) classes.push('out');
    if (!player.connected && state.phase === 'lobby') classes.push('offline');
    return `<li class="${classes.join(' ')}">
      ${extra.bar ? `<div class="bar" style="width:${extra.bar}%"></div>` : ''}
      <div class="avatar">${player.avatar}</div>
      <div class="name">${esc(player.name)}${player.id === state.meId ? '<small>You</small>' : ''}</div>
      ${extra.pill || ''}
    </li>`;
  }

  function showWait({ avatar, title, text, progress, list }) {
    show('wait');
    $('wait-avatar').textContent = avatar;
    $('wait-title').textContent = title;
    $('wait-text').textContent = text;

    $('wait-progress').hidden = progress == null;
    if (progress != null) $('wait-progress-bar').style.width = `${progress}%`;

    $('wait-list-wrap').hidden = !list;
    if (list) {
      $('wait-count').textContent = `${state.players.length} in`;
      $('wait-list').innerHTML = state.players.map((player) => playerRow(player)).join('');
    }
  }

  function renderVote(self) {
    show('vote');
    const candidates = state.players.filter((player) => !player.eliminated && player.id !== self.id);
    if (!candidates.some((player) => player.id === selected)) selected = null;

    $('vote-list').innerHTML = candidates
      .map((player) => `<li><button class="row choice${player.id === selected ? ' selected' : ''}" data-id="${esc(player.id)}">
        <div class="avatar">${player.avatar}</div>
        <div class="name">${esc(player.name)}</div>
        <span class="radio"></span>
      </button></li>`)
      .join('');
    $('vote-btn').disabled = !selected;
  }

  function renderResult(self) {
    show('result');
    const { result } = state;
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const out = result.eliminatedId ? byId.get(result.eliminatedId) : null;

    $('result-status').className = `status${out && out.id === self.id ? ' alert' : ''}`;
    $('result-avatar').textContent = out ? out.avatar : '🤝';
    if (out) {
      $('result-title').textContent = out.id === self.id ? 'You are out!' : `${out.name} is out!`;
      $('result-text').textContent = out.id === self.id
        ? 'You got the most votes and are out of the game.'
        : 'Most votes. Waiting for the next round.';
    } else {
      $('result-title').textContent = 'Tie';
      $('result-text').textContent = 'Nobody was voted out this round.';
    }

    $('result-round').textContent = `Round ${result.round}`;
    const max = Math.max(1, ...Object.values(result.counts));
    $('result-list').innerHTML = state.players
      .filter((player) => player.id in result.counts)
      .sort((a, b) => result.counts[b.id] - result.counts[a.id])
      .map((player) => playerRow(player, {
        bar: (result.counts[player.id] / max) * 100,
        pill: `<span class="pill${player.id === result.eliminatedId ? ' out' : ' soft'}">${result.counts[player.id]}</span>`,
      }))
      .join('');
  }

  function pct() {
    return state.activeCount ? (state.voteCount / state.activeCount) * 100 : 0;
  }

  function render() {
    const self = state && state.players.find((player) => player.id === state.meId);
    if (!self) return showJoin();

    const phase = state.phase;
    const title = `Round ${state.round}`;

    if (phase === 'lobby') {
      setHero('', `Game ${state.code}`, "You're in!", `Hi, ${self.name}`);
      showWait({ avatar: self.avatar, title: 'Waiting to start', text: 'Your teacher will start the game soon.', list: true });
    } else if (phase === 'ready') {
      setHero('', `Game ${state.code}`, 'The game is on', `Hi, ${self.name}`);
      showWait({ avatar: self.avatar, title: 'The game has started', text: 'Your teacher will open the vote.' });
    } else if (phase === 'voting') {
      if (self.eliminated) {
        setHero('orange', title, 'Vote', 'You are out of the game');
        showWait({ avatar: self.avatar, title: 'You are out', text: 'You can watch while the others vote.', progress: pct() });
      } else if (state.myVote) {
        setHero('orange', title, 'Vote', 'Your vote is in');
        showWait({
          avatar: '🗳️',
          title: 'Vote sent',
          text: `${state.voteCount} of ${state.activeCount} have voted.`,
          progress: pct(),
        });
      } else {
        setHero('orange', title, 'Vote', 'Who do you think is the impostor?');
        renderVote(self);
      }
    } else if (phase === 'result') {
      setHero(state.result.eliminatedId ? 'sage' : 'orange', title, 'Result', self.eliminated ? 'You are out of the game' : 'You are still in');
      renderResult(self);
    } else {
      setHero('', `Game ${state.code}`, 'The game is over', 'Thanks for playing!');
      showWait({ avatar: '🎉', title: 'Thanks for playing!', text: 'Your teacher has ended the game.' });
    }
  }

  function follow() {
    if (watcher) watcher.stop();
    watcher = api.watchGame(session, {
      onState(next) {
        state = next;
        if (next.phase !== 'voting') selected = null;
        render();
      },
      onGone() {
        clearSession();
        showJoin('That game is no longer there. Ask your teacher for a new code.');
      },
    });
  }

  async function join(code, name, secret) {
    $('join-btn').disabled = true;
    try {
      const joined = await api.rpc('imposter_join_game', { p_code: code, p_name: name, p_secret: secret });
      session = { code: joined.code, secret, name };
      saveSession();
      $('join-error').textContent = '';
      follow();
    } catch (error) {
      $('join-error').textContent = error.message;
      $('join-btn').disabled = false;
    }
  }

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('code').value.trim().toUpperCase();
    const name = $('name').value.trim();
    if (code.length !== 4) return void ($('join-error').textContent = 'The game code has 4 characters.');
    if (!name) return void ($('join-error').textContent = 'Please enter your name.');
    $('join-error').textContent = '';
    // Samme enhet og samme spill: bruk den gamle nøkkelen, så du får plassen din tilbake.
    const secret = session && session.code === code ? session.secret : api.newSecret();
    join(code, name, secret);
  });

  $('vote-list').addEventListener('click', (event) => {
    const button = event.target.closest('.choice');
    if (!button) return;
    selected = button.dataset.id;
    for (const el of $('vote-list').querySelectorAll('.choice')) el.classList.toggle('selected', el === button);
    $('vote-btn').disabled = false;
  });

  $('vote-btn').addEventListener('click', async () => {
    if (!selected) return;
    $('vote-btn').disabled = true;
    try {
      await api.rpc('imposter_cast_vote', { p_code: session.code, p_secret: session.secret, p_target: selected });
    } catch (error) {
      toast(error.message);
      $('vote-btn').disabled = false;
    }
    watcher.refresh();
  });

  const urlCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase().slice(0, 4);
  if (session && urlCode && session.code !== urlCode) clearSession();

  if (urlCode) $('code').value = urlCode;
  else if (session) $('code').value = session.code;
  if (session) $('name').value = session.name;

  showJoin();
  if (session && api.isReady) follow();
  if (!session) $('name').focus();
})();
