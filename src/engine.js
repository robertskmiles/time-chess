/**
 * Time Chess engine — a modern re-implementation of the 2011 G53IDS project's
 * TimeChessEngine.py / pieces.py.
 *
 * Pure rules engine: no I/O, no dependencies. Runs in browsers and Node.
 *
 * The game state is a growable stack of 8x8 board layers, one per turn.
 * Piece objects are treated as immutable: every change to a piece produces a
 * new object, so cloning a whole game for move simulation only has to copy
 * the layer arrays, not the pieces (structural sharing).
 *
 * Piece: { id, type, color, x, y, t, age, moved, sterile }
 *   id      — lineage identity; every instance of one in-game piece shares it
 *   age     — personal time: how many turns the piece has lived through
 *   moved   — has this lineage ever been commanded to move (pawn double-step)
 *   sterile — departed to the future; blocks its square but never propagates
 */

export const FILES = 'abcdefgh';
export const PIECE_NAMES = { p: 'Pawn', r: 'Rook', n: 'Knight', b: 'Bishop', q: 'Queen', k: 'King' };
export const COLOR_NAMES = { w: 'White', b: 'Black' };

// ---------------------------------------------------------------------------
// Notation (TCECP position/move notation, e.g. "c6t1", "a2t0a4t0")
// ---------------------------------------------------------------------------

export function posToStr({ x, y, t }) {
  return `${FILES[x]}${y + 1}t${t}`;
}

export function strToPos(s) {
  const m = /^([a-h])([1-8])t(\d+)$/.exec(s);
  if (!m) throw new Error(`Bad position notation: ${JSON.stringify(s)}`);
  return { x: FILES.indexOf(m[1]), y: Number(m[2]) - 1, t: Number(m[3]) };
}

export function moveToStr({ from, to }) {
  return posToStr(from) + posToStr(to);
}

export function strToMove(s) {
  const m = /^([a-h][1-8]t\d+)([a-h][1-8]t\d+)$/.exec(s);
  if (!m) throw new Error(`Bad move notation: ${JSON.stringify(s)}`);
  return { from: strToPos(m[1]), to: strToPos(m[2]) };
}

const samePos = (a, b) => a.x === b.x && a.y === b.y && a.t === b.t;

/**
 * Parse a move typed by a human, resolved against the current position.
 * Accepted forms:
 *   - full TCECP:        "a2t0a4t0"
 *   - coordinate:        "e2e4", "e2-e4", "d2xe3"  (times default to now)
 *   - standard algebraic: "e4", "Nf3", "exd5", "Nbd2", "R1a3"
 * A destination in another turn takes a t suffix, absolute ("Nf3t2") or
 * relative to the present ("Nf3t+2"). Case-insensitive, except that a leading
 * lowercase "b" reads as the b-file first and as the Bishop if no pawn move
 * matches. Check marks (+, #) and promotion suffixes (=Q) are ignored —
 * promotion is automatic.
 *
 * Returns {ok:true, move} or {ok:false, reason}. Algebraic forms only ever
 * resolve to fully legal moves; coordinate forms are returned as written and
 * left to checkMove, whose failure messages explain what went wrong.
 */
