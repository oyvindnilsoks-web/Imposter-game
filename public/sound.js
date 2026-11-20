// Musikk og lydeffekter for lærerskjermen. Alt lages med Web Audio, så det trengs ingen lydfiler.
// Nettlesere vil ikke spille lyd før brukeren har trykket på siden, så lyden starter ved første trykk.
window.ImposterSound = (() => {
  const KEY = 'imposter-sound';
  const LEVELS = [
    { icon: '🔇', volume: 0, label: 'Sound off' },
    { icon: '🔈', volume: 0.35, label: 'Sound low' },
    { icon: '🔊', volume: 0.8, label: 'Sound on' },
  ];

  let level = 2;
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw === null ? NaN : Number(JSON.parse(raw));
    if (Number.isInteger(saved) && saved >= 0 && saved < LEVELS.length) level = saved;
  } catch { /* privat modus */ }

  let ctx = null;
  let master = null;
  let musicBus = null;
  let sfxBus = null;
  let noise = null;
  let mood = null; // humøret vi ønsker, selv før lyden er låst opp
  let timer = null;
  const moodGain = {};
  const hz = (note) => 440 * Math.pow(2, (note - 69) / 12);

  // Hvert humør har et tempo, akkorder (MIDI-toner) og noter til en rolig arpeggio.
  // every er antall halve takter mellom arpeggio-notene. En akkord varer 8 takter.
  const MOODS = {
    day: { bpm: 80, wave: 'triangle', pad: 0.05, arp: 0.07, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], scale: [0, 4, 7, 9, 12, 9, 7, 4], root: 12, every: 2 },
    night: { bpm: 54, wave: 'sine', pad: 0.07, arp: 0.05, chords: [[45, 52, 57], [41, 48, 53], [43, 50, 55], [40, 47, 52]], scale: [0, 3, 7, 10, 7, 3, 0, -2], root: 24, every: 4, drone: 33 },
    vote: { bpm: 104, wave: 'triangle', pad: 0.04, arp: 0.06, chords: [[50, 53, 57], [50, 53, 57], [49, 52, 57], [50, 53, 57]], scale: [0, 0, 3, 0, 0, 5, 3, 0], root: 12, every: 2, pulse: 38 },
    win: { bpm: 96, wave: 'triangle', pad: 0.06, arp: 0.09, chords: [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], scale: [0, 4, 7, 12, 7, 4, 7, 12], root: 12, every: 2 },
    lose: { bpm: 56, wave: 'sine', pad: 0.07, arp: 0.05, chords: [[45, 48, 52], [44, 47, 52], [41, 45, 48], [44, 47, 52]], scale: [0, 3, 0, -2, 0, 3, 7, 3], root: 24, every: 4, drone: 33 },
  };

  function volume() {
    return LEVELS[level].volume;
  }

  function ensure() {
    if (ctx) return true;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
    } catch {
      return false;
    }
    master = ctx.createGain();
    master.gain.value = volume();
    master.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.55;
    musicBus.connect(master);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);
    // Litt støy til dunk og susing
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    for (const name of Object.keys(MOODS)) {
      moodGain[name] = ctx.createGain();
      moodGain[name].gain.value = 0;
      moodGain[name].connect(musicBus);
    }
    return true;
  }

  // ---- små byggeklosser
  function tone({ note, start, length, type = 'sine', gain = 0.1, attack = 0.01, to = musicBus, slideTo = null }) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz(note), start);
    if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(hz(slideTo), start + length);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(env);
    env.connect(to);
    osc.start(start);
    osc.stop(start + length + 0.05);
  }

  function thud(start, gain = 0.5) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.setValueAtTime(140, start);
    osc.frequency.exponentialRampToValueAtTime(35, start + 0.35);
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
    osc.connect(env);
    env.connect(sfxBus);
    osc.start(start);
    osc.stop(start + 0.5);
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const burst = ctx.createGain();
    src.buffer = noise;
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    burst.gain.setValueAtTime(gain * 0.6, start);
    burst.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
    src.connect(filter);
    filter.connect(burst);
    burst.connect(sfxBus);
    src.start(start);
    src.stop(start + 0.3);
  }

  function swoosh(start, length, from, to, gain = 0.15) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    src.buffer = noise;
    src.loop = true;
    filter.type = 'bandpass';
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + length);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + length * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, start + length);
    src.connect(filter);
    filter.connect(env);
    env.connect(sfxBus);
    src.start(start);
    src.stop(start + length + 0.05);
  }

  // ---- lydeffekter
  const EFFECTS = {
    join: (t) => {
      tone({ note: 84, start: t, length: 0.25, gain: 0.12, to: sfxBus });
      tone({ note: 91, start: t + 0.08, length: 0.3, gain: 0.1, to: sfxBus });
    },
    start: (t) => [60, 64, 67, 72].forEach((note, i) => tone({ note, start: t + i * 0.1, length: 0.5, type: 'triangle', gain: 0.14, to: sfxBus })),
    night: (t) => {
      swoosh(t, 1.8, 1400, 180, 0.12);
      [69, 66, 62, 57].forEach((note, i) => tone({ note, start: t + i * 0.28, length: 1.1, gain: 0.1, to: sfxBus }));
    },
    morning: (t) => {
      swoosh(t, 1.2, 300, 2200, 0.08);
      [72, 76, 79].forEach((note, i) => tone({ note, start: t + i * 0.18, length: 0.9, type: 'triangle', gain: 0.12, to: sfxBus }));
    },
    kill: (t) => {
      thud(t, 0.55);
      tone({ note: 40, start: t + 0.05, length: 1.2, type: 'sawtooth', gain: 0.06, to: sfxBus, slideTo: 33 });
    },
    shield: (t) => {
      [84, 88, 91, 96].forEach((note, i) => tone({ note, start: t + i * 0.07, length: 1.4, gain: 0.09, attack: 0.02, to: sfxBus }));
    },
    clue: (t) => [88, 91, 95, 100].forEach((note, i) => tone({ note, start: t + i * 0.12, length: 1, gain: 0.08, to: sfxBus })),
    level: (t) => [67, 72, 76, 79].forEach((note, i) => tone({ note, start: t + i * 0.11, length: 0.6, type: 'triangle', gain: 0.13, to: sfxBus })),
    vote: (t) => {
      tone({ note: 76, start: t, length: 0.35, type: 'triangle', gain: 0.14, to: sfxBus });
      tone({ note: 76, start: t + 0.22, length: 0.45, type: 'triangle', gain: 0.14, to: sfxBus });
    },
    out: (t) => [67, 63, 58].forEach((note, i) => tone({ note, start: t + i * 0.2, length: 0.7, type: 'triangle', gain: 0.13, to: sfxBus })),
    tie: (t) => {
      tone({ note: 64, start: t, length: 0.4, type: 'triangle', gain: 0.12, to: sfxBus });
      tone({ note: 64, start: t + 0.3, length: 0.6, type: 'triangle', gain: 0.12, to: sfxBus });
    },
    win: (t) => [60, 64, 67, 72, 76, 79].forEach((note, i) => tone({ note, start: t + i * 0.12, length: 1.1, type: 'triangle', gain: 0.13, to: sfxBus })),
    lose: (t) => {
      [57, 53, 50, 45].forEach((note, i) => tone({ note, start: t + i * 0.3, length: 1.2, type: 'sawtooth', gain: 0.06, to: sfxBus }));
      thud(t + 0.9, 0.35);
    },
  };

  // ---- musikk: en liten planlegger som legger noter litt frem i tid
  const music = { step: 0, next: 0 };

  function schedule() {
    if (!ctx || !mood || !MOODS[mood] || volume() === 0) return;
    const m = MOODS[mood];
    const beat = 60 / m.bpm;
    const bus = moodGain[mood];
    if (music.next < ctx.currentTime) music.next = ctx.currentTime + 0.05;
    while (music.next < ctx.currentTime + 0.8) {
      const t = music.next;
      const i = music.step;
      const chord = m.chords[Math.floor(i / 16) % m.chords.length];
      if (i % 16 === 0) {
        for (const note of chord) {
          tone({ note, start: t, length: beat * 8.5, type: 'sine', gain: m.pad, attack: beat * 2, to: bus });
          tone({ note: note + 12, start: t, length: beat * 8.5, type: m.wave, gain: m.pad * 0.4, attack: beat * 2.5, to: bus });
        }
        if (m.drone) tone({ note: m.drone, start: t, length: beat * 8.5, type: 'sine', gain: 0.09, attack: beat * 3, to: bus });
      }
      if (i % m.every === 0) {
        const step = m.scale[(i / m.every) % m.scale.length];
        tone({ note: chord[0] + m.root + step - 12, start: t, length: beat * m.every * 0.5 + 0.6, type: m.wave, gain: m.arp, attack: 0.02, to: bus });
      }
      if (m.pulse && i % 2 === 0) tone({ note: m.pulse, start: t, length: 0.18, gain: 0.16, attack: 0.005, to: bus });
      music.step += 1;
      music.next += beat / 2; // ett steg er en halv takt
    }
  }

  function applyMood() {
    if (!ctx) return;
    for (const name of Object.keys(moodGain)) {
      moodGain[name].gain.setTargetAtTime(name === mood ? 1 : 0, ctx.currentTime, 0.8);
    }
    music.step = 0;
    music.next = ctx.currentTime + 0.1;
    clearInterval(timer);
    timer = setInterval(schedule, 200);
    schedule();
  }

  function applyVolume() {
    if (master) master.gain.setTargetAtTime(volume(), ctx.currentTime, 0.1);
  }

  // Må kalles etter at brukeren har trykket på siden.
  function unlock() {
    if (!ensure()) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!timer) applyMood();
    return true;
  }

  function setMood(name) {
    if (name === mood) return;
    mood = name;
    applyMood();
  }

  function sfx(name) {
    if (!ctx || volume() === 0 || !EFFECTS[name]) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    EFFECTS[name](ctx.currentTime + 0.02);
  }

  function cycle() {
    unlock();
    level = (level + 1) % LEVELS.length;
    try { localStorage.setItem(KEY, JSON.stringify(level)); } catch { /* privat modus */ }
    applyVolume();
    if (volume() > 0) schedule();
    return LEVELS[level];
  }

  // Kobler en knapp til lyden, og låser opp ved første trykk hvor som helst på siden.
  function setupButton(button) {
    const show = () => {
      button.textContent = LEVELS[level].icon;
      button.setAttribute('aria-label', LEVELS[level].label);
      button.title = `${LEVELS[level].label}. Tap to change.`;
    };
    show();
    button.hidden = false;
    button.addEventListener('click', () => { cycle(); show(); });
    document.addEventListener('pointerdown', unlock, { passive: true });
  }

  return {
    setupButton,
    unlock,
    setMood,
    sfx,
    cycle,
    status: () => ({ unlocked: Boolean(ctx), running: Boolean(ctx) && ctx.state === 'running', level, mood }),
  };
})();
