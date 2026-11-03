const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WORDS = require("./words");
const ai = require("./ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// no-cache on every static asset: this app's client.js talks a live
// protocol to server.js, so a browser holding onto a stale cached copy
// after an update can misbehave in ways that only a hard refresh fixes.
// Explicitly telling the browser not to cache avoids that entirely.
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

// ---- In-memory room store -------------------------------------------------
// rooms: Map<code, RoomState>
// Players are keyed by a persistent clientId (generated client-side and
// stored in sessionStorage) rather than socket.id, so a page refresh —
// which creates a brand new socket connection — can rejoin the same
// player identity instead of showing up as a stranger with no team/role.
const rooms = new Map();
const ROOM_TTL_MS = 20 * 60 * 1000; // clean up abandoned rooms after 20 min of no connected players
const BOARD_SIZES = [16, 20, 25, 30, 35, 40, 45];
const DEFAULT_BOARD_SIZE = 25;

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Scales the classic 9/8/7/1 (of 25) color split to any board size while
// always keeping exactly one assassin and giving the starting team one
// more agent than the other side.
function colorCounts(size) {
  const remaining = size - 1; // minus the assassin
  // classic 25-card ratio is 9/8/7/1 (starter/other/neutral/assassin);
  // scale the neutral share by the same proportion (7 of 24 non-assassin cards)
  const neutral = Math.min(Math.round(remaining * (7 / 24)), remaining - 2); // keep >=1 card per side
  const leftover = remaining - neutral;
  const starter = Math.ceil(leftover / 2);
  const other = Math.floor(leftover / 2);
  return { starter, other, neutral, assassin: 1 };
}

function newBoard(extraWords, onlyCustom, boardSize) {
  const size = BOARD_SIZES.includes(boardSize) ? boardSize : DEFAULT_BOARD_SIZE;
  const seen = new Set();
  const custom = [];
  for (const w of (extraWords || [])) {
    const key = w.trim().toUpperCase();
    if (key && !seen.has(key)) { seen.add(key); custom.push(key); }
  }
  const base = [];
  for (const w of WORDS) {
    const key = w.trim().toUpperCase();
    if (key && !seen.has(key)) { seen.add(key); base.push(key); }
  }

  let boardWords;
  if (onlyCustom && custom.length >= size) {
    // Use ONLY the words the players supplied — nothing from the built-in bank.
    boardWords = shuffle(custom).slice(0, size);
  } else {
    // Mixed mode: custom words are guaranteed a spot (up to `size` of them);
    // the base word bank fills whatever slots are left. Also the automatic
    // fallback if "only custom" was requested but there weren't enough yet.
    const customPicked = shuffle(custom).slice(0, size);
    const basePicked = shuffle(base).slice(0, size - customPicked.length);
    boardWords = shuffle(customPicked.concat(basePicked));
  }

  const starterTeam = Math.random() < 0.5 ? "red" : "blue";
  const otherTeam = starterTeam === "red" ? "blue" : "red";
  const counts = colorCounts(size);
  const colors = [
    ...Array(counts.starter).fill(starterTeam),
    ...Array(counts.other).fill(otherTeam),
    ...Array(counts.neutral).fill("neutral"),
    ...Array(counts.assassin).fill("assassin"),
  ];
  const shuffledColors = shuffle(colors);
  const board = boardWords.map((word, i) => ({
    word,
    color: shuffledColors[i],
    revealed: false,
  }));
  return { board, starter: starterTeam };
}

function createRoom(code) {
  const customWords = [];
  const boardSize = DEFAULT_BOARD_SIZE;
  const { board, starter } = newBoard(customWords, false, boardSize);
  const room = {
    code,
    players: new Map(), // clientId -> {clientId, socketId, name, team, role, connected}
    board,
    boardSize,
    turnTeam: starter,
    starter,
    phase: "lobby", // lobby | clue | guess | ended
    clue: null, // {word, number}
    guessesLeft: 0,
    guessesMade: 0,
    log: [],
    history: [], // [{team, word, number, guesses: [{word, color}]}] — public info, fed to AI players
    epoch: 0, // bumped whenever the turn/game changes, so stale AI work can detect it and bail out
    botBusy: false, // an AI player is currently thinking/acting
    botFailedEpoch: null, // epoch in which the AI failed; blocks auto-retry until someone clicks Retry
    winner: null,
    customWords, // extra words players add on top of the base word bank
    onlyCustomWords: false, // if true (and enough custom words), skip the base bank entirely
    hostClientId: null, // the player who created the room — has authority to end the game
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function scoreRemaining(room, team) {
  return room.board.filter((c) => c.color === team && !c.revealed).length;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    turnTeam: room.turnTeam,
    starter: room.starter,
    clue: room.clue,
    guessesLeft: room.guessesLeft,
    winner: room.winner,
    log: room.log.slice(-30),
    remaining: { red: scoreRemaining(room, "red"), blue: scoreRemaining(room, "blue") },
    customWords: room.customWords,
    onlyCustomWords: room.onlyCustomWords,
    boardSize: room.boardSize,
    boardSizeOptions: BOARD_SIZES,
    hostId: room.hostClientId,
    aiEnabled: ai.isEnabled(),
    aiThinking: room.botBusy,
    aiFailed: room.botFailedEpoch !== null && room.botFailedEpoch === room.epoch,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.clientId,
      name: p.name,
      team: p.team,
      role: p.role,
      connected: p.connected,
      isBot: !!p.isBot,
      isHost: p.clientId === room.hostClientId,
    })),
  };
}

