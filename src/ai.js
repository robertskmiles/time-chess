/**
 * Time Chess AI — a deliberately bog-standard chess engine pointed at Time
 * Chess: iterative-deepening negamax with alpha-beta pruning, MVV-LVA +
 * killer + history move ordering, null-move pruning, a capture-only
 * quiescence search, and a handcrafted evaluation.
 *
 * Pure module, no dependencies; runs in browsers and Node, like the engine.
 * It never mutates the engine it is given — every state transition goes
 * through Engine.clone(), which the engine makes cheap (structural sharing).
 *
 * See AI-REPORT.md for how each standard chess-engine technique fares against
 * a game that was designed ("Be complex for computers", dissertation §design)
 * to resist exactly this approach — and which of them quietly die here.
 */

import { moveToStr } from './engine.js';

export const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

const MATE = 1_000_000; // mate scores are MATE - ply, so nearer mates win
const INF = 2_000_000;
const NOOP = () => {};
const TIMEUP = Symbol('search time exhausted');

// Evaluation weights (centipawns). Hand-guessed, untuned — see the report.
const MOBILITY_CP = 2; // per pseudo-legal move
const PAST_THREAT_CP = 8; // per enemy attack on a past self of a living piece
const KING_PAST_THREAT_CP = 12; // per attack on any past instance of a king
const TEMPO_CP = 10; // for the side to move
const IN_TRANSIT_FACTOR = 0.85; // material discount while in the future queue
const QSEARCH_DELTA_CP = 250; // delta-pruning margin

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Small centre bonus, 1..7: pieces gain a little for central squares. */
const centrality = (x, y) => Math.round(7 - Math.abs(x - 3.5) - Math.abs(y - 3.5));

function placement(p) {
  switch (p.type) {
    case 'p': // advancement (promotion is a queen for free) plus a touch of centre
      return (p.color === 'w' ? p.y - 1 : 6 - p.y) * 5 + centrality(p.x, p.y);
    case 'n': return centrality(p.x, p.y) * 2;
    case 'b': return centrality(p.x, p.y) * 2;
    case 'q': return centrality(p.x, p.y);
    default: return 0;
  }
}

/**
 * Static evaluation from the perspective of the side to move.
 *
 * Standard chess terms (material, placement, mobility, tempo) plus the two
 * terms Time Chess demands and chess has no concept of:
 *  - in-transit material: pieces in the future queue are discounted, since
 *    they can still be Lost in Time and do nothing for you until they land;
 *  - past exposure: an enemy move that lands on a *past* self of a piece
 *    whose lineage is still alive erases it up to the present, so attacks
 *    on the past are real threats — especially attacks on past kings, which
 *    are the raw material of Time Chess mating nets.
 */
export function evaluate(node) {
  const scores = { w: 0, b: 0 };
  const present = [];
  const alive = new Set(); // lineages that still have a living present/future self

  for (const p of node.layers[node.t]) {
    if (!p || p.sterile) continue;
    present.push(p);
    alive.add(p.id);
    scores[p.color] += VALUES[p.type] + placement(p);
  }
  for (const trav of node.futureQueue) {
    alive.add(trav.id);
    scores[trav.color] += Math.round(VALUES[trav.type] * IN_TRANSIT_FACTOR);
  }

  for (const p of present) {
    const moves = node.getMoves(p);
    scores[p.color] += moves.length * MOBILITY_CP;
    for (const m of moves) {
      if (m.to.t >= node.t) continue; // only attacks into the past
      const tgt = node.pieceAt(m.to.x, m.to.y, m.to.t);
      if (!tgt || tgt.color === p.color) continue;
      if (tgt.type === 'k') scores[p.color] += KING_PAST_THREAT_CP;
      else if (alive.has(tgt.id)) scores[p.color] += PAST_THREAT_CP;
    }
  }

  const side = node.currentSide;
  return scores[side] - scores[side === 'w' ? 'b' : 'w'] + TEMPO_CP;
}

// ---------------------------------------------------------------------------
// Search plumbing
// ---------------------------------------------------------------------------

/**
 * Score for a game the engine has already declared over, from `side`'s view.
 *
 * The perspective must come from search-ply parity, NOT node.currentSide:
 * when a game ends mid-move (a King Lost in Time during arrival settlement),
 * the engine skips endTurn(), so currentSide still names the mover — trusting
 * it scored king suicide as mate-in-1 for the suicide.
 */
function terminalScore(node, side, ply) {
  if (node.status === 'draw') return 0;
  const winner = node.status === 'w-wins' ? 'w' : 'b';
  return side === winner ? MATE - ply : -(MATE - ply);
}

const posKey = (p) => p.t * 64 + p.y * 8 + p.x;
const moveKey = (m) => posKey(m.from) * 65536 + posKey(m.to);

/** Can this node's window possibly recreate an earlier one? A repeat with
 *  period p spans p+7 >= 9 piece-preserving plies, so anything below a
 *  quiet run of 8 provably cannot repeat and skips the (pricey) window key. */
