#!/usr/bin/env node
/**
 * Rough engine benchmark: plays games of random legal moves and reports the
 * cost of the operations a UI actually performs (legalMoves + attemptMove,
 * which internally runs full check/mate/stalemate settlement per move).
 *
 *   node bench.js [moves-per-game] [games]
 */

import { Engine } from './src/engine.js';

const MOVES = Number(process.argv[2] ?? 60);
const GAMES = Number(process.argv[3] ?? 5);

let rngState = 42;
const rng = () => {
  // deterministic xorshift so runs are comparable
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
};

let totalMoves = 0;
let totalMs = 0;
let worstMs = 0;
let worstAt = null;

for (let g = 0; g < GAMES; g++) {
  const e = new Engine();
  for (let i = 0; i < MOVES && e.status === 'playing'; i++) {
    const pieces = e.presentPieces(e.currentSide);
    // shuffle, then take the first piece that has a legal move
    for (let j = pieces.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [pieces[j], pieces[k]] = [pieces[k], pieces[j]];
    }
    const t0 = performance.now();
    let move = null;
    for (const p of pieces) {
      const moves = e.legalMoves({ x: p.x, y: p.y, t: p.t });
      if (moves.length) { move = moves[Math.floor(rng() * moves.length)]; break; }
    }
    if (!move) break; // mate or stalemate already settled
    const res = e.attemptMove(move);
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`legalMoves offered an illegal move: ${res.reason}`);
    totalMoves++; totalMs += ms;
    if (ms > worstMs) { worstMs = ms; worstAt = `game ${g} turn ${e.t - 1}`; }
  }
  console.log(`game ${g}: reached turn ${e.t}, status ${e.status}`);
}

console.log(`\n${totalMoves} moves in ${totalMs.toFixed(0)} ms ` +
  `(avg ${(totalMs / totalMoves).toFixed(2)} ms/move, worst ${worstMs.toFixed(1)} ms at ${worstAt})`);
console.log('each move includes: legal-move generation for the clicked pieces, full move');
console.log('validation with check simulation, arrival settlement, and mate/stalemate search');
