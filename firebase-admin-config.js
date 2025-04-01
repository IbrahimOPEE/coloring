const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Global flag to track if we're using unauthenticated mode
let isUnauthenticatedMode = false;

// Function to initialize Firebase Admin SDK
function initializeFirebaseAdmin() {
  try {
    // Check for environment variables first (Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        
        // Initialize Firebase Admin with environment variables
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
        });
        
        console.log('Firebase Admin SDK initialized successfully using environment variables');
        console.log('Project ID:', serviceAccount.project_id);
        
        return admin;
      } catch (parseError) {
        console.error('Error parsing FIREBASE_SERVICE_ACCOUNT environment variable:', parseError);
      }
    }
    
    // Fallback to service account file
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    
    // Check if service account file exists
    if (!fs.existsSync(serviceAccountPath)) {
      console.error('Service account key file not found at:', serviceAccountPath);
      console.error('Please ensure either the serviceAccountKey.json file is present or FIREBASE_SERVICE_ACCOUNT environment variable is set');
      console.warn('Proceeding in unauthenticated mode - results will be generated deterministically but not saved to Firestore');
      isUnauthenticatedMode = true;
      return {
        // Provide mock firestore methods
        firestore: () => ({
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: false, data: () => null }),
              set: async () => console.log('Mock firestore: document set (not actually saved)')
            }),
            orderBy: () => ({
              limit: () => ({
                get: async () => ({ 
                  empty: true,
                  forEach: () => {} 
                })
              })
            })
          })
        })
      };
    }
    
    // Load service account
    const serviceAccount = require(serviceAccountPath);
    
    // Validate service account data
    if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
      console.error('Invalid service account data. Missing required fields.');
      console.warn('Proceeding in unauthenticated mode - results will be generated deterministically but not saved to Firestore');
      isUnauthenticatedMode = true;
      return {
        // Provide mock firestore methods
        firestore: () => ({
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: false, data: () => null }),
              set: async () => console.log('Mock firestore: document set (not actually saved)')
            }),
            orderBy: () => ({
              limit: () => ({
                get: async () => ({ 
                  empty: true,
                  forEach: () => {} 
                })
              })
            })
          })
        })
      };
    }
    
    // Initialize Firebase Admin
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    
    console.log('Firebase Admin SDK initialized successfully using service account file');
    console.log('Project ID:', serviceAccount.project_id);
    
    // Set up global error handler for unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
    
    return admin;
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
    console.error('Stack trace:', error.stack);
    console.warn('Proceeding in unauthenticated mode - results will be generated deterministically but not saved to Firestore');
    isUnauthenticatedMode = true;
    return {
      // Provide mock firestore methods
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: false, data: () => null }),
            set: async () => console.log('Mock firestore: document set (not actually saved)')
          }),
          orderBy: () => ({
            limit: () => ({
              get: async () => ({ 
                empty: true,
                forEach: () => {} 
              })
            })
          })
        })
      })
    };
  }
}

// Initialize and export Firebase Admin
const firebaseAdmin = initializeFirebaseAdmin();

// Export both the admin instance, Firestore, and the authentication mode flag
module.exports = {
  admin: firebaseAdmin,
  firestore: firebaseAdmin.firestore(),
  isUnauthenticatedMode
}; 