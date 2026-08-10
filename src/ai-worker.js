/**
 * Web Worker wrapper for the AI, so searching never freezes the page.
 *
 * The engine's whole state is plain data (layers of frozen-in-practice piece
 * objects, the future queue, a turn counter), so the UI can post it here via
 * structured clone and it can be rehydrated onto the Engine prototype
 * directly — no serialization format needed.
 *
 * Module workers don't see the page's import map, so only relative imports
 * are used (engine.js and ai.js have no dependencies anyway).
 */

import { Engine } from './engine.js';
import { AI } from './ai.js';

self.onmessage = ({ data }) => {
  const { seq, state, timeLimitMs } = data;
  const engine = Object.assign(Object.create(Engine.prototype), state);
  engine.simulation = false;
  engine.events = [];
  const result = new AI({ timeLimitMs }).chooseMove(engine);
  self.postMessage({ seq, result });
};
