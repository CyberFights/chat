// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory structures
const chatHistory = {};     // { roomName: [message objects] }
const roomMembers = {};     // { roomName: [ {username, profilePic} ] }
const userSockets = {};     // { username: socket.id }

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;
  let profilePic = null;

  // Join a room
  socket.on('joinRoom', ({ room, username }) => {
    currentRoom = room;
    currentUser = username;
    // Optionally, set profilePic if you want to support it from the client
    profilePic = socket.handshake.query.profilePic || null;

    socket.join(room);

    // Track socket for private messaging
    userSockets[username] = socket.id;

    // Add member to room
    if (!roomMembers[room]) roomMembers[room] = [];
    if (!roomMembers[room].some(m => m.username === username)) {
      roomMembers[room].push({ username, profilePic });
    }

    // Send chat history
    socket.emit('loadMessages', (chatHistory[room] || []).map(msg => `${msg.username}: ${msg.message}`));

    // Update members for all in room
    io.to(room).emit('updateMembers', roomMembers[room]);
  });

  // Leave a room
  socket.on('leaveRoom', ({ room, username }) => {
    socket.leave(room);
    if (roomMembers[room]) {
      roomMembers[room] = roomMembers[room].filter(m => m.username !== username);
      io.to(room).emit('updateMembers', roomMembers[room]);
    }
    delete userSockets[username];
  });

  // Handle chat messages
  socket.on('chat message', ({ room, username, message }) => {
    if (!chatHistory[room]) chatHistory[room] = [];
    chatHistory[room].push({ username, message });
    io.to(room).emit('chat message', { username, message });
  });

  // Handle private messages
  socket.on('private message', ({ to, from, message }) => {
    const toSocketId = userSockets[to];
    if (toSocketId) {
      io.to(toSocketId).emit('private message', { from, message });
    }
  });

  // On disconnect, remove from room members
  socket.on('disconnect', () => {
    if (currentRoom && currentUser) {
      if (roomMembers[currentRoom]) {
        roomMembers[currentRoom] = roomMembers[currentRoom].filter(m => m.username !== currentUser);
        io.to(currentRoom).emit('updateMembers', roomMembers[currentRoom]);
      }
      delete userSockets[currentUser];
    }
  });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
