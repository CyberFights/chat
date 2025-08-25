require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const bodyParser = require("body-parser");
const multer = require("multer");
const bcrypt = require("bcrypt");
const { MongoClient } = require("mongodb");
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use('/assets/images/users', express.static(path.join(__dirname, 'users')));
app.use(bodyParser.json());

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "users")); // Make sure "users" points to a persistent volume
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage });


const client = new MongoClient(process.env.Mongo_DB);
let db;

client.connect().then(() => {
  db = client.db("chatApp");
  db.collection("users").createIndex({ username: 1 }, { unique: true });
}).catch(err => console.error("MongoDB connection error:", err));

const roomMembers = {};   // room -> [{username, profilePic}]
const userSockets = {};   // username -> socketId

const DISCORD_WEBHOOK_URL = process.env.Discord_webhook;

async function sendDiscordWebhookMessage(username, message, avatarUrl) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error('Discord webhook URL is not defined in environment variables!');
    return;
  }

  const payload = {
    username: username || 'Chat Message',
    content: message,
    avatar_url: avatarUrl || ''
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error('Failed to send webhook:', response.statusText);
    }
  } catch (err) {
    console.error('Error sending webhook:', err);
  }
}


// REST API
// API endpoint to receive chat message data from client
app.post('/api/sendChatMessage', async (req, res) => {
  const { username, message, avatarUrl } = req.body;
  await sendDiscordWebhookMessage(username, message, avatarUrl);
  res.json({ success: true });
});
// Register new user
app.post("/register", upload.single("image"), async (req, res) => {
  try {
    const { username, password, email, language, color, age, stats, info, nativeLanguage, colorPreference } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const imagePath = req.file ? req.file.path : null;

    const newUser = {
      username,
      password: hashed,
      email,
      language: nativeLanguage || language,
      color: colorPreference || color,
      age,
      stats,
      info,
      imagePath
    };

    await db.collection("users").insertOne(newUser);

    res.json({ success: true, message: "User registered!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection("users").findOne({ username });

    if (!user) return res.status(400).json({ error: "No such user" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Get user info
app.get("/user/:username", async (req, res) => {
  try {
    const user = await db.collection("users").findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Update user info
app.put("/user/:username", upload.single("image"), async (req, res) => {
  try {
    const { username } = req.params;
    const { email, language, color, age, stats, info } = req.body;

    const imagePath = req.file ? req.file.path : null;

    await db.collection("users").updateOne(
      { username },
      { $set: { email, language, color, age, stats, info, imagePath } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// Save message in room (via REST)
app.post("/rooms/:room/messages", async (req, res) => {
  try {
    const { room } = req.params;
    const { username, message } = req.body;

    await db.collection("messages").insertOne({ room, username, message, timestamp: new Date() });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save message" });
  }
});

// Get room messages
app.get("/rooms/:room/messages", async (req, res) => {
  try {
    const msgs = await db.collection("messages").find({ room: req.params.room }).sort({ timestamp: 1 }).toArray();
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Save private message with optional image upload
app.post('/private/messages', upload.single('image'), async (req, res) => {
  try {
    const { from_user, to_user, message } = req.body;
    if (!from_user || !to_user) return res.status(400).json({ error: 'Missing users' });

    let fullMessage = message || '';
    if (req.file) {
      const imageUrl = `/assets/images/users/${req.file.filename}`;
      fullMessage = fullMessage ? fullMessage + ' [Image]' : '[Image]';
    }

    await db.collection("private_messages").insertOne({
      user1: from_user,
      user2: to_user,
      from_user,
      to_user,
      message: fullMessage,
      timestamp: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save private message" });
  }
});

// Get private message history
app.get('/private/messages/:userA/:userB', async (req, res) => {
  try {
    const messages = await db.collection("private_messages").find({
      user1: { $in: [req.params.userA, req.params.userB] },
      user2: { $in: [req.params.userA, req.params.userB] }
    }).sort({ timestamp: 1 }).toArray();

    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch private messages" });
  }
});

// Send message via Socket.IO to a specific room from REST
app.post("/broadcast", async (req, res) => {
  try {
    const { room, username, message, timestamp } = req.body;
    if (!room || !username || !message)
      return res.status(400).json({ error: "Room, username, and message required" });

    io.to(room).emit("chat message", { room, username, message, timestamp });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Broadcast failed" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Socket.IO real-time chat & private messaging
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;
  let profilePic = null;

  socket.on("joinRoom", async ({ room, username }) => {
    try {
      currentRoom = room;
      currentUser = username;
      profilePic = socket.handshake.query.profilePic || null;

      socket.join(room);
      userSockets[username] = socket.id;

      if (!roomMembers[room]) roomMembers[room] = [];
      if (!roomMembers[room].some(m => m.username === username)) {
        roomMembers[room].push({ username, profilePic });
      }

      const history = await db.collection("messages").find({ room }).sort({ timestamp: 1 }).toArray();
      socket.emit("loadMessages", history.map(m => `${m.username}: ${m.message}`));

      io.to(room).emit("updateMembers", roomMembers[room]);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("leaveRoom", ({ room, username }) => {
    socket.leave(room);
    if (roomMembers[room]) {
      roomMembers[room] = roomMembers[room].filter(m => m.username !== username);
      io.to(room).emit("updateMembers", roomMembers[room]);
    }
    delete userSockets[username];
  });

  socket.on("chat message", async ({ room, username, message, timestamp }) => {
    try {
      await db.collection("messages").insertOne({ room, username, message, timestamp });
      io.to(room).emit("chat message", { username, message, timestamp });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("private message", async ({ to, from, message }) => {
    try {
      const recipientSocket = userSockets[to];
      if (recipientSocket) {
        io.to(recipientSocket).emit("private message", { from, message });
      }

      await db.collection("private_messages").insertOne({
        user1: from,
        user2: to,
        from_user: from,
        to_user: to,
        message,
        timestamp: new Date()
      });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("get private history", async ({ userA, userB }, callback) => {
    try {
      const messages = await db.collection("private_messages").find({
        user1: { $in: [userA, userB] },
        user2: { $in: [userA, userB] }
      }).sort({ timestamp: 1 }).toArray();

      callback(messages);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("disconnect", () => {
    if (currentRoom && currentUser) {
      if (roomMembers[currentRoom]) {
        roomMembers[currentRoom] = roomMembers[currentRoom].filter(m => m.username !== currentUser);
        io.to(currentRoom).emit("updateMembers", roomMembers[currentRoom]);
      }
      delete userSockets[currentUser];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening at http://malecyberfights.up.railway.app:${PORT}`);
});