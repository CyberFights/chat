
// server.js
// Merged and fixed server implementation (ES module)
// Features:
// - Express + Socket.io real-time chat
// - MongoDB persistence for users, rooms, messages, DM messages
// - File upload to S3 via multer + multer-s3-v3
// - Register / login with bcrypt
// - REST endpoints for rooms, messages, DM history, support (Discord webhook)
// - Invite/remove, create rooms, join/leave rooms, DM rooms via Socket.io
//
// NOTE: Configure environment variables:
// - AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET
// - Mongo_DB (MongoDB connection string)
// - Discord_webhook (optional for chat webhook)
// - Discord_Support (optional for support webhook)
// - PORT (optional)

import path from "path";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import cors from "cors";
import { S3Client } from "@aws-sdk/client-s3";
import multer from "multer";
import multerS3 from "multer-s3-v3";
import bcrypt from "bcrypt";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "url";

dotenv.config();

// __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AWS S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Multer + S3 storage
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET || "",
    acl: "public-read",
    key: (req, file, cb) => {
      const key = `users/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
      cb(null, key);
    },
  }),
});

// Express + HTTP + Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// MongoDB setup
const mongoUri = process.env.Mongo_DB;
if (!mongoUri) {
  console.warn("Warning: Mongo_DB environment variable not set. Mongo features will fail until configured.");
}
const client = new MongoClient(mongoUri || "", { useNewUrlParser: true, useUnifiedTopology: true });

let db;
client
  .connect()
  .then(() => {
    db = client.db("chatApp");
    // Ensure indexes
    db.collection("users").createIndex({ username: 1 }, { unique: true }).catch(() => {});
    db.collection("dm_rooms").createIndex({ room: 1 }, { unique: true }).catch(() => {});
    console.log("Connected to MongoDB");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });

// In-memory runtime state (for quick lookups). Persisted state is in MongoDB.
const roomMembers = {}; // roomName -> [{ username, profilePic }]
const userSockets = {}; // username -> socketId

const DISCORD_WEBHOOK_URL = process.env.Discord_webhook || null;
const DISCORD_SUPPORT_URL = process.env.Discord_Support || null;

/**
 * Send a simple Discord webhook message (text)
 */
async function sendDiscordWebhookMessage(username, message, avatarUrl) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("Discord webhook URL not configured.");
    return;
  }
  const payload = {
    username: username || "Chat Message",
    content: message,
    avatar_url: avatarUrl || "",
  };
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error("Failed to send webhook:", response.statusText);
    }
  } catch (err) {
    console.error("Error sending webhook:", err);
  }
}

/* -------------------------
   REST API Endpoints
   ------------------------- */

/**
 * Send chat message to Discord (optional)
 */
app.post("/api/sendChatMessage", async (req, res) => {
  try {
    const { username, message, avatarUrl } = req.body;
    await sendDiscordWebhookMessage(username, message, avatarUrl);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to send message" });
  }
});

/**
 * Save chat message (REST) and broadcast to room
 */
app.post("/api/chatMessage", async (req, res) => {
  try {
    const { room, username, message, timestamp, avatar } = req.body;
    if (!room || !username || !message) {
      return res.status(400).json({ error: "Room, username, and message are required" });
    }
    const msgTimestamp = timestamp ? new Date(timestamp) : new Date();
    if (!db) return res.status(500).json({ error: "Database not ready" });
    await db.collection("messages").insertOne({ room, username, message, timestamp: msgTimestamp, avatar: avatar || null });
    io.to(room).emit("discord message", { username, message, avatar, timestamp: msgTimestamp.toLocaleTimeString() });
    res.json({ success: true, message: "Message saved and broadcasted" });
  } catch (err) {
    console.error("Error saving chat message:", err);
    res.status(500).json({ error: "Failed to save message" });
  }
});

/**
 * Register new user (with optional image upload to S3)
 */
app.post("/register", upload.single("image"), async (req, res) => {
  try {
    const {
      username,
      password,
      email,
      language,
      color,
      age,
      stats,
      info,
      nativeLanguage,
      colorPreference,
    } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    if (!db) return res.status(500).json({ error: "Database not ready" });

    const hashed = await bcrypt.hash(password, 10);
    const imagePath = req.file ? req.file.location || req.file.key || null : null;

    const newUser = {
      username,
      password: hashed,
      email: email || null,
      language: nativeLanguage || language || null,
      color: colorPreference || color || "#ffffff",
      age: age || null,
      stats: stats || null,
      info: info || null,
      imagePath,
      createdAt: new Date(),
    };

    await db.collection("users").insertOne(newUser);
    res.json({ success: true, message: "User registered!" });
  } catch (err) {
    console.error("Register error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Registration failed" });
  }
});

/**
 * Login
 */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!db) return res.status(500).json({ error: "Database not ready" });
    const user = await db.collection("users").findOne({ username });
    if (!user) return res.status(400).json({ error: "No such user" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });
    // Do not return password hash
    const { password: _p, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * Create or return DM room for two users
 */
app.post("/dm-room", async (req, res) => {
  try {
    const { userA, userB } = req.body;
    if (!userA || !userB) return res.status(400).json({ error: "userA and userB required" });
    const usersSorted = [userA, userB].sort();
    const roomName = `dm_${usersSorted[0]}_${usersSorted[1]}`;
    if (!db) return res.status(500).json({ error: "Database not ready" });

    let room = await db.collection("dm_rooms").findOne({ room: roomName });
    if (!room) {
      await db.collection("dm_rooms").insertOne({ room: roomName, users: usersSorted, createdAt: new Date() });
    }
    res.json({ success: true, room: roomName });
  } catch (err) {
    console.error("dm-room error:", err);
    res.status(500).json({ error: "Failed to store/load DM room" });
  }
});

/**
 * Get user info
 */
app.get("/user/:username", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: "Database not ready" });
    const user = await db.collection("users").findOne({ username: req.params.username }, { projection: { password: 0 } });
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json(user);
  } catch (err) {
    console.error("Get user error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

/**
 * Update user info (optional image upload)
 */
app.put("/user/:username", upload.single("image"), async (req, res) => {
  try {
    const { username } = req.params;
    const { email, language, color, age, stats, info } = req.body;
    const imagePath = req.file ? req.file.location || req.file.key || null : null;
    if (!db) return res.status(500).json({ error: "Database not ready" });

    const update = { email, language, color, age, stats, info };
    if (imagePath) update.imagePath = imagePath;

    await db.collection("users").updateOne({ username }, { $set: update });
    res.json({ success: true });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

/**
 * Save message in room (REST)
 */
app.post("/rooms/:room/messages", async (req, res) => {
  try {
    const { room } = req.params;
    const { username, message } = req.body;
    if (!db) return res.status(500).json({ error: "Database not ready" });
    await db.collection("messages").insertOne({ room, username, message, timestamp: new Date() });
    res.json({ success: true });
  } catch (err) {
    console.error("Save room message error:", err);
    res.status(500).json({ error: "Failed to save message" });
  }
});

/**
 * Get room messages
 */
app.get("/rooms/:room/messages", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: "Database not ready" });
    const msgs = await db.collection("messages").find({ room: req.params.room }).sort({ timestamp: 1 }).toArray();
    res.json(msgs);
  } catch (err) {
    console.error("Get room messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/**
 * Save DM message (REST)
 */
app.post("/dm-messages/:room", async (req, res) => {
  try {
    const { room } = req.params;
    const { from_user, message } = req.body;
    if (!room || !from_user || !message) return res.status(400).json({ error: "Missing data" });
    if (!db) return res.status(500).json({ error: "Database not ready" });
    await db.collection("dm_messages").insertOne({ room, from_user, message, timestamp: new Date() });
    res.json({ success: true });
  } catch (err) {
    console.error("Save DM message error:", err);
    res.status(500).json({ error: "Failed to save DM message" });
  }
});

/**
 * Load DM messages (REST)
 */
app.get("/dm-messages/:room", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: "Database not ready" });
    const messages = await db.collection("dm_messages").find({ room: req.params.room }).sort({ timestamp: 1 }).toArray();
    res.json(messages);
  } catch (err) {
    console.error("Get DM messages error:", err);
    res.status(500).json({ error: "Failed to fetch DM messages" });
  }
});

/**
 * Save private message with optional image upload (REST)
 */
app.post("/private/messages", upload.single("image"), async (req, res) => {
  try {
    const { from_user, to_user, message } = req.body;
    if (!from_user || !to_user) return res.status(400).json({ error: "Missing users" });
    if (!db) return res.status(500).json({ error: "Database not ready" });

    let fullMessage = message || "";
    if (req.file) {
      const imageUrl = req.file.location || req.file.key || null;
      fullMessage = fullMessage ? `${fullMessage} [Image: ${imageUrl}]` : `[Image: ${imageUrl}]`;
    }

    await db.collection("private_messages").insertOne({
      user1: from_user,
      user2: to_user,
      from_user,
      to_user,
      message: fullMessage,
      timestamp: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Save private message error:", err);
    res.status(500).json({ error: "Failed to save private message" });
  }
});

/**
 * Get private message history between two users
 */
app.get("/private/messages/:userA/:userB", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: "Database not ready" });
    const messages = await db
      .collection("private_messages")
      .find({
        $or: [
          { user1: req.params.userA, user2: req.params.userB },
          { user1: req.params.userB, user2: req.params.userA },
        ],
      })
      .sort({ timestamp: 1 })
      .toArray();
    res.json(messages);
  } catch (err) {
    console.error("Get private messages error:", err);
    res.status(500).json({ error: "Failed to fetch private messages" });
  }
});

/**
 * Broadcast message to a Socket.IO room (REST)
 */
app.post("/broadcast", async (req, res) => {
  try {
    const { room, username, message, timestamp } = req.body;
    if (!room || !username || !message) return res.status(400).json({ error: "Room, username, and message required" });
    io.to(room).emit("chat message", { room, username, message, timestamp });
    res.json({ success: true });
  } catch (err) {
    console.error("Broadcast error:", err);
    res.status(500).json({ error: "Broadcast failed" });
  }
});

/**
 * Submit support request -> Discord embed
 */
app.post("/submit-support", async (req, res) => {
  try {
    const { topic, description, incidentDate, reportedPerson, submittedBy } = req.body;
    if (!DISCORD_SUPPORT_URL) {
      console.warn("Discord support webhook not configured.");
      return res.status(500).send("Support webhook not configured");
    }
    const discordMessage = {
      embeds: [
        {
          title: "New Support Request",
          fields: [
            { name: "Topic", value: topic || "N/A", inline: true },
            { name: "Description", value: description || "N/A", inline: false },
            { name: "Date of Incident", value: incidentDate || "N/A", inline: true },
            { name: "Reported Person", value: reportedPerson || "N/A", inline: true },
            { name: "Submitted By", value: submittedBy || "N/A", inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const response = await fetch(DISCORD_SUPPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordMessage),
    });

    if (response.ok) {
      res.status(200).send("Support request sent to Discord!");
    } else {
      console.error("Discord support webhook failed:", response.statusText);
      res.status(500).send("Failed to send support request to Discord.");
    }
  } catch (err) {
    console.error("Submit support error:", err);
    res.status(500).send("Error sending webhook to Discord.");
  }
});

/* -------------------------
   Serve frontend
   ------------------------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* -------------------------
   Socket.IO handlers
   ------------------------- */

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;
  let profilePic = null;

  // Join a public/private room
  socket.on("joinRoom", async ({ room, username }) => {
    try {
      if (!room || !username) return;
      currentRoom = room;
      currentUser = username;
      profilePic = socket.handshake.query.profilePic || null;

      socket.join(room);
      userSockets[username] = socket.id;

      if (!roomMembers[room]) roomMembers[room] = [];
      if (!roomMembers[room].some((m) => m.username === username)) {
        roomMembers[room].push({ username, profilePic });
      }

      // Load history from DB if available
      if (db) {
        const history = await db.collection("messages").find({ room }).sort({ timestamp: 1 }).toArray();
        // send structured messages
        socket.emit(
          "loadMessages",
          history.map((m) => ({ username: m.username, message: m.message, timestamp: m.timestamp, avatar: m.avatar || null }))
        );
      } else {
        socket.emit("loadMessages", []);
      }

      io.to(room).emit("updateMembers", roomMembers[room]);
      io.to(room).emit("chat message", {
        username: "System",
        message: `${username} joined ${room}`,
        timestamp: new Date().toLocaleTimeString(),
        color: "#999",
        profileImage: null,
      });
    } catch (err) {
      console.error("joinRoom error:", err);
    }
  });

  // Leave a room
  socket.on("leaveRoom", ({ room, username }) => {
    try {
      socket.leave(room);
      if (roomMembers[room]) {
        roomMembers[room] = roomMembers[room].filter((m) => m.username !== username);
        io.to(room).emit("updateMembers", roomMembers[room]);
      }
      if (userSockets[username] && userSockets[username] === socket.id) {
        delete userSockets[username];
      }
      io.to(room).emit("chat message", {
        username: "System",
        message: `${username} left ${room}`,
        timestamp: new Date().toLocaleTimeString(),
        color: "#999",
        profileImage: null,
      });
    } catch (err) {
      console.error("leaveRoom error:", err);
    }
  });

  // Join DM room
  socket.on("joinDmRoom", async ({ dmRoom, username }) => {
    try {
      if (!dmRoom || !username) return;
      currentRoom = dmRoom;
      currentUser = username;
      profilePic = socket.handshake.query.profilePic || null;

      socket.join(dmRoom);
      userSockets[username] = socket.id;

      if (!roomMembers[dmRoom]) roomMembers[dmRoom] = [];
      if (!roomMembers[dmRoom].some((m) => m.username === username)) {
        roomMembers[dmRoom].push({ username, profilePic });
      }

      // Load DM history
      if (db) {
        const dmHistory = await db.collection("dm_messages").find({ room: dmRoom }).sort({ timestamp: 1 }).toArray();
        socket.emit(
          "loadDmMessages",
          dmHistory.map((m) => ({ from: m.from_user || m.from, message: m.message, timestamp: m.timestamp }))
        );
      } else {
        socket.emit("loadDmMessages", []);
      }

      io.to(dmRoom).emit("updateMembers", roomMembers[dmRoom]);
    } catch (err) {
      console.error("joinDmRoom error:", err);
    }
  });

  // Leave DM room
  socket.on("leaveDmRoom", ({ dmRoom, username }) => {
    try {
      socket.leave(dmRoom);
      if (roomMembers[dmRoom]) {
        roomMembers[dmRoom] = roomMembers[dmRoom].filter((m) => m.username !== username);
        io.to(dmRoom).emit("updateMembers", roomMembers[dmRoom]);
      }
      if (userSockets[username] && userSockets[username] === socket.id) {
        delete userSockets[username];
      }
      if (currentRoom === dmRoom) currentRoom = null;
      if (currentUser === username) currentUser = null;
    } catch (err) {
      console.error("leaveDmRoom error:", err);
    }
  });

  // Public chat message (Socket)
  socket.on("chat message", async ({ room, username, message, timestamp, color, profileImage }) => {
    try {
      if (!room || !username || !message) return;
      const ts = timestamp || new Date();
      if (db) {
        await db.collection("messages").insertOne({ room, username, message, timestamp: ts, color: color || null, profileImage: profileImage || null });
      }
      io.to(room).emit("chat message", { username, message, timestamp: ts, color: color || null, profileImage: profileImage || null });
    } catch (err) {
      console.error("chat message error:", err);
    }
  });

  // DM message (Socket)
  socket.on("dm message", async ({ room, to, from, message, timestamp, color, profileImage }) => {
    try {
      if (!room || !from || !message) return;
      const ts = timestamp || new Date();
      if (db) {
        await db.collection("dm_messages").insertOne({ room, from_user: from, to_user: to, message, color: color || null, profileImage: profileImage || null, timestamp: ts });
      }
      io.to(room).emit("private message", { room, to, from, message, color: color || null, profileImage: profileImage || null, timestamp: ts });
    } catch (err) {
      console.error("dm message error:", err);
    }
  });

  // Request private history (callback)
  socket.on("get private history", async ({ room }, callback) => {
    try {
      if (!db) return callback([]);
      const messages = await db.collection("dm_messages").find({ room }).sort({ timestamp: 1 }).toArray();
      callback(messages);
    } catch (err) {
      console.error("get private history error:", err);
      callback([]);
    }
  });

  // Request to create DM (notify recipient)
  socket.on("request-create-dm", async ({ from, to, room }) => {
    try {
      const usersSorted = [from, to].sort();
      if (db) {
        let savedRoom = await db.collection("dm_rooms").findOne({ room });
        if (!savedRoom) {
          await db.collection("dm_rooms").insertOne({ room, users: usersSorted, createdAt: new Date() });
        }
      }
      const recipientSocket = userSockets[to];
      if (recipientSocket) {
        io.to(recipientSocket).emit("create-dm", { from, room });
      }
    } catch (err) {
      console.error("request-create-dm error:", err);
    }
  });

  // Invite user to a room (Socket)
  socket.on("invite_user", ({ roomName, targetUsername }) => {
    try {
      const username = socket.data?.username || currentUser;
      if (!roomName || !targetUsername) return;
      // Only notify the target; server-side invite persistence can be added
      const targetSocket = userSockets[targetUsername];
      if (targetSocket) {
        io.to(targetSocket).emit("invited", { room: roomName, from: username || "system" });
      }
      socket.emit("invite_sent", { room: roomName, to: targetUsername });
    } catch (err) {
      console.error("invite_user error:", err);
    }
  });

  // Remove user from room (Socket)
  socket.on("remove_user", ({ roomName, targetUsername }) => {
    try {
      const username = socket.data?.username || currentUser;
      if (!roomName || !targetUsername) return;
      if (roomMembers[roomName]) {
        roomMembers[roomName] = roomMembers[roomName].filter((m) => m.username !== targetUsername);
        io.to(roomName).emit("updateMembers", roomMembers[roomName]);
      }
      const targetSocket = userSockets[targetUsername];
      if (targetSocket) {
        io.to(targetSocket).emit("removed", { room: roomName, by: username || "system" });
        // force leave
        io.sockets.sockets.get(targetSocket)?.leave(roomName);
      }
      socket.emit("user_removed", { room: roomName, user: targetUsername });
    } catch (err) {
      console.error("remove_user error:", err);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    try {
      if (currentRoom && currentUser) {
        if (roomMembers[currentRoom]) {
          roomMembers[currentRoom] = roomMembers[currentRoom].filter((m) => m.username !== currentUser);
          io.to(currentRoom).emit("updateMembers", roomMembers[currentRoom]);
        }
        if (userSockets[currentUser] && userSockets[currentUser] === socket.id) {
          delete userSockets[currentUser];
        }
      }
    } catch (err) {
      console.error("disconnect error:", err);
    }
  });
});

/* -------------------------
   Start server
   ------------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
