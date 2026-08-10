import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Engine, strToPos, strToMove, posToStr, moveToStr, makeChild,
} from '../src/engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const P = strToPos;
const idx = (x, y) => y * 8 + x;

/** Piece at a notation position, or null. */
function at(engine, s) {
  return engine.pieceAtPos(P(s));
}

/** Empty the whole game back to a single bare layer. */
function clearBoard(engine) {
  engine.layers = [new Array(64).fill(null)];
  engine.t = 0;
  engine.futureQueue = [];
}

let conjured = 0;
/** Conjure a piece directly onto the board (white-box test setup). */
function place(engine, type, color, posStr, extra = {}) {
  const { x, y, t } = P(posStr);
  const piece = {
    id: `${color}${type}#${conjured++}`,
    type, color, x, y, t,
    age: extra.age ?? t,
    moved: extra.moved ?? false,
    sterile: false,
    ...extra,
  };
  engine.layers[t][idx(x, y)] = piece;
  return piece;
}

/** Advance n turns without anyone moving, skipping mate evaluation. */
function fastForward(engine, n) {
  const wasSim = engine.simulation;
  engine.simulation = true;
  for (let i = 0; i < n; i++) engine.endTurn();
  engine.simulation = wasSim;
}

function legalTargets(engine, posStr) {
  return engine.legalMoves(P(posStr)).map((m) => posToStr(m.to)).sort();
}

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

test('position notation round-trips', () => {
  for (const s of ['a1t0', 'h8t999', 'c6t1']) {
    assert.equal(posToStr(strToPos(s)), s);
  }
  assert.deepEqual(P('c6t1'), { x: 2, y: 5, t: 1 });
  assert.throws(() => strToPos('i0t9'));
  assert.throws(() => strToPos('a9t0'));
  assert.throws(() => strToPos('a1'));
});

test('move notation round-trips', () => {
  const m = strToMove('c6t1e8t1');
  assert.deepEqual(m, { from: { x: 2, y: 5, t: 1 }, to: { x: 4, y: 7, t: 1 } });
  assert.equal(moveToStr(m), 'c6t1e8t1');
  assert.throws(() => strToMove('c6t1'));
});

// ---------------------------------------------------------------------------
// Setup and basic queries (ports of the original TestGame / TestTCE)
// ---------------------------------------------------------------------------

test('new game: standard chess setup, white to move', () => {
  const e = new Engine();
  assert.equal(e.t, 0);
  assert.equal(e.currentSide, 'w');
  assert.equal(e.status, 'playing');
  assert.equal(e.layers.length, 1);
  assert.equal(e.presentPieces().length, 32);
  assert.equal(at(e, 'a2t0').type, 'p');
  assert.equal(at(e, 'e1t0').type, 'k');
  assert.equal(at(e, 'e8t0').color, 'b');
  assert.equal(at(e, 'a3t0'), null);
  // absurd positions read as empty rather than crashing
  assert.equal(e.pieceAt(-1, 0, 0), null);
  assert.equal(e.pieceAt(0, 0, 30), null);
});

test('checkMove rejects the illegal move families (port of test_checkMove)', () => {
  const e = new Engine();
  const bad = (mv) => assert.equal(e.checkMove(strToMove(mv)).ok, false);
  bad('e1t3a2t4'); // not this turn
  bad('a4t0a5t0'); // no piece there
  bad('a7t0a6t0'); // black piece on white's turn
  bad('a2t0b4t0'); // not a pawn move
  bad('b1t0d2t0'); // would take own piece
});

test('a legal present move advances the turn and ages the piece (port of test_attemptMove)', () => {
  const e = new Engine();
  const res = e.attemptMove('a2t0a4t0'); // TCECP notation accepted directly
  assert.equal(res.ok, true);
  assert.equal(e.t, 1);
  assert.equal(e.currentSide, 'b');
  assert.equal(at(e, 'a2t0'), null);
  const p0 = at(e, 'a4t0');
  const p1 = at(e, 'a4t1');
  assert.equal(p0.type, 'p');
  assert.equal(p0.age, 0); // moving in space costs no personal time
  assert.equal(p1.age, 1); // the propagated child has aged
  assert.equal(p0.id, p1.id); // one lineage
  assert.equal(p0.moved, true);
});