export function parseMoveInput(engine, raw) {
  const fail = (reason) => ({ ok: false, reason });
  let s = raw.replace(/\s+/g, '');
  s = s.replace(/[+#!?]+$/, '').replace(/=[qnrb]$/i, '');
  if (!s) return fail('Type a move first');
  if (/^[o0](-?[o0])+$/i.test(s)) return fail('There is no castling in Time Chess');
  if (engine.status !== 'playing') return fail(`The game is over (${engine.statusReason})`);

  const sq = (fr) => ({ x: FILES.indexOf(fr[0]), y: Number(fr[1]) - 1 });
  const time = (tok) => (tok === undefined ? engine.t
    : /^[+-]/.test(tok) ? engine.t + Number(tok) : Number(tok));

  // Coordinate forms, with or without explicit times.
  let m = /^([a-h][1-8])(?:t([+-]?\d+))?[-x:>]?([a-h][1-8])(?:t([+-]?\d+))?$/
    .exec(s.toLowerCase());
  if (m) {
    return { ok: true, move: {
      from: { ...sq(m[1]), t: time(m[2]) },
      to: { ...sq(m[3]), t: time(m[4]) },
    } };
  }

  // Algebraic. A leading lowercase "b" could name the b-file or the Bishop;
  // try the pawn reading first and fall back to the Bishop.
  const readings = [];
  if (/^[KQRNkqrnB]/.test(s)) readings.push({ type: s[0].toLowerCase(), rest: s.slice(1) });
  else readings.push({ type: 'p', rest: s });
  if (s[0] === 'b') readings.push({ type: 'b', rest: s.slice(1) });
  let shaped = null; // first reading that at least looked like a move
  for (const { type, rest } of readings) {
    m = /^([a-h]?)([1-8]?)[x:]?([a-h][1-8])(?:t([+-]?\d+))?$/.exec(rest.toLowerCase());
    if (!m) continue;
    const to = { ...sq(m[3]), t: time(m[4]) };
    if (!shaped) shaped = { type, to };
    const matches = [];
    for (const p of engine.presentPieces(engine.currentSide)) {
      if (p.type !== type) continue;
      if (m[1] && p.x !== FILES.indexOf(m[1])) continue;
      if (m[2] && p.y !== Number(m[2]) - 1) continue;
      for (const mv of engine.legalMoves({ x: p.x, y: p.y, t: p.t })) {
        if (samePos(mv.to, to)) matches.push(mv);
      }
    }
    if (matches.length === 1) return { ok: true, move: matches[0] };
    if (matches.length > 1) {
      return fail(`Ambiguous — ${matches.map(moveToStr).join(', ')} all match; ` +
        'name the piece’s file or rank too (e.g. Nbd2, R1a3)');
    }
  }
  if (shaped) {
    return fail(`No ${PIECE_NAMES[shaped.type]} of yours can legally move to ${posToStr(shaped.to)}`);
  }
  return fail(`Could not read ${JSON.stringify(raw.trim())} as a move — ` +
    'try "e4", "Nf3", "e2e4", or full notation like "a2t0a4t0"');
}
const idx = (x, y) => y * 8 + x;
const encodePos = (x, y, t) => t * 64 + y * 8 + x;

// ---------------------------------------------------------------------------
// Movement direction tables: chess moves extruded into the time dimension.
// Every entry is [dx, dy, dt].
// ---------------------------------------------------------------------------

const ROOK_DIRS = [
  [0, 0, 1], [0, 0, -1],
  [0, 1, 0], [0, -1, 0],
  [1, 0, 0], [-1, 0, 0],
];

// Two orthogonal directions, equal distance: all 12 two-axis diagonals.
const BISHOP_DIRS = [
  [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
  [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
  [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
];

const QUEEN_DIRS = [...ROOK_DIRS, ...BISHOP_DIRS]; // 18

// 2 in one dimension, 1 in another: 24 jumps.
const KNIGHT_JUMPS = [];
for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) { // dimension pairs (x,y), (x,t), (y,t)
  for (const [da, db] of [[1, 2], [2, 1]]) {
    for (const sa of [1, -1]) {
      for (const sb of [1, -1]) {
        const v = [0, 0, 0];
        v[a] = da * sa;
        v[b] = db * sb;
        KNIGHT_JUMPS.push(v);
      }
    }
  }
}

const KING_STEPS = QUEEN_DIRS; // same 18 directions, distance 1

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {(object|null)[][]} layers[t][y*8+x] */
    this.layers = [startingLayer()];
    this.t = 0;
    this.futureQueue = []; // travellers, in departure order
    this.status = 'playing'; // 'playing' | 'w-wins' | 'b-wins' | 'draw'
    this.statusReason = '';
    this.simulation = false;
    this.events = [];
    this.windowKeys = []; // one windowKey() per completed real turn (repetition rule)
    this.quietRun = 0; // consecutive piece-preserving moves (repetition gate)
    this.clockRun = 0; // like quietRun but pawn moves also reset it (50-move rule)
  }

  get currentSide() {
    return this.t % 2 === 0 ? 'w' : 'b';
  }

  /** Cheap deep-enough copy for move simulation: layer arrays are copied,
   *  piece objects are shared (they are never mutated). */
  clone() {
    const e = Object.create(Engine.prototype);
    e.layers = this.layers.map((l) => l.slice());
    e.t = this.t;
    e.futureQueue = this.futureQueue.slice();
    e.status = this.status;
    e.statusReason = this.statusReason;
    e.simulation = true;
    e.events = [];
    e.windowKeys = this.windowKeys.slice();
    e.quietRun = this.quietRun;
    e.clockRun = this.clockRun;
    return e;
  }

  event(type, message, data = {}) {
    this.events.push({ type, message, ...data });
  }

  /** Piece at a position, or null. Out-of-range and not-yet-existing future
   *  layers read as empty (matching the original's semantics: the future is
   *  undetermined, so nothing blocks there at declaration time). */
  pieceAt(x, y, t) {
    if (x < 0 || x > 7 || y < 0 || y > 7 || t < 0) return null;
    const layer = this.layers[t];
    return layer ? layer[idx(x, y)] : null;
  }

  pieceAtPos(pos) {
    return this.pieceAt(pos.x, pos.y, pos.t);
  }

  /** All pieces in the present (top) layer, optionally filtered by color. */
  presentPieces(color = null) {
    const out = [];
    for (const p of this.layers[this.t]) {
      if (p && (color === null || p.color === color)) out.push(p);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Move generation (pseudo-legal, as the original getMoves)
  // -------------------------------------------------------------------------

  getMoves(piece) {
    switch (piece.type) {
      case 'r': return this.slideMoves(piece, ROOK_DIRS);
      case 'b': return this.slideMoves(piece, BISHOP_DIRS);
      case 'q': return this.slideMoves(piece, QUEEN_DIRS);
      case 'n': return this.jumpMoves(piece, KNIGHT_JUMPS);
      case 'k': return this.jumpMoves(piece, KING_STEPS);
      case 'p': return this.pawnMoves(piece);
      default: throw new Error(`Unknown piece type ${piece.type}`);
    }
  }

  slideMoves(piece, dirs) {
    const from = { x: piece.x, y: piece.y, t: piece.t };
    const moves = [];
    for (const [dx, dy, dt] of dirs) {
      let { x, y, t } = from;
      for (let i = 0; i < 7; i++) { // up to 7 steps, as in chess
        x += dx; y += dy; t += dt;
        if (x < 0 || x > 7 || y < 0 || y > 7 || t < 0) break;
        const occ = this.pieceAt(x, y, t);
        if (occ === null) {
          moves.push({ from, to: { x, y, t } });
        } else {
          if (occ.color !== piece.color) moves.push({ from, to: { x, y, t } });
          break;
        }
      }
    }
    return moves;
  }

  jumpMoves(piece, offsets) {
    const from = { x: piece.x, y: piece.y, t: piece.t };
    const moves = [];
    for (const [dx, dy, dt] of offsets) {
      const x = from.x + dx, y = from.y + dy, t = from.t + dt;
      if (x < 0 || x > 7 || y < 0 || y > 7 || t < 0) continue;
      const occ = this.pieceAt(x, y, t);
      if (occ === null || occ.color !== piece.color) {
        moves.push({ from, to: { x, y, t } });
      }
    }
    return moves;
  }

  pawnMoves(piece) {
    const from = { x: piece.x, y: piece.y, t: piece.t };
    const fwd = piece.color === 'w' ? 1 : -1;
    const moves = [];

    // Forward in space: 1 step if empty, 2 if unmoved and both empty.
    const y1 = from.y + fwd, y2 = from.y + 2 * fwd;
    if (y1 >= 0 && y1 <= 7 && this.pieceAt(from.x, y1, from.t) === null) {
      moves.push({ from, to: { x: from.x, y: y1, t: from.t } });
      if (!piece.moved && y2 >= 0 && y2 <= 7 && this.pieceAt(from.x, y2, from.t) === null) {
        moves.push({ from, to: { x: from.x, y: y2, t: from.t } });
      }
    }

    // Forward in time: 1 step if empty, 2 if unmoved and both empty.
    // (Occupancy of future layers is undetermined at declaration time; the
    // Lost in Time rule settles it on arrival.)
    if (this.pieceAt(from.x, from.y, from.t + 1) === null) {
      moves.push({ from, to: { x: from.x, y: from.y, t: from.t + 1 } });
      if (!piece.moved && this.pieceAt(from.x, from.y, from.t + 2) === null) {
        moves.push({ from, to: { x: from.x, y: from.y, t: from.t + 2 } });
      }
    }

    // Captures in space: diagonally forward, only onto an enemy piece.
    for (const dx of [1, -1]) {
      const x = from.x + dx;
      if (x < 0 || x > 7 || y1 < 0 || y1 > 7) continue;
      const occ = this.pieceAt(x, y1, from.t);
      if (occ && occ.color !== piece.color) {
        moves.push({ from, to: { x, y: y1, t: from.t } });
      }
    }

    // Captures in time: diagonally forward in time. Whether there is anything
    // to capture cannot be known yet, so these are always offered and are
    // validated on arrival (nothing to capture => Lost in Time).
    for (const dx of [1, -1]) {
      const x = from.x + dx;
      if (x < 0 || x > 7) continue;
      moves.push({ from, to: { x, y: from.y, t: from.t + 1 } });
    }

    return moves;
  }

  // -------------------------------------------------------------------------
  // Legality
  // -------------------------------------------------------------------------

  /** Full legality check for a proposed move. Returns {ok, reason}. */
  checkMove(move) {
    const fail = (reason) => ({ ok: false, reason });

    if (this.status !== 'playing') {
      return fail(`The game is over (${this.statusReason})`);
    }
    const { from, to } = move;
    if (from.x < 0 || from.x > 7 || from.y < 0 || from.y > 7 || from.t < 0) {
      return fail(`${posToStr(from)} is not a location on the board`);
    }
    if (from.t !== this.t) {
      return fail(`It is turn ${this.t}; you cannot move a piece from turn ${from.t}`);
    }
    const piece = this.pieceAtPos(from);
    if (piece === null) {
      return fail(`There is no piece at ${posToStr(from)}`);
    }
    if (piece.color !== this.currentSide) {
      return fail(`The piece at ${posToStr(from)} is ${humanString(piece)}, but it is ${COLOR_NAMES[this.currentSide]}'s turn`);
    }
    if (!this.getMoves(piece).some((m) => samePos(m.to, to))) {
      return fail(`Not a possible move for the ${humanString(piece)} at ${posToStr(from)}`);
    }
    const target = this.pieceAtPos(to);
    if (target && target.color === piece.color) {
      return fail('Cannot take a piece of your own colour');
    }
    if (target && target.type === 'k') {
      return fail(`Cannot take the ${humanString(target)} at ${posToStr(to)}: kings are never captured, only checkmated`);
    }
    if (this.moveEndsInCheck(move, piece.color)) {
      return fail('That move ends with you in check');
    }
    return { ok: true, reason: 'Success' };
  }

  moveEndsInCheck(move, side) {
    const sim = this.clone();
    sim.applyMove(move);
    return sim.isInCheck(side);
  }

  /** Fully legal moves for the piece at a position (for UI highlighting).
   *  Unlike the original, which highlighted pseudo-legal moves and let the
   *  engine reject them on click, this filters out every illegal move. */
  legalMoves(pos) {
    if (this.status !== 'playing') return [];
    const piece = this.pieceAtPos(pos);
    if (!piece || piece.t !== this.t || piece.color !== this.currentSide) return [];
    return this.getMoves(piece).filter((m) => {
      const target = this.pieceAtPos(m.to);
      if (target && (target.color === piece.color || target.type === 'k')) return false;
      return !this.moveEndsInCheck(m, piece.color);
    });
  }

  /** Attempt a move (Move object or notation string).
   *  Returns {ok, reason?, events}. */
  attemptMove(move) {
    if (typeof move === 'string') move = strToMove(move);
    this.events = [];
    const check = this.checkMove(move);
    if (!check.ok) return { ok: false, reason: check.reason, events: this.events };
    this.applyMove(move);
    return { ok: true, events: this.events };
  }

  // -------------------------------------------------------------------------
  // Move execution. applyMove does NO validity checking (like __makeMove);
  // it must only be called with moves that passed checkMove.
  // -------------------------------------------------------------------------

  /** Pieces still in play: the present layer plus the future queue. This
   *  only ever decreases, which makes it the cheap gate for the repetition
   *  rule — a window can only repeat across piece-preserving moves. */
  pieceCount() {
    let n = this.futureQueue.length;
    for (const p of this.layers[this.t]) if (p && !p.sterile) n++;
    return n;
  }

  applyMove(move) {
    const piecesBefore = this.pieceCount();
    const { from, to } = move;
    const piece = this.layers[from.t][idx(from.x, from.y)];

    if (to.t === from.t) {
      // Ordinary chess move within the present layer.
      const target = this.layers[to.t][idx(to.x, to.y)];
      if (target) this.event('capture', `${humanString(piece)} takes ${humanString(target)} at ${posToStr(to)}`);
      this.layers[to.t][idx(to.x, to.y)] = { ...piece, x: to.x, y: to.y, moved: true };
      this.layers[from.t][idx(from.x, from.y)] = null;
      this.event('move', `${humanString(piece)} moves ${moveToStr(move)}`);
    } else if (to.t < from.t) {
      // Backward time travel.
      this.layers[from.t][idx(from.x, from.y)] = null;
      const dest = this.pieceAtPos(to);
      if (dest) {
        // Capturing in the past removes the victim's whole lineage from the
        // moment of capture to the present. (Consequences of its past actions
        // remain, per the rules.)
        this.event('pastCapture',
          `${humanString(piece)} travels back to ${posToStr(to)} and takes ${humanString(dest)}; ` +
          `all its later selves vanish from the timeline`);
        this.eraseLineage(dest);
      } else {
        this.event('move', `${humanString(piece)} travels back in time to ${posToStr(to)}`);
      }
      // The traveller sits braindead in its square, propagating up to the
      // present. If some turn already has that square occupied, the traveller
      // is steamrollered and ceases to exist from that point on.
      let age = piece.age + 1;
      for (let t = to.t; t <= this.t; t++) {
        const cell = idx(to.x, to.y);
        const occ = this.layers[t][cell];
        if (occ !== null) {
          this.event('steamroller',
            `${humanString(piece)} is steamrollered at ${posToStr({ x: to.x, y: to.y, t })} by ` +
            `${humanString(occ)} and is destroyed`);
          break;
        }
        this.layers[t][cell] = { ...piece, x: to.x, y: to.y, t, age, moved: true, sterile: false };
        age++;
      }
    } else {
      // Forward time travel: the piece departs (its present self stays on the
      // board as a sterile marker that blocks its square but has no future),
      // and a traveller waits in the future queue until its arrival turn.
      this.layers[from.t][idx(from.x, from.y)] = { ...piece, sterile: true };
      this.futureQueue.push({
        ...piece, x: to.x, y: to.y, t: to.t, age: piece.age + 1, moved: true, sterile: false,
      });
      this.event('move', `${humanString(piece)} departs for the future, due at ${posToStr(to)}`);
    }

    this.processFutureArrivals();
    const preserving = this.pieceCount() === piecesBefore;
    this.quietRun = preserving ? this.quietRun + 1 : 0;
    this.clockRun = preserving && piece.type !== 'p' ? this.clockRun + 1 : 0;

    if (this.status === 'playing') this.endTurn();
  }

  /**
   * Validate every queued forward move and land the travellers due this turn.
   *
   * Travellers are processed strictly in departure order (the rules'
   * "appearance order"). Each is validated at its moment of arrival against
   * the board as it stands then — including travellers that arrived just
   * before it. (The original iterated over the queue while removing from it,
   * which skipped entries, and placed arrivals by blind overwrite, which
   * could silently destroy same-coloured pieces and even kings.)
   */
  processFutureArrivals() {
    const queue = this.futureQueue;
    this.futureQueue = [];

    for (const trav of queue) {
      const parent = this.findParent(trav);
      if (parent === null) {
        // The piece was captured in the past before it could depart.
        this.event('neverHappened',
          `${humanString(trav)} was destroyed in the past; its move to ${posToStr(trav)} never happened`);
        continue;
      }

      let lost = null;
      if (!this.getMoves(parent).some((m) => samePos(m.to, trav))) {
        lost = 'its path has become blocked';
      } else if (trav.t === this.t) {
        const occ = this.pieceAt(trav.x, trav.y, trav.t);
        if (occ && occ.type === 'k') {
          // Rules clarification: kings are never captured, so an arrival onto
          // a square a king occupies is illegal. (The original silently
          // deleted the king here.)
          lost = 'a king occupies its destination, and kings are never captured';
        } else if (trav.type === 'p' && trav.x !== parent.x && (!occ || occ.color === trav.color)) {
          // A pawn moving diagonally through time must capture on arrival.
          // (Checked against the arrival layer; the original checked t-1.)
          lost = 'it was capturing diagonally through time but there is nothing there to capture';
        }
      }

      if (lost) {
        this.event('lostInTime', `${humanString(trav)} bound for ${posToStr(trav)} is Lost in Time: ${lost}`);
        if (trav.type === 'k') {
          this.endGame({ loser: trav.color, reason: `the ${COLOR_NAMES[trav.color]} King became Lost in Time` });
        }
        continue;
      }

      if (trav.t === this.t) {
        const occ = this.pieceAt(trav.x, trav.y, trav.t);
        if (occ) {
          this.event('capture',
            `${humanString(trav)} arrives from the past and takes ${humanString(occ)} at ${posToStr(trav)}`);
          this.eraseLineage(occ);
        } else {
          this.event('arrival', `${humanString(trav)} arrives from the past at ${posToStr(trav)}`);
        }
        this.layers[trav.t][idx(trav.x, trav.y)] = trav;
      } else {
        this.futureQueue.push(trav); // still in transit
      }
    }
  }

  /** The board instance one personal turn before this piece, or null. */
  findParent(piece) {
    for (let t = Math.min(this.t, this.layers.length - 1); t >= 0; t--) {
      for (const p of this.layers[t]) {
        if (p && p.id === piece.id && p.age === piece.age - 1) return p;
      }
    }
    return null;
  }

  /** Remove a piece and all its later selves (same lineage, age >= root's)
   *  from the board — the "captured in the past" rule. */
  eraseLineage(root) {
    for (let t = root.t; t <= this.t; t++) {
      const layer = this.layers[t];
      for (let i = 0; i < 64; i++) {
        const p = layer[i];
        if (p && p.id === root.id && p.age >= root.age) layer[i] = null;
      }
    }
  }

  /** Tick over to the next turn: propagate every non-sterile piece into a new
   *  top layer, hand the move to the other side, and settle check/mate. */
  endTurn() {
    const newLayer = new Array(64).fill(null);
    for (const p of this.layers[this.t]) {
      if (p && !p.sterile) {
        const child = makeChild(p);
        newLayer[idx(child.x, child.y)] = child;
      }
    }
    this.layers.push(newLayer);
    this.t++;

    if (!this.simulation && this.status === 'playing') this.evaluatePosition();
  }

  /**
   * Canonical key of everything that can still influence the game — the
   * complete Markov state. No move reaches more than 7 turns into the past
   * (slides are capped at 7, knights at 2, kings at 1, pawns never go back),
   * check only ever comes from present pieces, and lineage erasure starts at
   * the capture square; so layers older than t-7 are frozen scenery. The key
   * covers the last 8 layers, the future queue, and the side to move.
   *
   * Lineage ids are renumbered in scan order and ages are encoded relative
   * to the lineage's newest instance, so the key is invariant to *when* the
   * window occurs — two turns with identical keys are genuinely the same
   * game state, and the game tree from them is identical.
   */
  windowKey() {
    const lo = Math.max(0, this.t - 7);
    const lin = new Map(); // lineage id -> canonical ordinal
    const maxAge = new Map(); // lineage id -> newest age in the window
    const meet = (p) => {
      if (!lin.has(p.id)) lin.set(p.id, lin.size);
      if (!(maxAge.get(p.id) >= p.age)) maxAge.set(p.id, p.age);
    };
    for (let t = lo; t <= this.t; t++) for (const p of this.layers[t]) if (p) meet(p);
    for (const p of this.futureQueue) meet(p);

    // moved matters only for pawn lineages (double-step rights)
    const code = (p) => `${p.color}${p.type}${p.sterile ? '*' : ''}` +
      `${p.type === 'p' && !p.moved ? '^' : ''}${lin.get(p.id)}.${maxAge.get(p.id) - p.age}`;

    const parts = [String(this.t % 2)];
    for (let t = lo; t <= this.t; t++) {
      parts.push(this.layers[t].map((p) => (p ? code(p) : '')).join(','));
    }
    parts.push(this.futureQueue.map((p) => `${code(p)}@${p.x},${p.y},${p.t - this.t}`).join(';'));
    return parts.join('|');
  }

  /** Detect repetition, check, checkmate and stalemate for the side to move. */
  evaluatePosition() {
    // Draw by repetition: the third time the same 8-turn window (plus queue
    // and side to move) comes around, nothing new can ever happen — full
    // histories never repeat in Time Chess, but the reachable-state window
    // can, and that is the only repetition that means anything.
    const key = this.windowKey();
    let seen = 0;
    for (const k of this.windowKeys) if (k === key) seen++;
    this.windowKeys.push(key);
    if (seen >= 2) {
      this.event('repetition', 'The same position (all 8 reachable turns of it) has now occurred three times');
      this.endGame({ draw: true, reason: 'draw by threefold repetition of the reachable past' });
      return;
    }

    // Fifty-move rule backstop: repetition alone cannot adjudicate a dead
    // position (wandering kings never recreate an exact window on a board
    // this big), so mirror chess: 50 moves per side with no capture, no
    // loss to time, and no pawn move is a draw.
    if (this.clockRun >= 100) {
      this.event('fiftyMoves', 'Fifty moves by each side without a capture, a loss to time, or a pawn move');
      this.endGame({ draw: true, reason: 'draw by the fifty-move rule' });
      return;
    }

    const side = this.currentSide;
    const inCheck = this.isInCheck(side);
    if (this.hasLegalMove(side, inCheck)) {
      if (inCheck) this.event('check', `${COLOR_NAMES[side]} is in check`);
      return;
    }
    if (inCheck) {
      this.event('checkmate', `${COLOR_NAMES[side]} is checkmated`);
      this.endGame({ loser: side, reason: `${COLOR_NAMES[side]} is checkmated` });
    } else {
      this.event('stalemate', `${COLOR_NAMES[side]} has no legal moves: stalemate`);
      this.endGame({ draw: true, reason: 'stalemate' });
    }
  }

  /** Does `side` have any fully legal move? Bails out on the first one found.
   *  When escaping check, future moves by non-kings are skipped: removing
   *  your own piece from the present can never block or capture a threat. */
  hasLegalMove(side, inCheck) {
    for (const piece of this.presentPieces(side)) {
      for (const move of this.getMoves(piece)) {
        if (inCheck && move.to.t > this.t && piece.type !== 'k') continue;
        const target = this.pieceAtPos(move.to);
        // Must match checkMove: capturing your own piece or any king is not
        // legal, so neither counts as an escape. (The original counted these
        // and could miss a checkmate.)
        if (target && (target.color === side || target.type === 'k')) continue;
        if (!this.moveEndsInCheck(move, side)) return true;
      }
    }
    return false;
  }

  /**
   * Is `color` in check? A king is in check if any of its instances, in the
   * present or any past turn, can be reached by a move of an enemy piece in
   * the present (only present pieces can be commanded).
   */
  isInCheck(color) {
    const kingSquares = new Set();
    for (let t = 0; t <= this.t && t < this.layers.length; t++) {
      for (const p of this.layers[t]) {
        if (p && p.type === 'k' && p.color === color) kingSquares.add(encodePos(p.x, p.y, p.t));
      }
    }
    if (kingSquares.size === 0) return false;

    for (const threat of this.presentPieces()) {
      if (threat.color === color) continue;
      for (const m of this.getMoves(threat)) {
        if (kingSquares.has(encodePos(m.to.x, m.to.y, m.to.t))) return true;
      }
    }
    return false;
  }

  endGame({ winner = null, loser = null, draw = false, reason = '' }) {
    if (draw) this.status = 'draw';
    else if (winner === 'w' || loser === 'b') this.status = 'w-wins';
    else if (winner === 'b' || loser === 'w') this.status = 'b-wins';
    this.statusReason = reason;
    if (!this.simulation) {
      const outcome = this.status === 'draw' ? 'Draw'
        : this.status === 'w-wins' ? 'White wins' : 'Black wins';
      this.event('gameOver', `Game over: ${outcome} (${reason})`);
    }
  }

  // -------------------------------------------------------------------------
  // State export / debugging
  // -------------------------------------------------------------------------

  /** Plain-data snapshot of the whole game, convenient for UIs and protocols. */
  snapshot() {
    return {
      t: this.t,
      currentSide: this.currentSide,
      status: this.status,
      statusReason: this.statusReason,
      layers: this.layers.map((l) => l.filter(Boolean).map((p) => ({ ...p }))),
      futureQueue: this.futureQueue.map((p) => ({ ...p })),
    };
  }

  /** ASCII rendering of one layer (or the present), for tests and the CLI. */
  prettyPrint(t = this.t) {
    const lines = [`    _______________ ______Turn ${t}`];
    for (let y = 7; y >= 0; y--) {
      let row = `${y + 1}  `;
      for (let x = 0; x < 8; x++) {
        const p = this.pieceAt(x, y, t);
        row += '|' + (p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : '_');
      }
      lines.push(row + `|  ${y + 1}`);
    }
    lines.push('    a b c d e f g h');
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Piece helpers
// ---------------------------------------------------------------------------

export function humanString(piece) {
  return `${COLOR_NAMES[piece.color]} ${PIECE_NAMES[piece.type]}`;
}

/** The piece's self in the next turn. Pawns reaching the far rank come back
 *  as queens — with the same lineage id, so capturing the pawn in its past
 *  still erases the queen it became. */
export function makeChild(piece) {
  const type = (piece.type === 'p' && (piece.y === 0 || piece.y === 7)) ? 'q' : piece.type;
  return { ...piece, type, t: piece.t + 1, age: piece.age + 1 };
}

function makePiece(type, color, x, y) {
  return {
    id: `${color}${type}${FILES[x]}`, // e.g. "wra": White's a-file Rook
    type, color, x, y, t: 0, age: 0, moved: false, sterile: false,
  };
}

function startingLayer() {
  const layer = new Array(64).fill(null);
  const backRank = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let x = 0; x < 8; x++) {
    layer[idx(x, 0)] = makePiece(backRank[x], 'w', x, 0);
    layer[idx(x, 1)] = makePiece('p', 'w', x, 1);
    layer[idx(x, 6)] = makePiece('p', 'b', x, 6);
    layer[idx(x, 7)] = makePiece(backRank[x], 'b', x, 7);
  }
  return layer;
}
