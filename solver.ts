// Perfect Connect 4 solver: negamax + alpha-beta, after Pascal Pons
// (http://blog.gamesolver.org). Bitboards, null-window search, transposition
// table, threat-based move ordering.
//
// Bit layout (Pons): bit = col * 7 + row, row 0 = bottom, row 6 is a sentinel.
// That's 49 bits and JS bitwise ops are 32-bit, so a bitboard is split in two
// words: lo = columns 0-3 (28 bits), hi = columns 4-6 (21 bits).

const W = 7, H = 6, SIZE = W * H;
const M28 = 0xfffffff, M21 = 0x1fffff;
const MIN_SCORE = -SIZE / 2 + 3;
const BOARD_LO = 63 | (63 << 7) | (63 << 14) | (63 << 21), BOARD_HI = 63 | (63 << 7) | (63 << 14);
const BOTTOM_LO = 1 | (1 << 7) | (1 << 14) | (1 << 21), BOTTOM_HI = 1 | (1 << 7) | (1 << 14);
const ORDER = [3, 2, 4, 1, 5, 0, 6]; // center first
const colLo = (c: number) => (c < 4 ? 63 << (7 * c) : 0);
const colHi = (c: number) => (c < 4 ? 0 : 63 << (7 * (c - 4)));

// Two-word shifts (s <= 24) write into (aLo, aHi).
let aLo = 0, aHi = 0;
function shl(lo: number, hi: number, s: number) {
  aHi = ((hi << s) | (lo >>> (28 - s))) & M21;
  aLo = (lo << s) & M28;
}
function shr(lo: number, hi: number, s: number) {
  aLo = (lo >>> s) | ((hi << (28 - s)) & M28);
  aHi = hi >>> s;
}

function popcount(x: number) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Empty cells that would complete four for the stones in p. Result in (wLo, wHi).
let wLo = 0, wHi = 0;
function winningCells(pLo: number, pHi: number, mLo: number, mHi: number) {
  shl(pLo, pHi, 1); let xLo = aLo, xHi = aHi;
  shl(pLo, pHi, 2); xLo &= aLo; xHi &= aHi;
  shl(pLo, pHi, 3);
  let rLo = xLo & aLo, rHi = xHi & aHi; // vertical

  for (const s of [7, 6, 8]) { // horizontal, both diagonals
    shl(pLo, pHi, s); xLo = aLo; xHi = aHi;
    shl(pLo, pHi, 2 * s); xLo &= aLo; xHi &= aHi;
    shl(pLo, pHi, 3 * s); rLo |= xLo & aLo; rHi |= xHi & aHi;
    shr(pLo, pHi, s); rLo |= xLo & aLo; rHi |= xHi & aHi;
    shr(pLo, pHi, s); xLo = aLo; xHi = aHi;
    shr(pLo, pHi, 2 * s); xLo &= aLo; xHi &= aHi;
    shl(pLo, pHi, s); rLo |= xLo & aLo; rHi |= xHi & aHi;
    shr(pLo, pHi, 3 * s); rLo |= xLo & aLo; rHi |= xHi & aHi;
  }
  wLo = rLo & (BOARD_LO ^ mLo);
  wHi = rHi & (BOARD_HI ^ mHi);
}

// Transposition table: upper bounds, keyed by the unique position key cur + mask.
const TT_SIZE = 2097143; // prime; ~19 MB, small enough for phones
const ttKey = new Float64Array(TT_SIZE);
const ttVal = new Int8Array(TT_SIZE);
const key = (cLo: number, cHi: number, mLo: number, mHi: number) => (cHi + mHi) * 2 ** 28 + cLo + mLo;

// Per-depth move buffers so the search doesn't allocate.
const bufLo = new Int32Array(SIZE * W), bufHi = new Int32Array(SIZE * W), bufScore = new Int32Array(SIZE * W);

// Early positions can take minutes to solve exactly (Pons uses an opening book
// for those), so searches run against a deadline.
const TIMEOUT = new Error("timeout");
let deadline = Infinity, nodes = 0;

