const express = require('express');
const cors = require('cors');
const path = require('path');
const net = require('net');
const fs = require('fs');

// Import Firebase Admin from our configuration file
const { admin, firestore, isUnauthenticatedMode } = require('./firebase-admin-config');

const db = firestore;

// Path to local game history file
const LOCAL_HISTORY_FILE = path.join(__dirname, 'local_game_history.json');

// Global flag to track if the scheduler is running
let isSchedulerRunning = false;
let serverPort = 3456; // Fixed unique port number

const app = express();

// Configure CORS to allow requests from your domain
app.use(cors({
  origin: ['http://127.0.0.1:3456', 'http://localhost:3456'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Serve static files from the root directory
app.use(express.static(path.join(__dirname)));

// Handle favicon.ico request
app.get('/favicon.ico', (req, res) => {
  // Send a default favicon or a 204 No Content response
  res.status(204).end();
});

// Add global error handler for Firebase operations
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

// Global time sync endpoint
app.get('/api/time', (req, res) => {
  const now = new Date();
  const currentPeriod = getPeriod();
  const completedPeriod = getCompletedPeriod();
  
  res.json({ 
    serverTime: now.getTime(),
    currentPeriod,
    completedPeriod,
    currentSeconds: now.getSeconds(),
    milliseconds: now.getMilliseconds()
  });
});

// API endpoint to get server info including port
app.get('/api/server-info', (req, res) => {
  res.json({ 
    port: serverPort,
    serverTime: Date.now()
  });
});

// Add a route to serve the base URL configuration
app.get('/api/config', (req, res) => {
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const host = req.get('host');
  res.json({
    baseUrl: `${protocol}://${host}`,
    serverTime: Date.now()
  });
});

// Function to get previous results from Firestore
async function getPreviousResults(count = 2) {
  try {
    // Try to fetch the most recent results from Firestore
    const resultsSnapshot = await db.collection('gameResults')
      .orderBy('timestamp', 'desc')
      .limit(count)
      .get();
    
    if (resultsSnapshot.empty) {
      console.log(`No previous results found in Firestore`);
      return [];
    }
    
    const results = [];
    resultsSnapshot.forEach(doc => {
      results.push(doc.data());
    });
    
    console.log(`Retrieved ${results.length} previous results from Firestore`);
    return results;
  } catch (error) {
    console.error('Error fetching previous results:', error);
    return []; // Return empty array in case of error
  }
}

// Function to generate a mock result when Firestore is unavailable
async function generateMockResult(period) {
  // Convert period string to a better numeric seed
  const [datePart, periodPart] = period.split('-');
  // Extract components from datePart (YYMMDDHHMI format)
  const year = parseInt(datePart.substring(0, 2));
  const month = parseInt(datePart.substring(2, 4));
  const day = parseInt(datePart.substring(4, 6));
  const hour = parseInt(datePart.substring(6, 8));
  const minute = parseInt(datePart.substring(8, 10));
  
  // Create a more unique seed by combining all components
  const periodSeed = (year * 31 + day) * 24 * 60 + (hour * 60 + minute) + (periodPart === '1' ? 0 : 30);
  console.log('Using period seed for random generation:', periodSeed);
  
  // Improved seeded random function with better distribution
  const seededRandom = (salt = 1) => {
    let x = periodSeed + salt;
    x = ((x << 13) ^ x) * 0x45d9f3b;
    x = ((x << 17) ^ x) * 0x45d9f3b;
    x = (x ^ (x >> 15)) >>> 0;
    return (x % 1000000) / 1000000;
  };
  
  // Generate number first (0-9)
  const numberRandom = seededRandom(1);
  let number;
  
  // More balanced number distribution
  if (numberRandom < 0.1) {
    number = 0; // 10% chance for 0
  } else if (numberRandom < 0.2) {
    number = 5; // 10% chance for 5
  } else {
    // Distribute remaining numbers (1-4, 6-9) evenly
    const remainingNumbers = [1, 2, 3, 4, 6, 7, 8, 9];
    const index = Math.floor(seededRandom(2) * remainingNumbers.length);
    number = remainingNumbers[index];
  }
  
  // Determine color based on number and additional randomness
  let color;
  const colorRandom = seededRandom(3);
  
  if (number === 0) {
    color = 'VIOLET';
  } else if (number === 5) {
    color = colorRandom < 0.5 ? 'VIOLET' : 'VIOLET GREEN';
  } else if (number % 2 === 0) {
    color = 'RED';
  } else {
    color = 'GREEN';
  }
  
  // Determine size
  const size = number >= 5 ? 'BIG' : 'SMALL';
  
  const result = { 
    number, 
    size, 
    color,
    timestamp: new Date().toISOString(),
    period,
    isMock: false
  };
  
  console.log(`Generated deterministic result for period ${period}:`, result);
  return result;
}

// Result generation function with deterministic output
async function generateAndSaveResult(period) {
  try {
    // Check if a result already exists for this period
    let existingDoc;
    let existingResult = null;
    
    try {
      const docRef = db.collection('gameResults').doc(period);
      existingDoc = await docRef.get();
      if (existingDoc.exists) {
        console.log(`Result for period ${period} already exists, returning existing result`);
        existingResult = existingDoc.data();
        return existingResult;
      }
    } catch (authError) {
      console.error('Authentication error when checking for existing result:', authError);
      // Continue execution - we'll generate a deterministic result even if we can't save it
    }
    
    // Generate a deterministic result based on the period
    const result = await generateMockResult(period);
    
    // Save the result to Firestore if authentication is working
    try {
      if (!isUnauthenticatedMode) {
        await db.collection('gameResults').doc(period).set(result);
        console.log(`Result saved to Firestore for period ${period}`);
      } else {
        console.log(`Running in unauthenticated mode - result for period ${period} not saved to Firestore`);
      }
    } catch (saveError) {
      console.error('Error saving result to Firestore:', saveError);
      console.log(`Generated result for completed period ${period} after auth error:`, result);
      // Continue - we still want to return the deterministic result
    }
    
    // Save to local file as backup
    try {
      const historyData = await getLocalGameHistory();
      historyData.results = historyData.results || [];
      
      // Check if this period already exists in local history
      const existingIndex = historyData.results.findIndex(item => item.period === period);
      if (existingIndex >= 0) {
        historyData.results[existingIndex] = result;
      } else {
        historyData.results.push(result);
      }
      
      // Keep only the latest 100 results
      if (historyData.results.length > 100) {
        historyData.results = historyData.results.slice(-100);
      }
      
      await saveGameHistoryLocally(historyData);
      console.log(`Result also saved to local backup file for period ${period}`);
    } catch (localSaveError) {
      console.error('Error saving to local backup:', localSaveError);
    }
    
    return result;
  } catch (error) {
    console.error(`Error in generateAndSaveResult for period ${period}:`, error);
    // In case of any error, still return a deterministic result
    const fallbackResult = await generateMockResult(period);
    console.log(`Using fallback deterministic result for period ${period} after error:`, fallbackResult);
    return fallbackResult;
  }
}

// Get current period with server time
function getPeriod() {
  const now = new Date();
  // Round down to nearest 30 seconds to ensure consistency
  const roundedSeconds = Math.floor(now.getSeconds() / 30) * 30;
  const periodDate = new Date(now);
  periodDate.setSeconds(roundedSeconds);
  periodDate.setMilliseconds(0);
  
  const year = periodDate.getFullYear().toString().slice(-2);
  const month = (periodDate.getMonth() + 1).toString().padStart(2, '0');
  const day = periodDate.getDate().toString().padStart(2, '0');
  const hour = periodDate.getHours().toString().padStart(2, '0');
  const minute = periodDate.getMinutes().toString().padStart(2, '0');
  const periodSuffix = roundedSeconds === 0 ? '-1' : '-2';
  
  return `${year}${month}${day}${hour}${minute}${periodSuffix}`;
}

// Function to get the period that just completed
function getCompletedPeriod() {
  const now = new Date();
  
  // Round down to the last 30-second mark
  const currentSeconds = now.getSeconds();
  const completedTime = new Date(now);
  
  if (currentSeconds < 30) {
    // If we're in the first half, get the previous minute's second half
    completedTime.setMinutes(completedTime.getMinutes() - 1);
    completedTime.setSeconds(30);
  } else {
    // If we're in the second half, get this minute's first half
    completedTime.setSeconds(0);
  }
  completedTime.setMilliseconds(0);
  
  const year = completedTime.getFullYear().toString().slice(-2);
  const month = (completedTime.getMonth() + 1).toString().padStart(2, '0');
  const day = completedTime.getDate().toString().padStart(2, '0');
  const hour = completedTime.getHours().toString().padStart(2, '0');
  const minute = completedTime.getMinutes().toString().padStart(2, '0');
  const periodSuffix = completedTime.getSeconds() === 0 ? '-1' : '-2';
  
  return `${year}${month}${day}${hour}${minute}${periodSuffix}`;
}

// API endpoint to get the latest result
app.get('/api/latest-result', async (req, res) => {
  try {
    const completedPeriod = getCompletedPeriod();
    console.log('Getting result for completed period:', completedPeriod);
    
    // Generate new result for this period
    console.log('Generating new result for period:', completedPeriod);
    const result = await generateMockResult(completedPeriod);
    
    if (!result) {
      console.error('Failed to generate result');
      return res.status(500).json({ error: 'Failed to generate result' });
    }
    
    // Save to local storage
    try {
      // Get existing history
      let historyData = { results: [] };
      if (fs.existsSync(LOCAL_HISTORY_FILE)) {
        const fileContent = fs.readFileSync(LOCAL_HISTORY_FILE, 'utf8');
        historyData = JSON.parse(fileContent);
      }
      
      // Add new result
      if (!Array.isArray(historyData.results)) {
        historyData.results = [];
      }
      
      // Remove existing result for this period if any
      historyData.results = historyData.results.filter(r => r.period !== completedPeriod);
      
      // Add new result
      historyData.results.push(result);
      
      // Keep only latest 100 results
      if (historyData.results.length > 100) {
        historyData.results = historyData.results.slice(-100);
      }
      
      // Save back to file
      fs.writeFileSync(LOCAL_HISTORY_FILE, JSON.stringify(historyData, null, 2));
      console.log('Saved result to local storage:', result);
    } catch (saveError) {
      console.error('Error saving to local storage:', saveError);
      // Continue even if save fails
    }
    
    // Return the result
    console.log('Returning generated result:', result);
    return res.json(result);
    
  } catch (error) {
    console.error('Error in /api/latest-result:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
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

// Function to save game history to local file
async function saveGameHistoryLocally(historyData) {
  try {
    console.log('saveGameHistoryLocally called with data:', JSON.stringify(historyData));
    
    // Create an array if file doesn't exist
    let historyArray = [];
    
    // Read existing history if file exists
    if (fs.existsSync(LOCAL_HISTORY_FILE)) {
      console.log(`Local history file exists at ${LOCAL_HISTORY_FILE}`);
      try {
        const fileContent = fs.readFileSync(LOCAL_HISTORY_FILE, 'utf8');
        console.log('Read file content:', fileContent);
        historyArray = JSON.parse(fileContent);
        console.log('Parsed existing history, entries:', historyArray.length);
      } catch (parseError) {
        console.error('Error parsing local history file:', parseError);
        // If file is corrupted, start with empty array
        historyArray = [];
      }
    } else {
      console.log(`Local history file does not exist at ${LOCAL_HISTORY_FILE}, creating new file`);
    }
    
    // Add new history entry with timestamp
    historyData.savedAt = new Date().toISOString();
    historyArray.push(historyData);
    
    // Write back to file
    console.log(`Writing ${historyArray.length} entries to local history file`);
    fs.writeFileSync(LOCAL_HISTORY_FILE, JSON.stringify(historyArray, null, 2), 'utf8');
    console.log('Game history saved locally, entry ID:', historyArray.length);
    
    return { id: historyArray.length, success: true };
  } catch (error) {
    console.error('Error saving game history locally:', error);
    throw error;
  }
}

// Function to get local game history
function getLocalGameHistory() {
  try {
    if (fs.existsSync(LOCAL_HISTORY_FILE)) {
      const fileContent = fs.readFileSync(LOCAL_HISTORY_FILE, 'utf8');
      return JSON.parse(fileContent);
    }
    return [];
  } catch (error) {
    console.error('Error reading local game history:', error);
    return [];
  }
}

// API endpoint to get local game history
app.get('/api/local-history', (req, res) => {
  const history = getLocalGameHistory();
  res.json(history);
});

// Test endpoint to directly save to local history file
app.post('/api/test-local-save', (req, res) => {
  try {
    const testData = {
      period: 'test-period',
      number: 7,
      size: 'BIG',
      color: 'GREEN',
      userId: 'test-user',
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      isTest: true
    };
    
    console.log('Test endpoint called, saving test data to local file');
    
    // Create an array if file doesn't exist
    let historyArray = [];
    
    // Read existing history if file exists
    if (fs.existsSync(LOCAL_HISTORY_FILE)) {
      console.log(`Local history file exists at ${LOCAL_HISTORY_FILE}`);
      try {
        const fileContent = fs.readFileSync(LOCAL_HISTORY_FILE, 'utf8');
        console.log('Read file content:', fileContent);
        historyArray = JSON.parse(fileContent);
        console.log('Parsed existing history, entries:', historyArray.length);
      } catch (parseError) {
        console.error('Error parsing local history file:', parseError);
        // If file is corrupted, start with empty array
        historyArray = [];
      }
    } else {
      console.log(`Local history file does not exist at ${LOCAL_HISTORY_FILE}, creating new file`);
    }
    
    // Add new history entry with timestamp
    testData.savedAt = new Date().toISOString();
    historyArray.push(testData);
    
    // Write back to file
    console.log(`Writing ${historyArray.length} entries to local history file`);
    fs.writeFileSync(LOCAL_HISTORY_FILE, JSON.stringify(historyArray, null, 2), 'utf8');
    console.log('Test data saved locally, entry ID:', historyArray.length);
    
    res.json({ 
      success: true, 
      message: 'Test data saved to local history file',
      entryId: historyArray.length,
      data: testData
    });
  } catch (error) {
    console.error('Error in test endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack
    });
  }
});

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
      try {
        const docRef = db.collection('gameResults').doc(completedPeriod);
        existingResultDoc = await docRef.get(); // Use admin SDK directly
        
        if (!existingResultDoc.exists) {
          // Only generate a result if one doesn't already exist
          const result = await generateAndSaveResult(completedPeriod);
          console.log(`Generated result for completed period ${completedPeriod}:`, result);
        } else {
          console.log(`Result for period ${completedPeriod} already exists, skipping generation`);
        }
      } catch (authError) {
        console.error('Authentication error in result generation scheduler:', authError);
        // Try to generate a result anyway, our generateAndSaveResult function has fallbacks
        try {
          const result = await generateAndSaveResult(completedPeriod);
          console.log(`Generated result for completed period ${completedPeriod} after auth error:`, result);
        } catch (genError) {
          console.error('Failed to generate result after auth error:', genError);
        }
      }
    } catch (error) {
      console.error('Error generating result:', error);
    } finally {
      scheduleResultGeneration(); // Schedule next result
    }
  }, delay);
}

// Start the result generation scheduler
if (!isSchedulerRunning) {
  isSchedulerRunning = true;
  scheduleResultGeneration();
  console.log('Result generation scheduler started');
} else {
  console.log('Result generation scheduler already running, skipping initialization');
}

// Start the server
app.listen(serverPort, () => {
  console.log(`Server running on fixed port ${serverPort}`);
}); 