
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store active users and their rooms
const users = {};
const rooms = {};

// Serve static files if needed
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = null;

  // Join a room
  socket.on('joinRoom', ({ room, username }) => {
    currentRoom = room;
    currentUsername = username || `User${Math.floor(Math.random() * 1000)}`;

    socket.join(room);

    // Store user info
    users[socket.id] = { username: currentUsername, room };

    // Track room members
    if (!rooms[room]) rooms[room] = new Set();
    rooms[room].add(socket.id);

    // Notify others in the room
    io.to(room).emit('updateMembers', Array.from(rooms[room]).map(id => ({
      username: users[id].username,
      profilePic: users[id].profilePic || 'https://via.placeholder.com/30'
    })));

    // Optionally send previous messages (not implemented here)
    // socket.emit('loadMessages', []);
  });

  // Handle public chat messages
  socket.on('chat message', (message) => {
    if (currentRoom && currentUsername) {
      io.to(currentRoom).emit('chat message', {
        username: currentUsername,
        message
      });
    }
  });

  // Handle private messages
  socket.on('private message', ({ to, message }) => {
    const recipientSocket = Object.keys(users).find(id => users[id].username === to);
    if (recipientSocket && users[recipientSocket]) {
      io.to(recipientSocket).emit('private message', {
        from: currentUsername,
        message
      });
      socket.emit('private message', {
        from: currentUsername,
        message,
        sent: true
      });
    }
  });

  // Leave room
  socket.on('leaveRoom', ({ room, username }) => {
    socket.leave(room);
    if (rooms[room]) {
      rooms[room].delete(socket.id);
      io.to(room).emit('updateMembers', Array.from(rooms[room]).map(id => ({
        username: users[id].username,
        profilePic: users[id].profilePic || 'https://via.placeholder.com/30'
      })));
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].delete(socket.id);
      io.to(currentRoom).emit('updateMembers', Array.from(rooms[currentRoom]).map(id => ({
        username: users[id].username,
        profilePic: users[id].profilePic || 'https://via.placeholder.com/30'
      })));
    }
    delete users[socket.id];
  });
});

server.listen(3000, () => {
  console.log('Server listening on http://localhost:3000');
});