// Express + Socket.IO server for Render (sessions + join flow + robust updates)
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (_req, res) =>
  res.send("✅ Hangman server is running (Render) — sessions ready.")
);

// Quick debug endpoint
app.get("/debug/sessions", (_req, res) => {
  const out = [];
  for (const [code, s] of sessions) {
    out.push({
      code,
      atvSocketId: s.atvSocketId,
      players: s.players.map(p => ({ id: p.id, name: p.name, isManager: p.isManager })),
      createdAt: s.createdAt,
    });
  }
  res.json(out);
});

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
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ"; // avoid ambiguous
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
  const payload = {
    code,
    players: s.players.map(p => ({ id: p.id, name: p.name, isManager: p.isManager }))
  };
  // Emit to the room (ATV + all phones)
  io.to(code).emit("session:players", payload);
  // Also emit directly to ATV as a backup
  if (s.atvSocketId) io.to(s.atvSocketId).emit("session:players", payload);
}

io.on("connection", (socket) => {
  console.log("🔌 connected:", socket.id);
  socket.data.code = null; // track which room this socket belongs to

  /** ATV creates a session */
  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.emit("session:created", { code });
    console.log(`📺 ATV created session ${code}`);
  });

  /** ATV requests current player list (e.g. on page reload) */
  socket.on("atv:getPlayers", ({ code }) => {
    const s = getSession(code);
    if (!s) { socket.emit("session:ended"); return; }
    emitPlayerList(code);
  });

  /** Phone joins a session with name + code */
  socket.on("player:join", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const s = getSession(code);
    if (!s) { socket.emit("error:join", { message: "Invalid or expired code." }); return; }

    const safeName = String(name || "Player").slice(0, 16);
    const isManager = s.players.length === 0;

    s.players.push({ id: socket.id, name: safeName, isManager });
    socket.join(code);
    socket.data.code = code;

    socket.emit("player:joined", { code, isManager });
    emitPlayerList(code);

    console.log(`👤 ${safeName} joined ${code} ${isManager ? "(manager)" : ""}`);
  });

  /** Handle disconnects and cleanup */
  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (code && sessions.has(code)) {
      const s = sessions.get(code);
      // If ATV disconnected, end session
      if (s.atvSocketId === socket.id) {
        sessions.delete(code);
        io.to(code).emit("session:ended");
        console.log(`🗑️ session ${code} ended (ATV left)`);
      } else {
        // Remove as a player if present
        const idx = s.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
          const wasManager = s.players[idx].isManager;
          s.players.splice(idx, 1);
          if (wasManager && s.players.length > 0) s.players[0].isManager = true;
          emitPlayerList(code);
        }
      }
    }
    console.log("❌ disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
