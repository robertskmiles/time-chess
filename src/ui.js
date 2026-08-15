/**
 * Time Chess — browser 3D interface.
 *
 * The successor to TimeChess3dInterface.py (VPython, 2011). The game state is
 * drawn as a stack of 8x8 board layers, one per turn, with time running
 * upward. Pieces keep the original's minimalist primitive-solid designs.
 *
 * Rendering strategy: all pieces of one (type, colour) pair are drawn with a
 * single InstancedMesh, so a deep game is still a handful of draw calls
 * (the original rebuilt every VPython object, layer by layer, every turn).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AnaglyphEffect } from 'three/addons/effects/AnaglyphEffect.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Engine, posToStr, moveToStr, humanString, parseMoveInput, COLOR_NAMES } from './engine.js';
import { AI } from './ai.js';

// ---------------------------------------------------------------------------
// Constants and scene basics
// ---------------------------------------------------------------------------

const GAP = 1.7; // vertical world distance between turns (stack layout)
const ROW_GAP = 9.5; // horizontal distance between turns (line layout)
const RECENT_TURNS = 6;

// 'stack': 3D, time runs upward. 'line': 3D, each turn to the right of the
// last. 'flat': 2D boards with chess symbols, left to right as time passes.
let layout = 'stack';
const LAYOUTS = ['stack', 'line', 'flat'];
const layerOrigin = (t) => (layout === 'stack'
  ? new THREE.Vector3(0, t * GAP, 0)
  : new THREE.Vector3(t * ROW_GAP, 0, 0));
const worldPos = (x, y, t) => layerOrigin(t).add(new THREE.Vector3(x, 0, 7 - y));

const container = document.getElementById('scene');
// the scene box is not the whole window on phones (the panel becomes a
// bottom sheet), so all sizing follows the container, not the window
const viewSize = () => ({
  w: container.clientWidth || window.innerWidth,
  h: container.clientHeight || window.innerHeight,
});
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewSize().w, viewSize().h);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// mid grey, roughly halfway between the two piece colours, so that both the
// white (0xe8e6e0) and black (0x23262e) pieces read clearly against it
scene.background = new THREE.Color(0x7e848e);
scene.fog = new THREE.Fog(0x7e848e, 40, 90);

const camera = new THREE.PerspectiveCamera(45, viewSize().w / viewSize().h, 0.1, 200);
camera.position.set(14, 9, 16);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(3.5, 0.5, 3.5);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 70;
controls.minDistance = 3;

let anaglyph = null; // lazily created anaglyph effect
let stereoMode = 'off'; // 'off' | 'anaglyph' | 'cross' (cross-eye side-by-side)
const stereoCamera = new THREE.StereoCamera(); // aspect set per frame in renderCrossEye

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(8, 20, 10);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8fa3c8, 0.5);
fill.position.set(-10, 6, -8);
scene.add(fill);

// ---------------------------------------------------------------------------
// Piece geometry — the original VPython primitive recipes, y-up
// ---------------------------------------------------------------------------

function buildPieceGeometries() {
  const g = {};
  const cs = 0.15; // rook crenellation size

  const cone = (r, h, y) => new THREE.ConeGeometry(r, h, 24).translate(0, y + h / 2, 0);
  const coneDown = (r, h, y) => new THREE.ConeGeometry(r, h, 24).rotateX(Math.PI).translate(0, y + h / 2, 0);
  const cyl = (r, h, y) => new THREE.CylinderGeometry(r, r, h, 24).translate(0, y + h / 2, 0);
  const sph = (r, y) => new THREE.SphereGeometry(r, 20, 14).translate(0, y, 0);
  const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

  g.p = mergeGeometries([cone(0.3, 0.5, 0), sph(0.15, 0.5)]);

  g.r = mergeGeometries([
    cyl(0.3, 0.7, 0),
    box(cs, cs, cs, +0.3 - cs / 2, 0.7 + cs / 2, 0),
    box(cs, cs, cs, -0.3 + cs / 2, 0.7 + cs / 2, 0),
    box(cs, cs, cs, 0, 0.7 + cs / 2, +0.3 - cs / 2),
    box(cs, cs, cs, 0, 0.7 + cs / 2, -0.3 + cs / 2),
  ]);

  // knight: upright body with a head angled forward (rotated 180° for black)
  const head = new THREE.BoxGeometry(0.24, 0.24, 0.55);
  head.rotateX(-Math.PI / 5);
  head.translate(0, 0.62, -0.16);
  g.n = mergeGeometries([box(0.32, 0.62, 0.3, 0, 0.31, 0.05), head]);

  g.b = mergeGeometries([cyl(0.15, 0.6, 0), cone(0.2, 0.3, 0.65), coneDown(0.2, 0.3, 0.35)]);

  g.q = mergeGeometries([cyl(0.2, 0.7, 0), coneDown(0.3, 0.6, 0.3), sph(0.06, 0.92)]);

  g.k = mergeGeometries([
    cyl(0.2, 0.7, 0),
    box(0.34, 0.1, 0.1, 0, 0.9, 0),
    box(0.1, 0.34, 0.1, 0, 0.9, 0),
  ]);

  return g;
}

const pieceGeometry = buildPieceGeometries();

const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.45, metalness: 0.05 });
const blackMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.5, metalness: 0.15 });
const ghostWhiteMat = new THREE.MeshStandardMaterial({
  color: 0xe8e6e0, transparent: true, opacity: 0.25, depthWrite: false, roughness: 0.5,
});
const ghostBlackMat = new THREE.MeshStandardMaterial({
  color: 0x3a3f4d, transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.5,
});

const moveMat = new THREE.MeshBasicMaterial({ color: 0x3fae5a, transparent: true, opacity: 0.4, depthWrite: false });
const captureMat = new THREE.MeshBasicMaterial({ color: 0xd05045, transparent: true, opacity: 0.55, depthWrite: false });
const selectMat = new THREE.MeshBasicMaterial({ color: 0xe8c15a, transparent: true, opacity: 0.5, depthWrite: false });
const highlightGeom = new THREE.BoxGeometry(0.96, 0.1, 0.96);

// grid: 9 + 9 lines outlining an 8x8 board on the XZ plane
function buildGridGeometry() {
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    pts.push(i - 0.5, 0, -0.5, i - 0.5, 0, 7.5); // lines along z
    pts.push(-0.5, 0, i - 0.5, 7.5, 0, i - 0.5); // lines along x
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}
const gridGeometry = buildGridGeometry();
const gridNowMat = new THREE.LineBasicMaterial({ color: 0x9fb2d8, transparent: true, opacity: 0.95 });
const gridPastMat = new THREE.LineBasicMaterial({ color: 0x39415a, transparent: true, opacity: 0.8 });
const gridFutureMat = new THREE.LineBasicMaterial({ color: 0x2e3450, transparent: true, opacity: 0.6 });

// faint board surface under each grid, so layers read as separate planes
const surfaceGeometry = new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2);
const surfaceMat = new THREE.MeshBasicMaterial({
  color: 0x969ca8, transparent: true, opacity: 0.1,
  depthWrite: false, side: THREE.DoubleSide,
});

// Transparent things are blended in draw order, and three.js's default
// per-object distance sort snaps as the camera moves (one sample point per
// object, so a whole highlight square pops when its order against a big
// surface plane flips). Instead, draw the stack deterministically from the
// bottom layer up; within a layer: surface, then grid, then markers/ghosts.
const layerOrder = (t, within) => t + within;
const ON_SURFACE = 0.3, ON_GRID = 0.6;

// ---------------------------------------------------------------------------
// Game + dynamic scene state
// ---------------------------------------------------------------------------

const engine = new Engine();
const undoStack = [];

let viewMode = 'all'; // 'now' | 'recent' | 'all'
let selected = null; // {x, y, t} of the selected piece
let legalTargets = []; // moves for the selected piece

const dynamic = new THREE.Group(); // everything rebuilt per turn
scene.add(dynamic);
let clickTargets = []; // meshes the raycaster tests

function visibleTurns() {
  const turns = new Set();
  if (viewMode === 'now') turns.add(engine.t);
  else if (viewMode === 'recent') {
    for (let t = Math.max(0, engine.t - RECENT_TURNS); t <= engine.t; t++) turns.add(t);
  } else {
    for (let t = 0; t <= engine.t; t++) turns.add(t);
  }
  for (const m of legalTargets) turns.add(m.to.t); // reveal every layer you could move to
  for (const trav of engine.futureQueue) turns.add(trav.t); // and every ghost's arrival layer
  return turns;
}

function rebuild() {
  if (layout === 'flat') { rebuildFlat(); return; } // the 3D scene is hidden

  // tear down previous frame's dynamic content
  for (const child of dynamic.children) {
    if (child.isInstancedMesh) child.dispose();
  }
  dynamic.clear();
  clickTargets = [];

  const turns = visibleTurns();

  // board grids, each on a faint translucent surface
  for (const t of turns) {
    const mat = t === engine.t ? gridNowMat : (t > engine.t ? gridFutureMat : gridPastMat);
    const grid = new THREE.LineSegments(gridGeometry, mat);
    grid.position.copy(layerOrigin(t));
    grid.renderOrder = layerOrder(t, ON_SURFACE);
    dynamic.add(grid);

    if (t <= engine.t) { // future layers hold no pieces; the grid is enough
      const surface = new THREE.Mesh(surfaceGeometry, surfaceMat);
      surface.position.copy(worldPos(3.5, 3.5, t));
      surface.position.y -= 0.02;
      surface.renderOrder = layerOrder(t, 0);
      dynamic.add(surface);
    }
  }

  // pieces, one InstancedMesh per (type, colour)
  const buckets = new Map();
  for (const t of turns) {
    if (t > engine.t) continue;
    for (const p of engine.layers[t]) {
      if (!p) continue;
      const bkey = p.type + p.color;
      if (!buckets.has(bkey)) buckets.set(bkey, []);
      buckets.get(bkey).push(p);
    }
  }
  const m4 = new THREE.Matrix4();
  const flip = new THREE.Matrix4().makeRotationY(Math.PI);
  for (const [bkey, pieces] of buckets) {
    const type = bkey[0], color = bkey[1];
    const mesh = new THREE.InstancedMesh(
      pieceGeometry[type], color === 'w' ? whiteMat : blackMat, pieces.length);
    pieces.forEach((p, i) => {
      const v = worldPos(p.x, p.y, p.t);
      m4.makeTranslation(v.x, v.y, v.z);
      if (color === 'b') m4.multiply(flip); // knights face their own forward
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.pieces = pieces;
    dynamic.add(mesh);
    clickTargets.push(mesh);
  }

  // ghosts: queued travellers shown at their destination
  for (const trav of engine.futureQueue) {
    const ghost = new THREE.Mesh(
      pieceGeometry[trav.type], trav.color === 'w' ? ghostWhiteMat : ghostBlackMat);
    ghost.position.copy(worldPos(trav.x, trav.y, trav.t));
    if (trav.color === 'b') ghost.rotation.y = Math.PI;
    ghost.renderOrder = layerOrder(trav.t, ON_GRID);
    ghost.userData.ghost = trav;
    dynamic.add(ghost);
    clickTargets.push(ghost);
  }

  // selection marker + move highlights
  if (selected) {
    const marker = new THREE.Mesh(highlightGeom, selectMat);
    marker.position.copy(worldPos(selected.x, selected.y, selected.t));
    marker.position.y += 0.05;
    marker.renderOrder = layerOrder(selected.t, ON_GRID);
    dynamic.add(marker);

    for (const m of legalTargets) {
      const isCapture = !!engine.pieceAtPos(m.to);
      const hl = new THREE.Mesh(highlightGeom, isCapture ? captureMat : moveMat);
      hl.position.copy(worldPos(m.to.x, m.to.y, m.to.t));
      hl.position.y += 0.05;
      hl.renderOrder = layerOrder(m.to.t, ON_GRID);
      hl.userData.moveTarget = m;
      dynamic.add(hl);
      clickTargets.push(hl);
    }
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const logEl = el('log');

function log(type, message, turn = engine.t) {
  const div = document.createElement('div');
  div.className = `entry ${type}`;
  div.innerHTML = `<span class="t">t${turn}</span>${message}`;
  logEl.prepend(div);
  while (logEl.children.length > 250) logEl.lastChild.remove();
}

function updatePanel() {
  el('turnnum').textContent = `turn ${engine.t}`;
  const chip = el('sidechip');
  chip.className = engine.currentSide;
  chip.textContent = COLOR_NAMES[engine.currentSide];

  const banner = el('banner');
  if (engine.status !== 'playing') {
    const who = engine.status === 'draw' ? 'Draw'
      : engine.status === 'w-wins' ? 'White wins' : 'Black wins';
    banner.textContent = `${who} — ${engine.statusReason}`;
    banner.classList.add('show');
  } else if (engine.isInCheck(engine.currentSide)) {
    banner.textContent = `${COLOR_NAMES[engine.currentSide]} is in check`;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }

  el('queue').innerHTML = engine.futureQueue.length
    ? 'In transit: ' + engine.futureQueue
      .map((p) => `<span>${humanString(p)} &rarr; ${posToStr(p)}</span>`).join(', ')
    : '';
}

// ---------------------------------------------------------------------------
// 2D (flat) view — plain boards with chess symbols, left to right in time.
// Rebuilt from scratch on every rebuild(), sharing the 3D view's selection
// state and move logic; only the rendering differs.
// ---------------------------------------------------------------------------

const flatEl = el('flat');
// filled glyphs for both sides, coloured in CSS; U+FE0E keeps emoji fonts
// from rendering them as fixed-colour emoji
const GLYPHS = { p: '♟︎', r: '♜︎', n: '♞︎', b: '♝︎', q: '♛︎', k: '♚︎' };
let flatLastT = -1; // auto-scroll to the present board only when the turn changes

function rebuildFlat() {
  flatEl.innerHTML = '';
  const turns = [...visibleTurns()].sort((a, b) => a - b);
  const targets = new Map(); // "x,y,t" -> move, for the selected piece
  for (const m of legalTargets) targets.set(`${m.to.x},${m.to.y},${m.to.t}`, m);
  const ghosts = new Map();
  for (const trav of engine.futureQueue) ghosts.set(`${trav.x},${trav.y},${trav.t}`, trav);

  for (const t of turns) {
    const board = document.createElement('div');
    board.className = 'flat-board ' + (t === engine.t ? 'present' : t > engine.t ? 'future' : 'past');
    const label = document.createElement('div');
    label.className = 'flat-label';
    label.textContent = t === engine.t ? `turn ${t} — now` : `turn ${t}`;
    board.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'flat-grid';
    for (let y = 7; y >= 0; y--) {
      for (let x = 0; x < 8; x++) {
        const cell = document.createElement('div');
        cell.className = 'sq ' + ((x + y) % 2 ? 'light' : 'dark');
        const key = `${x},${y},${t}`;
        const p = t <= engine.t ? engine.pieceAt(x, y, t) : null;
        const ghost = !p && ghosts.get(key);
        if (p) {
          cell.textContent = GLYPHS[p.type];
          cell.classList.add(p.color === 'w' ? 'wp' : 'bp');
          if (p.sterile) cell.classList.add('faded');
          cell.title = `${humanString(p)} — ${posToStr(p)}${p.sterile ? ' (departed to the future)' : ''}`;
        } else if (ghost) {
          cell.textContent = GLYPHS[ghost.type];
          cell.classList.add(ghost.color === 'w' ? 'wp' : 'bp', 'faded');
          cell.title = `${humanString(ghost)} — in transit, due at ${posToStr(ghost)}`;
        }
        if (selected && selected.x === x && selected.y === y && selected.t === t) {
          cell.classList.add('sel');
        }
        const mv = targets.get(key);
        if (mv) {
          cell.classList.add(engine.pieceAtPos(mv.to) ? 'cap' : 'mov');
          cell.addEventListener('click', (ev) => { ev.stopPropagation(); tryMove(mv); });
        } else if (p && !p.sterile && p.t === engine.t && p.color === engine.currentSide
            && engine.status === 'playing') {
          cell.classList.add('own');
          cell.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (selected && selected.x === x && selected.y === y && selected.t === t) deselect();
            else select({ x, y, t });
          });
        }
        grid.appendChild(cell);
      }
    }
    board.appendChild(grid);
    flatEl.appendChild(board);
  }

  if (flatLastT !== engine.t) {
    flatLastT = engine.t;
    flatEl.querySelector('.flat-board.present')
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}

// clicking empty space (or an inert square) drops the selection
flatEl.addEventListener('click', () => { if (selected) deselect(); });

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

function setPointer(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  if (stereoMode === 'cross') {
    // each half shows the same scene through a narrower frustum; map a click
    // in either half back onto the full-frame ray (the remaining eye offset
    // is a few pixels, well under a square's width)
    const { rh, half } = crossLayout();
    let hx = ev.clientX - r.left;
    if (hx >= half) hx -= half;
    pointer.x = ((hx / half) * 2 - 1) * stereoCamera.aspect;
    // the pair's region is the canvas minus the bar; same vertical fov as
    // the mono camera, so its NDC y is the mono NDC y
    pointer.y = -((ev.clientY - r.top) / rh) * 2 + 1;
  } else {
    pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  }
}

function pick(ev) {
  setPointer(ev);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(clickTargets, false)[0] ?? null;
}

function select(pos) {
  if (!engine.pieceAtPos(pos)) return;
  selected = pos;
  legalTargets = engine.legalMoves(pos);
  rebuild();
}

function deselect() {
  selected = null;
  legalTargets = [];
  rebuild();
}

function tryMove(move) {
  const backup = engine.clone();
  backup.simulation = false;
  const res = engine.attemptMove(move);
  if (!res.ok) {
    log('illegal', res.reason);
    return false;
  }
  gameStamp++;
  undoStack.push(backup);
  if (undoStack.length > 300) undoStack.shift();
  for (const ev of res.events) log(ev.type, ev.message, backup.t);
  selected = null;
  legalTargets = [];
  rebuild();
  updatePanel();
  scheduleAutoMove();
  return true;
}

// typed move entry: algebraic ("e4", "Nf3"), coordinate ("e2e4"), or full
// TCECP ("a2t0a4t0"); a tN suffix sends the destination to another turn
const moveInput = el('moveinput');

function submitTypedMove() {
  if (!moveInput.value.trim()) return;
  const parsed = parseMoveInput(engine, moveInput.value);
  if (parsed.ok && tryMove(parsed.move)) {
    moveInput.value = '';
  } else {
    if (!parsed.ok) log('illegal', parsed.reason);
    moveInput.select(); // leave the text in place to fix and resubmit
  }
}

moveInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') submitTypedMove();
  else if (ev.key === 'Escape') moveInput.blur();
});

renderer.domElement.addEventListener('pointerdown', (ev) => {
  downAt = { x: ev.clientX, y: ev.clientY };
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt) return;
  const drag = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
  downAt = null;
  // fingers wobble more than mice: allow a bigger tap radius on touch
  const tapRadius = ev.pointerType === 'touch' ? 14 : 6;
  if (drag > tapRadius || ev.button !== 0) return; // that was an orbit, not a click

  const hit = pick(ev);
  if (!hit) { if (selected) deselect(); return; }
  const obj = hit.object;

  if (obj.userData.moveTarget) {
    tryMove(obj.userData.moveTarget);
    return;
  }
  if (obj.isInstancedMesh) {
    const p = obj.userData.pieces[hit.instanceId];
    if (!p) return;
    if (p.t === engine.t && p.color === engine.currentSide && engine.status === 'playing') {
      if (selected && selected.x === p.x && selected.y === p.y && selected.t === p.t) deselect();
      else select({ x: p.x, y: p.y, t: p.t });
    } else if (p.t !== engine.t) {
      log('entry', `${humanString(p)} at ${posToStr(p)} is in the past and cannot be commanded`);
    } else {
      log('entry', `It is ${COLOR_NAMES[engine.currentSide]}'s turn`);
    }
  }
});

// hover readout
const hoverEl = el('hover');
renderer.domElement.addEventListener('pointermove', (ev) => {
  const hit = pick(ev);
  if (!hit) { hoverEl.classList.remove('show'); return; }
  const obj = hit.object;
  let text = null;
  if (obj.userData.moveTarget) {
    const to = obj.userData.moveTarget.to;
    const occ = engine.pieceAtPos(to);
    text = occ ? `capture ${humanString(occ)} at ${posToStr(to)}` : `move to ${posToStr(to)}`;
  } else if (obj.userData.ghost) {
    text = `${humanString(obj.userData.ghost)} — in transit, due at ${posToStr(obj.userData.ghost)}`;
  } else if (obj.isInstancedMesh) {
    const p = obj.userData.pieces[hit.instanceId];
    if (p) text = `${humanString(p)} — ${posToStr(p)}${p.sterile ? ' (departed to the future)' : ''}`;
  }
  if (text) { hoverEl.textContent = text; hoverEl.classList.add('show'); }
  else hoverEl.classList.remove('show');
});

// buttons
el('newgame').addEventListener('click', () => {
  engine.reset();
  gameStamp++;
  undoStack.length = 0;
  selected = null; legalTargets = [];
  logEl.innerHTML = '';
  log('entry', 'New game. White to move.');
  rebuild(); updatePanel();
  scheduleAutoMove(); // in case the AI plays White
});

function restoreState(prev) {
  engine.layers = prev.layers;
  engine.t = prev.t;
  engine.futureQueue = prev.futureQueue;
  engine.status = prev.status;
  engine.statusReason = prev.statusReason;
  engine.windowKeys = prev.windowKeys;
  engine.quietRun = prev.quietRun;
  engine.clockRun = prev.clockRun;
}

el('undo').addEventListener('click', () => {
  const prev = undoStack.pop();
  if (!prev) { log('entry', 'Nothing to undo'); return; }
  restoreState(prev);
  gameStamp++; // discard any in-flight AI search of the popped position
  const opp = el('opponent').value;
  if (opp === 'both') {
    el('opponent').value = 'none'; // undo pauses the AI-vs-AI show
    log('entry', 'AI vs AI paused (switched to two players)');
  } else if ((opp === 'w' || opp === 'b') && aiControls(engine.currentSide)) {
    // playing against the AI: take back its reply and your move together
    const prev2 = undoStack.pop();
    if (prev2) restoreState(prev2);
  }
  selected = null; legalTargets = [];
  log('entry', `Took back the move made at turn ${engine.t}`);
  rebuild(); updatePanel();
});

// ---------------------------------------------------------------------------
// AI opponent. The search runs in a Web Worker so the page stays interactive
// while it thinks; if workers are unavailable it falls back to searching on
// the main thread. `gameStamp` invalidates a search whose position changed
// under it (new game, undo, a human move) before the reply arrived.
// ---------------------------------------------------------------------------

let aiWorker = null;
let aiSeq = 0;
let aiThinking = false;
let gameStamp = 0;

function searchAsync(timeLimitMs) {
  if (aiWorker === null) {
    try {
      aiWorker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    } catch {
      aiWorker = false;
    }
  }
  if (!aiWorker) {
    return Promise.resolve(new AI({ timeLimitMs }).chooseMove(engine));
  }
  return new Promise((resolve) => {
    const seq = ++aiSeq;
    const done = (ev) => {
      if (ev.type === 'message' && ev.data.seq !== seq) return;
      aiWorker.removeEventListener('message', done);
      aiWorker.removeEventListener('error', done);
      if (ev.type === 'error') {
        aiWorker = false; // fall back for this and future searches
        resolve(new AI({ timeLimitMs }).chooseMove(engine));
      } else {
        resolve(ev.data.result);
      }
    };
    aiWorker.addEventListener('message', done);
    aiWorker.addEventListener('error', done);
    aiWorker.postMessage({
      seq,
      timeLimitMs,
      state: {
        layers: engine.layers,
        t: engine.t,
        futureQueue: engine.futureQueue,
        status: engine.status,
        statusReason: engine.statusReason,
        windowKeys: engine.windowKeys,
        quietRun: engine.quietRun,
        clockRun: engine.clockRun,
      },
    });
  });
}

async function aiMove() {
  if (aiThinking) return;
  if (engine.status !== 'playing') { log('entry', 'The game is over'); return; }
  aiThinking = true;
  const stamp = gameStamp;
  const button = el('aimove');
  button.disabled = true;
  log('entry', `${COLOR_NAMES[engine.currentSide]} (AI) is thinking…`);
  try {
    const r = await searchAsync(Number(el('ailevel').value));
    if (gameStamp !== stamp || engine.status !== 'playing') return; // position changed under us
    if (!r) { log('entry', 'No legal moves for the AI to choose from'); return; }
    log('entry', `AI plays ${moveToStr(r.move)} — depth ${r.depth}, eval ${r.scoreText}, ` +
      `${((r.nodes + r.qnodes) / 1000).toFixed(0)}k nodes in ${(r.ms / 1000).toFixed(1)}s`);
    tryMove(r.move);
  } finally {
    aiThinking = false;
    button.disabled = false;
    scheduleAutoMove(); // in AI vs AI mode, keep the game going
  }
}

const aiControls = (side) => el('opponent').value === 'both' || el('opponent').value === side;

/** If it is an AI-controlled side's turn, let it move (after a short pause so
 *  the previous move can be seen landing on the board). */
