// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCHaGjJ-t3DCE7xY08C6aV7w35xxjMZpdc",
    authDomain: "coloring-705b5.firebaseapp.com",
    projectId: "coloring-705b5",
    storageBucket: "coloring-705b5.firebasestorage.app",
    messagingSenderId: "686022960865",
    appId: "1:686022960865:web:a9a5203d8b7d98f98ab9a0",
    measurementId: "G-3MZYE1BP0K"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Get Firestore reference
const db = firebase.firestore();

// Collection references
const collections = {
    users: db.collection('users'),
    transactions: db.collection('transactions'),
    dailyTransactions: db.collection('dailyTransactions'),
    gameHistory: db.collection('gameHistory'),
    gameState: db.collection('gameState'),
    gameResults: db.collection('gameResults')
};

// Auth reference
const auth = firebase.auth(); 