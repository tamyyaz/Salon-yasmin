// Lets the assistant answer again in chats where it went quiet (you typed there, or it handed off).
//   npm run resume              all chats
//   npm run resume -- 963991234567   one chat (international number, digits only)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as web } from '../../src/config.js';
import { openDb } from '../lib/db.js';

try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* optional */ }
const db = openDb({ projectId: process.env.FIREBASE_PROJECT_ID || web.firebase.projectId });
const only = (process.argv[2] || '').replace(/\D/g, '');
const snap = only ? [await db.collection('wa_chats').doc(only).get()].filter((d) => d.exists) : (await db.collection('wa_chats').get()).docs;
let n = 0;
for (const d of snap) {
  if ((d.data().humanUntil || 0) > Date.now()) { await d.ref.update({ humanUntil: 0 }); n += 1; console.log('resumed:', d.id); }
}
console.log(n ? `Done: ${n} chat(s) resumed.` : 'Nothing was paused.');
process.exit(0);
