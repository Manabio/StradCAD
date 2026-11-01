// ================================================================
// ASCII DXF の構文解析（純関数）。dxfTokenize の対 → { header, blocks, entities, warnings }。
//
// 対象: LINE・ARC・CIRCLE・LWPOLYLINE（bulge→円弧）・POLYLINE/VERTEX（最小）・INSERT（ブロック展開）。
// それ以外のエンティティは無視して種類ごとの件数だけ UNSUPPORTED_ENTITY で警告する（TEXT・HATCH・SPLINE・DIMENSION 等）。
//
// 出力のエンティティは幾何だけの 2 種類（座標は DXF のまま＝単位換算・y 反転はしない。mm 化は dxfEntities.js）:
//   { kind:'line', a:{x,y}, b:{x,y} }
//   { kind:'arc',  c:{x,y}, u:{x,y}, v:{x,y}, t0, t1 }   // 点 P(θ) = c + u·cosθ + v·sinθ（θ は t0〜t1・反時計回り）
// 円・円弧・bulge は全部 arc（円は t1−t0=2π）。INSERT のスケール・回転・ミラーは座標へ焼き込むので、非一様スケールを
// 受けた円は u・v が直交等長でない楕円弧になる（NONUNIFORM_SCALE を警告。多角形近似は dxfEntities.js）。
// ブロックは blocks[name] = { base:{x,y}, entities } （INSERT 展開前の生のエンティティ。展開済みは entities 側）。
//
// 外部ファイルは信用しない: 件数上限（maxEntities）で打ち切り、INSERT は深さ上限・循環で打ち切る。例外にしない。
// 既知の限界: 押し出し方向（210/220/230）・INSERT の配列（70/71）・ペーパー空間（67=1）のエンティティは見ない。
// ================================================================

import {
  DxfWarning, DXF_MAX_ENTITIES, DXF_INSERT_DEPTH_MAX, DXF_SIMILARITY_EPS, DXF_SNAP_TOL_MM,
} from '../../core/constants.js';

const INVALID_ARC = Symbol('invalidArc');

// ---- DXF の語彙（ファイル形式の記述子。種別値ではなく形式の一部）----
const Rec = Object.freeze({
  SECTION: 'SECTION', ENDSEC: 'ENDSEC', BLOCK: 'BLOCK', ENDBLK: 'ENDBLK',
  LINE: 'LINE', ARC: 'ARC', CIRCLE: 'CIRCLE', LWPOLYLINE: 'LWPOLYLINE', POLYLINE: 'POLYLINE', VERTEX: 'VERTEX', SEQEND: 'SEQEND',
  INSERT: 'INSERT',
});
const Sec = Object.freeze({ HEADER: 'HEADER', BLOCKS: 'BLOCKS', ENTITIES: 'ENTITIES' });
const G = Object.freeze({
  TYPE: 0, NAME: 2, VAR: 9, X: 10, Y: 20, X2: 11, Y2: 21, RADIUS: 40, SCALE_X: 41, SCALE_Y: 42, BULGE: 42,
  ANGLE_START: 50, ANGLE_END: 51, ROTATION: 50, FLAGS: 70, SPACE: 67,
});
const HEADER_INSUNITS = '$INSUNITS';
const CLOSED_FLAG = 1;                 // LWPOLYLINE / POLYLINE の 70: 閉じた折れ線
const POLYLINE_UNSUPPORTED_FLAGS = 16 | 64; // 3D メッシュ・ポリフェースメッシュ
const VERTEX_SPLINE_FRAME_FLAG = 16;   // スプライン制御点の頂点
const PAPER_SPACE = 1;
const FULL_TURN_DEG = 360;
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

// ---- 行列（x' = a·x + c·y + e,  y' = b·x + d·y + f）----
const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
});
const applyPoint = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
const applyVector = (m, p) => ({ x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y });
function isSimilarity(m) {
  const n1 = Math.hypot(m.a, m.b);
  const n2 = Math.hypot(m.c, m.d);
  const scale = Math.max(n1, n2);
  return Math.abs(n1 - n2) <= DXF_SIMILARITY_EPS * scale && Math.abs(m.a * m.c + m.b * m.d) <= DXF_SIMILARITY_EPS * n1 * n2;
}
function insertMatrix(ent, base) {
  const cos = Math.cos(ent.rot);
  const sin = Math.sin(ent.rot);
  const T = { a: 1, b: 0, c: 0, d: 1, e: ent.p.x, f: ent.p.y };
  const R = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  const S = { a: ent.sx, b: 0, c: 0, d: ent.sy, e: 0, f: 0 };
  const Tb = { a: 1, b: 0, c: 0, d: 1, e: -base.x, f: -base.y };
  return mul(T, mul(R, mul(S, Tb)));
}

