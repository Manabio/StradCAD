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
import { selectElevationRooms } from './elevationFaces.js';
import { parseBaseboardHeightMm, formatMaterialLabel, estimateWallLabelWidthPx } from './elevationFigure.js';
import { ElevationLineRole, weightForRole, WALL_LABEL_LINE_GAP_MM, CH_DIM_OFFSET_MM } from './elevationStyle.js';
import { findRunCLAt } from './elevationFloorProfile.js';
import { layoutBandFaces, finalizeBand, appendBandCutContent } from './elevationBand.js';
import { translatePrimitive } from './elevationPrimitives.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildCutContent } from './section/sectionContent.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './section/sectionCutPlane.js';
import { structuralColumnContribution } from './section/sectionStructure.js';

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
 * **その面の平面が上階に存在する範囲**（ローカルx）。ユーザー確定の方針C
 * 「その面（の通り）に2階の壁・アキが実在する範囲だけ上階まで描く」の実装。
 *
 * 同じ通りに上階の壁が1枚でもあれば、**最初の壁の始まりから最後の壁の終わりまで**を1つの範囲に
 * する——壁と壁のあいだの隙間は「その面のアキ」（壁が無く見通せる）であって、面の平面としては
 * 連続しているため。壁が1枚も無ければ空（その面は上階に存在しない＝上階を描かない）。
 * @param {object} face
 * @param {object} upperGraph
 * @returns {{lo:number,hi:number}[]} 0件 or 1件
 */
function upperPlaneLocal(face, upperGraph) {
  const world = lowerWallWorldRanges(face, upperGraph); // 同じ通りの壁（向き＋座標で照合）
  if (world.length === 0) return [];
  const lo = Math.max(Math.min(...world.map(r => r.lo)), face.lo);
  const hi = Math.min(Math.max(...world.map(r => r.hi)), face.hi);
  if (hi - lo <= MIN_SUB_SEG_MM) return [];
  return toLocal(face, [{ lo, hi }]);
}

/** ranges から subtract を引いた残り（どちらもローカルx・昇順マージ済み）。 */
function subtractRanges(ranges, subtract) {
  let out = ranges.map(r => ({ ...r }));
  for (const s of subtract) {
    const next = [];
    for (const r of out) {
      if (s.hi <= r.lo + MIN_SUB_SEG_MM || s.lo >= r.hi - MIN_SUB_SEG_MM) { next.push(r); continue; }
      if (s.lo > r.lo + MIN_SUB_SEG_MM) next.push({ lo: r.lo, hi: s.lo });
      if (s.hi < r.hi - MIN_SUB_SEG_MM) next.push({ lo: s.hi, hi: r.hi });
    }
    out = next;
  }
  return out;
}

/**
 * **上階ぶんの展開を、同じ帯へ床高さぶん持ち上げて重ねる**（ユーザー確定の方針C）。
 *
 * 吹抜けの範囲は下の断面が既に上階天井まで描いているので、ここが担当するのは
 * 「その面の平面が上階に存在するが吹抜けではない範囲」＝**上階に床がある側**。
 * 上階を**それ自身が自階である1層の断面**として組むのが要点——そうすることで、上階の壁・アキ・
 * エッジがすべて通常の1層帯とまったく同じ処理で出る（「上に実在の部屋がある高さを非描画の
 * 床構造とみなす」分類に手を入れずに済む）。
 *
 * 断面ローカルxは cut ごとに `line.lo/hi` から決まるため、面ローカルxへ戻す平行移動を掛ける
 * （面の x=0 と cut の x=0 は一致しない）。
 * @param {object[]} primitives 積み先
 * @param {ReturnType<typeof layoutBandFaces>} layout
 * @param {object} upperGraph
 * @param {{floorHeightMm:number, upperCH:number, roomBoundsRect:object|null, endExtendMm:number|undefined}} opts
 */
function appendUpperStoreyOutline(primitives, layout, upperGraph, opts) {
  const { floorHeightMm, upperCH, roomBoundsRect, endExtendMm } = opts;
  const layers = [{ graph: upperGraph, floorZMm: floorHeightMm, role: 'self' }];
  const probeCtx = makeProbeContext(layers);
  const columnSolids = structuralColumnContribution(layers);
  const hiZ = floorHeightMm + upperCH;
  for (const { face, xCursor } of layout.faceRuns) {
    const plan = face.voidAbove;
    if (!plan) continue;
    for (const seg of subtractRanges(upperPlaneLocal(face, upperGraph), plan.voidLocal)) {
      if (seg.hi - seg.lo <= MIN_SUB_SEG_MM) continue;
      // ローカルx範囲 → 世界範囲（world = originWorld + dirSign * localX）
      const wa = face.originWorld + face.dirSign * seg.lo;
      const wb = face.originWorld + face.dirSign * seg.hi;
      const lo = Math.min(wa, wb), hi = Math.max(wa, wb);
      const offsetMm = cutPlaneOffsetMm(face, layers, { columnSolids });
      const cut = {
        seqNo: `${face.label}^`, dirSign: face.dirSign, face,
        viewSign: faceViewSign(face),
        line: faceCutLine({ ...face, lo, hi }, offsetMm),
        layers, baseFloorZ: floorHeightMm,
        zRange: { loZ: floorHeightMm, hiZ },
        ceilProfile: [{ loX: 0, hiX: hi - lo, ceilZ: hiZ }],
      };
      const { content } = buildCutContent(cut, probeCtx, { endExtendMm, bandRoomBounds: roomBoundsRect });
      // cutのローカルx=0は line.lo/hi 側。面ローカルxへ戻す。
      const cutOriginWorld = face.dirSign > 0 ? lo : hi;
      const dx = xCursor + (cutOriginWorld - face.originWorld) * face.dirSign;
      for (const p of content) primitives.push(translatePrimitive(p, dx, 0));
    }
  }
}

