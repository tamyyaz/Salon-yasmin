// Everything you may want to change lives here.
// The Firebase "web config" is NOT a secret (it only identifies the project);
// the data is protected by the login + firestore.rules.
export const config = {
  salonName: 'صالون ياسمين',
  currency: '₪',
  openHour: 9,        // first slot of the day
  closeHour: 21,      // last slot ends here
  slotMinutes: 30,

  // The one account that can sign in. Create it in Firebase Console → Authentication → Users
  // with a password of your choice. It must match the email inside firestore.rules.
  salonEmail: 'salon@yasmin.app',

  // Firebase Console → Project settings → Your apps → Web app → "SDK setup and configuration"
  firebase: {
    apiKey: 'AIzaSyBNiFftDly1kK3f9N_fDnf3mTFtrJVBJK0',
    authDomain: 'salon-yasmin.firebaseapp.com',
    projectId: 'salon-yasmin',
    appId: '1:120596759277:web:9d94efb99a4147dfa5c2e4',
  },
};
