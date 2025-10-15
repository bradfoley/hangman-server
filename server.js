// Express + Socket.IO server for Render (sessions + join flow + debug routes)
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

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
  io.to(code).emit("session:players", payload);
  if (s.atvSocketId) io.to(s.atvSocketId).emit("session:players", payload);
}

/** -------------------------
 * HTTP routes
 * ------------------------- */
app.get("/", (_req, res) => {
  res.send("✅ Hangman server is running (Render) — sessions & debug ready.");
});

// Create a session (simulates ATV); returns {code}
app.get("/debug/create", (_req, res) => {
  const fakeAtvId = "HTTP_DEBUG_ATV_" + Math.random().toString(36).slice(2, 8);
  const code = createSession(fakeAtvId);
  console.log(`🐞 [HTTP] created session ${code} (fake ATV ${fakeAtvId})`);
  res.json({ code });
});

// Join a session (simulates phone); /debug/join?code=XXXXXX&name=Alice
app.get("/debug/join", (req, res) => {
  let { code = "", name = "Player" } = req.query;
  code = String(code).trim().toUpperCase();
  name = String(name).slice(0, 16);

  const s = getSession(code);
  if (!s) {
    res.status(400).json({ error: "Invalid or expired code." });
    return;
  }

  const isManager = s.players.length === 0;
  const fakeSocketId = "HTTP_DEBUG_PLAYER_" + Math.random().toString(36).slice(2, 8);
  s.players.push({ id: fakeSocketId, name, isManager });
  console.log(`🐞 [HTTP] ${name} joined ${code} ${isManager ? "(manager)" : ""}`);

  emitPlayerList(code);
  res.json({ ok: true, code, name, isManager });
});

// View sessions & players
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

// Reset all
app.get("/debug/reset", (_req, res) => {
  sessions.clear();
  res.json({ ok: true });
});

/** -------------------------
 * Socket.IO events
 * ------------------------- */
io.on("connection", (socket) => {
  console.log("🔌 connected:", socket.id);
  socket.data.code = null;

  // Log all events for visibility
  socket.onAny((event, ...args) => {
    console.log(`📨 [${socket.id}] ${event}`, args.length ? args[0] : "");
  });

  // ATV: create session
  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.emit("session:created", { code });
    console.log(`📺 ATV created session ${code}`);
  });

  // ATV: request current players (useful after reconnect)
  socket.on("atv:getPlayers", ({ code }) => {
    const s = getSession(code);
    if (!s) { socket.emit("session:ended"); return; }
    emitPlayerList(code);
  });

  // Phone: join session
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

  // Cleanup on disconnect
  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (code && sessions.has(code)) {
      const s = sessions.get(code);
      if (s.atvSocketId === socket.id) {
        sessions.delete(code);
        io.to(code).emit("session:ended");
        console.log(`🗑️ session ${code} ended (ATV left)`);
      } else {
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
