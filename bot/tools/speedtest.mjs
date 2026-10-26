// Where does the time go?   npm run speedtest
// Measures the round trips a reply depends on: Firestore reads and writes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as web } from '../../src/config.js';
import { openDb } from '../lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '..', '.env')); } catch { /* variables may come from the system */ }

const time = async (fn) => { const t = Date.now(); try { await fn(); return { ms: Date.now() - t }; } catch (e) { return { ms: Date.now() - t, error: e.message }; } };
const show = (label, rs) => {
  const ok = rs.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
  console.log(ok.length
    ? `${label.padEnd(22)} min ${ok[0]} ms   median ${ok[Math.floor(ok.length / 2)]} ms   max ${ok[ok.length - 1]} ms`
    : `${label.padEnd(22)} FAILED: ${rs[0].error}`);
};
const repeat = async (n, fn) => { const out = []; for (let i = 0; i < n; i += 1) out.push(await time(fn)); return out; };

const db = openDb({ projectId: web.firebase.projectId });
const ref = db.collection('bot_status').doc('speedtest');
console.log('Firestore (first call includes connecting, so it is shown separately):');
const first = await time(() => ref.get());
console.log(`  first read           ${first.ms} ms${first.error ? `  FAILED: ${first.error}` : ''}`);
show('  read', await repeat(5, () => ref.get()));
show('  write', await repeat(5, () => ref.set({ at: new Date().toISOString() })));
await ref.delete().catch(() => {});

console.log('\nReading: under ~150 ms is fine; above ~400 ms means the internet connection of the bot device is the slow part.');
process.exit(0);
