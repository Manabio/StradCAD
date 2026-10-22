/**
 * 天伏（見上げ）の切断高の解決（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。唯一の供給源。
 *
 * 規則（ユーザー裁定 2026-10-22。2026-10-18 の「階の 1 値＋低い部屋の例外」を一般化した）:
 *   1. 切断高は部屋ごとに定める。部屋の切断高＝その部屋の天井面の最低点の直下（最低点 − CUT_BELOW_CEILING_MM＝2·DEFAULT_EPS_MM。
 *      裁定の「直下（−eps）」から、壁・柱の遮蔽を効かせるため eps だけ下げた。定数の注を参照）。見上げの鏡像で天井面が
 *      「切断面のすぐ下に見える」側に入る。部屋に複数の天井高さ（区画・傾斜・円弧・ドーム）があれば最低点＝最小。階の値より天井が高い部屋も
 *      その部屋の天井直下で切る。
 *      天井面の最低点は、天伏の立体（plan/planSolids.js ceilingSolids）と同じ ceilingShapeSolidZ の zLo（flat＝zMm、sloped/arc/dome＝基準高 baseZ＝最低点）。
 *      床段差込みの絶対 z（FL=0 基準）。
 *   2. 部分指定の子（Room.referenceRoomIds）は親とまとめて 1 部屋（親と全ての子の天井面の最小。共有する参照で連なる部屋も同じ群）。
 *   3. 天井の無い所（吹抜け・屋外・階段吹抜け STAIR_VOID の平らな面・天井なしの部屋・索引外のセル）は階の値 baseCutMm
 *      （ceilingCutHeightMmOf(plane)。メニュー「天伏切断高」・ダイアログで指定）。
 *   4. 壁の切断高は両側の低い方。ただし天井のある側だけで決め、両側とも天井が無ければ階の値。壁の長さ方向で接する部屋が替わる場合は
 *      位置ごとに決まる（wallCutAt）。壁の両側＝壁の軸（通り）の ±SIDE_SAMPLE_MM の点が属する天井面の部屋。
 *      cutZAt は、点が壁の帯（wallConcealRange × 壁の長さ方向の範囲。閉区間）の中にあれば壁の切断高、そうでなければ点が属する部屋の切断高を返す
 *      （壁の帯は軸をまたぐので、部屋だけで引くと壁が軸の両側で別の高さに切られてしまう）。帯が重なる所（T 字・十字）は小さい方。
 *      角の取り合いのために壁の立体が延びる角の小片は、端が直交壁の帯に接する壁の帯を向こう側の面まで延ばして含める（extendBandsToCorners）。
 *   5. 天井より低い梁（下がり梁。ユーザー裁定 2026-10-22）がある部屋は、梁型が見える位置まで切断高を下げる。範囲は部屋全体（部分指定の親子は群の最小）。
 *      部屋の切断高＝min(天井面の最低点, 部屋の中に見える下がり梁の下端の最小) − CUT_BELOW_CEILING_MM。壁の切断高もこの部屋の値に従う。
 *      下がり梁＝自階の梁（planSolids の beamSolids）のうち、(i) 下端 zLo が、足元と重なる天井面の重なりの中の最高点（傾斜・円弧・ドームは ceilingShape.js の zMaxIn で正確に取る）より eps を超えて下にあり、
 *      (ii) 足元から壁の帯を差し引いた残りが、その天井面の矩形と面積（両辺とも DROPPED_BEAM_MIN_OVERLAP_MM 超）を持って重なり、
 *      (iii) 下端がその部屋の床面（床段差込み）より eps を超えて上にある（床梁＝天端が床面で下端が床より下の梁は、部屋の中に見えないので除く）もの。
 *      壁の帯の中に収まる梁・天井より上の梁・床梁・天井の無い所の梁では下げない。下がり梁の id は droppedBeams で返す（外形の中線は呼び出し側）。
 *
 * 全部屋の切断高が階の値と同じ（天井のある部屋が無い場合を含む）なら uniform（呼び元は数値の切断高で解いてよい。出力不変）。
 * 部屋ごとの切断高の違いを図に示す注記は出さない（未裁定）。
 */
import { ceilingCutHeightMmOf, RoomFeature } from '@core';
import { buildCeilingHeightField } from './ceilingHeightField.js';
import { ceilingShapeSolidZ } from './ceilingShape.js';
import { wallConcealRange } from '../finish/columnWrap.js';
import { DEFAULT_EPS_MM } from '../plan/planSectionFigure.js';
import { beamSolids } from '../plan/planSolids.js';
import { subtractRects } from '../plan/planGeometry.js';

