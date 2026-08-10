#!/usr/bin/env node
/**
 * Watch the AI play Time Chess: AI vs AI, or AI vs random mover.
 *
 *   node aiplay.js [--white=ai|random] [--black=ai|random] [--ms=1000]
 *                  [--depth=N] [--moves=60] [--seed=42] [--quiet]
 *
 * Prints one line per move (search depth, score, node counts) plus the
 * engine's narration of arrivals, Lost in Time, steamrollering, and check.
 * Ends with the final board and a material count. Also reports how search
 * depth decays as the game (and therefore the state) grows — the numbers
 * behind AI-REPORT.md.
 */

import { Engine, moveToStr, COLOR_NAMES } from './src/engine.js';
import { AI, VALUES } from './src/ai.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
  if (!m) throw new Error(`Bad argument ${a} (try --white=ai --black=random --ms=1000)`);
  return [m[1], m[2] ?? true];
}));

const MS = Number(args.ms ?? 1000);
const MOVES = Number(args.moves ?? 60);
const QUIET = Boolean(args.quiet);
const players = { w: args.white ?? 'ai', b: args.black ?? 'ai' };

let rngState = Number(args.seed ?? 42);
const rng = () => {
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
};

function randomMove(engine) {
  const pieces = engine.presentPieces(engine.currentSide);
  for (let j = pieces.length - 1; j > 0; j--) {
    const k = Math.floor(rng() * (j + 1));
    [pieces[j], pieces[k]] = [pieces[k], pieces[j]];
  }
  for (const p of pieces) {
    const moves = engine.legalMoves({ x: p.x, y: p.y, t: p.t });
    if (moves.length) return moves[Math.floor(rng() * moves.length)];
  }
  return null;
}

function material(engine, color) {
  let sum = 0;
  for (const p of engine.presentPieces(color)) if (!p.sterile) sum += VALUES[p.type];
  for (const t of engine.futureQueue) if (t.color === color) sum += VALUES[t.type];
  return sum;
}

const engine = new Engine();
const ai = new AI(args.depth ? { depthLimit: Number(args.depth) } : { timeLimitMs: MS });
const depthLog = [];

for (let i = 0; i < MOVES && engine.status === 'playing'; i++) {
  const side = engine.currentSide;
  let move;
  let note = '';
  if (players[side] === 'ai') {
    const r = ai.chooseMove(engine);
    if (!r) break;
    move = r.move;
    note = `depth ${r.depth}  score ${r.scoreText}  ` +
      `${((r.nodes + r.qnodes) / 1000).toFixed(1)}k nodes  ${(r.ms / 1000).toFixed(2)}s  ` +
      `pv ${r.pv.slice(0, 3).join(' ')}`;
    depthLog.push({ t: engine.t, depth: r.depth, ms: r.ms, nodes: r.nodes + r.qnodes });
  } else {
    move = randomMove(engine);
    if (!move) break;
    note = 'random';
  }
  const res = engine.attemptMove(move);
  if (!res.ok) throw new Error(`illegal move ${moveToStr(move)}: ${res.reason}`);
  console.log(`t${String(engine.t - 1).padEnd(3)} ${side}  ${moveToStr(move).padEnd(14)} ${note}`);
  if (!QUIET) {
    for (const ev of res.events) {
      if (ev.type !== 'move') console.log(`         · ${ev.message}`);
    }
  }
}

console.log(`\n${engine.prettyPrint()}\n`);
console.log(`status: ${engine.status}${engine.statusReason ? ` (${engine.statusReason})` : ''}`);
console.log(`material: White ${material(engine, 'w')}  Black ${material(engine, 'b')}  ` +
  `(in transit: ${engine.futureQueue.map((p) => `${COLOR_NAMES[p.color]} ${p.type}`).join(', ') || 'none'})`);

if (depthLog.length) {
  const bucket = 10;
  console.log('\nAI search depth as the game grows:');
  for (let lo = 0; lo < depthLog.length; lo += bucket) {
    const rows = depthLog.slice(lo, lo + bucket);
    const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
    console.log(`  turns ${String(rows[0].t).padStart(3)}–${String(rows[rows.length - 1].t).padStart(3)}: ` +
      `avg depth ${avg((r) => r.depth).toFixed(1)}, ` +
      `avg ${(avg((r) => r.nodes) / 1000).toFixed(0)}k nodes, ` +
      `avg ${(avg((r) => r.ms) / 1000).toFixed(2)}s/move`);
  }
}