test('opening move counts include time travel', () => {
  const e = new Engine();
  // e-pawn: 2 spatial + 2 straight-time + 2 diagonal-time
  assert.equal(e.legalMoves(P('e2t0')).length, 6);
  // rook a1 is boxed in spatially but can still slide up to 7 turns forward
  assert.deepEqual(legalTargets(e, 'a1t0'),
    ['a1t1', 'a1t2', 'a1t3', 'a1t4', 'a1t5', 'a1t6', 'a1t7']);
  // pieces not in the present have no moves
  assert.deepEqual(e.legalMoves(P('a2t3')), []);
});

// ---------------------------------------------------------------------------
// Backward time travel
// ---------------------------------------------------------------------------

test('capturing in the past erases the whole later lineage (port of test_eraseLineage)', () => {
  const e = new Engine();
  fastForward(e, 5); // t = 5, black to move
  const victim = at(e, 'c2t5');
  place(e, 'b', 'b', 'c7t5'); // conjure a black bishop with a clear diagonal to the past
  const res = e.attemptMove('c7t5c2t0');
  assert.equal(res.ok, true);
  // the white c-pawn is wiped from every turn
  for (let t = 0; t < e.layers.length; t++) {
    for (const p of e.layers[t]) {
      assert.ok(!(p && p.id === victim.id), `victim still present at t${t}`);
    }
  }
  // the bishop propagates braindead from the capture point to the present
  for (let t = 0; t <= 6; t++) {
    assert.equal(at(e, `c2t${t}`).type, 'b', `bishop missing at c2t${t}`);
  }
  assert.ok(res.events.some((ev) => ev.type === 'pastCapture'));
});

test('a braindead traveller is steamrollered by any piece already in its square', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'h8t0');
  place(e, 'n', 'w', 'b1t0');
  fastForward(e, 2); // t = 2, white to move
  const blocker = place(e, 'r', 'b', 'b2t1', { age: 1 }); // occupies the square mid-propagation
  const res = e.attemptMove('b1t2b2t0'); // knight jump (0,+1,-2)
  assert.equal(res.ok, true);
  assert.equal(at(e, 'b2t0').type, 'n'); // arrived in the past
  assert.equal(at(e, 'b2t1').id, blocker.id); // blocker untouched
  assert.equal(at(e, 'b2t2'), null); // traveller destroyed from here on
  assert.equal(at(e, 'b2t3'), null); // and never reaches the present
  assert.ok(res.events.some((ev) => ev.type === 'steamroller'));
  // the knight's own past is untouched, but it is gone from the present
  assert.equal(at(e, 'b1t0').type, 'n');
  assert.equal(at(e, 'b1t1').type, 'n');
  assert.equal(at(e, 'b1t3'), null);
});

// ---------------------------------------------------------------------------
// Forward time travel
// ---------------------------------------------------------------------------

test('a forward move queues a traveller which arrives on schedule (port of test_future)', () => {
  const e = new Engine();
  e.layers[0][idx(3, 1)] = null; // clear d2 so the queen has a time-diagonal
  const q = at(e, 'd1t0');
  const res = e.attemptMove('d1t0d4t3');
  assert.equal(res.ok, true);
  assert.equal(e.futureQueue.length, 1);
  assert.equal(e.futureQueue[0].id, q.id);
  assert.equal(e.futureQueue[0].age, q.age + 1);
  assert.equal(e.snapshot().futureQueue.length, 1); // visible to UIs as a ghost
  assert.equal(at(e, 'd1t0').sterile, true); // departure marker blocks its square
  assert.equal(at(e, 'd1t1'), null); // ...but has no future
  fastForward(e, 2); // t = 3
  e.processFutureArrivals();
  assert.equal(at(e, 'd4t3').id, q.id); // the queen arrives
  assert.equal(e.futureQueue.length, 0);
});

