/**
 * 揪咖 JioKa2 前端設定
 * 【部署前必改】以下兩個值，取得方式見 README.md / guide.html
 */
window.JIOKA_CONFIG = {
  // 你的 Firebase 專案設定物件（Firebase Console → 專案設定 →「你的應用程式」→ SDK 設定與程式碼 → 設定物件）
  firebase: {
    apiKey: 'YOUR_FIREBASE_API_KEY',
    authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT_ID.appspot.com',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
  },

  // 你的 Google OAuth 2.0 Client ID（Web 應用程式類型）
  // 就是 Firebase Authentication 啟用 Google 登入方式時，主控台顯示的那組「網路用戶端 ID」
  GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
};