// A player only sees colors if: they are a spymaster, the card is revealed, or the game ended.
function boardFor(room, player) {
  const canSeeAll = player && (player.role === "spymaster" || room.phase === "ended");
  return room.board.map((c) => ({
    word: c.word,
    revealed: c.revealed,
    color: c.revealed || canSeeAll ? c.color : undefined,
  }));
}

function broadcastRoom(room) {
  room.lastActivity = Date.now();
  const state = publicState(room);
  for (const player of room.players.values()) {
    if (!player.connected || !player.socketId) continue;
    io.to(player.socketId).emit("room_update", { state, board: boardFor(room, player) });
  }
  scheduleBot(room);
}

function pushLog(room, text) {
  room.log.push({ text, ts: Date.now() });
}

function checkWin(room) {
  if (scoreRemaining(room, "red") === 0) {
    room.phase = "ended";
    room.winner = "red";
    pushLog(room, "RED has revealed all their agents. RED wins.");
  } else if (scoreRemaining(room, "blue") === 0) {
    room.phase = "ended";
    room.winner = "blue";
    pushLog(room, "BLUE has revealed all their agents. BLUE wins.");
  }
}

function switchTurn(room) {
  room.turnTeam = room.turnTeam === "red" ? "blue" : "red";
  room.phase = "clue";
  room.clue = null;
  room.guessesLeft = 0;
  room.guessesMade = 0;
  room.epoch++;
}

// ---- Shared game actions (used by both human sockets and AI players) -------
function doGiveClue(room, word, number, actor) {
  const n = Math.max(0, Math.min(9, parseInt(number, 10) || 0));
  room.clue = { word: (word || "").slice(0, 40), number: n };
  room.guessesLeft = n === 0 ? 999 : n + 1; // 0 = unlimited guesses ("infinity" clue handled as big number)
  room.guessesMade = 0;
  room.phase = "guess";
  room.history.push({ team: room.turnTeam, word: room.clue.word, number: n, guesses: [] });
  pushLog(room, `${room.turnTeam.toUpperCase()} spymaster's clue: "${room.clue.word}" — ${n}`);
  broadcastRoom(room);
}

