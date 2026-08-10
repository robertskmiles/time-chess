# A Chess Engine Meets Time Chess

*August 2026*

The dissertation's headline further-work item was an AI player, and its design
chapter states the game was built to resist one: "Be complex for computers —
the game's state space should be large, as should the number of available
choices, to keep the branching factor high." This report documents what
happens when you ignore that warning and point a completely bog-standard
chess engine at Time Chess: iterative-deepening negamax with alpha-beta
pruning, MVV-LVA + killer + history move ordering, null-move pruning, a
capture-only quiescence search, and a handcrafted evaluation.

The verdict up front: **it works, and the game fights back exactly where the
dissertation predicted, plus a few places it didn't.** The AI plays plausible
openings, wins material, checkmated a random mover by turn 17, and beat a
copy of itself at turn 40 with a genuinely time-chess-native mating move
(occupying the arrival square of the defender's in-transit pawn, making it
Lost in Time). But it reaches depth 2–4 where the same effort in ordinary
chess reaches depth 6–8, and several load-bearing chess-engine techniques
quietly die on contact with the rules.

## 1. What was built

- `src/ai.js` — the searcher and evaluator. Pure ES module, no dependencies,
  runs in browser and Node, like the rules engine. It never mutates the
  engine it is given: every node in the search tree is an `Engine.clone()`.
- `aiplay.js` — CLI: `node aiplay.js --white=ai --black=random --ms=1000`.
  Plays games, prints depth/score/nodes per move and a depth-decay summary.
- `test/ai.test.js` — 9 tests: evaluation sanity, mate-in-1, winning and
  saving hanging material, a regression test for the perspective bug (§4.1),
  legality of everything the AI plays, game-over handling, time budget.
- UI: an **AI move** button (key `c`) plays a move for whichever side is to
  move — so you can play against the AI, or make it play itself.

## 2. Measured reality

Random-play game, 1 second per search, on this machine (Node 24):

| turn | pieces | legal moves | depth reached | nodes/s |
|---|---|---|---|---|
| 0 | 32 | 127 | 3 | 67k |
| 5 | 28 | 112 | 3 | 51k |
| 10 | 25 | 130 | 3 | 23k |
| 20 | 22 | 128 | **1** | 11k |
| 40 | 17 | 63 | 3 | 32k |
| 80 | 10 | 94 | 4 | 32k |

Two things are happening at once. Node cost grows with `t` (cloning is
O(t·64), and every check test scans the whole surviving history), which is
the turn-20 trough. Then material loss pulls the branching factor back down
— but far more slowly than in chess, because **history re-arms the survivors**:
ten pieces at turn 80 still have 94 legal moves between them, several times
what ten chess pieces would have, because each of them can slide into an
ever-deeper past.

Where those moves come from, at the start of a game:

| | spatial | forward time | backward time |
|---|---|---|---|
| turn 0 | 20 | 107 | 0 |
| turn 8 (after a normal opening) | 35 | 112 | 19 |

The 20 familiar chess openings are outnumbered five-to-one by forward
time-hops on move one. That is the branching problem in a single row: most
of Time Chess's move list is speculative moves whose legality — let alone
value — is *undetermined at the moment they are declared*.

## 3. Which chess-engine pillars survive

| technique | status here |
|---|---|
| alpha-beta + iterative deepening | works unchanged |
| move ordering (MVV-LVA, killers, history) | works; past-captures slot into MVV-LVA naturally since a past victim is a whole lineage |
| make/unmake move | **impossible** — replaced by clone-per-node (§4.3) |
| transposition table | **dead on arrival** (§4.4) |
| null-move pruning | works, and is oddly *more* principled than in chess (§4.5) |
| quiescence search | half-works: it can settle present and backward captures, but cannot quiesce the future (§4.6) |
| material + mobility evaluation | works, but needs terms chess has no concept of, and its cost grows with game length (§4.7) |

## 4. The challenges, in the order they drew blood

### 4.1 Negamax's deepest assumption fails: the game can end mid-move

First bug, found on the very first search: from the opening position the
engine announced **mate in 1** — by stepping its own king forward in time
onto the square its bishop would occupy. That is the exact "clearly stupid
move" from the dissertation's playtest chapter, and it loses instantly.

The cause is structural. When a King becomes Lost in Time, the game ends
*during arrival settlement inside another move* — the engine sets the result
and never hands the turn over, so the state's side-to-move marker still
names the mover. My terminal scorer read the perspective from that marker;
the sign flipped, and suicide scored as victory. Chess code never meets this:
chess games end between moves, cleanly, with the side-to-move well defined.
In Time Chess a move you made three turns ago can end the game in the middle
of someone else's move. Fix: derive perspective from search-ply parity and
never trust the terminal state's own turn marker (`sideAt(ply)` in
`src/ai.js`, plus a regression test).

