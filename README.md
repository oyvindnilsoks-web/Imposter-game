# The Impostor

Et live impostor-spill for engelskundervisning. Elevene scanner en QR-kode for å bli med, og læreren styrer avstemmingene. Alt elevene og du ser på skjermen er på enkel engelsk.

## Slik spiller dere

1. **Læreren** åpner `/host` og trykker **Create new game**. En QR-kode og en spillkode vises.
2. **Elevene** scanner QR-koden, kan ta et bilde av seg selv, skriver inn navnet sitt og havner i lobbyen. Læreren ser alle som er med.
3. Læreren trykker **Start game**, og så **Pick impostors**. Der trykker du **Show**, velger impostorene og trykker **Save**. Spillet krever minst én impostor, og flere crew enn impostorer.
4. Hvis noen er drept av impostorene før avstemmingen, trykker læreren **Someone was killed** (før runde 1 og mellom rundene) og velger den som er drept. Alle ser hvem det var, og spillet teller det som en utkastelse, så det kan også avgjøre spillet. Så trykker læreren **Start round 1 vote**. Alle som er med får opp en liste og stemmer på den de tror er impostor. Hver har én stemme, og man kan ikke stemme på seg selv.
5. Avstemmingen lukkes automatisk når alle har stemt. Den med flest stemmer krysses ut.
6. **Uavgjort:** ingen blir kastet ut. Neste runde er en omavstemming (**Start runoff vote**) der bare de som sto likt kan velges. Blir også den uavgjort, er neste runde en vanlig avstemming med alle.
7. Læreren trykker **Start round 2 vote**, og slik fortsetter det. Spillere som er ute kan følge med, men ikke stemme.
8. **Spillet er slutt** når alle impostorene er ute (crew vinner), eller når impostorene er like mange som crew (impostorene vinner). Da vises vinneren, og alle ser hvem som var impostor.

Hvis noen har mistet nettet og avstemmingen står fast, trykk **Close vote now**.

Dialogen for å velge impostorer er sløret helt til du trykker **Show** (trykk **Hide** for å skjule igjen), og valget sendes først når du trykker **Save**. Impostorene vises ikke noe sted på hovedskjermen før spillet er slutt, så du kan trygt vise den på tavla.

### Bilder
Elevene kan ta et lite bilde av seg selv (128×128 piksler) i stedet for dyre-emojien, enten når de blir med eller senere mens de venter (**Add a photo** / **Change photo**). Bildet:
- lagres bare i nettleseren mens fanen er åpen (`sessionStorage`), og skrives **aldri** til databasen,
- deles med de andre spillerne via Supabase Realtime Presence, som bare holder det i minnet mens eleven er koblet til,
- forsvinner når eleven lukker siden. Uten Realtime vises emoji som vanlig.

Sjekk gjerne skolens regler for bilder av elever.

## Slik er det bygget

- **Nettsiden** (`public/`) er rene statiske filer, uten byggesteg. Den kan ligge på Netlify.
- **Databasen** er Supabase. All spillogikk ligger som SQL-funksjoner i `supabase/schema.sql`: hvem som får bli med, stemmetelling og utkastelse. Nettleseren kan ikke lese hemmeligheter, andres stemmer eller endre tabeller direkte.
- **Live-oppdatering** går via Supabase Realtime, og sidene sjekker i tillegg for endringer hvert 3. sekund. Spillet fungerer derfor også om Realtime skulle være av.
- Spill som er over 1 døgn gammelt ryddes bort automatisk.

Tabeller og funksjoner heter `imposter_…`, så de kan ligge i et Supabase-prosjekt som brukes til andre ting.

## Sette opp

1. **Supabase:** kjør hele `supabase/schema.sql` i SQL Editor. Den kan kjøres på nytt uten skade, også oppå en eldre versjon, og beholder data.
2. **Koble siden:** legg prosjekt-URL og publiserbar nøkkel i `public/config.js`.
3. **Netlify (autodeploy):** koble repoet én gang, så deployes hver merge til `main` av seg selv.
   Netlify → prosjektet → **Project configuration → Build & deploy → Continuous deployment → Link repository** → GitHub →
   `oyvindnilsoks-web/Imposter-game`, production branch `main`, **build command tom**, **publish directory `public`**
   (`netlify.toml` har dette allerede). Slå gjerne på **Deploy Previews**, så hver pull request får en egen testadresse
   (den bruker samme Supabase, så bruk den bare til å se på utseende). Åpne `https://<din-side>.netlify.app/host`.

Endringer i `supabase/schema.sql` deployes ikke av Netlify. Lim dem inn i SQL Editor (se punkt 1) **før** du merger kode som trenger dem.

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
