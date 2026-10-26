'use strict';

// Kjører hele spillet lokalt uten Supabase: siden serveres fra public/, og databasekallene
// går til en innebygd Postgres (PGlite) med nøyaktig samme SQL som i Supabase.
// Spilltilstanden forsvinner når serveren stopper. Start med `npm run local`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLocalDatabase, PUBLIC_FUNCTIONS } = require('./local-db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function main() {
  const { rpc } = await createLocalDatabase();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Samme adresse og svar som Supabase (PostgREST) bruker for funksjonskall.
    const match = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (match) {
      if (req.method !== 'POST' || !PUBLIC_FUNCTIONS.has(match[1])) return sendJson(res, 404, { message: 'Not found' });
      try {
        const args = JSON.parse((await readBody(req)) || '{}');
        const result = await rpc(match[1], args);
        if (result === null || result === undefined) {
          res.writeHead(204);
          return res.end();
        }
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { code: error.code || 'P0001', message: error.message, details: null, hint: null });
      }
    }

    // Peker siden mot denne serveren i stedet for mot Supabase.
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] });
      return res.end(`window.IMPOSTER_CONFIG = { supabaseUrl: location.origin, supabaseKey: 'local' };`);
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname === '/host' ? '/host.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, requested));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  // Realtime finnes ikke lokalt. Siden sjekker for endringer hvert 3. sekund i stedet.
  server.on('upgrade', (req, socket) => socket.destroy());

  server.listen(PORT, () => {
    console.log(`Imposter game (local test version) running at http://localhost:${PORT}/host`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