// ---- 警告の集計（同じ警告は 1 件に畳む。UNSUPPORTED_ENTITY は種類ごとの件数）----
function makeWarnings() {
  const map = new Map();
  return {
    add(code, detail = {}) {
      const key = `${code}|${detail.block ?? ''}`;
      if (!map.has(key)) map.set(key, { code, ...detail });
    },
    unsupported(type) {
      const key = `${DxfWarning.UNSUPPORTED_ENTITY}|${type}`;
      const w = map.get(key);
      if (w) w.count += 1;
      else map.set(key, { code: DxfWarning.UNSUPPORTED_ENTITY, type, count: 1 });
    },
    list: () => [...map.values()],
  };
}

// ---- レコードの読み出し ----
const pairOf = (rec, code) => rec.pairs.find(p => p.code === code);
function numOf(rec, code) {
  const p = pairOf(rec, code);
  if (!p) return null;
  const v = Number(p.value);
  return Number.isFinite(v) ? v : null;
}
const numOr = (rec, code, dflt) => numOf(rec, code) ?? dflt;

function splitRecords(pairs) {
  const records = [];
  let cur = null;
  for (const p of pairs) {
    if (p.code === G.TYPE) { cur = { type: p.value, pairs: [] }; records.push(cur); } else if (cur) cur.pairs.push(p);
  }
  return records;
}

const lineEnt = (a, b) => ({ kind: 'line', a, b });
const arcEnt = (c, r, t0, t1) => ({ kind: 'arc', c, u: { x: r, y: 0 }, v: { x: 0, y: r }, t0, t1 });

/**
 * bulge（tan(θ/4)。正＝反時計回り）の区間 p1→p2 → arc。
 * 矢高 d·|bulge|/2 が DXF_SNAP_TOL_MM 以下なら直線として null（極小 bulge が線分数を膨らませない）。
 * 中心・半径が非有限（極大 bulge・桁あふれ）なら INVALID_ARC。
 */
function bulgeArc(p1, p2, bulge) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (!(d > 0) || d * Math.abs(bulge) / 2 <= DXF_SNAP_TOL_MM) return null;
  const h = d * (1 - bulge * bulge) / (4 * bulge); // 弦の中点から中心まで（進行方向の左が正）
  const c = { x: (p1.x + p2.x) / 2 - dy / d * h, y: (p1.y + p2.y) / 2 + dx / d * h };
  const r = d * (1 + bulge * bulge) / (4 * Math.abs(bulge));
  const sweep = 4 * Math.atan(Math.abs(bulge));
  const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  const a2 = Math.atan2(p2.y - c.y, p2.x - c.x);
  const t0 = bulge > 0 ? a1 : a2; // 時計回り（負）は p2→p1 の反時計回りとして持つ
  if (![c.x, c.y, r, t0, sweep].every(Number.isFinite)) return INVALID_ARC;
  return arcEnt(c, r, t0, t0 + sweep);
}

/** 頂点列（{x,y,bulge}）→ line／arc の列。closed なら最後→最初の区間も足す。 */
function polylineSegments(verts, closed) {
  const out = [];
  const last = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < last; i++) {
    const p1 = verts[i];
    const p2 = verts[(i + 1) % verts.length];
    if (p1.x === p2.x && p1.y === p2.y) continue;
    const arc = p1.bulge !== 0 ? bulgeArc(p1, p2, p1.bulge) : null;
    if (arc === INVALID_ARC) return null; // 折れ線ごと不正として警告する（黙って消さない）
    out.push(arc ?? lineEnt({ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }));
  }
  return out;
}

function lwpolylineOf(rec) {
  const verts = [];
  for (const p of rec.pairs) {
    const v = Number(p.value);
    if (p.code === G.X) verts.push({ x: v, y: 0, bulge: 0 });
    else if (verts.length > 0 && p.code === G.Y) verts[verts.length - 1].y = v;
    else if (verts.length > 0 && p.code === G.BULGE) verts[verts.length - 1].bulge = v;
  }
  if (verts.length < 2 || verts.some(q => !Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.bulge))) return null;
  return polylineSegments(verts, (numOr(rec, G.FLAGS, 0) & CLOSED_FLAG) !== 0);
}

