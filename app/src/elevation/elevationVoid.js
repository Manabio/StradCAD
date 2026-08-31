/**
 * 展開図: 吹抜け（VOID）部屋の2層帯（WP-V1。設置階下階のFLから設置階の天井高さまで、CLを
 * 合わせて描画）。設計意図は .claude/elevation-model.md 参照。
 *
 * 方式:「自階（吹抜けRoom）の面を下へ延長する」——世界座標は全階共通のため、同じ壁中心線＝
 * 同じ世界座標で自動的にCLが揃う。下階の面リストを別に組んで縦に積む必要は無い。ctx.faceOverride
 * （elevationBand.jsのlayoutBandFacesが公開するフック）で各面のfloorSegmentsを下へずらすだけで
 * 実現する（床が下がる・天井は動かない＝ceilAbs=floorDelta+chMmが不変になるよう変換する）。
 * ただし下へ延長してよいのは**下階に同じ壁が実在する区間だけ**（lowerCoverLocal）。
 */
import { roomBounds } from '../finish/gridCells.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { graphList } from '../graphReadScope.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { findRunCLAt } from './elevationFloorProfile.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildColumns } from './section/sectionEngine.js';
import { emitColumns } from './section/sectionEmit.js';
import { translatePrimitive } from './elevationPrimitives.js';
import { layoutBandFaces, finalizeBand } from './elevationBand.js';

// 2つのワールド矩形が重なるか（面積0の接触は重なりに含めない）。
// elevationStair.jsのfindOverlappingVoidRoomと同じ実装（R: 矩形重なり探索部を共有ヘルパへ切り出し）。
function rectsOverlap(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/**
 * bounds（世界矩形）と重なる predicate 該当Roomを targetGraph から1つ返す（無ければnull）。
 * elevationStair.js の findOverlappingVoidRoom（階段の直上階VOID/STAIR_VOID探索）と、本ファイルの
 * 吹抜け下階の対応Room探索の両方が共有する（R: 矩形重なり探索部の切り出し）。
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} bounds
 * @param {object} targetGraph
 * @param {(room:import('@core').Room) => boolean} predicate
 * @returns {import('@core').Room|null}
 */
export function findOverlappingRoom(bounds, targetGraph, predicate) {
  if (!bounds) return null;
  for (const r of targetGraph.rooms) {
    if (!predicate(r)) continue;
    const b = roomBounds(r.cells, targetGraph);
    if (b && rectsOverlap(bounds, b)) return r;
  }
  return null;
}

/**
 * 吹抜けRoom（voidRoom）と footprint が重なる、lowerGraph上の通常部屋（feature===null）を
 * 1つ返す（無ければnull）。
 */
function findLowerRoom(voidRoom, graph, lowerGraph) {
  const bounds = roomBounds(voidRoom.cells, graph);
  return findOverlappingRoom(bounds, lowerGraph, r => r.feature == null);
}

// 面の軸CLと下階の壁を同一視する世界座標の許容差(mm)。CLは階ごとに別オブジェクトのため、
// idではなく世界座標で突き合わせる（section層のisSightlineShapeと同じ規約）。
const LOWER_AXIS_EPS_MM = 1;
// 分割で生じる極小区間を捨てる下限(mm)。
const MIN_SUB_SEG_MM = 1e-6;

// 世界範囲の配列を昇順に整列・結合する。
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi) last.hi = Math.max(last.hi, r.hi);
    else out.push({ ...r });
  }
  return out;
}

/**
 * face と同じ位置（軸CLの世界座標・向きが一致）の壁が lowerGraph に実在する世界範囲。
 * 吹抜けの2層帯は「自階の面を下へ延長する」方式のため、下階に壁が無い区間まで延長すると
 * 実在しない壁の輪郭が1FLまで描かれてしまう（ユーザー実機指摘2026-08その17と同じ構造の不具合。
 * 階段帯はsection層で層ごとに壁を拾うが、吹抜け帯は面をそのまま引き伸ばすだけだった）。
 * @param {object} face
 * @param {object} lowerGraph
 * @returns {{lo:number,hi:number}[]} 世界座標の範囲（結合済み）
 */
function lowerWallWorldRanges(face, lowerGraph) {
  const axis = face.axisCL?.effectiveValue;
  if (axis == null) return [];
  const ranges = [];
  for (const w of graphList(lowerGraph, 'walls') ?? []) {
    if (!w.isVertical !== !face.isVertical) continue;
    const wAxis = w.axisCL?.effectiveValue;
    if (wAxis == null || Math.abs(wAxis - axis) > LOWER_AXIS_EPS_MM) continue;
    ranges.push({ lo: Math.min(w.coord1, w.coord2), hi: Math.max(w.coord1, w.coord2) });
  }
  return mergeRanges(ranges);
}