// 下がり梁の足元（壁の帯を差し引いた残り）と天井面の矩形が「面積を持って重なる」とみなす、両辺の重なりの下限(mm)
const DROPPED_BEAM_MIN_OVERLAP_MM = 1;

/** 壁の軸から両側の部屋を引くときの、軸からの距離(mm)（隣のセルの内側に入る程度。finish/kneeDropWall.js の旧 SIDE_SAMPLE_MM と同じ値）。 */
export const SIDE_SAMPLE_MM = 10;

// 壁の帯の閉区間の許容(mm)。立体の辺は帯の境界の上にあり、float の丸めだけを吸収する
const BAND_TOL_MM = 1e-3;

// 壁の帯の索引の格子の大きさ(mm)
const BUCKET_MM = 2000;

/**
 * 切断面を天井面の最低点より下げる量(mm)。解決器の遮蔽は「相手の天端が eps を**超えて**高い」ときに隠す（planSectionFigure.js hidesAt (i)）。
 * 天井面と同じ高さまで届く壁・柱（cut の立体は天端＝切断面）が天井の外形線を隠すには、切断面が天井面より eps を超えて下になければならない。
 * 天井面の −eps ちょうどだと天端の差が eps で隠せず、壁の軸・帯や柱の中の天井の縁が線として出てしまう（実測: 13.stq 1 階 22→97 本）ので
 * 2·eps 下げる。天井面は切断面より eps 以内に上にあるので従来どおり「見える側（below）」に入る。
 */
const CUT_BELOW_CEILING_MM = 2 * DEFAULT_EPS_MM;

/**
 * 壁の帯の長さ方向の端を、接する直交壁の帯の向こう側の面まで延ばす（bands を直接更新）。壁の立体は取り合いの角を閉じるために
 * 端を延ばす（plan/planSolids.js withJoinedCorners）が、角の小片はどの壁の長さ範囲にも入らず、部屋の切断高で引かれて壁の天端が
 * 天井面より高くならない。端が直交壁の帯の中（閉区間）で、その壁の長さ範囲と帯が重なる（接する）ときだけ延ばす。
 */
function extendBandsToCorners(bands) {
  const ext = bands.map(() => ({ lo: null, hi: null }));
  bands.forEach((b, i) => {
    for (const p of bands) {
      if (p.vertical === b.vertical) continue;
      if (p.aLo > b.hi + BAND_TOL_MM || p.aHi < b.lo - BAND_TOL_MM) continue; // p の長さ範囲が b の帯に届かない
      if (b.aLo >= p.lo - BAND_TOL_MM && b.aLo <= p.hi + BAND_TOL_MM) ext[i].lo = Math.min(ext[i].lo ?? Infinity, p.lo);
      if (b.aHi >= p.lo - BAND_TOL_MM && b.aHi <= p.hi + BAND_TOL_MM) ext[i].hi = Math.max(ext[i].hi ?? -Infinity, p.hi);
    }
  });
  bands.forEach((b, i) => {
    if (ext[i].lo != null) b.aLo = Math.min(b.aLo, ext[i].lo);
    if (ext[i].hi != null) b.aHi = Math.max(b.aHi, ext[i].hi);
  });
}

/** 部分指定の親子を 1 つの群にする（room.id → 群の代表 id）。参照先が無い（消えた）部屋の id は無視する。 */
function roomGroupsOf(graph) {
  const parent = new Map();
  const find = id => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let c = id; parent.get(c) !== r;) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  for (const room of graph.rooms) parent.set(room.id, room.id);
  for (const room of graph.rooms) {
    for (const refId of room.referenceRoomIds ?? []) {
      if (!parent.has(refId)) continue;
      const a = find(room.id), b = find(refId);
      if (a !== b) parent.set(a, b);
    }
  }
  return find;
}

/**
 * @param {object|null} graph  null は天井なし（全域が基本の高さ）
 * @param {{baseCutMm?: number, beamSolids?: Array<object>}} [opts]  baseCutMm＝天井の無い所の切断高。省略は ceilingCutHeightMmOf(graph?.plane)。
 *   beamSolids＝自階（層の床 z=0）の梁の立体（planSolids の kind 'beam'）。省略は graph の梁から作る（作ると重いので、立体を作った呼び元は渡す）
 * @returns {{
 *   baseCutMm: number,
 *   roomCutMm: Map<string, number>,
 *   rooms: Array<{roomId: string, minCeilingZ: number, cutMm: number}>,
 *   droppedBeams: Array<{beamId: string, zLo: number, roomIds: string[]}>,
 *   uniform: boolean,
 *   cutZAt: (x: number, y: number) => number,
 *   wallCutAt: (isVertical: boolean, axisMm: number, alongMm: number) => number,
 *   wallFloorAt: (isVertical: boolean, axisMm: number, alongMm: number) => number,
 *   range: {min: number, max: number},
 * }}  roomCutMm・rooms＝天井面を持つ全ての部屋（部分指定の子は親と同じ値）。range＝cutZAt の取りうる範囲（基本の高さを含む）。
 *   uniform＝cutZAt がどこでも baseCutMm（数値の切断高と同じ）
 */