function scheduleAutoMove(delay = 400) {
  if (engine.status !== 'playing' || aiThinking || !aiControls(engine.currentSide)) return;
  const stamp = gameStamp;
  setTimeout(() => {
    if (gameStamp !== stamp || engine.status !== 'playing' || aiThinking) return;
    if (aiControls(engine.currentSide)) aiMove();
  }, delay);
}

el('aimove').addEventListener('click', aiMove);
el('opponent').addEventListener('change', () => scheduleAutoMove());

function setMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  rebuild();
}
document.querySelectorAll('.mode').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});

// board surface opacity slider (persisted across visits)
const opacitySlider = el('boardopacity');
const applyBoardOpacity = () => { surfaceMat.opacity = Number(opacitySlider.value) / 100; };
opacitySlider.addEventListener('input', () => {
  applyBoardOpacity();
  try { localStorage.setItem('timechess-board-opacity', opacitySlider.value); } catch { /* private mode */ }
});
try {
  const saved = localStorage.getItem('timechess-board-opacity');
  if (saved !== null) opacitySlider.value = saved;
} catch { /* no storage */ }
applyBoardOpacity();

// layout toggle, cycling stack -> line -> flat 2D (persisted across visits)
function setLayout(mode) {
  layout = mode;
  el('layout').textContent = mode === 'stack' ? 'Stack' : mode === 'line' ? 'Line' : '2D';
  flatEl.hidden = mode !== 'flat';
  if (mode === 'flat') flatLastT = -1; // re-centre on the present board
  rebuild();
  try { localStorage.setItem('timechess-layout', mode); } catch { /* private mode */ }
}
el('layout').addEventListener('click', () => {
  setLayout(LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length]);
});
try {
  const saved = localStorage.getItem('timechess-layout');
  if (LAYOUTS.includes(saved) && saved !== 'stack') setLayout(saved);
} catch { /* no storage */ }