function doGuess(room, index, actor) {
  const card = room.board[index];
  if (!card || card.revealed) return;
  card.revealed = true;
  room.guessesMade += 1;
  const entry = room.history[room.history.length - 1];
  if (entry) entry.guesses.push({ word: card.word, color: card.color });

  if (card.color === "assassin") {
    pushLog(room, `${actor.name} revealed "${card.word}" — the ASSASSIN! ${room.turnTeam.toUpperCase()} loses.`);
    room.phase = "ended";
    room.winner = room.turnTeam === "red" ? "blue" : "red";
    return broadcastRoom(room);
  }

  pushLog(room, `${actor.name} revealed "${card.word}" (${card.color}).`);

  checkWin(room);
  if (room.phase === "ended") return broadcastRoom(room);

  if (card.color !== room.turnTeam) {
    // wrong team or neutral: turn ends
    switchTurn(room);
    return broadcastRoom(room);
  }

  // correct guess
  room.guessesLeft -= 1;
  if (room.guessesLeft <= 0) {
    switchTurn(room);
  }
  broadcastRoom(room);
}

function doEndTurn(room) {
  pushLog(room, `${room.turnTeam.toUpperCase()} ended their turn.`);
  switchTurn(room);
  broadcastRoom(room);
}

// ---- AI players -------------------------------------------------------------
// A bot is a normal entry in room.players (isBot: true, never connected via a
// socket). When it is a bot's turn to act, the server asks the LLM, validates
// the answer, and then plays through the same doGiveClue/doGuess/doEndTurn
// functions as a human would. The key (card colors) is only ever used here, on
// the server, and only for the spymaster bot's prompt.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_GUESS_DELAY_MS = parseInt(process.env.BOT_DELAY_MS, 10) || 1400;

function findBot(room, team, role) {
  return Array.from(room.players.values()).find((p) => p.isBot && p.team === team && p.role === role);
}

function clueContext(room) {
  const hidden = room.board.filter((c) => !c.revealed);
  const words = (color) => hidden.filter((c) => c.color === color).map((c) => c.word);
  const opp = room.turnTeam === "red" ? "blue" : "red";
  return {
    team: room.turnTeam,
    own: words(room.turnTeam),
    opponent: words(opp),
    neutral: words("neutral"),
    assassin: words("assassin"),
    hidden: hidden.map((c) => c.word),
    history: room.history,
  };
}

function guessContext(room) {
  const hidden = room.board.filter((c) => !c.revealed).map((c) => c.word);
  return {
    team: room.turnTeam,
    clue: room.clue,
    maxGuesses: Math.min(room.guessesLeft, 9, hidden.length),
    hidden,
    revealed: room.board.filter((c) => c.revealed).map((c) => ({ word: c.word, color: c.color })),
    history: room.history,
  };
}

async function runBot(room, bot) {
  const epoch = room.epoch;
  const stale = (phase) => room.epoch !== epoch || room.phase !== phase;
  try {
    if (room.phase === "clue") {
      const { clue, number } = await ai.generateClue(clueContext(room));
      if (stale("clue")) return;
      doGiveClue(room, clue, number, bot);
    } else if (room.phase === "guess") {
      const picks = await ai.generateGuesses(guessContext(room));
      for (const word of picks) {
        await sleep(BOT_GUESS_DELAY_MS); // let the table watch each card flip
        if (stale("guess")) return;
        const idx = room.board.findIndex((c) => !c.revealed && c.word === word);
        if (idx !== -1) doGuess(room, idx, bot);
      }
      if (!stale("guess")) {
        await sleep(BOT_GUESS_DELAY_MS);
        if (!stale("guess")) doEndTurn(room);
      }
    }
  } catch (err) {
    console.error(`[ai] ${bot.name} failed in room ${room.code}:`, err.message);
    room.botFailedEpoch = epoch;
    pushLog(room, `${bot.name} couldn't act (${String(err.message).slice(0, 120)}). Click "Retry AI" to try again.`);
  } finally {
    room.botBusy = false;
    broadcastRoom(room); // also lets the next bot in line (e.g. the other team's) start
  }
}