const repeatPossible = (node) => node.status === 'playing' && node.quietRun >= 8;

/**
 * Pseudo-legal moves for the side to move, with the filters checkMove would
 * apply anyway (no own-captures, kings are never captured). Full legality —
 * "does this leave me in check?" — is settled later by actually making the
 * move on a clone, since the clone is needed as the child node regardless.
 */
function pseudoMoves(node, capturesOnly = false) {
  const out = [];
  for (const piece of node.presentPieces(node.currentSide)) {
    for (const m of node.getMoves(piece)) {
      const victim = node.pieceAtPos(m.to);
      if (victim && (victim.color === piece.color || victim.type === 'k')) continue;
      if (capturesOnly && !victim) continue;
      out.push({ m, piece, victim });
    }
  }
  return out;
}

export class AI {
  constructor(opts = {}) {
    this.timeLimitMs = opts.timeLimitMs ?? 1000;
    this.maxDepth = opts.maxDepth ?? 32;
    this.depthLimit = opts.depthLimit ?? null; // fixed depth, no clock (tests)
    this.qDepthMax = opts.qDepth ?? 6;
    this.useNullMove = opts.nullMove ?? true;
  }

  /**
   * Pick a move. Returns null if the game is over or no legal move exists;
   * otherwise { move, score, scoreText, depth, pv, nodes, qnodes, ms }.
   */
  chooseMove(engine) {
    if (engine.status !== 'playing') return null;
    const t0 = now();
    this.nodes = 0;
    this.qnodes = 0;
    this.killers = [];
    this.history = new Map();
    this.pvTable = [];
    this.pathKeys = [];
    this.rootSide = engine.currentSide;

    const side = engine.currentSide;
    const root = [];
    for (const entry of pseudoMoves(engine)) {
      const child = this.makeChild(engine, entry.m);
      if (child.isInCheck(side)) continue;
      root.push({
        ...entry, child, repeat: repeatPossible(child),
        score: entry.victim ? VALUES[entry.victim.type] : 0,
      });
    }
    if (root.length === 0) return null;
    root.sort((a, b) => b.score - a.score);

    let best = null;
    const maxD = this.depthLimit ?? this.maxDepth;
    try {
      for (let d = 1; d <= maxD; d++) {
        // depth 1 always completes so there is always a move to return
        this.deadline = (d === 1 || this.depthLimit !== null) ? Infinity : t0 + this.timeLimitMs;
        let alpha = -INF;
        let bestThis = null;
        let pvThis = [];
        for (const r of root) {
          this.pvTable[1] = [];
          const s = -this.negamax(r.child, d - 1, -INF, -alpha, 1, r.repeat);
          r.score = s;
          if (bestThis === null || s > alpha) {
            alpha = s;
            bestThis = r;
            pvThis = [r.m, ...(this.pvTable[1] ?? [])];
          }
        }
        root.sort((a, b) => b.score - a.score);
        best = { move: bestThis.m, score: alpha, depth: d, pv: pvThis.map(moveToStr) };
        if (Math.abs(alpha) >= MATE - 10000) break; // a forced mate; deeper adds nothing
        if (this.depthLimit === null && now() - t0 > this.timeLimitMs) break;
      }
    } catch (e) {
      if (e !== TIMEUP) throw e; // partial iteration discarded, keep last full one
    }

    return {
      ...best,
      scoreText: scoreText(best.score),
      nodes: this.nodes,
      qnodes: this.qnodes,
      ms: now() - t0,
    };
  }

  /** Clone-and-apply: the only way search ever advances a position. */
  makeChild(node, m) {
    const child = node.clone();
    child.event = NOOP; // don't build narration strings inside the search
    child.applyMove(m);
    return child;
  }

  /** Side to move at a given search ply. Equals node.currentSide except at
   *  terminal nodes, where the engine may not have handed the turn over. */
  sideAt(ply) {
    return (ply & 1) === 0 ? this.rootSide : (this.rootSide === 'w' ? 'b' : 'w');
  }

