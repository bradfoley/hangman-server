// Hangman server — sessions + rounds + guesses + hint + scoring + debug + verbose logs
// CommonJS (Render-friendly)

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/** -------------------------
 * Sessions & Game State
 * ------------------------- */
const sessions = new Map(); // code -> Session
const CODE_TTL_MS = 1000 * 60 * 60 * 2;

function makeCode() {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 2; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return code;
}

function createSession(atvSocketId) {
  let code;
  do { code = makeCode(); } while (sessions.has(code));
  const s = {
    atvSocketId,
    createdAt: Date.now(),
    players: [], // phones only: {id,name,isManager,score}
    settings: { rounds: 3, minLen: 3, maxLen: 24 },
    game: null
  };
  sessions.set(code, s);
  return code;
}

function getSession(code) {
  const s = sessions.get(code);
  if (!s) return null;
  if (Date.now() - s.createdAt > CODE_TTL_MS) { sessions.delete(code); return null; }
  return s;
}

function newGame() {
  return {
    roundIndex: -1,
    setterIndex: -1,       // rotates across PHONE players
    state: "idle",         // idle | waiting_phrase | active | won | over
    round: null
  };
}

function startNextRound(session) {
  if (!session.game) session.game = newGame();

  session.game.roundIndex += 1;
  if (session.game.roundIndex >= session.settings.rounds) {
    session.game.state = "over";
    session.game.round = null;
    return;
  }

  // rotate setter among PHONE players (exclude ATV)
  const phonePlayers = session.players; // ATV is never in players now
  if (phonePlayers.length === 0) {
    session.game.state = "idle";
    session.game.round = null;
    return;
  }

  session.game.setterIndex = (session.game.setterIndex + 1) % phonePlayers.length;
  const setterId = phonePlayers[session.game.setterIndex].id;

  session.game.state = "waiting_phrase";
  session.game.round = {
    setterId,
    phrase: null,
    hint: "",
    masked: "",
    raw: "",
    guessedLetters: [],
    hintShown: false,
    turnIndex: 0,
    guesserOrder: phonePlayers.filter(p => p.id !== setterId).map(p => p.id),
    winnerId: null
  };
}

function normalizePhrase(input) {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ '-.";
  const up = String(input || "").toUpperCase().replace(/\s+/g, " ").trim();
  for (const ch of up) if (!allowed.includes(ch)) return null;
  return up;
}

function buildMasked(raw, guessedSet) {
  let out = "";
  for (const ch of raw) {
    if (/[A-Z]/.test(ch)) out += guessedSet.has(ch) ? ch : "_";
    else out += ch;
  }
  return out;
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
  io.to(code).emit("game:state", {
    state: g?.state ?? "idle",
    roundsTotal: s.settings.rounds,
    roundIndex: g?.roundIndex ?? -1,
    setterId: g?.round?.setterId ?? null,
    hintShown: g?.round?.hintShown ?? false,
    masked: g?.round?.masked ?? "",
    guessedLetters: g?.round?.guessedLetters ?? [],
    winnerId: g?.round?.winnerId ?? null,
    scores: s.players.map(p => ({ id: p.id, score: p.score ?? 0 }))
  });
}

function currentTurnPlayerId(session) {
  const r = session.game?.round; if (!r) return null;
  if (!r.guesserOrder || r.guesserOrder.length === 0) return null;
  return r.guesserOrder[r.turnIndex % r.guesserOrder.length];
}

function advanceTurn(session) {
  const r = session.game.round;
  if (!r.guesserOrder || r.guesserOrder.length === 0) return;
  r.turnIndex = (r.turnIndex + 1) % r.guesserOrder.length;
}

/** -------------------------
 * HTTP debug helpers
 * ------------------------- */
app.get("/", (_req, res) => res.send("✅ Hangman server running — sessions & rounds ready."));

app.get("/debug/sessions", (_req, res) => {
  const out = [];
  for (const [code, s] of sessions) {
    out.push({
      code,
      players: s.players.map(p => ({ id: p.id, name: p.name, score: p.score ?? 0, isManager: p.isManager })),
      settings: s.settings,
      game: s.game ? {
        state: s.game.state,
        roundIndex: s.game.roundIndex,
        setterIndex: s.game.setterIndex,
        round: s.game.round ? {
          setterId: s.game.round.setterId,
          masked: s.game.round.masked,
          guessedLetters: s.game.round.guessedLetters,
          hintShown: s.game.round.hintShown,
          winnerId: s.game.round.winnerId
        } : null
      } : null
    });
  }
  res.json(out);
});

// HTTP reset all sessions
app.get("/debug/reset", (_req, res) => { sessions.clear(); res.json({ ok: true }); });

// HTTP create (simulate ATV)
app.get("/debug/create", (_req, res) => {
  const fakeAtvId = "HTTP_DEBUG_ATV_" + Math.random().toString(36).slice(2, 8);
  const code = createSession(fakeAtvId);
  res.json({ code });
});

// HTTP join (simulate phone)
app.get("/debug/join", (req, res) => {
  let { code = "", name = "Player" } = req.query;
  code = String(code).trim().toUpperCase();
  name = String(name).slice(0, 16);

  const s = getSession(code);
  if (!s) return res.status(400).json({ error: "Invalid or expired code." });

  const isManager = s.players.length === 0; // first phone is manager
  const fakeSocketId = "HTTP_" + Math.random().toString(36).slice(2, 8);
  s.players.push({ id: fakeSocketId, name, isManager, score: 0 });

  emitSessionPlayers(code);
  emitGameState(code);
  res.json({ ok: true, code, name, isManager });
});

