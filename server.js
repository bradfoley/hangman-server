// Hangman server — stable baseline (full)
// Features: 4-char codes, players ≤10, ≥2 to start, rounds-as-laps, rename, hint, scoring
// Settings now LOCK once the game has started (Step 3 change only)

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

// ----------------------------
// Sessions & helpers
// ----------------------------
const sessions = new Map(); // code -> session
const CODE_TTL_MS = 1000 * 60 * 60 * 2; // 2h

function makeCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid 0,O,1,I
  let code = "";
  do {
    code = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (sessions.has(code));
  return code;
}

function createSession(atvSocketId) {
  const code = makeCode(4);
  const s = {
    atvSocketId,
    createdAt: Date.now(),
    players: [],
    settings: { rounds: 3, minLen: 3, maxLen: 50 },
    game: null
  };
  sessions.set(code, s);
  console.log(`🆕 Session created code=${code} (atv=${atvSocketId})`);
  return code;
}

function getSession(code) {
  const s = sessions.get(code);
  if (!s) return null;
  if (Date.now() - s.createdAt > CODE_TTL_MS) { sessions.delete(code); return null; }
  return s;
}

function normalizePhrase(input) {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '-.";
  const up = String(input || "").toUpperCase().replace(/\s+/g, " ").trim();
  for (const ch of up) if (!allowed.includes(ch)) return null;
  return up;
}

function buildMasked(raw, guessedSet) {
  let out = "";
  for (const ch of raw) {
    if (/[A-Z]/.test(ch)) out += guessedSet.has(ch) ? ch : "_";
    else out += ch; // show digits/space/punct
  }
  return out;
}

function currentTurnPlayerId(s) {
  const r = s.game?.round; if (!r) return null;
  if (!r.guesserOrder || r.guesserOrder.length === 0) return null;
  return r.guesserOrder[r.turnIndex % r.guesserOrder.length];
}

function advanceTurn(s) {
  const r = s.game.round;
  if (!r.guesserOrder || r.guesserOrder.length === 0) return;
  r.turnIndex = (r.turnIndex + 1) % r.guesserOrder.length;
}

function emitSessionPlayers(code) {
  const s = sessions.get(code); if (!s) return;
  io.to(code).emit("session:players", {
    code,
    players: s.players.map(p => ({ id: p.id, name: p.name, isManager: p.isManager, score: p.score ?? 0 }))
  });
}

function emitGameState(code) {
  const s = sessions.get(code); if (!s) return;
  const g = s.game;
  const currentTurnId = (g && g.state === "active") ? currentTurnPlayerId(s) : null;
  io.to(code).emit("game:state", {
    state: g?.state ?? "idle",
    roundsTotal: s.settings.rounds,
    roundIndex: g?.roundIndex ?? -1,
    setterId: g?.round?.setterId ?? null,
    currentTurnId,
    hintShown: g?.round?.hintShown ?? false,
    masked: g?.round?.masked ?? "",
    guessedLetters: g?.round?.guessedLetters ?? [],
    winnerId: g?.round?.winnerId ?? null,
    scores: s.players.map(p => ({ id: p.id, score: p.score ?? 0 }))
  });
}

// ----------------------------
// HTTP debug
// ----------------------------
app.get("/", (_req, res) => res.send("✅ Hangman server up"));
app.get("/debug/reset", (_req, res) => { sessions.clear(); res.json({ ok: true }); });
app.get("/debug/create", (_req, res) => {
  const code = createSession("HTTP_DEBUG");
  res.json({ code });
});