/**
 * lowerWallWorldRangesを面のローカルx（0..run）へ写した被覆範囲。
 * world = originWorld + dirSign * localX（snapFaceEndsToCornersの規約）。
 */
function lowerCoverLocal(face, lowerGraph) {
  const world = lowerWallWorldRanges(face, lowerGraph);
  const sign = face.dirSign > 0 ? 1 : -1;
  const local = world.map(r => {
    const a = sign * (r.lo - face.originWorld), b = sign * (r.hi - face.originWorld);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  });
  return mergeRanges(local);
}

/**
 * 1つのfloorSegmentを被覆範囲(cover)で切り分ける。返り値は元の[loX,hiX]を隙間なく覆う
 * 小区間の並び（covered=下階に壁があるので下へ延長してよい区間）。
 */
function splitSegByCover(seg, cover) {
  const cuts = [seg.loX];
  for (const c of cover) {
    if (c.lo > seg.loX && c.lo < seg.hiX) cuts.push(c.lo);
    if (c.hi > seg.loX && c.hi < seg.hiX) cuts.push(c.hi);
  }
  cuts.push(seg.hiX);
  cuts.sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const loX = cuts[i], hiX = cuts[i + 1];
    if (hiX - loX <= MIN_SUB_SEG_MM) continue;
    const mid = (loX + hiX) / 2;
    parts.push({ loX, hiX, covered: cover.some(c => mid > c.lo && mid < c.hi) });
  }
  return parts;
}

/**
 * 吹抜け部屋の帯（設置階下階のFLから設置階の天井高さまでの2層帯。CLを合わせて描画）。
 * lowerGraph・ctx.floorHeightBelowMm のどちらかが無ければ drop なしの1層帯（buildRoomBand相当・
 * heightUnits:1）を返す（例外は投げない）。
 * @param {import('@core').Room} voidRoom
 * @param {object} graph - 設置階のgraph
 * @param {object|null} lowerGraph - 直下階のgraph（floorSwapManager.peek済み。呼び出し側が解決する）
 * @param {{floorHeightBelowMm?:number|null, project?:object, materialMap?:Map, gridCLs?:object[],
 *   gapModelMm?:number, nameGapModelMm?:number, triangleOffsetModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number, wallLessEndExtendModelMm?:number,
 *   scale?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   topMarginMm:number, heightUnits:number, unitHeightMm:number}}
 */
export function buildVoidBand(voidRoom, graph, lowerGraph, ctx = {}) {
  const faces = composeRoomFaces(voidRoom, graph);
  const floorHeightBelowMm = ctx.floorHeightBelowMm ?? null;
  const hasLower = lowerGraph != null && floorHeightBelowMm != null;

  let faceOverride;
  let dropMm = 0;
  if (hasLower) {
    const lowerRoom = findLowerRoom(voidRoom, graph, lowerGraph);
    const flDiffMm = lowerRoom
      ? lowerGraph.effectiveFloorLevel(lowerRoom) - lowerGraph.floorDatum
      : 0;
    // QA修正: 下階Roomの沈み床（flDiffMmが大きく負）でfloorHeightBelowMm+flDiffMmが0以下になりうる。
    // 物理的に「設置階下階のFLが設置階のFL以上」という値は2層表現として意味を持たないため、
    // 0でクランプする（クランプせず負値のまま使うと、床が天井より上に来る空白の2層帯になる）。
    dropMm = Math.max(0, floorHeightBelowMm + flDiffMm);
    // ceilAbs = floorDelta + chMm が不変（天井は動かず床だけ下がる）。
    // 下へ延長するのは**下階に同じ壁が実在する区間だけ**（lowerCoverLocal）。壁の無い区間は
    // 設置階の床（2FL）のまま残し、その境界は既存の段差床線の仕組みで縦の折れとして出る
    // ——延長しない＝「下階はこの面では壁が無い（アキ）」という表現。
    faceOverride = (face, i, defaults) => {
      if (!defaults.floorSegments) return null; // 段差見付け面（kind==='step'）は対象外
      const cover = lowerCoverLocal(face, lowerGraph);
      const out = [];
      for (const seg of defaults.floorSegments) {
        for (const part of splitSegByCover(seg, cover)) {
          // hiCLIdは元の区間の右端に達する小区間だけが引き継ぐ（分割で生じた内側の境界は
          // 段差CLではないため、ROW1寸法の分割点にしてはいけない）。
          const hiCLId = part.hiX === seg.hiX ? seg.hiCLId : null;
          out.push(part.covered
            ? { ...seg, loX: part.loX, hiX: part.hiX, hiCLId,
                floorDeltaMm: seg.floorDeltaMm - dropMm, chMm: (seg.chMm ?? defaults.CH) + dropMm }
            : { ...seg, loX: part.loX, hiX: part.hiX, hiCLId });
        }
      }
      return { floorSegments: out };
    };
  }

  const { primitives, chDimX, prevBoundaryHi } = layoutBandFaces(voidRoom, graph, faces, { ...ctx, faceOverride });
  return finalizeBand(voidRoom, graph, primitives, {
    faceCount: faces.length, chDimX, prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
    // QA修正: dropMmが0にクランプされた（下階FL差で相殺された）場合は実質1層と同じ表現のため
    // heightUnits=1にする（hasLowerだけを見ると2層予約されたままになってしまう）。
    heightUnits: hasLower && dropMm > 0 ? 2 : 1,
  });
}

