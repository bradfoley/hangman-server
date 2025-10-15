// Express + Socket.IO server for Render (sessions + join flow)
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (_req, res) =>
  res.send("✅ Hangman server is running (Render) — sessions ready.")
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

/** -------------------------
 * In-memory session store
 * ------------------------- */
const sessions = new Map(); // code -> { atvSocketId, players:[{id,name,isManager}], createdAt }
const CODE_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

function makeCode() {
  // 4 letters + 2 digits (e.g., QJBR27)
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ"; // skip ambiguous
  const digits = "23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 2; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return code;
}

function createSession(atvSocketId) {
  let code;
  do { code = makeCode(); } while (sessions.has(code));
  sessions.set(code, { atvSocketId, players: [], createdAt: Date.now() });
  return code;
}

function getSession(code) {
  const s = sessions.get(code);
  if (!s) return null;
  if (Date.now() - s.createdAt > CODE_TTL_MS) { sessions.delete(code); return null; }
  return s;
}

function emitPlayerList(code) {
  const s = sessions.get(code);
  if (!s) return;
  io.to(code).emit("session:players", {
    code,
    players: s.players.map(p => ({ id: p.id, name: p.name, isManager: p.isManager }))
  });
}

io.on("connection", (socket) => {
  console.log("🔌 connected:", socket.id);

  /** ATV creates a session */
  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    socket.join(code); // ATV sits in its own room
    socket.emit("session:created", { code });
    console.log(`📺 ATV created session ${code}`);
  });

  /** Phone joins a session with name + code */
  socket.on("player:join", ({ code, name }) => {
    const s = getSession(code);
    if (!s) { socket.emit("error:join", { message: "Invalid or expired code." }); return; }

    // First player becomes manager
    const isManager = s.players.length === 0;
    s.players.push({ id: socket.id, name: String(name || "Player").slice(0, 16), isManager });

    socket.join(code);
    socket.emit("player:joined", { code, isManager });
    emitPlayerList(code);

    console.log(`👤 ${name} joined ${code} ${isManager ? "(manager)" : ""}`);
  });

  /** Leave / disconnect cleanup */
  socket.on("disconnect", () => {
    // Remove player from any session and reassign manager if needed
    for (const [code, s] of sessions.entries()) {
      const idx = s.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const wasManager = s.players[idx].isManager;
        s.players.splice(idx, 1);

        // If manager left, pick next player as manager
        if (wasManager && s.players.length > 0) {
          s.players[0].isManager = true;
        }

        // If ATV itself disconnected, trash the session
        if (s.atvSocketId === socket.id) {
          sessions.delete(code);
          io.to(code).emit("session:ended");
          console.log(`🗑️ session ${code} ended (ATV left)`);
        } else {
          emitPlayerList(code);
        }
      }
    }
    console.log("❌ disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
