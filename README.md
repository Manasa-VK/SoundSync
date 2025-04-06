# SoundSync
SoundSync


# Network Synchronized Speakers - Setup Guide

This guide will help you set up the Network Synchronized Speakers system on your local network. The system allows multiple devices to play audio in perfect synchronization just by visiting a webpage.

## Requirements

- Node.js installed on your computer (download from [nodejs.org](https://nodejs.org/))
- Devices with modern web browsers (Chrome, Firefox, Safari, Edge)
- All devices connected to the same WiFi network

## Setup Steps

### 1. Create the Project Files

1. Create a new folder named `sync-speakers` anywhere on your computer
2. Inside this folder, create two files:
   - `server.js` - Copy the server code into this file
   - `index.html` - Copy the HTML code into this file

### 2. Install Required Dependencies

1. Open a command prompt or terminal
2. Navigate to your project folder:
   ```
   cd path/to/sync-speakers
   ```
3. Initialize a new Node.js project:
   ```
   npm init -y
   ```
4. Install required packages:
   ```
   npm install ws
   ```

### 3. Start the Server

1. In the same terminal window, run:
   ```
   node server.js
   ```
2. You should see output similar to:
   ```
   Server is running on port 8080
   Access the app at: http://192.168.1.100:8080
   ```
3. Note your local IP address shown in the output (e.g., 192.168.1.100)

### 4. Connect Devices

1. On your computer (the host), open a web browser and go to:
   ```
   http://localhost:8080
   ```
2. Click "Become Host" to start hosting the session
3. On other devices (phones, tablets, laptops), open a web browser and enter:
   ```
   http://192.168.1.100:8080
   ```
   (Replace 192.168.1.100 with your actual IP address)
4. On these devices, click "Join Existing Session"

### 5. Play Synchronized Audio

1. On the host device, you can:
   - Click "Test Sound" to play a test tone on all connected devices
   - Click "Choose Audio File" to select an MP3 file from your computer
   - Click "Play on All Devices" to play the selected audio file on all connected devices simultaneously
   - Click "Stop" to stop playback on all devices

**Note about file sizes**: MP3 files are transmitted to all devices, so it's best to use smaller files (under 10MB) for optimal performance.

## Troubleshooting

- **Devices can't connect**: Make sure all devices are on the same WiFi network and your computer's firewall allows connections on port 8080
- **No sound**: Ensure device volume is up and not muted
- **Connection errors**: Restart the server and refresh all browser tabs

## Advanced Usage

- To play actual audio files, you would need to extend the server to handle file uploads and distribution
- For better synchronization over larger networks, you could implement more sophisticated timing mechanisms
- To make the system accessible outside your local network, you would need to set up port forwarding or use a service like ngrok

## Security Note

This implementation is intended for use on trusted local networks only. It does not include authentication or encryption required for secure use over the internet.
