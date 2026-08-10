# How to play Time Chess

*Chess, extruded into the time dimension.*

## The board is the whole history

Each layer of the stack is one turn — the top layer is *now*, and every
layer below it is a past turn, frozen where it happened. A new layer
appears after every move. You can only command pieces on the top layer,
but their moves can point into the past or the future.

## Moving

Tap or click one of your pieces on the top layer, then tap a highlighted
square: <span style="color:#7fc97f">green</span> to move,
<span style="color:#e06c5f">red</span> to capture. Moves within the top
layer are ordinary chess. Highlights on other layers are time travel —
each piece moves through time the same way it moves through space (a
rook slides straight through turns, a knight jumps 2×1, and so on).
Pieces block each other in time just as they do in space.

## Forward in time

The piece vanishes now and lands on a future turn — a ghost marks
where it will arrive. The catch: the future isn't settled yet. If its
booked move has become illegal when the moment comes, the piece is
**Lost in Time** and never returns. Lose your King this way and you
lose the game.

**Fighting a piece in transit.** Careful: a traveller attacks its
destination, so blockading the landing square with an ordinary piece
just gets you captured when it arrives. What does work: block its
*route* — any square its move passes through on the way (for a piece
hopping straight through time, that's its own square during any turn in
between); capture its past self before the moment it departed, so the
move never happened; or stand a King on the destination — Kings are
never captured, so the arrival simply fails. Pawns hopping straight
through time are the exception: that move can't capture, so any blocker
on their square kills them.

## Backward in time

The piece appears on a past turn and stands there, *braindead*,
repeated on every layer up to the present — it can't be commanded until
it catches up to now, and if history already put a piece on that
square, it gets **steamrollered** and destroyed. Capturing a piece in
the past erases it from that moment onward — everything it went on to
do stays done, but the piece itself (and anything it became) vanishes
from every later turn. There are no paradoxes; what happened, happened.

## Check works on your past too

Your King is in check if *any* of its selves — present or past — can be
captured by an enemy piece moving now. Dodging into the future doesn't
save a king whose history is exposed, which is why checkmate here means
covering the king's past as well as its present.

## How games end

- Checkmate, or a King Lost in Time.
- Draw: stalemate, threefold repetition of the recent position (the
  last 8 turns are all that can still matter), or fifty moves each
  without a capture, a loss to time, or a pawn move.

## Controls

- **Orbit** drag (one finger) · **zoom** wheel or pinch · **pan**
  right-drag (two fingers)
- `n`/`r`/`a` show Now / Recent / All turns · `u` undo · `c` AI move ·
  `s` cycle stereo (anaglyph, then cross-eye) · `h` this guide
- The AI plays Black by default — change who it plays (or watch it
  play itself) and its thinking time with the two dropdowns.

## First-game tips

- Watch the event log on the panel: it narrates every arrival, loss,
  and capture in plain words.
- Time-hops are tempting and usually fatal — a piece sent forward
  needs its landing kept safe for every turn in between.
- A piece that seems safe can still be attacked *in the past*. Guard
  your King's history, not just its square.
