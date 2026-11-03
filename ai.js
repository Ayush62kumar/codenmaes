// AI helpers for Codenames bots (spymaster + operative).
//
// Talks to an LLM API with plain fetch (Node >= 18), so no extra dependency
// is needed. Two providers are supported; configure with environment variables:
//   Gemini (has a free tier):  GEMINI_API_KEY   (+ optional AI_MODEL)
//   Anthropic:                 ANTHROPIC_API_KEY (+ optional AI_MODEL)
//   PROVIDER=gemini|anthropic  (optional; auto-detected from whichever key is set)
//
// Everything the model returns is treated as untrusted: clues are validated
// against the board before being used, and guesses are matched against the
// words that are actually still hidden.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
// Tried in order when AI_MODEL is not set. Google retires models regularly, so if one
// returns 404 ("no longer available") we move on to the next and remember what worked.
const GEMINI_MODEL_FALLBACKS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
let geminiWorkingModel = null;
const REQUEST_TIMEOUT_MS = 45000;

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
}

// Which provider to use: explicit PROVIDER wins, otherwise whichever key exists.
function provider() {
  const explicit = (process.env.PROVIDER || "").toLowerCase();
  if (explicit === "gemini" || explicit === "anthropic") return explicit;
  if (geminiKey()) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

async function anthropicCompleter({ system, user, maxTokens }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL,
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

async function geminiRequest(model, { system, user, maxTokens }) {
  const generationConfig = {
    // Headroom: on "thinking" models, reasoning tokens count against this limit.
    maxOutputTokens: Math.max(1024, (maxTokens || 400) * 3),
    responseMimeType: "application/json",
  };
  // Thinking isn't needed for these short answers; turn it off where supported (2.5 Flash).
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": geminiKey() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Gemini API ${res.status} (${model}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text) {
    const why = (data.candidates && data.candidates[0] && data.candidates[0].finishReason) ||
      (data.promptFeedback && data.promptFeedback.blockReason) || "empty response";
    throw new Error(`Gemini returned no text (${why})`);
  }
  return text;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = new Set([500, 502, 503, 504]); // overloaded / temporary: worth retrying
const SKIP_MODEL = new Set([404, 429]);          // retired or out of quota: try a different model

// One model, with a short retry on temporary overload errors.
async function geminiWithRetry(model, args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await geminiRequest(model, args);
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.has(err.status) || i === attempts - 1) throw err;
      await wait(1500 * (i + 1)); // 1.5s, 3s
    }
  }
  throw lastErr;
}

async function geminiCompleter(args) {
  if (process.env.AI_MODEL) return geminiWithRetry(process.env.AI_MODEL, args);
  // Start with the model that last worked, then the rest of the list.
  const order = geminiWorkingModel
    ? [geminiWorkingModel, ...GEMINI_MODEL_FALLBACKS.filter((m) => m !== geminiWorkingModel)]
    : GEMINI_MODEL_FALLBACKS;
  let lastErr;
  for (const model of order) {
    try {
      const text = await geminiWithRetry(model, args, 2);
      geminiWorkingModel = model;
      return text;
    } catch (err) {
      lastErr = err;
      const modelProblem = SKIP_MODEL.has(err.status) || TRANSIENT.has(err.status) ||
        (err.status === 400 && /model/i.test(err.message));
      if (!modelProblem) throw err; // e.g. bad API key: another model won't help
    }
  }
  throw lastErr;
}

async function defaultCompleter(args) {
  const p = provider();
  if (p === "gemini") return geminiCompleter(args);
  if (p === "anthropic") return anthropicCompleter(args);
  throw new Error("No AI provider configured");
}

let completer = defaultCompleter;

// Tests swap in a fake model with this.
function setCompleter(fn) {
  completer = fn || defaultCompleter;
}

function isEnabled() {
  return completer !== defaultCompleter || provider() !== null;
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