test('a blocked forward move means Lost in Time (port of test_lost_in_time)', () => {
  const e = new Engine();
  const q = at(e, 'd1t0');
  // d2 pawn stays put, so its children will block the queen's path at d2t1
  assert.equal(e.attemptMove('d1t0d4t3').ok, true);
  fastForward(e, 2);
  e.processFutureArrivals();
  assert.equal(at(e, 'd4t3'), null); // never arrives
  assert.equal(e.futureQueue.length, 0); // and is gone from the queue
  assert.ok(!e.layers.flat().some((p) => p && p.id === q.id && !p.sterile && p.t > 0));
});

test('a piece captured in the past never makes its forward move', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'h8t0');
  place(e, 'r', 'w', 'e4t0');
  fastForward(e, 0);
  assert.equal(e.attemptMove('e4t0e4t3').ok, true); // white rook departs, due t3
  assert.equal(e.futureQueue.length, 1);
  // t=1, black to move: a black queen one time-diagonal step away captures the
  // rook's sterile departure self at e4t0 (-1, 0, -1).
  place(e, 'q', 'b', 'f4t1', { age: 1 });
  const res = e.attemptMove('f4t1e4t0');
  assert.equal(res.ok, true);
  assert.ok(res.events.some((ev) => ev.type === 'pastCapture'));
  // the queue is validated at the end of that same move: the rook's parent is
  // gone, so its forward move never happened
  assert.equal(e.futureQueue.length, 0);
  assert.ok(res.events.some((ev) => ev.type === 'neverHappened'));
  fastForward(e, 1); // reach t3 just to be sure nothing arrives
  e.processFutureArrivals();
  // e4t3 holds the black queen that propagated up from the past capture —
  // but no white rook ever arrives
  assert.equal(at(e, 'e4t3').type, 'q');
});

// ---------------------------------------------------------------------------
// Arrival processing — regression tests for the original's queue bugs
// ---------------------------------------------------------------------------

test('REGRESSION: two travellers due the same turn both arrive (queue was mutated while iterating)', () => {
  const e = new Engine();
  const wr = at(e, 'a1t0');
  const br = at(e, 'a8t0');
  assert.equal(e.attemptMove('a1t0a1t2').ok, true); // white rook -> t2
  assert.equal(e.attemptMove('a8t1a8t2').ok, true); // black rook -> t2
  assert.equal(e.futureQueue.length, 2);
  const res = e.attemptMove('h2t2h3t2'); // any white move at t2 lands them both
  assert.equal(res.ok, true);
  assert.equal(at(e, 'a1t2').id, wr.id);
  assert.equal(at(e, 'a8t2').id, br.id);
  assert.equal(e.futureQueue.length, 0);
  assert.equal(res.events.filter((ev) => ev.type === 'arrival').length, 2);
});

test('REGRESSION: same-square arrivals — first departed arrives first, enemy latecomer captures it', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'a8t0');
  place(e, 'q', 'w', 'e1t0');
  place(e, 'q', 'b', 'e6t0');
  fastForward(e, 0);
  assert.equal(e.attemptMove('e1t0e4t3').ok, true); // white queen departs first
  assert.equal(e.attemptMove('e6t1e4t3').ok, true); // black queen, same destination
  assert.equal(e.attemptMove('a1t2a2t2').ok, true); // waiting moves
  const res = e.attemptMove('a8t3a7t3'); // t=3: both arrive during this move
  assert.equal(res.ok, true);
  const survivor = at(e, 'e4t3');
  assert.equal(survivor.color, 'b'); // black departed later, arrives second, captures
  assert.ok(res.events.some((ev) => ev.type === 'capture'));
  // the white queen's arrival was real but its lineage was then erased
  assert.ok(res.events.some((ev) => ev.type === 'arrival'));
});