  negamax(node, depth, alpha, beta, ply, repeatCandidate = false) {
    if ((++this.nodes & 1023) === 0 && now() > this.deadline) throw TIMEUP;
    const side = this.sideAt(ply);
    if (node.status !== 'playing') return terminalScore(node, side, ply);
    if (node.clockRun >= 100) return 0; // the fifty-move rule will end it here

    // Repetition scores as the draw the rules now make it. Only a quiet,
    // material-preserving move can recreate an earlier window, so only those
    // nodes pay for a key; matches count against the real game's turns and
    // against this search path's ancestors.
    this.pathKeys.length = ply; // discard sibling-branch leftovers
    if (repeatCandidate) {
      const key = node.windowKey();
      if (node.windowKeys.includes(key) || this.pathKeys.includes(key)) return 0;
      this.pathKeys[ply] = key;
    }

    if (depth <= 0) return this.qsearch(node, alpha, beta, ply, this.qDepthMax);

    this.pvTable[ply] = [];
    const inCheck = node.isInCheck(side);

    // Null-move pruning: give the opponent a free ply (in Time Chess a "pass"
    // is well-defined: settle arrivals, then just let the world propagate one
    // turn). If they still can't hurt us enough to reach beta, prune.
    if (this.useNullMove && !inCheck && depth >= 3 && Math.abs(beta) < MATE - 10000) {
      const nul = node.clone();
      nul.event = NOOP;
      nul.processFutureArrivals();
      if (nul.status === 'playing') nul.endTurn();
      const s = -this.negamax(nul, depth - 3, -beta, -beta + 1, ply + 1);
      if (s >= beta) return s;
    }

    const moves = this.orderMoves(node, pseudoMoves(node), ply);
    let legal = 0;
    let best = -INF;
    for (const entry of moves) {
      const child = this.makeChild(node, entry.m);
      if (child.isInCheck(side)) continue; // illegal: leaves mover in check
      legal++;
      this.pvTable[ply + 1] = [];
      const s = -this.negamax(child, depth - 1, -beta, -alpha, ply + 1, repeatPossible(child));
      if (s > best) best = s;
      if (s > alpha) {
        alpha = s;
        this.pvTable[ply] = [entry.m, ...(this.pvTable[ply + 1] ?? [])];
        if (alpha >= beta) {
          this.rememberCutoff(entry, depth, ply);
          break;
        }
      }
    }
    if (legal === 0) return inCheck ? -(MATE - ply) : 0; // mate or stalemate
    return best;
  }

  /**
   * Quiescence: stand pat on the static eval, then chase captures only (all
   * evasions when in check) so leaves are not evaluated mid-exchange.
   * Note this settles *present and backward* captures; forward time travel
   * is never examined here — see the report on the horizon problem.
   */
  qsearch(node, alpha, beta, ply, qleft) {
    if ((++this.qnodes & 1023) === 0 && now() > this.deadline) throw TIMEUP;
    const side = this.sideAt(ply);
    if (node.status !== 'playing') return terminalScore(node, side, ply);
    if (node.clockRun >= 100) return 0; // the fifty-move rule will end it here
    this.pvTable[ply] = [];

    const inCheck = node.isInCheck(side);
    let standPat = -INF;
    if (!inCheck) {
      standPat = evaluate(node);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
      if (qleft <= 0) return standPat;
    } else if (qleft <= -2) {
      return evaluate(node); // check chain ran away; give up on precision
    }

    const moves = this.orderMoves(node, pseudoMoves(node, !inCheck), ply);
    let legal = 0;
    let best = standPat;
    for (const entry of moves) {
      if (!inCheck && entry.victim
        && standPat + VALUES[entry.victim.type] + QSEARCH_DELTA_CP <= alpha) continue;
      const child = this.makeChild(node, entry.m);
      if (child.isInCheck(side)) continue;
      legal++;
      const s = -this.qsearch(child, -beta, -alpha, ply + 1, qleft - 1);
      if (s > best) best = s;
      if (s > alpha) {
        alpha = s;
        if (alpha >= beta) break;
      }
    }
    if (inCheck && legal === 0) return -(MATE - ply); // checkmated
    return best;
  }

  /** MVV-LVA for captures (past captures included — a past victim is a whole
   *  lineage), then killers, then history. Forward hops sort last: they have
   *  no immediate victim, which suits their speculative nature. */
  orderMoves(node, moves, ply) {
    const killers = this.killers[ply] ?? [];
    for (const entry of moves) {
      if (entry.victim) {
        entry.order = 1e8 + VALUES[entry.victim.type] * 100 - VALUES[entry.piece.type] / 10;
      } else {
        const key = moveKey(entry.m);
        if (key === killers[0]) entry.order = 9e7;
        else if (key === killers[1]) entry.order = 8.9e7;
        else entry.order = this.history.get(key) ?? 0;
      }
    }
    return moves.sort((a, b) => b.order - a.order);
  }

  rememberCutoff(entry, depth, ply) {
    if (entry.victim) return; // only quiet moves feed killers/history
    const key = moveKey(entry.m);
    const k = (this.killers[ply] ??= []);
    if (k[0] !== key) { k[1] = k[0]; k[0] = key; }
    this.history.set(key, (this.history.get(key) ?? 0) + depth * depth);
  }
}

/** One-shot convenience: bestMove(engine, {timeLimitMs: 2000}). */
export function bestMove(engine, opts = {}) {
  return new AI(opts).chooseMove(engine);
}

export function scoreText(score) {
  if (score >= MATE - 10000) return `#${Math.ceil((MATE - score) / 2)}`;
  if (score <= -(MATE - 10000)) return `#-${Math.ceil((MATE + score) / 2)}`;
  return (score >= 0 ? '+' : '') + (score / 100).toFixed(2);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
