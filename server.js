// Hangman server — sessions + rounds + guesses + hint + scoring
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

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
    players: [], // {id,name,isManager,score}
    settings: { rounds: 3, minLen: 3, maxLen: 24 },
    game: null // see below
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

// Create a new game model
function newGame(session) {
  return {
    roundIndex: -1,
    setterIndex: -1, // which player is setter for this round (rotates)
    state: "idle",   // idle | waiting_phrase | active | won | over
    round: null      // see round object below
  };
}

// Start next round (assign setter & reset)
function startNextRound(session) {
  if (!session.game) session.game = newGame(session);

  // advance
  session.game.roundIndex += 1;
  if (session.game.roundIndex >= session.settings.rounds) {
    session.game.state = "over";
    session.game.round = null;
    return;
  }

  // rotate setter
  if (session.players.length === 0) return;
  session.game.setterIndex = (session.game.setterIndex + 1) % session.players.length;

  // create new round skeleton
  session.game.state = "waiting_phrase";
  session.game.round = {
    setterId: session.players[session.game.setterIndex].id,
    phrase: null,
    hint: "",
    masked: "",          // e.g. "_ _ _  _ _"
    raw: "",             // normalized phrase
    guessedLetters: [],  // ['A','B',...]
    hintShown: false,
    turnIndex: 0,        // index into guesser order list
    guesserOrder: [],    // player ids excluding setter
    winnerId: null
  };
}

// Normalize phrase and construct masked (letters only get masked; spaces/punct shown)
function normalizePhrase(input) {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ '-.";
  const up = input.toUpperCase().replace(/\s+/g, " ").trim();
  for (const ch of up) if (!allowed.includes(ch)) return null;
  return up;
}

function buildMasked(raw, guessedSet) {
  let out = "";
  for (const ch of raw) {
    if (/[A-Z]/.test(ch)) out += guessedSet.has(ch) ? ch : "_";
    else out += ch; // spaces/punct reveal immediately
  }
  return out;
}

function emitSessionPlayers(code) {
  const s = sessions.get(code); if (!s) return;
  io.to(code).emit("session:players", {
    code,
    players: s.players.map(p => ({ id:p.id, name:p.name, isManager:p.isManager, score:p.score ?? 0 }))
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
    scores: s.players.map(p => ({ id:p.id, score:p.score ?? 0 })),
    // do NOT send raw phrase; only setter gets a local echo via ack
  });
}

function currentTurnPlayerId(session) {
  const r = session.game?.round; if (!r) return null;
  if (r.guesserOrder.length === 0) return null;
  return r.guesserOrder[r.turnIndex % r.guesserOrder.length];
}

function advanceTurn(session) {
  const r = session.game.round;
  r.turnIndex = (r.turnIndex + 1) % r.guesserOrder.length;
}

/** -------------------------
 * HTTP debug helpers (optional)
 * ------------------------- */