/**
 * 「上部吹抜け」を、それが落ちている下階Roomの帯に多層書きする（ユーザー明示指示2026-08）。
 *
 * 吹抜けの展開を独立した帯として並べるのではなく、**下階の部屋の展開と同じ帯**へ積む。
 * 同じ面（軸CLの世界座標・見る向きが同じ）なら、走り方向の範囲が下階の面と食い違って
 * いても1枚の面として一緒に描く（ユーザー明示指示: 吹抜けA面の下に1階壁は無いが、
 * X2の左に同一面が続くので一緒に描画。D面も同様）。
 *
 * **吹抜けには天井断面まで水平断面が無い**（ユーザー明示指示2026-08。見えがかりは存在する）
 * ——吹抜けの範囲でも床断面は下階のFLのまま1本で通り、上階の床位置に断面線は立たない。
 * したがって区間ごとの高さは「吹抜けの範囲外＝下階の床〜天井」「吹抜けの範囲＝下階の床〜
 * 上階の天井」の2通りだけになる。下階にその面の壁があるかどうかは断面の有無を左右しない
 * （実機症状: 吹抜け側の区間だけ床を2FLへ上げていたため、1F床断面が面の端まで届かず
 * 「5」A1でX3の壁断面と、D1でY1の壁断面と取り合わなかった）。
 * @param {import('@core').Room} room - 下階の部屋（吹抜けが落ちている部屋）
 * @param {object} graph - 下階のgraph
 * @param {import('@core').Room} voidRoom - 直上階の吹抜けRoom
 * @param {object} upperGraph - 直上階のgraph
 * @param {object} [ctx] - buildRoomBandと同じctx＋floorHeightAboveMm（下階→上階の階高）
 * @returns {object} finalizeBandの戻り（heightUnits=2）
 */
