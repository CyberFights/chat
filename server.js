const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const bodyParser = require("body-parser");
const multer = require("multer");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.json());

const upload = multer({ dest: "uploads/" });

const db = new Database("app.db");

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    email TEXT,
    language TEXT,
    color TEXT,
    age INTEGER,
    stats TEXT,
    info TEXT,
    imagePath TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    username TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1 TEXT NOT NULL,
    user2 TEXT NOT NULL,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

const roomMembers = {};   // room -> [{username, profilePic}]
const userSockets = {};   // username -> socketId

// REST API

// Register new user
app.post("/register", upload.single("image"), async (req, res) => {
  try {
    const { username, password, email, language, color, age, stats, info, nativeLanguage, colorPreference } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const exists = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (exists) return res.status(400).json({ error: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const imagePath = req.file ? req.file.path : null;

    db.prepare(`INSERT INTO users (username, password, email, language, color, age, stats, info, imagePath)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(username, hashed, email, nativeLanguage || language, colorPreference || color, age, stats, info, imagePath);

    res.json({ success: true, message: "User registered!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user) return res.status(400).json({ error: "No such user" });

  bcrypt.compare(password, user.password).then(match => {
    if (!match) return res.status(400).json({ error: "Invalid password" });
    res.json({ success: true, user });
  });
});

// Get user info
app.get("/user/:username", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(req.params.username);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

// Update user info
app.put("/user/:username", upload.single("image"), (req, res) => {
  const { username } = req.params;
  const { email, language, color, age, stats, info } = req.body;

  const existing = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!existing) return res.status(404).json({ error: "User not found" });

  const imagePath = req.file ? req.file.path : existing.imagePath;

  db.prepare(`UPDATE users SET email=?, language=?, color=?, age=?, stats=?, info=?, imagePath=? WHERE username=?`)
    .run(email, language, color, age, stats, info, imagePath, username);

  res.json({ success: true });
});

// Save message in room (via REST)
app.post("/rooms/:room/messages", (req, res) => {
  const { room } = req.params;
  const { username, message } = req.body;
  db.prepare("INSERT INTO messages (room, username, message) VALUES (?, ?, ?)").run(room, username, message);
  res.json({ success: true });
});

// Get room messages
app.get("/rooms/:room/messages", (req, res) => {
  const msgs = db.prepare("SELECT * FROM messages WHERE room=? ORDER BY timestamp ASC").all(req.params.room);
  res.json(msgs);
});

// Save private message with optional image upload
app.post('/private/messages', upload.single('image'), (req, res) => {
  const { from_user, to_user, message } = req.body;
  if (!from_user || !to_user) return res.status(400).json({ error: 'Missing users' });

  const [user1, user2] = [from_user, to_user].sort();

  let fullMessage = message || '';
  if (req.file) {
    const imageUrl = `/uploads/${req.file.filename}`;
    fullMessage = fullMessage ? fullMessage + ' [Image]' : '[Image]';
    // Optionally save imageUrl in DB separately if desired
  }

  db.prepare(`INSERT INTO private_messages (user1, user2, from_user, to_user, message) VALUES (?, ?, ?, ?, ?)`)
    .run(user1, user2, from_user, to_user, fullMessage);

  res.json({ success: true, imageUrl: req.file ? `/uploads/${req.file.filename}` : null });
});

// Get private message history
app.get('/private/messages/:userA/:userB', (req, res) => {
  const [user1, user2] = [req.params.userA, req.params.userB].sort();
  const messages = db.prepare(`
    SELECT * FROM private_messages WHERE user1 = ? AND user2 = ? ORDER BY timestamp ASC
  `).all(user1, user2);
  res.json(messages);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Socket.IO real-time chat & private messaging
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;
  let profilePic = null;

  socket.on("joinRoom", ({ room, username }) => {
    currentRoom = room;
    currentUser = username;
    profilePic = socket.handshake.query.profilePic || null;

    socket.join(room);
    userSockets[username] = socket.id;

    if (!roomMembers[room]) roomMembers[room] = [];
    if (!roomMembers[room].some(m => m.username === username)) {
      roomMembers[room].push({ username, profilePic });
    }

    const history = db.prepare("SELECT username, message FROM messages WHERE room=? ORDER BY timestamp ASC").all(room);
    socket.emit("loadMessages", history.map(m => `${m.username}: ${m.message}`));

    io.to(room).emit("updateMembers", roomMembers[room]);
  });

  socket.on("leaveRoom", ({ room, username }) => {
    socket.leave(room);
    if (roomMembers[room]) {
      roomMembers[room] = roomMembers[room].filter(m => m.username !== username);
      io.to(room).emit("updateMembers", roomMembers[room]);
    }
    delete userSockets[username];
  });

  socket.on("chat message", ({ room, username, message }) => {
    db.prepare("INSERT INTO messages (room, username, message) VALUES (?, ?, ?)").run(room, username, message);
    io.to(room).emit("chat message", { username, message });
  });

  socket.on("private message", ({ to, from, message }) => {
    const [user1, user2] = [from, to].sort();
    db.prepare(`
      INSERT INTO private_messages (user1, user2, from_user, to_user, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(user1, user2, from, to, message);

    const sid = userSockets[to];
    if (sid) {
      io.to(sid).emit("private message", { from, message });
    }
  });

  socket.on("get private history", ({ userA, userB }, callback) => {
    const [user1, user2] = [userA, userB].sort();
    const messages = db.prepare(`
      SELECT from_user, to_user, message, timestamp
      FROM private_messages
      WHERE user1 = ? AND user2 = ?
      ORDER BY timestamp ASC
    `).all(user1, user2);
    callback(messages);
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
  console.log(`Server listening at http://localhost:${PORT}`);
});
