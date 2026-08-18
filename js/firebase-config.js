// Config del proyecto Firebase de Examnio — única fuente de verdad,
// compartida por examen.js y profesor.js (antes duplicada en ambos HTML).
// El apiKey de Firebase Web no es secreto por diseño: el acceso real se
// controla con las reglas de seguridad de Firestore, no ocultando esta config.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';

export const firebaseConfig = {
  apiKey:"AIzaSyBtdSxcbzXOOaX3zzQ6DC9fEV6Sx6P-9Jw",
  authDomain:"examinador-7afb6.firebaseapp.com",
  projectId:"examinador-7afb6",
  storageBucket:"examinador-7afb6.firebasestorage.app",
  messagingSenderId:"701854685959",
  appId:"1:701854685959:web:6c54d2562e5b445f5d43a2"
};

export const app = initializeApp(firebaseConfig);