test('REGRESSION: same-square arrivals — same-colour latecomer is Lost in Time (was silently destroying the first)', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'a8t0');
  place(e, 'r', 'w', 'e4t0');
  place(e, 'b', 'w', 'd4t0');
  fastForward(e, 0);
  assert.equal(e.attemptMove('e4t0e4t3').ok, true); // white rook departs for e4t3
  assert.equal(e.attemptMove('a8t1b8t1').ok, true); // (not a7: the bishop covers it)
  assert.equal(e.attemptMove('d4t2e4t3').ok, true); // white bishop, same destination, departs later
  const res = e.attemptMove('b8t3a8t3'); // t=3: both arrive
  assert.equal(res.ok, true);
  const survivor = at(e, 'e4t3');
  assert.equal(survivor.type, 'r'); // first departed wins the square
  assert.ok(res.events.some((ev) => ev.type === 'lostInTime')); // bishop is lost
  assert.equal(e.status, 'playing');
});

test('REGRESSION: a traveller arriving on a king is Lost in Time — the king is never silently deleted', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'e5t0');
  place(e, 'n', 'w', 'e3t0');
  place(e, 'p', 'w', 'a2t0', { moved: true });
  fastForward(e, 0);
  assert.equal(e.attemptMove('e3t0e4t2').ok, true); // knight jump (0,+1,+2), due t2
  assert.equal(e.attemptMove('e5t1e4t1').ok, true); // black king steps onto the arrival square
  const res = e.attemptMove('a2t2a3t2'); // t=2: knight due to arrive
  assert.equal(res.ok, true);
  assert.equal(at(e, 'e4t2').type, 'k'); // king survives
  assert.equal(at(e, 'e4t2').color, 'b');
  assert.ok(res.events.some((ev) => ev.type === 'lostInTime'));
  assert.equal(e.status, 'playing');
});

// ---------------------------------------------------------------------------
// Pawns
// ---------------------------------------------------------------------------

test('REGRESSION: pawn capturing diagonally through time takes a piece that moved in (was checking the wrong layer)', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'h8t0');
  place(e, 'p', 'w', 'e4t0', { moved: true });
  place(e, 'r', 'b', 'f8t0');
  fastForward(e, 0);
  assert.equal(e.attemptMove('e4t0f4t1').ok, true); // pawn: diagonal into the future
  const res = e.attemptMove('f8t1f4t1'); // rook moves onto the square... and is taken on arrival
  assert.equal(res.ok, true);
  const pawn = at(e, 'f4t1');
  assert.equal(pawn.type, 'p');
  assert.equal(pawn.color, 'w');
  assert.ok(res.events.some((ev) => ev.type === 'capture'));
});

test('REGRESSION: pawn diagonal time move with nothing to capture on arrival is Lost in Time (no phantom capture)', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'h8t0');
  place(e, 'p', 'w', 'e4t0', { moved: true });
  place(e, 'r', 'b', 'f4t0'); // present at departure time...
  fastForward(e, 0);
  assert.equal(e.attemptMove('e4t0f4t1').ok, true);
  const res = e.attemptMove('f4t1f8t1'); // ...but the rook moves away before arrival
  assert.equal(res.ok, true);
  assert.equal(at(e, 'f4t1'), null); // no phantom pawn
  assert.ok(res.events.some((ev) => ev.type === 'lostInTime'));
});

test('pawn double-steps only while unmoved, in space and in time', () => {
  const e = new Engine();
  assert.ok(legalTargets(e, 'e2t0').includes('e4t0'));
  assert.ok(legalTargets(e, 'e2t0').includes('e2t2'));
  assert.equal(e.attemptMove('e2t0e3t0').ok, true);
  assert.equal(e.attemptMove('e7t1e6t1').ok, true);
  // the moved pawn has lost both double-steps
  const targets = legalTargets(e, 'e3t2');
  assert.ok(!targets.includes('e5t2'));
  assert.ok(!targets.includes('e3t4'));
  assert.ok(targets.includes('e4t2'));
  assert.ok(targets.includes('e3t3'));
});