const STEREO_MODES = ['off', 'anaglyph', 'cross'];
function setStereo(mode) {
  stereoMode = mode;
  if (mode === 'anaglyph') {
    if (!anaglyph) anaglyph = new AnaglyphEffect(renderer, viewSize().w, viewSize().h);
    anaglyph.setSize(viewSize().w, viewSize().h);
  }
  const b = el('stereo');
  b.classList.toggle('active', mode !== 'off');
  b.textContent = mode === 'off' ? 'Stereo'
    : mode === 'anaglyph' ? 'Stereo: anaglyph' : 'Stereo: cross-eye';
}
function cycleStereo() {
  setStereo(STEREO_MODES[(STEREO_MODES.indexOf(stereoMode) + 1) % STEREO_MODES.length]);
}
el('stereo').addEventListener('click', cycleStereo);

/** The stereo pair sits above the bottom bar (which overlays the bottom of
 *  the full-window canvas). */
function crossLayout() {
  const { w, h } = viewSize();
  const barH = Math.min(el('panel').offsetHeight, h / 2);
  return { w, h, barH, rh: h - barH, half: w / 2 };
}

/** Side-by-side for free viewing: crossed eyes, so the RIGHT eye's image
 *  goes on the LEFT half and vice versa. */
function renderCrossEye() {
  const { w, h, barH, rh, half } = crossLayout();
  // eye separation scaled to the viewing distance (~2° stereo base), so the
  // disparity stays comfortable at any zoom
  stereoCamera.eyeSep = camera.focus / 30;
  stereoCamera.aspect = (half / rh) / camera.aspect; // eye frustum fits a half
  stereoCamera.update(camera);
  renderer.setScissorTest(true);
  if (barH > 0) { // keep the strip under the translucent bar from going stale
    renderer.setScissor(0, 0, w, barH);
    renderer.setClearColor(scene.background);
    renderer.clear();
  }
  renderer.setScissor(0, barH, half, rh);
  renderer.setViewport(0, barH, half, rh);
  renderer.render(scene, stereoCamera.cameraR);
  renderer.setScissor(half, barH, half, rh);
  renderer.setViewport(half, barH, half, rh);
  renderer.render(scene, stereoCamera.cameraL);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
}

