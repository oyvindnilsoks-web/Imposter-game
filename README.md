# Imposter

Et live impostor-spill for klassen. Elevene scanner en QR-kode for å bli med, og læreren styrer avstemmingene.

## Slik spiller dere

1. **Læreren** åpner `/host` og trykker **Lag nytt spill**. En QR-kode og en spillkode vises.
2. **Elevene** scanner QR-koden, skriver inn navnet sitt og havner i lobbyen. Læreren ser alle som er med.
3. Læreren trykker **Start spillet**. Impostorene velges i virkeligheten (appen vet ikke hvem de er).
4. Læreren trykker **Start runde 1 avstemming**. Alle som er med får opp en liste og stemmer på den de tror er impostor. Hver har én stemme, og man kan ikke stemme på seg selv.
5. Avstemmingen lukkes automatisk når alle har stemt. Den med flest stemmer krysses ut. Ved uavgjort blir ingen kastet ut.
6. Læreren trykker **Start runde 2 avstemming**, og slik fortsetter det. Spillere som er ute kan følge med, men ikke stemme.

Hvis noen har mistet nettet og avstemmingen står fast, kan læreren trykke **Avslutt avstemming nå**.

## Kjøre spillet

Krever Node.js 18 eller nyere.

```bash
npm install
npm start
```

Serveren starter på port 3000 (endre med `PORT`). Åpne `http://<adresse>:3000/host`.

QR-koden peker på adressen du åpnet verts-siden fra. Derfor må du **ikke** bruke `localhost` hvis elevene skal bli med fra egne mobiler:

- **På samme Wi-Fi:** åpne verts-siden via maskinens IP-adresse, for eksempel `http://192.168.1.20:3000/host`.
- **På nett:** publiser på en vert som støtter WebSocket og en kjørende Node-prosess (Render, Railway, Fly.io o.l.), og åpne `/host` på den adressen.

Spilltilstanden ligger i minnet på serveren. Starter du serveren på nytt, forsvinner pågående spill.

## Utvikling

```bash
npm test
```

- `server.js` – Express + Socket.IO, QR-generering
- `lib/room.js` – spillreglene (lobby, avstemming, utkastelse), uten nettverkskode
- `public/` – verts-siden (`host.html`) og elevsiden (`index.html`)
