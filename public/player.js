(() => {
  const STORE_KEY = 'imposter-player';
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['join', 'wait', 'vote', 'result'];

  let state = null; // felles romtilstand fra serveren
  let myVote = null; // min egen stemme (kun jeg får vite den)
  let selected = null;
  let session = loadSession(); // { code, playerId, name } når jeg er med i et spill

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

  // crypto.randomUUID finnes ikke på http://<ip>, så vi bruker getRandomValues.
  function newPlayerId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

  function playerRow(player, extra = {}) {
    const classes = ['row'];
    if (player.id === session?.playerId) classes.push('me');
    if (player.eliminated) classes.push('out');
    if (!player.connected && state.phase === 'lobby') classes.push('offline');
    return `<li class="${classes.join(' ')}">
      ${extra.bar ? `<div class="bar" style="width:${extra.bar}%"></div>` : ''}
      <div class="avatar">${player.avatar}</div>
      <div class="name">${esc(player.name)}${player.id === session?.playerId ? '<small>You</small>' : ''}</div>
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

  function render() {
    if (!session || !state) return show('join');
    const self = state.players.find((player) => player.id === session.playerId);
    if (!self) return show('join');

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
      } else if (myVote) {
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

  function pct() {
    return state.activeCount ? (state.voteCount / state.activeCount) * 100 : 0;
  }

  function join(code, name, playerId, { silent = false } = {}) {
    // Serveren sender romtilstanden før kvitteringen, så økten må være satt på forhånd.
    session = { code, playerId, name };
    socket.emit('player:join', { code, name, playerId }, (res) => {
      if (!res.ok) {
        // Ved automatisk gjenkobling skal en død økt bare ryddes bort.
        clearSession();
        state = null;
        setHero('', 'Imposter', 'Join the game', 'Enter your name to play.');
        show('join');
        $('join-btn').disabled = false;
        if (!silent) $('join-error').textContent = res.error;
        else toast(res.error);
        return;
      }
      session = { code: res.code, playerId, name };
      saveSession();
      render();
      $('join-error').textContent = '';
    });
  }

  socket.on('room:state', (next) => {
    if (!session || next.code !== session.code) return;
    state = next;
    if (state.phase !== 'voting') { myVote = null; selected = null; }
    render();
  });

  socket.on('player:me', (me) => {
    if (session && me.playerId === session.playerId) myVote = me.myVote;
  });

  // Etter nettverksbrudd får vi ny socket, så vi melder oss inn igjen med samme spiller-id.
  socket.on('connect', () => {
    if (session) join(session.code, session.name, session.playerId, { silent: true });
  });

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('code').value.trim().toUpperCase();
    const name = $('name').value.trim();
    if (code.length !== 4) return void ($('join-error').textContent = 'The game code has 4 characters.');
    if (!name) return void ($('join-error').textContent = 'Please enter your name.');
    $('join-error').textContent = '';
    const previous = session && session.code === code ? session.playerId : null;
    join(code, name, previous || newPlayerId());
  });

  $('vote-list').addEventListener('click', (event) => {
    const button = event.target.closest('.choice');
    if (!button) return;
    selected = button.dataset.id;
    for (const el of $('vote-list').querySelectorAll('.choice')) el.classList.toggle('selected', el === button);
    $('vote-btn').disabled = false;
  });

  $('vote-btn').addEventListener('click', () => {
    if (!selected) return;
    $('vote-btn').disabled = true;
    socket.emit('player:vote', { targetId: selected }, (res) => {
      if (!res.ok) {
        toast(res.error);
        $('vote-btn').disabled = false;
      }
    });
  });

  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('code').value = urlCode.toUpperCase().slice(0, 4);
  if (session && urlCode && session.code !== urlCode.toUpperCase()) clearSession();
  if (session) $('name').value = session.name;
  if (!$('code').value && session) $('code').value = session.code;
  show('join');
  $('name').focus();
})();
