import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA23JoLWlOahEn2ZTuYKpLruXBbUy7uTwM",
  authDomain: "marsh-intel.firebaseapp.com",
  projectId: "marsh-intel",
  storageBucket: "marsh-intel.firebasestorage.app",
  messagingSenderId: "937027699274",
  appId: "1:937027699274:web:98588e9e42496a4635dcb3",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
