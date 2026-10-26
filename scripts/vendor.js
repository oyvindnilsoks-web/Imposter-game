'use strict';

// Kopierer nettleserbibliotekene inn i public/vendor, så siden kan publiseres uten byggesteg.
// Kjør `npm run vendor` etter å ha oppdatert avhengighetene.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'public', 'vendor');

const files = {
  'supabase.js': 'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
  'qrcode.js': 'node_modules/qrcode-generator/dist/qrcode.js',
};

fs.mkdirSync(target, { recursive: true });
for (const [name, source] of Object.entries(files)) {
  fs.copyFileSync(path.join(root, source), path.join(target, name));
  console.log(`public/vendor/${name}`);
}