// --- bottom bar chrome ---------------------------------------------------

// the help card and "?" button sit just above the bar, wherever it ends up
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--bar-h', `${el('panel').offsetHeight}px`);
}).observe(el('panel'));

// the controls cheat-sheet fades to a "?" once the first game is underway
const helpEl = el('help');
const helpBtn = el('helpbtn');
setTimeout(() => {
  helpEl.classList.add('hidden');
  helpBtn.classList.add('show');
}, 15000);
helpBtn.addEventListener('click', () => helpEl.classList.toggle('hidden'));

// the log shows the last event or two; the arrow grows it upward
el('logexpand').addEventListener('click', () => {
  const tall = el('logwrap').classList.toggle('tall');
  document.body.classList.toggle('log-tall', tall); // the help yields to it
  el('logexpand').innerHTML = tall ? '&#9660;' : '&#9650;';
});

// --- the how-to-play guide (shown automatically on the first visit) ------
// The text lives in GUIDE.md so it can be edited without touching code.
// This renders the small subset of markdown the guide uses: #/## headings,
// paragraphs, - lists, **bold**, *italic*, `key` (as <kbd>), raw HTML through.

function mdToHtml(md) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<kbd>$1</kbd>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const out = [];
  let inList = false;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    if (line.startsWith('- ')) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList && /^\s/.test(raw)) { // continuation of a wrapped list item
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line)}</li>`);
      continue;
    }
    closeList();
    const h = line.match(/^(#{1,2}) (.*)/);
    if (h) { flushPara(); const n = h[1].length + 1; out.push(`<h${n}>${inline(h[2])}</h${n}>`); }
    else para.push(line);
  }
  flushPara(); closeList();
  return out.join('\n');
}

fetch('./GUIDE.md')
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((md) => { el('guide-content').innerHTML = mdToHtml(md); })
  .catch(() => {
    el('guide-content').innerHTML =
      '<p class="dim">Could not load GUIDE.md — it should sit next to index.html.</p>';
  });

const guideEl = el('guide');
function showGuide(show) {
  guideEl.hidden = !show;
  if (!show) {
    try { localStorage.setItem('timechess-guide-seen', '1'); } catch { /* private mode */ }
  }
}
el('guidebtn').addEventListener('click', () => showGuide(true));
el('guide-close').addEventListener('click', () => showGuide(false));
el('guide-start').addEventListener('click', () => showGuide(false));
guideEl.addEventListener('click', (ev) => { if (ev.target === guideEl) showGuide(false); });
try {
  if (!localStorage.getItem('timechess-guide-seen')) showGuide(true);
} catch { /* no storage: just don't auto-open */ }

window.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !guideEl.hidden) { showGuide(false); return; }
  if (k === 'h') { showGuide(guideEl.hidden); return; }
  if (k === '/') { moveInput.focus(); ev.preventDefault(); }
  else if (k === 'n') setMode('now');
  else if (k === 'r') setMode('recent');
  else if (k === 'a') setMode('all');
  else if (k === 's') cycleStereo();
  else if (k === 'l') el('layout').click();
  else if (k === 'u') el('undo').click();
  else if (k === 'c') aiMove();
  else if (k === 'escape' && selected) deselect();
});

window.addEventListener('resize', () => {
  const { w, h } = viewSize();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (anaglyph) anaglyph.setSize(w, h);
});

// ---------------------------------------------------------------------------
// Render loop — the camera drifts to follow the present layer as it climbs
// the stack (or marches rightward along the line)
// ---------------------------------------------------------------------------

let followX = 0;
let followY = 0.4;

function animate() {
  requestAnimationFrame(animate);
  if (layout === 'flat') return; // the 2D overlay covers the whole scene
  const wantY = (layout === 'stack' ? engine.t * GAP : 0) + 0.4;
  const wantX = layout === 'line' ? engine.t * ROW_GAP : 0;
  if (Math.abs(wantY - followY) > 0.001) {
    const dy = (wantY - followY) * 0.06;
    followY += dy;
    controls.target.y += dy;
    camera.position.y += dy;
  }
  if (Math.abs(wantX - followX) > 0.001) {
    const dx = (wantX - followX) * 0.06;
    followX += dx;
    controls.target.x += dx;
    camera.position.x += dx;
  }
  controls.update();
  // both stereo effects converge the eyes at camera.focus; put that on the
  // orbit target rather than three.js's fixed default of 10 units
  if (stereoMode !== 'off') camera.focus = camera.position.distanceTo(controls.target);
  if (stereoMode === 'anaglyph') anaglyph.render(scene, camera);
  else if (stereoMode === 'cross') renderCrossEye();
  else renderer.render(scene, camera);
}

log('entry', 'New game. White to move.');
rebuild();
updatePanel();
animate();

// console/debug handle: window.timeChess.move('a2t0a4t0'), .engine, .select(...)
window.timeChess = {
  engine,
  move: (s) => tryMove(s), // accepts "a2t0a4t0" notation or a move object
  ai: aiMove, // let the AI play a move for whoever is to move
  select, deselect, rebuild, updatePanel,
  camera, controls,
};
