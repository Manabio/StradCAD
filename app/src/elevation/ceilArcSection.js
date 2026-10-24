/**
 * 展開図の自室の天井断面（円弧・ドーム）: 開始点・頭頂点・終了点の 3 点を通る円の純幾何（純モジュール）。
 * 設計意図は .claude/elevation-model.md「天井高さの解決」の E4。
 *
 * 入力は体裁の片（elevationFloorProfile.js wallAdjacentFloorSegments の1件）:
 *   {loX, hiX, floorDeltaMm, chMm（loX の高さ）, chHiMm（hiX の高さ）, ceilArc:{alongX（頭頂のローカル x）, chMm（頭頂の高さ）}}
 * 高さは絶対 z（floorDeltaMm + ch。上が正）。円は上側の弧だけを使う（頭頂が弦より上・3 点とも円の中心以上のとき）。
 * 作れない（頭頂が片の内側に無い・弦と一直線・下側の弧になる・非有限）ときは null＝呼び元は従来の直線（chMm→chHiMm）。
 * 体裁は円弧プリミティブ 1 本、断面エンジンは弦に刻んだ区間の列（鉛直差 SAGITTA_MM 以下）で受ける。
 * 単位 mm。import は elevationPrimitives.js（生成ヘルパー）・elevationStyle.js（許容）だけ（node:test から単体で読める）。
 */
import { arc } from './elevationPrimitives.js';
import { FLOAT_EPS, GAP_EPS_MM } from './elevationStyle.js';

const END_MARGIN_MM = 0.5;    // 頭頂が両端からこれ以上内側にあること
const STRAIGHT_EPS_MM = 0.5;  // 頭頂が弦より高い量がこれ未満なら直線
const SAGITTA_MM = 1;         // エンジンへ渡す弦と円弧の鉛直方向の差の上限
const MAX_CHORDS = 64;        // 弦の本数の上限（左右 32 ずつ。下限は左右 2 ずつ＝4）

/**
 * @typedef {{cx:number, cz:number, r:number, x0:number, z0:number, xa:number, za:number, x1:number, z1:number}} CeilArcCircle
 *   中心 (cx, cz)・半径 r（絶対 z・上が正）と 3 点（開始・頭頂・終了）。
 */

/**
 * 片 → 3 点を通る円。作れなければ null。
 * @param {{loX:number, hiX:number, floorDeltaMm?:number, chMm?:number, chHiMm?:number, ceilArc?:{alongX:number, chMm:number}}|null|undefined} seg
 * @returns {CeilArcCircle|null}
 */
export function ceilArcCircleOf(seg) {
  const a = seg?.ceilArc;
  if (!a || !Number.isFinite(seg.chMm)) return null;
  const fd = seg.floorDeltaMm ?? 0;
  const x0 = seg.loX, x1 = seg.hiX, xa = a.alongX;
  const z0 = fd + seg.chMm, z1 = fd + (seg.chHiMm ?? seg.chMm), za = fd + a.chMm;
  if (![x0, x1, xa, z0, z1, za].every(Number.isFinite)) return null;
  if (!(xa > x0 + END_MARGIN_MM && xa < x1 - END_MARGIN_MM)) return null;
  const chord = z0 + (z1 - z0) * ((xa - x0) / (x1 - x0));
  if (!(za - chord > STRAIGHT_EPS_MM)) return null;
  // 開始点を原点にした座標で外心を求める（桁落ちを避ける）
  const bx = xa - x0, bz = za - z0, cx = x1 - x0, cz = z1 - z0;
  const d = 2 * (bx * cz - bz * cx);
  if (!(Math.abs(d) > FLOAT_EPS)) return null;
  const b2 = bx * bx + bz * bz, c2 = cx * cx + cz * cz;
  const ux = (cz * b2 - bz * c2) / d, uz = (bx * c2 - cx * b2) / d;
  const r = Math.hypot(ux, uz);
  const center = { cx: x0 + ux, cz: z0 + uz };
  // 3 点とも中心以上（上側の弧）でなければ上側の弧の式が成り立たない
  const lowest = Math.min(z0, za, z1);
  if (!(lowest >= center.cz - GAP_EPS_MM) || !Number.isFinite(r) || !(r > 0)) return null;
  return { ...center, r, x0, z0, xa, za, x1, z1 };
}

/**
 * 円弧上の絶対 z。x は [x0, x1] にクランプ（区間の外は端の値で水平＝既存の規約）。端は元の値をそのまま返す。
 * @param {CeilArcCircle} c
 * @param {number} x
 * @returns {number}
 */
export function ceilArcZAt(c, x) {
  if (x <= c.x0) return c.z0;
  if (x >= c.x1) return c.z1;
  const dx = x - c.cx;
  return c.cz + Math.sqrt(Math.max(0, c.r * c.r - dx * dx));
}

/**
 * x の範囲 [xa, xb]（[x0, x1] の内側）の円弧プリミティブ（図の座標＝y 下向き。openings/openingPlanSymbol.js の arc と同形）。
 * 角度は y 下向きの度（arcPathD と同じ式。上側の弧なので −180〜0）。xa >= xb なら null。
 * @param {CeilArcCircle} c
 * @param {number} xa
 * @param {number} xb
 * @param {object} style  weight など線種の属性（そのまま載せる）
 * @returns {object|null}
 */
export function ceilArcPrimitive(c, xa, xb, style) {
  if (!(xb > xa)) return null;
  const ang = x => {
    const dz = -Math.abs(ceilArcZAt(c, x) - c.cz); // 図の y = −z。上側の弧なので中心より上（y が小さい）
    return (Math.atan2(dz, x - c.cx) * 180) / Math.PI;
  };
  const start = ang(xa), end = ang(xb);
  return arc(c.cx, -c.cz, c.r, start, end - start, style);
}

