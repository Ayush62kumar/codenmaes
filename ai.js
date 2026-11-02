// AI helpers for Codenames bots (spymaster + operative).
//
// Talks to the Anthropic Messages API with plain fetch (Node >= 18), so no
// extra dependency is needed. Configure with environment variables:
//   ANTHROPIC_API_KEY  (required to enable AI players)
//   AI_MODEL           (optional, default below)
//
// Everything the model returns is treated as untrusted: clues are validated
// against the board before being used, and guesses are matched against the
// words that are actually still hidden.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const REQUEST_TIMEOUT_MS = 45000;

async function defaultCompleter({ system, user, maxTokens }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_MODEL,
      max_tokens: maxTokens || 400,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

let completer = defaultCompleter;

// Tests swap in a fake model with this.
function setCompleter(fn) {
  completer = fn || defaultCompleter;
}

function isEnabled() {
  return completer !== defaultCompleter || !!process.env.ANTHROPIC_API_KEY;
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

const letters = (s) => String(s).toUpperCase().replace(/[^\p{L}]/gu, "");

// Returns a human-readable reason if the clue is illegal, otherwise null.
// `boardWords` = words still hidden on the board (revealed words may be reused).
function validateClue(clue, number, boardWords, ownRemaining) {
  if (typeof clue !== "string" || !/^\p{L}+$/u.test(clue.trim())) {
    return "the clue must be a single word made of letters only";
  }
  const c = letters(clue);
  for (const w of boardWords) {
    const b = letters(w);
    if (!b) continue;
    if (c === b) return `"${clue}" is a word on the board`;
    if (c.length >= 3 && b.length >= 3 && (b.includes(c) || c.includes(b))) {
      return `"${clue}" is too similar to the board word ${w}`;
    }
  }
  if (!Number.isInteger(number) || number < 1 || number > Math.min(9, ownRemaining)) {
    return `the number must be a whole number from 1 to ${Math.min(9, ownRemaining)}`;
  }
  return null;
}

const RULES = `You are playing Codenames. The board has hidden cards of four kinds: cards belonging to the RED team, cards belonging to the BLUE team, neutral bystanders, and exactly one ASSASSIN. A team wins by revealing all of its own cards. Revealing the assassin loses the game instantly. Revealing a neutral or opposing card ends the guessing team's turn (and an opposing card helps the other team).`;

const SPYMASTER_SYSTEM = `${RULES}

You are the SPYMASTER. You can see which cards belong to whom. Give ONE single-word clue plus a number: the number of your team's remaining cards the clue relates to.

Rules for the clue:
- Exactly one word, letters only. No spaces, hyphens or digits.
- It must not be (or contain, or be contained in) any word still on the board.
- It must not hint at the assassin or the opposing team's words. Weigh the risk: the assassin is catastrophic, opposing cards are bad, neutral cards are mildly bad.
- Prefer a clue that safely links 2 or more of your team's words, but a safe 1 beats a risky 3.

Respond with ONLY a JSON object, no other text:
{"clue": "WORD", "number": 2, "targets": ["YOURWORD1", "YOURWORD2"]}`;

const OPERATIVE_SYSTEM = `${RULES}

You are an OPERATIVE. You cannot see which cards belong to whom, only the words, the clue your spymaster gave, and what has already been revealed. Pick the cards on the board you think the clue refers to, most confident first.

Guidelines:
- You may list at most the allowed number of guesses (given in the user message).
- The first guess is mandatory. Add more only if you are reasonably confident; every wrong guess ends the turn.
- Never pick a word that is not on the list of hidden words.
- Think about earlier clues from your team: leftover words from them can be good extra guesses.

Respond with ONLY a JSON object, no other text:
{"guesses": ["WORD1", "WORD2"]}`;

function historyText(history) {
  if (!history || !history.length) return "none yet";
  return history
    .map((h) => {
      const g = h.guesses.length ? h.guesses.map((x) => `${x.word} (${x.color})`).join(", ") : "no guesses";
      return `${h.team.toUpperCase()} clue "${h.word}" ${h.number} -> ${g}`;
    })
    .join("\n");
}

// ctx: { team, own[], opponent[], neutral[], assassin[], hidden[], history[] }
async function generateClue(ctx, maxAttempts = 3) {
  const rejected = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let user =
      `You are the ${ctx.team.toUpperCase()} spymaster.\n\n` +
      `Your team's hidden cards (${ctx.own.length}): ${ctx.own.join(", ")}\n` +
      `Opposing team's hidden cards: ${ctx.opponent.join(", ") || "none"}\n` +
      `Neutral bystanders: ${ctx.neutral.join(", ") || "none"}\n` +
      `ASSASSIN: ${ctx.assassin.join(", ") || "already revealed"}\n\n` +
      `Previous turns:\n${historyText(ctx.history)}\n`;
    if (rejected.length) {
      user += `\nThese clues were rejected, so do not repeat them: ${rejected.join("; ")}\n`;
    }
    const text = await completer({ system: SPYMASTER_SYSTEM, user, maxTokens: 300 });
    let parsed;
    try {
      parsed = extractJson(text);
    } catch (e) {
      rejected.push(`unparseable reply (${e.message})`);
      continue;
    }
    const clue = typeof parsed.clue === "string" ? parsed.clue.trim() : "";
    const number = Number.isInteger(parsed.number) ? parsed.number : parseInt(parsed.number, 10);
    const reason = validateClue(clue, number, ctx.hidden, ctx.own.length);
    if (!reason) return { clue: clue.toUpperCase(), number };
    rejected.push(`${clue || "(empty)"}: ${reason}`);
  }
  throw new Error(`no valid clue after ${maxAttempts} attempts (${rejected.join(" | ")})`);
}

// ctx: { team, clue:{word,number}, maxGuesses, hidden[], revealed[{word,color}], history[] }
// Returns an ordered list of hidden words to guess (1..maxGuesses).
async function generateGuesses(ctx) {
  const user =
    `You are on the ${ctx.team.toUpperCase()} team. Your spymaster's clue is "${ctx.clue.word}" for ${ctx.clue.number} card(s).\n` +
    `You may make at most ${ctx.maxGuesses} guess(es) this turn.\n\n` +
    `Hidden words still on the board: ${ctx.hidden.join(", ")}\n` +
    `Already revealed: ${ctx.revealed.map((r) => `${r.word} (${r.color})`).join(", ") || "nothing"}\n\n` +
    `Previous turns:\n${historyText(ctx.history)}\n`;
  const text = await completer({ system: OPERATIVE_SYSTEM, user, maxTokens: 200 });
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed.guesses) ? parsed.guesses : [];
  const hiddenByKey = new Map(ctx.hidden.map((w) => [letters(w), w]));
  const out = [];
  for (const g of raw) {
    const w = hiddenByKey.get(letters(typeof g === "string" ? g : g && g.word));
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= ctx.maxGuesses) break;
  }
  if (!out.length) throw new Error("model returned no usable guesses");
  return out;
}

module.exports = { isEnabled, setCompleter, generateClue, generateGuesses, validateClue };