app.get("/", (_req, res) => res.send("✅ Hangman server running — rounds ready."));
app.get("/debug/sessions", (_req, res) => {
  const out = [];
  for (const [code, s] of sessions) {
    out.push({
      code,
      players: s.players.map(p => ({ id:p.id, name:p.name, score:p.score ?? 0, isManager:p.isManager })),
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

/** -------------------------
 * Socket events
 * ------------------------- */
io.on("connection", (socket) => {
  socket.data.code = null;
  // console.log("🔌", socket.id);

  // ATV creates session
  socket.on("atv:createSession", () => {
    const code = createSession(socket.id);
    const s = sessions.get(code);
    socket.join(code);
    socket.data.code = code;
    if (!s.players.some(p=>p.id===socket.id)) {
      s.players.push({ id: socket.id, name: "ATV", isManager: false, score: 0 });
    }
    socket.emit("session:created", { code });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // ATV can fetch players after reconnect
  socket.on("atv:getPlayers", ({ code }) => {
    if (!getSession(code)) { socket.emit("session:ended"); return; }
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Player join
  socket.on("player:join", ({ code, name }) => {
    const s = getSession(String(code||"").toUpperCase());
    if (!s) { socket.emit("error:join", { message: "Invalid or expired code." }); return; }

    const safeName = String(name||"Player").slice(0,16);
    const isManager = s.players.filter(p=>p.id!==s.atvSocketId).length === 0; // first phone
    s.players.push({ id: socket.id, name: safeName, isManager, score: 0 });
    socket.join(code);
    socket.data.code = code;

    socket.emit("player:joined", { code, isManager });
    emitSessionPlayers(code);
    emitGameState(code);
  });

  // Manager sets basic settings then starts game
  socket.on("manager:setSettings", ({ rounds, minLen, maxLen }) => {
    const s = sessions.get(socket.data.code); if (!s) return;
    const me = s.players.find(p=>p.id===socket.id); if (!me?.isManager) return;
    if (Number.isInteger(rounds) && rounds>=1 && rounds<=20) s.settings.rounds = rounds;
    if (Number.isInteger(minLen) && minLen>=1 && minLen<=40) s.settings.minLen = minLen;
    if (Number.isInteger(maxLen) && maxLen>=s.settings.minLen && maxLen<=60) s.settings.maxLen = maxLen;
    emitGameState(socket.data.code);
  });

  socket.on("manager:startGame", () => {
    const s = sessions.get(socket.data.code); if (!s) return;
    const me = s.players.find(p=>p.id===socket.id); if (!me?.isManager) return;
    if (!s.game) s.game = newGame(s);
    startNextRound(s);
    emitSessionPlayers(socket.data.code);
    emitGameState(socket.data.code);
  });

  // Setter submits phrase + hint
  socket.on("setter:submitPhrase", ({ phrase, hint }) => {
    const s = sessions.get(socket.data.code); if (!s || !s.game || s.game.state!=="waiting_phrase") return;
    const r = s.game.round;
    if (socket.id !== r.setterId) return;

    const norm = normalizePhrase(String(phrase||""));
    if (!norm) { socket.emit("error:phrase", { message:"Invalid characters." }); return; }
    if (norm.replace(/[^A-Z]/g,"").length < s.settings.minLen || norm.replace(/[^A-Z]/g,"").length > s.settings.maxLen) {
      socket.emit("error:phrase", { message:`Length must be ${s.settings.minLen}-${s.settings.maxLen} letters.` });
      return;
    }

    r.raw = norm;
    r.hint = String(hint||"").slice(0,100);
    r.guessedLetters = [];
    r.hintShown = false;
    r.guesserOrder = s.players.filter(p=>p.id!==r.setterId && p.id!==s.atvSocketId).map(p=>p.id);
    r.turnIndex = 0;
    const guessedSet = new Set(r.guessedLetters);
    r.masked = buildMasked(r.raw, guessedSet);

    s.game.state = "active";
    // ack setter only (doesn't reveal to others)
    socket.emit("setter:ok", { ok:true });
    emitGameState(socket.data.code);
  });

  // Setter can show hint (manual, reduces solve to 1 point)
  socket.on("setter:showHint", () => {
    const s = sessions.get(socket.data.code); if (!s || !s.game || s.game.state!=="active") return;
    const r = s.game.round; if (socket.id !== r.setterId) return;
    if (!r.hintShown) {
      r.hintShown = true;
      io.to(socket.data.code).emit("game:hint", { hint: r.hint });
      emitGameState(socket.data.code);
    }
  });

  // Player guesses ONE letter on their turn
  socket.on("player:guessLetter", ({ letter }) => {
    const s = sessions.get(socket.data.code); if (!s || !s.game || s.game.state!=="active") return;
    const r = s.game.round;
    const meId = socket.id;
    if (meId !== currentTurnPlayerId(s)) return; // not your turn
    const L = String(letter||"").toUpperCase();
    if (!/^[A-Z]$/.test(L)) return;
    if (r.guessedLetters.includes(L)) return;

    r.guessedLetters.push(L);
    const guessedSet = new Set(r.guessedLetters);
    r.masked = buildMasked(r.raw, guessedSet);

    // Check win (all letters revealed)
    if (!r.masked.includes("_")) {
      s.game.state = "won";
      r.winnerId = meId; // last revealer gets the solve (2 or 1 based on hint)
      const pts = r.hintShown ? 1 : 2;
      const winner = s.players.find(p=>p.id===meId); if (winner) winner.score = (winner.score||0) + pts;

      // small delay then advance
      emitGameState(socket.data.code);
      setTimeout(() => {
        startNextRound(s);
        emitSessionPlayers(socket.data.code);
        emitGameState(socket.data.code);
      }, 800);
      return;
    }

    // Next player's turn
    advanceTurn(s);
    emitGameState(socket.data.code);
  });

  // Player attempts full solve (instead of guessing)
  socket.on("player:solve", ({ guess }) => {
    const s = sessions.get(socket.data.code); if (!s || !s.game || s.game.state!=="active") return;
    const r = s.game.round;
    const meId = socket.id;
    if (meId !== currentTurnPlayerId(s)) return; // not your turn
    const normGuess = normalizePhrase(String(guess||"")); if (!normGuess) return;

    if (normGuess === r.raw) {
      s.game.state = "won";
      r.winnerId = meId;
      const pts = r.hintShown ? 1 : 2;
      const winner = s.players.find(p=>p.id===meId); if (winner) winner.score = (winner.score||0) + pts;

      // reveal all
      r.masked = r.raw;
      emitGameState(socket.data.code);
      setTimeout(() => {
        startNextRound(s);
        emitSessionPlayers(socket.data.code);
        emitGameState(socket.data.code);
      }, 800);
    } else {
      // wrong solve — you lose your turn
      advanceTurn(s);
      emitGameState(socket.data.code);
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

    // Remove player & adjust manager if needed
    const idx = s.players.findIndex(p=>p.id===socket.id);
    if (idx !== -1) {
      const wasManager = s.players[idx].isManager;
      const removedId = s.players[idx].id;
      s.players.splice(idx,1);
      if (wasManager) {
        const firstPhone = s.players.find(p=>p.id!==s.atvSocketId);
        if (firstPhone) firstPhone.isManager = true;
      }
      // If they were in the round order, remove them
      if (s.game?.round?.guesserOrder) {
        const gidx = s.game.round.guesserOrder.indexOf(removedId);
        if (gidx !== -1) s.game.round.guesserOrder.splice(gidx,1);
        if (s.game.round.guesserOrder.length===0 && s.game.state==="active") {
          // No guessers left: end round and advance
          s.game.state = "won";
          s.game.round.winnerId = null;
          setTimeout(()=>{ startNextRound(s); emitSessionPlayers(code); emitGameState(code); }, 400);
        }
      }
    }
    emitSessionPlayers(code);
    emitGameState(code);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server listening on", PORT));
