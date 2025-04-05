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

// Create WebSocket server with increased message size limit for MP3 files
const wss = new WebSocket.Server({ 
  server, 
  maxPayload: 50 * 1024 * 1024  // 50MB max payload size
});

// Keep track of all connected clients
const clients = new Set();
let hostClient = null;

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
          
          // Send confirmation to the host
          ws.send(JSON.stringify({
            type: 'host-confirmed',
            clientCount: clients.size
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
          
        case 'play':
          // Add server timestamp for synchronization
          data.serverTime = Date.now();
          
          // Log MP3 data size if present
          if (data.mp3Data) {
            const sizeInMB = (data.mp3Data.length * 0.75) / (1024 * 1024);
            console.log(`Broadcasting audio file (${sizeInMB.toFixed(2)}MB)`);
          } else {
            console.log('Broadcasting test sound');
          }
          
          // Broadcast the play command to all clients except the host
          broadcastToClients(JSON.stringify(data), true);
          break;
          
        case 'stop':
          // Broadcast the stop command to all clients except the host
          broadcastToClients(JSON.stringify(data), true);
          console.log('Broadcasting stop command');
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