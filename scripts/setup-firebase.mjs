// One-command setup of a NEW Firebase project for the salon. Safe to re-run.
//
//   node scripts/setup-firebase.mjs --key path/to/service-account.json [--dry-run] [--password '...'] [--location eur3]
//
// What it does (in order):
//   1. checks the project is clean (refuses to touch a project that already hosts something else)
//   2. registers a web app and writes its config into src/config.js + .firebaserc
//   3. makes sure Firestore and Email/Password sign-in are ready (some steps can only be clicked in the Console)
//   4. creates the salon login (email from src/config.js) with a generated or given password
//   5. builds, then deploys Firestore rules + Hosting
// The key file is only read from where you point at; it is never copied or written anywhere.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : args[i + 1] ?? true; };
const keyFile = opt('key');
const dryRun = args.includes('--dry-run');
if (!keyFile || keyFile === true) { console.error('usage: node scripts/setup-firebase.mjs --key <service-account.json> [--dry-run] [--password <pw>] [--location eur3]'); process.exit(1); }

const APP_NAME = 'Salon Yasmin';
const { project_id: P } = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const client = await new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
const call = async (url, method = 'GET', data) => {
  try { return (await client.request({ url, method, data })).data; }
  catch (e) { throw new Error(`${method} ${url.replace(/\?.*/, '')} → ${e.response?.status} ${e.response?.data?.error?.message || e.message}`); }
};
const tolerant = async (fn) => { try { return await fn(); } catch (e) { return { __error: e.message }; } };
const step = (msg) => console.log(`\n▸ ${msg}`);
const stop = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };
const location = typeof opt('location') === 'string' ? opt('location') : 'eur3';
const API_OFF = /has not been used|is disabled|SERVICE_DISABLED/;

console.log(`Project: ${P}${dryRun ? '   (dry run: read-only checks)' : ''}`);

// ---------- 1. safety checks + state ----------
step('Checking the project is clean');
const apps = (await call(`https://firebase.googleapis.com/v1beta1/projects/${P}/webApps`)).apps || [];
const foreignApps = apps.filter((a) => a.displayName !== APP_NAME);
if (foreignApps.length) stop(`This project already has other web apps (${foreignApps.map((a) => a.displayName).join(', ')}). Use a NEW, empty Firebase project for the salon.`);
const existingApp = apps[0];

// Firestore: must be empty (or absent); never overwrite another app's data
const dbList = await tolerant(() => call(`https://firestore.googleapis.com/v1/projects/${P}/databases`));
const firestoreApiOff = dbList.__error && API_OFF.test(dbList.__error);
if (dbList.__error && !firestoreApiOff) stop(dbList.__error);
const hasDb = !dbList.__error && (dbList.databases || []).some((d) => d.name.endsWith('/(default)'));
if (hasDb) {
  const { collectionIds = [] } = await call(`https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents:listCollectionIds`, 'POST', {});
  const foreign = collectionIds.filter((c) => !['appointments', 'notes'].includes(c));
  if (foreign.length) stop(`Firestore already holds other data (${foreign.slice(0, 5).join(', ')}…). Use a NEW project, or deploy the rules by hand.`);
}

const sites = (await call(`https://firebasehosting.googleapis.com/v1beta1/projects/${P}/sites`)).sites || [];
const site = sites.find((s) => s.type === 'DEFAULT_SITE');
if (!site) stop('No default Hosting site found for this project.');
const { releases = [] } = await call(`https://firebasehosting.googleapis.com/v1beta1/sites/${P}/releases?pageSize=1`);
const siteHasContent = releases.length > 0;
if (siteHasContent && !existingApp) stop('The default Hosting site already has a deployed site. Refusing to overwrite it.');

