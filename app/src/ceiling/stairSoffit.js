/**
 * 階段の裏面（天伏の見上げ。S13a。純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * N 階の天伏で、N の階段の足元の上にある N+1 階の階段（N の続き）を裏から見た姿のうち、**木造階段の傾斜天井**の立体を作る。
 * 階段裏に天井材仕上げがあるので踏面線は描かず、傾斜する天井面（kind 'ceiling'＝面材として遮蔽に参加）だけを返す。
 * 鉄骨階段は踏面線を全段描く（planSolids が stairTread を drawEdges:true にする側）ので、ここでは [] を返す。
 *
 * **階段 1 本につき 1 つの立体**（source.part は 0）。別々の立体が接する辺で線が 2 重・ずれるのを根本から無くすため、
 * 往路・回転部・復路の矩形を 1 つの footprint.rects にまとめ、面の折れ目は innerLines（role 'stairSoffitFold'）で描く
 * （同じ立体の矩形どうしの共有辺は輪郭として描かれない）。
 *
 * 高さは層の FL（N+1 の FL = floorZMm）基準の絶対 z。段 k の天端 = floorZMm + k × 蹴上（stairTreadFootprints と同じ）。
 * 裏面 = 天端 − dz。dz = STAIR_SOFFIT_THICKNESS_MM / cosθ（階段の傾斜に直交して測った厚みの垂直方向への換算。tanθ = 蹴上 / 踏面）。
 *   往路   … 矩形 R_A（幅 s0〜sA × 上り口 baseA 〜 回転部の前縁 turnFront）。baseA で「当該階天井」（N の階段の対の部屋の CH＋床段差。
 *            N の FL 基準の値で floorZMm は足さない。対の部屋が無ければ DEFAULT_ROOM_CEILING_HEIGHT）→ turnFront で 回転部の最初の段の天端 − dz zA の線形。
 *   回転部 … 前縁 turnFront は両レーン共通（frontA と front のうち back に近い方＝隔て板の端）。往路側 Q_A（s0〜sA × turnFront〜back）と
 *            復路側 Q_B（sB〜s1 × turnFront〜back）を、隔て板の角点 (sA, turnFront)／(sB, turnFront) から外側の奥の角 (s0, back)／(s1, back) への
 *            対角線（45 度相当）で 2 つの三角形に分け、計 4 三角の平面で表す（回転部の段数によらない）。隔て板の延長の帯 S（sA〜sB）は双線形。
 *            頂点の高さは回転部を角度で等分: 角点・前縁の角 = zA（往路側）／zB（復路側）、外側の奥の角 = zA+Δ/4・zA+3Δ/4、
 *            内側の奥 I = zA+Δ/2。Δ = zB − zA = 回転部固有の蹴上 × 蹴上（回転部のマス数−1）。踊り場（マス数 1）は Δ=0 で平ら。
 *            角度等分は「段数によらず 4 三角」から導いた既定（ユーザー裁定待ち）。
 *   復路   … 矩形 R_B（幅 sB〜s1 × turnFront 〜 到達辺 baseB）。turnFront で 最後の回転部マスの天端 − dz zB → baseB で 総蹴上の天端 − dz の線形。
 *   直進系 … STRAIGHT は base → end の 1 矩形、STRAIGHT_LANDING は 直進部1 → 踊り場（平ら）→ 直進部2 の 3 矩形（区間ごとの線形）。
 * 既知の限界: 取りつき回転部（側面の出入口）を往路の平面に含める／L_TURN・FLARED・OPEN_WELL・蹴上が求まらない階段は裏面なし。
 */
import { StairType, StructuralMaterialType, DEFAULT_ROOM_CEILING_HEIGHT } from '@core';
import { STAIR_SOFFIT_THICKNESS_MM } from '../core/constants.js'; // 公開 API（core.js）には出さない内部定数
import { uTurnPlanLayout, straightPlanLayout } from '../finish/stair/stairGeometry.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';

const MIN_SPAN_MM = 1; // 矩形の辺の下限（これ未満は潰れた区間として作らない）
const FOLD_ROLE = 'stairSoffitFold'; // 面の折れ目（innerLines の role）

/**
 * 当該階天井（N の FL 基準の mm）: N の階段の対の部屋の CH＋床段差。対の部屋が無ければ既定の天井高。
 * 床段差＋CH の式は ceiling/ceilingSurfaces.js と同じ（共通化は別件）。
 */
