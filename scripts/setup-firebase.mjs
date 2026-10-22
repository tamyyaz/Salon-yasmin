// One-command setup of a NEW Firebase project for the salon.
//
//   node scripts/setup-firebase.mjs --key path/to/service-account.json [--dry-run] [--password '...']
//
// What it does (in order):
//   1. checks the project is clean (refuses to touch a project that already hosts something else)
//   2. registers a web app and writes its config into src/config.js + .firebaserc
//   3. creates the salon login (email from src/config.js) with a generated or given password
//   4. builds, then deploys Firestore rules + Hosting
// The key file is only read from where you point at; it is never copied or written anywhere.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1] ?? true; };
const keyFile = opt('key');
const dryRun = args.includes('--dry-run');
if (!keyFile || keyFile === true) { console.error('usage: node scripts/setup-firebase.mjs --key <service-account.json> [--dry-run] [--password <pw>]'); process.exit(1); }

const { project_id: P } = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const client = await new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
const call = async (url, method = 'GET', data) => {
  try { return (await client.request({ url, method, data })).data; }
  catch (e) { throw new Error(`${method} ${url.replace(/\?.*/, '')} → ${e.response?.status} ${e.response?.data?.error?.message || e.message}`); }
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const stop = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

console.log(`Project: ${P}${dryRun ? '   (dry run: read-only checks)' : ''}`);

// ---------- 1. safety checks ----------
step('Checking the project is clean');
const apps = (await call(`https://firebase.googleapis.com/v1beta1/projects/${P}/webApps`)).apps || [];
if (apps.length) stop(`This project already has web apps (${apps.map((a) => a.displayName).join(', ')}). Use a NEW, empty Firebase project for the salon.`);

const dbs = (await call(`https://firestore.googleapis.com/v1/projects/${P}/databases`)).databases || [];
if (!dbs.some((d) => d.name.endsWith('/(default)'))) stop('No Firestore database yet. Firebase Console → Build → Firestore Database → Create database (production mode), then re-run.');
const { collectionIds = [] } = await call(`https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents:listCollectionIds`, 'POST', {});
const foreign = collectionIds.filter((c) => !['appointments', 'notes'].includes(c));
if (foreign.length) stop(`Firestore already holds other data (${foreign.slice(0, 5).join(', ')}…). Use a NEW project, or deploy the rules by hand.`);

const sites = (await call(`https://firebasehosting.googleapis.com/v1beta1/projects/${P}/sites`)).sites || [];
const site = sites.find((s) => s.type === 'DEFAULT_SITE');
if (!site) stop('No default Hosting site found for this project.');
const { releases = [] } = await call(`https://firebasehosting.googleapis.com/v1beta1/sites/${P}/releases?pageSize=1`);
if (releases.length) stop('The default Hosting site already has a deployed site. Refusing to overwrite it.');

const authCfg = await call(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config`).catch(() => null);
if (!authCfg?.signIn?.email?.enabled) stop('Email/Password sign-in is not enabled. Firebase Console → Build → Authentication → Get started → Sign-in method → Email/Password → Enable, then re-run.');
console.log(`  clean ✔  site: ${site.defaultUrl}`);
if (dryRun) { console.log('\nDry run finished: nothing was changed.'); process.exit(0); }

// ---------- 2. web app + config ----------
step('Registering the web app');
let op = await call(`https://firebase.googleapis.com/v1beta1/projects/${P}/webApps`, 'POST', { displayName: 'Salon Yasmin' });
for (let i = 0; i < 30 && !op.done; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  op = await call(`https://firebase.googleapis.com/v1beta1/${op.name}`);
}
if (!op.done || op.error) stop(`Web app creation failed: ${op.error?.message || 'timed out'}`);
const cfg = await call(`https://firebase.googleapis.com/v1beta1/${op.response.name}/config`);

let source = fs.readFileSync('src/config.js', 'utf8');
const block = `firebase: {\n    apiKey: '${cfg.apiKey}',\n    authDomain: '${cfg.authDomain}',\n    projectId: '${cfg.projectId}',\n    appId: '${cfg.appId}',\n  },`;
source = source.replace(/firebase: \{[\s\S]*?\n  \},/, block);
fs.writeFileSync('src/config.js', source);
fs.writeFileSync('.firebaserc', JSON.stringify({ projects: { default: P } }, null, 2) + '\n');
console.log(`  config written for ${cfg.projectId}`);

// ---------- 3. salon login ----------
step('Creating the salon login');
const email = /salonEmail:\s*'([^']+)'/.exec(source)[1];
const password = typeof opt('password') === 'string' ? opt('password') : crypto.randomBytes(9).toString('base64url');
try {
  await call(`https://identitytoolkit.googleapis.com/v1/projects/${P}/accounts`, 'POST', { email, password, emailVerified: true });
  console.log(`  created ${email}`);
  console.log(`  PASSWORD (shown once, change it any time in Authentication → Users): ${password}`);
} catch (e) {
  if (!/EMAIL_EXISTS/.test(e.message)) throw e;
  console.log(`  ${email} already exists — password left unchanged`);
}

// ---------- 4. build + deploy ----------
step('Building and deploying (Firestore rules + Hosting)');
const run = (cmd, a, env = {}) => {
  const r = spawnSync(cmd, a, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status) stop(`${cmd} ${a.join(' ')} failed`);
};
run('npm', ['run', 'build']);
run('npx', ['firebase', 'deploy', '--only', 'hosting,firestore:rules', '--project', P, '--non-interactive'], { GOOGLE_APPLICATION_CREDENTIALS: keyFile });
console.log(`\n✔ Done. Open ${site.defaultUrl} and sign in with the salon password.`);
console.log('  Next: delete the service-account key you used (Google Cloud → IAM → Service accounts → Keys).');
