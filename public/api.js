// Felles kode for elev- og vertssiden: snakker med Supabase.
window.ImposterApi = (() => {
  const config = window.IMPOSTER_CONFIG || {};
  const isReady = Boolean(config.supabaseUrl && config.supabaseKey && window.supabase);
  const client = isReady
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

  const NOT_SET_UP = 'The game is not set up yet. Please ask your teacher.';
  const GENERIC_ERROR = 'Something went wrong. Please try again.';

  // Feilmeldingene vi selv lager i SQL (kode P0001) er skrevet for mennesker.
  // Alt annet, som nettverksfeil, får en vanlig melding.
  async function rpc(name, args) {
    if (!client) throw new Error(NOT_SET_UP);
    let result;
    try {
      result = await client.rpc(name, args);
    } catch {
      throw new Error(GENERIC_ERROR);
    }
    if (result.error) {
      const error = new Error(result.error.code === 'P0001' ? result.error.message : GENERIC_ERROR);
      error.gone = /game not found/i.test(error.message);
      throw error;
    }
    return result.data;
  }

  // Følger et spill. Realtime gir raske oppdateringer, og en sjekk hvert 3. sekund er sikkerhetsnett
  // hvis Realtime er av eller nettet hakker.
  function watchGame({ code, secret }, { onState, onGone }) {
    let stopped = false;
    let busy = false;
    let again = false;

    async function refresh() {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const state = await rpc('imposter_get_state', { p_code: code, p_secret: secret || null });
        if (!stopped) onState(state);
      } catch (error) {
        if (!stopped && error.gone) onGone(error);
      } finally {
        busy = false;
        if (again && !stopped) {
          again = false;
          refresh();
        }
      }
    }

    let channel = null;
    if (client) {
      channel = client
        .channel(`imposter-${code}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'imposter_games', filter: `code=eq.${code}` }, refresh)
        .subscribe();
    }
    const timer = setInterval(refresh, 3000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    refresh();

    return {
      refresh,
      stop() {
        stopped = true;
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
        if (channel) client.removeChannel(channel);
      },
    };
  }

  // crypto.randomUUID finnes ikke på http://<ip>, så vi bruker getRandomValues.
  function newSecret() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return { isReady, NOT_SET_UP, rpc, watchGame, newSecret };
})();