/**
 * 上階の面（同じ通り・同じ向き）を持つ2階のRoomと、その面がローカルxで占める範囲。
 * 巾木・壁2段書きは**その位置の2階の部屋**の設定から引く必要があるため、範囲と部屋を対にして返す
 * （1階の値を2階へ転用しない、というのがこの関数が存在する理由）。
 * @param {object} face - 帯の面（1階側。ローカルxの基準）
 * @param {object} upperGraph
 * @returns {Array<{room:object, lo:number, hi:number}>} ローカルx
 */
function upperFaceRooms(face, upperGraph) {
  const axis = face.axisCL?.effectiveValue;
  if (axis == null) return [];
  const out = [];
  for (const room of selectElevationRooms(upperGraph)) {
    for (const f of composeRoomFaces(room, upperGraph)) {
      if (f.kind === 'step') continue;
      if (!f.isVertical !== !face.isVertical) continue;
      if (Math.sign(f.inward) !== Math.sign(face.inward)) continue;
      if (Math.abs((f.axisCL?.effectiveValue ?? NaN) - axis) > LOWER_AXIS_EPS_MM) continue;
      const local = toLocal(face, [{ lo: f.lo, hi: f.hi }]);
      if (local.length === 0) continue;
      out.push({ room, lo: local[0].lo, hi: local[0].hi });
    }
  }
  return out;
}

/**
 * 上階ぶんの**図面の体裁**（天井線・巾木・壁2段書き・天井高寸法）を帯へ積む。
 *
 * 輪郭（壁・アキ）は`appendUpperStoreyOutline`（断面エンジン）が描く。ここが描くのは面図側の
 * 要素で、**値の出どころはすべて2階の部屋**——1階の巾木高さ・壁材を2階へ転用しない。
 * 横方向の寸法（壁芯間・通り芯丸・面ラベル）は上下階で同じ通り芯・同じ位置なので増やさない
 * （重ねても完全に同じ場所へ重なるだけ。ユーザー確認済み）。
 */