function scheduleBot(room) {
  if (room.botBusy || !ai.isEnabled()) return;
  if (room.phase !== "clue" && room.phase !== "guess") return;
  if (room.botFailedEpoch === room.epoch) return;
  const role = room.phase === "clue" ? "spymaster" : "operative";
  const bot = findBot(room, room.turnTeam, role);
  if (!bot) return;
  if (role === "operative") {
    // An AI operative fills an empty seat; it steps aside when a human operative is on the team.
    const humanOperative = Array.from(room.players.values()).some(
      (p) => !p.isBot && p.connected && p.team === room.turnTeam && p.role === "operative"
    );
    if (humanOperative) return;
  }
  room.botBusy = true;
  setImmediate(() => {
    runBot(room, bot);
    broadcastRoom(room); // shows "AI is thinking…" (scheduleBot is a no-op now: botBusy is set)
  });
}

// Periodically clean up rooms nobody is connected to anymore, giving
// refreshing/reconnecting players plenty of time to come back first.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const anyoneConnected = Array.from(room.players.values()).some((p) => p.connected && !p.isBot);
    if (!anyoneConnected && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

io.on("connection", (socket) => {
  let currentRoomCode = null;
  let currentClientId = null;

  function getRoomOr(cb) {
    const room = rooms.get(currentRoomCode);
    if (!room) return socket.emit("error_msg", "Room no longer exists.");
    cb(room);
  }

  function getMe(room) {
    return currentClientId ? room.players.get(currentClientId) : null;
  }

  function joinOrCreate(room, { name, clientId }) {
    const displayName = (name || "Agent").slice(0, 24) || "Agent";
    currentRoomCode = room.code;
    currentClientId = clientId;
    socket.join(room.code);

    const existing = room.players.get(clientId);
    if (existing) {
      // Reconnect: keep their team/role, just reattach the live socket.
      existing.socketId = socket.id;
      existing.connected = true;
      existing.name = displayName;
      pushLog(room, `${displayName} reconnected.`);
    } else {
      // Brand new player: always starts as a spectator (no team/role) —
      // they must explicitly opt into a team to play.
      room.players.set(clientId, {
        clientId,
        socketId: socket.id,
        name: displayName,
        team: null,
        role: null,
        connected: true,
      });
      pushLog(room, `${displayName} joined as a spectator.`);
    }
    broadcastRoom(room);
  }

  socket.on("create_room", ({ name, clientId }) => {
    if (!clientId) return socket.emit("error_msg", "Missing client id.");
    const code = makeRoomCode();
    const room = createRoom(code);
    room.hostClientId = clientId;
    joinOrCreate(room, { name, clientId });
  });

  socket.on("join_room", ({ code, name, clientId }) => {
    if (!clientId) return socket.emit("error_msg", "Missing client id.");
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return socket.emit("error_msg", "No room with that code.");
    joinOrCreate(room, { name, clientId });
  });

  socket.on("set_team", ({ team }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p) return;
      p.team = team;
      broadcastRoom(room);
    });
  });

  socket.on("set_role", ({ role }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p) return;
      p.role = role;
      // A human taking the spymaster seat replaces that team's AI spymaster.
      if (role === "spymaster" && p.team) {
        const bot = findBot(room, p.team, "spymaster");
        if (bot) {
          room.players.delete(bot.clientId);
          pushLog(room, `${bot.name} stepped down for ${p.name}.`);
        }
      }
      broadcastRoom(room);
    });
  });

  socket.on("become_spectator", () => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p) return;
      p.team = null;
      p.role = null;
      pushLog(room, `${p.name} became a spectator.`);
      broadcastRoom(room);
    });
  });

  socket.on("add_words", ({ words }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase !== "lobby") return;
      const incoming = String(words || "")
        .split(/[,\n]/)
        .map((w) => w.trim().toUpperCase())
        .filter((w) => w.length > 0 && w.length <= 24);
      const existing = new Set(room.customWords.concat(WORDS));
      let added = 0;
      for (const w of incoming) {
        if (!existing.has(w)) {
          existing.add(w);
          room.customWords.push(w);
          added++;
        }
      }
      if (added > 0) pushLog(room, `${p.name} added ${added} word${added === 1 ? "" : "s"} to the pool.`);
      broadcastRoom(room);
    });
  });

  socket.on("set_word_mode", ({ onlyCustom }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase !== "lobby") return;
      room.onlyCustomWords = !!onlyCustom;
      broadcastRoom(room);
    });
  });

  socket.on("set_board_size", ({ size }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase !== "lobby") return;
      const n = parseInt(size, 10);
      if (!BOARD_SIZES.includes(n)) return;
      room.boardSize = n;
      broadcastRoom(room);
    });
  });

  socket.on("randomize_teams", () => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase !== "lobby") return;
      // AI players keep their seats; only humans are shuffled around them.
      const players = shuffle(Array.from(room.players.values()).filter((x) => !x.isBot));
      const half = Math.ceil(players.length / 2);
      let redSpySet = !!findBot(room, "red", "spymaster");
      let blueSpySet = !!findBot(room, "blue", "spymaster");
      players.forEach((pl, i) => {
        pl.team = i < half ? "red" : "blue";
      });
      players.forEach((pl) => {
        if (pl.team === "red") { pl.role = redSpySet ? "operative" : "spymaster"; redSpySet = true; }
        else { pl.role = blueSpySet ? "operative" : "spymaster"; blueSpySet = true; }
      });
      pushLog(room, `${p.name} randomized the teams.`);
      broadcastRoom(room);
    });
  });

  socket.on("start_game", () => {
    getRoomOr((room) => {
      const players = Array.from(room.players.values());
      const ready =
        players.some((p) => p.team === "red" && p.role === "spymaster") &&
        players.some((p) => p.team === "blue" && p.role === "spymaster") &&
        players.some((p) => p.team === "red" && p.role === "operative") &&
        players.some((p) => p.team === "blue" && p.role === "operative");
      if (!ready) {
        return socket.emit("error_msg", "Need at least one spymaster and one operative on each team.");
      }
      if (room.onlyCustomWords && room.customWords.length < room.boardSize) {
        return socket.emit("error_msg", `"Only my words" is on but you only have ${room.customWords.length}/${room.boardSize} words in the pool. Add more, or turn the toggle off.`);
      }
      const { board, starter } = newBoard(room.customWords, room.onlyCustomWords, room.boardSize);
      room.board = board;
      room.starter = starter;
      room.turnTeam = starter;
      room.phase = "clue";
      room.clue = null;
      room.guessesLeft = 0;
      room.guessesMade = 0;
      room.winner = null;
      room.log = [];
      room.history = [];
      room.epoch++;
      room.botFailedEpoch = null;
      pushLog(room, room.onlyCustomWords
        ? `New game (${room.boardSize} cards) using only the custom word pool. ${starter.toUpperCase()} goes first.`
        : `New game (${room.boardSize} cards). ${starter.toUpperCase()} goes first.`);
      broadcastRoom(room);
    });
  });

  socket.on("give_clue", ({ word, number }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || p.role !== "spymaster" || p.team !== room.turnTeam || room.phase !== "clue") return;
      doGiveClue(room, word, number, p);
    });
  });

  socket.on("guess_word", ({ index }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || p.role !== "operative" || p.team !== room.turnTeam || room.phase !== "guess") return;
      doGuess(room, index, p);
    });
  });

  socket.on("end_turn", () => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || p.team !== room.turnTeam || room.phase !== "guess") return;
      doEndTurn(room);
    });
  });

  // ---- AI players (lobby only) ----
  socket.on("add_bot", ({ team, role }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase !== "lobby") return;
      if (!["red", "blue"].includes(team) || !["spymaster", "operative"].includes(role)) return;
      if (!ai.isEnabled()) {
        return socket.emit("error_msg", "AI players are not configured on this server. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) as an environment variable and restart the server.");
      }
      if (findBot(room, team, role)) return socket.emit("error_msg", `${team.toUpperCase()} already has an AI ${role}.`);
      if (role === "spymaster") {
        const humanSpy = Array.from(room.players.values()).some((x) => !x.isBot && x.team === team && x.role === "spymaster");
        if (humanSpy) return socket.emit("error_msg", `${team.toUpperCase()} already has a human spymaster.`);
      }
      const id = "bot-" + Math.random().toString(36).slice(2, 10);
      const name = role === "spymaster" ? "Cipher (AI)" : "Scout (AI)";
      room.players.set(id, { clientId: id, socketId: null, name, team, role, connected: true, isBot: true });
      pushLog(room, `${p.name} added an AI ${role} to ${team.toUpperCase()}.`);
      broadcastRoom(room);
    });
  });

  socket.on("remove_bot", ({ id }) => {
    getRoomOr((room) => {
      const p = getMe(room);
      const bot = room.players.get(id);
      if (!p || !bot || !bot.isBot || room.phase !== "lobby") return;
      room.players.delete(id);
      pushLog(room, `${p.name} removed ${bot.name} from ${bot.team.toUpperCase()}.`);
      broadcastRoom(room);
    });
  });

  // If an AI stalled (API error, bad output), anyone can ask it to try again.
  socket.on("ai_retry", () => {
    getRoomOr((room) => {
      if (!getMe(room)) return;
      room.botFailedEpoch = null;
      broadcastRoom(room);
    });
  });

  socket.on("end_game", () => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase === "lobby" || room.phase === "ended") return;
      const host = room.players.get(room.hostClientId);
      const hostPresent = host && host.connected;
      const isHost = p.clientId === room.hostClientId;
      if (hostPresent && !isHost) {
        return socket.emit("error_msg", "Only the room host can end the game.");
      }
      room.phase = "ended";
      room.epoch++;
      room.winner = null; // aborted, no winner
      pushLog(room, `${p.name}${isHost ? " (host)" : ""} ended the game early.`);
      broadcastRoom(room);
    });
  });

  socket.on("new_game", () => {
    getRoomOr((room) => {
      const { board, starter } = newBoard(room.customWords, room.onlyCustomWords, room.boardSize);
      room.board = board;
      room.starter = starter;
      room.turnTeam = starter;
      room.phase = "clue";
      room.clue = null;
      room.guessesLeft = 0;
      room.guessesMade = 0;
      room.winner = null;
      room.log = [];
      room.history = [];
      room.epoch++;
      room.botFailedEpoch = null;
      pushLog(room, `New game. ${starter.toUpperCase()} goes first.`);
      broadcastRoom(room);
    });
  });

  socket.on("back_to_lobby", () => {
    getRoomOr((room) => {
      const p = getMe(room);
      if (!p || room.phase !== "ended") return;
      room.phase = "lobby";
      room.epoch++;
      room.clue = null;
      room.winner = null;
      broadcastRoom(room);
    });
  });

  socket.on("disconnect", () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const p = getMe(room);
    if (!p) return;
    // Don't delete the player — a page refresh looks identical to a real
    // disconnect from the server's point of view, so we just mark them as
    // away and let joinOrCreate() restore them if/when they reconnect with
    // the same clientId. The periodic sweep cleans up truly abandoned rooms.
    p.connected = false;
    pushLog(room, `${p.name} disconnected.`);
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Codenames server running on port ${PORT}`);
});