### 4.2 Legality is non-local, so there are no cheap legal-move tricks

Chess engines avoid full make-and-test legality with local reasoning: pin
detection, "did this move expose the king", attack tables. None of it ports.
A Time Chess check can run from a *present* attacker through a diagonal in
*spacetime* to a king instance nine turns in the past; whether your present
move is legal can depend on whether it unblocks a line through the layer you
just changed, which every future present will look back through. Every
candidate move gets the full treatment: clone, apply (including arrival
settlement it may trigger), then a check scan over every surviving king
instance in history. This is the single biggest term in the node cost, and I
found no shortcut that survives the geometry.

### 4.3 No unmake — and why clone-per-node is survivable anyway

`applyMove` can settle arrivals, erase whole lineages, steamroller a
braindead piece, and end the game; unwinding that would need a journal of
everything it did. The 2026 engine's design rescues this: pieces are
immutable and layers are arrays of pointers, so a clone is a structural
share — a few thousand pointer copies, no object construction. Search is
possible *because* the rules engine was rebuilt that way. The 2011 original's
deep-copy (32,000 Python objects per candidate move) would have made even
depth 2 heroic.

### 4.4 Transposition tables are dead, and that is a property of the game

The TT is one of the pillars of computer chess — and here it is nearly
worthless, for a reason worth stating precisely: **in Time Chess, the
position *is* the history.** Two move orders that produce the same present
in chess produce distinguishable states here, because the layers they leave
behind differ, and layers are live game state — they block time-lines, they
hold capturable past selves, they carry check. Genuine transpositions are
almost nonexistent; hashing the full state costs O(t·64) per node. A
corollary: since `t` only ever grows, *no state can ever repeat at all* —
threefold repetition on full histories is impossible. The same monotonicity
that kills the draw rule kills the cache.

There is, however, a repetition that *does* mean something. No move reaches
more than 7 turns into the past, so the last 8 layers (plus the future queue
and the side to move) are the complete reachable state — a Markov window —
and *that* can recur. The engine now implements threefold repetition on this
window as a draw (see §4.8), and the same canonical window key would be the
right thing to hash if a TT were ever attempted: it is the true "position".

### 4.5 Null move: the one gift