export function stairBelowCeilingMm(belowStair, belowGraph) {
  const room = belowStair?.roomId != null ? belowGraph?.rooms?.find(r => r.id === belowStair.roomId) : null;
  if (!room || !belowGraph) return DEFAULT_ROOM_CEILING_HEIGHT;
  const floorStep = belowGraph.effectiveFloorLevel(room) - belowGraph.effectiveFloorLevel(null);
  return roomCeilingHeight(belowGraph, room).mm + floorStep;
}

const clamp01 = t => Math.min(Math.max(t, 0), 1);

/**
 * 立体の組み立て。座標は (a, r)＝（幅方向, 走行方向）で扱い、vertical（走行が y）かどうかで世界座標 (x, y) へ写す。
 * 部品 piece＝{ a0, a1, r0, r1（順不同の矩形範囲）, z(a, r) }。zAt は最寄りの部品の範囲へクランプした点で z を求める。
 */
function makeAssembler(vertical) {
  const toWorld = (a, r) => (vertical ? { x: a, y: r } : { x: r, y: a });
  const toAR = (x, y) => (vertical ? [x, y] : [y, x]);
  const piece = (a0, a1, r0, r1, z) => {
    if (![a0, a1, r0, r1].every(Number.isFinite)) return null;
    if (Math.abs(a1 - a0) < MIN_SPAN_MM || Math.abs(r1 - r0) < MIN_SPAN_MM) return null;
    return { a0: Math.min(a0, a1), a1: Math.max(a0, a1), r0: Math.min(r0, r1), r1: Math.max(r0, r1), z };
  };
  /** 走行方向 rs → re で zs → ze と線形に変わる部品（クランプ）。 */
  const ramp = (a0, a1, rs, re, zs, ze) => piece(a0, a1, rs, re, (a, r) => zs + (ze - zs) * clamp01((r - rs) / (re - rs)));
  const rectOf = p => {
    const A = toWorld(p.a0, p.r0), B = toWorld(p.a1, p.r1);
    return { x1: Math.min(A.x, B.x), y1: Math.min(A.y, B.y), x2: Math.max(A.x, B.x), y2: Math.max(A.y, B.y) };
  };
  const line = (a0, r0, a1, r1) => {
    const A = toWorld(a0, r0), B = toWorld(a1, r1);
    return { points: [A.x, A.y, B.x, B.y], role: FOLD_ROLE };
  };
  /** 部品と折れ目の線から立体を作る。部品が無い・z が有限でないときは null。 */
  const solid = (pieces, innerLines, zValues) => {
    const ps = pieces.filter(Boolean);
    if (ps.length === 0 || !zValues.every(Number.isFinite)) return null;
    const out = { footprint: { rects: ps.map(rectOf) }, zLo: Math.min(...zValues), zHi: Math.max(...zValues) };
    if (out.zLo !== out.zHi) {
      out.zAt = (x, y) => {
        const [a, r] = toAR(x, y);
        let best = null, bestD = Infinity, ba = 0, br = 0;
        for (const p of ps) {
          const ca = Math.min(Math.max(a, p.a0), p.a1), cr = Math.min(Math.max(r, p.r0), p.r1);
          const d = Math.hypot(a - ca, r - cr);
          if (d < bestD - 1e-9) { best = p; bestD = d; ba = ca; br = cr; }
        }
        return best.z(ba, br);
      };
    }
    if (innerLines.length > 0) out.innerLines = innerLines;
    return out;
  };
  return { piece, ramp, line, solid };
}

/** 三角形 (a,r,z)×3 の平面で z を求める（重心座標。三角形の外へも外挿する）。 */
function planeOf(p, q, s) {
  const det = (q[1] - s[1]) * (p[0] - s[0]) + (s[0] - q[0]) * (p[1] - s[1]);
  return (a, r) => {
    const l1 = ((q[1] - s[1]) * (a - s[0]) + (s[0] - q[0]) * (r - s[1])) / det;
    const l2 = ((s[1] - p[1]) * (a - s[0]) + (p[0] - s[0]) * (r - s[1])) / det;
    return l1 * p[2] + l2 * q[2] + (1 - l1 - l2) * s[2];
  };
}

/**
 * 回転部の矩形を、隔て板の角点 P（レーン内側の辺と前縁の交点）から外側の奥の角 O への対角線で 2 つの三角形（P,F,O）（P,O,I）に分けた部品。
 * F＝前縁の外側の角、I＝内側の奥の角。頂点は [a, r, z]。点がどちらの側にあるかで平面を選ぶ。
 */
