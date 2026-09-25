// Web Worker running the perfect solver in the browser, so it never blocks the
// page and costs no server CPU. Built to public/solver.js (`bun run build`).
import { bestMove } from "./solver";

self.onmessage = (e: MessageEvent<{ board: string[][] }>) => {
  const m = bestMove(e.data.board, "O");
  const outcome = { win: "O wins", draw: "draw", loss: "X wins" }[m.outcome!];
  postMessage({ column: m.column, detail: m.exact ? `solved: ${outcome} with perfect play` : `searched ${m.depth} moves ahead` });
};
