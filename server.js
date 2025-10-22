// Hangman server — sessions + rounds + guesses + hint + scoring + wrong-guess limit + debug + verbose logs
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

function makeCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid 0,O,1,I
  let code = "";
  do {
    code = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (sessions.has(code));
  return code;
}

function createSession(atvSocketId) {
  let code;
  do { code = makeCode(); } while (sessions.has(code));
  const s = {
    atvSocketId,
    createdAt: Date.now(),
    players: [], // phones only
    settings: { 
      rounds: 3,               // 🔸 default rounds = 3 (was 1)
      minLen: 3, 
      maxLen: 50,
      wrongLimit: 6,           // number of wrong guesses allowed
      unlimitedWrong: false    // if true -> ignore wrongLimit
    },
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
    round: null,
    setterOrder: [],
    setterPointer: 0
  };
}

function buildSetterOrder(s) {
  // snapshot player IDs in join order at start
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
    winnerId: null,
    wrongCount: 0, // wrong guesses in this round
    guesserOrder: [],
    turnIndex: 0
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

function normalizePhrase(input) {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ '-.";
  const up = String(input || "").toUpperCase().replace(/\s+/g, " ").trim();
  for (const ch of up) if (!allowed.includes(ch)) return null;
  return up;
}

function buildMasked(raw, guessedSet) {
  let out = "";
  for (const ch of raw) {
    if (/[A-Za-z]/.test(ch)) out += guessedSet.has(ch.toUpperCase()) ? ch.toUpperCase() : "_";
    else out += ch;
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
  const currentTurnId = s.game && s.game.state === "active" ? currentTurnPlayerId(s) : null;
  io.to(code).emit("game:state", {
    state: g?.state ?? "idle",
    roundsTotal: s.settings.rounds,              // for Puzzle X/Y
    roundIndex: g?.setterPointer ?? -1,          // 0-based index of current puzzle
    setterId: g?.round?.setterId ?? null,
    currentTurnId,
    hintShown: g?.round?.hintShown ?? false,
    masked: g?.round?.masked ?? "",
    guessedLetters: g?.round?.guessedLetters ?? [],
    winnerId: g?.round?.winnerId ?? null,
    wrongLimit: s.settings.unlimitedWrong ? null : (s.settings.wrongLimit ?? 6),
    wrongCount: g?.round?.wrongCount ?? 0,
    scores: s.players.map(p => ({ id: p.id, score: p.score ?? 0 }))
  });
}

/** -------------------------
 * HTTP debug helpers
 * ------------------------- */
app.get("/", (_req, res) => res.send("✅ Hangman server running — sessions & rounds & wrong-limit ready."));
app.get("/debug/reset", (_req, res) => { sessions.clear(); res.json({ ok: true }); });
app.get("/debug/create", (_req, res) => {
  const fakeAtvId = "HTTP_DEBUG_ATV_" + Math.random().toString(36).slice(2, 8);
  const code = createSession(fakeAtvId);
  res.json({ code });
});

/** -------------------------
 * Socket events
 * ------------------------- */
io.on("connection", (socket) => {
  socket.data.code = null;
  socket.onAny((event, payload) => {
    console.log(`📨 ${socket.id} -> ${event}`, payload || "");
  });

  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.emit("session:created", { code });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  socket.on("atv:getPlayers", ({ code }) => {
    if (!getSession(code)) { socket.emit("session:ended"); return; }
    socket.join(code);
    socket.data.code = code;
    emitSessionPlayers(code);
    emitGameState(code);
  });

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

  socket.on("player:rejoin", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const s = getSession(code);
    if (!s) { socket.emit("error:join", { message: "Invalid or expired code." }); return; }
    let p = s.players.find(p => p.id === socket.id);
    if (!p) {
      const isManager = s.players.length === 0;
      p = { id: socket.id, name: String(name || "Player").slice(0, 16), isManager, score: 0 };
      s.players.push(p);
    } else {
      p.name = String(name || p.name).slice(0, 16);
    }
    socket.join(code);
    socket.data.code = code;
    socket.emit("player:joined", { code, isManager: p.isManager });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  socket.on("player:rename", ({ name }) => {
    const code = socket.data.code;
    const s = sessions.get(code);
    if (!s) return;
    const nn = String(name || "").trim().slice(0, 24);
    if (!nn) return;
    const me = s.players.find(p => p.id === socket.id);
    if (!me) return;
    me.name = nn;
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Settings — rounds now default to 3; plus wrongLimit & unlimitedWrong supported
  socket.on("manager:setSettings", ({ rounds, minLen, maxLen, wrongLimit, unlimitedWrong }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s) return;
    const me = s.players.find(p => p.id === socket.id); if (!me?.isManager) return;
    if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 20) s.settings.rounds = rounds;
    if (Number.isInteger(minLen) && minLen >= 1 && minLen <= 40) s.settings.minLen = minLen;
    if (Number.isInteger(maxLen) && maxLen >= s.settings.minLen && maxLen <= 60) s.settings.maxLen = maxLen;
    if (typeof unlimitedWrong === "boolean") s.settings.unlimitedWrong = unlimitedWrong;
    if (!s.settings.unlimitedWrong && Number.isInteger(wrongLimit)) {
      s.settings.wrongLimit = Math.max(1, Math.min(26, wrongLimit));
    }
    emitGameState(code);
  });

  socket.on("manager:startGame", () => {
    const code = socket.data.code;
    const s = sessions.get(code);
    if (!s) return;

    const mgr = s.players.find(p => p.id === socket.id && p.isManager);
    if (!mgr) return;

    s.game = s.game || {};
    s.game.setterOrder = buildSetterOrder(s);
    s.game.setterPointer = 0;

    if (!s.game.setterOrder.length) {
      s.game.state = "idle";
      emitGameState(code);
      return;
    }

    startWaitingForPhrase(s);
  });

  socket.on("manager:nextRound", () => {
    const code = socket.data.code;
    const s = sessions.get(code);
    if (!s || !s.game) return;
    const mgr = s.players.find(p => p.id === socket.id && p.isManager);
    if (!mgr) return;

    s.game.setterPointer += 1;
    if (maybeGameOver(s)) return;
    startWaitingForPhrase(s);
  });

  socket.on("manager:endGame", () => {
    const code = socket.data.code;
    const s = sessions.get(code);
    if (!s) return;
    const mgr = s.players.find(p => p.id === socket.id && p.isManager);
    if (!mgr) return;

    const atvId = s.atvSocketId;
    io.to(code).emit("session:ended");
    sessions.delete(code);

    const atvSock = io.sockets.sockets.get(atvId);
    if (atvSock) {
      const newCode = createSession(atvId);
      try { atvSock.leave(code); } catch {}
      atvSock.join(newCode);
      atvSock.data.code = newCode;
      atvSock.emit("session:created", { code: newCode });
      emitSessionPlayers(newCode);
      emitGameState(newCode);
    }
  });

  socket.on("setter:submitPhrase", ({ phrase, hint }) => {
    const code = socket.data.code; const s = sessions.get(code);
    if (!s || !s.game || s.game.state !== "waiting_phrase") return;

    const r = s.game.round;
    if (!r || r.setterId !== socket.id) return;

    const raw = String(phrase || "").trim();
    if (raw.length < s.settings.minLen || raw.length > s.settings.maxLen) {
      socket.emit("error:phrase", { message: `Phrase must be ${s.settings.minLen}–${s.settings.maxLen} characters.` });
      return;
    }

    r.raw = raw.toUpperCase();
    r.hint = String(hint || "").slice(0, 120);
    r.hintShown = false;
    r.guessedLetters = [];
    r.wrongCount = 0;

    r.masked = buildMasked(r.raw, new Set());
    const guessers = s.players.filter(p => p.id !== r.setterId).map(p => p.id);
    r.guesserOrder = guessers;
    r.turnIndex = 0;

    s.game.state = "active";
    emitGameState(code);
    socket.emit("setter:ok");
  });

  socket.on("setter:showHint", () => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round; if (socket.id !== r.setterId) return;
    if (!r.hintShown) {
      r.hintShown = true;
      io.to(code).emit("game:hint", { hint: r.hint });
      emitGameState(code);
    }
  });

  function finishRoundWithSetterWin(s, code) {
    const r = s.game.round;
    s.game.state = "won";
    r.winnerId = r.setterId;
  
    // ▶ Make the ATV show the full solution when guessers fail
    r.masked = r.raw;
  
    // Points to setter: 1 if hint not shown, 2 if hint shown
    const pts = r.hintShown ? 2 : 1;
    const setter = s.players.find(p => p.id === r.setterId);
    if (setter) setter.score = (setter.score || 0) + pts;
  
    emitGameState(code);
  }

  socket.on("player:guessLetter", ({ letter }) => {
    const code = socket.data.code; const s = sessions.get(code); if (!s || !s.game || s.game.state !== "active") return;
    const r = s.game.round;
    const meId = socket.id;
    if (meId !== currentTurnPlayerId(s)) return;
    const L = String(letter || "").toUpperCase();
    if (!/^[A-Z]$/.test(L)) return;
    if (r.guessedLetters.includes(L)) return;

    r.guessedLetters.push(L);

    if (r.raw.includes(L)) {
      r.masked = buildMasked(r.raw, new Set(r.guessedLetters));
      if (!r.masked.includes("_")) {
        s.game.state = "won";
        r.winnerId = meId;
        const pts = r.hintShown ? 1 : 2; // solver: 2 without hint, 1 with hint
        const winner = s.players.find(p => p.id === meId); if (winner) winner.score = (winner.score || 0) + pts;
        emitGameState(code);
        return;
      }
      advanceTurn(s);
      emitGameState(code);
    } else {
      r.wrongCount = (r.wrongCount || 0) + 1;
      const limited = !s.settings.unlimitedWrong;
      const limit = s.settings.wrongLimit ?? 6;
      if (limited && r.wrongCount >= limit) {
        finishRoundWithSetterWin(s, code);
        return;
      }
      advanceTurn(s);
      emitGameState(code);
    }
  });

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
    } else {
      r.wrongCount = (r.wrongCount || 0) + 1;
      const limited = !s.settings.unlimitedWrong;
      const limit = s.settings.wrongLimit ?? 6;
      if (limited && r.wrongCount >= limit) {
        finishRoundWithSetterWin(s, code);
        return;
      }
      advanceTurn(s);
      emitGameState(code);
    }
  });

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

      if (wasManager && s.players.length > 0) s.players[0].isManager = true;

      if (s.game?.round?.guesserOrder) {
        const gidx = s.game.round.guesserOrder.indexOf(removedId);
        if (gidx !== -1) s.game.round.guesserOrder.splice(gidx, 1);
        if (s.game.round.guesserOrder.length === 0 && s.game.state === "active") {
          finishRoundWithSetterWin(s, code);
        }
      }
    }
    emitSessionPlayers(code);
    emitGameState(code);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));