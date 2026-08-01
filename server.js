const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WORDS = require("./words");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---- In-memory room store -------------------------------------------------
// rooms: Map<code, RoomState>
const rooms = new Map();

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

function newBoard() {
  const chosen = shuffle(WORDS).slice(0, 25);
  const starter = Math.random() < 0.5 ? "red" : "blue";
  const other = starter === "red" ? "blue" : "red";
  const colors = [
    ...Array(9).fill(starter),
    ...Array(8).fill(other),
    ...Array(7).fill("neutral"),
    "assassin",
  ];
  const shuffledColors = shuffle(colors);
  const board = chosen.map((word, i) => ({
    word,
    color: shuffledColors[i],
    revealed: false,
  }));
  return { board, starter };
}

function createRoom(code) {
  const { board, starter } = newBoard();
  const room = {
    code,
    players: new Map(), // socketId -> {id, name, team, role}
    board,
    turnTeam: starter,
    starter,
    phase: "lobby", // lobby | clue | guess | ended
    clue: null, // {word, number}
    guessesLeft: 0,
    guessesMade: 0,
    log: [],
    winner: null,
    createdAt: Date.now(),
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
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
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
  const state = publicState(room);
  for (const [socketId, player] of room.players.entries()) {
    io.to(socketId).emit("room_update", { state, board: boardFor(room, player) });
  }
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
}

io.on("connection", (socket) => {
  let currentRoomCode = null;

  function getRoomOr(cb) {
    const room = rooms.get(currentRoomCode);
    if (!room) return socket.emit("error_msg", "Room no longer exists.");
    cb(room);
  }

  socket.on("create_room", ({ name }) => {
    const code = makeRoomCode();
    const room = createRoom(code);
    currentRoomCode = code;
    room.players.set(socket.id, { id: socket.id, name: name?.slice(0, 24) || "Agent", team: null, role: null });
    socket.join(code);
    pushLog(room, `${name || "Agent"} created the room.`);
    broadcastRoom(room);
  });

  socket.on("join_room", ({ code, name }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return socket.emit("error_msg", "No room with that code.");
    currentRoomCode = room.code;
    room.players.set(socket.id, { id: socket.id, name: name?.slice(0, 24) || "Agent", team: null, role: null });
    socket.join(room.code);
    pushLog(room, `${name || "Agent"} joined.`);
    broadcastRoom(room);
  });

  socket.on("set_team", ({ team }) => {
    getRoomOr((room) => {
      const p = room.players.get(socket.id);
      if (!p) return;
      p.team = team;
      broadcastRoom(room);
    });
  });

  socket.on("set_role", ({ role }) => {
    getRoomOr((room) => {
      const p = room.players.get(socket.id);
      if (!p) return;
      p.role = role;
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
      const { board, starter } = newBoard();
      room.board = board;
      room.starter = starter;
      room.turnTeam = starter;
      room.phase = "clue";
      room.clue = null;
      room.guessesLeft = 0;
      room.guessesMade = 0;
      room.winner = null;
      room.log = [];
      pushLog(room, `New game. ${starter.toUpperCase()} goes first.`);
      broadcastRoom(room);
    });
  });

  socket.on("give_clue", ({ word, number }) => {
    getRoomOr((room) => {
      const p = room.players.get(socket.id);
      if (!p || p.role !== "spymaster" || p.team !== room.turnTeam || room.phase !== "clue") return;
      const n = Math.max(0, Math.min(9, parseInt(number, 10) || 0));
      room.clue = { word: (word || "").slice(0, 40), number: n };
      room.guessesLeft = n === 0 ? 999 : n + 1; // 0 = unlimited guesses ("infinity" clue handled as big number)
      room.guessesMade = 0;
      room.phase = "guess";
      pushLog(room, `${room.turnTeam.toUpperCase()} spymaster's clue: "${room.clue.word}" — ${n}`);
      broadcastRoom(room);
    });
  });

  socket.on("guess_word", ({ index }) => {
    getRoomOr((room) => {
      const p = room.players.get(socket.id);
      if (!p || p.role !== "operative" || p.team !== room.turnTeam || room.phase !== "guess") return;
      const card = room.board[index];
      if (!card || card.revealed) return;
      card.revealed = true;
      room.guessesMade += 1;

      if (card.color === "assassin") {
        pushLog(room, `${p.name} revealed "${card.word}" — the ASSASSIN! ${room.turnTeam.toUpperCase()} loses.`);
        room.phase = "ended";
        room.winner = room.turnTeam === "red" ? "blue" : "red";
        return broadcastRoom(room);
      }

      pushLog(room, `${p.name} revealed "${card.word}" (${card.color}).`);

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
    });
  });

  socket.on("end_turn", () => {
    getRoomOr((room) => {
      const p = room.players.get(socket.id);
      if (!p || p.team !== room.turnTeam || room.phase !== "guess") return;
      pushLog(room, `${room.turnTeam.toUpperCase()} ended their turn.`);
      switchTurn(room);
      broadcastRoom(room);
    });
  });

  socket.on("new_game", () => {
    getRoomOr((room) => {
      const { board, starter } = newBoard();
      room.board = board;
      room.starter = starter;
      room.turnTeam = starter;
      room.phase = "clue";
      room.clue = null;
      room.guessesLeft = 0;
      room.guessesMade = 0;
      room.winner = null;
      room.log = [];
      pushLog(room, `New game. ${starter.toUpperCase()} goes first.`);
      broadcastRoom(room);
    });
  });

  socket.on("disconnect", () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    room.players.delete(socket.id);
    if (p) pushLog(room, `${p.name} disconnected.`);
    if (room.players.size === 0) {
      rooms.delete(room.code);
    } else {
      broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Codenames server running on port ${PORT}`);
});