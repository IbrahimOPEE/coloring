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

// Global variables to store bet data for the current period
let currentPeriodBets = {
  period: '',
  bets: {
    RED: 0,
    GREEN: 0,
    VIOLET: 0
  },
  numbers: {
    '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, 
    '5': 0, '6': 0, '7': 0, '8': 0, '9': 0
  },
  sizes: {
    BIG: 0,
    SMALL: 0
  },
  timestamp: null
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
  // Instead of using the seeded random logic, use the strategic result
  const result = determineStrategicResult();
  result.period = period;
  console.log(`Generated strategic result for period ${period}:`, result);
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
      // Continue execution - we'll generate a strategic result even if we can't save it
    }
    
    // Generate a strategic result based on bet distribution instead of random
    const result = determineStrategicResult();
    result.period = period;
    
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
      // Continue - we still want to return the strategic result
    }
    
    // Save to local file as backup
    try {
      const historyData = await getLocalGameHistory();
      historyData.results = historyData.results || [];
      
      // Add bet data to the result
      result.betData = { ...currentPeriodBets };
      
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
    
    // Reset bet data for the next period
    currentPeriodBets = {
      period: getPeriod(),
      bets: {
        RED: 0,
        GREEN: 0,
        VIOLET: 0
      },
      numbers: {
        '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, 
        '5': 0, '6': 0, '7': 0, '8': 0, '9': 0
      },
      sizes: {
        BIG: 0,
        SMALL: 0
      },
      timestamp: new Date().toISOString()
    };
    
    return result;
  } catch (error) {
    console.error(`Error in generateAndSaveResult for period ${period}:`, error);
    // In case of any error, still return a strategic result
    const fallbackResult = determineStrategicResult();
    fallbackResult.period = period;
    console.log(`Using fallback strategic result for period ${period} after error:`, fallbackResult);
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

// Add API endpoint to receive bet data from clients
app.post('/api/place-bet', (req, res) => {
  try {
    const { betType, betValue, amount, userId } = req.body;
    
    if (!betType || !betValue || !amount) {
      return res.status(400).json({ error: 'Missing required bet information' });
    }
    
    console.log(`Received bet: type=${betType}, value=${betValue}, amount=${amount}, userId=${userId || 'anonymous'}`);
    
    // Update the current period bet counts
    const currentPeriod = getPeriod();
    if (currentPeriodBets.period !== currentPeriod) {
      // Reset bet data for new period
      currentPeriodBets = {
        period: currentPeriod,
        bets: {
          RED: 0,
          GREEN: 0,
          VIOLET: 0
        },
        numbers: {
          '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, 
          '5': 0, '6': 0, '7': 0, '8': 0, '9': 0
        },
        sizes: {
          BIG: 0,
          SMALL: 0
        },
        timestamp: new Date().toISOString()
      };
    }
    
    // Record the bet based on type
    if (betType === 'color') {
      // Color bets - normalize to uppercase
      const normalizedValue = betValue.toUpperCase();
      if (currentPeriodBets.bets[normalizedValue] !== undefined) {
        currentPeriodBets.bets[normalizedValue] += parseInt(amount);
      } else {
        console.warn(`Unrecognized color bet value: ${normalizedValue}`);
      }
    } else if (betType === 'number') {
      // Number bets
      const numValue = betValue.toString();
      if (currentPeriodBets.numbers[numValue] !== undefined) {
        currentPeriodBets.numbers[numValue] += parseInt(amount);
      } else {
        console.warn(`Unrecognized number bet value: ${numValue}`);
      }
    } else if (betType === 'size') {
      // Size bets - normalize to uppercase
      const normalizedValue = betValue.toUpperCase();
      if (currentPeriodBets.sizes[normalizedValue] !== undefined) {
        currentPeriodBets.sizes[normalizedValue] += parseInt(amount);
      } else {
        console.warn(`Unrecognized size bet value: ${normalizedValue}`);
      }
    } else {
      console.warn(`Unrecognized bet type: ${betType}`);
    }
    
    console.log('Current period bet data:', currentPeriodBets);
    
    return res.json({ 
      success: true, 
      message: 'Bet recorded successfully',
      currentPeriod
    });
  } catch (error) {
    console.error('Error processing bet:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Function to determine the optimal result based on bet distribution
function determineStrategicResult() {
  console.log('Determining strategic result based on bet distribution:', currentPeriodBets);
  
  // Default result in case of equal distribution or no bets
  const defaultResult = {
    number: 0,
    size: 'SMALL',
    color: 'VIOLET'
  };
  
  // If no bets, return default random result
  const totalColorBets = Object.values(currentPeriodBets.bets).reduce((sum, count) => sum + count, 0);
  const totalNumberBets = Object.values(currentPeriodBets.numbers).reduce((sum, count) => sum + count, 0);
  const totalSizeBets = Object.values(currentPeriodBets.sizes).reduce((sum, count) => sum + count, 0);
  
  if (totalColorBets === 0 && totalNumberBets === 0 && totalSizeBets === 0) {
    console.log('No bets placed, returning default result');
    return defaultResult;
  }
  
  // Find which color has the least bets (excluding zeros)
  const colorBets = Object.entries(currentPeriodBets.bets)
    .filter(([color, count]) => count > 0)
    .sort((a, b) => a[1] - b[1]);
  
  // Find which number has the least bets (excluding zeros)
  const numberBets = Object.entries(currentPeriodBets.numbers)
    .filter(([number, count]) => count > 0)
    .sort((a, b) => a[1] - b[1]);
  
  // Find which size has the least bets (excluding zeros)
  const sizeBets = Object.entries(currentPeriodBets.sizes)
    .filter(([size, count]) => count > 0)
    .sort((a, b) => a[1] - b[1]);
  
  // Start building the strategic result
  let strategicResult = { ...defaultResult };
  
  // First, determine the winning color (least bet color)
  if (colorBets.length > 0) {
    const winningColor = colorBets[0][0];
    strategicResult.color = winningColor;
    console.log(`Winning color will be ${winningColor} (least bet color)`);
    
    // Now determine a number that matches this color
    if (winningColor === 'RED') {
      // Red numbers: 2, 4, 6, 8
      const redNumbers = ['2', '4', '6', '8'];
      const leastBetRedNumber = redNumbers
        .map(num => [num, currentPeriodBets.numbers[num] || 0])
        .sort((a, b) => a[1] - b[1])[0][0];
      strategicResult.number = parseInt(leastBetRedNumber);
      strategicResult.size = strategicResult.number >= 5 ? 'BIG' : 'SMALL';
    } else if (winningColor === 'GREEN') {
      // Green numbers: 1, 3, 7, 9
      const greenNumbers = ['1', '3', '7', '9'];
      const leastBetGreenNumber = greenNumbers
        .map(num => [num, currentPeriodBets.numbers[num] || 0])
        .sort((a, b) => a[1] - b[1])[0][0];
      strategicResult.number = parseInt(leastBetGreenNumber);
      strategicResult.size = strategicResult.number >= 5 ? 'BIG' : 'SMALL';
    } else if (winningColor === 'VIOLET') {
      // Violet numbers: 0, 5
      if ((currentPeriodBets.numbers['0'] || 0) <= (currentPeriodBets.numbers['5'] || 0)) {
        strategicResult.number = 0;
        strategicResult.size = 'SMALL';
      } else {
        strategicResult.number = 5;
        strategicResult.size = 'BIG';
        // 5 is both green and violet
        strategicResult.color = 'VIOLET GREEN';
      }
    }
  } else if (numberBets.length > 0) {
    // If no color bets but there are number bets
    const winningNumber = parseInt(numberBets[0][0]);
    strategicResult.number = winningNumber;
    
    // Set color and size based on the number
    if (winningNumber === 0) {
      strategicResult.color = 'VIOLET';
      strategicResult.size = 'SMALL';
    } else if (winningNumber === 5) {
      strategicResult.color = 'VIOLET GREEN';
      strategicResult.size = 'BIG';
    } else if (winningNumber % 2 === 0) { // Even numbers (2,4,6,8)
      strategicResult.color = 'RED';
      strategicResult.size = winningNumber >= 5 ? 'BIG' : 'SMALL';
    } else { // Odd numbers (1,3,7,9)
      strategicResult.color = 'GREEN';
      strategicResult.size = winningNumber >= 5 ? 'BIG' : 'SMALL';
    }
  } else if (sizeBets.length > 0) {
    // If only size bets
    const winningSize = sizeBets[0][0];
    strategicResult.size = winningSize;
    
    // Pick a number that matches this size
    if (winningSize === 'BIG') {
      // Big numbers: 5-9
      const bigNumbers = ['5', '6', '7', '8', '9'];
      const leastBetBigNumber = bigNumbers
        .map(num => [num, currentPeriodBets.numbers[num] || 0])
        .sort((a, b) => a[1] - b[1])[0][0];
      strategicResult.number = parseInt(leastBetBigNumber);
      
      // Determine color based on number
      if (strategicResult.number === 5) {
        strategicResult.color = 'VIOLET GREEN';
      } else if (strategicResult.number % 2 === 0) {
        strategicResult.color = 'RED';
      } else {
        strategicResult.color = 'GREEN';
      }
    } else {
      // Small numbers: 0-4
      const smallNumbers = ['0', '1', '2', '3', '4'];
      const leastBetSmallNumber = smallNumbers
        .map(num => [num, currentPeriodBets.numbers[num] || 0])
        .sort((a, b) => a[1] - b[1])[0][0];
      strategicResult.number = parseInt(leastBetSmallNumber);
      
      // Determine color based on number
      if (strategicResult.number === 0) {
        strategicResult.color = 'VIOLET';
      } else if (strategicResult.number % 2 === 0) {
        strategicResult.color = 'RED';
      } else {
        strategicResult.color = 'GREEN';
      }
    }
  }
  
  console.log('Determined strategic result:', strategicResult);
  
  // Return the strategic result
  return {
    ...strategicResult,
    timestamp: new Date().toISOString(),
    isMock: false
  };
}

// Modify the result generation scheduler to collect bets and make strategic decision
async function scheduleResultGeneration() {
  const now = new Date();
  const seconds = now.getSeconds();
  
  // Calculate when the next period ends (either at :00 or :30 seconds)
  const nextPeriodEnd = seconds < 30 ? 30 : 60;
  const timeToNextPeriodEnd = (nextPeriodEnd - seconds) * 1000 - now.getMilliseconds();
  
  // For strategic decision making, we need to set a timer to collect bets 5 seconds before period ends
  const timeToStrategicDecision = timeToNextPeriodEnd - 5000;
  
  if (timeToStrategicDecision > 0) {
    // Set a timer to finalize bet collection 5 seconds before period ends
    setTimeout(() => {
      // Log the final bet distribution for the current period
      console.log('Final bet distribution before period end:', currentPeriodBets);
    }, timeToStrategicDecision);
  }
  
  // Original timer to generate result when period ends
  setTimeout(async () => {
    try {
      // Get the period that just ended
      const completedPeriod = getCompletedPeriod();
      
      // Check if a result already exists for this period
      let existingResultDoc;
      try {
        const docRef = db.collection('gameResults').doc(completedPeriod);
        existingResultDoc = await docRef.get();
        
        if (!existingResultDoc.exists) {
          // Only generate a result if one doesn't already exist
          const result = await generateAndSaveResult(completedPeriod);
          console.log(`Generated strategic result for completed period ${completedPeriod}:`, result);
        } else {
          console.log(`Result for period ${completedPeriod} already exists, skipping generation`);
        }
      } catch (authError) {
        console.error('Authentication error in result generation scheduler:', authError);
        // Try to generate a result anyway, our generateAndSaveResult function has fallbacks
        try {
          const result = await generateAndSaveResult(completedPeriod);
          console.log(`Generated strategic result for completed period ${completedPeriod} after auth error:`, result);
        } catch (genError) {
          console.error('Failed to generate result after auth error:', genError);
        }
      }
    } catch (error) {
      console.error('Error generating result:', error);
    } finally {
      scheduleResultGeneration(); // Schedule next result
    }
  }, timeToNextPeriodEnd);
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