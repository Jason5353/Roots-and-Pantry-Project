// Copies the self-hosted fonts into public/fonts so the app needs no third-party font service.
import fs from 'node:fs';
const out = 'public/fonts';
fs.mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2', 'bricolage.woff2'],
  ['node_modules/@fontsource/caveat/files/caveat-latin-700-normal.woff2', 'caveat-700.woff2'],
];
for (const [from, to] of files) fs.copyFileSync(from, `${out}/${to}`);
console.log('fonts copied');