export function buildRoomBandWithVoidAbove(room, graph, voidRoom, upperGraph, ctx = {}) {
  const floorHeightMm = ctx.floorHeightAboveMm ?? null;
  const baseFaces = composeRoomFaces(room, graph);
  if (floorHeightMm == null || !upperGraph) {
    // 階高が解決できなければ多層書きしない（下階の帯そのまま。例外は投げない）。
    const { primitives, chDimX, prevBoundaryHi } = layoutBandFaces(room, graph, baseFaces, ctx);
    return finalizeBand(room, graph, primitives, {
      faceCount: baseFaces.length, chDimX, prevBoundaryHi,
      triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
    });
  }
  const voidCH = roomCeilingHeight(upperGraph, voidRoom).mm;
  const voidFaces = composeRoomFaces(voidRoom, upperGraph).filter(f => f.kind !== 'step');

  // 面の対応付け: 軸CLの世界座標と見る向き（isVertical×inward）が同じなら同一面とみなす。
  const samePlane = (a, b) => !a.isVertical === !b.isVertical
    && Math.sign(a.inward) === Math.sign(b.inward)
    && Math.abs((a.axisCL?.effectiveValue ?? NaN) - (b.axisCL?.effectiveValue ?? NaN)) <= LOWER_AXIS_EPS_MM;

  const used = new Set();
  const faces = baseFaces.map(f => {
    if (f.kind === 'step') return f;
    const mates = voidFaces.filter(v => samePlane(f, v));
    if (mates.length === 0) return f;
    mates.forEach(v => used.add(v));
    const lo = Math.min(f.lo, ...mates.map(v => v.lo));
    const hi = Math.max(f.hi, ...mates.map(v => v.hi));
    return withVoidRanges({ ...f, lo, hi }, f, mates, graph, upperGraph);
  });
  // 下階に同じ面が無い吹抜けの面は、上段だけの面として単独で足す。
  for (const v of voidFaces) {
    if (!used.has(v)) faces.push(withVoidRanges({ ...v }, v, [v], graph, upperGraph));
  }

  const faceOverride = (face, i, defaults) => {
    const plan = face.voidAbove;
    if (!plan) return null;
    const base = defaults.floorSegments ?? [{ loX: 0, hiX: face.run, floorDeltaMm: 0 }];
    const out = [];
    for (const seg of coverFullRun(base, face.run)) {
      for (const part of splitSegByCover(seg, plan.voidLocal)) {
        if (!part.covered) { out.push({ ...seg, loX: part.loX, hiX: part.hiX }); continue; }
        // 吹抜けの区間: 床はそのまま（水平断面を挟まない）、天井だけ上階の天井まで伸ばす。
        const delta = seg.floorDeltaMm ?? 0;
        out.push({ ...seg, loX: part.loX, hiX: part.hiX, hiCLId: null, chMm: floorHeightMm + voidCH - delta });
      }
    }
    return { floorSegments: out };
  };

  const layout = layoutBandFaces(room, graph, faces, { ...ctx, faceOverride });
  const primitives = [...layout.primitives];

  // 壁断面・見えがかりは**階段展開とまったく同じ2.5D断面エンジン**に任せる（ユーザー明示指示
  // 2026-08「処理共有のこと」）。面ごとにSectionCutを1本立て、buildColumns→emitColumnsの
  // 同じ経路を通す——これで吹抜けの区間にも1階天井の見えがかり・上階の壁（腰壁・垂れ壁）の
  // 断面／見えがかりが、階段帯と同じ規則で出る。
  // 床線・天井線・端の縦線・幅木・建具はbuildFaceFigure側の責務のまま（役割分担は階段帯と同じ）。
  const hiZ = floorHeightMm + voidCH;
  const layers = [
    { graph, floorZMm: 0, role: 'self' },
    { graph: upperGraph, floorZMm: floorHeightMm, role: 'above' },
  ];
  const probeCtx = makeProbeContext(layers);
  const bandRoomBounds = roomBounds(room.cells, graph);
  layout.faceRuns.forEach(({ xCursor }, i) => {
    const face = faces[i];
    if (!face?.voidAbove) return; // 吹抜けの無い面は従来どおり（断面エンジンを通さない）
    const cut = {
      seqNo: String(i), dirSign: face.dirSign,
      // 視線は室内から壁を見る向き＝面のinwardの逆（elevationStairSequence.jsの
      // `letterOf(isVertical, -cut.viewSign)`と対の規約）。
      viewSign: face.inward > 0 ? -1 : 1,
      line: {
        isVertical: face.isVertical, axisValue: face.axisCL.effectiveValue, lo: face.lo, hi: face.hi,
        // 直交壁はこの面の壁に突き当たって室内側の面で終わる（CL上の切断線までは届かない）。
        // 面の壁の半厚ぶんを許容してその断面を拾う（sectionProbe.jsのisCutWall参照）。
        buttToleranceMm: Math.abs((face.faceValue ?? face.axisCL.effectiveValue) - face.axisCL.effectiveValue),
      },
      layers, zRange: { loZ: 0, hiZ }, baseFloorZ: 0, bandRoomBounds,
    };
    for (const p of emitColumns(buildColumns(cut, probeCtx), cut, { ceilZ: hiZ })) {
      primitives.push(translatePrimitive(p, xCursor, 0));
    }
  });

  return finalizeBand(room, graph, primitives, {
    faceCount: faces.length, chDimX: layout.chDimX, prevBoundaryHi: layout.prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
    heightUnits: 2,
  });
}

// 面の走り方向の世界範囲をローカルx（0..run）へ写す（world = originWorld + dirSign*localX）。
function toLocal(face, ranges) {
  const sign = face.dirSign > 0 ? 1 : -1;
  return mergeRanges(ranges.map(r => {
    const a = sign * (r.lo - face.originWorld), b = sign * (r.hi - face.originWorld);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }));
}

/**
 * 走り範囲を広げた面に、吹抜けの範囲（ローカルx）と端の情報を付ける。
 * 端の「壁あり/見えがかりエッジ」は、その端の世界座標を実際に持っている元の面から引き継ぐ
 * （伸ばした側の端は吹抜けの面が持っている）。
 */