const authCfg = await tolerant(() => call(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config`));
const authInitialised = !authCfg.__error;
const authOn = authInitialised && authCfg.signIn?.email?.enabled;

console.log(`  web app:   ${existingApp ? 'already registered' : 'not yet → will register'}`);
console.log(`  firestore: ${hasDb ? 'database exists and is empty' : 'no database yet (create it in the Console)'}`);
console.log(`  auth:      ${authOn ? 'Email/Password enabled' : authInitialised ? 'initialised, Email/Password off → will enable' : 'not initialised (click "Get started" in the Console)'}`);
console.log(`  hosting:   ${siteHasContent ? 'has our release' : 'clean ✔'}  ${site.defaultUrl}`);
if (dryRun) { console.log('\nDry run finished: nothing was changed.'); process.exit(0); }

const waitOp = async (url, op, label) => {
  for (let i = 0; i < 60 && !op.done; i += 1) { await new Promise((r) => setTimeout(r, 3000)); op = await call(url(op.name)); }
  if (!op.done || op.error) stop(`${label} failed: ${op.error?.message || 'timed out'}`);
  return op;
};

// ---------- 2. web app + config ----------
step('Registering the web app');
let appName = existingApp?.name;
if (!appName) {
  const op = await waitOp((n) => `https://firebase.googleapis.com/v1beta1/${n}`,
    await call(`https://firebase.googleapis.com/v1beta1/projects/${P}/webApps`, 'POST', { displayName: APP_NAME }), 'Web app creation');
  appName = op.response.name;
}
const cfg = await call(`https://firebase.googleapis.com/v1beta1/${appName}/config`);
let source = fs.readFileSync('src/config.js', 'utf8');
const block = `firebase: {\n    apiKey: '${cfg.apiKey}',\n    authDomain: '${cfg.authDomain}',\n    projectId: '${cfg.projectId}',\n    appId: '${cfg.appId}',\n  },`;
source = source.replace(/firebase: \{[\s\S]*?\n  \},/, block);
fs.writeFileSync('src/config.js', source);
fs.writeFileSync('.firebaserc', JSON.stringify({ projects: { default: P } }, null, 2) + '\n');
console.log(`  config written for ${cfg.projectId} (src/config.js, .firebaserc)`);

// ---------- 3. services that must be ready ----------
step('Checking Firestore and sign-in');
const todo = [];
if (!authInitialised) todo.push('Authentication → Get started (then Sign-in method → Email/Password → Enable)');
else if (!authOn) {
  await call(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config?updateMask=signIn.email`, 'PATCH', { signIn: { email: { enabled: true, passwordRequired: true } } });
  console.log('  Email/Password enabled');
}
if (!hasDb) {
  const enabled = firestoreApiOff
    ? await tolerant(() => call(`https://serviceusage.googleapis.com/v1/projects/${P}/services/firestore.googleapis.com:enable`, 'POST', {}))
    : {};
  if (enabled.__error) todo.push(`Firestore Database → Create database (production mode, location ${location})`);
  else {
    if (firestoreApiOff) await waitOp((n) => `https://serviceusage.googleapis.com/v1/${n}`, enabled, 'Enabling the Firestore API');
    await waitOp((n) => `https://firestore.googleapis.com/v1/${n}`,
      await call(`https://firestore.googleapis.com/v1/projects/${P}/databases?databaseId=(default)`, 'POST', { type: 'FIRESTORE_NATIVE', locationId: location }), 'Creating the database');
    console.log('  database created');
  }
}
if (todo.length) {
  stop(`Web app and config are done. Two clicks are left that this key is not allowed to do (Firebase Console → project "${P}" → Build):\n${todo.map((t) => `   • ${t}`).join('\n')}\n  Then run this script again.`);
}

// ---------- 4. salon login ----------
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

// ---------- 5. build + deploy ----------
step('Building and deploying (Firestore rules + Hosting)');
const run = (cmd, a, env = {}) => {
  const r = spawnSync(cmd, a, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status) stop(`${cmd} ${a.join(' ')} failed`);
};
run('npm', ['run', 'build']);
run('npx', ['firebase', 'deploy', '--only', 'hosting,firestore:rules', '--project', P, '--non-interactive'], { GOOGLE_APPLICATION_CREDENTIALS: keyFile });
console.log(`\n✔ Done. Open ${site.defaultUrl} and sign in with the salon password.`);
console.log('  Next: delete the service-account key you used (Google Cloud → IAM → Service accounts → Keys).');