function turnQuad(asm, rect, { P, F, O, I }) {
  const triF = planeOf(P, F, O);
  const triI = planeOf(P, O, I);
  const side = (a, r) => (O[0] - P[0]) * (r - P[1]) - (O[1] - P[1]) * (a - P[0]); // 対角線のどちら側か（外積の符号）
  const sF = side(F[0], F[1]);
  return asm.piece(rect.a0, rect.a1, rect.r0, rect.r1, (a, r) => (side(a, r) * sF >= 0 ? triF(a, r) : triI(a, r)));
}

/** 幅方向の 2 点のうち基準 base に近い方（across の向き＝s0<s1 か s0>s1 を仮定しないため、大小でなく距離で選ぶ）。 */
const nearerTo = (base, x, y) => (Math.abs(x - base) <= Math.abs(y - base) ? x : y);

/**
 * uTurnPlanLayout の戻り値 L から U 字系の裏面の立体を作る（幾何の本体。layout を模した入力で単体テストできるよう export）。
 * 幅方向の向き（s0<s1 でも s0>s1 でも）・走行方向の向き・vertical のどれでも成り立つ（矩形は normalize、端は基準の辺からの距離で選ぶ）。
 * 回転部の前縁 turnFront は両レーン共通（frontA と front のうち back に近い方＝隔て板の端）。ピボット（柱の面）は使わない。
 * @param {object} L uTurnPlanLayout の戻り値
 * @param {{zStart:number, zTop:(n:number)=>number}} ctx
 */
export function uTurnSoffitFromLayout(L, { zStart, zTop }) {
  const { run, across, vertical } = L;
  const asm = makeAssembler(vertical);
  const lastTurn = L.firstTurnNumber + L.turnCells - 1;
  const zA = zTop(L.firstTurnNumber), zB = zTop(lastTurn), zEnd = zTop(L.totalSteps);
  const delta = zB - zA; // 回転部固有の蹴上 × 蹴上（踊り場は 0）
  const { s0, sA, sB, s1 } = across;
  const back = run.back;
  // 回転部の前縁（両レーン共通＝隔て板の端）。uTurnLayout の不変条件（tPB > tPA）により常に front が back に近いので実質 run.front だが、
  // レイアウトの前提を裏面側で仮定しないため「back に近い方」で選ぶ（柱なし・踊り場では frontA == front）
  const tf = nearerTo(back, run.frontA, run.front);
  const zI = zA + delta / 2;

  const rA = asm.ramp(s0, sA, run.baseA, tf, zStart, zA);
  const rB = asm.ramp(sB, s1, tf, run.baseB, zB, zEnd);
  // 回転部 A（往路側）: P_A=(sA, tf)＝隔て板の角点・F_A=(s0, tf)・O_A=(s0, back)・I_A=(sA, back)
  // 回転部 B（復路側）: P_B=(sB, tf)・F_B=(s1, tf)・O_B=(s1, back)・I_B=(sB, back)
  const qA = turnQuad(asm, { a0: s0, a1: sA, r0: tf, r1: back }, {
    P: [sA, tf, zA], F: [s0, tf, zA], O: [s0, back, zA + delta / 4], I: [sA, back, zI],
  });
  const qB = turnQuad(asm, { a0: sB, a1: s1, r0: tf, r1: back }, {
    P: [sB, tf, zB], F: [s1, tf, zB], O: [s1, back, zA + 3 * delta / 4], I: [sB, back, zI],
  });
  if (!qA || !qB) return null; // 回転部が潰れている（求まらない）
  // 隔て板の延長の帯 S（sA〜sB のあき）: 前縁で zA → zB（幅方向に線形）、奥は zI。run 方向に線形（双線形）
  const band = asm.piece(sA, sB, tf, back, (a, r) => {
    const u = clamp01((a - sA) / (sB - sA)), t = clamp01((r - tf) / (back - tf));
    return (zA + (zB - zA) * u) * (1 - t) + zI * t;
  });

  const lines = [];
  // 回転部の前縁（両レーン共通の 1 本）。帯 S の前の辺は矩形の輪郭として出るので、足すのは同じ立体の共有辺の部分（R_A/R_B との境）だけ
  if (rA) lines.push(asm.line(s0, tf, sA, tf));
  if (rB) lines.push(asm.line(sB, tf, s1, tf));
  if (delta > 0) { // 対角線（隔て板の角点から外側の奥の角へ）。踊り場は平らなので描かない
    lines.push(asm.line(sA, tf, s0, back));
    lines.push(asm.line(sB, tf, s1, back));
  }
  if (Math.abs(sA - sB) < MIN_SPAN_MM) { // あき 0: 往路/復路の境と回転部 A/B の境（いずれも高さが食い違う共有辺）
    if (rA && rB) {
      const lo = Math.max(Math.min(run.baseA, tf), Math.min(tf, run.baseB));
      const hi = Math.min(Math.max(run.baseA, tf), Math.max(tf, run.baseB));
      if (hi - lo >= MIN_SPAN_MM) lines.push(asm.line(sA, lo, sA, hi));
    }
    if (delta > 0) lines.push(asm.line(sA, tf, sA, back));
  }
  return asm.solid([rA, qA, band, qB, rB], lines, [zStart, zA, zB, zEnd, zA + delta / 4, zI, zA + 3 * delta / 4]);
}

