// Firestore (Admin SDK). The Admin SDK bypasses security rules, so this key must stay on the bot machine only.
//   FIREBASE_SERVICE_ACCOUNT       JSON text of the service-account key, or
//   GOOGLE_APPLICATION_CREDENTIALS path to the key file
// Against the emulator set FIRESTORE_EMULATOR_HOST (no key needed).
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function openDb({ projectId, appName = 'salon-bot' } = {}) {
  const existing = getApps().find((a) => a.name === appName);
  if (existing) return getFirestore(existing);
  const options = { projectId };
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    options.credential = process.env.FIREBASE_SERVICE_ACCOUNT ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) : applicationDefault();
  }
  const app = initializeApp(options, appName);
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
