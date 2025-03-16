const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const net = require('net');

// Global flag to track if the scheduler is running
let isSchedulerRunning = false;
let serverPort = 3000; // Default port, will be updated when server starts

// Add a flag to track if Firebase is available
let isFirebaseAvailable = true;
let localGameResults = {}; // In-memory storage for results when Firebase is unavailable
let localGameHistory = []; // In-memory storage for game history when Firebase is unavailable
let pendingSyncOperations = []; // Queue of operations to sync when Firebase becomes available again

// Function to check if a port is in use
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', () => {
        resolve(true); // Port is in use
      })
      .once('listening', () => {
        server.close();
        resolve(false); // Port is free
      })
      .listen(port);
  });
}

// Function to find an available port
async function findAvailablePort(startPort) {
  let port = startPort;
  while (await isPortInUse(port)) {
    console.log(`Port ${port} is in use, trying next port`);
    port++;
  }
  return port;
}

const app = express();

// Configure CORS to allow requests from any origin
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Serve static files from the root directory
app.use(express.static(path.join(__dirname)));

// Initialize Firebase Admin
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // If running on Render or other cloud platform, use environment variable
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // If running locally, use the service account file
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (error) {
    console.error('Error loading service account key file:', error);
    console.error('Please make sure serviceAccountKey.json exists or set FIREBASE_SERVICE_ACCOUNT environment variable');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Global time sync endpoint
app.get('/api/time', (req, res) => {
  res.json({ serverTime: Date.now() });
});

// API endpoint to get server info including port
app.get('/api/server-info', (req, res) => {
  res.json({ 
    port: serverPort,
    serverTime: Date.now()
  });
});

// Function to check Firebase connectivity
async function checkFirebaseConnectivity() {
  try {
    // Try to read a document from Firestore
    await db.collection('gameResults').limit(1).get();
    
    if (!isFirebaseAvailable) {
      console.log('Firebase connection restored');
      isFirebaseAvailable = true;
      
      // Sync pending operations
      await syncPendingOperations();
    }
    return true;
  } catch (error) {
    if (isFirebaseAvailable) {
      console.error('Firebase connection lost, switching to local mode:', error);
      isFirebaseAvailable = false;
    }
    return false;
  }
}

// Function to sync pending operations when Firebase becomes available
async function syncPendingOperations() {
  if (!isFirebaseAvailable || pendingSyncOperations.length === 0) {
    return;
  }
  
  console.log(`Attempting to sync ${pendingSyncOperations.length} pending operations to Firebase`);
  
  const operationsToProcess = [...pendingSyncOperations];
  pendingSyncOperations = []; // Clear the queue
  
  for (const operation of operationsToProcess) {
    try {
      if (operation.type === 'gameResult') {
        // Convert JS Date to Firestore timestamp
        const resultData = {...operation.data};
        resultData.timestamp = admin.firestore.Timestamp.fromDate(new Date(resultData.timestamp));
        
        await db.collection('gameResults').doc(operation.id).set(resultData);
        console.log(`Synced game result for period ${operation.id} to Firebase`);
      } else if (operation.type === 'gameHistory') {
        // Convert JS Date to Firestore timestamp if needed
        const historyData = {...operation.data};
        if (historyData.timestamp) {
          historyData.timestamp = admin.firestore.Timestamp.fromDate(new Date(historyData.timestamp));
        }
        
        await db.collection('gameHistory').add(historyData);
        console.log(`Synced game history for user ${historyData.userId} for period ${historyData.period} to Firebase`);
      }
    } catch (error) {
      console.error(`Error syncing operation to Firebase:`, error);
      // Put the operation back in the queue
      pendingSyncOperations.push(operation);
    }
  }
  
  console.log(`Sync completed. ${pendingSyncOperations.length} operations remaining.`);
}

// Schedule regular checks of Firebase connectivity
setInterval(checkFirebaseConnectivity, 60000); // Check every minute

// Modified generateAndSaveResult to use local storage when Firebase is unavailable
async function generateAndSaveResult(period) {
  try {
    // Check if Firebase is available
    const firebaseAvailable = await checkFirebaseConnectivity();
    
    // Check if a result already exists for this period
    let existingResult = null;
    
    if (firebaseAvailable) {
      try {
        const existingDoc = await db.collection('gameResults').doc(period).get();
        if (existingDoc.exists) {
          console.log(`Result for period ${period} already exists in Firebase, returning existing result`);
          return existingDoc.data();
        }
      } catch (dbError) {
        console.error(`Error checking for existing result in Firebase for period ${period}:`, dbError);
        // Fall back to local storage
        isFirebaseAvailable = false;
      }
    }
    
    // Check local storage if Firebase is unavailable or check failed
    if (!isFirebaseAvailable && localGameResults[period]) {
      console.log(`Result for period ${period} already exists in local storage, returning existing result`);
      return localGameResults[period];
    }

    // Use crypto for better randomness
    const crypto = require('crypto');
    
    // Generate a truly random number between 0-9
    const randomBytes = crypto.randomBytes(1);
    const number = randomBytes[0] % 10;
    
    // Determine size based on number
    const size = number >= 5 ? 'BIG' : 'SMALL';
    
    // Determine color based on number
    let color;
    if (number === 0) {
      color = 'VIOLET';
    } else if (number === 5) {
      // Make 5 sometimes VIOLET and sometimes GREEN
      const colorRandom = crypto.randomBytes(1)[0] % 2;
      color = colorRandom === 0 ? 'VIOLET GREEN' : 'GREEN';
    } else if (number % 2 === 0) {
      color = 'RED';
    } else {
      color = 'GREEN';
    }
    
    const timestamp = new Date();
    const result = { 
      number, 
      size, 
      color,
      timestamp,
      period
    };

    // Save to appropriate storage
    if (isFirebaseAvailable) {
      try {
        // Add server timestamp for Firebase
        const firestoreResult = {...result};
        firestoreResult.timestamp = admin.firestore.FieldValue.serverTimestamp();
        await db.collection('gameResults').doc(period).set(firestoreResult);
        console.log(`Result for period ${period} saved to Firebase:`, result);
        
        // Also save to gameHistory collection for all users
        try {
          // Get all users
          const usersSnapshot = await db.collection('users').get();
          const savePromises = [];
          
          usersSnapshot.forEach(userDoc => {
            const userId = userDoc.id;
            const historyData = {
              period: period,
              number: result.number,
              size: result.size,
              color: result.color,
              userId: userId,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              createdAt: new Date().toISOString()
            };
            
            savePromises.push(
              db.collection('gameHistory').add(historyData)
                .then(() => console.log(`Game history saved for user ${userId} for period ${period}`))
                .catch(err => console.error(`Error saving game history for user ${userId}:`, err))
            );
          });
          
          await Promise.all(savePromises);
          console.log(`Game history saved for all users for period ${period}`);
        } catch (historyError) {
          console.error('Error saving to game history:', historyError);
          // Continue even if history saving fails
        }
      } catch (saveError) {
        console.error(`Error saving result to Firebase for period ${period}:`, saveError);
        // Fall back to local storage
        isFirebaseAvailable = false;
        localGameResults[period] = result;
        console.log(`Result for period ${period} saved to local storage:`, result);
        
        // Queue the operation for later sync
        pendingSyncOperations.push({
          type: 'gameResult',
          id: period,
          data: result
        });
        
        // Also save to local game history
        await saveToLocalGameHistory(result);
      }
    } else {
      // Save to local storage
      localGameResults[period] = result;
      console.log(`Result for period ${period} saved to local storage:`, result);
      
      // Queue the operation for later sync
      pendingSyncOperations.push({
        type: 'gameResult',
        id: period,
        data: result
      });
      
      // Also save to local game history
      await saveToLocalGameHistory(result);
    }
    
    return result;
  } catch (error) {
    console.error(`Error in generateAndSaveResult for period ${period}:`, error);
    
    // Return a fallback result if we can't generate or save the real one
    const fallbackResult = {
      number: Math.floor(Math.random() * 10),
      size: Math.random() >= 0.5 ? 'BIG' : 'SMALL',
      color: Math.random() >= 0.5 ? 'RED' : 'GREEN',
      timestamp: new Date(),
      period,
      isFallback: true
    };
    
    // Save fallback to local storage
    localGameResults[period] = fallbackResult;
    
    // Queue the operation for later sync
    pendingSyncOperations.push({
      type: 'gameResult',
      id: period,
      data: fallbackResult
    });
    
    // Also save to local game history
    await saveToLocalGameHistory(fallbackResult);
    
    console.log(`Generated fallback result for period ${period} due to error:`, fallbackResult);
    return fallbackResult;
  }
}

// Function to save to local game history
async function saveToLocalGameHistory(result) {
  try {
    // Try to get users from Firebase if available
    let users = [];
    
    if (isFirebaseAvailable) {
      try {
        const usersSnapshot = await db.collection('users').get();
        usersSnapshot.forEach(userDoc => {
          users.push(userDoc.id);
        });
      } catch (error) {
        console.error('Error fetching users from Firebase:', error);
        // If we can't get users, create a default entry
        users = ['default'];
      }
    } else {
      // If Firebase is unavailable, create a default entry
      users = ['default'];
    }
    
    // Create history entries for each user
    for (const userId of users) {
      const historyData = {
        period: result.period,
        number: result.number,
        size: result.size,
        color: result.color,
        userId: userId,
        timestamp: new Date(),
        createdAt: new Date().toISOString()
      };
      
      // Add to local history
      localGameHistory.push(historyData);
      
      // Queue for later sync to Firebase
      pendingSyncOperations.push({
        type: 'gameHistory',
        data: historyData
      });
    }
    
    console.log(`Game history saved locally for period ${result.period}`);
    return true;
  } catch (error) {
    console.error('Error saving to local game history:', error);
    return false;
  }
}

// API endpoint to get game history for a user
app.get('/api/game-history/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Check if Firebase is available
    const firebaseAvailable = await checkFirebaseConnectivity();
    
    let historyData = [];
    
    if (firebaseAvailable) {
      try {
        // Try to get history from Firebase
        const historySnapshot = await db.collection('gameHistory')
          .where('userId', '==', userId)
          .orderBy('timestamp', 'desc')
          .limit(50)
          .get();
        
        historySnapshot.forEach(doc => {
          historyData.push(doc.data());
        });
      } catch (dbError) {
        console.error(`Error fetching game history from Firebase for user ${userId}:`, dbError);
        // Fall back to local storage
        isFirebaseAvailable = false;
      }
    }
    
    // If Firebase is unavailable or no data was found, use local history
    if (!firebaseAvailable || historyData.length === 0) {
      // Filter local history for this user
      historyData = localGameHistory
        .filter(entry => entry.userId === userId || entry.userId === 'default')
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 50);
      
      console.log(`Using local game history for user ${userId}`);
    }
    
    res.json(historyData);
  } catch (error) {
    console.error('Error fetching game history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get the latest result
app.get('/api/latest-result', async (req, res) => {
  try {
    // Get the current period
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hour = now.getHours().toString().padStart(2, '0');
    const minute = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds();
    
    // Determine the completed period
    let completedPeriod;
    if (seconds < 30) {
      // If we're in the first half of the minute, the completed period was the second half of the previous minute
      const prevMinute = new Date(now);
      prevMinute.setSeconds(0);
      prevMinute.setMinutes(prevMinute.getMinutes() - 1);
      
      const prevYear = prevMinute.getFullYear().toString().slice(-2);
      const prevMonth = (prevMinute.getMonth() + 1).toString().padStart(2, '0');
      const prevDay = prevMinute.getDate().toString().padStart(2, '0');
      const prevHour = prevMinute.getHours().toString().padStart(2, '0');
      const prevMinute2 = prevMinute.getMinutes().toString().padStart(2, '0');
      
      completedPeriod = `${prevYear}${prevMonth}${prevDay}${prevHour}${prevMinute2}-2`;
    } else {
      // If we're in the second half of the minute, the completed period was the first half of the current minute
      completedPeriod = `${year}${month}${day}${hour}${minute}-1`;
    }
    
    console.log(`Getting result for completed period ${completedPeriod}`);
    
    // Check if Firebase is available
    const firebaseAvailable = await checkFirebaseConnectivity();
    
    let result = null;
    
    if (firebaseAvailable) {
      try {
        // Try to get result from Firebase
        const resultDoc = await db.collection('gameResults').doc(completedPeriod).get();
        
        if (resultDoc.exists) {
          result = resultDoc.data();
          console.log(`Result found in Firebase for period ${completedPeriod}:`, result);
        } else {
          console.log(`No result found in Firebase for period ${completedPeriod}, generating new result`);
          result = await generateAndSaveResult(completedPeriod);
        }
      } catch (dbError) {
        console.error(`Error fetching result from Firebase for period ${completedPeriod}:`, dbError);
        // Fall back to local storage
        isFirebaseAvailable = false;
      }
    }
    
    // If Firebase is unavailable or no result was found, check local storage
    if (!firebaseAvailable || !result) {
      if (localGameResults[completedPeriod]) {
        result = localGameResults[completedPeriod];
        console.log(`Using result from local storage for period ${completedPeriod}.`);
      } else {
        console.log(`No result found in local storage for period ${completedPeriod}, generating new result`);
        result = await generateAndSaveResult(completedPeriod);
      }
    }
    
    // Convert Firestore timestamp to regular date if needed
    if (result && result.timestamp && typeof result.timestamp.toDate === 'function') {
      result = {
        ...result,
        timestamp: result.timestamp.toDate()
      };
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error getting latest result:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to manually trigger result generation (for testing)
app.post('/api/generate-result', async (req, res) => {
  try {
    // If a specific period is provided, use it; otherwise use the most recently completed period
    const period = req.body.period || getCompletedPeriod();
    
    // Check if the requested period is the current (incomplete) period
    const currentPeriod = getPeriod();
    if (period === currentPeriod) {
      return res.status(400).json({ 
        error: 'Cannot generate result for current period before it ends',
        currentPeriod,
        message: 'Results can only be generated for completed periods'
      });
    }
    
    const result = await generateAndSaveResult(period);
    res.json(result);
  } catch (error) {
    console.error('Error generating result:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Get current period
function getPeriod() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hour = now.getHours().toString().padStart(2, '0');
  const minute = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds();
  const periodSuffix = seconds < 30 ? '-1' : '-2';
  
  return `${year}${month}${day}${hour}${minute}${periodSuffix}`;
}

// Function to get the previous period
function getPreviousPeriod() {
  const now = new Date();
  now.setSeconds(now.getSeconds() - 30); // Go back 30 seconds
  return getPeriod(now);
}

// Result generation scheduler
async function scheduleResultGeneration() {
  const now = new Date();
  const seconds = now.getSeconds();
  
  // Calculate when the next period ends (either at :00 or :30 seconds)
  const nextPeriodEnd = seconds < 30 ? 30 : 60;
  const delay = (nextPeriodEnd - seconds) * 1000 - now.getMilliseconds();
  
  setTimeout(async () => {
    try {
      // Get the period that just ended
      const completedPeriod = getCompletedPeriod();
      
      // Check if a result already exists for this period
      let existingResultDoc;
      let resultExists = false;
      
      try {
        existingResultDoc = await db.collection('gameResults').doc(completedPeriod).get();
        resultExists = existingResultDoc.exists;
      } catch (checkError) {
        console.error(`Error checking if result exists for period ${completedPeriod}:`, checkError);
        // Continue with generation even if check fails
      }
      
      if (!resultExists) {
        // Only generate a result if one doesn't already exist
        try {
          const result = await generateAndSaveResult(completedPeriod);
          console.log(`Generated result for completed period ${completedPeriod}:`, result);
        } catch (genError) {
          console.error(`Error generating result for period ${completedPeriod}:`, genError);
          // The generateAndSaveResult function now handles errors internally
        }
      } else {
        console.log(`Result for period ${completedPeriod} already exists, skipping generation`);
      }
    } catch (error) {
      console.error('Error in result generation scheduler:', error);
      // Continue scheduling even if there's an error
    } finally {
      // Always schedule the next result generation, even if there was an error
      scheduleResultGeneration();
    }
  }, delay);
}

// Function to get the period that just completed
function getCompletedPeriod() {
  const now = new Date();
  
  // Create a copy of the current time
  const completedTime = new Date(now);
  
  // Adjust the time to the previous period end
  const seconds = now.getSeconds();
  if (seconds < 30) {
    // If we're in the first half of the minute, the completed period was the second half of the previous minute
    completedTime.setSeconds(0);
    completedTime.setMinutes(completedTime.getMinutes() - 1);
    completedTime.setSeconds(30);
  } else {
    // If we're in the second half of the minute, the completed period was the first half of the current minute
    completedTime.setSeconds(0);
  }
  
  const year = completedTime.getFullYear().toString().slice(-2);
  const month = (completedTime.getMonth() + 1).toString().padStart(2, '0');
  const day = completedTime.getDate().toString().padStart(2, '0');
  const hour = completedTime.getHours().toString().padStart(2, '0');
  const minute = completedTime.getMinutes().toString().padStart(2, '0');
  const periodSuffix = completedTime.getSeconds() < 30 ? '-1' : '-2';
  
  return `${year}${month}${day}${hour}${minute}${periodSuffix}`;
}

// Function to get the period before the most recently completed period
function getPreviousCompletedPeriod() {
  const now = new Date();
  
  // Create a copy of the current time
  const previousCompletedTime = new Date(now);
  
  // Adjust the time to the period before the most recently completed period
  const seconds = now.getSeconds();
  if (seconds < 30) {
    // If we're in the first half of the minute, go back to the first half of the previous minute
    previousCompletedTime.setMinutes(previousCompletedTime.getMinutes() - 1);
    previousCompletedTime.setSeconds(0);
  } else {
    // If we're in the second half of the minute, go back to the second half of the previous minute
    previousCompletedTime.setMinutes(previousCompletedTime.getMinutes() - 1);
    previousCompletedTime.setSeconds(30);
  }
  
  const year = previousCompletedTime.getFullYear().toString().slice(-2);
  const month = (previousCompletedTime.getMonth() + 1).toString().padStart(2, '0');
  const day = previousCompletedTime.getDate().toString().padStart(2, '0');
  const hour = previousCompletedTime.getHours().toString().padStart(2, '0');
  const minute = previousCompletedTime.getMinutes().toString().padStart(2, '0');
  const periodSuffix = previousCompletedTime.getSeconds() < 30 ? '-1' : '-2';
  
  return `${year}${month}${day}${hour}${minute}${periodSuffix}`;
}

// Start the result generation scheduler
if (!isSchedulerRunning) {
  isSchedulerRunning = true;
  scheduleResultGeneration();
  console.log('Result generation scheduler started');
} else {
  console.log('Result generation scheduler already running, skipping initialization');
}

// Start the server on an available port
const DEFAULT_PORT = process.env.PORT || 3000;

// Use an immediately invoked async function to start the server
(async () => {
  try {
    const availablePort = await findAvailablePort(DEFAULT_PORT);
    serverPort = availablePort; // Store the actual port being used
    app.listen(availablePort, () => {
      console.log(`Server running on port ${availablePort}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
  }
})(); 