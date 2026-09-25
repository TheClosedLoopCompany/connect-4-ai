// API shared by the local Bun server (server.ts) and the Cloudflare Worker (worker.ts).
// The solver runs in the browser (solver-worker.ts), so only the paid AIs live here.
//
// Bot protection (enabled when TURNSTILE_SITE_KEY is set; fails closed if the
// secrets are missing): the browser solves a Cloudflare Turnstile challenge once,
// siteverify checks success + action + hostname, and the browser gets a signed
// session cookie that every /api/move needs. The Worker also rate-limits per IP.

export type Env = {
  OPENAI_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string; // comma-separated frontend hostnames siteverify must report
  SESSION_SECRET?: string;
  MOVE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
};

const ROWS = 6, COLS = 7;
type Board = string[][]; // ROWS x COLS, row 0 = top; "." empty, "X" human, "O" AI

const MODELS: Record<string, string> = { luna: "gpt-6-luna", sol: "gpt-6-sol", astra: "gpt-6-astra" };
const EFFORTS = ["none", "low", "medium", "high"];
// Astra is expensive: pin it to its cheapest supported effort ("none" is not accepted).
const FIXED_EFFORT: Record<string, string> = { astra: "low" };

const legalColumns = (b: Board) => [...Array(COLS).keys()].filter((c) => b[0][c] === ".");

function dropRow(b: Board, c: number) {
  for (let r = ROWS - 1; r >= 0; r--) if (b[r][c] === ".") return r;
  return -1;
}

// Longest line through (r, c) for the piece already placed there.
function lineLength(b: Board, r: number, c: number) {
  const p = b[r][c];
  let best = 0;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (b[rr]?.[cc] === p) { n++; rr += dr * s; cc += dc * s; }
    }
    best = Math.max(best, n);
  }
  return best;
}

const wouldWin = (b: Board, c: number, p: string) => {
  const r = dropRow(b, c);
  if (r < 0) return false;
  b[r][c] = p;
  const win = lineLength(b, r, c) >= 4;
  b[r][c] = ".";
  return win;
};

const winningColumns = (b: Board, p: string) => legalColumns(b).filter((c) => wouldWin(b, c, p));

// --- GPT ---------------------------------------------------------------------

const render = (b: Board) => [" 1 2 3 4 5 6 7", ...b.map((r) => " " + r.join(" "))].join("\n");

const gptPrompt = (b: Board) => `You are playing Connect 4 as "O" against "X". Pieces drop to the lowest empty cell of a column.
Get four in a row (horizontal, vertical or diagonal) to win. Block X's threats.
Board (top row first, "." is empty, columns numbered 1-7):
${render(b)}
Legal columns: ${legalColumns(b).map((c) => c + 1).join(", ")}.
It is O's turn. Pick the best column.`;