/** -------------------------
 * Socket events
 * ------------------------- */
io.on("connection", (socket) => {
  socket.data.code = null;

  // Log every event & payload for visibility
  socket.onAny((event, payload) => {
    console.log(`📨 ${socket.id} -> ${event}`, payload || "");
  });

  // ATV creates session (ATV is NOT a player)
  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.emit("session:created", { code });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // ATV: fetch current lists after reconnect
  socket.on("atv:getPlayers", ({ code }) => {
    if (!getSession(code)) { socket.emit("session:ended"); return; }
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Phone join (first phone becomes manager)
  socket.on("player:join", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const s = getSession(code);
    if (!s) { socket.emit("error:join", { message: "Invalid or expired code." }); return; }

    const safeName = String(name || "Player").slice(0, 16);
    const isManager = s.players.length === 0;

    s.players.push({ id: socket.id, name: safeName, isManager, score: 0 });
    socket.join(code);
    socket.data.code = code;

    socket.emit("player:joined", { code, isManager });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Manager: settings & start
  socket.on("manager:setSettings", ({ rounds, minLen, maxLen }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s) return;
    const me = s.players.find(p => p.id === socket.id); if (!me?.isManager) return;

    if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 20) s.settings.rounds = rounds;
    if (Number.isInteger(minLen) && minLen >= 1 && minLen <= 40) s.settings.minLen = minLen;
    if (Number.isInteger(maxLen) && maxLen >= s.settings.minLen && maxLen <= 60) s.settings.maxLen = maxLen;

    emitGameState(code);
  });

  socket.on("manager:startGame", () => {
    const code = socket.data.code; const s = sessions.get(code); if (!s) return;
    const me = s.players.find(p => p.id === socket.id); if (!me?.isManager) return;

    if (!s.game) s.game = newGame();
    startNextRound(s);
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Setter submits phrase + hint
  socket.on("setter:submitPhrase", ({ phrase, hint }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "waiting_phrase") return;
    const r = s.game.round;
    if (socket.id !== r.setterId) return;

    const norm = normalizePhrase(phrase);
    if (!norm) { socket.emit("error:phrase", { message: "Invalid characters. Use letters, space, ', -, ." }); return; }

    const onlyLetters = norm.replace(/[^A-Z]/g, "");
    if (onlyLetters.length < s.settings.minLen || onlyLetters.length > s.settings.maxLen) {
      socket.emit("error:phrase", { message: `Length must be ${s.settings.minLen}-${s.settings.maxLen} letters.` });
      return;
    }

    r.raw = norm;
    r.hint = String(hint || "").slice(0, 100);
    r.guessedLetters = [];
    r.hintShown = false;

    // guessers are all phones except the setter
    r.guesserOrder = s.players.filter(p => p.id !== r.setterId).map(p => p.id);
    r.turnIndex = 0;

    r.masked = buildMasked(r.raw, new Set(r.guessedLetters));
    s.game.state = "active";

    socket.emit("setter:ok", { ok: true });
    emitGameState(code);
  });

  // Setter shows hint (reduces points to 1)
  socket.on("setter:showHint", () => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round; if (socket.id !== r.setterId) return;
    if (!r.hintShown) {
      r.hintShown = true;
      io.to(code).emit("game:hint", { hint: r.hint });
      emitGameState(code);
    }
  });

  // Player guesses ONE letter (must be their turn)
  socket.on("player:guessLetter", ({ letter }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round;
    const meId = socket.id;
    if (meId !== currentTurnPlayerId(s)) return; // not your turn

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

      emitGameState(code);
      setTimeout(() => { startNextRound(s); emitSessionPlayers(code); emitGameState(code); }, 800);
      return;
    }

    advanceTurn(s);
    emitGameState(code);
  });

  // Player attempts full solve (must be their turn)
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

      emitGameState(code);
      setTimeout(() => { startNextRound(s); emitSessionPlayers(code); emitGameState(code); }, 800);
    } else {
      advanceTurn(s);
      emitGameState(code);
    }
  });

  // Disconnect cleanup
  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (!code || !sessions.has(code)) return;
    const s = sessions.get(code);

    if (s.atvSocketId === socket.id) {
      sessions.delete(code);
      io.to(code).emit("session:ended");
      return;
    }

    const idx = s.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const wasManager = s.players[idx].isManager;
      const removedId = s.players[idx].id;
      s.players.splice(idx, 1);

      if (wasManager && s.players.length > 0) {
        s.players[0].isManager = true;
      }

      if (s.game?.round?.guesserOrder) {
        const gidx = s.game.round.guesserOrder.indexOf(removedId);
        if (gidx !== -1) s.game.round.guesserOrder.splice(gidx, 1);
        if (s.game.round.guesserOrder.length === 0 && s.game.state === "active") {
          s.game.state = "won";
          s.game.round.winnerId = null;
          setTimeout(() => { startNextRound(s); emitSessionPlayers(code); emitGameState(code); }, 400);
        }
      }
    }
    emitSessionPlayers(code);
    emitGameState(code);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