// cur = stones of the player to move, mask = all stones, moves = stones played.
function negamax(cLo: number, cHi: number, mLo: number, mHi: number, moves: number, alpha: number, beta: number): number {
  if ((++nodes & 4095) === 0 && performance.now() > deadline) throw TIMEOUT;
  const pLo = (mLo + BOTTOM_LO) & BOARD_LO, pHi = (mHi + BOTTOM_HI) & BOARD_HI;
  winningCells(cLo ^ mLo, cHi ^ mHi, mLo, mHi); // opponent's winning cells
  const oLo = wLo, oHi = wHi;
  let nLo = pLo, nHi = pHi;
  const fLo = pLo & oLo, fHi = pHi & oHi; // forced blocks
  if (fLo | fHi) {
    if (popcount(fLo) + popcount(fHi) > 1) return -((SIZE - moves) >> 1); // two threats: lost
    nLo = fLo; nHi = fHi;
  }
  shr(oLo, oHi, 1); // never play directly below an opponent win
  nLo &= ~aLo; nHi &= ~aHi;
  if (!(nLo | nHi)) return -((SIZE - moves) >> 1);
  if (moves >= SIZE - 2) return 0;

  const min = -((SIZE - 2 - moves) >> 1);
  if (alpha < min) { alpha = min; if (alpha >= beta) return alpha; }
  let max = (SIZE - 1 - moves) >> 1;
  const k = key(cLo, cHi, mLo, mHi), slot = k % TT_SIZE;
  if (ttKey[slot] === k) max = ttVal[slot] + MIN_SCORE - 1;
  if (beta > max) { beta = max; if (alpha >= beta) return beta; }

  // Order moves by how many winning cells they create for us (insertion sort, stable).
  const base = moves * W;
  let n = 0;
  for (const c of ORDER) {
    const mvLo = nLo & colLo(c), mvHi = nHi & colHi(c);
    if (!(mvLo | mvHi)) continue;
    winningCells(cLo | mvLo, cHi | mvHi, mLo, mHi);
    const score = popcount(wLo) + popcount(wHi);
    let i = n++;
    for (; i > 0 && bufScore[base + i - 1] < score; i--) {
      bufLo[base + i] = bufLo[base + i - 1]; bufHi[base + i] = bufHi[base + i - 1]; bufScore[base + i] = bufScore[base + i - 1];
    }
    bufLo[base + i] = mvLo; bufHi[base + i] = mvHi; bufScore[base + i] = score;
  }

  for (let i = 0; i < n; i++) {
    const mvLo = bufLo[base + i], mvHi = bufHi[base + i];
    // play: switch perspective to the opponent
    const score = -negamax(cLo ^ mLo, cHi ^ mHi, mLo | mvLo, mHi | mvHi, moves + 1, -beta, -alpha);
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  ttKey[slot] = k;
  ttVal[slot] = alpha - MIN_SCORE + 1;
  return alpha;
}

// Exact score: positive = player to move wins (the sooner, the higher), 0 = draw.
function solve(cLo: number, cHi: number, mLo: number, mHi: number, moves: number) {
  winningCells(cLo, cHi, mLo, mHi);
  if ((wLo & ((mLo + BOTTOM_LO) & BOARD_LO)) | (wHi & ((mHi + BOTTOM_HI) & BOARD_HI))) return (SIZE + 1 - moves) >> 1;
  let min = -((SIZE - moves) >> 1), max = (SIZE + 1 - moves) >> 1;
  while (min < max) { // null-window binary search
    let med = min + Math.trunc((max - min) / 2);
    if (med <= 0 && Math.trunc(min / 2) < med) med = Math.trunc(min / 2);
    else if (med >= 0 && Math.trunc(max / 2) > med) med = Math.trunc(max / 2);
    const r = negamax(cLo, cHi, mLo, mHi, moves, med, med + 1);
    if (r <= med) max = r; else min = r;
  }
  return min;
}

// Moves that don't hand the opponent an immediate win, ordered best-first by how
// many winning cells they create. Returns the count, or -1 if the opponent has two
// threats (lost). Moves land in the per-depth buffers.
function orderedMoves(cLo: number, cHi: number, mLo: number, mHi: number, moves: number) {
  const pLo = (mLo + BOTTOM_LO) & BOARD_LO, pHi = (mHi + BOTTOM_HI) & BOARD_HI;
  winningCells(cLo ^ mLo, cHi ^ mHi, mLo, mHi);
  const oLo = wLo, oHi = wHi;
  let nLo = pLo, nHi = pHi;
  const fLo = pLo & oLo, fHi = pHi & oHi;
  if (fLo | fHi) {
    if (popcount(fLo) + popcount(fHi) > 1) return -1;
    nLo = fLo; nHi = fHi;
  }
  shr(oLo, oHi, 1);
  nLo &= ~aLo; nHi &= ~aHi;
  const base = moves * W;
  let n = 0;
  for (const c of ORDER) {
    const mvLo = nLo & colLo(c), mvHi = nHi & colHi(c);
    if (!(mvLo | mvHi)) continue;
    winningCells(cLo | mvLo, cHi | mvHi, mLo, mHi);
    const score = popcount(wLo) + popcount(wHi);
    let i = n++;
    for (; i > 0 && bufScore[base + i - 1] < score; i--) {
      bufLo[base + i] = bufLo[base + i - 1]; bufHi[base + i] = bufHi[base + i - 1]; bufScore[base + i] = bufScore[base + i - 1];
    }
    bufLo[base + i] = mvLo; bufHi[base + i] = mvHi; bufScore[base + i] = score;
  }
  return n;
}

// Fallback when the exact solve runs out of time: depth-limited negamax with a
// heuristic (own minus opponent's open winning cells, plus center control).
const WIN = 1000, CENTER_LO = 63 << 21;
function heuristic(cLo: number, cHi: number, mLo: number, mHi: number, moves: number, depth: number, alpha: number, beta: number): number {
  if ((++nodes & 4095) === 0 && performance.now() > deadline) throw TIMEOUT;
  winningCells(cLo, cHi, mLo, mHi);
  if ((wLo & ((mLo + BOTTOM_LO) & BOARD_LO)) | (wHi & ((mHi + BOTTOM_HI) & BOARD_HI))) return WIN - moves - 1;
  const n = orderedMoves(cLo, cHi, mLo, mHi, moves);
  if (n <= 0) return -(WIN - moves); // no safe move: opponent wins next turn
  if (moves >= SIZE - 2) return 0;
  if (depth === 0) {
    winningCells(cLo, cHi, mLo, mHi); const mine = popcount(wLo) + popcount(wHi);
    winningCells(cLo ^ mLo, cHi ^ mHi, mLo, mHi); const theirs = popcount(wLo) + popcount(wHi);
    return 3 * (mine - theirs) + popcount(cLo & CENTER_LO) - popcount((cLo ^ mLo) & CENTER_LO);
  }
  const base = moves * W;
  for (let i = 0; i < n; i++) {
    const score = -heuristic(cLo ^ mLo, cHi ^ mHi, mLo | bufLo[base + i], mHi | bufHi[base + i], moves + 1, depth - 1, -beta, -alpha);
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

// board: rows top-to-bottom, "." empty; `me` is the player to move.
export function bestMove(board: string[][], me: string, budgetMs = 4000) {
  let cLo = 0, cHi = 0, mLo = 0, mHi = 0, moves = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const v = board[r][c];
    if (v === ".") continue;
    const bit = 7 * (c % 4) + (H - 1 - r);
    const isLo = c < 4;
    moves++;
    if (isLo) mLo |= 1 << bit; else mHi |= 1 << bit;
    if (v === me) { if (isLo) cLo |= 1 << bit; else cHi |= 1 << bit; }
  }
  const pLo = (mLo + BOTTOM_LO) & BOARD_LO, pHi = (mHi + BOTTOM_HI) & BOARD_HI;
  const legal = ORDER.filter((c) => (pLo & colLo(c)) | (pHi & colHi(c)));
  const colOf = (lo: number, hi: number) => ORDER.find((c) => (lo & colLo(c)) | (hi & colHi(c)))!;

  winningCells(cLo, cHi, mLo, mHi);
  const win = legal.find((c) => (wLo & pLo & colLo(c)) | (wHi & pHi & colHi(c)));
  if (win !== undefined) return { column: win, exact: true, outcome: "win" };
  if (moves === 0) return { column: 3, exact: true, outcome: "win" }; // proven: center wins

  const start = performance.now();
  // Exact: solve each child; the transposition table carries over between them.
  try {
    deadline = start + budgetMs / 2;
    let best = legal[0], bestScore = -Infinity;
    for (const c of legal) {
      const score = -solve(cLo ^ mLo, cHi ^ mHi, mLo | (pLo & colLo(c)), mHi | (pHi & colHi(c)), moves + 1);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return { column: best, exact: true, outcome: bestScore > 0 ? "win" : bestScore < 0 ? "loss" : "draw" };
  } catch (e) {
    if (e !== TIMEOUT) throw e;
  }

  // Heuristic: iterative deepening until the rest of the budget is used.
  deadline = start + budgetMs;
  let best = legal[0], depth = 0;
  try {
    for (let d = 1; d <= SIZE - moves; d++) {
      const n = orderedMoves(cLo, cHi, mLo, mHi, moves);
      if (n <= 0) break; // every move loses; keep the fallback
      let alpha = -Infinity, choice = best;
      const base = moves * W, list = Array.from({ length: n }, (_, i) => [bufLo[base + i], bufHi[base + i]]);
      for (const [mvLo, mvHi] of list) {
        const score = -heuristic(cLo ^ mLo, cHi ^ mHi, mLo | mvLo, mHi | mvHi, moves + 1, d - 1, -Infinity, -alpha);
        if (score > alpha) { alpha = score; choice = colOf(mvLo, mvHi); }
      }
      best = choice; depth = d;
      if (Math.abs(alpha) >= WIN - SIZE) break; // forced result found
    }
  } catch (e) {
    if (e !== TIMEOUT) throw e;
  }
  return { column: best, exact: false, depth };
}
