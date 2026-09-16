/**
 * 揪咖 JioKa2 — Firebase 初始化（ES Module）
 * 需先於 config.js 設定 window.JIOKA_CONFIG.firebase 與 GOOGLE_CLIENT_ID
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithCredential, signOut as fbSignOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const cfg = window.JIOKA_CONFIG || {};
export const app = initializeApp(cfg.firebase);
export const auth = getAuth(app);
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });

export function signInWithGoogleIdToken(idToken) {
  const credential = GoogleAuthProvider.credential(idToken);
  return signInWithCredential(auth, credential);
}
export function signOut() { return fbSignOut(auth); }
export { onAuthStateChanged };