/**
 * 断面エンジンの `cut.ceilProfile` へ渡す弦の列。頭頂を節に、左右とも頭頂から端へ向けて**鉛直差（同じ x での円弧と弦の高さの差）が
 * SAGITTA_MM 以下**になる最長の弦を順に取る（傾きが急な端付近ほど細かく刻む。壁の帯の天端は鉛直差で円弧からずれるため）。
 * 弦の本数は左右とも 2〜MAX_CHORDS/2。上限に当たるとき（半円に近い巨大な円弧）は等角で上限本数に刻み、鉛直差は 1mm を超える（限界）。
 * 端の z は片の元の値、頭頂の z は頭頂の元の値。
 * @param {CeilArcCircle} c
 * @returns {Array<{loX:number, hiX:number, ceilZ:number, ceilZHi:number}>}
 */
export function ceilArcChords(c) {
  const phi = x => Math.atan2(x - c.cx, Math.sqrt(Math.max(0, c.r * c.r - (x - c.cx) ** 2))); // 頂点から測った角（右が正）
  const pt = p => ({ x: c.cx + c.r * Math.sin(p), z: c.cz + c.r * Math.cos(p) });
  // 角 p1→p2 の弦の鉛直差（途中を等間隔に標本）
  const deviation = (p1, p2) => {
    const a = pt(p1), b = pt(p2);
    if (Math.abs(b.x - a.x) < FLOAT_EPS) return 0;
    let worst = 0;
    for (let k = 1; k <= 7; k++) {
      const q = pt(p1 + ((p2 - p1) * k) / 8);
      worst = Math.max(worst, q.z - (a.z + ((q.x - a.x) * (b.z - a.z)) / (b.x - a.x)));
    }
    return worst;
  };
  // 頭頂の角 pa から端の角 pe へ向かう弦の節の角列（pa を含まず pe を含む）
  const halfAngles = (pa, pe) => {
    const out = [];
    let p = pa;
    const dir = pe >= pa ? 1 : -1;
    while ((pe - p) * dir > 1e-12) {
      if (out.length >= MAX_CHORDS / 2) return null;
      let lo = 0, hi = Math.abs(pe - p); // lo: 条件を満たす, hi: 上限
      if (deviation(p, pe) <= SAGITTA_MM) lo = hi;
      else for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (deviation(p, p + dir * mid) <= SAGITTA_MM) lo = mid; else hi = mid; }
      p = lo >= Math.abs(pe - p) - 1e-12 ? pe : p + dir * lo;
      out.push(p);
    }
    if (out.length < 2) { // 最低 2 本（左右で計 4 本）: 等角に割り直す
      return [pa + (pe - pa) / 2, pe];
    }
    return out;
  };
  const equalAngles = (pa, pe) => Array.from({ length: MAX_CHORDS / 2 }, (_, i) => pa + ((pe - pa) * (i + 1)) / (MAX_CHORDS / 2));
  const pa = phi(c.xa);
  const right = halfAngles(pa, phi(c.x1)) ?? equalAngles(pa, phi(c.x1));
  const left = halfAngles(pa, phi(c.x0)) ?? equalAngles(pa, phi(c.x0));
  const nodes = [
    { x: c.x0, z: c.z0 },
    ...left.slice(0, -1).reverse().map(pt),
    { x: c.xa, z: c.za },
    ...right.slice(0, -1).map(pt),
    { x: c.x1, z: c.z1 },
  ];
  const out = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    out.push({ loX: nodes[i].x, hiX: nodes[i + 1].x, ceilZ: nodes[i].z, ceilZHi: nodes[i + 1].z });
  }
  return out;
}

/**
 * 区間を [loX, hiX]（元の区間の内側）へ切り詰めた小片の天井の項目 {chMm, chHiMm, ceilArc?}（床基準の高さ）。
 * 両端の高さは元の区間の形（円弧は元の円、傾斜は直線）から取り直し、頭頂が小片の外ならceilArcを外す（戻り値に含めない）。
 * 傾いていない区間（chHiMm 無し）は元のままの {chMm}。下階が一部だけ覆う面で区間を割るとき（elevationVoid.js）に使う。
 * @param {{loX:number, hiX:number, floorDeltaMm?:number, chMm?:number, chHiMm?:number, ceilArc?:{alongX:number, chMm:number}}} seg
 * @param {number} loX
 * @param {number} hiX
 * @returns {{chMm:number|undefined, chHiMm?:number, ceilArc?:{alongX:number, chMm:number}}}
 */
export function sliceCeilSeg(seg, loX, hiX) {
  if (seg.chHiMm == null || !(seg.hiX > seg.loX)) return { chMm: seg.chMm };
  if (loX === seg.loX && hiX === seg.hiX) return { chMm: seg.chMm, chHiMm: seg.chHiMm, ...(seg.ceilArc ? { ceilArc: seg.ceilArc } : {}) };
  const circle = ceilArcCircleOf(seg);
  const fd = seg.floorDeltaMm ?? 0;
  const at = x => (circle ? ceilArcZAt(circle, x) - fd : seg.chMm + ((seg.chHiMm - seg.chMm) * (x - seg.loX)) / (seg.hiX - seg.loX));
  const apexInside = circle && circle.xa > loX + END_MARGIN_MM && circle.xa < hiX - END_MARGIN_MM;
  return { chMm: at(loX), chHiMm: at(hiX), ...(apexInside ? { ceilArc: seg.ceilArc } : {}) };
}
