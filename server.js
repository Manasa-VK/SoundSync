// server.js - WebSocket server for auto-synced speakers
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Create HTTP server
const server = http.createServer((req, res) => {
  // Serve index.html for the root path
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Increase WebSocket server limits substantially for large audio files
const wss = new WebSocket.Server({ 
  server, 
  maxPayload: 200 * 1024 * 1024,  // 200MB max payload size
  perMessageDeflate: {
    zlibDeflateOptions: {
      level: 5  // Compression level (1-9, where 9 is highest but slowest)
    }
  }
});

// Helper for getting a reasonable size string
function getSizeString(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Keep track of all connected clients
const clients = new Set();
let hostClient = null;
let readyClients = new Map(); // Track which clients are ready for synchronized playback
let activePlayback = null;   // Track active playback session
let syncCheckTimer = null;   // Timer for periodic sync checks
let clientDecodingTimes = new Map(); // Track client audio decoding performance

// Store MP3 data separately to avoid issues with large messages
let currentMP3Data = null;

// Handle WebSocket connections
wss.on('connection', (ws) => {
  // Add the new client to our set
  clients.add(ws);
  console.log(`New client connected. Total clients: ${clients.size}`);
  
  // Handle messages from clients
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle different message types
      switch (data.type) {
        case 'host':
          // Register this client as the host
          hostClient = ws;
          ws.isHost = true;
          console.log('Host registered');
          
          // Find all local IP addresses
          const { networkInterfaces } = require('os');
          const nets = networkInterfaces();
          const localIps = [];
          
          for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
              // Only get IPv4 addresses and skip internal ones
              if (net.family === 'IPv4' && !net.internal) {
                localIps.push(net.address);
                console.log(`Found IP address: ${net.address} on interface ${name}`);
              }
            }
          }
          
          console.log('All found IP addresses:', localIps);
          
          // Send confirmation to the host with all IP addresses
          ws.send(JSON.stringify({
            type: 'host-confirmed',
            clientCount: clients.size,
            localIps: localIps,
            port: process.env.PORT || 8080
          }));
          break;
          
        case 'join':
          // Register a regular client
          ws.isHost = false;
          ws.deviceName = data.deviceName;
          console.log(`Client joined: ${data.deviceName}`);
          
          // Notify the host about the new client
          if (hostClient) {
            hostClient.send(JSON.stringify({
              type: 'client-joined',
              deviceName: data.deviceName
            }));
          }
          
          // Send confirmation to the client
          ws.send(JSON.stringify({
            type: 'join-confirmed'
          }));
          break;
          
        case 'prepare-audio':
          // Host is sending audio preparation info for clients
          console.log('Received audio preparation info');
          
          // Forward to all clients to help them prepare
          broadcastToClients(JSON.stringify({
            type: 'prepare-audio',
            fileSize: data.fileSize,
            duration: data.duration,
            sampleRate: data.sampleRate,
            numberOfChannels: data.numberOfChannels,
            serverTime: Date.now()
          }), true);
          break;
          
        case 'decoding-stats':
          // Client is reporting its audio decoding performance
          if (data.clientId) {
            // Store the client's decoding performance
            clientDecodingTimes.set(data.clientId, {
              decodingTime: data.decodingTime,
              timestamp: Date.now()
            });
            
            console.log(`Client ${data.clientId} reported decoding time: ${data.decodingTime}ms for ${data.fileSize} bytes`);
          }
          break;
          
        case 'play':
          // Add server timestamp for synchronization
          data.serverTime = Date.now();
          
          // Start a new sync verification for this playback
          readyClients.clear();
          clientDecodingTimes.clear();
          
          // Create a unique playback ID
          const playbackId = Date.now().toString();
          
          // Log MP3 data size if present
          if (data.mp3Data) {
            // Store the MP3 data securely
            currentMP3Data = data.mp3Data;
            
            const mp3DataSize = data.mp3Data.length * 0.75; // Base64 to binary size approx
            const sizeInMB = mp3DataSize / (1024 * 1024);
            console.log(`Broadcasting audio file (${sizeInMB.toFixed(2)}MB)`);
            
            // Verify the data looks valid (sanity check)
            if (data.mp3Data.length < 100) {
              console.error('MP3 data appears to be invalid or too small:', data.mp3Data);
            } else {
              console.log('MP3 data appears valid (first 20 chars):', data.mp3Data.substring(0, 20) + '...');
            }
            
            // Clone the data object without the MP3 data for easier manipulation
            const playCommandBase = {
              type: data.type,
              serverTime: data.serverTime,
              audioInfo: data.audioInfo,
              playbackId: playbackId
            };
            
            // Set a longer scheduled time for precise sync (8 seconds for MP3 files)
            // This gives enough time for large files to be transferred and decoded
            playCommandBase.scheduledTime = Date.now() + 8000;
            
            // First, send a sync verification request to all clients
            broadcastToClients(JSON.stringify({
              type: 'sync-verification',
              playId: playbackId,
              serverTime: Date.now(),
              audioInfo: data.audioInfo // Forward audio info from host
            }), true);
            
            // Store information about this playback session
            activePlayback = {
              id: playbackId,
              startTime: playCommandBase.scheduledTime,
              clientSyncStates: new Map(),
              startedAt: null,
              audioInfo: data.audioInfo
            };
            
            // Then wait for all clients to confirm they're synced before sending play command
            setTimeout(() => {
              if (clients.size > 1) { // If we have clients besides the host
                console.log(`Waiting for clients to confirm sync readiness (${readyClients.size}/${clients.size - 1} ready)`);
                
                // Wait for clients to be ready or timeout
                const waitForSync = setInterval(() => {
                  const readyCount = readyClients.size;
                  const clientCount = clients.size - 1; // Exclude host
                  
                  console.log(`Sync status: ${readyCount}/${clientCount} clients ready`);
                  
                  // Proceed if all clients are ready or we're getting close to scheduled time
                  if (readyCount >= clientCount || Date.now() > playCommandBase.scheduledTime - 2000) {
                    clearInterval(waitForSync);
                    
                    // Check if we need to adjust the scheduled time based on client decoding performance
                    if (clientDecodingTimes.size > 0) {
                      // Find the slowest client's decoding time
                      let maxDecodingTime = 0;
                      for (const [clientId, stats] of clientDecodingTimes.entries()) {
                        maxDecodingTime = Math.max(maxDecodingTime, stats.decodingTime);
                      }
                      
                      // If any client takes more than 2 seconds to decode, add extra buffer
                      if (maxDecodingTime > 2000) {
                        const additionalBuffer = Math.min(3000, maxDecodingTime - 2000);
                        playCommandBase.scheduledTime += additionalBuffer;
                        console.log(`Adjusted scheduled time by +${additionalBuffer}ms due to slow decoding`);
                      }
                    }
                    
                    console.log(`Broadcasting play command (${readyCount}/${clientCount} clients synchronized) for time ${new Date(playCommandBase.scheduledTime).toISOString()}`);
                    
                    // Set the actual start time for tracking
                    activePlayback.startTime = playCommandBase.scheduledTime;
                    activePlayback.startedAt = Date.now();
                    
                    // Make sure we still have the MP3 data
                    if (!currentMP3Data || currentMP3Data.length < 100) {
                      console.error('ERROR: MP3 data was lost during processing!');
                      return;
                    }
                    
                    // Add the MP3 data to the play command
                    const fullPlayCommand = {
                      ...playCommandBase,
                      mp3Data: currentMP3Data
                    };
                    
                    // Send the play command to clients
                    const playCommandJson = JSON.stringify(fullPlayCommand);
                    console.log('Play command JSON size:', getSizeString(playCommandJson.length));
                    
                    // Send to each client individually to ensure reliability
                    for (const client of clients) {
                      if (client.readyState === WebSocket.OPEN && !client.isHost) {
                        try {
                          client.send(playCommandJson, (err) => {
                            if (err) {
                              console.error('Error sending play command to client:', err.message);
                            } else {
                              console.log('Play command sent to client successfully');
                            }
                          });
                        } catch (error) {
                          console.error('Error sending play command:', error);
                        }
                      }
                    }
                    
                    // Also send playback command to host (without the MP3 data)
                    // Important: Don't send the MP3 data back to the host (it already has it)
                    if (hostClient && hostClient.readyState === WebSocket.OPEN) {
                      hostClient.send(JSON.stringify({
                        type: 'host-play',
                        scheduledTime: playCommandBase.scheduledTime,
                        playbackId: playbackId,
                        serverTime: Date.now()
                      }));
                    }
                    
                    // If some clients aren't ready, send them individually adjusted times
                    if (readyCount < clientCount) {
                      console.log(`Warning: Not all clients confirmed sync readiness`);
                    }
                    
                    // Set up periodic sync checks during playback
                    startPeriodicSyncChecks();
                  }
                }, 500); // Check every 500ms
              } else {
                // No clients to wait for, broadcast immediately
                console.log('No clients to sync with, playing immediately');
                
                // Set the actual start time for tracking
                activePlayback.startedAt = Date.now();
                
                // Direct host to play
                if (hostClient && hostClient.readyState === WebSocket.OPEN) {
                  hostClient.send(JSON.stringify({
                    type: 'host-play',
                    scheduledTime: playCommandBase.scheduledTime,
                    playbackId: playbackId,
                    serverTime: Date.now()
                  }));
                }
              }
            }, 200); // Small delay to allow sync-verification to be sent first
          } else {
            // For test tones, use a much shorter schedule time
            data.scheduledTime = Date.now() + 1000;
            console.log('Broadcasting test sound');
            broadcastToClients(JSON.stringify(data), true);
          }
          break;
          
        case 'client-ready':
          // Client is reporting it's ready for synchronized playback
          if (data.clientId && data.syncInfo) {
            // Store the client's readiness and sync information
            readyClients.set(data.clientId, {
              timestamp: Date.now(),
              networkLatency: data.syncInfo.networkLatency,
              clockOffset: data.syncInfo.clockOffset,
              audioLatency: data.syncInfo.audioLatency
            });
            
            // Also store in active playback if available
            if (activePlayback && data.playId === activePlayback.id) {
              activePlayback.clientSyncStates.set(data.clientId, {
                lastUpdate: Date.now(),
                syncInfo: data.syncInfo
              });
            }
            
            console.log(`Client ${data.clientId} reported ready for sync playback (${readyClients.size} ready)`);
            
            // Notify the host about client readiness
            if (hostClient && hostClient.readyState === WebSocket.OPEN) {
              hostClient.send(JSON.stringify({
                type: 'client-sync-status',
                clientId: data.clientId,
                ready: true,
                readyCount: readyClients.size,
                totalClients: clients.size - 1
              }));
            }
          }
          break;
          
        case 'playback-status':
          // Client is reporting its playback status
          if (data.clientId && data.playbackId && activePlayback && data.playbackId === activePlayback.id) {
            // Update the client's playback status
            activePlayback.clientSyncStates.set(data.clientId, {
              lastUpdate: Date.now(),
              position: data.position,
              drift: data.drift,
              syncInfo: data.syncInfo
            });
            
            // Log significant drift
            if (Math.abs(data.drift) > 0.1) {
              console.log(`Client ${data.clientId} reported drift of ${data.drift.toFixed(3)}s at position ${data.position.toFixed(2)}s`);
            }
          }
          break;
          
        case 'stop':
          // Broadcast the stop command to all clients except the host
          broadcastToClients(JSON.stringify(data), true);
          console.log('Broadcasting stop command');
          
          // Clear active playback and sync check timer
          activePlayback = null;
          currentMP3Data = null;
          if (syncCheckTimer) {
            clearTimeout(syncCheckTimer);
            syncCheckTimer = null;
          }
          break;
          
        case 'clock-sync':
          // This is a clock synchronization message
          if (data.clientId) {
            // This is a response to a specific client request
            // Find that client and forward the message only to them
            for (const client of clients) {
              if (!client.isHost && client !== hostClient && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
                break;
              }
            }
          } else {
            // Broadcast to all clients except host
            broadcastToClients(JSON.stringify(data), true);
          }
          break;
          
        case 'clock-sync-request':
          // Forward clock sync request to host
          if (hostClient && hostClient.readyState === WebSocket.OPEN) {
            hostClient.send(JSON.stringify(data));
          }
          break;
          
        case 'ping':
          // Forward ping to host
          if (hostClient && hostClient.readyState === WebSocket.OPEN) {
            hostClient.send(JSON.stringify(data));
          }
          break;
          
        case 'pong':
          // Forward pong to the client that sent the ping
          for (const client of clients) {
            if (!client.isHost && client.readyState === WebSocket.OPEN) {
              // This is a simplified approach - in a real implementation,
              // we'd track which client sent which ping
              client.send(JSON.stringify(data));
            }
          }
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  // Handle client disconnection
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected. Total clients: ${clients.size}`);
    
    // If the host disconnected, clear the host reference
    if (ws.isHost) {
      hostClient = null;
      console.log('Host disconnected');
    }
    
    // If a regular client disconnected, notify the host
    if (!ws.isHost && hostClient && ws.deviceName) {
      hostClient.send(JSON.stringify({
        type: 'client-left',
        deviceName: ws.deviceName
      }));
    }
  });
});

// Broadcast a message to all clients
function broadcastToClients(message, skipHost = false) {
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      // Skip the host if specified
      if (skipHost && client.isHost) {
        return;
      }
      client.send(message);
    }
  });
}

// Periodic sync checks during playback
function startPeriodicSyncChecks() {
  // Clear any existing timer
  if (syncCheckTimer) {
    clearTimeout(syncCheckTimer);
  }
  
  // Check sync every 5 seconds
  syncCheckTimer = setTimeout(checkPlaybackSync, 5000);
}

// Check playback synchronization across clients
function checkPlaybackSync() {
  if (!activePlayback || !activePlayback.startedAt) {
    // No active playback or it hasn't started yet
    return;
  }
  
  // Calculate expected playback position
  const elapsedMs = Date.now() - activePlayback.startedAt;
  const expectedPosition = elapsedMs / 1000;
  
  // Request status update from all clients
  broadcastToClients(JSON.stringify({
    type: 'request-playback-status',
    playbackId: activePlayback.id,
    expectedPosition: expectedPosition,
    serverTime: Date.now()
  }), true);
  
  // Wait for responses and send drift corrections if needed
  setTimeout(() => {
    if (!activePlayback) return;
    
    // Analyze client states and find average drift
    let totalDrift = 0;
    let clientCount = 0;
    let maxDrift = 0;
    let minDrift = 0;
    
    for (const [clientId, state] of activePlayback.clientSyncStates.entries()) {
      if (state.drift !== undefined) {
        totalDrift += state.drift;
        clientCount++;
        maxDrift = Math.max(maxDrift, state.drift);
        minDrift = Math.min(minDrift, state.drift);
      }
    }
    
    // Only process if we have client data
    if (clientCount > 0) {
      const avgDrift = totalDrift / clientCount;
      const driftSpread = maxDrift - minDrift;
      
      console.log(`Playback sync status: avg drift=${avgDrift.toFixed(3)}s, spread=${driftSpread.toFixed(3)}s across ${clientCount} clients`);
      
      // If average drift is significant or the spread is too large, send correction
      if (Math.abs(avgDrift) > 0.1 || driftSpread > 0.2) {
        console.log('Sending drift correction command');
        
        broadcastToClients(JSON.stringify({
          type: 'drift-correction',
          playbackId: activePlayback.id,
          avgDrift: avgDrift,
          expectedPosition: expectedPosition,
          serverTime: Date.now()
        }), true);
      }
    }
    
    // Schedule next check
    syncCheckTimer = setTimeout(checkPlaybackSync, 5000);
  }, 1000); // Wait 1 second for responses
}

// Start the server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Find and display the local IP address
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`Access the app at: http://${net.address}:${PORT}`);
      }
    }
  }
});