test('a pawn reaching the far rank comes back as a queen of the same lineage', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'h1t0');
  const pawn = place(e, 'p', 'w', 'b7t0', { moved: true });
  fastForward(e, 0);
  assert.equal(e.attemptMove('b7t0b8t0').ok, true);
  assert.equal(at(e, 'b8t0').type, 'p'); // in its own turn it is still the pawn that moved
  const promoted = at(e, 'b8t1');
  assert.equal(promoted.type, 'q'); // its next self is a queen
  assert.equal(promoted.id, pawn.id); // same lineage: capture the pawn in the past, kill the queen
  e.eraseLineage(at(e, 'b8t0'));
  assert.equal(at(e, 'b8t1'), null);
});

// ---------------------------------------------------------------------------
// Check, checkmate, and game endings
// ---------------------------------------------------------------------------

test('check is detected in the present and the past, and past blocking works (port of test_isincheck)', () => {
  const e = new Engine();
  clearBoard(e);
  // history: black king sits at e8 in t0, then moves and is at d8 for t1..t3
  const bk = place(e, 'k', 'b', 'e8t0');
  place(e, 'k', 'w', 'a1t0');
  fastForward(e, 1);
  e.simulation = true;
  e.applyMove({ from: P('e8t1'), to: P('d8t1') }); // unchecked white-box move; ends turn -> t2
  e.simulation = false;
  fastForward(e, 1); // t3
  // a white queen in the present with a clear time-diagonal to e8t0
  place(e, 'q', 'w', 'e5t3');
  assert.equal(e.isInCheck('b'), true); // via the king's past instance at e8t0
  assert.equal(e.isInCheck('w'), false);
  // blocking the time-diagonal in the past lifts the check
  place(e, 'r', 'b', 'e7t1', { age: 1 });
  assert.equal(e.isInCheck('b'), false);
  assert.ok(bk); // silence unused warning
});

test('kings can never be captured — not in the present, the past, or by arrivals', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'e1t0');
  place(e, 'k', 'b', 'e8t0');
  place(e, 'r', 'b', 'e5t0');
  fastForward(e, 1); // t1: black to move
  const res = e.attemptMove('e5t1e1t1'); // rook tries to take the white king
  assert.equal(res.ok, false);
  assert.match(res.reason, /never captured/);
  // and the move is not even offered by legalMoves
  assert.ok(!legalTargets(e, 'e5t1').includes('e1t1'));
});

test('fools mate is not mate in Time Chess: the king escapes through time', () => {
  const e = new Engine();
  assert.equal(e.attemptMove('f2t0f3t0').ok, true);
  assert.equal(e.attemptMove('e7t1e5t1').ok, true);
  assert.equal(e.attemptMove('g2t2g4t2').ok, true);
  const res = e.attemptMove('d8t3h4t3'); // Qh4+, mate in ordinary chess
  assert.equal(res.ok, true);
  assert.equal(e.status, 'playing'); // not here
  assert.ok(res.events.some((ev) => ev.type === 'check'));
  assert.ok(!res.events.some((ev) => ev.type === 'checkmate'));
  // the king's escape: one step forward in time
  assert.ok(legalTargets(e, 'e1t4').includes('e1t5'));
});

test('a real Time Chess checkmate: present and past both covered', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'b', 'a8t0');
  place(e, 'k', 'w', 'b6t0');
  place(e, 'q', 'w', 'a7t0');
  fastForward(e, 9); // t9, black to move, deep enough history for time attacks
  e.evaluatePosition();
  assert.equal(e.status, 'w-wins');
  assert.match(e.statusReason, /checkmated/);
});