function polylineOf(rec, vertexRecs) {
  const flags = numOr(rec, G.FLAGS, 0);
  if ((flags & POLYLINE_UNSUPPORTED_FLAGS) !== 0) return null;
  const verts = [];
  for (const vr of vertexRecs) {
    if ((numOr(vr, G.FLAGS, 0) & VERTEX_SPLINE_FRAME_FLAG) !== 0) continue;
    const x = numOf(vr, G.X);
    const y = numOf(vr, G.Y);
    if (x === null || y === null) return null;
    verts.push({ x, y, bulge: numOr(vr, G.BULGE, 0) });
  }
  if (verts.length < 2) return null;
  return polylineSegments(verts, (flags & CLOSED_FLAG) !== 0);
}

/** 1 レコード → 生のエンティティ列。null は読めない（不正）。 */
function entitiesOfRecord(rec) {
  switch (rec.type) {
    case Rec.LINE: {
      const x1 = numOf(rec, G.X), y1 = numOf(rec, G.Y), x2 = numOf(rec, G.X2), y2 = numOf(rec, G.Y2);
      if ([x1, y1, x2, y2].includes(null)) return null;
      return [lineEnt({ x: x1, y: y1 }, { x: x2, y: y2 })];
    }
    case Rec.ARC: {
      const x = numOf(rec, G.X), y = numOf(rec, G.Y), r = numOf(rec, G.RADIUS);
      const s = numOf(rec, G.ANGLE_START), e = numOf(rec, G.ANGLE_END);
      if ([x, y, r, s, e].includes(null) || r <= 0) return null;
      const sweepDeg = (((e - s) % FULL_TURN_DEG) + FULL_TURN_DEG) % FULL_TURN_DEG || FULL_TURN_DEG;
      return [arcEnt({ x, y }, r, s * DEG, s * DEG + sweepDeg * DEG)];
    }
    case Rec.CIRCLE: {
      const x = numOf(rec, G.X), y = numOf(rec, G.Y), r = numOf(rec, G.RADIUS);
      if ([x, y, r].includes(null) || r <= 0) return null;
      return [arcEnt({ x, y }, r, 0, TWO_PI)];
    }
    case Rec.LWPOLYLINE:
      return lwpolylineOf(rec);
    case Rec.INSERT: {
      const x = numOf(rec, G.X), y = numOf(rec, G.Y);
      const name = pairOf(rec, G.NAME)?.value;
      if (x === null || y === null || !name) return null;
      return [{
        kind: 'insert', name, p: { x, y },
        sx: numOr(rec, G.SCALE_X, 1), sy: numOr(rec, G.SCALE_Y, 1), rot: numOr(rec, G.ROTATION, 0) * DEG,
      }];
    }
    default:
      return undefined; // 未対応
  }
}

/**
 * レコード列（ENTITIES か 1 つのブロックの中身）→ 生のエンティティ列。POLYLINE は続く VERTEX〜SEQEND を取り込む。
 * budget.left を数え、尽きたら打ち切る（budget.limited）。
 */
function readEntities(records, warnings, budget) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.type === Rec.VERTEX || rec.type === Rec.SEQEND) continue; // POLYLINE が取り込み済みのはず（孤立は捨てる）
    if (numOf(rec, G.SPACE) === PAPER_SPACE) continue;
    if (budget.left <= 0) { budget.limited = true; break; }
    budget.left -= 1;
    let ents;
    if (rec.type === Rec.POLYLINE) {
      const vertexRecs = [];
      while (i + 1 < records.length && records[i + 1].type === Rec.VERTEX) vertexRecs.push(records[++i]);
      if (i + 1 < records.length && records[i + 1].type === Rec.SEQEND) i++;
      ents = polylineOf(rec, vertexRecs);
    } else {
      ents = entitiesOfRecord(rec);
    }
    if (ents === undefined || ents === null) warnings.unsupported(ents === null ? `${rec.type}（不正）` : rec.type);
    else out.push(...ents);
  }
  return out;
}

/**
 * INSERT を再帰展開して line／arc だけにする（座標へ焼き込む）。
 * depth: 今いる入れ子の段（トップレベルは 0。INSERT はブロックの中身を depth+1 で展開する）。
 */
