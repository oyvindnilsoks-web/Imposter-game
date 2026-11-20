(() => {
  const STORE_KEY = 'imposter-player';
  const PHOTO_KEY = 'imposter-photo';
  const api = window.ImposterApi;
  const fx = window.ImposterFx;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['join', 'wait', 'vote', 'night', 'task', 'result'];

  let state = null; // tilstanden fra databasen
  let photos = {}; // spillerens id -> bilde, delt live og aldri lagret
  let selected = null;
  let nightEnd = 0; // når natten slutter, målt på denne enhetens klokke
  let nightMax = 1; // lengste gjenstående tid vi har sett i natten, til fremdriftsstolpen
  let nightNo = 0;
  let series = 0;
  let lastPot = null; // potten sist, for å se at noe blir ødelagt
  let lastOut = null; // hvem som var ute sist, for å se at noen kommer tilbake
  let taskOpen = false; // oppgaveskjermen er åpen
  let task = null; // oppgaven som vises
  let built = []; // ordene eleven har trykket inn (setninger)
  let answering = false;
  let suspectPick = null; // crew: den du mistenker i natt (bare lokalt, sendes aldri)
  let usedIndexes = []; // hvilke ordknapper som er brukt, i samme rekkefølge som built
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
    $('out-note').hidden = true;
    $('role-peek').hidden = true;
    document.body.classList.remove('has-peek');
    hideRole();
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

  const isClue = (player) => Boolean(state.clueIds && state.clueIds.includes(player.id) && !player.eliminated);
  const isDetective = (player) => Boolean(state.detectiveIds && state.detectiveIds.includes(player.id) && !player.eliminated && !isClue(player));
  const susPill = '<span class="pill sus">🕵️ Suspect</span>';
  const isImpostor = (player) => Boolean(state.impostorIds && state.impostorIds.includes(player.id));

  function playerRow(player, index, extra = {}) {
    const classes = ['row'];
    if (isFresh(extra.list || 'rows', player.id)) classes.push('fresh');
    if (player.id === state.meId) classes.push('me');
    if (player.eliminated) classes.push('out');
    if (isImpostor(player)) classes.push('imp');
    if (!player.connected && state.phase === 'lobby') classes.push('offline');
    const pill = extra.pill || (isImpostor(player) ? '<span class="pill imp">🎭 Impostor</span>' : isClue(player) ? '<span class="pill ok">✅ Crew</span>' : isDetective(player) ? susPill : '');
    return `<li class="${classes.join(' ')}" style="--i:${index}">
      ${extra.bar ? `<div class="bar" style="width:${extra.bar}%"></div>` : ''}
      <div class="avatar">${avatarHtml(player)}</div>
      <div class="name"><span class="t">${esc(player.name)}</span>${player.id === state.meId ? '<small>You</small>' : ''}${extra.below || ''}</div>
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
      // De som er igjen ligger øverst.
      const ordered = [...state.players].sort((a, b) => Number(a.eliminated) - Number(b.eliminated));
      $('wait-list').innerHTML = ordered.map((player, index) => playerRow(player, index, { list })).join('');
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
      : state.doubleRound && !self.isImpostorUnknown
        ? 'Double vote! The crew votes count twice this round.'
        : 'You only have one vote, so choose carefully.';

    $('vote-list').innerHTML = candidates
      .map((player, index) => `<li><button class="row choice${isFresh('vote', player.id) ? ' fresh' : ''}${player.id === selected ? ' selected' : ''}" style="--i:${index}" data-id="${esc(player.id)}">
        <div class="avatar">${avatarHtml(player)}</div>
        <div class="name">${esc(player.name)}</div>
        ${isClue(player) ? '<span class="pill ok">✅ Crew</span>' : isDetective(player) ? susPill : ''}
        <span class="radio"></span>
      </button></li>`)
      .join('');
    $('vote-btn').disabled = !selected;
  }

  // Vote reveal (nivå 5): hvem som stemte på hvem i runden som er ferdig.
  function votersOf(player) {
    if (!state.votes) return '';
    const byId = new Map(state.players.map((p) => [p.id, p]));
    const chips = state.votes
      .filter((vote) => vote.targetId === player.id)
      .map((vote) => byId.get(vote.voterId))
      .filter(Boolean)
      .map((voter) => `<span class="voter"><span class="avatar">${avatarHtml(voter)}</span>${esc(voter.name)}</span>`)
      .join('');
    return chips ? `<small class="voters">${chips}</small>` : '';
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
        below: votersOf(player),
      }))
      .join('');
  }

  // Oppdrag og kort for impostorene. Bare impostorer ser natt-skjermen, så dette er privat.
  const MISSIONS = {
    vote_hit: 'Vote for a crew member who then gets voted out.',
    night_kill: 'Pick the player who is killed in the night.',
    survive: 'Stay in the game for 2 votes.',
  };
  const CARDS = {
    double_kill: ['💀💀 Double kill', 'The next night kill takes two players.'],
    break_shield: ['💥 Break shield', "Removes the crew's shield."],
    steal: ['🕳️ Steal points', 'Takes points from the team pot.'],
  };

  function renderMission() {
    const box = $('mission-box');
    const mission = state.mission;
    const card = state.card;
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const mates = (state.mates || []).map((id) => (byId.get(id) || {}).name).filter(Boolean);
    const team = `<div class="team-line">🎭 ${mates.length ? `Your team: ${esc(mates.join(', '))}` : 'You are the only impostor.'}</div>`;
    box.hidden = false;
    if (card) {
      const [title, text] = CARDS[card] || [card, ''];
      box.innerHTML = `<strong>🃏 Your card</strong><div class="mission-text">${esc(title)}</div><div>${esc(text)}</div><button type="button" class="btn orange" id="card-btn">Use it now</button>${team}`;
    } else if (mission) {
      const percent = (mission.progress / mission.goal) * 100;
      box.innerHTML = `<strong>🎯 Your secret mission</strong><div class="mission-text">${esc(MISSIONS[mission.type] || mission.type)}</div><div class="mission-bar"><div style="width:${percent}%"></div></div><div>${mission.progress} of ${mission.goal}. Finish it to get a card.</div>${team}`;
    } else {
      box.innerHTML = `<strong>🎯 Your secret mission</strong><div class="mission-text">Waiting for a new mission.</div>${team}`;
    }
  }

  function renderNight(self) {
    show('night');
    const mates = new Set(state.mates || []);
    const picks = state.nightPicks || {};
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const targets = state.players.filter((player) => !player.eliminated && player.id !== self.id && !mates.has(player.id));

    // Hvem har valgt hvem. De som har fått flest valg ligger øverst, ellers i den vanlige rekkefølgen.
    const pickers = new Map(); // mål -> impostorene som har valgt det
    for (const [impostor, target] of Object.entries(picks)) {
      if (!pickers.has(target)) pickers.set(target, []);
      pickers.get(target).push(impostor);
    }
    const votesFor = (player) => (pickers.get(player.id) || []).length;
    const order = new Map(targets.map((player, index) => [player.id, index]));
    const sorted = [...targets].sort((a, b) => votesFor(b) - votesFor(a) || order.get(a.id) - order.get(b.id));

    // Hvor mange som må være enige: mer enn halvparten av impostorene som er med.
    const alive = 1 + (state.mates || []).filter((id) => byId.get(id) && !byId.get(id).eliminated).length;
    const need = Math.floor(alive / 2) + 1;
    const top = sorted.length ? votesFor(sorted[0]) : 0;
    const leader = top > 0 ? sorted[0] : null;
    const status = $('night-status');
    status.className = `night-status${top >= need ? ' agreed' : ''}`;
    if (top >= need) status.textContent = `✅ ${leader.name} has ${top} of ${alive} votes. The night ends when everyone has chosen.`;
    else if (top > 0) status.textContent = `No majority yet. ${need} of ${alive} must pick the same player. ${leader.name} has ${top}.`;
    else status.textContent = 'Tap a player to suggest who to kill.';

    renderMission();
    $('night-lead').textContent = 'Tap a player. You can change your mind. If most of you pick the same player, that player is out. If you do not agree, nobody is killed.';

    $('night-list').innerHTML = sorted.map((player, index) => {
      const who = (pickers.get(player.id) || []).map((id) => (id === self.id ? { you: true } : byId.get(id))).filter(Boolean);
      const count = who.length;
      const chips = who.map((voter) => (voter.you
        ? '<span class="voter you">You</span>'
        : `<span class="voter"><span class="avatar">${avatarHtml(voter)}</span>${esc(voter.name)}</span>`)).join('');
      const classes = ['row', 'choice'];
      if (isFresh('night', player.id)) classes.push('fresh');
      if (picks[self.id] === player.id) classes.push('selected');
      if (count) classes.push('voted');
      if (count >= need) classes.push('majority');
      return `<li><button class="${classes.join(' ')}" style="--i:${index}" data-id="${esc(player.id)}">
        <div class="avatar">${avatarHtml(player)}</div>
        <div class="name">${esc(player.name)}${count ? `<small class="voters">${chips}</small>` : ''}</div>
        ${count ? `<span class="pill vote-count">${count} ${count === 1 ? 'vote' : 'votes'}</span>` : ''}
        <span class="radio"></span>
      </button></li>`;
    }).join('');
    tickNight();
  }

  // Crew ser nesten den samme skjermen som impostorene om natten, så ingen kan se på en telefon hvem som er impostor.
  // Valget til crew er bare et notat til deg selv. Det sendes aldri, og påvirker ingenting.
  function renderNightCrew(self) {
    show('night');
    $('night-lead').textContent = 'Tap a player you suspect. Only you can see your pick. Earn points for the team while you wait.';
    const status = $('night-status');
    status.className = 'night-status';
    status.textContent = 'This is only for you. Nobody else sees who you pick.';
    const pot = state.pot;
    const next = pot ? pot.goals[Math.min(pot.level, pot.goals.length - 1)] : 1;
    const percent = pot ? Math.min(100, (pot.points / next) * 100) : 0;
    const box = $('mission-box');
    box.hidden = false;
    box.innerHTML = `<strong>🎯 Your task</strong><div class="mission-text">Earn points for the team.</div><div class="mission-bar"><div style="width:${percent}%"></div></div><div>Solve English tasks to fill the pot.</div><button type="button" class="btn orange" id="crew-task-btn">Earn points</button>`;
    const others = state.players.filter((player) => !player.eliminated && player.id !== self.id);
    if (!others.some((player) => player.id === suspectPick)) suspectPick = null;
    $('night-list').innerHTML = others.map((player, index) => `<li><button class="row choice${isFresh('night', player.id) ? ' fresh' : ''}${suspectPick === player.id ? ' selected' : ''}" style="--i:${index}" data-id="${esc(player.id)}">
      <div class="avatar">${avatarHtml(player)}</div>
      <div class="name">${esc(player.name)}${isClue(player) ? ' <small class="voters"><span class="voter">✅ Crew</span></small>' : ''}</div>
      <span class="radio"></span>
    </button></li>`).join('');
    tickNight();
  }

  // Nedtellingen går for seg selv, uten at siden tegnes på nytt.
  function tickNight() {
    if (!state || state.phase !== 'night') return;
    const left = Math.max(0, Math.ceil((nightEnd - Date.now()) / 1000));
    const percent = Math.min(100, (left / nightMax) * 100);
    $('night-time').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('night-bar').style.width = `${percent}%`;
    $('wait-progress-bar').style.width = `${percent}%`;
    if (left === 0 && watcher) watcher.refresh();
  }
  setInterval(tickNight, 500);

  function pct() {
    return state.activeCount ? (state.voteCount / state.activeCount) * 100 : 0;
  }

  // Effekter når noe skjer live. Første tegning (for eksempel etter en omlasting) spilles ikke av.
  const played = new Set();
  let effectsReady = false;
  function once(key, play) {
    if (played.has(key)) return;
    played.add(key);
    if (effectsReady) play();
  }

  function playEffects(self, killed) {
    const { phase, result } = state;
    const byId = new Map(state.players.map((player) => [player.id, player]));

    for (const player of killed) {
      once(`kill-${state.code}-${player.id}`, () => fx.kill({
        avatar: avatarHtml(player),
        title: player.id === self.id ? 'You were killed' : `${player.name} was killed`,
      }));
    }
    const pot = state.pot;
    const names = (ids) => (ids || []).map((id) => (byId.get(id) || {}).name).filter(Boolean).join(', ');
    const LEVEL_TEXT = {
      1: () => { const clue = byId.get((state.clueIds || [])[0]); return clue ? `🔎 Clue! ${clue.name} is crew.` : '🔎 Clue unlocked'; },
      2: () => '🛡️ Shield ready. The next kill will fail.',
      3: () => `🕵️ Detective! At least one impostor is among: ${names(state.detectiveIds)}.`,
      4: () => '💚 Revive ready. The next crew member who goes out comes back.',
      5: () => '🗳️ Vote reveal! Now you can see who voted for whom.',
      6: () => '⚖️ Double vote ready. Crew votes count twice in the next vote.',
    };
    for (let level = 1; pot && level <= pot.level && level <= 6; level++) {
      if (level === 3 && !state.detectiveIds) continue;
      once(`level${level}-${state.code}`, () => fx.banner(LEVEL_TEXT[level]()));
    }
    // Noen har ødelagt noe fra potten
    if (lastPot && pot) {
      if (lastPot.shield && !pot.shield && !(state.nightResult && state.nightResult.shielded)) fx.banner('💥 The shield was broken!');
      if (pot.points < lastPot.points) fx.banner('🕳️ Someone stole points from the pot!');
    }
    lastPot = pot ? { shield: pot.shield, points: pot.points } : null;
    if (phase === 'voting' && state.doubleRound) once(`double-${state.code}-${state.round}`, () => fx.banner('⚖️ Double vote! Crew votes count twice.'));
    if (['ready', 'result'].includes(phase) && state.nightResult && state.nightResult.shielded) {
      once(`shield-${state.code}-${state.nightResult.night}`, () => fx.banner('🛡️ The shield saved someone!'));
    }
    if (phase === 'night') once(`night-${state.code}-${state.night.no}`, () => fx.banner('🌙 Night falls'));
    if (['ready', 'result'].includes(phase) && state.nightResult && !state.nightResult.killedId && !state.nightResult.shielded) {
      once(`morning-${state.code}-${state.nightResult.night}`, () => fx.banner('☀️ Morning. Nobody was killed.'));
    }
    if (phase === 'voting') {
      once(`vote-${state.code}-${state.round}`, () => fx.banner(state.inRunoff ? '⚔️ Runoff vote!' : '🗳️ Time to vote!'));
    }
    if ((phase === 'result' || phase === 'over') && result) {
      once(`result-${state.code}-${result.round}`, () => {
        const out = result.eliminatedId ? byId.get(result.eliminatedId) : null;
        const tied = state.players.filter((player) => (result.runoffIds || []).includes(player.id) && !player.eliminated);
        if (out) fx.reveal({ avatars: [avatarHtml(out)], title: out.id === self.id ? 'You are out!' : `${out.name} is out!`, text: 'Most votes' });
        else if (tied.length >= 2) fx.reveal({ avatars: tied.map((player) => avatarHtml(player)), title: 'Tie!', text: 'A runoff vote is next' });
        else fx.reveal({ avatars: ['🤝'], title: 'Tie', text: 'Nobody was voted out' });
      });
    }
    if (phase === 'over') once(`over-${state.code}`, () => fx.confetti({ dark: state.winner !== 'crew' }));
  }

  function render() {
    const self = state && state.players.find((player) => player.id === state.meId);
    if (!self) {
      // Læreren har fjernet deg, eller spillet har ikke deg. Du kan melde deg på igjen.
      clearSession();
      return showJoin('You are not in this game. You can join again, or ask your teacher.');
    }
    // Ny runde med de samme spillerne: effektene og inngangsanimasjonene starter på nytt.
    if (state.series !== series) {
      series = state.series;
      played.clear();
      seen.clear();
      lastOut = null;
      lastPot = null;
    }
    pendingSeen = [];

    const phase = state.phase;
    const title = `Round ${state.round}`;
    const killedSelf = self.eliminated && (state.killedIds || []).includes(self.id);

    // Hvem som er drept før denne avstemmingen
    const killed = state.players.filter((player) => (state.killedIds || []).includes(player.id));
    const quietNight = Boolean(state.nightResult && !state.nightResult.killedId);
    const quietText = state.nightResult && state.nightResult.shielded ? '🛡️ The shield saved someone last night.' : '☀️ Nobody was killed last night.';
    $('kill-note').hidden = !(killed.length || quietNight) || !['ready', 'voting', 'result'].includes(phase);
    if (killed.length) {
      const names = killed.map((player) => player.name);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      $('kill-note').textContent = `💀 ${who} ${names.length > 1 ? 'were' : 'was'} killed.${quietNight ? ` ${quietText}` : ''}`;
    } else if (quietNight) {
      $('kill-note').textContent = quietText;
    }
    // Noen er tilbake i spillet
    const outNow = new Set(state.players.filter((player) => player.eliminated).map((player) => player.id));
    if (effectsReady && lastOut) {
      const back = state.players.filter((player) => lastOut.has(player.id) && !outNow.has(player.id));
      if (back.length) {
        fx.banner(back.some((player) => player.id === self.id)
          ? '💚 You are back in the game!'
          : `💚 ${back.map((player) => player.name).join(' and ')} ${back.length > 1 ? 'are' : 'is'} back!`);
      }
    }
    lastOut = outNow;
    playEffects(self, killed);
    // De som er ute får en lenke til Glosemester, mens spillet pågår
    $('out-note').hidden = !(self.eliminated && ['ready', 'night', 'voting', 'result'].includes(phase));

    // Knappen for å se rollen sin finnes når læreren har lagret impostorene
    const canPeek = Boolean(state.myRole) && ['ready', 'night', 'voting', 'result'].includes(phase);
    $('role-peek').hidden = !canPeek;
    document.body.classList.toggle('has-peek', canPeek);
    if (!canPeek) hideRole();
    if (state.myRole) once(`roles-${state.code}`, () => fx.banner('🎭 Roles are ready. Hold the button: blue = crew, red = impostor.'));

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
    } else if (phase === 'night') {
      setHero('night', `Night ${state.night.no}`, 'Night', self.eliminated ? 'You are out of the game' : 'Stay quiet');
      if (state.myRole === 'impostor' && !self.eliminated) {
        renderNight(self);
      } else if (state.myRole === 'crew' && !self.eliminated) {
        renderNightCrew(self);
      } else {
        showWait({
          avatar: '🌙',
          title: 'Night falls',
          text: self.eliminated ? 'You can watch while the others play.' : 'Close your eyes and stay quiet. The impostors are choosing.',
          progress: 100,
          photoButton: true,
        });
        tickNight();
      }
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
    // Det felles potten og oppgavene
    const showPot = Boolean(state.pot) && ['ready', 'night', 'voting', 'result'].includes(phase);
    $('pot').hidden = !showPot || taskOpen;
    $('pot').innerHTML = showPot ? fx.potHtml(state.pot) : '';
    if (taskOpen && !state.canTask) closeTask();
    $('task-btn').hidden = !state.canTask || taskOpen || !$('screen-night').hidden;
    if (taskOpen) {
      $('task-pot').innerHTML = fx.potHtml(state.pot);
      show('task');
    }
    effectsReady = true;
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
        if (next.night) {
          // Tiden går for seg selv, så den hører ikke med i tilstanden som sammenlignes.
          if (next.night.no !== nightNo) { nightNo = next.night.no; nightMax = 1; }
          nightEnd = Date.now() + next.night.endsIn * 1000;
          nightMax = Math.max(nightMax, next.night.endsIn);
          next = { ...next, night: { no: next.night.no } };
        }
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

  // ---- Oppgaver
  function closeTask() {
    taskOpen = false;
    task = null;
    lastKey = '';
    view();
  }

  async function loadTask() {
    answering = false;
    built = [];
    $('task-feedback').textContent = '';
    $('task-feedback').className = 'task-feedback';
    $('task-next').hidden = true;
    $('task-prompt').textContent = 'Loading...';
    // Fjern det forrige svaret med en gang, så man ikke kan trykke på en gammel oppgave mens neste hentes.
    $('task-options').innerHTML = '';
    $('task-built').hidden = true;
    $('task-check').hidden = true;
    try {
      task = await api.rpc('imposter_next_task', { p_code: session.code, p_secret: session.secret });
    } catch (error) {
      toast(error.message);
      return closeTask();
    }
    drawTask();
  }

  function drawTask() {
    $('task-prompt').textContent = task.prompt;
    const order = task.kind === 'order';
    $('task-built').hidden = !order;
    $('task-check').hidden = !order;
    if (order) {
      $('task-built').innerHTML = built.map((word, index) => `<button type="button" class="chip" data-built="${index}">${esc(word)}</button>`).join('');
      $('task-options').className = 'task-bank';
      $('task-options').innerHTML = task.options
        .map((word, index) => `<button type="button" class="chip" data-index="${index}" ${usedIndexes.includes(index) ? 'hidden' : ''}>${esc(word)}</button>`)
        .join('');
      $('task-check').disabled = built.length !== task.options.length || answering;
    } else {
      $('task-options').className = 'list grid';
      $('task-options').innerHTML = task.options.map((option) => `<button type="button" class="row choice" data-option="${esc(option)}"><div class="name">${esc(option)}</div></button>`).join('');
    }
  }

  async function sendAnswer(text) {
    if (answering || !task) return;
    answering = true;
    $('task-check').disabled = true;
    try {
      const result = await api.rpc('imposter_answer_task', { p_code: session.code, p_secret: session.secret, p_task: task.id, p_answer: text });
      const box = $('task-feedback');
      if (result.correct) {
        box.className = 'task-feedback good';
        box.textContent = result.capped ? '✅ Right! You have given the most points you can this round.' : '✅ Right!';
      } else {
        box.className = 'task-feedback bad';
        box.textContent = `❌ The answer is: ${result.answer}`;
      }
      for (const el of $('task-options').querySelectorAll('.choice')) {
        el.disabled = true;
        if (el.dataset.option === result.answer) el.classList.add('right');
        else if (el.dataset.option === text) el.classList.add('wrong');
      }
      $('task-next').hidden = false;
      if (watcher) watcher.refresh();
    } catch (error) {
      toast(error.message);
      answering = false;
      if (/not open|Tasks are open/i.test(error.message)) closeTask();
    }
  }

  $('task-btn').addEventListener('click', () => {
    taskOpen = true;
    usedIndexes = [];
    lastKey = '';
    view();
    loadTask();
  });
  $('task-back').addEventListener('click', closeTask);
  $('task-next').addEventListener('click', () => { usedIndexes = []; loadTask(); });
  $('task-options').addEventListener('click', (event) => {
    if (!task || answering) return;
    const choice = event.target.closest('[data-option]');
    if (choice) return void sendAnswer(choice.dataset.option);
    const word = event.target.closest('[data-index]');
    if (word) {
      const index = Number(word.dataset.index);
      usedIndexes.push(index);
      built.push(task.options[index]);
      drawTask();
    }
  });
  $('task-built').addEventListener('click', (event) => {
    if (!task || answering) return;
    const chip = event.target.closest('[data-built]');
    if (!chip) return;
    const position = Number(chip.dataset.built);
    built.splice(position, 1);
    usedIndexes.splice(position, 1);
    drawTask();
  });
  $('task-check').addEventListener('click', () => sendAnswer(built.join(' ')));

  $('photo-btn').addEventListener('click', () => $('photo-input').click());
  $('wait-photo-btn').addEventListener('click', () => $('photo-input').click());

  // Rollen vises bare mens knappen holdes inne, så ingen ser den over skulderen.
  // Rollen vises bare som en liten farge mens knappen holdes inne: blå er crew, rød er impostor.
  // Teksten er skjult for skjermlesere. Impostorene ser lagkameratene sine på natt-skjermen.
  function showRole() {
    if (!state || !state.myRole) return;
    const sheet = $('role-sheet');
    const byId = new Map(state.players.map((player) => [player.id, player]));
    const mates = (state.mates || []).map((id) => (byId.get(id) || {}).name).filter(Boolean);
    const label = state.myRole === 'impostor'
      ? `You are an IMPOSTOR. ${mates.length ? `Your team: ${mates.join(', ')}.` : 'You are the only impostor.'}`
      : 'You are CREW.';
    sheet.innerHTML = `<span class="sr-only">${esc(label)}</span>`;
    sheet.className = `role-sheet ${state.myRole}`;
    sheet.hidden = false;
  }

  function hideRole() {
    const sheet = $('role-sheet');
    sheet.hidden = true;
    sheet.innerHTML = '';
  }

  const peek = $('role-peek');
  peek.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try { peek.setPointerCapture(event.pointerId); } catch { /* ikke alle nettlesere */ }
    showRole();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) peek.addEventListener(type, hideRole);
  peek.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideRole(); });
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

  $('mission-box').addEventListener('click', async (event) => {
    if (event.target.closest('#crew-task-btn')) return $('task-btn').click();
    if (!event.target.closest('#card-btn')) return;
    event.target.disabled = true;
    try {
      await api.rpc('imposter_use_card', { p_code: session.code, p_secret: session.secret });
      toast('Card used.');
    } catch (error) {
      toast(error.message);
    }
    watcher.refresh();
  });

  $('night-list').addEventListener('click', async (event) => {
    const button = event.target.closest('.choice');
    if (!button || !state || state.phase !== 'night') return;
    const target = button.dataset.id;
    // Crew: bare et notat til deg selv. Ingenting sendes.
    if (state.myRole !== 'impostor') {
      suspectPick = target;
      for (const el of $('night-list').querySelectorAll('.choice')) el.classList.toggle('selected', el === button);
      return;
    }
    const before = state;
    // Vis valget med en gang. Går noe galt, ruller vi tilbake.
    state = { ...state, nightPicks: { ...(state.nightPicks || {}), [state.meId]: target } };
    lastKey = '';
    view();
    try {
      await api.rpc('imposter_night_pick', { p_code: session.code, p_secret: session.secret, p_target: target });
    } catch (error) {
      state = before;
      lastKey = '';
      view();
      toast(error.message);
    }
    watcher.refresh();
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

  fx.setupFullscreen($('fs-btn'));
  fx.keepAwake();
  showPhotoPreview();
  showJoin();
  if (session && api.isReady) resume();
  if (!session) $('name').focus();
})();
