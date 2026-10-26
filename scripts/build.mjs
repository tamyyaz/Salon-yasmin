// Builds the deployable site into dist/: static files from public/ + the bundled app (src/ + Firebase SDK).
import fs from 'node:fs';
import { build } from 'esbuild';

fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('public', 'dist', { recursive: true });

await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  outfile: 'dist/app.js',
  legalComments: 'none',
  logLevel: 'info',
});