export function ceilingCutResolverOf(graph, opts = {}) {
  const baseCutMm = Number.isFinite(opts.baseCutMm) ? opts.baseCutMm : ceilingCutHeightMmOf(graph?.plane);
  const field = buildCeilingHeightField(graph);
  const groupOf = graph ? roomGroupsOf(graph) : id => id;
  const minZByGroup = new Map(); // 群 id → 全ての面の天井面の最低点
  const ceilingRoomIds = new Set();
  const ceilingFaces = []; // 天井のある面: {s, zAt（面の高さ。形状つきは位置で替わる）}
  for (const s of field.surfaces) {
    if (graph.roomMap.get(s.roomId)?.feature === RoomFeature.STAIR_VOID) continue; // 階段吹抜けの平らな面は天井の無い所（基本の高さ）
    const solidZ = ceilingShapeSolidZ({ shape: s.shape, dims: s.dims, baseZ: s.zMm, rects: s.rects });
    const z = solidZ.zLo;
    if (!Number.isFinite(z)) continue;
    const g = groupOf(s.roomId);
    minZByGroup.set(g, Math.min(minZByGroup.get(g) ?? Infinity, z));
    ceilingRoomIds.add(s.roomId);
    ceilingFaces.push({ s, zAt: solidZ.zAt ?? (() => s.zMm), zMaxIn: solidZ.zMaxIn ?? null, top: Number.isFinite(solidZ.zHi) ? solidZ.zHi : z });
  }

  // 壁の帯: {vertical, axis, lo, hi（軸と直交の範囲）, aLo, aHi（長さ方向の範囲）, oLo, oHi（角へ延ばす前の長さ範囲）}。初回の問い合わせで組む
  let bandsMemo = null;
  const bandsOf = () => {
    if (bandsMemo) return bandsMemo;
    const bands = [];
    for (const wall of graph?.walls ?? []) {
      const cr = wallConcealRange(wall);
      const axis = wall.axisCL?.effectiveValue;
      if (!cr || !Number.isFinite(axis) || ![wall.coord1, wall.coord2, cr.lo, cr.hi].every(Number.isFinite)) continue;
      const aLo = Math.min(wall.coord1, wall.coord2), aHi = Math.max(wall.coord1, wall.coord2);
      // oLo・oHi: 両側の部屋を引く位置は角へ延ばす前の範囲へ寄せる
      bands.push({ vertical: !!wall.isVertical, axis, lo: cr.lo, hi: cr.hi, aLo, aHi, oLo: aLo, oHi: aHi, table: null });
    }
    extendBandsToCorners(bands);
    return (bandsMemo = bands);
  };

  // 下がり梁（規則 5）: 自階の梁の足元から壁の帯を引いた残りが、天井面の矩形と面積を持って重なり、下端がその天井面より eps を超えて下にある梁
  const beamMinByGroup = new Map(); // 群 id → 下がり梁の下端の最小
  const droppedBeams = []; // {beamId, zLo, roomIds}
  if (graph && ceilingFaces.length > 0 && (Array.isArray(opts.beamSolids) ? opts.beamSolids.length : (graph.beams?.length ?? 0)) > 0) {
    let cuttersMemo = null; // 壁の帯の矩形。足元の計算に進む梁が現れるまで組まない
    const cuttersOf = () => cuttersMemo ?? (cuttersMemo = bandsOf().map(b => (b.vertical
      ? { x1: b.lo, x2: b.hi, y1: b.aLo, y2: b.aHi } : { x1: b.aLo, x2: b.aHi, y1: b.lo, y2: b.hi })));
    // 速い除外: 下端がどの部屋の床面より上にも無い（床梁）・どの天井面の最高点より下にも無い梁は、足元の計算をしない
    const lowestFloor = Math.min(...ceilingFaces.map(f => f.s.zMm - f.s.chMm));
    const highestCeiling = Math.max(...ceilingFaces.map(f => f.top));
    // 梁の立体化（断面の成の解決）は重いので、天端（levelOffset）がどの床面より上にも無い梁（床梁）は先に落とす（下端は天端より上にならない）
    // 呼び元が見上げの立体を作っているなら、その自階の梁の立体を再利用する（opts.beamSolids。同じ beamSolids の出力）
    const ownBeams = Array.isArray(opts.beamSolids)
      ? opts.beamSolids
      : beamSolids({ graph: { beams: (graph.beams ?? []).filter(b => b.levelOffset > lowestFloor + DEFAULT_EPS_MM) }, floorZMm: 0 });
    for (const beam of ownBeams) {
      if (!(beam.zLo > lowestFloor + DEFAULT_EPS_MM && beam.zLo < highestCeiling - DEFAULT_EPS_MM)) continue;
      const roomIds = new Set();
      for (const piece of subtractRects(beam.footprint.rects, cuttersOf())) {
        for (const { s, zAt, zMaxIn } of ceilingFaces) {
          for (const r of s.rects) {
            const w = Math.min(piece.x2, r.x2) - Math.max(piece.x1, r.x1);
            const h = Math.min(piece.y2, r.y2) - Math.max(piece.y1, r.y1);
            if (!(w > DROPPED_BEAM_MIN_OVERLAP_MM && h > DROPPED_BEAM_MIN_OVERLAP_MM)) continue;
            // 床梁（天端が床面で、下端が床より下＝床組の中）は部屋の中に見えないので対象にしない: 梁が床面（床段差込み）より上に収まること
            const floorZ = s.zMm - s.chMm;
            if (!(beam.zLo > floorZ + DEFAULT_EPS_MM)) continue;
            // 重なりの中の天井面の最高点（傾斜・円弧・ドームは位置で替わる。zMaxIn が正確に取る。平らな面は 1 点）。梁がそれより下なら天井より下に見える
            const overlap = { x1: Math.max(piece.x1, r.x1), x2: Math.min(piece.x2, r.x2), y1: Math.max(piece.y1, r.y1), y2: Math.min(piece.y2, r.y2) };
            const ceilTop = zMaxIn ? zMaxIn(overlap) : zAt(overlap.x1, overlap.y1);
            if (beam.zLo < ceilTop - DEFAULT_EPS_MM) roomIds.add(s.roomId);
          }
        }
      }
      if (roomIds.size === 0) continue;
      droppedBeams.push({ beamId: beam.source.id, zLo: beam.zLo, roomIds: [...roomIds] });
      for (const roomId of roomIds) {
        const g = groupOf(roomId);
        beamMinByGroup.set(g, Math.min(beamMinByGroup.get(g) ?? Infinity, beam.zLo));
      }
    }
  }

  const roomCutMm = new Map();
  const rooms = [];
  for (const roomId of ceilingRoomIds) {
    const g = groupOf(roomId);
    const minCeilingZ = minZByGroup.get(g);
    const cutMm = Math.min(minCeilingZ, beamMinByGroup.get(g) ?? Infinity) - CUT_BELOW_CEILING_MM;
    roomCutMm.set(roomId, cutMm);
    rooms.push({ roomId, minCeilingZ, cutMm });
  }
  const uniform = [...roomCutMm.values()].every(v => v === baseCutMm);

  // 点が属する天井のある部屋の切断高。天井の無い所（面が無い・階段吹抜け）は null
  const roomCutAt = (x, y) => {
    const surface = field.surfaceAt(x, y);
    return surface ? (roomCutMm.get(surface.roomId) ?? null) : null;
  };
  // 壁の両側（軸 ±SIDE_SAMPLE_MM）の天井のある部屋の切断高の小さい方。両側とも無ければ基本の高さ
  const wallCutAt = (isVertical, axisMm, alongMm) => {
    let min = Infinity;
    for (const across of [axisMm - SIDE_SAMPLE_MM, axisMm + SIDE_SAMPLE_MM]) {
      const c = isVertical ? roomCutAt(across, alongMm) : roomCutAt(alongMm, across);
      if (c != null && c < min) min = c;
    }
    return min === Infinity ? baseCutMm : min;
  };
  // 壁の両側（軸 ±SIDE_SAMPLE_MM）の天井のある部屋の床面（床段差込みの絶対 z。天井面 zMm − 天井高 chMm）の低い方。両側とも無ければ 0（FL）。
  // 建具の下端・上端（床からの高さ）を切断高と同じ絶対 z に揃えるために使う（ceilingOpeningVisibility.js）。
  const wallFloorAt = (isVertical, axisMm, alongMm) => {
    let min = Infinity;
    for (const across of [axisMm - SIDE_SAMPLE_MM, axisMm + SIDE_SAMPLE_MM]) {
      const s = isVertical ? field.surfaceAt(across, alongMm) : field.surfaceAt(alongMm, across);
      if (s && roomCutMm.has(s.roomId)) min = Math.min(min, s.zMm - s.chMm);
    }
    return min === Infinity ? 0 : min;
  };

  // 壁の帯の索引。cutZAt の最初の呼び出しまで組まない（wallCutAt だけを使う呼び出し側＝ShapesLayer は組まずに済む）
  let index = null;
  const indexOf = () => {
    if (index) return index;
    const bands = bandsOf();
    // 格子のバケット: 帯の外接矩形（許容ぶん広げる）が掛かる格子へ入れる
    const buckets = new Map();
    for (const b of bands) {
      const [x1, x2, y1, y2] = b.vertical ? [b.lo, b.hi, b.aLo, b.aHi] : [b.aLo, b.aHi, b.lo, b.hi];
      for (let i = Math.floor((x1 - BAND_TOL_MM) / BUCKET_MM); i <= Math.floor((x2 + BAND_TOL_MM) / BUCKET_MM); i++) {
        for (let j = Math.floor((y1 - BAND_TOL_MM) / BUCKET_MM); j <= Math.floor((y2 + BAND_TOL_MM) / BUCKET_MM); j++) {
          const k = `${i},${j}`;
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(b);
        }
      }
    }
    // 天井面の矩形の辺（長さ方向の切れ目の候補）
    const xEdges = new Set(), yEdges = new Set();
    for (const s of field.surfaces) for (const r of s.rects) { xEdges.add(r.x1); xEdges.add(r.x2); yEdges.add(r.y1); yEdges.add(r.y2); }
    return (index = { buckets, xEdges, yEdges });
  };
  // 帯 b の長さ方向の壁の切断高は、面の矩形の辺で区切った区間ごとに一定（区間の中と切れ目の点で別々に引いて持つ）
  const wallTableOf = (b, edges) => {
    if (b.table) return b.table;
    const { oLo, oHi } = b; // 角へ延ばす前の長さ範囲。この外の位置は端の値（bandWallCutAt）
    const bps = [...new Set([oLo, oHi, ...[...edges].filter(v => v > oLo && v < oHi)])].sort((p, q) => p - q);
    const atPoint = bps.map(v => wallCutAt(b.vertical, b.axis, v));
    const inside = bps.slice(0, -1).map((v, i) => wallCutAt(b.vertical, b.axis, (v + bps[i + 1]) / 2));
    return (b.table = { bps, atPoint, inside });
  };
  const bandWallCutAt = (b, along, edges) => {
    const { bps, atPoint, inside } = wallTableOf(b, edges);
    // 角へ延ばした範囲（oLo より小さい・oHi より大きい位置）は両端の値（元の長さ範囲の端の点）
    if (along <= bps[0]) return atPoint[0];
    if (along >= bps[bps.length - 1]) return atPoint[bps.length - 1];
    let lo = 0, hi = bps.length - 1; // bps[lo] <= along の最大の lo
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bps[m] <= along) lo = m; else hi = m - 1; }
    return bps[lo] === along ? atPoint[lo] : inside[lo];
  };
  const cutZAt = uniform
    ? () => baseCutMm
    : (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return baseCutMm;
      const { buckets, xEdges, yEdges } = indexOf();
      let wallMin = Infinity;
      for (const b of buckets.get(`${Math.floor(x / BUCKET_MM)},${Math.floor(y / BUCKET_MM)}`) ?? []) {
        const across = b.vertical ? x : y, along = b.vertical ? y : x;
        if (across < b.lo - BAND_TOL_MM || across > b.hi + BAND_TOL_MM || along < b.aLo - BAND_TOL_MM || along > b.aHi + BAND_TOL_MM) continue;
        wallMin = Math.min(wallMin, bandWallCutAt(b, along, b.vertical ? yEdges : xEdges));
      }
      if (wallMin !== Infinity) return wallMin;
      return roomCutAt(x, y) ?? baseCutMm;
    };
  const range = { min: Math.min(baseCutMm, ...roomCutMm.values()), max: Math.max(baseCutMm, ...roomCutMm.values()) };
  return { baseCutMm, roomCutMm, rooms, droppedBeams, uniform, cutZAt, wallCutAt, wallFloorAt, range };
}
