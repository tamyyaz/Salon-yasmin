// Deploys dist/ (Hosting) and firestore.rules through the Firebase REST APIs.
// Fallback for service-account keys that the Firebase CLI refuses (it wants extra Service Usage permissions).
//   node scripts/deploy-rest.mjs --key path/to/service-account.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';

export async function deployRest(keyFile) {
  const { project_id: P } = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const client = await new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  const call = async (url, method = 'GET', data, extra = {}) => {
    try { return (await client.request({ url, method, data, ...extra })).data; }
    catch (e) { const err = new Error(`${method} ${url.replace(/\?.*/, '')} → ${e.response?.status} ${e.response?.data?.error?.message || e.message}`); err.status = e.response?.status; throw err; }
  };

  // ---- Firestore rules ----
  console.log('  rules: uploading firestore.rules');
  const ruleset = await call(`https://firebaserules.googleapis.com/v1/projects/${P}/rulesets`, 'POST',
    { source: { files: [{ name: 'firestore.rules', content: fs.readFileSync('firestore.rules', 'utf8') }] } });
  const release = { name: `projects/${P}/releases/cloud.firestore`, rulesetName: ruleset.name };
  // a new database already has a default `cloud.firestore` release: update it, create only if missing
  try { await call(`https://firebaserules.googleapis.com/v1/projects/${P}/releases/cloud.firestore`, 'PATCH', { release }); }
  catch (e) {
    if (e.status !== 404) throw e;
    await call(`https://firebaserules.googleapis.com/v1/projects/${P}/releases`, 'POST', release);
  }
  console.log('  rules: released');

  // ---- Hosting ----
  const site = P;
  const headers = JSON.parse(fs.readFileSync('firebase.json', 'utf8')).hosting.headers
    .map(({ source, headers: h }) => ({ glob: source, headers: Object.fromEntries(h.map(({ key, value }) => [key, value])) }));
  const version = await call(`https://firebasehosting.googleapis.com/v1beta1/sites/${site}/versions`, 'POST', { config: { headers } });

  const files = {};   // "/path" -> sha256 of gzipped bytes
  const byHash = {};  // sha256 -> gzipped bytes
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return walk(full);
    const gz = zlib.gzipSync(fs.readFileSync(full), { level: 9 });
    const hash = crypto.createHash('sha256').update(gz).digest('hex');
    files['/' + path.relative('dist', full).split(path.sep).join('/')] = hash;
    byHash[hash] = gz;
  });
  walk('dist');
  console.log(`  hosting: ${Object.keys(files).length} files`);

  const pop = await call(`https://firebasehosting.googleapis.com/v1beta1/${version.name}:populateFiles`, 'POST', { files });
  for (const hash of pop.uploadRequiredHashes || []) {
    await call(`${pop.uploadUrl}/${hash}`, 'POST', byHash[hash], { headers: { 'Content-Type': 'application/octet-stream' } });
  }
  await call(`https://firebasehosting.googleapis.com/v1beta1/${version.name}?update_mask=status`, 'PATCH', { status: 'FINALIZED' });
  await call(`https://firebasehosting.googleapis.com/v1beta1/sites/${site}/releases?versionName=${version.name}`, 'POST', {});
  console.log(`  hosting: released → https://${site}.web.app`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--key');
  if (i === -1) { console.error('usage: node scripts/deploy-rest.mjs --key <service-account.json>'); process.exit(1); }
  await deployRest(process.argv[i + 1]);
}