async function gptMove(b: Board, model: string, effort: string, key?: string) {
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      input: gptPrompt(b),
      text: {
        format: {
          type: "json_schema",
          name: "move",
          strict: true,
          schema: {
            type: "object",
            properties: { column: { type: "integer", enum: legalColumns(b).map((c) => c + 1) } },
            required: ["column"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message ?? res.status}`);
  const text = data.output
    ?.flatMap((o: any) => (o.type === "message" ? o.content : []))
    .find((c: any) => c.type === "output_text")?.text;
  return { column: JSON.parse(text).column - 1 };
}

// --- Jev ---------------------------------------------------------------------
// Jev is a System One model: fast judgment, no search, weak at counting/spatial
// reading. Per TypeSafe's guidance the board facts are computed here and each
// option describes what that move actually does; Jev judges which is best.

function describeMove(b: Board, c: number) {
  const r = dropRow(b, c);
  const xWinsNow = winningColumns(b, "X");
  b[r][c] = "O";
  const facts: string[] = [];
  const len = lineLength(b, r, c);
  if (len >= 4) facts.push("Wins the game immediately with four O in a row.");
  else {
    if (xWinsNow.includes(c)) facts.push("Blocks X's four in a row; otherwise X would win next turn.");
    const missed = xWinsNow.filter((x) => x !== c);
    if (missed.length) facts.push(`Loses: X can still complete four in a row next turn in column ${missed[0] + 1}.`);
    else if (r > 0 && wouldWin(b, c, "X")) facts.push("Loses: it lets X complete four in a row by playing on top of it in the same column.");
    const threats = winningColumns(b, "O");
    if (threats.length >= 2) facts.push("After this move O has two separate ways to win next turn; X cannot block both.");
    else if (threats.length === 1) facts.push("After this move O threatens to win next turn unless X blocks it.");
    if (len === 3) facts.push("Makes three O in a row.");
    else if (len === 2) facts.push("Makes two O in a row.");
  }
  b[r][c] = ".";
  const place = c === 3 ? "the center column" : Math.abs(c - 3) === 1 ? "a column next to the center" : Math.abs(c - 3) === 2 ? "a column two away from the center" : "an edge column";
  return { where: `Drops into ${place}, landing ${r === ROWS - 1 ? "on the bottom row" : "on top of an existing piece"}.`, effect: facts.length ? facts : ["No immediate tactical effect."] };
}

async function jevMove(b: Board, key?: string) {
  if (!key) throw new Error("TYPESAFE_API_KEY is not set");
  const criteria = Object.fromEntries(legalColumns(b).map((c) => [`column_${c + 1}`, describeMove(b, c)]));
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest",
      state: {
        game: "Connect 4. Players alternate dropping pieces into 7 columns; a piece falls to the lowest empty cell. The first to get four in a row (horizontal, vertical or diagonal) wins.",
        you_play: "O",
        opponent: "X",
        columns_bottom_to_top: Object.fromEntries(
          [...Array(COLS).keys()].map((c) => [`column_${c + 1}`, b.map((row) => row[c]).reverse().filter((v) => v !== ".").join(" ") || "empty"]),
        ),
      },
      questions: {
        move: {
          type: "choice",
          instructions: {
            question: "Which column should O play to have the best chance of winning?",
            priorities: [
              "A move that wins immediately beats everything.",
              "Never pick a move marked 'Loses' if another option is not marked 'Loses'.",
              "Blocking X's four in a row is mandatory when available.",
              "Prefer moves that create two ways to win, then moves that create threats, then longer rows and central columns.",
            ],
          },
          criteria,
        },
      },
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Jev: ${data.error?.message ?? data.detail ?? res.status}`);
  const ans = data.answers.move;
  return { column: Number(String(ans.choice).replace("column_", "")) - 1, confidence: ans.confidence };
}

const validBoard = (b: unknown): b is Board =>
  Array.isArray(b) && b.length === ROWS &&
  b.every((row) => Array.isArray(row) && row.length === COLS && row.every((v) => v === "." || v === "X" || v === "O"));

// --- sessions ------------------------------------------------------------------

const SESSION_HOURS = 6;
const enc = new TextEncoder();

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  return [...mac].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hasSession(req: Request, env: Env) {
  const cookie = req.headers.get("Cookie")?.match(/(?:^|;\s*)c4s=([^;]+)/)?.[1];
  if (!cookie || !env.SESSION_SECRET) return false;
  const [exp, mac] = cookie.split(".");
  return Number(exp) > Date.now() && mac === (await sign(exp, env.SESSION_SECRET));
}

const TURNSTILE_ACTION = "play";

async function startSession(req: Request, env: Env) {
  const forbidden = () => Response.json({ error: "Bot check failed" }, { status: 403 });
  const { token } = await req.json().catch(() => ({}));
  const hostnames = new Set((env.TURNSTILE_HOSTNAMES ?? "").split(",").map((h) => h.trim()).filter(Boolean));
  if (typeof token !== "string" || !token || token.length > 2048 || !hostnames.size) return forbidden();
  let check: any;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token, remoteip: req.headers.get("CF-Connecting-IP") ?? "" }),
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    check = await r.json();
  } catch {
    return forbidden();
  }
  if (!check.success || check.action !== TURNSTILE_ACTION || !hostnames.has(check.hostname)) return forbidden();
  const exp = String(Date.now() + SESSION_HOURS * 3600_000);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": `c4s=${exp}.${await sign(exp, env.SESSION_SECRET!)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}` },
  });
}

// --- router --------------------------------------------------------------------

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const protectedMode = Boolean(env.TURNSTILE_SITE_KEY);
  try {
    if (pathname === "/api/config") return Response.json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null, turnstileAction: TURNSTILE_ACTION });
    if (protectedMode && !(env.TURNSTILE_SECRET && env.SESSION_SECRET)) {
      return Response.json({ error: "Bot protection is not configured yet." }, { status: 503 });
    }
    if (req.method !== "POST") return new Response("Not found", { status: 404 });
    if (pathname === "/api/session" && protectedMode) return await startSession(req, env);
    if (pathname !== "/api/move") return new Response("Not found", { status: 404 });

    if (protectedMode && !(await hasSession(req, env))) return Response.json({ error: "session" }, { status: 401 });
    if (env.MOVE_LIMITER) {
      const { success } = await env.MOVE_LIMITER.limit({ key: req.headers.get("CF-Connecting-IP") ?? "unknown" });
      if (!success) return Response.json({ error: "Too many moves, slow down a little." }, { status: 429 });
    }

    const { board, engine, effort } = await req.json();
    if (!validBoard(board)) return Response.json({ error: "Invalid board" }, { status: 400 });
    const legal = legalColumns(board);
    if (!legal.length) return Response.json({ error: "Board is full" }, { status: 400 });
    const move = engine === "jev"
      ? await jevMove(board, env.TYPESAFE_API_KEY)
      : await gptMove(board, MODELS[engine] ?? MODELS.luna, FIXED_EFFORT[engine] ?? (EFFORTS.includes(effort) ? effort : "medium"), env.OPENAI_API_KEY);
    if (!legal.includes(move.column)) {
      return Response.json({ column: legal[0], note: `AI picked illegal column ${move.column + 1}` });
    }
    return Response.json(move);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
