# Codenames — real-time multiplayer

A hostable Codenames web app. Each player joins from their own phone or
laptop, picks a team and role, and plays a full game together — spymasters
give one-word clues, operatives guess, and the board syncs instantly for
everyone in the room.

## Run it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`. Open it in a few browser tabs (or on your
phone, on the same Wi-Fi, at `http://YOUR-COMPUTER-IP:3000`) to test with
multiple players.

## How it works

- **Server** (`server.js`): Express serves the static frontend, and
  Socket.io keeps every player's screen in sync. The server is the single
  source of truth for the board and game state — the key (which words are
  red/blue/neutral/assassin) is only ever sent to spymasters, so there's no
  way to peek by opening dev tools.
- **Client** (`public/`): plain HTML/CSS/JS, no build step needed.
- Game state lives in memory. If you restart the server, active rooms are
  lost — that's fine for casual play; swap in Redis if you need rooms to
  survive restarts.

## Playing a game

1. One player opens the site and clicks **"Start a new case"** — this
   creates a 4-letter room code.
2. Everyone else opens the site and joins with that code.
3. Each player picks a team (red/blue) and a role (spymaster or operative).
   You need at least one spymaster and one operative per team.
4. Click **"Brief the teams"** to deal the board.
5. The starting team's spymaster types a one-word clue and a number.
   Operatives on that team click words to guess. A wrong guess or neutral
   word ends the turn; the assassin ends the game instantly.
6. First team to reveal all their words wins.

## AI players

Any empty seat can be filled by an AI. In the lobby, each team has
**🤖 AI spymaster** and **🤖 AI operative** buttons.

- **AI spymaster** sees the key (server-side only), and gives a one-word clue
  plus a number. Every clue is validated before it is used: single word, not on
  the board, not a substring/superstring of a board word, sensible number. An
  illegal clue is sent back to the model for up to 3 attempts.
- **AI operative** only sees what a human operative sees (hidden words, the
  clue, revealed cards and past turns) and guesses in order of confidence.
  It steps aside automatically whenever a human operative is on its team.
- If the AI call fails (outage, bad output), the game shows a **Retry AI**
  button instead of freezing.

Enable it by setting an API key before starting the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# optional: AI_MODEL=claude-sonnet-5-5 (default)
npm start
```

On Render/Railway add `ANTHROPIC_API_KEY` as an environment variable. Without
a key the game works exactly as before and the AI buttons stay disabled. The
key stays on the server and is never sent to browsers. Code lives in `ai.js`
(prompts, validation) and the "AI players" section of `server.js`.

## Deploying so others can join from anywhere

Any host that runs a persistent Node.js process works (this app needs
WebSockets, so it won't run on purely static hosts). Two easy free options:

**Render**
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a new **Web Service** from
   that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy — Render gives you a public URL to share.

**Railway**
1. Push to GitHub, then [railway.app](https://railway.app) → **New
   Project** → **Deploy from GitHub repo**.
2. Railway auto-detects Node and runs `npm start`. Deploy — share the
   generated URL.

Both platforms set `PORT` automatically, which `server.js` already reads
from `process.env.PORT`.

## Customizing

- **Word list**: edit `words.js` — one word per array entry, at least 25.
- **Colors/fonts/layout**: `public/style.css` (CSS variables at the top
  under `:root`).
- **Game rules** (e.g. how many extra guesses a clue number grants):
  `server.js`, in the `give_clue` handler.