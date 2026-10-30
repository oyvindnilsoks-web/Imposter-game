(() => {
  const STORE_KEY = 'imposter-player';
  const PHOTO_KEY = 'imposter-photo';
  const api = window.ImposterApi;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['join', 'wait', 'vote', 'result'];

  let state = null; // tilstanden fra databasen
  let photos = {}; // spillerens id -> bilde, delt live og aldri lagret
  let selected = null;
  let watcher = null;
  let lastKey = '';
  const seen = new Set();
  let pendingSeen = [];
  let session = loadSession(); // { code, secret, name, playerId } når jeg er med i et spill
  let myPhoto = loadPhoto(); // mitt eget bilde, bare i denne nettleserøkten

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
  function loadPhoto() {
    try {
      const value = sessionStorage.getItem(PHOTO_KEY);
      return api.isPhoto(value) ? value : null;
    } catch {
      return null;
    }
  }
  function savePhoto(value) {
    try { sessionStorage.setItem(PHOTO_KEY, value); } catch { /* privat modus */ }
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
    photos = {};
    lastKey = '';
    selected = null;
    setHero('', 'Join with a code', 'Join the game', 'Enter your name to play.');
    show('join');
    $('join-btn').disabled = !api.isReady;
    $('join-error').textContent = api.isReady ? error : api.NOT_SET_UP;
  }

  // Rader som vises for første gang i en fase eller runde får en liten inngangsanimasjon.
  function isFresh(list, id) {
    const key = `${list}:${state.phase}:${state.round}:${id}`;
    if (seen.has(key)) return false;
    pendingSeen.push(key);
    return true;
  }

  const isImpostor = (player) => Boolean(state.impostorIds && state.impostorIds.includes(player.id));

  function playerRow(player, index, extra = {}) {
    const classes = ['row'];
    if (isFresh(extra.list || 'rows', player.id)) classes.push('fresh');
    if (player.id === state.meId) classes.push('me');
    if (player.eliminated) classes.push('out');
    if (isImpostor(player)) classes.push('imp');
    if (!player.connected && state.phase === 'lobby') classes.push('offline');
    const pill = extra.pill || (isImpostor(player) ? '<span class="pill imp">🎭 Impostor</span>' : '');
    return `<li class="${classes.join(' ')}" style="--i:${index}">
      ${extra.bar ? `<div class="bar" style="width:${extra.bar}%"></div>` : ''}
      <div class="avatar">${avatarHtml(player)}</div>
      <div class="name"><span class="t">${esc(player.name)}</span>${player.id === state.meId ? '<small>You</small>' : ''}</div>
      ${pill}
    </li>`;
  }

  // avatar er ferdig HTML: enten et bilde/emoji fra avatarHtml, eller en fast emoji.
  function showWait({ avatar, title, text, progress, list, count, photoButton }) {
    show('wait');
    $('wait-avatar').innerHTML = avatar;
    $('wait-title').textContent = title;
    $('wait-text').textContent = text;
    // Eleven kan legge til eller bytte bilde mens hen venter (der avataren er hens egen).
    $('wait-photo-btn').hidden = !photoButton;
    $('wait-photo-btn').textContent = myPhoto ? '📷 Change photo' : '📷 Add a photo';

    $('wait-progress').hidden = progress == null;
    if (progress != null) $('wait-progress-bar').style.width = `${progress}%`;

    $('wait-list-wrap').hidden = !list;
    if (list) {
      $('wait-count').textContent = count || `${state.players.length} in`;
      $('wait-list').innerHTML = state.players.map((player, index) => playerRow(player, index, { list })).join('');
    }
  }

  function renderVote(self) {
    show('vote');
    const candidates = state.players.filter((player) => (
      !player.eliminated
      && player.id !== self.id
      && (!state.candidateIds || state.candidateIds.includes(player.id))
    ));
    if (!candidates.some((player) => player.id === selected)) selected = null;

    $('vote-title').textContent = state.inRunoff ? 'Runoff: who is the impostor?' : 'Who is the impostor?';
    $('vote-lead').textContent = state.inRunoff
      ? 'These players had the same number of votes. Pick one.'
      : 'You only have one vote, so choose carefully.';

    $('vote-list').innerHTML = candidates
      .map((player, index) => `<li><button class="row choice${isFresh('vote', player.id) ? ' fresh' : ''}${player.id === selected ? ' selected' : ''}" style="--i:${index}" data-id="${esc(player.id)}">
        <div class="avatar">${avatarHtml(player)}</div>
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
    // I rekkefølgen spillerne ble med, så teksten alltid er lik for alle.
    const tied = state.players.filter((player) => (result.runoffIds || []).includes(player.id));

    $('result-status').className = `status${out && out.id === self.id ? ' alert' : ''}`;
    if (out) {
      $('result-avatar').innerHTML = avatarHtml(out);
      $('result-title').textContent = out.id === self.id ? 'You are out!' : `${out.name} is out!`;
      $('result-text').textContent = out.id === self.id
        ? 'You got the most votes and are out of the game.'
        : 'Most votes. Waiting for the next round.';
    } else if (tied.length) {
      $('result-avatar').textContent = '🤝';
      $('result-title').textContent = 'Tie!';
      $('result-text').textContent = `Next: a runoff vote between ${tied.map((player) => player.name).join(' and ')}.`;
    } else {
      $('result-avatar').textContent = '🤝';
      $('result-title').textContent = 'Tie';
      $('result-text').textContent = 'Nobody was voted out this round.';
    }

    $('result-round').textContent = `Round ${result.round}`;
    const max = Math.max(1, ...Object.values(result.counts));
    $('result-list').innerHTML = state.players
      .filter((player) => player.id in result.counts)
      .sort((a, b) => result.counts[b.id] - result.counts[a.id])
      .map((player, index) => playerRow(player, index, {
        list: 'result',
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
    pendingSeen = [];

    const phase = state.phase;
    const title = `Round ${state.round}`;
    const killedSelf = self.eliminated && (state.killedIds || []).includes(self.id);

    // Hvem som er drept før denne avstemmingen
    const killed = state.players.filter((player) => (state.killedIds || []).includes(player.id));
    $('kill-note').hidden = killed.length === 0 || !['ready', 'voting', 'result'].includes(phase);
    if (killed.length) {
      const names = killed.map((player) => player.name);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      $('kill-note').textContent = `💀 ${who} ${names.length > 1 ? 'were' : 'was'} killed.`;
    }

    if (phase === 'lobby') {
      setHero('', `Game ${state.code}`, "You're in!", `Hi, ${self.name}`);
      showWait({ avatar: avatarHtml(self), title: 'Waiting to start', text: 'Your teacher will start the game soon.', list: 'lobby', photoButton: true });
    } else if (phase === 'ready') {
      setHero('', `Game ${state.code}`, 'The game is on', `Hi, ${self.name}`);
      showWait({
        avatar: avatarHtml(self),
        title: killedSelf ? 'You were killed' : self.eliminated ? 'You are out' : 'The game has started',
        text: self.eliminated ? 'You can watch while the others play.' : 'Your teacher will open the vote.',
        photoButton: true,
      });
    } else if (phase === 'voting') {
      const heroTitle = state.inRunoff ? 'Runoff vote' : 'Vote';
      if (self.eliminated) {
        setHero('orange', title, heroTitle, 'You are out of the game');
        showWait({ avatar: avatarHtml(self), title: killedSelf ? 'You were killed' : 'You are out', text: 'You can watch while the others vote.', progress: pct(), photoButton: true });
      } else if (state.myVote) {
        setHero('orange', title, heroTitle, 'Your vote is in');
        showWait({
          avatar: '🗳️',
          title: 'Vote sent',
          text: `${state.voteCount} of ${state.activeCount} have voted.`,
          progress: pct(),
        });
      } else {
        setHero('orange', title, heroTitle, 'Who do you think is the impostor?');
        renderVote(self);
      }
    } else if (phase === 'result') {
      setHero(state.result.eliminatedId ? 'sage' : 'orange', title, 'Result', self.eliminated ? 'You are out of the game' : 'You are still in');
      renderResult(self);
    } else if (phase === 'over') {
      const crewWon = state.winner === 'crew';
      setHero(crewWon ? 'sage' : 'orange', `Game ${state.code}`, crewWon ? 'Crew wins!' : 'Impostors win!', 'The game is over.');
      showWait({
        avatar: crewWon ? '🏆' : '🕵️',
        title: crewWon ? 'The crew wins!' : 'The impostors win!',
        text: crewWon ? 'All the impostors are out.' : 'The impostors have taken over.',
        list: 'over',
        count: 'The impostors are marked',
      });
    } else {
      setHero('', `Game ${state.code}`, 'The game is over', 'Thanks for playing!');
      showWait({ avatar: '🎉', title: 'Thanks for playing!', text: 'Your teacher has ended the game.' });
    }
    for (const key of pendingSeen) seen.add(key);
    pendingSeen = [];
  }

  // Tegner bare på nytt når noe faktisk har endret seg, så animasjonene ikke starter om igjen.
  function view() {
    if (!state) return;
    const photoKey = Object.entries(photos).map(([id, photo]) => `${id}:${photo.length}`).sort().join(',');
    const key = `${JSON.stringify(state)}|${photoKey}`;
    if (key === lastKey) return;
    lastKey = key;
    if (state.phase !== 'voting') selected = null;
    render();
  }

  function follow() {
    if (watcher) watcher.stop();
    watcher = api.watchGame({ code: session.code, secret: session.secret, presenceKey: session.playerId, photo: myPhoto }, {
      onState(next) {
        state = next;
        view();
      },
      onVotes(count) {
        if (!state) return;
        state = { ...state, voteCount: count };
        // Mens eleven velger, tegner vi ikke listen på nytt (et trykk kan gå tapt).
        if (!$('screen-vote').hidden) return;
        view();
      },
      onPhotos(next) {
        photos = next;
        view();
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
      session = { code: joined.code, secret, name, playerId: joined.playerId };
      saveSession();
      $('join-error').textContent = '';
      follow();
    } catch (error) {
      $('join-error').textContent = error.message;
      $('join-btn').disabled = false;
    }
  }

  // Etter en omlasting: finn plassen din igjen. Ved ukjent spill tømmes økten.
  async function resume() {
    try {
      if (!session.playerId) {
        const joined = await api.rpc('imposter_join_game', { p_code: session.code, p_name: session.name, p_secret: session.secret });
        session.playerId = joined.playerId;
        saveSession();
      }
      follow();
    } catch (error) {
      if (error.gone) clearSession();
      showJoin(error.message);
    }
  }

  // Beskjærer bildet til et lite kvadrat. Det blir bare noen få KB, og lagres ikke på noen server.
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const size = 128;
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(
          image,
          (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side,
          0, 0, size, size,
        );
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read that photo. Try another one.'));
      };
      image.src = url;
    });
  }

  function showPhotoPreview() {
    $('photo-preview').innerHTML = myPhoto ? `<img src="${esc(myPhoto)}" alt="Your photo">` : '📷';
    $('photo-btn').classList.toggle('has-photo', Boolean(myPhoto));
  }

  $('photo-btn').addEventListener('click', () => $('photo-input').click());
  $('wait-photo-btn').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      myPhoto = await shrinkPhoto(file);
      savePhoto(myPhoto);
      showPhotoPreview();
      if (watcher) watcher.setPhoto(myPhoto);
      // Bytt avataren med en gang, uten å vente på at Realtime sender bildet tilbake.
      if (session && session.playerId) {
        photos = { ...photos, [session.playerId]: myPhoto };
        lastKey = '';
        view();
      }
    } catch (error) {
      toast(error.message);
    }
  });

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
    // Vis «Vote sent» med en gang, uten å vente på nettet. Går noe galt, ruller vi tilbake.
    const target = selected;
    const before = state;
    state = { ...state, myVote: target, voteCount: state.voteCount + 1 };
    lastKey = '';
    view();
    try {
      await api.rpc('imposter_cast_vote', { p_code: session.code, p_secret: session.secret, p_target: target });
    } catch (error) {
      state = before;
      lastKey = '';
      view();
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

  showPhotoPreview();
  showJoin();
  if (session && api.isReady) resume();
  if (!session) $('name').focus();
})();
