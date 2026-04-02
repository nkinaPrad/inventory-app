// firebase.js
// Firebase本体 / Authentication / Firestore を初期化するファイルです。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

// Firebase コンソールで発行された Web アプリ設定です。
// これは「接続先情報」であり、秘密鍵ではありません。
// ただし、これだけで安全になるわけではないため、
// Firestore Rules や Authentication の設定は別途必要です。
const firebaseConfig = {
  apiKey: "AIzaSyCFIsuTvfeadJXQOcIVGYtXHHQ4QV4BWhk",
  authDomain: "prad-kyouzai-inventory.firebaseapp.com",
  projectId: "prad-kyouzai-inventory",
  storageBucket: "prad-kyouzai-inventory.firebasestorage.app",
  messagingSenderId: "345351702509",
  appId: "1:345351702509:web:d05aef4bef07f09e0009e4"
};

// Firebase アプリ本体を初期化
const app = initializeApp(firebaseConfig);

// Authentication を初期化
const auth = getAuth(app);

// Firestore を初期化
const db = getFirestore(app);

// Google ログイン用の Provider
const googleProvider = new GoogleAuthProvider();

// 毎回アカウント選択を出したい場合
googleProvider.setCustomParameters({
  prompt: "select_account"
});

// 必要なものを他ファイルから使えるように export
export {
  app,
  auth,
  db,
  googleProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
};
