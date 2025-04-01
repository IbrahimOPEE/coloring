const express = require('express');
const cors = require('cors');
const path = require('path');
const net = require('net');
const fs = require('fs');

// Import Firebase Admin from our configuration file
const { admin, firestore } = require('./firebase-admin-config');

const db = firestore;

// Path to local game history file
const LOCAL_HISTORY_FILE = path.join(__dirname, 'local_game_history.json');

// Global flag to track if the scheduler is running
let isSchedulerRunning = false;
let serverPort = process.env.PORT || 3000; // Use environment PORT or default to 3000

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
  // In production (Render), always use the provided PORT
  if (process.env.PORT) {
    return process.env.PORT;
  }
  
  // Only search for available port in development
  let port = startPort;
  while (await isPortInUse(port)) {
    console.log(`Port ${port} is in use, trying next port`);
    port++;
  }
  return port;
}

const app = express();

// Configure CORS to allow requests from your domain
app.use(cors({
  origin: ['https://coloring-uv3a.onrender.com', 'http://localhost:3000'],
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
  // Get previous results to check for patterns
  const previousResults = await getPreviousResults(2);
  
  // Extract previous colors and sizes if they exist
  const prevColors = previousResults.map(r => r.color);
  const prevSizes = previousResults.map(r => r.size);
  const prevNumbers = previousResults.map(r => r.number);
  
  console.log('Previous colors:', prevColors);
  console.log('Previous sizes:', prevSizes);
  console.log('Previous numbers:', prevNumbers);
  
  // Generate a deterministic result based on the period
  // Use the period string as the seed for random generation
  let color, number, size;
  
  // Convert period string to a numeric seed
  const periodSeed = parseInt(period.replace(/\D/g, '')) || Date.now();
  console.log('Using period seed for random generation:', periodSeed);
  
  // Simple deterministic random function using the period seed
  const seededRandom = () => {
    // Simple LCG (Linear Congruential Generator) using the periodSeed
    let x = periodSeed;
    // These are standard values for a simple LCG
    const a = 1664525;
    const c = 1013904223;
    const m = Math.pow(2, 32);
    x = (a * x + c) % m;
    return x / m; // Normalize to [0, 1)
  };
  
  // Generate color with deterministic logic
  const colorRandom = seededRandom() * 100;
  
  if (prevColors.length >= 2 && prevColors[0] === prevColors[1]) {
    // If the same color appeared twice in a row, ensure we choose a different one
    if (prevColors[0] === 'RED') {
      color = colorRandom < 50 ? 'GREEN' : 'VIOLET';
    } else if (prevColors[0] === 'GREEN') {
      color = colorRandom < 50 ? 'RED' : 'VIOLET';
    } else {
      // If previous was VIOLET or VIOLET GREEN
      color = colorRandom < 50 ? 'RED' : 'GREEN';
    }
  } else {
    // Normal distribution: 45% red, 45% green, 10% violet
    if (colorRandom < 45) {
      color = 'RED';
    } else if (colorRandom < 90) {
      color = 'GREEN';
    } else {
      color = 'VIOLET';
    }
  }
  
  // Generate number based on color
  if (color === 'VIOLET') {
    // For violet, we can only have 0 or 5
    number = seededRandom() < 0.5 ? 0 : 5;
    
    // If number is 5, it's both VIOLET and GREEN
    if (number === 5) {
      color = 'VIOLET GREEN';
    }
  } else if (color === 'RED') {
    // For red, we need even numbers except 0
    const evenNumbers = [2, 4, 6, 8];
    const randomIndex = Math.floor(seededRandom() * evenNumbers.length);
    number = evenNumbers[randomIndex];
  } else {
    // For green, we need odd numbers except 5 (already covered in VIOLET)
    const oddNumbers = [1, 3, 7, 9];
    const randomIndex = Math.floor(seededRandom() * oddNumbers.length);
    number = oddNumbers[randomIndex];
  }
  
  // Determine size based on number
  size = number >= 5 ? 'BIG' : 'SMALL';
  
  console.log(`Generated deterministic result for period ${period}: ${color}, ${number}, ${size}`);
  
  return { 
    number, 
    size, 
    color,
    timestamp: new Date().toISOString(),
    period,
    isMock: false
  };
}

// Result generation function with deterministic output
async function generateAndSaveResult(period) {
  try {
    // Check if a result already exists for this period
    let existingDoc;
    try {
      const docRef = db.collection('gameResults').doc(period);
      existingDoc = await docRef.get();
      if (existingDoc.exists) {
        console.log(`Result for period ${period} already exists, returning existing result`);
        return existingDoc.data();
      }
    } catch (authError) {
      console.error('Authentication error when checking for existing result:', authError);
    }
    
    // Generate a deterministic result based on the period
    const result = await generateMockResult(period);
    
    // Save the result to Firestore
    try {
      await db.collection('gameResults').doc(period).set({
        ...result,
        timestamp: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        period: period
      });
      console.log(`Result saved to Firestore for period ${period}`);
    } catch (error) {
      console.error(`Error saving result to Firestore:`, error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in generateAndSaveResult:', error);
    return null;
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
    
    // Try to get existing result first
    const docRef = db.collection('gameResults').doc(completedPeriod);
    const doc = await docRef.get();
    
    if (doc.exists) {
      console.log('Found existing result for period:', completedPeriod);
      return res.json(doc.data());
    }
    
    // If no result exists, generate one
    console.log('No existing result found, generating new result for period:', completedPeriod);
    const result = await generateAndSaveResult(completedPeriod);
    
    if (result) {
      res.json(result);
    } else {
      res.status(500).json({ error: 'Failed to generate result' });
    }
  } catch (error) {
    console.error('Error in /api/latest-result:', error);
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