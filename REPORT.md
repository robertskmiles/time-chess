# Time Chess 2026: Re-implementation Report

*August 2026*

This report covers the re-implementation of the 2011 G53IDS dissertation
project "Time Chess" — a chess variant played on a stack of boards where each
layer is one turn, and pieces move through time as well as space. The original
ran on Python 2.6 + NumPy + VPython 5, a stack that has been unrunnable on a
normal system for well over a decade. The rewrite is a browser game with a
pure-JavaScript rules engine, living in this directory alongside the original
tree.

Sources used: the original code (`../code/`), and the design and
implementation chapters of the dissertation (`../dissertation/*.md`),
particularly *The Rules of Time Chess*, *Designing Backwards Time Travel*, and
the implementation notes on the future queue, lineage erasure, and the
"King Lost in Time" playtest bug.

---

## 1. What was kept

The game itself. The rules as written in the dissertation are implemented
faithfully — movement tables extruded into the time dimension, blocking
through time, the future queue and the Lost in Time rule, backward travel
with lineage erasure ("all occurrences of the piece from the time it is
captured to the present are removed... consequences remain unchanged"),
braindead pieces and steamrollering, check against past king instances, and
pawn promotion via the pieceId system so that capturing a pawn in its past
also kills the queen it became.

Also kept, deliberately:

- **The engine/interface split.** The dissertation makes a good case for it,
  and it survives here as a clean module boundary: `src/engine.js` is a pure
  model+controller with no I/O and no dependencies; `src/ui.js` is one view of
  it. `tcecp.js` still speaks the original's TCECP text protocol over
  stdin/stdout, so the 2011 interface contract is intact — a different UI (or
  a future AI player) can drive the engine exactly as before.
- **The piece-lineage system** (`pieceId` + `age`), which the dissertation
  correctly identifies as the key data structure. It is what makes "erase this
  piece from turn 12 onwards, but only the time-travelled copy of it" a
  one-liner. The rewrite keeps it under the names `id`/`age`.
- **The minimalist piece designs** — the same primitive-solid recipes (a pawn
  is a cone and a sphere) translated from VPython to Three.js geometry.
- **The red/blue stereo mode.** It was a good idea in 2011 and it still is;
  the `s` key toggles a Dubois anaglyph now instead of VPython's built-in.
- **Move notation** (`c6t1`, `c6t1e8t1`) and the TCECP message set.

## 2. What the rewrite runs on

- **Engine**: one ES module (`src/engine.js`), zero dependencies, identical in
  the browser and Node. All game logic — legality, simulation, the future
  queue, mate detection — lives here.
- **UI**: Three.js r170, vendored into `vendor/` (≈1.3 MB), imported via an
  import map. No build step, no package.json, no network access needed; the
  whole thing runs from any static file server, and will still run in twenty
  years the way the VPython original did not.
- **Tests**: Node's built-in `node:test` runner — `node --test
  test/engine.test.js`, 26 tests.

This is the most future-proof stack I could pick: plain standardized
JavaScript, one widely-mirrored rendering library pinned and vendored, and a
test runner that ships with the platform.

## 3. Bugs found in the original

Line numbers refer to `../code/`.

### 3.1 The future queue was mutated while being iterated
`TimeChessEngine.py:171-175` (arrivals) and `186-210` (validation) both do
`for p in self.futureQueue: ... self.futureQueue.remove(p)`. Removing the
current element of a Python list while iterating skips the next element. Two
travellers due to arrive in the same turn: the first arrives, the second is
silently skipped that turn — and since its arrival turn then never equals the
current turn again, it sits in the queue as a phantom forever. The same skip
could make an illegal in-transit move dodge its validation. The rewrite
processes a snapshot of the queue and rebuilds it (`processFutureArrivals`),
and a regression test plays two same-turn arrivals through the engine.

### 3.2 Arrivals were placed by blind overwrite — even onto kings
`TimeChessEngine.py:174`: `self.game[p.pos] = p`. Whatever stood on the
arrival square was deleted from the game, silently: an enemy piece (a capture,
but with no message and no lineage bookkeeping), a friendly piece (which
should instead mean the traveller is Lost in Time — moving onto your own piece
is not a legal move), or **a king** — the game would simply continue with the
king gone and the mate logic blind. The rules chapter even specifies
appearance order for simultaneous arrivals ("the one which departed first
arrives first"), which the overwrite made meaningless.

The rewrite validates each traveller *at its moment of arrival*, in departure
order, against the board as it stands then — including travellers that landed
moments earlier. First-departed lands first; a later same-square arrival
either captures it (enemy) or is Lost in Time (friend). Three regression
tests cover the enemy case, the friendly case, and the king case.

### 3.3 The pawn's diagonal time-capture checked the wrong layer
`TimeChessEngine.py:207` validates a pawn's diagonal-through-time capture by
looking at the destination square at `t-1` — one turn *before* the pawn
arrives. Both failure directions existed: an enemy that moved onto the square
during the intervening turn was invisible (pawn wrongly Lost in Time, a
capture denied), and an enemy that moved *away* passed the check (pawn
"captures" thin air and lands as a phantom). The rewrite judges the capture
against the arrival layer. Two regression tests, one per direction.

### 3.4 Checkmate could be escaped by illegal moves
`isInCheckmate` (`TimeChessEngine.py:213-229`) iterated raw `getMoves()`
output and asked only "does this end in check?". But `getMoves` includes
pseudo-moves that `checkMove` would reject — capturing a king, and a pawn's
unconditional diagonal-time moves onto friendly squares. A position whose only
"escape" was such an illegal move would be misreported as not-mate, leaving a
game that could never end. The rewrite's `hasLegalMove` applies the same
filters as move legality.

### 3.5 No stalemate handling
If the side to move had no legal moves but was not in check, the original
simply sat there: `isInCheckmate` returns `False` and the interface waits
forever for a move that cannot come. The rewrite declares a draw. (True
stalemate is spectacularly rare in Time Chess — almost every piece always has
a forward time-hop available — but rare is not never, and an engine should
terminate.)

### 3.6 Hard 500-turn crash and whole-array scans
`newGame()` preallocated a `500×8×8` object array (`TimeChessEngine.py:490`);
turn 500 raised an uncaught `IndexError` in `newTurn`. Every query —
`getPosWhereTrue`, check detection, lineage erasure — ran `numpy.vectorize`
over all 32,000 cells regardless of how far the game had actually progressed.
The rewrite's layer stack grows one 64-cell layer per turn, scans only the
layers that exist, and `eraseLineage` only scans from the capture turn
upward. A test plays past turn 550.

### 3.7 The deep-copy avalanche (the big performance one)
To test "does this move end in check?" the original deep-copied the entire
engine per candidate move (`TimeChessEngine.py:53`). Checkmate detection does
this for every available move. Worse, `Game.__deepcopy__`
(`TimeChessEngine.py:460-483`) ignored the `memo` parameter, so when the
engine was deep-copied, every `Piece` sitting in the future queue re-triggered
a full copy of the whole game array — copying the 32,000-cell board several
times per candidate move, with a Python-object clone per cell.

The rewrite treats piece objects as immutable, so cloning a game is just
copying the layer arrays and sharing the pieces (structural sharing) — a few
thousand pointer copies, no object construction. See §5 for numbers.

### 3.8 Smaller ones
- `TCECPInterface.py:33-34`: `except EOFError: pass` inside the read loop —
  when the GUI died without sending `quit`, the engine spun at 100% CPU
  re-raising EOF forever. The Node adapter exits on stdin close.
- `TimeChess3dInterface.py:222`: `debug("... %s, datastring: %s" (e, instr))`
  — missing `%`, so the error handler itself raised `TypeError`, and `posstrs`
  was then unbound (`NameError`) in the code that followed.
- `Game.getBoardAtTurn(-1)` silently wrapped to the *last* layer via negative
  indexing; garbage `getState` requests returned confident nonsense. The
  rewrite bounds-checks.
- Dead weight removed: the `UserArray` compatibility shim (obsolete even in
  2011), the `Callable` static-method recipe (Python 2.1-era), the deprecated
  `getIntKey`, and `attemptMove`'s unused `ignoreCheck` parameter.

## 4. Rules gaps the rewrite had to settle

The dissertation's rules left a few situations undefined; the original code
resolved them by accident (usually as a bug). The rewrite makes them explicit:

1. **Arrival onto a king.** Undefined in the rules; the original deleted the
   king (§3.2). Ruling: **kings are never captured** — the same principle the
   original's own `checkMove` applied to ordinary moves (`TimeChessEngine.py:97`).
   A traveller whose destination holds a king, either colour's, is Lost in
   Time. A corollary worth knowing as a player: a king can safely blockade an
   arrival square.
2. **Simultaneous arrivals on one square.** The rules give the order
   ("first departed, first arrives") but not the consequence. Ruling: the
   later arrival is validated against the board after the earlier one landed —
   enemy occupant means capture-on-arrival, friendly occupant means Lost in
   Time. This is just the Lost in Time rule applied at the moment of arrival.
3. **When is a pawn's diagonal time-capture judged?** At the arrival layer
   (§3.3). This matches the rules' definition of the diagonal as a capture
   move: the thing you capture is whatever is there when you land.
4. **Eager invalidation of in-transit moves is permanent** (kept from the
   original). Once a queued move is rendered illegal — blocked, or its maker
   captured in the past — the traveller is immediately and irrevocably lost,
   even if a later past-capture re-opens the path. This matches the rule text
   ("if this happens, the piece... is never returned to the board") and keeps
   the queue's behaviour a function of when things happened, which fits the
   game's whole aesthetic.
5. **Braindead self-collision.** A backward traveller propagating up to the
   present is destroyed by *any* occupied square, including its own younger
   self sitting where it used to be. This falls straight out of the
   steamrollering rule ("any piece of either colour") and needed no special
   case.

One emergent property, now pinned by a test: **Fool's Mate is not mate in
Time Chess.** After 1.f3 e5 2.g4 Qh4, White simply steps the king one turn
into the future. Mate requires covering the king's past as well as its
present — which is why real Time Chess mating nets (also tested) lean on
time-diagonal attacks into the king's history. The dissertation's evaluation
chapter suspected mate was hard; the engine now demonstrates precisely why.

## 5. Performance

Measured with `node bench.js` (games of random legal moves; every move
includes legal-move generation for clicked pieces, full validation with check
simulation, arrival settlement, and the mate/stalemate search):

```
125 moves in 105 ms  (avg 0.84 ms/move, worst 11.1 ms)
```

The original had no benchmark, but the asymptotics tell the story. Testing
one candidate move for check cost it a deep copy of 32,000 Python-object
cells (several times over, per §3.7) plus `vectorize` scans of the full
array; with ~30 candidate moves to clear a mate check, that is on the order
of 10⁶–10⁷ object operations *per move made*, in interpreted Python — the
dissertation itself calls checkmate detection "the most expensive operation
in the program by a substantial margin". The rewrite's clone is a structural
share of ~64×(turns so far) pointers, scans touch only live layers, and the
whole mate search at turn 30 fits in ~11 ms worst case. Interactive latency
is effectively zero at human timescales.

The interface got the same treatment. The VPython original created one 3D
object per primitive per piece per visible layer, rebuilt layer-by-layer
through protocol round-trips after every move (its layer cache invalidated
everything each turn). The Three.js UI draws all pieces of one type and
colour as a single instanced mesh — a 40-turn game with every layer visible
is still only ~12 instanced draw calls plus grid lines, rebuilt wholesale in
well under a frame.

## 6. The interface

Feature parity with the 2011 requirements list, plus the things a 2026 player
expects:

| | 2011 | 2026 |
|---|---|---|
| stacked 3D board, orbit/tilt/zoom | ✓ (VPython) | ✓ (Three.js, damped orbit, pan) |
| click piece → highlights → click to move | ✓ | ✓ |
| highlight legality | pseudo-legal (engine rejected some on click) | fully legal only; green/red split for move/capture |
| ghost pieces for in-transit travellers | ✓ | ✓, with hover readout |
| layer visibility | keys n/p/f | Now / Recent / All modes (n/r/a), auto-reveal of layers you can move to |
| red/blue stereo | ✓ | ✓ (`s`) |
| feedback | stderr text | in-page event log with narrative messages (departures, arrivals, Lost in Time, steamrollering, check), banner for check/game-over |
| undo | — | ✓ (`u`), implemented with the engine's cheap clone |
| runs on | Python 2.6 + VPython 5 | any modern browser, offline, no install |

The event log matters more than it sounds: Time Chess produces genuinely
confusing situations (the dissertation's survey said as much), and "White
Knight arrives from the past at d3t5" / "White Rook bound for e4t3 is Lost in
Time: its path has become blocked" is most of what makes the consequences of
a move legible.

## 7. Testing

`test/engine.test.js` — 26 tests, all passing:

- ports of the original's unit tests (`TestPos`, `TestGame`, `TestTCE`:
  setup, notation, move legality families, aging/propagation, lineage
  erasure, future queue, lost in time, check);
- a regression test per bug in §3 (same-turn double arrivals, same-square
  arrival collisions in both colours, arrival-onto-king, both directions of
  the pawn time-capture layer bug, >500-turn games);
- rules-level scenario tests: past-blocking of check, steamrollering,
  promotion lineage, the dissertation's "King Lost in Time" playtest game
  (the engine now ends the game, White's king move to e2t1 and all), a real
  Time Chess checkmate with the king's past covered, and Fool's-Mate-isn't-
  mate.

The browser UI was exercised end-to-end in Chromium: scripted openings with
forward time travel, ghost display, arrival, capture by a time-travelled
piece, synthetic click-to-select/move through the real pointer pipeline, view
modes, stereo, undo, and new-game — with a clean console throughout.

## 8. Known limitations & future work

- ~~**No AI opponent**~~ — since addressed: `src/ai.js` is an alpha-beta
  player built on exactly the `legalMoves` + cheap `clone()` surface
  anticipated here. See [AI-REPORT.md](AI-REPORT.md) for how the standard
  chess-engine toolkit fares against this branching factor (and which parts
  of it die).
- **No castling or en passant**, matching the original. The rules document
  says unspecified aspects default to chess, but neither the 2011 engine nor
  the rules' movement tables define their time-extruded forms, so I kept the
  original's scope rather than invent rules the dissertation never ratified.
- ~~**No draw-by-repetition or 50-move rule.**~~ — since addressed: the last
  8 layers + future queue are the complete reachable state (no move looks
  further back), so threefold repetition of that window is well-defined and
  now a draw, with a 50-move rule as backstop. See AI-REPORT.md §4.8.
- The TCECP adapter is stdin/stdout only; if a networked interface is ever
  wanted, the engine module can be imported server-side as-is.
- The UI shows every past layer on request but does not yet visualise *why* a
  move is illegal (e.g. which square blocks a time-slide). The event log
  covers the aftermath; a "show me the blocker" affordance would be a nice
  addition.

## 9. Files

```
2026-rewrite/
├── index.html          game page: panel, import map, styles
├── src/engine.js       the rules engine (pure ES module, no deps)
├── src/ui.js           Three.js interface
├── test/engine.test.js node:test suite (26 tests)
├── tcecp.js            2011 TCECP protocol adapter for Node
├── bench.js            benchmark harness
├── vendor/             Three.js r170 + addons, vendored for offline use
├── README.md           how to run and play
└── REPORT.md           this report
```
