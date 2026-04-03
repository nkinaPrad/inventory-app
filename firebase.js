// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCFIsuTvfeadJXQOcIVGYtXHHQ4QV4BWhk",
  authDomain: "prad-kyouzai-inventory.firebaseapp.com",
  projectId: "prad-kyouzai-inventory",
  storageBucket: "prad-kyouzai-inventory.firebasestorage.app",
  messagingSenderId: "345351702509",
  appId: "1:345351702509:web:d05aef4bef07f09e0009e4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { app, db };