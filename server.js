// Express + Socket.IO server for Render
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("✅ Hangman server is running (Render)."));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

io.on("connection", (socket) => {
  console.log("🔌 client connected:", socket.id);
  socket.emit("hello", { msg: "Welcome from Hangman server" });
  socket.on("disconnect", () => console.log("❌ client disconnected:", socket.id));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
