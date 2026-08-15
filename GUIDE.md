# How to play Time Chess

## Chess, extruded into the time dimension

Each layer of the stack is one turn - the top layer is *now*, and every
layer below it is a past turn, frozen where it happened. A new layer
appears with every move. You can only command pieces on the top layer,
but their moves can point into the past or the future.

## Moving

Tap or click one of your pieces on the top layer, then tap a highlighted
square: <span style="color:#7fc97f">green</span> to move,
<span style="color:#e06c5f">red</span> to capture. Moves within the top
layer are ordinary chess. Highlights on other layers are time travel -
each piece moves through time the same way it moves through space (a
rook slides diagonally through time, a knight jumps 2 by 1, and so on).
Pieces block each other in time just as they do in space.

## Moving forward in time

The piece vanishes now and lands on a future turn - a ghost marks
where it will arrive. The catch: the future isn't settled yet. If a
foward move becomes illegal before it's complete, the piece is
**Lost in Time** and never returns. Lose your King this way and you
lose the game.

**Fighting a piece in transit.** Careful: a traveller attacks its
destination, so blockading the landing square with an ordinary piece
just gets you captured when it arrives. But you can block its
*route* - any square its move passes through on the way, or capture its
past self before the it departed, so the
move never happened. You can also stand your King on the destination - Kings are
never captured, so the arrival simply fails.

## Moving backward in time

The piece appears on a past turn and stands there, *braindead*,
repeated on every layer up to the present - it can't be commanded until
it catches up to now, and if history already put a piece on that
square, it gets **steamrollered** and destroyed. Capturing a piece in
the past erases it from that moment onward - everything it went on to
do stays done, but the piece itself (and anything it became) vanishes
from every later turn. There are no paradoxes.

## Check works on your past too

Your King is in check if *any* of its selves — present or past — can be
captured by an enemy piece moving now. Dodging into the future doesn't
save a king whose history is exposed.

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
- You can also type moves into the box on the panel (`/` jumps there):
  chess notation (`e4`, `Nf3`, `exd5`) or plain squares (`e2e4`), with
  `tN` on the destination for time travel - `Nf3t2` lands on turn 2,
  `Nf3t+2` two turns ahead.
- The AI plays Black by default — change who it plays (or watch it
  play itself) and its thinking time with the two dropdowns.

## First-game tips

- Watch the event log on the panel: it narrates every arrival, loss,
  and capture in plain words.
- Time-travel is tempting but dangerous - it's easy to get Lost in Time
- A piece that seems safe can still be attacked *in the past*. Guard
  your King's history, not just its square.