function withVoidRanges(merged, ownFace, voidMates, graph, upperGraph) {
  const dirSign = ownFace.dirSign;
  const face = {
    ...merged, dirSign, run: merged.hi - merged.lo,
    originWorld: dirSign > 0 ? merged.lo : merged.hi,
  };
  const owners = [ownFace, ...voidMates];
  // 端のCL: startCLIdは常に世界座標lo・endCLIdは常にhiを決める（snapFaceEndsToCornersの規約）。
  // 伸ばした端は上階の面が持つCL idなので、そのままでは下階graphで引けず faceBoundaryLocalX が
  // フォールバックして帯のパネル幅が狂う（隣の面と重なる）。世界座標は全階共通なので、同値の
  // 下階CLへ引き直す。
  // start/end のどちらのスロットがlo側かは元の面によってまちまちなので、**値の近さ**で選び、
  // 文書化された不変条件（startCLId=世界座標lo・endCLId=hi。elevationOpenSpan.js参照）で
  // 詰め直す。faceBoundaryLocalXはmin/maxを取るためスロットの入れ替わりは境界に影響しない。
  const clOf = (g, id) => g?.shapeMap?.get(id) ?? g?._structGraph?.shapeMap?.get(id) ?? null;
  const clIdNear = (world) => {
    const owner = owners.find(o => Math.abs(o.lo - world) <= MIN_SUB_SEG_MM
      || Math.abs(o.hi - world) <= MIN_SUB_SEG_MM) ?? ownFace;
    const cands = [owner.startCLId, owner.endCLId]
      .map(id => ({ id, cl: clOf(upperGraph, id) ?? clOf(graph, id) }))
      .filter(c => c.cl != null)
      .sort((a, b) => Math.abs(a.cl.effectiveValue - world) - Math.abs(b.cl.effectiveValue - world));
    const best = cands[0];
    if (!best) return null;
    // 上階の面が持つCL idは下階graphでは引けない。世界座標は全階共通なので同値の下階CLへ移す
    // （引き直せないと faceBoundaryLocalX がフォールバックし、帯のパネル幅が狂って隣の面と重なる）。
    return clOf(graph, best.id) ? best.id
      : (findRunCLAt(graph, face.isVertical, best.cl.value)?.id ?? best.id);
  };
  face.startCLId = clIdNear(merged.lo) ?? ownFace.startCLId;
  face.endCLId   = clIdNear(merged.hi) ?? ownFace.endCLId;
  const endFlags = (world) => {
    const atLo = owners.find(o => Math.abs(o.lo - world) <= MIN_SUB_SEG_MM);
    const atHi = owners.find(o => Math.abs(o.hi - world) <= MIN_SUB_SEG_MM);
    const o = atLo ?? atHi ?? ownFace;
    const useLo = !!atLo;
    return {
      hasWall: (useLo ? (o.dirSign > 0 ? o.hasWallAtLocal0 : o.hasWallAtLocalRun)
        : (o.dirSign > 0 ? o.hasWallAtLocalRun : o.hasWallAtLocal0)) ?? true,
      edge: (useLo ? (o.dirSign > 0 ? o.edgeAtLocal0 : o.edgeAtLocalRun)
        : (o.dirSign > 0 ? o.edgeAtLocalRun : o.edgeAtLocal0)) ?? false,
    };
  };
  const at0 = endFlags(dirSign > 0 ? merged.lo : merged.hi);
  const atRun = endFlags(dirSign > 0 ? merged.hi : merged.lo);
  face.hasWallAtLocal0 = at0.hasWall; face.edgeAtLocal0 = at0.edge;
  face.hasWallAtLocalRun = atRun.hasWall; face.edgeAtLocalRun = atRun.edge;
  face.voidAbove = { voidLocal: toLocal(face, voidMates.map(v => ({ lo: v.lo, hi: v.hi }))) };
  return face;
}

// segsが面の全長[0,run]を覆うよう、隙間を親（floorDeltaMm=0）の区間で埋める。
function coverFullRun(segs, run) {
  const sorted = [...segs].sort((a, b) => a.loX - b.loX);
  const out = [];
  let x = 0;
  for (const s of sorted) {
    if (s.loX > x + MIN_SUB_SEG_MM) out.push({ loX: x, hiX: s.loX, floorDeltaMm: 0 });
    out.push(s); x = Math.max(x, s.hiX);
  }
  if (run > x + MIN_SUB_SEG_MM) out.push({ loX: x, hiX: run, floorDeltaMm: 0 });
  return out;
}