// ----------------------------
// Socket.IO
// ----------------------------
io.on("connection", (socket) => {
  socket.data.code = null;

  // ATV creates new session
  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.emit("session:created", { code });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // ATV reconnects to existing session
  socket.on("atv:getPlayers", ({ code }) => {
    code = String(code || "").trim().toUpperCase();
    const s = getSession(code);
    if (!s) { socket.emit("session:ended"); return; }
    socket.join(code);
    socket.data.code = code;
    s.atvSocketId = socket.id;            // rebind ATV ownership
    socket.emit("session:created", { code }); // always re-send code
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Phone joins
  socket.on("player:join", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const s = getSession(code);
    if (!s) { socket.emit("error:join", { message: "Invalid or expired code." }); return; }
    if (s.players.length >= 10) { socket.emit("error:join", { message: "Game is full (max 10 players)." }); return; }

    const safeName = String(name || "Player").slice(0, 16);
    const isManager = s.players.length === 0;
    s.players.push({ id: socket.id, name: safeName, isManager, score: 0 });

    socket.join(code);
    socket.data.code = code;
    socket.emit("player:joined", { code, isManager });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  socket.on("player:rejoin", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const s = getSession(code);
    if (!s) return; // invalid/expired
    const safeName = String(name || "Player").slice(0, 16);
  
    // If someone with that name already exists, reuse that slot
    let existing = s.players.find(p => p.name === safeName);
    if (existing) {
      existing.id = socket.id;
    } else {
      s.players.push({ id: socket.id, name: safeName, isManager: false, score: 0 });
    }
  
    socket.join(code);
    socket.data.code = code;
    socket.emit("player:joined", { code, isManager: existing?.isManager ?? false });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Rename
  socket.on("player:rename", ({ name }) => {
    const code = socket.data.code;
    const s = sessions.get(code); if (!s) return;
    const me = s.players.find(p => p.id === socket.id); if (!me) return;
    const nn = String(name || "").trim().slice(0, 24); if (!nn) return;
    me.name = nn;
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Manager sets settings
  socket.on("manager:setSettings", ({ rounds, minLen, maxLen }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s) return;
    const me = s.players.find(p => p.id === socket.id); if (!me?.isManager) return;

    // ✅ Step 3: LOCK settings once game is not idle
    if (s.game && s.game.state && s.game.state !== "idle") {
      return; // ignore changes after start
    }

    if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 20) s.settings.rounds = rounds;
    if (Number.isInteger(minLen) && minLen >= 1 && minLen <= 40) s.settings.minLen = minLen;
    if (Number.isInteger(maxLen) && maxLen >= s.settings.minLen && maxLen <= 60) s.settings.maxLen = maxLen;
    emitGameState(code);
  });

  // Manager starts game (rounds-as-laps)
  socket.on("manager:startGame", () => {
    const code = socket.data.code; const s = sessions.get(code); if (!s) return;
    const mgr = s.players.find(p => p.id === socket.id && p.isManager); if (!mgr) return;
    if (s.players.length < 2) { socket.emit("error:start", { message: "Need at least 2 players to start." }); return; }

    s.game = s.game || {};
    s.game.roundIndex = 0;
    s.game.setterOrder = buildSetterOrder(s);
    s.game.setterPointer = 0;

    if (!s.game.setterOrder.length) {
      s.game.state = "idle";
      emitGameState(code);
      return;
    }
    startWaitingForPhrase(s);
  });

  // Manager advances after a win
  socket.on("manager:nextRound", () => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game) return;
    const mgr = s.players.find(p => p.id === socket.id && p.isManager); if (!mgr) return;

    s.game.setterPointer += 1;
    if (maybeGameOver(s)) return;
    startWaitingForPhrase(s);
  });

  // Setter submits phrase
  socket.on("setter:submitPhrase", ({ phrase, hint }) => {
    const code = socket.data.code; const s = sessions.get(code);
    if (!s || !s.game || s.game.state !== "waiting_phrase") return;

    const r = s.game.round;
    if (!r || r.setterId !== socket.id) return;

    const rawInput = String(phrase || "").trim();
    if (rawInput.length < 3 || rawInput.length > 50) {
      socket.emit("error:phrase", { message: "Phrase must be 3–50 characters." });
      return;
    }
    const norm = normalizePhrase(rawInput);
    if (!norm) {
      socket.emit("error:phrase", { message: "Only letters, numbers, spaces, apostrophes, dashes, and periods are allowed." });
      return;
    }

    r.raw = norm;
    r.hint = String(hint || "").slice(0, 120);
    r.hintShown = false;
    r.guessedLetters = [];

    r.masked = buildMasked(r.raw, new Set());
    const guessers = s.players.filter(p => p.id !== r.setterId).map(p => p.id);
    r.guesserOrder = guessers;
    r.turnIndex = 0;

    s.game.state = "active";
    emitGameState(code);
    socket.emit("setter:ok");
  });

  // Setter shows hint
  socket.on("setter:showHint", () => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round; if (socket.id !== r.setterId) return;
    if (!r.hintShown) {
      r.hintShown = true;
      io.to(code).emit("game:hint", { hint: r.hint });
      emitGameState(code);
    }
  });

  // Guess a letter
  socket.on("player:guessLetter", ({ letter }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round;
    const meId = socket.id;
    if (meId !== currentTurnPlayerId(s)) return;

    const L = String(letter || "").toUpperCase();
    if (!/^[A-Z]$/.test(L)) return;
    if (r.guessedLetters.includes(L)) return;

    r.guessedLetters.push(L);
    r.masked = buildMasked(r.raw, new Set(r.guessedLetters));

    if (!r.masked.includes("_")) {
      s.game.state = "won";
      r.winnerId = meId;
      const pts = r.hintShown ? 1 : 2;
      const winner = s.players.find(p => p.id === meId); if (winner) winner.score = (winner.score || 0) + pts;
      emitSessionPlayers(code); // ensure scores update everywhere
      emitGameState(code);
      return;
    }

    advanceTurn(s);
    emitGameState(code);
  });

  // Attempt full solve
  socket.on("player:solve", ({ guess }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round;
    const meId = socket.id;
    if (meId !== currentTurnPlayerId(s)) return;

    const normGuess = normalizePhrase(guess); if (!normGuess) return;
    if (normGuess === r.raw) {
      s.game.state = "won";
      r.winnerId = meId;
      const pts = r.hintShown ? 1 : 2;
      const winner = s.players.find(p => p.id === meId); if (winner) winner.score = (winner.score || 0) + pts;
      r.masked = r.raw;
      emitSessionPlayers(code); // ensure scores update everywhere
      emitGameState(code);
    } else {
      advanceTurn(s);
      emitGameState(code);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (!code || !sessions.has(code)) return;
    const s = sessions.get(code);

    // ATV disconnect
    if (s.atvSocketId === socket.id) {
      const hasPlayers = s.players.length > 0;
      if (hasPlayers) { s.atvSocketId = null; return; }
      sessions.delete(code);
      io.to(code).emit("session:ended");
      return;
    }

    // Phone disconnect
    const idx = s.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const wasManager = s.players[idx].isManager;
      const removedId = s.players[idx].id;
      s.players.splice(idx, 1);

      if (wasManager && s.players.length > 0) s.players[0].isManager = true;

      if (s.game?.round?.guesserOrder) {
        const gidx = s.game.round.guesserOrder.indexOf(removedId);
        if (gidx !== -1) s.game.round.guesserOrder.splice(gidx, 1);
        if (s.game.round.guesserOrder.length === 0 && s.game.state === "active") {
          s.game.state = "won";
          s.game.round.winnerId = null;
        }
      }
    }

    emitSessionPlayers(code);
    emitGameState(code);
  });
});

// ----------------------------
// Round helpers
// ----------------------------
function buildSetterOrder(s) {
  const ids = s.players.map(p => p.id);
  const laps = Math.max(1, parseInt(s.settings.rounds || 1, 10));
  const order = [];
  for (let r = 0; r < laps; r++) order.push(...ids);
  return order;
}

function startWaitingForPhrase(s) {
  const code = [...sessions.entries()].find(([c, v]) => v === s)?.[0];
  const sp = s.game.setterPointer;
  const setterId = s.game.setterOrder[sp];

  s.game.round = {
    raw: "",
    masked: "",
    guessedLetters: [],
    hint: "",
    hintShown: false,
    setterId,
    winnerId: null
  };

  s.game.state = "waiting_phrase";
  emitSessionPlayers(code);
  emitGameState(code);
}

function maybeGameOver(s) {
  const total = s.game.setterOrder.length;
  if (s.game.setterPointer >= total) {
    s.game.state = "over";
    s.game.round = null;
    const code = [...sessions.entries()].find(([c, v]) => v === s)?.[0];
    emitGameState(code);
    return true;
  }
  return false;
}

// ----------------------------
// Start server
// ----------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));