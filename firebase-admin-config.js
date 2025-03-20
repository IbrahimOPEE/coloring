const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Function to initialize Firebase Admin SDK
function initializeFirebaseAdmin() {
  try {
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    
    // Check if service account file exists
    if (!fs.existsSync(serviceAccountPath)) {
      console.error('Service account key file not found at:', serviceAccountPath);
      throw new Error('Firebase service account key file not found');
    }
    
    // Load service account
    const serviceAccount = require(serviceAccountPath);
    
    // Initialize Firebase Admin
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    
    console.log('Firebase Admin SDK initialized successfully');
    
    // Set up global error handler for unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
    
    return admin;
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
    throw error;
  }
}

// Initialize and export Firebase Admin
const firebaseAdmin = initializeFirebaseAdmin();

// Export both the admin instance and Firestore
module.exports = {
  admin: firebaseAdmin,
  firestore: firebaseAdmin.firestore()
}; 