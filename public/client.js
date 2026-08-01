(function () {
  const app = document.getElementById("app");
  const socket = io();

  // A persistent identity for this browser tab, independent of the socket
  // connection. socket.id changes on every reconnect (e.g. a page refresh),
  // but clientId survives via sessionStorage, so the server can recognize
  // "this is the same player coming back" and restore their team/role
  // instead of treating them as a brand new stranger.
  let clientId = safeGet("cn_client_id");
  if (!clientId) {
    clientId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("c" + Date.now() + Math.random().toString(16).slice(2));
    safeSet("cn_client_id", clientId);
  }

  let myName = safeGet("cn_name") || "";
  let roomCode = safeGet("cn_room") || "";
  const hadStoredRoom = !!roomCode; // did we have a room to try rejoining on load?
  let state = null; // last room_update.state
  let board = null; // last room_update.board
  let prevBoard = null; // board from before the latest update, for sound-on-reveal diffing
  let errorMsg = "";
  let screen = hadStoredRoom ? "reconnecting" : "home"; // reconnecting | home | lobby | game
  let soundOn = safeGet("cn_sound") !== "off";

  function safeGet(k) {
    try { return sessionStorage.getItem(k); } catch (e) { return null; }
  }
  function safeSet(k, v) {
    try { sessionStorage.setItem(k, v); } catch (e) {}
  }
  function safeClear(k) {
    try { sessionStorage.removeItem(k); } catch (e) {}
  }

  // ---------------------------------------------------------------- sound
  // Generated tones via Web Audio API — no external audio files needed.
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
  }
  function beep(freq, duration, type, delay) {
    if (!soundOn) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }
  function playRevealSound(color, wasMyTeam) {
    if (color === "assassin") {
      beep(160, 0.35, "sawtooth");
      beep(110, 0.5, "sawtooth", 0.12);
    } else if (color === "neutral") {
      beep(300, 0.18, "triangle");
    } else if (wasMyTeam === true) {
      beep(660, 0.12, "sine");
      beep(880, 0.16, "sine", 0.1);
    } else {
      beep(220, 0.22, "square");
    }
  }
  function playClickTick() {
    beep(500, 0.05, "square");
  }

  socket.on("connect", () => {
    if (hadStoredRoom && screen === "reconnecting" && !state) {
      // Attempt to silently rejoin the room we were in before the refresh.
      socket.emit("join_room", { code: roomCode, name: myName, clientId });
    }
    render();
  });

  socket.on("room_update", (payload) => {
    prevBoard = board;
    state = payload.state;
    board = payload.board;
    roomCode = state.code;
    safeSet("cn_room", roomCode);
    errorMsg = "";
    screen = state.phase === "lobby" ? "lobby" : "game";

    // Play a sound for any card that just transitioned from hidden to revealed.
    if (prevBoard && board && prevBoard.length === board.length) {
      const self = me();
      for (let i = 0; i < board.length; i++) {
        if (board[i].revealed && !prevBoard[i].revealed) {
          const wasMyTeam = self && self.team ? board[i].color === self.team : undefined;
          playRevealSound(board[i].color, wasMyTeam);
        }
      }
    }
    render();
  });

  socket.on("error_msg", (msg) => {
    if (screen === "reconnecting") {
      // The room we tried to rejoin is gone (server restarted, room expired,
      // etc.) — fall back to the home screen instead of getting stuck.
      safeClear("cn_room");
      roomCode = "";
      screen = "home";
    }
    errorMsg = msg;
    render();
  });

  socket.on("disconnect", () => {
    errorMsg = "Connection lost. Reconnecting…";
    render();
  });

  function me() {
    if (!state) return null;
    return state.players.find((p) => p.id === clientId) || null;
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

  function toggleSound() {
    soundOn = !soundOn;
    safeSet("cn_sound", soundOn ? "on" : "off");
    if (soundOn) beep(500, 0.08, "sine"); // little confirmation blip
    render();
  }

  function identityChip() {
    const self = me();
    if (!self) return null;
    const teamLabel = self.team ? self.team.toUpperCase() : "SPECTATOR";
    const roleLabel = self.role ? " · " + self.role.toUpperCase() : "";
    const cls = self.team === "red" ? "identity-chip red" : self.team === "blue" ? "identity-chip blue" : "identity-chip";
    return el("div", { class: cls }, `${self.name} · ${teamLabel}${roleLabel}`);
  }

  function topbar() {
    return el("div", { class: "topbar" },
      el("div", { class: "brand" }, "CODENAMES", el("small", {}, "CLASSIFIED · INTEL BOARD")),
      el("div", { class: "topbar-right" },
        identityChip(),
        el("button", { class: "sound-toggle", title: soundOn ? "Mute sound" : "Unmute sound", onclick: toggleSound }, soundOn ? "🔊" : "🔇"),
        roomCode ? el("div", { class: "room-chip" }, roomCode) : null
      )
    );
  }

  // ---------------------------------------------------------------- RECONNECTING
  function renderReconnecting() {
    return el("div", { class: "center-screen" },
      el("div", { class: "folder-card", "data-tab": "CASE FILE · RESUMING" },
        el("h1", {}, "Reconnecting…"),
        el("p", { class: "sub" }, `Rejoining room ${roomCode}.`),
        errorMsg ? el("div", { class: "error-banner" }, errorMsg) : null
      )
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
    safeSet("cn_name", myName);
    return myName;
  }

  function onCreate() {
    const name = readName();
    socket.emit("create_room", { name, clientId });
  }
  function onJoin() {
    const name = readName();
    const code = (document.getElementById("codeInput").value || "").trim().toUpperCase();
    if (!code) { errorMsg = "Enter a room code."; return render(); }
    socket.emit("join_room", { code, name, clientId });
  }

  // ---------------------------------------------------------------- LOBBY
  function teamDossier(team) {
    const players = state.players.filter((p) => p.team === team);
    const label = team === "red" ? "RED CELL" : "BLUE CELL";
    const spymasters = players.filter((p) => p.role === "spymaster");
    const operatives = players.filter((p) => p.role === "operative");
    const unassigned = players.filter((p) => !p.role);

    function pill(p) {
      const away = p.connected === false;
      return el("span", { class: "player-pill" + (p.id === clientId ? " self" : "") + (away ? " away" : "") },
        p.name + (away ? " (away)" : "")
      );
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

  function spectatorsPanel() {
    const spectators = state.players.filter((p) => !p.team);
    return el("div", { class: "panel" },
      el("h3", {}, "Spectators"),
      spectators.length
        ? el("div", {}, spectators.map((p) => el("span", {
            class: "player-pill" + (p.id === clientId ? " self" : "") + (p.connected === false ? " away" : "")
          }, p.name + (p.connected === false ? " (away)" : ""))))
        : el("span", { class: "small-note" }, "Nobody watching right now."),
      el("p", { class: "small-note", style: "margin-top:8px;text-align:left;" },
        "New players start here. Pick a team above to play, or stay here to watch."
      )
    );
  }

  function setTeamRole(team, role) {
    socket.emit("set_team", { team });
    socket.emit("set_role", { role });
  }

  function wordPoolPanel() {
    const custom = (state.customWords || []);
    const onlyCustom = !!state.onlyCustomWords;
    const need = state.boardSize || 25;
    const enoughForOnlyCustom = custom.length >= need;
    return el("div", { class: "panel word-pool-panel" },
      el("h3", {}, "Word pool"),
      el("p", { class: "small-note", style: "margin:0 0 10px;text-align:left;" },
        "Add your own words to mix into the board (comma or newline separated)."
      ),
      el("div", { class: "clue-form", style: "align-items:flex-start;" },
        el("textarea", { id: "extraWords", rows: "2", placeholder: "e.g. PIZZA, MOUNTAIN, WIZARD", style: "flex:1;resize:vertical;padding:8px 10px;border-radius:2px;border:1px solid rgba(231,221,192,0.2);background:var(--ink-3);color:var(--paper);font-family:var(--font-mono);font-size:12px;" }),
        el("button", { class: "btn btn-ghost", style: "width:auto;padding:8px 14px;", onclick: onAddWords }, "Add")
      ),
      el("label", { class: "checkbox-row" },
        el("input", {
          type: "checkbox",
          checked: onlyCustom || false,
          onchange: (e) => socket.emit("set_word_mode", { onlyCustom: e.target.checked }),
        }),
        `Use ONLY my words for the board (need ${need} — you have ${custom.length}/${need})`
      ),
      onlyCustom && !enoughForOnlyCustom
        ? el("p", { class: "small-note", style: "margin-top:6px;text-align:left;color:var(--amber-bright);" },
            `Add ${need - custom.length} more word${need - custom.length === 1 ? "" : "s"} before starting — until then the default word bank will fill any gaps.`
          )
        : null,
      custom.length
        ? el("p", { class: "small-note", style: "margin-top:10px;text-align:left;" },
            `${custom.length} custom word${custom.length === 1 ? "" : "s"} in the pool: `,
            custom.join(", ")
          )
        : null
    );
  }

  function onAddWords() {
    const input = document.getElementById("extraWords");
    const words = input.value.trim();
    if (!words) return;
    socket.emit("add_words", { words });
    input.value = "";
  }

  function boardSizePanel() {
    const options = state.boardSizeOptions || [16, 20, 25, 30];
    const current = state.boardSize || 25;
    return el("div", { class: "panel" },
      el("h3", {}, "Board size"),
      el("div", { class: "size-options" },
        options.map((n) => el("button", {
          class: "btn size-btn" + (n === current ? " active" : ""),
          onclick: () => socket.emit("set_board_size", { size: n }),
        }, `${n} cards`))
      )
    );
  }

  function renderLobby() {
    const self = me();
    const wrap = el("div", { class: "lobby-wrap" },
      el("p", { class: "hint" }, "Share room code ", el("b", {}, roomCode), " with your team. Each side needs one spymaster and at least one operative."),
      errorMsg ? el("div", { class: "error-banner" }, errorMsg) : null,
      el("div", { class: "teams-grid" }, teamDossier("red"), teamDossier("blue")),
      self && self.team ? el("div", { class: "lobby-controls", style: "margin-bottom:20px;" },
        el("button", { class: "btn btn-ghost", style: "width:auto;padding:8px 16px;", onclick: () => socket.emit("become_spectator") }, "Become spectator")
      ) : null,
      spectatorsPanel(),
      boardSizePanel(),
      wordPoolPanel(),
      el("div", { class: "lobby-controls" },
        el("button", { class: "btn btn-primary", onclick: () => socket.emit("start_game") }, "Brief the teams (start game)")
      ),
      el("p", { class: "small-note" }, self ? `You are ${self.name}${self.team ? " · " + self.team.toUpperCase() : " · SPECTATOR"}${self.role ? " · " + self.role : ""}` : "")
    );
    return wrap;
  }

  // ---------------------------------------------------------------- GAME
  const STAMP_LABEL = { red: "RED AGENT", blue: "BLUE AGENT", neutral: "BYSTANDER", assassin: "ASSASSIN" };

  // Deterministic little "redacted photo" swatch per word — no network
  // images needed, but every card gets a unique visual identity that fits
  // the dossier theme.
  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function photoSwatch(word) {
    const hue = hashHue(word);
    const hue2 = (hue + 40) % 360;
    const style = `background: linear-gradient(135deg, hsl(${hue},38%,30%), hsl(${hue2},30%,18%));`;
    return el("div", { class: "card-photo", style });
  }

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
      type: "button",
      disabled: !isMyTurnGuess,
      onclick: isMyTurnGuess ? () => { playClickTick(); socket.emit("guess_word", { index: idx }); } : null,
    },
      photoSwatch(card.word),
      el("span", { class: "card-word" }, card.word),
      revealed ? el("div", { class: "stamp" }, el("span", {}, STAMP_LABEL[card.color] || "")) : null
    );
    return node;
  }

  function renderGame() {
    const self = me();
    const isSpymaster = self && self.role === "spymaster";
    const isMyTurn = self && self.team === state.turnTeam;
    const ended = state.phase === "ended";
    const boardSizeClass = board.length > 25 ? " board-xl" : board.length <= 16 ? " board-sm" : "";

    const boardEl = el("div", { class: "board" + boardSizeClass }, board.map((c, i) => cardEl(c, i, self)));

    const scoreboard = el("div", { class: "scoreboard" },
      el("div", { class: "score-badge" + (state.turnTeam === "red" && !ended ? " active" : "") }, "RED", el("span", { class: "num" }, state.remaining.red)),
      el("div", { class: "score-badge blue" + (state.turnTeam === "blue" && !ended ? " active" : "") }, "BLUE", el("span", { class: "num" }, state.remaining.blue))
    );

    const turnBanner = !ended ? el("div", { class: "turn-banner" },
      "Turn: ", el("b", {}, state.turnTeam.toUpperCase()),
      " · Phase: ", el("b", {}, state.phase === "clue" ? "awaiting clue" : "guessing"),
      self && !self.team ? el("span", {}, " · you are spectating") : null
    ) : null;

    const resultBanner = ended ? el("div", { class: "result-banner " + (state.winner || "aborted") },
      state.winner ? `${state.winner.toUpperCase()} TEAM WINS` : "GAME ENDED"
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

    const endGamePanel = (!ended && self && self.team)
      ? el("div", { class: "panel" },
          el("button", { class: "btn btn-ghost danger", onclick: onEndGame }, "End game")
        )
      : null;

    const rolePanel = el("div", { class: "panel" },
      el("h3", {}, "Your status"),
      self ? el("span", { class: "role-badge" }, `${self.name} · ${self.team ? self.team.toUpperCase() : "SPECTATOR"} · ${self.role || "—"}`) : el("span", { class: "small-note" }, "—"),
      ended ? el("div", { style: "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;" },
        el("button", { class: "btn btn-primary", style: "width:auto;", onclick: () => socket.emit("new_game") }, "Rematch"),
        el("button", { class: "btn btn-ghost", style: "width:auto;", onclick: () => socket.emit("back_to_lobby") }, "Back to lobby")
      ) : null
    );

    const logPanel = el("div", { class: "panel" },
      el("h3", {}, "Field log"),
      el("ul", { class: "log-list" }, (state.log || []).map((l) => el("li", {}, l.text)))
    );

    const sidebar = el("div", { class: "sidebar" }, cluePanel, controlsPanel, endGamePanel, rolePanel, logPanel);

    const wrap = el("div", { class: "game-wrap" },
      scoreboard,
      turnBanner,
      resultBanner,
      boardEl,
      sidebar
    );
    return wrap;
  }

  function onEndGame() {
    if (confirm("End the game now for everyone?")) {
      socket.emit("end_game");
    }
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
      app.appendChild(screen === "reconnecting" ? renderReconnecting() : renderHome());
      return;
    }
    if (screen === "lobby") app.appendChild(renderLobby());
    else app.appendChild(renderGame());
  }

  render();
})();