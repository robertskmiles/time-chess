#!/usr/bin/env node
/**
 * TCECP adapter — speaks the Time Chess Engine Communication Protocol from
 * the 2011 dissertation (appendix: protocol spec) over stdin/stdout, backed
 * by the modern engine. Kept so anything written against the old protocol
 * (or a curious human with a terminal) can still drive the engine:
 *
 *   node tcecp.js
 *   > a2t0a4t0
 *   Success
 *   > getState 1
 *   state (1): [["a4t1","w","p"], ...]
 *
 * Also fixes the original TCECPInterface.py bug where EOF on stdin left the
 * process spinning in a busy loop instead of exiting.
 */

import readline from 'node:readline';
import { Engine, strToPos, strToMove, posToStr } from './src/engine.js';

let engine = new Engine();
const out = (s) => process.stdout.write(s + '\n');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const input = line.trim();
  if (input === '') return;
  if (input === 'quit') { rl.close(); return; }

  try {
    if (input === 'new') {
      engine = new Engine();
    } else if (input.startsWith('ping')) {
      out('pong' + input.slice(4));
    } else if (/^[a-h][1-8]t\d+[a-h][1-8]t\d+$/.test(input)) {
      const res = engine.attemptMove(strToMove(input));
      if (res.ok) {
        out('Success');
        for (const ev of res.events) process.stderr.write(ev.message + '\n');
      } else {
        out(`Illegal move (${res.reason}): ${input}`);
      }
    } else if (/^[a-h][1-8]t\d+$/.test(input)) {
      const moves = engine.legalMoves(strToPos(input));
      out(`moves (${input}): ${JSON.stringify(moves.map((m) => posToStr(m.to)))}`);
    } else if (input === 'getState t') {
      out(String(engine.t));
    } else if (input === 'getState futureQueue') {
      out('futureQueue: ' + JSON.stringify(
        engine.futureQueue.map((p) => [posToStr(p), p.color, p.type])));
    } else if (input.startsWith('getState ')) {
      const t = Number(input.split(/\s+/)[1]);
      const pieces = (Number.isInteger(t) && t >= 0 && t < engine.layers.length)
        ? engine.layers[t].filter(Boolean) : [];
      out(`state (${t}): ${JSON.stringify(pieces.map((p) => [posToStr(p), p.color, p.type]))}`);
    } else if (input === 'print') { // extra: not in the 2011 spec, handy in a terminal
      process.stderr.write(engine.prettyPrint() + '\n');
    } else {
      process.stderr.write(`TCECP: unrecognised input: ${input}\n`);
    }
  } catch (err) {
    process.stderr.write(`TCECP: error: ${err.message}\n`);
  }
});

rl.on('close', () => process.exit(0));
