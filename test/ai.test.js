import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, strToPos, moveToStr } from '../src/engine.js';
import { AI, evaluate } from '../src/ai.js';

// ---------------------------------------------------------------------------
// Helpers (same white-box setup idiom as engine.test.js)
// ---------------------------------------------------------------------------

const P = strToPos;
const idx = (x, y) => y * 8 + x;

function clearBoard(engine) {
  engine.layers = [new Array(64).fill(null)];
  engine.t = 0;
  engine.futureQueue = [];
}

let conjured = 0;
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

function fastForward(engine, n) {
  const wasSim = engine.simulation;
  engine.simulation = true;
  for (let i = 0; i < n; i++) engine.endTurn();
  engine.simulation = wasSim;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

test('evaluation: the starting position is symmetric (tempo only)', () => {
  const e = new Engine();
  assert.equal(evaluate(e), 10); // TEMPO_CP for the side to move
});

test('evaluation: material shows up from the right perspective', () => {
  const e = new Engine();
  e.layers[0][idx(3, 7)] = null; // remove the black queen
  const forWhite = evaluate(e); // white to move
  assert.ok(forWhite > 800, `white should be about a queen up, got ${forWhite}`);
});

// ---------------------------------------------------------------------------
// Search finds the game's tactics
// ---------------------------------------------------------------------------

test('AI finds a Time Chess mate in 1 (king walks in to cover the escape)', () => {
  // The engine test suite's proven mate pattern (bK a8, wK b6, wQ a7, deep
  // history) backed off one move: the white king starts on b5, and Kb5-b6
  // completes the net. The queen has covered a7 since t0, so the king's past
  // is already sealed.
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'b', 'a8t0');
  place(e, 'k', 'w', 'b5t0');
  place(e, 'q', 'w', 'a7t0');
  fastForward(e, 8); // t8: white to move
  const r = new AI({ depthLimit: 2 }).chooseMove(e);
  assert.equal(r.scoreText, '#1');
  assert.equal(e.attemptMove(r.move).ok, true);
  assert.equal(e.status, 'w-wins');
  assert.match(e.statusReason, /checkmated/);
});

test('AI takes a hanging queen', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'e1t0');
  place(e, 'k', 'b', 'e8t0');
  place(e, 'r', 'w', 'd1t0');
  place(e, 'q', 'b', 'd4t0');
  const r = new AI({ depthLimit: 2 }).chooseMove(e);
  assert.equal(moveToStr(r.move), 'd1t0d4t0');
  // rook-for-nothing after winning Q for R: white ends about a rook up
  assert.ok(r.score > 400, `should be about a rook up, got ${r.score}`);
});

test('AI saves an attacked queen', () => {
  const e = new Engine();
  clearBoard(e);
  place(e, 'k', 'w', 'a1t0');
  place(e, 'k', 'b', 'h8t0');
  place(e, 'q', 'w', 'd4t0');
  place(e, 'p', 'b', 'e5t0'); // attacks d4
  const r = new AI({ depthLimit: 2 }).chooseMove(e);
  assert.equal(e.attemptMove(r.move).ok, true);
  // after white's move, no black reply may capture a white queen
  for (const p of e.presentPieces('b')) {
    for (const m of e.getMoves(p)) {
      const tgt = e.pieceAtPos(m.to);
      assert.ok(!(tgt && tgt.color === 'w' && tgt.type === 'q'),
        `queen left en prise to ${moveToStr(m)}`);
    }
  }
});

test('AI does not walk its king into a Lost in Time suicide (perspective regression)', () => {
  // e1t0f1t1 sends the king one turn forward onto the square its own bishop
  // will occupy — the dissertation's playtest blunder. A sign error in
  // terminal scoring once made the search evaluate this as mate-in-1 FOR the
  // suicide, because a game that ends mid-move never hands the turn over.
  const e = new Engine();
  const r = new AI({ depthLimit: 2 }).chooseMove(e);
  assert.notEqual(moveToStr(r.move), 'e1t0f1t1');
  assert.ok(Math.abs(r.score) < 500, `opening should be near level, got ${r.scoreText}`);
});

// ---------------------------------------------------------------------------
// Playing interface
// ---------------------------------------------------------------------------

test('AI vs AI produces only legal moves', () => {
  const e = new Engine();
  const ai = new AI({ depthLimit: 1 });
  for (let i = 0; i < 6 && e.status === 'playing'; i++) {
    const r = ai.chooseMove(e);
    assert.ok(r, 'AI returned no move in a live position');
    const res = e.attemptMove(r.move);
    assert.equal(res.ok, true, `AI chose illegal move ${moveToStr(r.move)}: ${res.reason}`);
  }
});

test('AI returns null once the game is over', () => {
  const e = new Engine();
  assert.equal(e.attemptMove('e1t0e2t1').ok, true); // the playtest blunder
  assert.equal(e.attemptMove('a7t1a6t1').ok, true); // any reply ends it
  assert.equal(e.status, 'b-wins');
  assert.equal(new AI({ depthLimit: 1 }).chooseMove(e), null);
});

test('AI respects its time budget within tolerance', () => {
  const e = new Engine();
  const t0 = performance.now();
  const r = new AI({ timeLimitMs: 300 }).chooseMove(e);
  const ms = performance.now() - t0;
  assert.ok(r.move, 'must return a move');
  // depth 1 always completes, so allow generous slack over the budget
  assert.ok(ms < 3000, `took ${ms.toFixed(0)}ms against a 300ms budget`);
});