function expand(ents, matrix, depth, stack, ctx, blockName) {
  const { warnings, out, budget } = ctx;
  for (const ent of ents) {
    if (budget.stopped) return;
    if (out.length >= budget.maxOut) { budget.stopped = true; return; }
    if (ent.kind === 'line') {
      out.push(lineEnt(applyPoint(matrix, ent.a), applyPoint(matrix, ent.b)));
    } else if (ent.kind === 'arc') {
      if (!isSimilarity(matrix)) warnings.add(DxfWarning.NONUNIFORM_SCALE, { block: blockName });
      out.push({ kind: 'arc', c: applyPoint(matrix, ent.c), u: applyVector(matrix, ent.u), v: applyVector(matrix, ent.v), t0: ent.t0, t1: ent.t1 });
    } else if (ent.kind === 'insert') {
      // 展開回数（空のブロックの入れ子でも指数的に増える）に上限を設ける。未定義・循環・深さ超の INSERT も 1 回に数える。
      if (budget.visitsLeft <= 0) { budget.stopped = true; return; }
      budget.visitsLeft -= 1;
      const block = ctx.getBlock(ent.name);
      if (!block) { warnings.unsupported(`${Rec.INSERT}（ブロック未定義）`); continue; }
      if (stack.includes(ent.name)) { warnings.add(DxfWarning.INSERT_CYCLE, { block: ent.name }); continue; }
      if (depth + 1 > budget.maxDepth) { warnings.add(DxfWarning.INSERT_DEPTH, { block: ent.name }); continue; }
      expand(block.entities, mul(matrix, insertMatrix(ent, block.base)), depth + 1, [...stack, ent.name], ctx, ent.name);
      if (budget.stopped) return;
    }
  }
}

/**
 * @param {{code:number, value:string}[]} pairs dxfTokenize の pairs
 * @param {{maxEntities?: number, maxDepth?: number}} [opts]
 * @returns {{ header: {insUnits: number|null}, blocks: Object<string, {base:{x:number,y:number}, entities: object[]}>,
 *             entities: object[], warnings: object[] }}
 */
export function dxfParse(pairs, { maxEntities = DXF_MAX_ENTITIES, maxDepth = DXF_INSERT_DEPTH_MAX } = {}) {
  const warnings = makeWarnings();
  // 予算: ENTITIES の読込み件数（left）・展開後の出力数（maxOut）・INSERT の展開回数（visitsLeft）。ブロックの読込みは数えない
  // （使われたときに 1 度だけ読む。未使用の巨大ブロックが ENTITIES の予算を先に使い切らない）。
  const budget = { left: maxEntities, limited: false, maxOut: maxEntities, visitsLeft: maxEntities, stopped: false, maxDepth };
  const header = { insUnits: null };
  const blocks = Object.create(null); // ブロック名は外部入力（"__proto__" 等で原型を汚さない）

  const records = splitRecords(Array.isArray(pairs) ? pairs : []);
  let section = null;
  let blockRecs = null; // 読み込み中のブロック { name, base, recs }
  const entityRecs = [];
  for (const rec of records) {
    if (rec.type === Rec.SECTION) { section = pairOf(rec, G.NAME)?.value ?? null; if (section === Sec.HEADER) readHeader(rec, header); continue; }
    if (rec.type === Rec.ENDSEC) { section = null; blockRecs = null; continue; }
    if (section === Sec.ENTITIES) entityRecs.push(rec);
    else if (section === Sec.BLOCKS) {
      if (rec.type === Rec.BLOCK) {
        const name = pairOf(rec, G.NAME)?.value ?? '';
        blockRecs = { name, base: { x: numOr(rec, G.X, 0), y: numOr(rec, G.Y, 0) }, recs: [] };
        if (name) blocks[name] = { base: blockRecs.base, entities: null, recs: blockRecs.recs };
      } else if (rec.type === Rec.ENDBLK) blockRecs = null;
      else if (blockRecs) blockRecs.recs.push(rec);
    }
  }

  const topRaw = readEntities(entityRecs, warnings, budget);

  // ブロックは INSERT されたときに読んで結果を覚える。
  const readBlocks = Object.create(null);
  const getBlock = name => {
    if (!Object.hasOwn(blocks, name)) return null;
    if (!Object.hasOwn(readBlocks, name)) {
      const b = blocks[name];
      readBlocks[name] = { base: b.base, entities: readEntities(b.recs, warnings, { left: Infinity, limited: false }) };
    }
    return readBlocks[name];
  };

  const entities = [];
  expand(topRaw, IDENTITY, 0, [], { warnings, out: entities, budget, getBlock }, '');
  if (budget.limited || budget.stopped) warnings.add(DxfWarning.ENTITY_LIMIT, { limit: maxEntities });
  return { header, blocks: readBlocks, entities, warnings: warnings.list() };
}

function readHeader(rec, header) {
  const i = rec.pairs.findIndex(p => p.code === G.VAR && p.value === HEADER_INSUNITS);
  if (i < 0) return;
  const next = rec.pairs[i + 1];
  const v = next && next.code === G.FLAGS ? Number(next.value) : NaN;
  header.insUnits = Number.isFinite(v) ? v : null;
}
