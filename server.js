const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const serviceAccount = require('./serviceAccountKey.json');
const path = require('path');
const net = require('net');

// Global flag to track if the scheduler is running
let isSchedulerRunning = false;
let serverPort = 3000; // Default port, will be updated when server starts

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
app.use(cors());
app.use(express.json());

// Serve static files from the root directory
app.use(express.static(path.join(__dirname)));

// Initialize Firebase Admin
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

// API endpoint to get the latest result
app.get('/api/latest-result', async (req, res) => {
  try {
    // Get the most recently completed period
    const completedPeriod = getCompletedPeriod();
    
    // Try to get the result for the completed period
    let resultDoc = await db.collection('gameResults').doc(completedPeriod).get();
    
    if (!resultDoc.exists) {
      // If no result for the most recent completed period, try the period before that
      const previousCompletedPeriod = getPreviousCompletedPeriod();
      resultDoc = await db.collection('gameResults').doc(previousCompletedPeriod).get();
    }
    
    if (resultDoc.exists) {
      res.json(resultDoc.data());
    } else {
      res.status(404).json({ error: 'No result found for completed periods' });
    }
  } catch (error) {
    console.error('Error fetching latest result:', error);
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

// Result generation function
async function generateAndSaveResult(period) {
  try {
    // Check if a result already exists for this period
    const existingDoc = await db.collection('gameResults').doc(period).get();
    if (existingDoc.exists) {
      console.log(`Result for period ${period} already exists, returning existing result`);
      return existingDoc.data();
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
    
    const result = { 
      number, 
      size, 
      color,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      period
    };

    // Save to gameResults collection
    await db.collection('gameResults').doc(period).set(result);
    console.log(`Result for period ${period} saved to gameResults:`, result);
    
    // Also save to gameHistory collection for all users
    // This is a workaround since users can only see their own history based on rules
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
    
    return result;
  } catch (error) {
    console.error(`Error in generateAndSaveResult for period ${period}:`, error);
    throw error;
  }
}

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
      const existingResultDoc = await db.collection('gameResults').doc(completedPeriod).get();
      
      if (!existingResultDoc.exists) {
        // Only generate a result if one doesn't already exist
        const result = await generateAndSaveResult(completedPeriod);
        console.log(`Generated result for completed period ${completedPeriod}:`, result);
      } else {
        console.log(`Result for period ${completedPeriod} already exists, skipping generation`);
      }
    } catch (error) {
      console.error('Error generating result:', error);
    }
    scheduleResultGeneration(); // Schedule next result
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