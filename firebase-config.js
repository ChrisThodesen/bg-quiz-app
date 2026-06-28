import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
  push
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBUZNAtqJ3rDlurVK3IC28IeSnq5kfyX3o",
  authDomain: "bg-smart-metering-training.firebaseapp.com",
  databaseURL: "https://bg-smart-metering-training-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bg-smart-metering-training",
  storageBucket: "bg-smart-metering-training.firebasestorage.app",
  messagingSenderId: "543622658220",
  appId: "1:543622658220:web:03675a2fa06f020bed4709",
  measurementId: "G-34WCJKLNGF"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);

export {
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
  push
};