Chess has no legal "pass", so null-move pruning is a slightly guilty fiction.
Time Chess accidentally defines passing cleanly: settle the arrivals that
are due, then let every piece propagate one layer (`processFutureArrivals()`
+ `endTurn()` — the engine test suite's own `fastForward` idiom). Better
still, classical null-move's failure case, zugzwang, barely exists: almost
any piece can always step one turn into the future, so having the move is
almost never a liability. R=2 null-move pruning went in with less worry than
it deserves in chess.

### 4.6 Forward time travel is a built-in horizon-effect exploit

The worst structural problem. A piece moved to `t+k` resolves — arrives,
captures, or is Lost in Time — only `k` plies later, when the queue is
settled *during whatever move is being made then*. Three consequences:

- **A threatened piece can flee beyond the horizon.** Hop your attacked
  queen five turns forward and a depth-3 search cannot see whether the hop
  was salvation or suicide. The search sees only that the threat evaporated.
- **Quiescence cannot chase it.** Qsearch quiets a position by extending
  captures, but an arrival is not a move — there is nothing to extend on. A
  leaf with a loaded future queue is structurally *never quiet*, and the
  stand-pat evaluation there is a guess.
- The patch is a blunt instrument: in-transit material is valued at 85% and
  travellers add nothing else to the evaluation. The dissertation observed
  that random play loses most of its pieces to Lost in Time; an evaluator
  that priced arrival risk properly (is the path still clear? is the arrival
  square guarded? can the opponent afford to block?) is a real research item.

A cleaner definition of "quiet" for this game — and I think the right next
step — is *the future queue is empty and no capture is available*, with
search extended until arrivals land. That is potentially a `k`-ply extension
per traveller, which is exactly the cost the game wants you to pay.

### 4.7 Evaluation must score histories, not positions

Standard terms (material, mobility, centre, tempo) transfer directly. But two
terms exist that chess cannot express, and both are about the past:

- **Past exposure.** Capturing any past instance of a piece erases its
  lineage to the present. So every square a piece has *ever* stood on is a
  permanent attack surface, and the evaluator charges for enemy moves that
  land on a living piece's past self. The king version of this is the heart
  of the game: Fool's Mate fails here because the king steps into the future,
  and real mating nets must cover the king's past — which is why the
  evaluation pays specifically for attacks on past king instances.
- **Ghost material.** A traveller in the queue whose lineage has meanwhile
  been erased in the past will never arrive ("its move never happened"), but
  detecting that costs a parent-search per queue entry per eval, so the
  evaluator knowingly counts some dead pieces as 85% alive.

Both terms share an uncomfortable property: their cost grows with `t`. An
evaluation that must look at the whole history gets slower every turn — in
chess the eval of move 80 costs the same as the eval of move 8. Time Chess
quietly repeals that.

### 4.8 Nothing forced the game to end — so the rules grew two draw laws

As designed, the game had no repetition rule (impossible on full histories,
§4.4), no 50-move rule, and mate is hard: the dissertation's evaluation
chapter suspected it, and the engine demonstrates it — covering a king's
present *and* entire past usually needs overwhelming force. AI-vs-AI games
were observed settling into endless back-and-forth shuffles.

The window insight from §4.4 makes the fix principled rather than arbitrary,
and both rules are now implemented (a 2026 rules addition, flagged in the
README):

- **Threefold repetition of the 8-layer window** is a draw. The window is
  the complete reachable state, so its third recurrence genuinely is "the
  same position for the third time". A knight shuffle from the opening
  draws at exactly turn 16 — the first turn a window *can* have appeared
  three times — pinned by a test. The searcher scores any window recurrence
  (against the played game or its own search path) as 0, gated on a cheap
  "quiet run" counter, since a repeat provably needs at least nine
  consecutive piece-preserving plies.
- **A fifty-move rule as backstop**: 50 moves per side with no capture, no
  loss to time, and no pawn move is a draw. This is not redundant with
  repetition — an experiment with two AIs in bare K-vs-K ran 80+ moves
  without ever recreating an exact window (wandering kings on an 8×8×t
  board have plenty of room to never repeat), so dead positions need the
  clock. With both rules, the same experiment draws at exactly move 100.

### 4.9 What the AI taught me about the game

Watching it play was the fun part:

- **It discovered backward redeployment on its own**: rooks travelling to a
  square several turns in the past and riding the braindead propagation back
  to the present — teleportation with a steamroller risk attached, priced by
  the search at depth 1 because backward moves, unlike forward ones, resolve
  instantly inside `applyMove`. The asymmetry (backward = fully observable
  now, forward = unknowable for k plies) shapes its whole style: it plays
  confident backward tactics and treats forward hops as a last resort.
- **Its mates are time-chess mates.** The AI-vs-AI finish: Black, in check,
  hopped a pawn one turn forward as a desperado; White's queen took the
  arrival square, the pawn was Lost in Time, and the same move completed
  mate over the king's covered past.
- **It never loses pieces to Lost in Time**, where random play bleeds out
  through it — confirming the dissertation's diagnosis that the forward
  moves flooding the move list are mostly slow-motion suicides, and that
  *knowing which ones aren't* is most of what skill means in this game.

## 5. What a serious Time Chess engine would need

In rough order of expected value:

1. **Arrival-aware quiescence** — "quiet" defined as empty future queue
   (§4.6), so forward moves stop being horizon exploits.
2. **Real arrival-risk pricing** — replace the flat 85% with path/guard
   analysis, and detect ghost travellers cheaply (an erased-lineage bitset
   maintained incrementally by `eraseLineage`).
3. **Incremental state** — a journaling make/unmake inside the engine
   (record what arrival settlement and lineage erasure touched) to replace
   clone-per-node; nodes would get several times cheaper and stop degrading
   with `t`.
4. **Forward-move policy pruning** — the move list is ~70% speculative hops;
   a cheap "is this hop plausibly survivable" filter (or, in 2026 terms, a
   learned policy prior) attacks the branching factor where it actually
   lives. MCTS with a policy network is arguably a better fit than
   alpha-beta for this game: it needs no transposition table, tolerates huge
   branching with good priors, and its rollouts naturally resolve the future
   queue.
5. **Time-aware king safety** — a term for how *coverable* the king's past
   is, since that is what winning positions are converging toward.

## 6. Files

```
2026-rewrite/
├── src/ai.js           the searcher + evaluator (pure ES module, no deps)
├── src/ai-worker.js    Web Worker wrapper, so the browser UI never blocks
├── aiplay.js           CLI games: AI vs AI / AI vs random, with stats
├── test/ai.test.js     9 tests (node --test test/ai.test.js)
└── src/ui.js           opponent/level selectors, auto-reply, key `c`
```

All 38 tests pass (29 engine + 9 AI). The AI drives the engine purely
through its public surface, exactly as the 2011 engine/interface split
intended; the engine's only change for the AI's benefit is the §4.8 draw
rules — a rules addition, not an interface one.
