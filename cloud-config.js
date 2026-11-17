/**
 * Independent Cloud Sync Configuration (GitHub Pages Ready — Zero AI Studio Dependency)
 *
 * Uses Cloud Firestore directly via official Google Firebase Web SDK (CDN ESM)
 * so both your Main Customer GitHub Pages branch and your separate Admin Panel
 * GitHub Pages branch share real-time live data across all devices.
 *
 * Optional: You can also switch to a Firebase Realtime Database URL via
 * `rtdbUrl` below or inside the Admin Panel -> "Cloud Sync" dialog.
 */
const CLOUD_CONFIG = {
  mode: 'firestore', // 'firestore' | 'rtdb' | 'standalone'
  rtdbUrl: '',
  namespace: 'af_p2',
  firestoreConfig: {
    projectId: 'eminent-isomer-93rp2',
    appId: '1:46017993710:web:8709bc6b9002674010ccff',
    apiKey: 'AIzaSyBBWx-RxiJWEiF_yuxxIVVWxQHdfRQwOXE',
    authDomain: 'eminent-isomer-93rp2.firebaseapp.com',
    firestoreDatabaseId: 'ai-studio-accountfundspann-f9406242-8669-4e3b-903f-0446979f2a54',
    storageBucket: 'eminent-isomer-93rp2.firebasestorage.app',
    messagingSenderId: '46017993710',
  },
};

export default CLOUD_CONFIG;
