// One command for local work: build, start the Firebase emulators (Auth + Firestore) and serve dist/.
// Sign in with any password the first time — the emulator creates the account.
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const build = run('node', ['scripts/build.mjs']);
build.on('exit', (code) => {
  if (code) process.exit(code);
  const children = [
    run('npx', ['firebase', 'emulators:start', '--only', 'auth,firestore', '--project', 'demo-salon']),
    run('node', ['scripts/serve.mjs', '--emulator']),
  ];
  const stop = () => children.forEach((c) => c.kill());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
