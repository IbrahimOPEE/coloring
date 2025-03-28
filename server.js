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
  res.json({ serverTime: Date.now() });
});

// API endpoint to get server info including port
app.get('/api/server-info', (req, res) => {
  res.json({ 
    port: serverPort,
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
  
  // Generate new result ensuring it's different from previous patterns
  let color, number, size;
  let attempts = 0;
  const maxAttempts = 5; // Maximum attempts to avoid infinite loops
  
  do {
    attempts++;
    
    // Generate color with general probabilities but avoid repeating twice
    const colorRandom = Math.random() * 100;
    
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
      number = prevNumbers[0] === 0 ? 5 : 0; // Alternate between 0 and 5
      
      // If number is 5, it's both VIOLET and GREEN
      if (number === 5) {
        color = 'VIOLET GREEN';
      }
    } else if (color === 'RED') {
      // For red, we need even numbers except 0
      const evenNumbers = [2, 4, 6, 8];
      // Filter out the most recent number if it's in this list
      const availableNumbers = evenNumbers.filter(n => !prevNumbers.includes(n));
      number = availableNumbers.length > 0 
        ? availableNumbers[Math.floor(Math.random() * availableNumbers.length)]
        : evenNumbers[Math.floor(Math.random() * evenNumbers.length)];
    } else {
      // For green, we need odd numbers except 5 (already covered in VIOLET)
      const oddNumbers = [1, 3, 7, 9];
      // Filter out the most recent number if it's in this list
      const availableNumbers = oddNumbers.filter(n => !prevNumbers.includes(n));
      number = availableNumbers.length > 0 
        ? availableNumbers[Math.floor(Math.random() * availableNumbers.length)]
        : oddNumbers[Math.floor(Math.random() * oddNumbers.length)];
    }
    
    // Determine size based on number
    size = number >= 5 ? 'BIG' : 'SMALL';
    
    // If we've tried several times and still can't get a completely different result,
    // accept what we have to avoid an infinite loop
    if (attempts >= maxAttempts) {
      console.log(`Maximum attempts (${maxAttempts}) reached, accepting current result`);
      break;
    }
    
  } while (
    // Avoid repeating the same size three times in a row
    (prevSizes.length >= 2 && size === prevSizes[0] && size === prevSizes[1]) ||
    // Avoid repeating the same number
    (prevNumbers.length > 0 && number === prevNumbers[0])
  );
  
  console.log(`Generated new result after ${attempts} attempts: ${color}, ${number}, ${size}`);
  
  return { 
    number, 
    size, 
    color,
    timestamp: new Date().toISOString(),
    period,
    isMock: true // Flag to indicate this is a mock result
  };
}

// Helper function to handle latest result request
async function handleLatestResultRequest(req, res) {
  try {
    // Get the most recently completed period
    const completedPeriod = getCompletedPeriod();
    
    // Try to get the result for the completed period
    let resultDoc;
    try {
      const docRef = db.collection('gameResults').doc(completedPeriod);
      resultDoc = await docRef.get(); // Use admin SDK directly
    } catch (authError) {
      console.error('Authentication error when fetching result:', authError);
      // Return a mock result as fallback
      const mockResult = await generateMockResult(completedPeriod);
      console.log('Returning mock result due to authentication error:', mockResult);
      return res.json(mockResult);
    }
    
    if (!resultDoc.exists) {
      // If no result for the most recent completed period, try the period before that
      const previousCompletedPeriod = getPreviousCompletedPeriod();
      try {
        const prevDocRef = db.collection('gameResults').doc(previousCompletedPeriod);
        resultDoc = await prevDocRef.get(); // Use admin SDK directly
      } catch (authError) {
        console.error('Authentication error when fetching previous result:', authError);
        // Return a mock result as fallback
        const mockResult = await generateMockResult(previousCompletedPeriod);
        console.log('Returning mock result due to authentication error:', mockResult);
        return res.json(mockResult);
      }
    }
    
    if (resultDoc.exists) {
      res.json(resultDoc.data());
    } else {
      // If no result found in database, generate a mock result
      const mockResult = await generateMockResult(completedPeriod);
      console.log('No result found in database, returning mock result:', mockResult);
      res.json(mockResult);
    }
  } catch (error) {
    console.error('Error fetching latest result:', error);
    // Return a mock result as last resort
    const mockResult = await generateMockResult(getCompletedPeriod());
    console.log('Returning mock result due to error:', mockResult);
    res.json(mockResult);
  }
}

// API endpoint to get the latest result
app.get('/api/latest-result', async (req, res) => {
  await handleLatestResultRequest(req, res);
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

// Result generation function
async function generateAndSaveResult(period) {
  try {
    // Check if a result already exists for this period
    let existingDoc;
    try {
      const docRef = db.collection('gameResults').doc(period);
      existingDoc = await docRef.get(); // Use admin SDK directly
      if (existingDoc.exists) {
        console.log(`Result for period ${period} already exists, returning existing result`);
        return existingDoc.data();
      }
    } catch (authError) {
      console.error('Authentication error when checking for existing result:', authError);
      // Continue to generate a new result
    }
    
    // Generate a new result
    const result = await generateMockResult(period);
    console.log(`Generated new result for period ${period}:`, result);
    
    // Process game history entries
    try {
      // For testing, create history entries for some test users
      // Disable test user history creation as client is now saving history properly
      /*
      const userIds = ['testUser1', 'testUser2', 'testUser3'];
      console.log(`Creating game history entries for ${userIds.length} test users`);
      
      for (const userId of userIds) {
        const historyData = {
          period: period,
          number: result.number,
          size: result.size,
          color: result.color,
          userId: userId,
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString()
        };
        
        try {
          // Save to local file
          console.log(`Attempting to save local history for user ${userId}...`);
          const saveResult = await saveGameHistoryLocally(historyData);
          console.log(`Game history saved locally for user ${userId}, result:`, saveResult);
        } catch (saveError) {
          console.error(`Error saving local history for user ${userId}:`, saveError);
        }
        
        // Also try to save to Firestore if possible
        try {
          await db.collection('gameHistory').add(historyData);
          console.log(`Game history also saved to Firestore for user ${userId} for period ${period}`);
        } catch (firestoreError) {
          console.error(`Error saving to Firestore history for user ${userId}:`, firestoreError);
          // Continue even if Firestore save fails
        }
      }
      */

      // Only create a single server-side record for the result itself
      // This will not interfere with client-side user records
      const serverHistoryData = {
        period: period,
        number: result.number,
        size: result.size,
        color: result.color,
        userId: 'server',
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        isServerGenerated: true
      };
      
      // Save to Firestore
      try {
        await db.collection('gameResults').doc(period).set(result);
        console.log(`Result saved to Firestore gameResults collection for period ${period}`);
      } catch (firestoreError) {
        console.error(`Error saving to Firestore gameResults:`, firestoreError);
      }
      
      console.log(`Game history processing completed for period ${period}`);
    } catch (historyError) {
      console.error('Error saving to game history:', historyError);
      // Create a fallback history entry
      try {
        const fallbackHistoryData = {
          period: period,
          number: result.number,
          size: result.size,
          color: result.color,
          userId: 'server-fallback',
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          isFallback: true
        };
        
        // Save to local file as backup only
        console.log('Attempting to save fallback history entry locally...');
        const saveResult = await saveGameHistoryLocally(fallbackHistoryData);
        console.log('Fallback game history entry created locally, result:', saveResult);
      } catch (fallbackError) {
        console.error('Error creating fallback history entry:', fallbackError);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error in generateAndSaveResult:', error);
    // Return a mock result as fallback
    return await generateMockResult(period);
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