function uTurnSolid(stair, graph, ctx) {
  const L = uTurnPlanLayout(stair, graph);
  return L ? uTurnSoffitFromLayout(L, { zStart: ctx.zStart, zTop: ctx.zTop }) : null;
}

function straightSolid(stair, graph, ctx) {
  const L = straightPlanLayout(stair, graph);
  return L ? straightSoffitFromLayout(L, ctx) : null;
}

/** straightPlanLayout の戻り値 L から直進系の裏面の立体を作る（layout を模した入力で単体テストできるよう export）。 */
export function straightSoffitFromLayout(L, { zStart, zTop }) {
  const { run, across, vertical } = L;
  const asm = makeAssembler(vertical);
  const seg = (r0, r1, z0, z1) => asm.ramp(across.s0, across.s1, r0, r1, z0, z1);
  if (!L.hasLanding) {
    const zEnd = zTop(L.totalSteps);
    return asm.solid([seg(run.base, run.end, zStart, zEnd)], [], [zStart, zEnd]);
  }
  const zLand = zTop(L.landingNumber), zEnd = zTop(L.totalSteps);
  const s1 = seg(run.base, run.land1, zStart, zLand), s2 = seg(run.land1, run.land2, zLand, zLand), s3 = seg(run.land2, run.end, zLand, zEnd);
  const lines = []; // 隣り合う部品が両方あるときだけ境の線を出す（潰れた区間の境は出さない）
  if (s1 && s2) lines.push(asm.line(across.s0, run.land1, across.s1, run.land1));
  if (s2 && s3) lines.push(asm.line(across.s0, run.land2, across.s1, run.land2));
  return asm.solid([s1, s2, s3], lines, [zStart, zLand, zEnd]);
}

/**
 * N+1 の階段（木造）の裏面の立体（階段 1 本につき高々 1 つ）。対象外（鉄骨・L_TURN 等・蹴上や踏面が求まらない・レイアウトが null）は []。
 * @param {{
 *   stair: object, graph: object,        N+1 の階段とその階の graph
 *   belowStair?: object|null, belowGraph?: object|null,  N 側の対の階段と graph（当該階天井の算出）
 *   riser: number|null, floorZMm: number  蹴上と N+1 の FL（層の絶対 z）
 * }} args
 * @returns {import('../plan/planSolids.js').Solid[]}
 */
export function stairSoffitSolids({ stair, graph, belowStair = null, belowGraph = null, riser, floorZMm }) {
  if (!stair || !graph || !Number.isFinite(floorZMm)) return [];
  if (stair.structure !== StructuralMaterialType.WOOD) return [];
  if (!(Number.isFinite(riser) && riser > 0) || !(Number.isFinite(stair.tread) && stair.tread > 0)) return [];
  const dz = STAIR_SOFFIT_THICKNESS_MM * Math.sqrt(1 + (riser / stair.tread) ** 2); // 厚み / cosθ
  const ctx = {
    zStart: stairBelowCeilingMm(belowStair, belowGraph),
    zTop: n => floorZMm + n * riser - dz,
  };
  const t = stair.type;
  const solid = t === StairType.SWITCHBACK || t === StairType.WINDING ? uTurnSolid(stair, graph, ctx)
    : t === StairType.STRAIGHT || t === StairType.STRAIGHT_LANDING ? straightSolid(stair, graph, ctx) : null;
  if (!solid) return [];
  return [{ kind: 'ceiling', ...solid, source: { kind: 'stairSoffit', id: String(stair.id), layerFloorZ: floorZMm, part: 0 } }];
}
