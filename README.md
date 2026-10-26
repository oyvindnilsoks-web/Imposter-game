# Imposter

Et live impostor-spill for engelskundervisning. Elevene scanner en QR-kode for å bli med, og læreren styrer avstemmingene. Alt elevene og du ser på skjermen er på enkel engelsk.

## Slik spiller dere

1. **Læreren** åpner `/host` og trykker **Create new game**. En QR-kode og en spillkode vises.
2. **Elevene** scanner QR-koden, skriver inn navnet sitt og havner i lobbyen. Læreren ser alle som er med.
3. Læreren trykker **Start game**. Impostorene velges i virkeligheten (appen vet ikke hvem de er).
4. Læreren trykker **Start round 1 vote**. Alle som er med får opp en liste og stemmer på den de tror er impostor. Hver har én stemme, og man kan ikke stemme på seg selv.
5. Avstemmingen lukkes automatisk når alle har stemt. Den med flest stemmer krysses ut. Ved uavgjort blir ingen kastet ut.
6. Læreren trykker **Start round 2 vote**, og slik fortsetter det. Spillere som er ute kan følge med, men ikke stemme.

Hvis noen har mistet nettet og avstemmingen står fast, trykk **Close vote now**.

## Slik er det bygget

- **Nettsiden** (`public/`) er rene statiske filer, uten byggesteg. Den kan ligge på Netlify.
- **Databasen** er Supabase. All spillogikk ligger som SQL-funksjoner i `supabase/schema.sql`: hvem som får bli med, stemmetelling og utkastelse. Nettleseren kan ikke lese hemmeligheter, andres stemmer eller endre tabeller direkte.
- **Live-oppdatering** går via Supabase Realtime, og sidene sjekker i tillegg for endringer hvert 3. sekund. Spillet fungerer derfor også om Realtime skulle være av.
- Spill som er over 1 døgn gammelt ryddes bort automatisk.

Tabeller og funksjoner heter `imposter_…`, så de kan ligge i et Supabase-prosjekt som brukes til andre ting.

## Sette opp

1. **Supabase:** kjør hele `supabase/schema.sql` én gang i SQL Editor. Den kan kjøres på nytt uten skade.
2. **Koble siden:** legg prosjekt-URL og publiserbar nøkkel i `public/config.js`.
3. **Netlify:** koble repoet og la innstillingene i `netlify.toml` gjelde (publiser mappen `public`, ingen byggekommando). Åpne `https://<din-side>.netlify.app/host`.

## Prøve lokalt (uten Supabase)

```bash
npm install
npm run local
```

Åpner en testversjon på `http://localhost:3000/host`. Den bruker en innebygd Postgres med nøyaktig samme SQL, så du kan teste hele spillet uten konto. Tilstanden forsvinner når du stopper den. Elever på andre enheter kommer ikke inn via `localhost`, så dette er bare for å prøve.

## Utvikling

```bash
npm test          # SQL-reglene kjøres mot en lokal Postgres
npm run vendor    # kopierer nettleserbibliotekene til public/vendor etter oppdatering
```

- `supabase/schema.sql` – tabeller, sikkerhet og spillregler
- `public/` – elevside (`index.html`), vertsside (`host.html`), felles kode (`api.js`) og bibliotekene i `vendor/`
- `scripts/` – lokal testversjon og hjelpeskript
