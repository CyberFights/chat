// server.js (rename this as the src in your package.json)
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });

  socket.on("chat message", (msg) => {
    const messageWithMeta = {
      username: socket.username,
      message: msg,
      date: new Date().toLocaleString(),
    };

    io.emit("chat message", messageWithMeta);
  });

  socket.on("set username", (username) => {
    socket.username = username;
  });

  socket.on("publish media", ({ dataUrl, fileType }) => {
    console.log("Media publishing functionality removed");
  });
});

// Handle 404 errors
app.use((req, res, next) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