test('a king that becomes Lost in Time loses the game (the playtest bug from the dissertation)', () => {
  const e = new Engine();
  // the "clearly stupid move": king one step forward in time and one in space,
  // to the square directly above its own pawn
  assert.equal(e.attemptMove('e1t0e2t1').ok, true);
  const res = e.attemptMove('a7t1a6t1'); // black replies; the king's arrival fails
  assert.equal(res.ok, true);
  assert.equal(e.status, 'b-wins');
  assert.match(e.statusReason, /Lost in Time/);
  assert.ok(res.events.some((ev) => ev.type === 'lostInTime'));
  // no further moves are accepted
  assert.equal(e.attemptMove('a2t2a3t2').ok, false);
});

test('moves that end with you in check are illegal', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'e1t0');
  place(e, 'k', 'b', 'e8t0');
  place(e, 'r', 'w', 'e2t0');
  place(e, 'r', 'b', 'e5t0');
  fastForward(e, 0);
  // the white rook is pinned to the king by the black rook
  const res = e.attemptMove('e2t0a2t0');
  assert.equal(res.ok, false);
  assert.match(res.reason, /check/);
});

// ---------------------------------------------------------------------------
// Scale (the original crashed at its preallocated 500-turn cap)
// ---------------------------------------------------------------------------

test('games can run past 500 turns', () => {
  const e = new Engine();
  fastForward(e, 550);
  assert.equal(e.t, 550);
  const res = e.attemptMove('a2t550a3t550');
  assert.equal(res.ok, true);
  assert.equal(e.t, 551);
  assert.equal(e.layers.length, 552);
});

// ---------------------------------------------------------------------------
// Draw by repetition (2026 rules addition; see AI-REPORT.md)
// ---------------------------------------------------------------------------

test('a knight shuffle draws by threefold repetition of the 8-turn window', () => {
  const e = new Engine();
  const seq = [['b1', 'c3'], ['b8', 'c6'], ['c3', 'b1'], ['c6', 'b8']];
  let i = 0;
  while (e.status === 'playing' && e.t < 60) {
    const [from, to] = seq[i++ % 4];
    assert.equal(e.attemptMove(`${from}t${e.t}${to}t${e.t}`).ok, true);
  }
  assert.equal(e.status, 'draw');
  assert.match(e.statusReason, /repetition/);
  // full histories never repeat; only once the whole 8-layer window has
  // cycled three times may the draw land — not a move sooner
  assert.ok(e.t > 8, `triggered impossibly early, at t${e.t}`);
  assert.ok(e.t <= 20, `should trigger by the third window recurrence, got t${e.t}`);
});

test('normal development does not look like repetition', () => {
  const e = new Engine();
  const opening = ['e2t0e4t0', 'e7t1e5t1', 'g1t2f3t2', 'b8t3c6t3',
    'f1t4c4t4', 'f8t5c5t5', 'b1t6c3t6', 'g8t7f6t7'];
  for (const m of opening) assert.equal(e.attemptMove(m).ok, true);
  assert.equal(e.status, 'playing');
  // and the keys really were all distinct
  assert.equal(new Set(e.windowKeys).size, e.windowKeys.length);
});

test('a dead K vs K game is adjudicated (fifty-move rule or repetition)', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'e1t0', { moved: true });
  place(e, 'k', 'b', 'e8t0', { moved: true });
  let rngState = 11;
  const rng = () => {
    rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
    return (rngState >>> 0) / 0xffffffff;
  };
  let moves = 0;
  while (e.status === 'playing' && moves < 130) {
    // wander the kings with random spatial moves only (no time suicide)
    const king = e.presentPieces(e.currentSide)[0];
    const opts = e.legalMoves({ x: king.x, y: king.y, t: king.t })
      .filter((m) => m.to.t === e.t);
    assert.ok(opts.length > 0);
    assert.equal(e.attemptMove(opts[Math.floor(rng() * opts.length)]).ok, true);
    moves++;
  }
  assert.equal(e.status, 'draw');
  assert.match(e.statusReason, /fifty-move|repetition/);
});
