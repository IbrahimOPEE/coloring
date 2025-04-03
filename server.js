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

// Track bets for current period
let currentPeriodBets = {
  period: '',
  bets: {
    RED: 0,
    GREEN: 0,
    VIOLET: 0
  },
  numbers: {
    0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 
    5: 0, 6: 0, 7: 0, 8: 0, 9: 0
  },
  sizes: {
    BIG: 0,
    SMALL: 0
  },
  timestamp: new Date()
};

const app = express();

// Configure CORS to allow requests from your domain
app.use(cors({
  origin: ['https://coloring-uv3a.onrender.com', 'http://localhost:3456', 'http://127.0.0.1:3456'],
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

// New endpoint to track bets in real-time
app.post('/api/place-bet', async (req, res) => {
  try {
    const { userId, betType, betValue, amount, period } = req.body;
    
    if (!userId || !betType || !betValue || !amount || !period) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const currentPeriod = getPeriod();
    if (period !== currentPeriod) {
      return res.status(400).json({ error: 'Invalid period', currentPeriod });
    }
    
    // Reset bet tracking if period has changed
    if (currentPeriodBets.period !== currentPeriod) {
      currentPeriodBets = {
        period: currentPeriod,
        bets: { RED: 0, GREEN: 0, VIOLET: 0 },
        numbers: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
        sizes: { BIG: 0, SMALL: 0 },
        timestamp: new Date()
      };
    }
    
    // Track the bet based on type
    if (betType === 'color') {
      currentPeriodBets.bets[betValue] = (currentPeriodBets.bets[betValue] || 0) + 1;
    } else if (betType === 'number') {
      currentPeriodBets.numbers[betValue] = (currentPeriodBets.numbers[betValue] || 0) + 1;
    } else if (betType === 'size') {
      currentPeriodBets.sizes[betValue] = (currentPeriodBets.sizes[betValue] || 0) + 1;
    }
    
    // Store the bet in Firestore
    try {
      // Record the individual bet
      await db.collection('bets').add({
        userId,
        betType,
        betValue,
        amount,
        period,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Update period bets collection with aggregated data
      await db.collection('periodBets').doc(currentPeriod).set(currentPeriodBets, { merge: true });
      
      console.log(`Bet placed: User ${userId} bet ${amount} on ${betValue} (${betType}) for period ${period}`);
      
    } catch (firestoreError) {
      console.error('Error saving bet to Firestore:', firestoreError);
      // Continue even if Firestore fails
    }
    
    res.json({ 
      success: true, 
      message: 'Bet placed successfully',
      currentBets: currentPeriodBets
    });
    
  } catch (error) {
    console.error('Error processing bet:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// New endpoint to get current bets
app.get('/api/current-bets', (req, res) => {
  const currentPeriod = getPeriod();
  
  // Update period if needed
  if (currentPeriodBets.period !== currentPeriod) {
    currentPeriodBets.period = currentPeriod;
    currentPeriodBets.timestamp = new Date();
  }
  
  res.json(currentPeriodBets);
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

// Modified function to generate result based on minority bets
async function generateMockResult(period) {
  try {
    // Try to get saved bets for this period
    let periodBetsData;
    
    try {
      const periodBetsDoc = await db.collection('periodBets').doc(period).get();
      if (periodBetsDoc.exists) {
        periodBetsData = periodBetsDoc.data();
        console.log(`Using saved bets data for period ${period}:`, periodBetsData);
      } else {
        console.log(`No saved bets found for period ${period}, using current bets data`);
        periodBetsData = currentPeriodBets;
      }
    } catch (error) {
      console.error(`Error getting bets for period ${period}:`, error);
      periodBetsData = currentPeriodBets;
    }
    
    // Determine the minority bet for colors
    let colorCounts = periodBetsData.bets || { RED: 0, GREEN: 0, VIOLET: 0 };
    let numberCounts = periodBetsData.numbers || { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
    let sizeCounts = periodBetsData.sizes || { BIG: 0, SMALL: 0 };
    
    // Find the color with the minimum bets (among those with at least one bet)
    let minorityColor;
    let minBets = Infinity;
    
    // Consider all colors that have at least one bet
    for (const [color, count] of Object.entries(colorCounts)) {
      if (count > 0 && count < minBets) {
        minorityColor = color;
        minBets = count;
      }
    }
    
    // If there are no bets or all colors have the same bets
    if (!minorityColor || minBets === Infinity) {
      // Fallback to deterministic approach
      const [datePart, periodPart] = period.split('-');
      const year = parseInt(datePart.substring(0, 2));
      const month = parseInt(datePart.substring(2, 4));
      const day = parseInt(datePart.substring(4, 6));
      const hour = parseInt(datePart.substring(6, 8));
      const minute = parseInt(datePart.substring(8, 10));
      
      const periodValue = (year * 31 + day + month) + (hour * 60 + minute);
      const number = periodValue % 10;
      
      let color;
      if (number === 0) {
        color = 'VIOLET';
      } else if (number === 5) {
        color = 'VIOLET GREEN'; 
      } else if (number % 2 === 0) {
        color = 'RED';
      } else {
        color = 'GREEN';
      }
      
      const size = number >= 5 ? 'BIG' : 'SMALL';
      
      console.log(`No bets data available for period ${period}, using fallback deterministic result`);
      
      return { 
        number, 
        size, 
        color,
        timestamp: new Date().toISOString(),
        period,
        isMock: false,
        betData: periodBetsData
      };
    }
    
    // Now find a number that corresponds to the minority color
    let candidateNumbers = [];
    let number;
    
    if (minorityColor === 'VIOLET') {
      candidateNumbers = [0, 5]; // Numbers that can be VIOLET
    } else if (minorityColor === 'RED') {
      candidateNumbers = [2, 4, 6, 8]; // Even numbers except 0
    } else if (minorityColor === 'GREEN') {
      candidateNumbers = [1, 3, 7, 9]; // Odd numbers except 5
    } else if (minorityColor === 'VIOLET GREEN') {
      candidateNumbers = [5]; // Only 5 can be VIOLET GREEN
    }
    
    // Find the number with the minimum bets among candidates
    let minNumberBets = Infinity;
    for (const num of candidateNumbers) {
      const count = numberCounts[num] || 0;
      if (count < minNumberBets) {
        minNumberBets = count;
        number = num;
      }
    }
    
    // If there are no specific number bets, choose one randomly from candidates
    if (number === undefined) {
      number = candidateNumbers[0]; // Default to first candidate
    }
    
    // Determine size based on number
    const size = number >= 5 ? 'BIG' : 'SMALL';
    
    // Final color determination
    let color;
    if (number === 0) {
      color = 'VIOLET';
    } else if (number === 5) {
      color = 'VIOLET GREEN';
    } else if (number % 2 === 0) {
      color = 'RED';
    } else {
      color = 'GREEN';
    }
    
    console.log(`Generated minority-favoring result for period ${period}: Number ${number}, Color ${color}, Size ${size}`);
    
    return { 
      number, 
      size, 
      color,
      timestamp: new Date().toISOString(),
      period,
      isMock: false,
      betData: periodBetsData
    };
  } catch (error) {
    console.error(`Error in generateMockResult for period ${period}:`, error);
    
    // Fallback to fully deterministic approach if anything fails
    const [datePart, periodPart] = period.split('-');
    const year = parseInt(datePart.substring(0, 2));
    const month = parseInt(datePart.substring(2, 4));
    const day = parseInt(datePart.substring(4, 6));
    const hour = parseInt(datePart.substring(6, 8));
    const minute = parseInt(datePart.substring(8, 10));
    
    const periodValue = (year * 31 + day + month) + (hour * 60 + minute);
    const number = periodValue % 10;
    
    let color;
    if (number === 0) {
      color = 'VIOLET';
    } else if (number === 5) {
      color = 'VIOLET GREEN';
    } else if (number % 2 === 0) {
      color = 'RED';
    } else {
      color = 'GREEN';
    }
    
    const size = number >= 5 ? 'BIG' : 'SMALL';
    
    return { 
      number, 
      size, 
      color,
      timestamp: new Date().toISOString(),
      period,
      isMock: false
    };
  }
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
    
    // Generate new result for this period using the deterministic function
    console.log('Generating new result for period:', completedPeriod);
    const result = await generateAndSaveResult(completedPeriod);
    
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

// At the end of a period, update the currentPeriodBets
function resetCurrentPeriodBets() {
  const newPeriod = getPeriod();
  currentPeriodBets = {
    period: newPeriod,
    bets: { RED: 0, GREEN: 0, VIOLET: 0 },
    numbers: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    sizes: { BIG: 0, SMALL: 0 },
    timestamp: new Date()
  };
  console.log(`Reset current period bets for new period ${newPeriod}`);
}

// Modified scheduler to reset bet tracking
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
      
      // Reset bet tracking for the new period
      resetCurrentPeriodBets();
      
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