function appendUpperStoreyTrim(primitives, layout, upperGraph, opts) {
  const { floorHeightMm, upperCH, materialMap, scale } = opts;
  const hiZ = floorHeightMm + upperCH;
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const detailWeight = weightForRole(ElevationLineRole.DETAIL);
  let chDimDone = false;
  for (const { face, xCursor } of layout.faceRuns) {
    const plan = face.voidAbove;
    if (!plan) continue;
    const segs = subtractRanges(upperPlaneLocal(face, upperGraph), plan.voidLocal);
    if (segs.length === 0) continue;
    for (const seg of segs) {
      // 上階の天井断面線（この範囲の上端。これが無いとアキ・壁の上が宙で終わる）。
      primitives.push({ type: 'line', x1: xCursor + seg.lo, y1: -hiZ, x2: xCursor + seg.hi, y2: -hiZ,
        weight: cutWeight });
    }
    // 巾木・壁2段書きは「その位置の2階の部屋」の面がある範囲だけ。壁が無い区間（アキ）には
    // そもそも巾木も壁材も存在しない。
    for (const { room, lo, hi } of upperFaceRooms(face, upperGraph)) {
      for (const seg of segs) {
        const a = Math.max(lo, seg.lo), b = Math.min(hi, seg.hi);
        if (b - a <= MIN_SUB_SEG_MM) continue;
        const h = parseBaseboardHeightMm(room.finish?.baseboardHeight);
        if (h != null && h < upperCH) {
          primitives.push({ type: 'line', x1: xCursor + a, y1: -(floorHeightMm + h),
            x2: xCursor + b, y2: -(floorHeightMm + h), weight: detailWeight });
        }
        const info = room.getFinishInfo?.();
        const lines = [
          materialMap?.get(info?.wallMaterial)?.name ? `壁：${formatMaterialLabel(materialMap.get(info.wallMaterial).name)}` : null,
          materialMap?.get(info?.wallFinish)?.name ? formatMaterialLabel(materialMap.get(info.wallFinish).name) : null,
        ].filter(Boolean);
        if (lines.length > 0) {
          const widthPx = Math.max(...lines.map(estimateWallLabelWidthPx));
          const widthMm = scale ? widthPx / scale : 0;
          if (b - a >= widthMm * 2) {
            const cx = xCursor + (a + b) / 2, cy = -(floorHeightMm + upperCH / 2);
            lines.forEach((text, k) => primitives.push({ type: 'text', x: cx,
              y: cy + (k - (lines.length - 1) / 2) * WALL_LABEL_LINE_GAP_MM,
              text, anchor: 'middle', baseline: 'middle' }));
          }
        }
      }
    }
    // 上階の天井高寸法（階ごとに値が違うので、下階のぶんとは別に1本だけ足す）。
    if (!chDimDone && layout.chDimX != null) {
      chDimDone = true;
      primitives.push({ type: 'dim', dir: 'v', at: layout.chDimX, from: -hiZ, to: -floorHeightMm,
        foot: layout.chDimX + CH_DIM_OFFSET_MM, dot: true, label: Math.round(upperCH) });
    }
  }
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

  const layout = layoutBandFaces(voidRoom, graph, faces, { ...ctx, faceOverride });
  const primitives = [...layout.primitives];
  // 壁の輪郭は全4種の帯で共通の唯一の経路（appendBandCutContent→buildCutContent）。
  // 層スタックは設置階＋直下階——面を下へ延長する方式（このファイル冒頭）でも、下階の壁は
  // 下階のgraphからしか読めないため、下階を層として積まないと1FL付近の断面・見えがかりが
  // 一切出ない（面の引き伸ばしは床線・天井線の話で、壁の実体の話ではない）。
  appendBandCutContent(primitives, voidRoom, graph, layout,
    hasLower && dropMm > 0
      ? [{ graph, floorZMm: 0, role: 'self' }, { graph: lowerGraph, floorZMm: -dropMm, role: 'below' }]
      : [{ graph, floorZMm: 0, role: 'self' }],
    { endExtendMm: ctx.wallLessEndExtendModelMm });
  return finalizeBand(voidRoom, graph, primitives, {
    faceCount: faces.length, chDimX: layout.chDimX, prevBoundaryHi: layout.prevBoundaryHi,
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
    // 壁の輪郭は**この経路でも共通経路を通す**（自階1層＝buildRoomBandと同じ）——通さないと、
    // 階高が解決できない図面だけ壁断面・見えがかり・アキが丸ごと欠ける（例外もログも出ない）。
    const layout = layoutBandFaces(room, graph, baseFaces, ctx);
    const prims = [...layout.primitives];
    appendBandCutContent(prims, room, graph, layout, [{ graph, floorZMm: 0, role: 'self' }],
      { endExtendMm: ctx.wallLessEndExtendModelMm });
    return finalizeBand(room, graph, prims, {
      faceCount: baseFaces.length, chDimX: layout.chDimX, prevBoundaryHi: layout.prevBoundaryHi,
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
        // ceilFloorZMm: この区間の**天井が属する階の床レベル**（帯の床基準）。天井断面線を
        // 「階の異なる天井どうしは結ばない」と判断するための唯一の情報源（elevationFigure.js）。
        const delta = seg.floorDeltaMm ?? 0;
        out.push({ ...seg, loX: part.loX, hiX: part.hiX, hiCLId: null,
          chMm: floorHeightMm + voidCH - delta, ceilFloorZMm: floorHeightMm });
      }
    }
    return { floorSegments: out };
  };

  const layout = layoutBandFaces(room, graph, faces, { ...ctx, faceOverride });
  const primitives = [...layout.primitives];

  // 壁の輪郭は**全4種の帯で共通の唯一の経路**（elevationBand.jsのappendBandCutContent→
  // section/sectionContent.jsのbuildCutContent）へ任せる——探査延長・端の凹み側面線の抑制・
  // アキのバツまで通常の部屋帯・階段帯と同じ処理を通る。旧実装はemitColumnsだけを直接
  // 呼んでおり、この3つが丸ごと欠けていた（ユーザー指摘「「6」は正しく「5」は誤った出力」）。
  // 床線・天井線・端の縦線・幅木・建具はbuildFaceFigure側の責務のまま。
  appendBandCutContent(primitives, room, graph, layout, [
    { graph, floorZMm: 0, role: 'self' },
    { graph: upperGraph, floorZMm: floorHeightMm, role: 'above' },
  ], {
    endExtendMm: ctx.wallLessEndExtendModelMm,
  });
  // 上階ぶんの輪郭（方針C）: 吹抜けではないが上階にその面の平面がある範囲へ、上階を自階とする
  // 1層の断面をもう1本重ねる。
  appendUpperStoreyOutline(primitives, layout, upperGraph, {
    floorHeightMm, upperCH: voidCH,
    roomBoundsRect: roomBounds(room.cells, graph),
    endExtendMm: ctx.wallLessEndExtendModelMm,
  });
  // 上階ぶんの図面の体裁（天井線・巾木・壁2段書き・天井高寸法）。値の出どころはすべて2階の部屋。
  appendUpperStoreyTrim(primitives, layout, upperGraph, {
    floorHeightMm, upperCH: voidCH, materialMap: ctx.materialMap ?? null, scale: ctx.scale,
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
