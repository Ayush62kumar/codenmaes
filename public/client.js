(function () {
  const app = document.getElementById("app");
  const socket = io();

  let myId = null;
  let myName = localStorage_safeGet("cn_name") || "";
  let roomCode = localStorage_safeGet("cn_room") || "";
  let state = null; // last room_update.state
  let board = null; // last room_update.board
  let errorMsg = "";
  let screen = "home"; // home | lobby | game

  function localStorage_safeGet(k) {
    try { return sessionStorage.getItem(k); } catch (e) { return null; }
  }
  function localStorage_safeSet(k, v) {
    try { sessionStorage.setItem(k, v); } catch (e) {}
  }

  socket.on("connect", () => { myId = socket.id; render(); });

  socket.on("room_update", (payload) => {
    state = payload.state;
    board = payload.board;
    roomCode = state.code;
    localStorage_safeSet("cn_room", roomCode);
    errorMsg = "";
    screen = state.phase === "lobby" ? "lobby" : "game";
    render();
  });

  socket.on("error_msg", (msg) => {
    errorMsg = msg;
    render();
  });

  socket.on("disconnect", () => {
    errorMsg = "Connection lost. Reconnecting…";
    render();
  });

  function me() {
    if (!state) return null;
    return state.players.find((p) => p.id === myId) || null;
  }

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function topbar() {
    return el("div", { class: "topbar" },
      el("div", { class: "brand" }, "CODENAMES", el("small", {}, "CLASSIFIED · INTEL BOARD")),
      roomCode ? el("div", { class: "room-chip" }, roomCode) : null
    );
  }

  // ---------------------------------------------------------------- HOME
  function renderHome() {
    const wrap = el("div", { class: "center-screen" },
      el("div", { class: "folder-card", "data-tab": "CASE FILE · NEW" },
        el("h1", {}, "Codenames"),
        el("p", { class: "sub" }, "Assemble two teams. Crack the code before the assassin surfaces."),
        errorMsg ? el("div", { class: "error-banner" }, errorMsg) : null,
        el("div", { class: "field" },
          el("label", {}, "Your codename"),
          el("input", { id: "nameInput", type: "text", maxlength: "24", placeholder: "e.g. FALCON", value: myName })
        ),
        el("button", { class: "btn btn-primary", onclick: onCreate }, "Start a new case (create room)"),
        el("div", { class: "divider-word" }, "or join an existing case"),
        el("div", { class: "field" },
          el("label", {}, "Room code"),
          el("input", { id: "codeInput", type: "text", maxlength: "4", placeholder: "e.g. FOXY", style: "text-transform:uppercase;letter-spacing:4px;", value: roomCode })
        ),
        el("button", { class: "btn btn-ghost", onclick: onJoin }, "Join room")
      )
    );
    return wrap;
  }

  function readName() {
    const input = document.getElementById("nameInput");
    myName = (input.value || "Agent").trim().slice(0, 24) || "Agent";
    localStorage_safeSet("cn_name", myName);
    return myName;
  }

  function onCreate() {
    const name = readName();
    socket.emit("create_room", { name });
  }
  function onJoin() {
    const name = readName();
    const code = (document.getElementById("codeInput").value || "").trim().toUpperCase();
    if (!code) { errorMsg = "Enter a room code."; return render(); }
    socket.emit("join_room", { code, name });
  }

  // ---------------------------------------------------------------- LOBBY
  function teamDossier(team) {
    const players = state.players.filter((p) => p.team === team);
    const label = team === "red" ? "RED CELL" : "BLUE CELL";
    const spymasters = players.filter((p) => p.role === "spymaster");
    const operatives = players.filter((p) => p.role === "operative");
    const unassigned = players.filter((p) => !p.role);

    function pill(p) {
      return el("span", { class: "player-pill" + (p.id === myId ? " self" : "") }, p.name);
    }

    return el("div", { class: "team-dossier" + (team === "blue" ? " blue" : "") },
      el("h2", {}, label),
      el("div", { class: "role-slot" }, "Spymaster"),
      spymasters.length ? spymasters.map(pill) : el("span", { class: "small-note" }, "— empty —"),
      el("div", { class: "role-slot" }, "Operatives"),
      operatives.length ? operatives.map(pill) : el("span", { class: "small-note" }, "— empty —"),
      unassigned.length ? el("div", { class: "role-slot" }, "Joined, no role yet") : null,
      unassigned.length ? unassigned.map(pill) : null,
      el("div", { class: "join-row" },
        el("button", { class: "btn btn-ghost", onclick: () => setTeamRole(team, "spymaster") }, "Be spymaster"),
        el("button", { class: "btn btn-ghost", onclick: () => setTeamRole(team, "operative") }, "Be operative")
      )
    );
  }

  function setTeamRole(team, role) {
    socket.emit("set_team", { team });
    socket.emit("set_role", { role });
  }

  function renderLobby() {
    const self = me();
    const wrap = el("div", { class: "lobby-wrap" },
      el("p", { class: "hint" }, "Share room code ", el("b", {}, roomCode), " with your team. Each side needs one spymaster and at least one operative."),
      errorMsg ? el("div", { class: "error-banner" }, errorMsg) : null,
      el("div", { class: "teams-grid" }, teamDossier("red"), teamDossier("blue")),
      el("div", { class: "lobby-controls" },
        el("button", { class: "btn btn-primary", onclick: () => socket.emit("start_game") }, "Brief the teams (start game)")
      ),
      el("p", { class: "small-note" }, self ? `You are ${self.name}${self.team ? " · " + self.team.toUpperCase() : ""}${self.role ? " · " + self.role : ""}` : "")
    );
    return wrap;
  }

  // ---------------------------------------------------------------- GAME
  const STAMP_LABEL = { red: "RED AGENT", blue: "BLUE AGENT", neutral: "BYSTANDER", assassin: "ASSASSIN" };

  function cardEl(card, idx, self) {
    const revealed = card.revealed;
    const classes = ["card"];
    if (revealed) classes.push("revealed", card.color);
    const canSeeColor = card.color !== undefined && !revealed; // spymaster-only pre-reveal
    const isMyTurnGuess =
      self && self.role === "operative" && self.team === state.turnTeam && state.phase === "guess" && !revealed;

    const style = [];
    if (canSeeColor) {
      const edge = card.color === "red" ? "var(--red)" : card.color === "blue" ? "var(--blue)" : card.color === "assassin" ? "var(--assassin)" : "var(--neutral)";
      classes.push("key-edge");
      style.push(`--edge-color:${edge}`);
    }

    const node = el("button", {
      class: classes.join(" "),
      style: style.join(";"),
      disabled: !isMyTurnGuess,
      onclick: isMyTurnGuess ? () => socket.emit("guess_word", { index: idx }) : null,
    },
      el("span", {}, card.word),
      revealed ? el("div", { class: "stamp" }, el("span", {}, STAMP_LABEL[card.color] || "")) : null
    );
    return node;
  }

  function renderGame() {
    const self = me();
    const isSpymaster = self && self.role === "spymaster";
    const isMyTurn = self && self.team === state.turnTeam;
    const ended = state.phase === "ended";

    const boardEl = el("div", { class: "board" }, board.map((c, i) => cardEl(c, i, self)));

    const scoreboard = el("div", { class: "scoreboard" },
      el("div", { class: "score-badge" + (state.turnTeam === "red" && !ended ? " active" : "") }, "RED", el("span", { class: "num" }, state.remaining.red)),
      el("div", { class: "score-badge blue" + (state.turnTeam === "blue" && !ended ? " active" : "") }, "BLUE", el("span", { class: "num" }, state.remaining.blue))
    );

    const turnBanner = !ended ? el("div", { class: "turn-banner" },
      "Turn: ", el("b", {}, state.turnTeam.toUpperCase()),
      " · Phase: ", el("b", {}, state.phase === "clue" ? "awaiting clue" : "guessing")
    ) : null;

    const resultBanner = ended ? el("div", { class: "result-banner " + state.winner },
      `${state.winner.toUpperCase()} TEAM WINS`
    ) : null;

    // clue panel
    let cluePanel;
    if (state.phase === "clue" && isSpymaster && isMyTurn) {
      cluePanel = el("div", { class: "panel" },
        el("h3", {}, "Transmit clue"),
        el("div", { class: "clue-form" },
          el("input", { id: "clueWord", type: "text", maxlength: "40", placeholder: "one word" }),
          el("input", { id: "clueNum", type: "number", min: "0", max: "9", value: "1" }),
          el("button", { class: "btn btn-primary", style: "width:auto;padding:8px 14px;", onclick: sendClue }, "Send")
        )
      );
    } else if (state.clue) {
      cluePanel = el("div", { class: "panel" },
        el("h3", {}, "Current clue"),
        el("div", { class: "clue-display" }, state.clue.word, el("span", { class: "n" }, state.clue.number))
      );
    } else {
      cluePanel = el("div", { class: "panel" },
        el("h3", {}, "Current clue"),
        el("div", { class: "clue-empty" }, ended ? "Case closed." : "Waiting on spymaster…")
      );
    }

    const controlsPanel = (!ended && self && self.role === "operative" && self.team === state.turnTeam && state.phase === "guess")
      ? el("div", { class: "panel" },
          el("button", { class: "btn btn-ghost", onclick: () => socket.emit("end_turn") }, "End turn")
        )
      : null;

    const rolePanel = el("div", { class: "panel" },
      el("h3", {}, "Your status"),
      self ? el("span", { class: "role-badge" }, `${self.name} · ${self.team ? self.team.toUpperCase() : "—"} · ${self.role || "—"}`) : el("span", { class: "small-note" }, "—"),
      ended ? el("div", { style: "margin-top:12px;" },
        el("button", { class: "btn btn-primary", onclick: () => socket.emit("new_game") }, "Start new case")
      ) : null
    );

    const logPanel = el("div", { class: "panel" },
      el("h3", {}, "Field log"),
      el("ul", { class: "log-list" }, (state.log || []).map((l) => el("li", {}, l.text)))
    );

    const sidebar = el("div", { class: "sidebar" }, cluePanel, controlsPanel, rolePanel, logPanel);

    const wrap = el("div", { class: "game-wrap" },
      scoreboard,
      turnBanner,
      resultBanner,
      boardEl,
      sidebar
    );
    return wrap;
  }

  function sendClue() {
    const word = document.getElementById("clueWord").value.trim();
    const num = document.getElementById("clueNum").value;
    if (!word) return;
    socket.emit("give_clue", { word, number: num });
  }

  // ---------------------------------------------------------------- ROOT
  function render() {
    app.innerHTML = "";
    app.appendChild(topbar());
    if (!state) {
      app.appendChild(renderHome());
      return;
    }
    if (screen === "lobby") app.appendChild(renderLobby());
    else app.appendChild(renderGame());
  }

  render();
})();