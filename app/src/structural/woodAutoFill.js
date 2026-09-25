// 在来木造の自動補完（ステップ3a: 壁交点柱・既存部材の断面そろえ）。設計意図は .claude/structural-model.md。
//
// 在来木造では柱は通り芯の交点ではなく**壁が交差する位置**（交点・T字・コーナー）に立つ。壁の位置には
// 壁由来の梁芯CL（wallBeamAxes.js。discipline:'fuse'）が生成されるので、交点をそのCLペアへ解決すれば
// 既存の柱アンカー（縦CL×横CL）・除外集合（excludedColumnSlots）・採番がそのまま使える（新しい
// アンカーは持たない）。壁の自由端（他の壁と交わらない端）には立てない（ユーザー裁定2026-09-14）。
//
// autoFillStructuralGrid（structuralAutoFill.js）から主構造ルールの選択子 columnPlacement で呼ばれる。
// structuralAutoFill.js → 本ファイル の一方向依存。
// **前提**: 呼び出し側が壁由来の梁芯CL（autoFillWallBeamAxes。マージ済み・下階込みの wallSources）を
// 先に生成しておくこと——ここでは CL を作らない（自階だけの未マージ source で作ると、下階経路で
// extent の短い梁芯CLが永続化され、後の重複ガードで固定される）。
import { CenterLineType, Discipline, centerLineKind, columnSlotKey, columnAnchorKey, spanKey, beamExclusionKey, findHostPrimaryBeam } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { structuralAnchorAt, structuralAnchorCandidates, supportSpanColumnCandidates, spansEntireAxis } from '../core/centerLineKindPolicy.js';
import { findSectionEntry, woodRectSectionKey } from './sectionCatalog.js';
import {
  rulesFor, effectiveStructure, TRADITIONAL_WOOD_FRAMING, TRADITIONAL_WOOD_BACKING, WOOD_DEPTH_BEAM_ROLES,
  woodColumnWidthMm, woodColumnSectionId, resolvedBeamColumnWidthMm, columnSectionId, columnWidthMm,
} from './structureRules.js';
import { selfWallSegments, findBeamAnchorCL, wallBeamAxisExcludeKey, bracketExtent, wallBackingCenterCoord } from './wallBeamAxes.js';
import { woodStudCodeFor } from '../finish/materials/backingClass.js';
import { beamGridCells } from './framingCells.js';
import {
  woodBeamDepthForSpans, woodBeamSectionForDepth, crossingBeamLoadCoords,
  mergeWallIntervals, throughBeamRuns, propagateCarrierDepths, pointsOnWallLines, columnSplitPoints,
  columnSupportBeamCandidates, beamWallCrossPoints, WALL_JUNCTION_TOL_MM, sillTopLevelOffsetMm,
  jambColumnPositions, rectsOverlap, subtractCoveredSpan, supportSpanColumnPositions, mergePrimaryBeamRuns,
} from './woodFraming.js';
import { woodColumnEccentricity } from './woodColumnOffset.js';
import { buildSelfFootprintGate, footprintBreakCLs } from './wallGate.js';
import { bareColumnRect } from '../finish/columnWrap.js';
import { findHostWall } from '../openings/openingGeometry.js';
import { selfWallFreeEnds } from './wallFreeEnds.js';

// isKneeDropFreeEnd／selfWallFreeEndsの実体は wallFreeEnds.js（腰壁・垂れ壁の端部材
// structural/wallEndMember.js が同じ述語を共有するため2026-09-19に切り出した。二系統禁止）。

// WALL_JUNCTION_TOL_MM（壁の端部の取り合い許容mm）の真実は woodFraming.js（woodColumnOffset.js との
// 共有のため。純モジュールから core.js 依存の woodAutoFill.js を import できない）。既存の import 元
// （本ファイルの他関数・woodAutoFill.test.js）を壊さないよう再exportする。
export { WALL_JUNCTION_TOL_MM };

/**
 * 壁区間（プレーン配列 [{isVertical, coord, lo, hi}]。coord＝下地帯の中心、lo/hi＝壁の走行範囲）から、
 * 縦壁×横壁が交わる点（交点・T字・コーナー）を列挙する。平行な壁同士は交わらない。
 * 端部の取り合いは WALL_JUNCTION_TOL_MM（控えられた端）まで許容する。同じ点は1つにまとめる。純関数（graph 非依存）。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} segments
 * @param {number} [tol] - 端部の取り合い許容(mm)
 * @returns {Array<{x:number, y:number}>}
 */
export function wallIntersectionPoints(segments, tol = WALL_JUNCTION_TOL_MM) {
  const verticals = segments.filter(s => s.isVertical);
  const horizontals = segments.filter(s => !s.isVertical);
  const seen = new Set();
  const points = [];
  for (const v of verticals) {
    for (const h of horizontals) {
      if (v.coord < h.lo - tol || v.coord > h.hi + tol) continue; // 縦壁の位置が横壁の範囲内（端の控えを許容）
      if (h.coord < v.lo - tol || h.coord > v.hi + tol) continue; // 横壁の位置が縦壁の範囲内（同上）
      const key = `${Math.round(v.coord)}:${Math.round(h.coord)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({ x: v.coord, y: h.coord });
    }
  }
  return points;
}

// 壁のある意匠中心線（centerLineKind==='center'。補助線は除く）を柱アンカーの第2候補にする
// （ユーザー指示2026-09-14「壁のある『中心』との交点にも柱は立つ」）。通り芯・梁芯（findBeamAnchorCL）が
// 無い位置——梁芯の除外集合で梁芯CLが作られない壁など——でも、壁が乗っている中心線があれば柱を立てる。
// 中心線は構造モードで非表示だが、柱の位置は effectiveValue から導出されるので描画には影響しない。
function findCenterAnchorCL(graph, centerLineType, coord) {
  return structuralAnchorAt(graph, { centerLineType, coord, tier: 'secondary' });
}

// 上階柱直下の柱（ステップ3b）のアンカー解決: 通り芯／梁芯（findBeamAnchorCL）→ 壁のある意匠中心線
// （findCenterAnchorCL）。3aの柱アンカー解決（wallIntersectionPointsのループ内の2段）と同じ2段で、
// CLは新設しない（どちらも無ければnull）。裁定（QA F2・2026-09-16）：3b限定の「±柱幅/2の寄せ」
// （3段目）は実データ3文書（moku1/moku2/2026模試）で使用0回・テスト0件・アンカー述語の3つ目の
// コピーだったため削除した——アンカーが無い候補はCLを新設せず素直に見送る。
function resolveWoodColumnAnchorCL(graph, centerLineType, coord) {
  return findBeamAnchorCL(graph, centerLineType, coord) ?? findCenterAnchorCL(graph, centerLineType, coord);
}

// run（フェーズA・Bとも）をcolumnSplitPointsへ渡す前に、自階フットプリント境界（footprintBreakCLs）
// も分割点候補へ足す（ステップA-1）——境界をまたいだままの区間は「中点が内側にたまたま入っている
// から通る／分割で中点が外側に転げて丸ごと落ちる」という分割粒度依存になるため、フットプリントの
// 帰属が変わる位置では必ず先に切っておく。返り値はcolumnSplitPointsのcolumnPoints引数と同じ形
// （{x,y}）——垂直軸(perp=x)なら`x`をaxisCoordに固定しbreak値を`y`へ、水平軸ならその逆にする
// （columnSplitPointsの`Math.abs((isVertical?p.x:p.y)-axisCoord)<tol`フィルタを通すため）。
// axisCoordはcolumnSplitPoints呼び出し側と同じaxisCL.effectiveValueを使う（呼び出し側と単位を揃える）。
function footprintBreakPoints(selfGate, graph, axisCL, isVertical, run) {
  // 境界座標はcl.effectiveValue（分割点として使う値。CLがドラッグ中でも現在の暫定位置に追従する）。
  // ゲート自体の内外判定（footprintBreakCLs内部が使う.value基準の判定）はここでは変更しない——
  // footprintBreakCLsが返すCL実体そのものを読み替えるだけで、判定ロジックには触れない（QA指摘）。
  return footprintBreakCLs(selfGate, graph, axisCL, isVertical, run.lo, run.hi)
    .map(cl => (isVertical
      ? { x: axisCL.effectiveValue, y: cl.effectiveValue }
      : { x: cl.effectiveValue, y: axisCL.effectiveValue }));
}

// 建具の袖柱（下記）の走行方向アンカー: resolveWoodColumnAnchorCL は座標に厳密一致（CL_OVERLAP_TOL_MM
// 以内）するCLしか返さないが、袖座標（開口の外形±クリアランス±柱寸/2）は一般に既存CLへ厳密一致
// しない——CLは新設しない方針のため、resolveWoodColumnAnchorCL が対象にするのと同じ集合（通り芯・
// 梁芯・壁のある意匠中心線）の中から coord に最も近いものを「その線」として使う（柱の実際のAXIS座標は
// core/structuralEntities.js の袖柱AXIS導出が開口位置から都度計算するため、ここで選ぶCLの座標そのもの
// は走行方向の実位置には使われない——existing判定・wallGate等のためのプレースホルダー）。
// 候補が1件も無ければnull（見送り）。
// タイブレークは決定的に：距離が同値なら effectiveValue 昇順→id 昇順（QA指摘Major-2・2026-09-18）
// ——旧実装はgraph.centerLinesの走査順で先着勝ちだったため、完全な同距離タイ（例: 通り芯グリッドの
// 中点）で走査順が変わる（CLの追加順・undo/redo等）とアンカーCLの選び方自体が変わり、3h-2の
// オフセット柱のcolumnAnchorKey（実位置基準に変更済み）は影響を受けないが、生成に使うverticalCL/
// horizontalCL（プレースホルダ）オブジェクト自体が変わってしまう問題があった。袖柱のcrossCL解決も
// 本関数を共有するため同じ恩恵を受ける。
export function nearestAnchorCL(graph, centerLineType, coord) {
  let best = null, bestDist = Infinity;
  for (const cl of structuralAnchorCandidates(graph, { centerLineType, tier: 'any' })) {
    const dist = Math.abs(cl.effectiveValue - coord);
    if (!best || dist < bestDist
      || (dist === bestDist && cl.effectiveValue < best.effectiveValue)
      || (dist === bestDist && cl.effectiveValue === best.effectiveValue && cl.id < best.id)) {
      bestDist = dist; best = cl;
    }
  }
  return best;
}

// 建具の袖柱の法線方向アンカーに使う「下地オーナー壁」を解決する。findHostWall（openings/
// openingGeometry.js）はシンボル配置・当たり判定向けで、開口を包含する壁のうちwallSideが一致する
// ものを返す——それが仕上げのみの薄壁（backingRange===null。部屋境界の「下地オーナー壁＋仕上げ薄壁」
// ペアの薄壁側）だと下地帯が無くwallBackingCenterCoordが例外になる。その場合は同じaxisCL・向きで
// 開口を包含する下地オーナー壁（backingRange!=null）を探し直す——wallSideの厳格一致は要求しない
// （findOpeningsOnWallと同じ規律。開口は物理的にその位置の壁すべてを貫通するため）。
// 該当なしはnull（呼び出し側が見送る）。
function findHostBackingWall(opening, graph) {
  const hostWall = findHostWall(opening, graph);
  if (hostWall?.backingRange != null) return hostWall;
  const lo = opening.coord1, hi = opening.coord2;
  let best = null, bestAbs = Infinity;
  for (const w of graph.walls) {
    if (w.backingRange == null || w.isVertical !== opening.isVertical || w.axisCL.id !== opening.axisCL.id) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (lo < wLo - WALL_JUNCTION_TOL_MM || hi > wHi + WALL_JUNCTION_TOL_MM) continue;
    if (Math.abs(w.axisOffset) < bestAbs) { bestAbs = Math.abs(w.axisOffset); best = w; }
  }
  return best;
}

/**
 * 在来木造の柱を「自階の壁が交差する位置」（ステップ3a）・「壁の自由端」（ステップF-1・2026-09-19裁定）・
 * 「1つ上の実体階の柱の直下」（ステップ3b）・
 * 「1つ上の実体階の頭つなぎ／受梁が自階の壁を横切る位置」（ステップ3h-2）に自動生成し、候補に無い
 * 自動生成の柱を撤去する。
 *  - 3a候補＝自階の下地オーナー壁（selfWallSegments）の交点・T字・コーナー。各座標を通り芯／梁芯CL（無ければ
 *    壁のある意匠中心線）へ解決できた点だけが対象（解決できない方向がある点は生成しない。壁の梁芯CLは
 *    呼び出し側が先に生成する）。
 *  - F-1候補＝自階の下地オーナー壁runの自由端（wallRunFreeEnds。直交する下地オーナー壁が
 *    WALL_JUNCTION_TOL_MM以内に無い端。階段の上り口・下り口の開口辺等で壁がCL位置ちょうどで
 *    止まる箇所に生じる）。腰壁・垂れ壁の指定がある辺の自由端は対象外（isKneeDropFreeEnd。
 *    別ステップで端部材として扱うため）。アンカーは3b/3h-2と同じ2段resolveWoodColumnAnchorCL→
 *    オフセットアンカー（nearestAnchorCL）フォールバックを共有する（bestByPointへ直接合流し、
 *    inRunは自由端自身のため常に真とみなす）。2026-09-14裁定「壁の自由端には柱を立てない」は
 *    ここで撤回した（ユーザー指摘2026-09-19「壁の自由端は柱を立てる」）。
 *  - 3b候補＝aboveColumns（1つ上の実体階の柱、role!=='foundation'）のうち、自階の壁の下地帯の内側
 *    （pointsOnWallLines）かつ、その壁線の3c（wallSegments。自階＋1つ下の階）と同一のthrough-run
 *    （wallLineThroughRuns）の内側にあるもの。壁が無ければ立てない（帯に一致する壁が無い＝候補から外れる。
 *    その位置の梁は受梁のまま）。アンカーは壁線自身の座標（法線方向）と上階柱の走行方向座標を
 *    resolveWoodColumnAnchorCL（通り芯／梁芯→意匠中心線。3aと同じ2段。CLは新設しない）で解決し、
 *    いずれか解決できなければその候補は見送る。
 *  - 3h-2候補＝aboveBeamSegments（1つ上の実体階の柱生成の点源＝role:'primary'（beamTypeを問わない。
 *    壁線由来の大梁・頭つなぎ・受梁のいずれも含む）または'floor'（床梁）の梁の区間。
 *    columnSeedBeamSegments参照。beamWallCrossPointsが「壁とみなして」自階の壁（selfWallSegments）と
 *    交わる点を求める）を、3bのAXIS座標点（aboveColumns由来）と合流し、pointsOnWallLines→bestByPoint
 *    （決定的タイブレーク）→isInRun（through-run判定）→2段アンカー解決という同じ経路に通す（柱は壁の
 *    中にしか立たないため「自階に壁が無ければ立たない」規律も共有する）。**法線方向のCL（axisCL）は
 *    解決できるが走行方向のCL（crossCL）が解決できない場合、3b・3h-2どちらの由来でもオフセットアンカー
 *    （nearestAnchorCL＋WoodColumn.woodAxisOffset。袖柱と同じプレースホルダ方式）へフォールバックする**
 *    （B-3・2026-09-19裁定「柱の追加は最上階から順に、最下階まで可能な限り同位置に」）——旧実装は
 *    3h-2由来だけ救う設計だったが、上階柱の直下（3b。特に袖柱直下・ポーチ等、走行方向に厳密一致する
 *    CLが無い位置）にも同じ理由で救う必要があるため、3bにも解禁した。CLは新設しない。
 *  - 袖柱候補（ステップ「建具の袖柱」）＝自階の全開口（graph.openings）の両袖に、開口の外形
 *    （coord1/coord2）からclearanceMm(5)+柱寸/2だけ離れた走行方向座標（woodFraming.js
 *    jambColumnPositions）。法線方向のアンカーは開口のホスト壁（openings/openingGeometry.js
 *    findHostWall）の下地帯中心（wallBackingCenterCoord）を resolveWoodColumnAnchorCL で解決した
 *    CL（3a/3b/3h-2と同じ2段）。走行方向のCLは厳密一致するCLがあるとは限らないため
 *    nearestAnchorCL（最寄りの通り芯／梁芯／意匠中心線。CLは新設しない）で仮のアンカーを持つだけ——
 *    実際のAXIS座標は core/structuralEntities.js の袖柱AXIS導出（column.woodJambRef）が開口位置から
 *    都度計算する（.claude/structural-model.md「建具の袖柱」節参照）。3a/3b/3h-2のslots確定後に
 *    評価し、候補柱＋既存柱（locked含む。ただし既存の袖柱自身は除く——冪等性のため）の断面矩形
 *    （finish/columnWrap.js bareColumnRect）と重なれば生成しない。隣接建具どうしの袖が互いに
 *    重なる場合は決定的な順序（開口id昇順→side）で先着1本。ホスト壁・アンカーが解決できない開口は
 *    見送る（例外を投げない）。
 *  - 3a・F-1・3b・3h-2・袖柱は同じslotsへ合流する（袖柱は`jamb:${openingId}:${side}`、それ以外は
 *    columnSlotKeyで自然に重複排除。撤去ループに別枠を持たせない＝由来ごとに別ロジックで消える
 *    ことがない）。既存判定・撤去判定のキーは columnAnchorKey（core/structuralEntities.js）——
 *    袖柱はCLペアでは同一性を保証できない（開口移動で最寄りCLが変わりうる）ため。
 *  - 除外集合（excludedColumnSlots）は3a・F-1・3b・3h-2・袖柱共通（通り芯交点の柱と同じ規律）。建物
 *    フットプリントのゲート（wallGate）はF-1・3b・3h-2——袖柱はホスト壁が自階の下地オーナー壁
 *    （＝フットプリント内）なので掛けない。3aは常にフットプリント内（壁の交点自体が壁の中）のため
 *    実質ゲートの影響を受けない。
 *  - 壁が無い階は生成も撤去もしない（既存の柱を保全。裁定2026-09-14）。F-1・3b・3h-2・袖柱もこのガードの対象
 *    （segments.length===0で早期returnするため、壁が無ければF-1・3b・3h-2・袖柱候補も一切評価しない）。
 *  - 撤去＝候補に無い位置の柱のうち dimensionStatus==='auto' かつ通常柱（杭を除く）。手動固定は保持し、
 *    除外集合には記録しない（deleteClassificationOverflow と同じ「可逆」の規律。通り芯交点で生成された
 *    旧来の柱を壁交点方式へ置き換えるための移行でもある）。
 * @param {object} graph
 * @param {object} project
 * @param {object|null} [wallGate]
 * @param {object[]} [aboveColumns] - 1つ上の実体階の柱集合（省略・null・[]はいずれも3b候補なし＝従来と同結果）
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} [wallSegments] - 3cと同じ
 *   壁区間（自階＋1つ下の階、マージ不要のプレーン配列）。3b・3h-2のthrough-run判定に使う。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, role:string}>} [aboveBeamSegments] -
 *   1つ上の実体階の柱生成の点源（role:'primary'|'floor'の梁の区間。省略・null・[]はいずれも3h-2候補
 *   なし＝従来と同結果。呼び出し側が structural/wallBeamAxes.js columnSeedBeamSegments で peek 済みの
 *   上階graphから写して渡す）
 * @param {Array<{axisX:number, axisY:number, role?:string}>} [belowColumns] - 1つ下の実体階の柱集合
 *   （ユーザー裁定2026-09-19「柱の追加は最上階から順に、最下階まで可能な限り同位置に」——3iの候補
 *   優先度ラベル'below'に使う。優先順自体の唯一の出どころはwoodFraming.jsのSUPPORT_SPAN_PRIORITY_ORDER
 *   （現状struct＞center＞below。どれも採れなければ910グリッドへフォールバック）。呼び出し側は
 *   autoFillBeamsForStructureの同名引数（3c-2b）と同じ値をそのまま渡せる——
 *   structuralRecompute.jsの`belowGraph?.columns`。省略・null・[]は従来どおり（belowの候補なし）。
 *   role:'foundation'（杭）は候補にしない）。
 * @param {ReturnType<import('./wallBeamAxes.js').createWallSourceCache>} [wallSourceCache] - 1回の
 *   再計算内で壁区間（selfWallSegments）をmemoするキャッシュ（ステップC）。省略時は従来どおり
 *   自前で全走査する。
 * @returns {{created: object[], removed: string[], jambSkipped: object[], iiPicks: Array<{isVertical:boolean,
 *   coord:number, along:number, kind:string, x:number, y:number}>}} kindはSUPPORT_SPAN_PRIORITY_ORDERの
 *   要素、または'grid'。iiPicksは3iが採用した候補の診断用一覧（生成の可否判定には使わない。
 *   probe woodSupportSpanProbe.mjsが由来内訳の報告に使う）
 */
export function autoFillWoodColumns(graph, project, wallGate = null, aboveColumns = [], wallSegments = [], aboveBeamSegments = [], belowColumns = [], wallSourceCache = undefined) {
  const rules = rulesFor(effectiveStructure(graph, project));
  const segments = selfWallSegments(graph, wallSourceCache);
  // 壁が1本も無い階（仕上げモード未着手で壁が未生成）は何もしない＝既存の柱を保全する
  // （ユーザー裁定2026-09-14。候補0で全撤去すると、非アクティブ階がモード境界で無通知に柱を失う）。
  // 壁が生成された時点で壁交点方式へ切り替わる。
  if (segments.length === 0) return { created: [], removed: [], jambSkipped: [], iiPicks: [] };
  // F-1・F-2（2026-09-19裁定）: 自由端（自階の下地オーナー壁runの端で直交する下地オーナー壁が
  // WALL_JUNCTION_TOL_MM以内に無いもの。腰壁・垂れ壁の辺は対象外）の点源。柱（下記bestByPointへの
  // 合流）・通し梁/土台のrun延長（wallLineThroughRunsのfreeEnds引数）の両方がこれを共有する。
  const freeEnds = selfWallFreeEnds(graph, segments);
  // QA裁定2026-09-19（Major-1）: role:'primary'の区間はrunへ束ね直してから3h-2（beamWallCrossPoints）・
  // 3iの両方へ渡す——素の区間（前回パスで下階柱によって分割済み）をそのまま使うと、下階柱の位置
  // （＝分割点＝梁端）が点源に混ざり、3h-2/3iの出力（新しい下階柱）が次パスの入力（同じ梁の分割点）を
  // 変える自己参照ループになる。どの位置で分割済みかは階の処理順（どちらの階を先に処理したか）に
  // 依存するため、結果が順序依存になっていた（実データmoku3で確認。.claude/structural-model.md
  // 「3iの収束は処理順に依存しない」節参照）。floor（床梁）は下階柱で分割されないため素通しする。
  const mergedAboveBeamSegments = mergePrimaryBeamRuns(aboveBeamSegments);
  const slots = new Map();
  for (const p of wallIntersectionPoints(segments)) {
    // アンカーは通り芯または壁由来の梁芯CL（findBeamAnchorCL＝梁芯の重複ガードと同じ述語）。
    // 無ければ壁のある意匠中心線（findCenterAnchorCL）。
    const verticalCL = findBeamAnchorCL(graph, CenterLineType.VERTICAL, p.x) ?? findCenterAnchorCL(graph, CenterLineType.VERTICAL, p.x);
    const horizontalCL = findBeamAnchorCL(graph, CenterLineType.HORIZONTAL, p.y) ?? findCenterAnchorCL(graph, CenterLineType.HORIZONTAL, p.y);
    if (!verticalCL || !horizontalCL) continue;
    slots.set(columnSlotKey(verticalCL, horizontalCL), { verticalCL, horizontalCL });
  }

  // ループ不変（3a/3b/3h-2/袖柱/3iで共通に使う）なので先に1回だけ解決する（3b近接ガード・3iの安全弁が
  // ここで使う。以前は3bのCL解決分より後ろで定義していたが、ガード追加のため前倒しした——他の
  // 消費側（袖柱・オフセット候補）の計算順序・値は変えていない）。
  const columnSection = woodColumnSectionId(graph, project) ?? rules.defaultSections.column;
  // 【AXISで統一】候補柱・既存柱・オフセット候補・袖柱のすべてAXIS（axisX/axisY。偏心を含まない）
  // 基準で重なり・近接を判定する——柱寸105の階で外壁上の共通柱に非ゼロ偏心（conformWoodColumnEccentricity。
  // ±(120-105)/2等）が付いていても、その偏心量に判定が左右されないようにするため
  // （.claude/structural-model.md「AXISで一致・ACTUALで止める」と同じ規律）。
  const axisOffsetOf = (cl) => graph.columnAxisOffsets.get(cl.id) ?? 0;
  const columnWidth = findSectionEntry(columnSection)?.width;
  // 現時点のslots（候補柱。3a・このあと確定していく3b/3h-2/袖柱/3iを含む）＋既存柱（自階graph.columns。
  // role:'foundation'除く）のAXIS点列。3b近接ガード・3iの安全弁が共有する単一の抽出（二重実装しない）。
  // slotsは以後も成長するため、呼び出しのたびに読み直す（クロージャで`slots`を参照する関数）。
  const columnAxisPoints = () => [
    ...[...slots.values()].map(({ verticalCL, horizontalCL, woodAxisOffset }) => ({
      x: woodAxisOffset?.isVertical ? verticalCL.effectiveValue + woodAxisOffset.offset : verticalCL.effectiveValue + axisOffsetOf(verticalCL),
      y: woodAxisOffset && !woodAxisOffset.isVertical ? horizontalCL.effectiveValue + woodAxisOffset.offset : horizontalCL.effectiveValue + axisOffsetOf(horizontalCL),
    })),
    ...graph.columns.filter(c => c.role !== 'foundation').map(c => ({ x: c.axisX, y: c.axisY })),
  ];
  // 裁定（2026-09-19）: 3b・3iが共有する近接ガード述語——指定位置(axisCoord基準の壁線・along)と
  // 同じ壁線上（法線方向がtol内一致）に、points（既存柱・候補柱）の中で中心間距離が2×柱寸未満
  // （かつ同位置=tol内ではない。同位置は従来どおり同一スロットに畳む）のものがあれば true。
  // その既存柱が支持を担うものとみなし、新しい柱を立てない（3iの安全弁と同じ述語を共有する）。
  const hasNearbyColumnOnSameLine = (points, isVertical, axisCoord, along) => {
    if (!Number.isFinite(columnWidth)) return false;
    const minCenterDistMm = 2 * columnWidth;
    return points.some(p => {
      const pAxisCoord = isVertical ? p.x : p.y;
      if (Math.abs(pAxisCoord - axisCoord) >= CL_OVERLAP_TOL_MM) return false;
      const pAlong = isVertical ? p.y : p.x;
      const d = Math.abs(pAlong - along);
      return d >= CL_OVERLAP_TOL_MM && d < minCenterDistMm;
    });
  };

  // 3b: 上階柱直下の柱。role:'foundation'（杭）は候補にしない——上階の杭の直下に柱を立てる意味は無い。
  // F-2: 自由端をrunの端点候補へ加える（inRunの範囲が自由端まで広がる。isInRunの帰結）。
  const lineRuns = wallLineThroughRuns(wallSegments, freeEnds);
  const isInRun = (isVertical, coord, along) => {
    const line = lineRuns.find(l => l.isVertical === isVertical && Math.abs(l.coord - coord) < CL_OVERLAP_TOL_MM);
    return !!line?.runs.some(r => along >= r.lo - CL_OVERLAP_TOL_MM && along <= r.hi + CL_OVERLAP_TOL_MM);
  };
  // AXIS（axisX/axisY。偏心を含まない）で候補位置を取る——個別柱の偏心（woodColumnOffset.js）で
  // 通り芯・梁芯との一致判定がずれないため（.claude/structural-model.md「AXISで一致・ACTUALで止める」）。
  const abovePoints = (aboveColumns ?? [])
    .filter(c => c.role !== 'foundation')
    .map(c => ({ x: c.axisX, y: c.axisY }));
  // 3h-2: 上階の柱生成の点源（role:'primary'|'floor'の梁。columnSeedBeamSegments）を「壁とみなして」
  // 自階の壁（segments）と交わる位置。柱は壁の中にしか立たない＝壁が無ければ3bと同じ理由で候補から
  // 外れる。B-3（2026-09-19）以降は3bと同じオフセットアンカー可否を共有するため、以下では区別しない。
  const tiePoints = beamWallCrossPoints(mergedAboveBeamSegments, segments);
  // pointsOnWallLinesは1点が複数の壁線に一致する場合、すべての一致を並び順非依存で返す。ここで
  // 決定的タイブレークで1点につき1件へ絞る：runに入る線を優先→|perp-coord|(dist)最小→coord昇順
  // （QA F6・2026-09-16。旧実装はsegments/graph.wallsの走査順で最初に一致した線を採っており、
  // runに入らない線が先に見つかると本来立つはずの候補が消える不具合だった）。
  const bestByPoint = new Map();
  function considerPoints(matches) {
    for (const m of matches) {
      const key = `${m.x}:${m.y}`;
      const inRun = isInRun(m.isVertical, m.coord, m.along);
      const cur = bestByPoint.get(key);
      if (!cur
        || (inRun && !cur.inRun)
        || (inRun === cur.inRun && m.dist < cur.dist)
        || (inRun === cur.inRun && m.dist === cur.dist && m.coord < cur.coord)) {
        bestByPoint.set(key, { ...m, inRun });
      }
    }
  }
  considerPoints(pointsOnWallLines(abovePoints, segments, WALL_JUNCTION_TOL_MM));
  considerPoints(pointsOnWallLines(tiePoints, segments, WALL_JUNCTION_TOL_MM));
  // F-1: 自由端そのものを点源として合流する（3b/3h-2と同じ2段アンカー解決・オフセットアンカー
  // フォールバックへ流す）。自由端は定義よりrunの境界そのものなので inRun を強制的に真にする——
  // 他の点源（3b/3h-2）と異なりisInRunの判定（wallSegments＝自階＋下階基準）に委ねない
  // （自由端の柱源は自階の壁だけで判定する。既にbestByPointにある点があれば譲る＝上書きしない）。
  for (const fe of freeEnds) {
    const key = `${fe.x}:${fe.y}`;
    if (!bestByPoint.has(key)) {
      bestByPoint.set(key, { isVertical: fe.isVertical, coord: fe.coord, along: fe.along, dist: 0, inRun: true });
    }
  }
  // オフセットアンカー候補: 走行方向のCLが解決できない場合はここでは確定させず pendingOffsetCandidates
  // へ積む——3a/3b/3h-2(CL解決分)のslotsが確定してから重なり判定する（評価順は
  // 3a/3b/3h-2(CL解決分) → オフセット分 → 袖柱。下記参照）。
  const pendingOffsetCandidates = [];
  for (const { isVertical, coord, along, inRun } of bestByPoint.values()) {
    if (!inRun) continue; // runの外（自由端側）、または壁の無い位置は立てない
    const axisType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const crossType = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const axisCL = resolveWoodColumnAnchorCL(graph, axisType, coord);
    const crossCL = resolveWoodColumnAnchorCL(graph, crossType, along);
    if (!axisCL) continue; // 法線方向のCLが無ければ見送る（アンカー解決不能な候補はCLを新設しない）
    if (!crossCL) {
      // B-3（2026-09-19裁定）：走行方向のCLが解決できないとき、3b・3h-2どちらの由来でも見送らず
      // pendingOffsetCandidatesへ積む（実際のオフセットアンカー解決・重なり判定は3a/3b/3h-2(CL解決分)の
      // slotsが確定してから行う）。旧実装（3h-2由来だけ救う）はこの一般化で不要になった。
      pendingOffsetCandidates.push({ isVertical, axisCL, crossType, along });
      continue;
    }
    // 3bガード（裁定2026-09-19）: 自階の同じ壁線上に既存柱・候補柱（3a等）が中心間距離2×柱寸未満
    // （かつ同位置ではない）であれば、その既存柱が支持を担うものとみなし新しい柱を立てない
    // （3iの安全弁と同じ述語hasNearbyColumnOnSameLineを共有する）。
    if (hasNearbyColumnOnSameLine(columnAxisPoints(), isVertical, coord, along)) continue;
    const verticalCL = isVertical ? axisCL : crossCL;
    const horizontalCL = isVertical ? crossCL : axisCL;
    slots.set(columnSlotKey(verticalCL, horizontalCL), { verticalCL, horizontalCL });
  }

  // columnSection・axisOffsetOfは3bガードのため関数冒頭で解決済み（上記columnAxisPoints参照）。

  // オフセットアンカー候補の確定（B-3・3b/3h-2共通）: 3a/3b/3h-2(CL解決分)のslotsが確定した後に、
  // 走行方向の最寄りの解決可能なCL（nearestAnchorCL。袖柱と同じプレースホルダ）＋オフセットでアンカーを
  // 立てる。重なり判定は候補柱（slots）＋既存柱（locked含む。ただし既存のオフセット柱自身は除く——袖柱が
  // woodJambRef列を除くのと同じ「自分自身に自己ブロックされて撤去→再生成を繰り返す」事故を避けるため）
  // の断面矩形（AXIS基準・rectsOverlapを袖柱と共有）。3aは対象外（壁交点は常に厳密一致CLで解決するため
  // オフセット候補自体が生じない）。
  const offsetBlockingRects = [
    ...[...slots.values()].map(({ verticalCL, horizontalCL }) => bareColumnRect({
      sectionDefId: columnSection, rotation: 0,
      x: verticalCL.effectiveValue + axisOffsetOf(verticalCL), y: horizontalCL.effectiveValue + axisOffsetOf(horizontalCL),
    })),
    ...graph.columns.filter(c => !c.woodJambRef && !c.woodAxisOffset).map(c => bareColumnRect({
      sectionDefId: c.sectionDefId, rotation: c.rotation, x: c.axisX, y: c.axisY,
    })),
  ];
  const acceptedOffsetRects = [];
  for (const cand of pendingOffsetCandidates) {
    const anchor = nearestAnchorCL(graph, cand.crossType, cand.along);
    if (!anchor) continue; // 候補（通り芯／梁芯／意匠中心線）が1本も無ければ見送る
    const woodAxisOffset = { isVertical: !cand.isVertical, offset: cand.along - anchor.effectiveValue };
    const verticalCL = cand.isVertical ? cand.axisCL : anchor;
    const horizontalCL = cand.isVertical ? anchor : cand.axisCL;
    const x = woodAxisOffset.isVertical ? verticalCL.effectiveValue + woodAxisOffset.offset : verticalCL.effectiveValue + axisOffsetOf(verticalCL);
    const y = !woodAxisOffset.isVertical ? horizontalCL.effectiveValue + woodAxisOffset.offset : horizontalCL.effectiveValue + axisOffsetOf(horizontalCL);
    const rect = bareColumnRect({ sectionDefId: columnSection, rotation: 0, x, y });
    if ([...offsetBlockingRects, ...acceptedOffsetRects].some(r => rectsOverlap(rect, r))) continue; // 他の柱と重なれば見送る
    // 3bガード（裁定2026-09-19）: CL解決分と同じ述語をオフセットアンカー分にも適用する
    // （cand.axisCL.effectiveValueがこの壁線自身の軸座標。二重実装しない）。
    if (hasNearbyColumnOnSameLine(columnAxisPoints(), cand.isVertical, cand.axisCL.effectiveValue, cand.along)) continue;
    acceptedOffsetRects.push(rect);
    // キーは実位置基準（core/structuralEntities.js columnAnchorKeyと同じ式・同じ理由。QA指摘Major-2）
    // ——アンカーCL（verticalCL/horizontalCLのうちoffset側）の選び方に依らず同一性が保たれる。
    slots.set(`off:${Math.round(x)}:${Math.round(y)}`, { verticalCL, horizontalCL, woodAxisOffset });
  }

  // 建具の袖柱: 3a/3b/3h-2(CL解決分・オフセット分)のslots確定後に評価する（架構本体の候補が確定してから
  // でないと「候補柱と重なれば省略」の判定基準が揃わないため）。見送った候補の理由
  // （'noHost'|'noAnchor'|'overlap'）をjambSkippedへ積む——wallBeamAxisFollow.jsのskipped配列と同じ
  // 「戻り値に理由付きで積む」規約（probe woodJambColumnProbe.mjsが内訳を報告するのに使う。生成の
  // 可否判定自体は変えない）。
  const jambSkipped = [];
  // columnWidthは3bガードのため関数冒頭で解決済み（上記columnAxisPoints参照）。
  if (Number.isFinite(columnWidth)) {
    // 候補柱（3a/3b/3h-2のslots）＋既存柱（locked含む。ただし既存の袖柱自身は除く——このパスで
    // 開口から再計算した候補と自分自身を重なり判定すると、冪等（2回目も同じ位置に生成される）が
    // 壊れて毎パス撤去→再生成を繰り返す）の断面矩形。
    // slots候補のAXIS座標: 通常はCL.effectiveValue+columnAxisOffsets、3h-2のオフセットアンカー候補
    // （woodAxisOffset非null）はその軸だけ`crossCL.effectiveValue + offset`（実際に生成される柱の
    // axisX/axisYと同じ式。core/structuralEntities.js _woodAxisOffset参照）。
    const baseBlockingRects = [
      ...[...slots.values()].map(({ verticalCL, horizontalCL, woodAxisOffset }) => bareColumnRect({
        sectionDefId: columnSection, rotation: 0,
        x: woodAxisOffset?.isVertical ? verticalCL.effectiveValue + woodAxisOffset.offset : verticalCL.effectiveValue + axisOffsetOf(verticalCL),
        y: woodAxisOffset && !woodAxisOffset.isVertical ? horizontalCL.effectiveValue + woodAxisOffset.offset : horizontalCL.effectiveValue + axisOffsetOf(horizontalCL),
      })),
      ...graph.columns.filter(c => !c.woodJambRef).map(c => bareColumnRect({
        sectionDefId: c.sectionDefId, rotation: c.rotation, x: c.axisX, y: c.axisY,
      })),
    ];
    const openingsById = new Map(graph.openings.map(o => [o.id, o]));
    const jambCandidates = jambColumnPositions(
      [...openingsById.values()].map(o => ({ id: o.id, lo: o.coord1, hi: o.coord2 })),
      columnWidth,
    ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.side - b.side)); // 決定的順序（開口id昇順→side）

    const acceptedRects = [];
    for (const cand of jambCandidates) {
      const opening = openingsById.get(cand.id);
      const hostWall = findHostBackingWall(opening, graph);
      if (!hostWall) { jambSkipped.push({ openingId: opening.id, side: cand.side, jamb: cand.jamb, reason: 'noHost' }); continue; } // 下地オーナー壁が解決できない開口は見送る
      const axisType = opening.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
      const crossType = opening.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
      const axisCL = resolveWoodColumnAnchorCL(graph, axisType, wallBackingCenterCoord(hostWall));
      const crossCL = axisCL ? nearestAnchorCL(graph, crossType, cand.jamb) : null;
      if (!axisCL || !crossCL) { jambSkipped.push({ openingId: opening.id, side: cand.side, jamb: cand.jamb, reason: 'noAnchor' }); continue; } // アンカー解決不能な候補は見送る（CLは新設しない）
      const verticalCL   = opening.isVertical ? axisCL : crossCL;
      const horizontalCL = opening.isVertical ? crossCL : axisCL;
      // 袖柱自身もAXIS基準（axisCL側はeffectiveValue+axisOffsetOf、走行方向は開口位置から
      // 導出したcand.jamb＝そのままAXIS。core/structuralEntities.jsの_woodJambAxisが実柱で
      // 計算する値と同じ式）。
      const axisNormal = axisCL.effectiveValue + axisOffsetOf(axisCL);
      const rect = bareColumnRect({
        sectionDefId: columnSection, rotation: 0,
        x: opening.isVertical ? axisNormal : cand.jamb,
        y: opening.isVertical ? cand.jamb : axisNormal,
      });
      const blocker = [...baseBlockingRects, ...acceptedRects].find(r => rectsOverlap(rect, r));
      if (blocker) {
        // 診断用の重なり量(mm)＝矩形交差の短辺（x/yどちらの重なり幅が小さいか。probe woodJambColumnProbe.mjs
        // が省略理由の内訳を報告するのに使う。生成の可否判定自体には使わない＝rectsOverlapが唯一の判定）。
        const overlapMm = Math.min(
          Math.min(rect.xHi, blocker.xHi) - Math.max(rect.xLo, blocker.xLo),
          Math.min(rect.yHi, blocker.yHi) - Math.max(rect.yLo, blocker.yLo));
        jambSkipped.push({ openingId: opening.id, side: cand.side, jamb: cand.jamb, reason: 'overlap', overlapMm });
        continue; // 他の柱と重なれば省略
      }
      acceptedRects.push(rect);
      slots.set(`jamb:${opening.id}:${cand.side}`, {
        verticalCL, horizontalCL,
        woodJambRef: { openingId: opening.id, side: cand.side, isVertical: opening.isVertical },
      });
    }
  }

  // ---- 3i: 梁の支持長1820ルール（ユーザー指示2026-09-19「梁の支持長が1820を超える場合、1820以内の
  // 下階に壁あり直交する通り芯、中心があればそこ、なければ、支持長を1820以下に分ける910グリッドに柱を
  // 追加。最上階から順に行い、最下階まで可能な限り同位置に柱を追加」）。対象はmergedAboveBeamSegments
  // のうちrole:'primary'（大梁・頭つなぎ・受梁。beamType不問）のみ——床梁・土台・軒桁等は対象外。
  // 3a/3b/3h-2(CL解決・オフセット)・袖柱のslotsが確定した後に評価する（袖柱も支持点になるため最後に置く）。
  // 純関数supportSpanColumnPositions（woodFraming.js）へ支持点・候補CL（優先度つき）・isAllowed述語を
  // 渡すだけで、「支持長ごとの分割位置決め」自体はそちらに委ねる（graph依存の判定はisAllowedに閉じ込める）。
  // 【既存の割り切り】重なり判定（isAllowed (e)・iiBlockingRects）は候補・既存柱とも階の共通柱幅
  // （columnSection由来）で矩形を作り、既存柱の個別柱寸（woodColumnWidthMm）は見ない——個別柱寸が
  // 共通値より細い階の柱に対しては実際より広めの矩形とみなし「立てない」側に倒れうる（過剰回避）。
  // 個別柱寸は柱1本の見た目の寸法だけを変える機能で他の帰結に波及させない設計のため、3iの重なり判定
  // もこれに合わせて共通値で近似する（3h-2オフセット候補と同じ既存の割り切り。個別柱寸の全既存柱への
  // 波及テストは範囲外）。
  // 診断用: 3iが採用した候補の一覧（3iが動かない階では常に空配列）。戻り値スコープの外で宣言する。
  const iiPicks = [];
  if (rules.framing && mergedAboveBeamSegments.some(s => s.role === 'primary')) {
    // 【QA裁定2026-09-19】生成ループ（下記）と同じ「除外集合・wallGateで落ちるか」を共有する——
    // 落ちるslot（ユーザーが消した位置・フットプリント外）をsupports/重なり判定の入力にそのまま含めると、
    // 実際には生成されない位置を「もう支持されている／もう埋まっている」と誤認し、本来必要な3iの柱を
    // 見送ってしまう（除外された3i柱の代替位置が立たない事故になる）。
    const passesGate = (verticalCL, horizontalCL, woodJambRef, woodAxisOffset) => {
      if (!wallGate || woodJambRef) return true; // 袖柱はゲート対象外（下地オーナー壁の中＝フットプリント内保証）
      const gateVerticalCL = woodAxisOffset?.isVertical ? { value: verticalCL.value + woodAxisOffset.offset } : verticalCL;
      const gateHorizontalCL = woodAxisOffset && !woodAxisOffset.isVertical ? { value: horizontalCL.value + woodAxisOffset.offset } : horizontalCL;
      return wallGate.intersectionInBuilding(gateVerticalCL, gateHorizontalCL);
    };

    // このステージ開始時点のslots（3a/3b/3h-2/袖柱＝このパスで毎回フレッシュに再導出される。ただし
    // 除外集合・wallGateで落ちる分＝実際には生成されないものは除く）＋既存柱のうち手動固定
    // （dimensionStatus!=='auto'）分のAXIS座標——3iの支持点集合・重なり判定の両方がこれを参照する
    // （3h-2オフセット候補と同じ式。woodAxisOffset分は実位置へ差し替える）。
    // 【自己ブロック回避・冪等性】既存柱のうち auto（自動生成）分は含めない——3iが前回パスで生成した
    // 自分自身の柱（撤去はこの関数の最後に行うため、このループの時点ではまだ graph.columns に残っている）
    // を支持点・重なり判定の入力に混ぜると、「その位置はもう支持されている／もう埋まっている」と誤認して
    // 今回パスで同じ柱を再導出しない（＝slotsに入らない）ため、最後の撤去ループが「候補に無い」として
    // 削除してしまい、撤去→非生成→撤去…と冪等にならない（実データ回帰で発覚。3a/3b/3h-2/jambの出力は
    // すべてslots側からフレッシュに供給されるため、autoの既存柱を除いても実害は無い）。
    // 【注意・袖柱slot】slots内の袖柱エントリのverticalCL/horizontalCLは「走行方向はnearestAnchorCLの
    // プレースホルダ」（実位置ではない。JSDoc「建具の袖柱」節参照）——woodAxisOffset分と同じ式で読むと
    // 実位置とズレる。袖柱の実AXISは開口位置から都度導出する必要があるため、jamb block（上記）と同じ式
    // （axisNormal＝axisCL.effectiveValue+axisOffsetOf、走行方向＝jambAxisValue）で個別に解決する。
    const slotAxisPoint = ({ verticalCL, horizontalCL, woodAxisOffset, woodJambRef }) => {
      if (woodJambRef) {
        const opening = graph.openings.find(o => o.id === woodJambRef.openingId);
        if (opening) {
          const axisCL = woodJambRef.isVertical ? verticalCL : horizontalCL;
          const axisNormal = axisCL.effectiveValue + axisOffsetOf(axisCL);
          const jamb = jambColumnPositions([{ id: opening.id, lo: opening.coord1, hi: opening.coord2 }], columnWidth)
            .find(j => j.side === woodJambRef.side)?.jamb;
          if (Number.isFinite(jamb)) {
            return { x: woodJambRef.isVertical ? axisNormal : jamb, y: woodJambRef.isVertical ? jamb : axisNormal };
          }
        }
      }
      return {
        x: woodAxisOffset?.isVertical ? verticalCL.effectiveValue + woodAxisOffset.offset : verticalCL.effectiveValue + axisOffsetOf(verticalCL),
        y: woodAxisOffset && !woodAxisOffset.isVertical ? horizontalCL.effectiveValue + woodAxisOffset.offset : horizontalCL.effectiveValue + axisOffsetOf(horizontalCL),
      };
    };
    const iiAxisPoints = [
      ...[...slots.entries()]
        .filter(([key, { verticalCL, horizontalCL, woodJambRef, woodAxisOffset }]) =>
          !graph.excludedColumnSlots.has(key) && passesGate(verticalCL, horizontalCL, woodJambRef, woodAxisOffset))
        .map(([, entry]) => slotAxisPoint(entry)),
      ...graph.columns.filter(c => c.role !== 'foundation' && c.dimensionStatus !== 'auto').map(c => ({ x: c.axisX, y: c.axisY })),
    ];
    // 重なり判定用の断面矩形。ステージ開始時点のスナップショットに加え、3i自身が採用した候補も
    // pickごとに累積する（下記picks処理ループ）——同一パス内で別軸・別runの3i候補どうしが数mm差の
    // 別キーで近接して立つのを防ぐ（QA指摘Minor）。
    const iiBlockingRects = Number.isFinite(columnWidth)
      ? iiAxisPoints.map(({ x, y }) => bareColumnRect({ sectionDefId: columnSection, rotation: 0, x, y }))
      : [];

    // 3iの1候補(along)を実CLペア／オフセットアンカーへ解決する（isAllowedの事前チェックとpicks処理の
    // 両方から呼ぶ単一実装。二重実装しない）。法線方向のCL（壁自身の軸）が無ければnull。
    function resolveIiCandidate(seg, axisType, crossType, along) {
      const axisCL = resolveWoodColumnAnchorCL(graph, axisType, seg.coord);
      if (!axisCL) return null;
      const crossCL = resolveWoodColumnAnchorCL(graph, crossType, along);
      if (crossCL) {
        const verticalCL = seg.isVertical ? axisCL : crossCL;
        const horizontalCL = seg.isVertical ? crossCL : axisCL;
        return {
          verticalCL, horizontalCL, woodAxisOffset: null, key: columnSlotKey(verticalCL, horizontalCL),
          x: verticalCL.effectiveValue + axisOffsetOf(verticalCL), y: horizontalCL.effectiveValue + axisOffsetOf(horizontalCL),
        };
      }
      // 910グリッド位置は通常CLを持たないため、3b/3h-2と同じオフセットアンカー
      // （nearestAnchorCL＋woodAxisOffset）へフォールバックする（B-3以降3b/3h-2と共有する方式）。
      const anchor = nearestAnchorCL(graph, crossType, along);
      if (!anchor) return null; // 候補（通り芯／梁芯／意匠中心線）が1本も無ければ見送る
      const woodAxisOffset = { isVertical: !seg.isVertical, offset: along - anchor.effectiveValue };
      const verticalCL = seg.isVertical ? axisCL : anchor;
      const horizontalCL = seg.isVertical ? anchor : axisCL;
      const x = woodAxisOffset.isVertical ? verticalCL.effectiveValue + woodAxisOffset.offset : verticalCL.effectiveValue + axisOffsetOf(verticalCL);
      const y = !woodAxisOffset.isVertical ? horizontalCL.effectiveValue + woodAxisOffset.offset : horizontalCL.effectiveValue + axisOffsetOf(horizontalCL);
      return { verticalCL, horizontalCL, woodAxisOffset, key: `off:${Math.round(x)}:${Math.round(y)}`, x, y };
    }

    for (const seg of mergedAboveBeamSegments) {
      if (seg.role !== 'primary') continue; // 床梁等は対象外（ユーザー指示は「梁」＝大梁・頭つなぎ・受梁）
      const axisType = seg.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
      const crossType = seg.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;

      // supports = 梁の両端 ＋ この軸上(tol内)かつ梁の範囲の**内側**にあるslots候補・既存柱のAXIS along
      // （3dのalongCoordOnAxisと同じ「軸上判定」をここでも使う——3cが切る位置＝3dが数える位置の不変条件と
      // 同じ考え方）。範囲外（seg.lo/hi の外）の点は支持点に数えない——数えてしまうと、別の梁区間・前回
      // パスの3i柱（撤去はこの関数の最後に行うため、このループの時点ではまだ graph.columns に残っている）
      // が「範囲外なのに支持済み」と誤認され、本来必要な区間の柱が消えてしまう（実データ回帰で発覚）。
      const supports = new Set([seg.lo, seg.hi]);
      for (const p of iiAxisPoints) {
        const axisCoord = seg.isVertical ? p.x : p.y;
        if (Math.abs(axisCoord - seg.coord) >= CL_OVERLAP_TOL_MM) continue;
        const along = seg.isVertical ? p.y : p.x;
        if (along <= seg.lo + CL_OVERLAP_TOL_MM || along >= seg.hi - CL_OVERLAP_TOL_MM) continue;
        supports.add(along);
      }

      // 走行方向の候補CL＝supportSpanColumnCandidates（SUPPORT_SPAN_COLUMN_KINDS＝通り芯・意匠中心線。
      // 梁芯・補助線は除く）が返すkindをそのままsupportSpanColumnPositionsの優先度ラベルとして使う——
      // どのkindがどの順で優先されるか（並び）はwoodFraming.js側のSUPPORT_SPAN_PRIORITY_ORDERが唯一の
      // 出どころで、ここ（呼び出し側）は優先順を知らない・保持しない。
      // below（ユーザー裁定2026-09-19「最下階まで可能な限り同位置に柱を追加」）: 1つ下の実体階の柱の
      // うち、この壁線（seg自身の軸＝法線方向がseg.coordにtol内で一致）に乗っているものを候補に足す
      // ——下階に柱があるならそこへ揃えれば柱が上下に通り、3bで下階へ通すときに新しい柱が生まれない。
      // AXIS（axisX/axisY。偏心を含まない）で判定する（3b/3h-2と同じ理由）。
      const belowAlongs = (belowColumns ?? [])
        .filter(c => c.role !== 'foundation')
        .filter(c => Math.abs((seg.isVertical ? c.axisX : c.axisY) - seg.coord) < CL_OVERLAP_TOL_MM)
        .map(c => ({ along: seg.isVertical ? c.axisY : c.axisX, priority: 'below' }));
      const clAlongs = [
        ...supportSpanColumnCandidates(graph, { centerLineType: crossType })
          .map(({ cl, kind }) => ({ along: cl.effectiveValue, priority: kind })),
        ...belowAlongs,
      ];

      // R-1（2026-09-19是正）: 910グリッドへフォールバックする際の位相（原点）は、支持点lo自身
      // （袖柱等モジュール外の点になりうる）ではなく、その軸方向の通り芯（centerLineKind==='struct'）
      // のうち候補区間（そのペアのlo基準）に最も近いものにする——区間のlo以下で最大、無ければlo以上で
      // 最小。通り芯が1本も無い軸は従来どおりundefined（supportSpanColumnPositions側がペアlo自身へ
      // フォールバック）。**関数として渡す**（実データ回帰・2026-09-19是正）——mergePrimaryBeamRunsで
      // 束ねられた1本のrunに複数の支持長超過ペアが含まれる場合、遠く離れたrun全体の始端(seg.lo)を
      // 全ペア共通の原点にすると、途中のペアで別の位相（別の通り芯を基準にすべき910グリッド）を誤って
      // 採用してしまう（実測: moku4の屋根V x=7280で、run全体の始端-12614を原点にすると、本来
      // 隣接の通り芯Y3(-7280)基準であるべき区間が-12614基準の-5334を選び、1階・2階の既存柱(-5460)と
      // 126mmしか離れない）。supportSpanColumnPositionsがペアごとに`(lo,hi)`で呼ぶ。
      // 910グリッドの位相の基準は常に通り芯（'struct'固定。.claude/structural-model.md「910グリッドの
      // 基準は『通り芯』にする」節）——SUPPORT_SPAN_COLUMN_KINDSに種別を足しても、ここのフィルタは増やさない
      // （3iの候補優先順とは別の決まりのため）。
      const structAlongs = clAlongs.filter(e => e.priority === 'struct').map(e => e.along);
      const resolveGridOriginMm = (pairLo) => {
        const below = structAlongs.filter(v => v <= pairLo + CL_OVERLAP_TOL_MM);
        if (below.length > 0) return Math.max(...below);
        const above = structAlongs.filter(v => v >= pairLo - CL_OVERLAP_TOL_MM);
        return above.length > 0 ? Math.min(...above) : undefined;
      };

      const isAllowed = (along) => {
        const pt = seg.isVertical ? { x: seg.coord, y: along } : { x: along, y: seg.coord };
        // (a) 自階の壁（梁と平行＝同じisVertical）の下地帯内、かつthrough-run内。pointsOnWallLinesは
        // 向きを問わず幾何的に近い壁（直交する壁も）を返しうるため、ここでm.isVertical===seg.isVertical
        // で明示的に絞る——絞らないと、梁と直交する壁（例: 頭つなぎがまたぐ間仕切り壁）を「梁の真下の
        // 平行な壁」と誤認し、壁の無い位置にも柱を生成してしまう（実データ回帰で発覚。3b/3h-2は候補点
        // 自体が壁との交点のため向き不問で正しいが、3iは「梁の真下」という平行前提があるため区別する）。
        // タイブレークは3b/3h-2と同じ（runに入る線を優先→dist最小→coord昇順）。
        let best = null;
        for (const m of pointsOnWallLines([pt], segments, WALL_JUNCTION_TOL_MM)) {
          if (m.isVertical !== seg.isVertical) continue;
          const inRun = isInRun(m.isVertical, m.coord, m.along);
          if (!best || (inRun && !best.inRun) || (inRun === best.inRun && m.dist < best.dist)
            || (inRun === best.inRun && m.dist === best.dist && m.coord < best.coord)) {
            best = { ...m, inRun };
          }
        }
        if (!best || !best.inRun) return false;
        if (Number.isFinite(columnWidth)) {
          // (b) その壁上の建具の外形を柱寸/2+clearance広げた開区間には立てない（境界＝ちょうどは許容）。
          const half = columnWidth / 2 + TRADITIONAL_WOOD_BACKING.jambClearanceMm;
          for (const o of graph.openings) {
            if (o.isVertical !== seg.isVertical) continue;
            const hostWall = findHostBackingWall(o, graph);
            if (!hostWall || Math.abs(wallBackingCenterCoord(hostWall) - best.coord) >= CL_OVERLAP_TOL_MM) continue;
            const oLo = Math.min(o.coord1, o.coord2), oHi = Math.max(o.coord1, o.coord2);
            if (along > oLo - half + CL_OVERLAP_TOL_MM && along < oHi + half - CL_OVERLAP_TOL_MM) return false;
          }
        }
        // (c) 候補位置を実CLペア／オフセットアンカーへ解決できなければ見送る（新設しない）。
        // (d) 除外集合（ユーザーが消した位置）・wallGate（フットプリント外）も生成ループと同じ述語で
        // 事前チェックする（QA裁定）——ここで弾いておかないと、実際には生成されない位置に「支持長を
        // 満たした」と判定してしまい、立てられるはずの代替位置（別のCL・別のグリッド点）を探しに行かない。
        const cand = resolveIiCandidate(seg, axisType, crossType, along);
        if (!cand) return false;
        if (graph.excludedColumnSlots.has(cand.key)) return false;
        if (!passesGate(cand.verticalCL, cand.horizontalCL, null, cand.woodAxisOffset)) return false;
        if (Number.isFinite(columnWidth)) {
          // (e) 既存柱・候補柱（袖柱含む）と断面矩形が重ならない（AXIS基準。実際に解決した位置で判定する）。
          const rect = bareColumnRect({ sectionDefId: columnSection, rotation: 0, x: cand.x, y: cand.y });
          if (iiBlockingRects.some(r => rectsOverlap(rect, r))) return false;
          // (f) 安全弁（R-1・2026-09-19是正。裁定2026-09-19で3bと述語を共有するよう改定）: 同じ壁線上
          // （このseg軸上）の既存柱・候補柱との中心間距離が2×柱寸未満（かつ同位置ではない）なら不可
          // ——(e)の断面重なり判定だけでは、グリッド原点の解決が想定外に外れた場合に生じる数mm〜百mm
          // 程度の近接柱（実クリアランスがほぼ無い）を弾けない。同じ壁線上＝このseg（isVertical・coord）
          // に一致するiiAxisPoints（既存柱＋このステージで既に採用済みの候補。下記picks処理ループで
          // pushされる）に限定する——他の壁線上の柱まで巻き込まない。3b（上階柱直下）と同じ述語
          // hasNearbyColumnOnSameLineを共有する（二重実装しない）。
          if (hasNearbyColumnOnSameLine(iiAxisPoints, seg.isVertical, seg.coord, along)) return false;
        }
        return true;
      };

      const picks = supportSpanColumnPositions([...supports], clAlongs, isAllowed, {
        maxSpanMm: TRADITIONAL_WOOD_FRAMING.columnSupportMaxSpanMm,
        gridPitchMm: TRADITIONAL_WOOD_FRAMING.gridModuleMm,
        gridOriginMm: resolveGridOriginMm,
      });
      for (const { along, kind } of picks) {
        const cand = resolveIiCandidate(seg, axisType, crossType, along);
        if (!cand) continue; // isAllowedで確認済みだが、二重チェックとして安全側に残す（例外を投げない）
        slots.set(cand.key, { verticalCL: cand.verticalCL, horizontalCL: cand.horizontalCL, woodAxisOffset: cand.woodAxisOffset });
        iiPicks.push({ isVertical: seg.isVertical, coord: seg.coord, along, kind, x: cand.x, y: cand.y });
        if (Number.isFinite(columnWidth)) {
          iiBlockingRects.push(bareColumnRect({ sectionDefId: columnSection, rotation: 0, x: cand.x, y: cand.y }));
        }
        // (f)の安全弁が後続seg・後続ペアの判定でもこの候補を「既存点」として見るよう、iiAxisPoints自体に
        // 追記する（iiBlockingRectsと同じタイミング。iiAxisPointsはconstだが配列自体はmutable）。
        iiAxisPoints.push({ x: cand.x, y: cand.y });
      }
    }
  }

  const existing = new Set(graph.columns.map(c => columnAnchorKey(c)));
  const created = [];
  for (const [key, { verticalCL, horizontalCL, woodJambRef, woodAxisOffset }] of slots) {
    if (existing.has(key) || graph.excludedColumnSlots.has(key)) continue;
    // 袖柱は自階の下地オーナー壁の中に立つ＝フットプリント内が保証されるためwallGateを掛けない
    // （オフセットアンカー柱＝3h-2由来は3bと同じくwallGateを掛ける）。ゲート判定は実位置（AXIS）で
    // 行う——verticalCL/horizontalCLをそのまま渡すと、オフセット側は走行方向の実位置からずれた
    // プレースホルダCLの座標でフットプリントを判定してしまう（3h-2のcrossCLは最寄りのCLに過ぎず、
    // 実際の距離が離れうるため）。代替オブジェクトは`.value`（`wallGate.js intersectionInBuilding`が
    // 読むプロパティ名。他の呼び出し元が渡す実CLも`.value`を読まれる）に実位置を積む——
    // `.effectiveValue`を使うと、CLがドラッグ中（pendingDelta!=0）のとき法線方向は`.value`（確定値）・
    // 走行方向は`.effectiveValue`（ドラッグ中の暫定値）という異なる時点の座標を混在させてしまう
    // （QA指摘Minor・2026-09-18）。
    if (wallGate && !woodJambRef) {
      const gateVerticalCL = woodAxisOffset?.isVertical ? { value: verticalCL.value + woodAxisOffset.offset } : verticalCL;
      const gateHorizontalCL = woodAxisOffset && !woodAxisOffset.isVertical ? { value: horizontalCL.value + woodAxisOffset.offset } : horizontalCL;
      if (!wallGate.intersectionInBuilding(gateVerticalCL, gateHorizontalCL)) continue;
    }
    created.push(graph.addColumn(rules.baseMaterial, columnSection, verticalCL, horizontalCL,
      woodJambRef ? { woodJambRef } : woodAxisOffset ? { woodAxisOffset } : {}));
  }
  const removed = [];
  for (const column of [...graph.columnMap.values()]) {
    if (column.role === 'foundation' || column.dimensionStatus !== 'auto') continue;
    if (slots.has(columnAnchorKey(column))) continue;
    graph.columnMap.delete(column.id);
    removed.push(column.id);
  }
  // ユーザー承認済み一般則（案(a)・2026-09-25）: 撤去段の直後に「同じAXIS位置に複数の柱が残っていたら
  // 1本だけ残す」後始末を行う（dedupeColumnsByAxis）。上記の撤去ループはcolumnAnchorKeyの「存在」しか
  // 見ないため、複数の柱が偶然同じキー（例: off:x:y。実位置基準）を共有すると各柱が個別に
  // slots.has(key)===trueを満たして共倒れで両方生き残る「撤去段の穴」があった
  // （centerMoveStructuralSyncProbe.mjs M7で実測・qa-reviewer 2026-09-25特定）。
  removed.push(...dedupeColumnsByAxis(graph, slots));
  return { created, removed, jambSkipped, iiPicks };
}

// dedupeColumnsByAxis専用: 柱が「オフセットを介さない素直なCLペア」で立っているか——
// 柱自身のverticalCL/horizontalCL（axisX/axisYという実位置の値ではなく、柱が実際に参照している
// CLオブジェクト）が、それぞれの座標で「通り芯／梁芯→壁のある意匠中心線」の2段アンカー
// （resolveWoodColumnAnchorCL）としてそのまま解決できるかを見る。同じ重複グループ内の柱は
// 実位置(axisX/axisY)が全員同じ（グループ分けの定義そのもの）なので、実位置基準の判定はグループ内で
// 常に同着になり優先順として機能しない——柱自身が「どちらのアンカー方式で立っているか」という
// 由来の性質で判定する必要がある。woodAxisOffset非nullの柱はここでは常にfalse
// （オフセット柱は次の段（オフセット柱）で拾う——CLペア段と二重に該当させない）。
function hasCleanCLPairAnchor(graph, column) {
  if (column.woodAxisOffset != null) return false;
  return resolveWoodColumnAnchorCL(graph, CenterLineType.VERTICAL, column.verticalCL.effectiveValue) === column.verticalCL &&
    resolveWoodColumnAnchorCL(graph, CenterLineType.HORIZONTAL, column.horizontalCL.effectiveValue) === column.horizontalCL;
}

// 同じAXIS座標の候補グループ（2本以上）から生き残る1本を選ぶ（dedupeColumnsByAxis専用）。
// 優先順（ユーザー承認済み・2026-09-25）: (1) 今回の候補キー（slots）に入っている柱
// →(2) CLペアの柱（hasCleanCLPairAnchor）→(3) オフセット柱（woodAxisOffset非null）→(4) id昇順。
// 各段は「該当が1本以上あればその集合に絞り込み、無ければ前段の集合のまま次段へ進む」カスケード
// フィルタ——最終段（id昇順）は必ず1本に絞れる（idは重複しないため）決定的な終端。
// QA指摘n-5（2026-09-25）: 第1段（候補キー）は、dedupeColumnsByAxisが撤去ループの**後**に呼ばれる
// 現状の配置では、この時点で残っている全auto柱が既に撤去ループ自身の`slots.has(key)`チェックを
// 通過済み（でなければとっくに撤去されている）——つまり現状はグループの全メンバーが必ずtrueになり
// 絞り込みとして常に効かない（no-op）。それでも消さずに残す: dedupeColumnsByAxisを撤去ループの
// **中**（各柱の判定と同時）に統合するなど、将来撤去条件が変わったときの保険として意味を持ちうる段
// だからである（純関数として`slots`を引数に取る設計自体がこの再配置を想定している）。
function pickSurvivor(graph, slots, columns) {
  const narrow = (list, pred) => {
    const filtered = list.filter(pred);
    return filtered.length > 0 ? filtered : list;
  };
  let pool = columns;
  pool = narrow(pool, c => slots.has(columnAnchorKey(c)));
  pool = narrow(pool, c => hasCleanCLPairAnchor(graph, c));
  pool = narrow(pool, c => c.woodAxisOffset != null);
  return [...pool].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * 撤去段（autoFillWoodColumnsの撤去ループ）の直後に呼ぶ後始末: 同じAXIS座標（CL_OVERLAP_TOL_MM）に
 * 複数の柱が残っていたら1本だけ残す（ユーザー承認済み一般則・2026-09-25。案(a)）。
 * 対象は基礎（role:'foundation'）・袖柱（woodJambRef非null）を除いた全柱——基礎は独立した構造要素、
 * 袖柱は建具ごとに一意（openingId:side）のため対象外。
 *   - Q1裁定: グループに手動・locked・calculated（dimensionStatus!=='auto'）の柱が1本でもあれば、
 *     寸法の異同を問わずそのグループのauto柱を全撤去する（ユーザー確定値を優先。「AXISで一致・
 *     ACTUALで止める」規律と同じ——ACTUAL寸法が違っても同じAXIS位置なら重複とみなす。Q2裁定）。
 *   - auto柱だけのグループはpickSurvivorの優先順で1本を残し、残りを撤去する。
 * 決定的・冪等（同じ入力なら常に同じ1本が残る——2回目のパスは変化なし。id昇順の最終段が
 * 一意に定まるため）。既存の撤去（`graph.columnMap.delete`）と同じ手段を使う——`removeColumn`
 * （`PlanGraph`の公開メソッド）は`excludedColumnSlots`へ記録するため使わない（このグループの
 * もう一方の柱は今後も同じ理由で正しく再生成されるべきスロットであり、除外集合に汚してはいけない）。
 * @param {object} graph
 * @param {Map<string, {verticalCL, horizontalCL, woodJambRef, woodAxisOffset}>} slots - 今回の候補キー集合
 * @returns {string[]} 撤去した柱id配列
 */
export function dedupeColumnsByAxis(graph, slots) {
  const candidates = graph.columns.filter(c => c.role !== 'foundation' && !c.woodJambRef);
  const groups = [];
  for (const c of candidates) {
    let group = groups.find(g => Math.abs(g.axisX - c.axisX) < CL_OVERLAP_TOL_MM && Math.abs(g.axisY - c.axisY) < CL_OVERLAP_TOL_MM);
    if (!group) { group = { axisX: c.axisX, axisY: c.axisY, columns: [] }; groups.push(group); }
    group.columns.push(c);
  }

  const removed = [];
  for (const group of groups) {
    if (group.columns.length < 2) continue;
    const nonAuto = group.columns.filter(c => c.dimensionStatus !== 'auto');
    const autoCols = group.columns.filter(c => c.dimensionStatus === 'auto');
    if (nonAuto.length > 0) {
      for (const c of autoCols) { graph.columnMap.delete(c.id); removed.push(c.id); }
      continue;
    }
    if (autoCols.length < 2) continue;
    const survivor = pickSurvivor(graph, slots, autoCols);
    for (const c of autoCols) {
      if (c === survivor) continue;
      graph.columnMap.delete(c.id);
      removed.push(c.id);
    }
  }
  return removed;
}

// wallSegments（自階＋1つ下の階の壁区間）を「線」（isVertical, coord）ごとにまとめる。同一線判定は
// CL_OVERLAP_TOL_MM（mergeWallBeamSources・梁芯の重複ガードと同じ許容）。純関数、graph 非依存。
function groupWallLines(wallSegments) {
  const lines = [];
  for (const seg of wallSegments) {
    let line = lines.find(l => l.isVertical === seg.isVertical && Math.abs(l.coord - seg.coord) < CL_OVERLAP_TOL_MM);
    if (!line) { line = { isVertical: seg.isVertical, coord: seg.coord, intervals: [] }; lines.push(line); }
    line.intervals.push({ lo: seg.lo, hi: seg.hi });
  }
  return lines;
}

/**
 * wallSegments（自階＋1つ下の階の壁区間、マージ不要のプレーン配列）を線（isVertical, coord）ごとに
 * まとめ、各線の「通しで架けられる区間」（run。壁が途中で切れていない連続区間。柱の位置では切らない）
 * を求める（groupWallLines＋mergeWallIntervals＋wallIntersectionPoints＋throughBeamRunsの合成。
 * 壁線上の通し梁＝ステップ3c-2（autoFillWoodWallBeams）と上階柱直下の柱＝ステップ3b
 * （autoFillWoodColumns）が同じ「壁線の通し区間」を共有する——二重実装しない）。純関数、graph 非依存。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} wallSegments
 * @param {Array<{isVertical:boolean, coord:number, along:number}>} [freeEnds] - 自由端の点源
 *   （F-2・2026-09-19。wallRunFreeEnds由来。腰壁・垂れ壁の辺は呼び出し側が除外済みのこと）を
 *   runの端点候補へ加える——runは通常「交点の外側の自由端側の壁尻尾」を捨てるが、自由端にも
 *   柱・梁を伸ばす裁定により、自由端自身を新たな端点として扱う（それより外側の尻尾は無いため
 *   throughBeamRunsの結果は自由端がそのままrunの端になる）。省略時は従来どおり（交点のみ）。
 * @returns {Array<{isVertical:boolean, coord:number, runs: Array<{lo:number, hi:number}>}>}
 */
export function wallLineThroughRuns(wallSegments, freeEnds = []) {
  const points = wallIntersectionPoints(wallSegments);
  return groupWallLines(wallSegments).map(line => {
    const merged = mergeWallIntervals(line.intervals, WALL_JUNCTION_TOL_MM);
    const linePoints = [
      ...points
        .filter(p => Math.abs((line.isVertical ? p.x : p.y) - line.coord) < CL_OVERLAP_TOL_MM)
        .map(p => (line.isVertical ? p.y : p.x)),
      ...(freeEnds ?? [])
        .filter(fe => fe.isVertical === line.isVertical && Math.abs(fe.coord - line.coord) < CL_OVERLAP_TOL_MM)
        .map(fe => fe.along),
    ];
    return { isVertical: line.isVertical, coord: line.coord, runs: throughBeamRuns(linePoints, merged, WALL_JUNCTION_TOL_MM) };
  });
}

/**
 * 在来木造の壁線上の通し梁（role:'primary'、記号G。ステップ3c-2）・頭つなぎ／受梁（役柱の直上・直下、
 * ステップ3h）を自動生成し、候補に無い自動生成の梁（role:'primary'|'secondary', dimensionStatus==='auto'）を
 * 撤去する。通り芯グリッドの大梁・梁芯CL上の小梁（autoFillBeams/autoFillSecondaryBeams）の代わりに
 * こちらが生成する——呼び出し側（structural/structuralAutoFill.js autoFillBeamsForStructure）が
 * 主構造ルールの選択子（beamPlacement:'wallRuns'）で振り分ける。
 *
 * **屋根専用平面（isRoofPlane）から呼ばれたとき**（ステップ5・roofBeamPlacement:'wallRuns'）は、
 * 自階（＝1つ下の実体階＝最上階。wallSegments・selfGate・belowColumnsはいずれもステップ3・4で
 * 「屋根の1つ下＝最上階」を指すよう呼び出し側が配線済み）の壁線を対象に、フェーズAのbeamTypeだけ
 * '大梁'の代わりに'軒桁'にする（role自体はどちらも'primary'。symbol EG→G）。既存の通り芯グリッド
 * 方式の軒桁（role:'eaves', dimensionStatus==='auto'）は撤去対象に含める（手動固定は保全）。
 * フェーズBは無改造——ただし「受梁」（自階柱＝graph.columnsが点源）だけは、屋根自身が柱を持たない
 * ため点源が常に空になり自然に0本のまま。「頭つなぎ」（下階柱＝belowColumnsが点源）は屋根の
 * belowColumnsが最上階の柱に配線済み（ステップ3・4）のため、最上階に梁の通っていない柱があれば
 * 通常どおり生成される（M-1・2026-09-19是正: 旧コメントは頭つなぎも0件になると誤って書いていた）。
 *
 * 【フェーズA: 壁線上の通し梁（role:'primary'、beamType:'大梁'。ステップ3c-2）】
 *  - 候補＝壁線（wallSegments。自階＋1つ下の階、呼び出し側がマージせず渡す）を線（isVertical,coord）
 *    ごとにまとめ、各線の壁区間を mergeWallIntervals で連結、その線上の壁の交点（wallIntersectionPoints）
 *    をthroughBeamRuns へ通した「通しで架けられる区間」（run）。自由端には伸ばさない。
 *  - **各runはさらに下階柱（belowColumns、role:'foundation'除外）の位置で分割する**（ユーザー裁定
 *    2026-09-16「梁は下階柱（面）から下階柱（面）で区切られる材ごとに区別する」）。分割点の列挙は
 *    columnSplitPoints（woodFraming.js）に委ねる——渡すaxisCoordはaxisCL.effectiveValue（3dの
 *    alongCoordOnAxisと同じ座標基準）。
 *  - 各分割点・runの端は通り芯または壁由来の梁芯CL（無ければ壁のある意匠中心線。柱と同じ
 *    findBeamAnchorCL / findCenterAnchorCL）へ解決する。**run の両端**のいずれかが解決できなければ
 *    そのrunは丸ごと生成しない（従来どおり）。**内部の分割点**がアンカー解決できない場合は新しいCLを
 *    作らずそこで切ることを諦め、隣の区間と合流させる（`findBeamAnchorCL`は柱アンカーとも共有する
 *    述語のため、ここでCLを新設すると次回掃引で柱まで生えてしまう。かつ`excludedWallBeamAxes`を
 *    無視することにもなる）。
 *
 * 【フェーズB: 頭つなぎ・受梁（role:'primary'、beamType:'頭つなぎ'|'受梁'。ステップ3h）】
 *  - 下階柱（belowColumns、role:'foundation'除外。「頭つなぎ」の起因）と自階柱（graph.columns、
 *    role:'foundation'除外。「受梁」の起因）を点源に、columnSupportBeamCandidates（woodFraming.js）で
 *    「柱を中心に水平・垂直のうち隣の梁までの総長が短い方向」の候補区間を求める（ユーザー裁定）。
 *  - 支持・被覆集合（columnSupportBeamCandidatesのsegments引数）は**このパスで確定した壁線通し梁の
 *    候補区間（フェーズAの`candidateKeys.add`と同じタイミングでemitRunが積む`emitted`）＋手動固定
 *    （dimensionStatus!=='auto'）の同材種role:'primary'|'secondary'梁**だけ。自分の出力（頭つなぎ・
 *    受梁）や床梁（role:'floor'）は数えない——数えると生成した頭つなぎ自身が次の頭つなぎの支持に
 *    なってしまい、撤去⇄生成のチャーンや呼び出し順依存が生まれる（冪等性の核）。
 *  - 候補ごとに、候補の軸線（cand.coord）を通り芯／壁由来の梁芯CL（無ければ壁のある意匠中心線。柱・
 *    フェーズAと同じ2段resolveWoodColumnAnchorCL）へ解決できなければ見送る（CLは新設しない）。
 *  - 生成区間はcolumnSplitPoints（フェーズA・ステップ3c-2bと同一関数・同一tol）で下階柱位置により
 *    さらに分割する。内部分割点のアンカーが解けなければそこで切らず隣区間と合流（フェーズAと同じ規律）。
 *    区間の**両端**のCLは新設・座標からの引き直しをせず、**支持している隣の梁（candの loSeg/hiSeg）の
 *    axisCLオブジェクトそのもの**を使う（`findHostPrimaryBeam`はCLのid一致で hostを探すため、座標を
 *    合わせるだけでは不十分）。
 *  - 生成した区間は既存の「壁線上に無いauto梁は撤去」ループにそのまま乗る（別枠の撤去処理は持たない）。
 *
 * 【フェーズ共通】
 *  - **ゲートは自階フットプリント単独**（`wallGate.js`の`buildSelfFootprintGate`。QA裁定2026-09-18、
 *    Major 7・Blocker 1/2 是正）——引数`wallGate`（自階＋直下全階の鉛直連続性AND）はフェーズA・Bの
 *    どちらでも使わない（シグネチャ互換のためだけに残す）。壁線上の梁は自階の床を支える部材で、
 *    下階の連続性（ポーチ・吹抜け等）は柱・直交梁の支持で吸収されるため——旧実装（下階柱の両端支持で
 *    鉛直連続性ゲートを丸ごと免除する`exempt`）はQA実測で免除対象19区間中15区間が自階に部屋の
 *    無い位置（床も屋根も無い場所）に梁を通していたことが判明し撤回した。区間中点が自階の
 *    フットプリント内かどうかだけを見る（下階柱の有無は条件にしない）。自階に部屋が無ければ
 *    `buildSelfFootprintGate`が`null`を返し、その階は従来どおりゲートなし（全生成）で動く。
 *  - 除外集合（excludedBeamSlots）は区間ごとのキーに加え、run全長のキー（spanKey(axisCL,run両端のCL)）
 *    も見る——ユーザーが分割前の1本を丸ごと削除していれば、そのrunからは1本も生成しない（分割後の
 *    個々の区間キーへ除外情報を書き換える移行処理は持たない）。ユーザーが分割後の特定区間だけを
 *    削除した場合はその区間キー単体の除外で足りる。
 *  - 既存梁との重複は spanKey で確認する（柱・小梁と同じ規律）。加えて、**実際に分割されたrun**
 *    （下階柱で2区間以上に切れたrun）に限り、分割で生まれた区間キーが分割前の全長で手動固定
 *    （dimensionStatus!=='auto'）された梁のspanKeyとは一致しないため、幾何的な重なりで二重生成を防ぐ
 *    （lockedFullBeamOverlap。axisSpanOccupiedと同型・別関数）。分割されていないrun（下階柱が無い・
 *    分割点が全てアンカー解決不能で端2点のみ）はこのガードを適用せず、従来どおりspanKey占有だけで
 *    判定する（QA F2・2026-09-16。非分割runにまで幾何ガードを広げるとスコープが逸脱する）。
 *  - 壁が1本も無い階（wallSegments.length===0）・framing を持たない主構造は何もしない（生成も撤去もしない。
 *    autoFillWoodColumns と同じ「壁ゼロの階は既存部材を保全」裁定。フェーズBも壁ゼロならこのガードで
 *    一緒に止まる）。
 *  - 撤去は graph.beamMap.delete を直接使う（graph.removeBeam は使わない＝excludedBeamSlots を汚さない。
 *    deleteClassificationOverflow・resolveSecondaryBeamsForAxis と同じ規律）。子スリーブは連鎖削除する。
 *    対象は主構造材種の role:'primary'|'secondary' のうち dimensionStatus==='auto' のみ
 *    （locked/calculated は保持）。分割前の旧・全長梁（auto）はここで候補から外れて撤去される
 *    （移行専用の処理は持たない）。
 *  - **候補スロットに旧方式の小梁（role:'secondary'）が既に居座っている場合は、それを道を空けてから
 *    通し梁(role:'primary')へ置き換える**（`existing` 判定は role:'primary' の占有だけを「満たされた」と
 *    みなす——role を見ずに spanKey だけで判定すると、梁芯CL方式で生成された旧・小梁が同じ位置に残った
 *    まま「既存扱い」で新規生成をスキップし、かつ下段の撤去ループも候補キー一致で保持してしまうため、
 *    その位置がいつまでも role:'secondary' のまま role:'primary' に昇格しない事故になる（実データ
 *    moku1.stq の頭つなぎ・壁下梁で複数箇所再発）。占有物が手動固定（dimensionStatus!=='auto'）なら
 *    重複させず生成を見送る（他の`dimensionStatus`ガードと同じ規律）。
 *  - **占有物が既に role:'primary'（`existingPrimaryKeys`）でも beamType が今回の生成意図と食い違って
 *    いれば、撤去→再生成はせず in-place で beamType だけ揃える**（id・spanKey・寸法は不変。QA指摘：
 *    旧'大梁'が居座ったまま頭つなぎ・受梁のラベルへ昇格しない・その逆も同様の事故の是正）。この規則は
 *    フェーズA・フェーズB共通の`emitRun`に置くため両方に適用されるが、同一呼び出し内でフェーズBが
 *    フェーズAの占有スロット（`emitted`）と同じspanKeyを新たに候補にすることは無い——フェーズBの
 *    候補点はそもそも`emitted`上の点をno-op（既に両端支持の梁がある）として除外し、区間が`emitted`と
 *    同軸で重なれば候補外にする2つの防御（`columnSupportBeamCandidates`）があるため。逆方向
 *    （前回のフェーズBが生成した頭つなぎ・受梁の位置に、後の壁変更でフェーズAの壁線候補が新たに
 *    重なる）は起こり得るが、その場合は実際に壁ができた＝'大梁'へ揃えるのが正しい。手動固定
 *    （dimensionStatus!=='auto'）は触らない。2回目以降はbeamTypeが既に一致するためno-op（冪等）。
 * @param {object} graph
 * @param {object} project
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} wallSegments
 * @param {object|null} [wallGate] - **未使用（互換のため残置）**。QA裁定2026-09-18でゲートを自階
 *   フットプリント単独へ変更したため、呼び出し側（structuralAutoFill.js autoFillBeamsForStructure）
 *   とのシグネチャ互換のためだけに残す——ゲートは末尾の`selfGate`（第6引数）が担う。
 * @param {Array<{x:number, y:number, role?:string}>} [belowColumns] - 1つ下の実体階の柱集合
 *   （呼び出し側が peekBelowGraph(...).columns 等で渡す。3bのaboveColumns・3dのbelowColumnsと同じ
 *   「role:'foundation'除外は呼び出し側」の規律。省略・null・[]はいずれも「分割しない・頭つなぎ候補なし」＝従来どおり）
 * @param {object|null} [selfGate] - 自階フットプリント単独ゲート（wallGate.js buildSelfFootprintGate）。
 *   省略時（undefined）は従来どおり本関数が自前で`buildSelfFootprintGate(graph)`を計算する——
 *   実体階の呼び出し（graph自身が対象）はこれで従来と同値。**小屋伏図にも梁・柱ルールを適用する計画**
 *   （.claude/structural-model.md）で、呼び出し側（structuralAutoFill.js autoFillStructuralGrid経由）が
 *   屋根専用平面のときだけ`buildSelfFootprintGate(最上階graph)`を明示的に渡せるようにするための引数
 *   ——屋根専用平面は自階に部屋を持たないため`buildSelfFootprintGate(graph自身)`は常にnull（ゲートなし）
 *   になってしまう（ステップ3。呼び出し側の切替はステップ5以降）。**wallGate引数（4番目）とは別物**
 *   （そちらは上記のとおり互換のためだけの死んだ引数のまま——既存の「裁定1・2026-09-18」テストが
 *   固定するとおりwallGate引数自体の意味は変えない。新しい選択制御は必ずこの引数を使うこと）。
 * @param {object} [freeEndGraph] - 自由端（F-2・selfWallFreeEnds）の判定に使うgraph（省略時=graph自身。
 *   selfWallSegments・isKneeDropFreeEndの両方をこちらに差し替える）。**R-2（2026-09-19是正）**:
 *   屋根専用平面（isRoof）は自階に壁を持たないため`selfWallFreeEnds(graph, ...)`が常に空になり、
 *   最上階の壁線の自由端（唯一の被覆漏れ区間）に軒桁が届かない——呼び出し側（structuralRecompute.js）
 *   が屋根のときだけ「1つ下の実体階（＝最上階）」のgraphを渡すことで、最上階の壁のkneeDropWalls判定
 *   （腰壁・垂れ壁の辺は対象外）も含めて最上階基準に揃える。実体階は従来どおり省略（graph自身）。
 * @param {ReturnType<import('./wallBeamAxes.js').createWallSourceCache>} [wallSourceCache] - 1回の
 *   再計算内で壁区間（selfWallSegments）をmemoするキャッシュ（ステップC）。省略時は従来どおり
 *   自前で全走査する（freeEndGraphのselfWallFreeEnds算出にだけ使う——wallSegments自体は呼び出し側が
 *   渡す値をそのまま使う）。
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodWallBeams(graph, project, wallSegments, wallGate = null, belowColumns = [], selfGate = buildSelfFootprintGate(graph), freeEndGraph = graph, wallSourceCache = undefined) {
  void wallGate; // 未使用（互換のため残置。QA裁定2026-09-18）。ゲートは末尾のselfGateが担う——理由は上記JSDoc参照。
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing || !(wallSegments?.length)) return { created: [], removed: [] };
  // 小屋伏図にも梁・柱ルールを適用する計画（ステップ5）: 屋根専用平面から呼ばれたときはフェーズAの
  // beamTypeを'軒桁'にする（フェーズBは従来どおり'頭つなぎ'/'受梁'——roofは自階に柱を持たないため
  // columnSupportBeamCandidatesの点源（graph.columns）が常に空になり自然に0本のまま）。既存の
  // 通り芯グリッド方式の軒桁（role:'eaves', dimensionStatus==='auto'）は道を空ける撤去対象に含める
  // （役割は違えど同じ横架材の置き換えのため）。
  const isRoof = graph.plane?.isRoofPlane === true;
  // AXIS（axisX/axisY）で分割点を取る（3bと同じ理由。個別柱の偏心で分割位置がずれないため）。
  const belowPts = (belowColumns ?? []).filter(c => c.role !== 'foundation').map(c => ({ x: c.axisX, y: c.axisY }));
  // F-2（2026-09-19裁定）: 自由端（自階の下地オーナー壁runの端。腰壁・垂れ壁の辺は除く）を
  // フェーズAの通し梁run延長点源に加える（F-1と同じselfWallFreeEnds。柱と同じ点源を共有する）。
  // R-2（2026-09-19是正）: 屋根専用平面は自階（graph自身）に壁が無いため、呼び出し側が渡す
  // freeEndGraph（屋根なら「1つ下の実体階＝最上階」、実体階なら省略時にgraph自身）を判定基準にする。
  const freeEnds = selfWallFreeEnds(freeEndGraph, selfWallSegments(freeEndGraph, wallSourceCache));

  // spanKey -> その位置に既にある梁（同材種）。候補スロットの占有物判定（role:'primary'昇格）に使う。
  const byKey = new Map();
  for (const b of graph.beams) {
    if (b.materialType !== rules.baseMaterial) continue;
    const k = spanKey(b.axisCL, b.clStart, b.clEnd);
    const arr = byKey.get(k);
    if (arr) arr.push(b); else byKey.set(k, [b]);
  }
  const existingPrimaryKeys = new Set(
    [...byKey].filter(([, bs]) => bs.some(b => b.role === 'primary')).map(([k]) => k));
  const candidateKeys = new Set();
  // フェーズBの支持集合（このパスで確定した壁線通し梁の候補区間。フェーズB自身の出力・床梁は含めない）。
  const emitted = [];
  const created = [];
  const removed = [];

  // QA裁定2026-09-18（Major 7・Blocker 1/2）: ゲートは自階フットプリント単独（下階の鉛直連続性AND
  // ではない）。引数`wallGate`は使わない——シグネチャ互換のためだけに残す（JSDoc参照）。
  // 自階に部屋が無い階（階段吹抜けのみの階を含む）はbuildSelfFootprintGateがnullを返し、この階は
  // ゲートなし＝下階由来の壁線runが全生成される（QA第2巡・Major5裁定2026-09-18: 現状維持=案(a)。
  // 旧wallGateも同条件でnullだったpre-existingの挙動であり回帰ではない）。
  // selfGateは第6引数（省略時は本関数がbuildSelfFootprintGate(graph)を計算する。上記JSDoc参照）。

  // 1区間（axisCL上、cls[i]..cls[i+1]の連続ペア）ごとに、ゲート→除外集合→占有物の道空け→生成を行う
  // ローカル関数（フェーズA・フェーズB共通。role:'primary'固定、beamTypeだけ呼び分ける）。
  function emitRun(axisCL, isVertical, cls, beamType) {
    const fullKey = spanKey(axisCL, cls[0], cls[cls.length - 1]);
    if (graph.excludedBeamSlots.has(fullKey)) return; // run全長を丸ごと削除済みなら分割後も何も生成しない

    for (let i = 0; i < cls.length - 1; i++) {
      const startCL = cls[i], endCL = cls[i + 1];
      if (selfGate && !selfGate.spanInBuilding(axisCL, isVertical, startCL, endCL)) continue;

      const key = spanKey(axisCL, startCL, endCL);
      // 除外スロット（手動削除の尊重）は candidateKeys に加えない——生成しないだけでなく、下段の撤去
      // ループの対象（＝撤去してよい）にも含める。ここで加えてしまうと、除外スロットに居座る旧方式の
      // auto小梁が「候補あり」として撤去も生成もされず永久に残る事故になる（QA指摘・再発防止）。
      if (graph.excludedBeamSlots.has(key)) continue;
      candidateKeys.add(key);
      const lo = Math.min(startCL.effectiveValue, endCL.effectiveValue);
      const hi = Math.max(startCL.effectiveValue, endCL.effectiveValue);
      // loCL/hiCL: lo/hiそれぞれの端に対応する実CL（指摘Bの延長候補が、既存区間の近い端点そのものへ
      // 接続するために使う。startCL/endCLはcls配列上の順序でありlo/hiの大小とは限らないため区別する）。
      const loCL = startCL.effectiveValue <= endCL.effectiveValue ? startCL : endCL;
      const hiCL = startCL.effectiveValue <= endCL.effectiveValue ? endCL : startCL;
      // Minor（2026-09-18）: emitted は「ここまでのゲート・除外集合を通過した候補区間」であって
      // 実際に生成された梁の保証ではない（この後の占有物チェック——手動固定占有時は見送る分岐が
      // 続く）。フェーズBの支持集合としては候補区間のまま使ってよい——手動固定占有物自体は
      // lockedSegments側で別途支持集合に入るため、この区別による実害は無い。
      emitted.push({ isVertical, coord: axisCL.effectiveValue, lo, hi, axisCL, loCL, hiCL });
      if (existingPrimaryKeys.has(key)) {
        // 占有中のrole:'primary'梁（同一spanKey・寸法・端点は不変）のbeamTypeが今回の生成意図と
        // 食い違っていれば、撤去→再生成はせずラベルだけをin-placeで揃える（id・spanKey不変。3d
        // 受梁伝播・構造リストの参照を壊さない。QA指摘: 旧'大梁'が居座ったまま頭つなぎ・受梁に
        // 昇格しない事故の是正）。手動固定（dimensionStatus!=='auto'）は触らない。2回目は
        // beamTypeが既に一致するためno-op（冪等）。
        for (const b of byKey.get(key) ?? []) {
          if (b.role === 'primary' && b.dimensionStatus === 'auto' && b.beamType !== beamType) {
            b.setField('beamType', beamType);
          }
        }
        continue;
      }

      // 二重防御: 分割前の全長で手動固定された梁と幾何的に重なっていれば重複生成しない
      // （spanKeyが分割で変わるためexistingPrimaryKeysだけではすり抜ける）。**実際に分割されたrun
      // （cls.length>2＝区間が2つ以上）だけに限る**（QA F2・2026-09-16）——分割されていないrun
      // （cls.length===2＝端2点のみ）は従来どおりspanKey占有だけで判定する。分割していないのに
      // 幾何的な重なりガードを効かせると、run全長の一部区間だけ手動固定した既存梁（分割は起きていない）
      // で本来生成されるべき別区間の梁まで巻き込んで見送ってしまう（スコープの逸脱）。
      if (cls.length > 2) {
        if (lockedFullBeamOverlap(graph, rules.baseMaterial, isVertical, axisCL.effectiveValue, lo, hi, CL_OVERLAP_TOL_MM)) continue;
      }

      // 候補スロットの占有物（旧方式の小梁等）を道を空ける。手動固定が占有していれば重複させず見送る。
      const occupants = byKey.get(key) ?? [];
      if (occupants.some(b => b.dimensionStatus !== 'auto')) continue;
      for (const b of occupants) {
        for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === b.id) graph.sleeveMap.delete(s.id);
        graph.beamMap.delete(b.id);
        removed.push(b.id);
      }

      created.push(graph.addBeam(
        rules.baseMaterial, rules.defaultSections.beam, axisCL, isVertical, startCL, endCL,
        { role: 'primary', beamType },
      ));
      existingPrimaryKeys.add(key);
    }
  }

  // ---- フェーズA: 壁線上の通し梁（role:'primary', beamType:'大梁'） ----
  for (const line of wallLineThroughRuns(wallSegments, freeEnds)) {
    const axisType = line.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const axisCL = findBeamAnchorCL(graph, axisType, line.coord) ?? findCenterAnchorCL(graph, axisType, line.coord);
    if (!axisCL) continue; // アンカー解決不能な線は生成しない（例外を投げない）

    const crossType = line.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;

    for (const run of line.runs) {
      // run を下階柱の位置（3c-2b）＋自階フットプリント境界（A-1）で分割する。同じ述語・tolを3d
      // （alongCoordOnAxis）と共有するため axisCoordはaxisCL.effectiveValueを渡す。
      const breakPts = footprintBreakPoints(selfGate, graph, axisCL, line.isVertical, run);
      const pts = columnSplitPoints(run, axisCL.effectiveValue, line.isVertical, [...belowPts, ...breakPts]);
      if (pts.length === 0) continue; // run自体が不正（columnSplitPointsの失敗系）。安全側で見送る
      const resolvedEnds = pts.map(v => ({
        cl: findBeamAnchorCL(graph, crossType, v) ?? findCenterAnchorCL(graph, crossType, v),
      }));
      if (!resolvedEnds[0].cl || !resolvedEnds[resolvedEnds.length - 1].cl) continue; // runの端が解決不能なら生成しない
      // 内部の分割点（下階柱）がアンカー解決できなければそこで切らず隣の区間とつなぐ（新CLは作らない）。
      // run の両端は直前のcontinueでcl非nullが確定済みなので、ここは単純にcl有無だけで絞ってよい（QA F6）。
      const cls = resolvedEnds.filter(r => r.cl).map(r => r.cl);

      emitRun(axisCL, line.isVertical, cls, isRoof ? '軒桁' : '大梁');
    }
  }

  // ---- フェーズB: 頭つなぎ（下階柱起因）・受梁（自階柱起因）（ステップ3h） ----
  // 支持集合＝フェーズAで確定した壁線通し梁の候補区間（emitted）＋手動固定の同材種role:primary|secondary梁。
  // 自分の出力（頭つなぎ・受梁）・床梁（role:'floor'）は数えない（冪等性の核。JSDoc参照）。
  const lockedSegments = [];
  for (const beam of graph.beams) {
    if (beam.materialType !== rules.baseMaterial) continue;
    if (beam.role !== 'primary' && beam.role !== 'secondary') continue;
    if (beam.dimensionStatus === 'auto') continue;
    const beamLo = Math.min(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
    const beamHi = Math.max(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
    lockedSegments.push({
      // coordはaxisCL.effectiveValue基準（emittedと同じ基準）。beam.axisValueは偏心・柱芯オフセットを
      // 加えた実位置のため、在来木造で偏心が非0の梁があると emitted との overlaps 判定がずれる（m6）。
      isVertical: beam.isVertical, coord: beam.axisCL.effectiveValue,
      lo: beamLo, hi: beamHi,
      axisCL: beam.axisCL,
      // loCL/hiCL: emittedと同じ規約（指摘Bの延長候補が既存端点CLそのものへ接続するため）。
      loCL: beam.clStart.effectiveValue <= beam.clEnd.effectiveValue ? beam.clStart : beam.clEnd,
      hiCL: beam.clStart.effectiveValue <= beam.clEnd.effectiveValue ? beam.clEnd : beam.clStart,
    });
  }
  const belowTiePts = belowPts.map(pt => ({ ...pt, kind: 'below' }));
  const selfCarrierPts = graph.columns.filter(c => c.role !== 'foundation').map(c => ({ x: c.axisX, y: c.axisY, kind: 'self' }));
  const supportSegments = [...emitted, ...lockedSegments];
  // supportPoints（第3引数）=belowPts: 端点一致の候補が「下階柱で既に支持済み」かどうかの判定に使う
  // （指摘B。no-opにせず候補評価へ進めるかどうかの分岐）。
  for (const cand of columnSupportBeamCandidates([...belowTiePts, ...selfCarrierPts], supportSegments, belowPts)) {
    const axisType = cand.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const axisCL = resolveWoodColumnAnchorCL(graph, axisType, cand.coord);
    if (!axisCL) continue; // アンカー解決不能な候補は見送る（CLは新設しない）

    const crossType = cand.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const candRun = { lo: cand.lo, hi: cand.hi };
    const breakPts = footprintBreakPoints(selfGate, graph, axisCL, cand.isVertical, candRun);
    const splitVals = columnSplitPoints(candRun, axisCL.effectiveValue, cand.isVertical, [...belowPts, ...breakPts]);
    // 区間自体が不正（columnSplitPointsの失敗系）。安全側で見送る——cand.lo<cand.hiは
    // columnSupportBeamCandidatesの構築上常に成立するため現状は到達不能だが、columnSplitPointsの
    // 契約（run.hi<=run.loで[]を返す）が変わった場合の保険として残す。
    if (splitVals.length === 0) continue;
    // 内部分割点のみアンカー解決する（両端は支持している隣の梁のaxisCLそのものを使う。座標から引き直さない）。
    const interior = splitVals.slice(1, -1)
      .map(v => resolveWoodColumnAnchorCL(graph, crossType, v))
      .filter(Boolean);
    // 端点CL: 延長側（指摘B・extendsLoSeg/extendsHiSeg非null）は既存区間の隣接端CL（loCL/hiCL）
    // そのものへ接続し、それ以外（従来どおりの新設）はloSeg/hiSegのaxisCLを使う。
    const startCL = cand.extendsLoSeg ? cand.extendsLoSeg.hiCL : cand.loSeg.axisCL;
    const endCL = cand.extendsHiSeg ? cand.extendsHiSeg.loCL : cand.hiSeg.axisCL;
    const cls = [startCL, ...interior, endCL];

    emitRun(axisCL, cand.isVertical, cls, cand.kind === 'below' ? '頭つなぎ' : '受梁');
  }

  // ---- 撤去: 候補（フェーズA・Bとも）に無い自動生成分は撤去する ----
  // 屋根専用平面のときだけ、旧方式（通り芯グリッド）の軒桁（role:'eaves'）も撤去対象に加える
  // （既存のautoな軒桁を占有物として道を空ける。ステップ5・アーキ裁定2）。手動固定
  // （dimensionStatus!=='auto'）の軒桁は下のガードでそのまま保全される。
  const removableRoles = isRoof ? ['primary', 'secondary', 'eaves'] : ['primary', 'secondary'];
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.materialType !== rules.baseMaterial) continue;
    if (!removableRoles.includes(beam.role)) continue;
    if (beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }

  return { created, removed };
}

/**
 * 在来木造の土台（role:'sill'、記号SL。基礎伏図＝最下階専用。「土台：1階の1FL-100に天端を
 * 合わせた、柱同寸の横材」「1階の壁下ならびに、基礎上には、必ずある」）を、1階の壁線through-runと
 * 既存の基礎梁（role:'foundation'）のスパンの和集合へ自動生成し、候補に無い自動生成の土台を撤去する。
 *  - 断面は生成時点ではrules.defaultSections.beam（在来木造は柱同寸の正角がルール既定値そのもの）で
 *    作り、階の柱寸（graph.woodColumnWidthMm）への追従はconformWoodSections（同じrecomputeパスで
 *    本関数の直後に呼ばれる）のrole:'sill'専用分岐（幅・成とも常にwoodColumnSectionIdへそろえる。
 *    他の梁のように現在の成を保つと非正角になるため）に委ねる——standardBeamSectionFor
 *    （memberNumbering.js）と同じ`woodColumnSectionId(...) ?? ...defaultSections.beam`の式を
 *    ここで重複させない（memberCatalog.test.js 不変条件）。材種はrules.baseMaterial、levelOffsetは
 *    sillTopLevelOffsetMm(rules.framing)（=-100。天端FL-100）、beamTypeは'土台'固定。
 *  - 候補源(a) 壁線through-run（wallLineThroughRuns。呼び出し側が自階（1階）の壁だけを渡す想定——
 *    最下階には下階が無いため、autoFillWoodWallBeams（フェーズA）と異なり下階柱による分割は行わない
 *    ＝通し1本、柱では分割しない。自由端には伸ばさない）。各runの軸CL・両端CLは通り芯または壁由来の
 *    梁芯CL（無ければ壁のある意匠中心線。findBeamAnchorCL ?? findCenterAnchorCL＝柱・壁下梁と同じ
 *    2段）へ解決し、解決できないrunは見送る（例外を投げない）。ゲートは自階フットプリント単独
 *    （wallGate.js buildSelfFootprintGate。区間中点が自階フットプリント内。null＝ゲートなし。
 *    autoFillWoodWallBeamsと同じ規律）。
 *  - 候補源(b) 既存の基礎梁（role:'foundation'）のスパン（axisCL, isVertical, clStart, clEnd）
 *    ——基礎梁は壁の有無に依らず存在する第2の候補源（生成時に既にゲート済みのため再適用しない）。
 *    **通し（候補源a）を優先する**（2026-09-18裁定「1階の土台が同軸で重複」修正）：候補源(a)は壁線を
 *    通しで見るのに対し候補源(b)は基礎梁のスパン単位（通り芯ごと）に分かれているため、旧実装は
 *    spanKeyの単純一致dedupeでは同一位置の重複（例: 通し[0..3640]と分割済み[0..1820]+[1820..3640]の
 *    3本が併存）を防げなかった。**同軸（isVertical・coordがCL_OVERLAP_TOL_MM以内）の(a)のrunの
 *    和集合で覆われた(b)のスパンは差し引き、残り（tol超）だけを候補にする**（`woodFraming.js`の
 *    純関数`subtractCoveredSpan`）。(a)のrunは**ユーザーがその位置の土台をremoveBeamで消していても
 *    coveringに残す**（QA実測Major-1: 除外判定より前にcoveringへ積むよう修正済み——先に除外扱いに
 *    すると、その位置を候補源(b)が「(a)が無い」と誤認して埋め直し、除外→復活のチャーンと同軸重複が
 *    再発する）。**(b)どうしの重なりも差し引く**（基礎梁自体が同軸で重複して存在しうるため。生成源は
 *    本関数の対象外の別ステップで、本関数はそれをそのまま重複させずに写すだけ）——(b)は区間の長い順
 *    →lo昇順→id昇順の決定的な順で処理し、採用したピースをそのつどcoveringへ積んで後続の(b)の
 *    差し引きにも使う（長い＝通し寄りの基礎梁を優先）。同軸に(a)が無ければ(b)どうしの差し引きだけが
 *    働く。境界の端点CLは常にcovering側（(a)のrun、または先に採用した(b)のピース）の端点CLそのもの
 *    （座標から引き直さない）、覆われない側の元の端は(b)自身のclStart/clEndを使う。
 *  - (a)(b)はspanKeyでdedupeする（同一位置は1本。基礎梁の直上に壁があれば同じキーで自然に合流する）。
 *  - 除外集合（excludedBeamSlots）の判定キーは`beamExclusionKey('sill', axisCL, startCL, endCL)`
 *    （'sill:'名前空間）——bareのspanKeyで判定すると、同位置の基礎梁（role:'foundation'）を
 *    `removeBeam`したときに記録される除外（bareのspanKey）まで拾ってしまい、基礎梁を消しただけで
 *    土台まで再生成されなくなる事故になる（QA指摘Major-1・2026-09-18。実データで再現）。逆に
 *    `graph.addBeam`/`removeBeam`（`core/planGraph.js`）も同じ`beamExclusionKey`でキーを持つため、
 *    土台自身を削除／再追加したときの除外解除・記録は独立して機能する。除外に該当するスロットは
 *    候補にしない（生成しない・下段の撤去ループの対象に含める）。
 *  - 既存に同spanKeyのrole:'sill'があれば生成をskipする（冪等）。
 *  - 撤去はgraph.beamMap.deleteを直接使う（graph.removeBeamは使わない＝excludedBeamSlotsを汚さない。
 *    子スリーブは連鎖削除する）。対象は主構造材種のrole:'sill'のうちdimensionStatus==='auto'のみ
 *    （locked/calculatedは保持）。
 *  - **壁が1本も無い階（wallSegments.length===0）でも早期returnしない**——候補源(b)（基礎梁）は壁の
 *    有無に依らず存在するため（他のautoFillWoodXxxとは異なる。撤去対象はrole:'sill'のautoのみで、
 *    既存の他role部材には触れない）。
 *  - ネコ土台（TRADITIONAL_WOOD_FRAMING.sillPackingThicknessMm=20）の消費は基礎の断面図（後続ステップ）
 *    で行う——ここでは基礎梁のlevelOffsetを書かない（structureRules.js sillPackingThicknessMmのコメント
 *    参照）。
 *  - **非在来（framingを持たない主構造）は自動生成分（dimensionStatus==='auto'）のrole:'sill'を撤去する**
 *    （QA裁定Major-2・2026-09-18「構造変更でxは削除」と同じ規律。手動固定=lockedは保持。詳細は関数内
 *    コメント参照）。
 * @param {object} graph
 * @param {object} project
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} [wallSegments] - 自階（1階）
 *   の壁区間（最下階には下階が無いため下階分は含めない。selfWallSegments(graph)相当を呼び出し側が渡す）
 * @param {object|null} [wallGate] - **未使用（互換のため残置）**。autoFillWoodWallBeamsと同じくシグネチャ
 *   互換のためだけに受け取る——ゲートは末尾の`selfGate`（第5引数）が担う。
 * @param {object|null} [selfGate] - 自階フットプリント単独ゲート。省略時（undefined）は従来どおり
 *   本関数が自前で`buildSelfFootprintGate(graph)`を計算する（autoFillWoodWallBeamsと同じ規約。
 *   土台は基礎伏図（最下階）専用のため屋根専用平面から呼ばれることは無いが、シグネチャを揃えておく）。
 * @returns {{created: object[], removed: string[]}}
 */
// subtractCoveredSpan（woodFraming.js）が示すloCut/hiCut境界の実座標から、その境界を作った
// 候補源(a)のrun端点CLそのものを逆引きする（新たにCLを解決し直さない——同じ位置に別のCLオブジェクトを
// 持ち込むと採番・除外集合の参照が二重化するため）。mergeWallIntervals による結合後の境界も、
// 結合前の個々のrunの端点（lo側はどれかのrunのlo、hi側はどれかのrunのhi）のいずれかと一致するため、
// 未結合のrun配列をそのまま線形探索すればよい。見つからなければnull（呼び出し側が見送る）。
function findWallRunBoundaryCL(runs, coord, tol = CL_OVERLAP_TOL_MM) {
  for (const r of runs ?? []) {
    if (Math.abs(r.lo - coord) < tol) return r.loCL;
    if (Math.abs(r.hi - coord) < tol) return r.hiCL;
  }
  return null;
}

export function autoFillWoodSillBeams(graph, project, wallSegments = [], wallGate = null, selfGate = buildSelfFootprintGate(graph)) {
  void wallGate; // 未使用（互換のため残置）。ゲートは末尾のselfGateが担う——理由は上記JSDoc参照。
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) {
    // 非在来（framingを持たない主構造）へ切り替わったら、自動生成分の土台（role:'sill'）は撤去する
    // （QA裁定Major-2・2026-09-18「構造変更でxは削除」と同じ規律。手動固定=lockedは保持）。
    // role:'sill'はmemberKindOf('beamMap',...)がMEMBER_KIND.BEAM（'foundation'/'eaves'/'roof'以外の
    // 既定分岐）に落ちるため、deleteClassificationOverflow（表Aの一般ゲート）だけでは非在来でも
    // BEAM種別が○の構造（S造・RC造等）で撤去されず取り残される——ここで明示的に撤去する。
    // materialTypeは問わない（在来→非在来切替直後はまだWOODのまま残っているため、切替後の
    // rules.baseMaterialでは絞り込めない。convertMembersToEffectiveMaterialはrole:'sill'を変換対象外に
    // しているため、locked分はWOODのまま保持される）。
    const removed = [];
    for (const beam of [...graph.beamMap.values()]) {
      if (beam.role !== 'sill' || beam.dimensionStatus !== 'auto') continue;
      for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
      graph.beamMap.delete(beam.id);
      removed.push(beam.id);
    }
    return { created: [], removed };
  }

  // selfGateは第5引数（省略時は本関数がbuildSelfFootprintGate(graph)を計算する。上記JSDoc参照）。
  // F-2（2026-09-19裁定）: 自由端（腰壁・垂れ壁の辺を除く。F-1と同じselfWallFreeEnds）を候補源(a)の
  // run延長点源に加える——土台も柱・通し梁と同じ点源を共有する。
  const freeEnds = selfWallFreeEnds(graph, wallSegments ?? []);
  // spanKey -> 生成に使う実CL（axisCL, isVertical, startCL, endCL）。
  const candidates = new Map();
  // 候補源(b)の差し引きに使う、候補源(a)のrunを軸（isVertical, coord）ごとにまとめたもの
  // （{lo, hi, loCL, hiCL}。lo/hiはrunの両端の実CL effectiveValue、loCL/hiCLはその実CLそのもの）。
  const wallRunsByAxis = [];

  // wallRunsByAxis から軸グループを引くか無ければ作る（候補源(a)・(b)で共有するヘルパー）。
  function axisGroupFor(isVertical, coord) {
    let g = wallRunsByAxis.find(g => g.isVertical === isVertical && Math.abs(g.coord - coord) < CL_OVERLAP_TOL_MM);
    if (!g) { g = { isVertical, coord, runs: [] }; wallRunsByAxis.push(g); }
    return g;
  }

  // (a) 壁線through-run（自階のみ。呼び出し側が自階の壁だけを渡す。柱で分割しない。自由端まで伸ばす。F-2）。
  for (const line of wallLineThroughRuns(wallSegments ?? [], freeEnds)) {
    const axisType = line.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const axisCL = findBeamAnchorCL(graph, axisType, line.coord) ?? findCenterAnchorCL(graph, axisType, line.coord);
    if (!axisCL) continue; // アンカー解決不能な線は生成しない（例外を投げない）
    const crossType = line.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const axisGroup = axisGroupFor(line.isVertical, axisCL.effectiveValue);
    for (const run of line.runs) {
      const startCL = findBeamAnchorCL(graph, crossType, run.lo) ?? findCenterAnchorCL(graph, crossType, run.lo);
      const endCL = findBeamAnchorCL(graph, crossType, run.hi) ?? findCenterAnchorCL(graph, crossType, run.hi);
      // 端CLが解決不能、または自階フットプリント外——この区間には実在する壁のrunを認めない
      // （候補源(a)自体が成立しない）ため、coveringにも入れない＝候補源(b)がここを埋めてよい。
      if (!startCL || !endCL) continue; // runの端が解決不能なら生成しない
      if (selfGate && !selfGate.spanInBuilding(axisCL, line.isVertical, startCL, endCL)) continue;
      // ここまで来た区間は「実在する壁のrun」——除外判定（ユーザーがこの位置の土台だけを
      // removeBeamした）より前にcoveringへ積む（Major-1裁定・QA実測: 除外した通し土台の位置に
      // 候補源(b)由来の土台が湧いて同軸重複が復活していた）。壁自体は消えていないため、
      // 候補源(b)にこの区間を埋め直させない、という意図をcoveringで表す。
      axisGroup.runs.push({ lo: startCL.effectiveValue, hi: endCL.effectiveValue, loCL: startCL, hiCL: endCL });
      const key = spanKey(axisCL, startCL, endCL);
      // 除外判定はbeamExclusionKey('sill', ...)——bareのspanKeyだと同位置の基礎梁（role:'foundation'）の
      // removeBeamで記録された除外まで拾ってしまう（QA指摘Major-1・2026-09-18）。
      if (graph.excludedBeamSlots.has(beamExclusionKey('sill', axisCL, startCL, endCL))) continue; // 除外は候補に入れない（生成しない・撤去対象に含める）
      candidates.set(key, { axisCL, isVertical: line.isVertical, startCL, endCL });
    }
  }

  // (b) 既存の基礎梁（role:'foundation'）のスパン——通し（候補源a）を優先し、(a)のrunの和集合で
  // 覆われた部分は差し引いて残りだけを候補にする（2026-09-18裁定「1階の土台が同軸で重複」修正）。
  // 完全に覆われれば候補にしない（(a)の通し1本だけが残る）。部分的に覆われれば残り区間だけを候補にし、
  // (a)と接する側の端点CLは(a)のrunの端点CL（subtractCoveredSpanのloCut/hiCutが示す）を使う——
  // 座標から新たにCLを解決し直さない（同じ位置に別のCLオブジェクトを持ち込むと採番・除外集合の
  // 参照が二重化するため）。同軸に(a)が無ければ従来どおり全区間をそのまま候補にする。
  // **(b)どうしの重なりも差し引く**（Major-1裁定2）：基礎梁自体が同軸で複数（通し[0..3640]と
  // 分割済み[0..1820]+[1820..3640]等）存在しうる（構造モードの基礎梁生成は本関数の対象外の別ステップ
  // ——本関数はそれらを重複させずに土台へ写すだけ）。処理順は決定的に「区間の長い順→lo昇順→id昇順」
  // （通し寄りの基礎梁を優先）にし、採用したピースをそのつどaxisGroup.runsへ積んで後続の(b)の
  // coveringに含める——先に採用した長い区間が、後から見る短い区間を差し引く側になる。
  const foundationBeams = graph.beams
    .filter(b => b.role === 'foundation')
    .map(b => {
      const lo = Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
      const hi = Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
      return {
        b, lo, hi,
        loCL: b.clStart.effectiveValue <= b.clEnd.effectiveValue ? b.clStart : b.clEnd,
        hiCL: b.clStart.effectiveValue <= b.clEnd.effectiveValue ? b.clEnd : b.clStart,
      };
    })
    .sort((x, y) => (y.hi - y.lo) - (x.hi - x.lo) || x.lo - y.lo || (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0));
  for (const { b, lo: bLo, hi: bHi, loCL: bLoCL, hiCL: bHiCL } of foundationBeams) {
    const axisGroup = axisGroupFor(b.isVertical, b.axisCL.effectiveValue);
    const pieces = subtractCoveredSpan({ lo: bLo, hi: bHi }, axisGroup.runs, CL_OVERLAP_TOL_MM);
    for (const piece of pieces) {
      const startCL = piece.loCut ? findWallRunBoundaryCL(axisGroup.runs, piece.lo) : bLoCL;
      const endCL = piece.hiCut ? findWallRunBoundaryCL(axisGroup.runs, piece.hi) : bHiCL;
      if (!startCL || !endCL) continue; // 境界CLが見つからない（想定外）ときは安全側で見送る
      // 採用したピースは（除外の有無に関わらず）coveringへ積む——このピースの区間は候補源(b)の
      // 中で既に「解決済み」であり、後続の(b)（同軸の他の基礎梁）に重ねて生成させないため
      // （(a)の除外時と同じ扱い。Major-1）。
      axisGroup.runs.push({ lo: piece.lo, hi: piece.hi, loCL: startCL, hiCL: endCL });
      // ここも土台の除外キー（'sill:'名前空間）を見る——基礎梁自身の除外（bareのspanKey。基礎梁を
      // removeBeamしたときに記録される）とは独立（Major-1）。ピース単位のspanKeyで判定する。
      if (graph.excludedBeamSlots.has(beamExclusionKey('sill', b.axisCL, startCL, endCL))) continue;
      const key = spanKey(b.axisCL, startCL, endCL);
      if (!candidates.has(key)) candidates.set(key, { axisCL: b.axisCL, isVertical: b.isVertical, startCL, endCL });
    }
  }

  const section = rules.defaultSections.beam; // conformWoodSectionsが階の柱寸へ揃える（上記コメント参照）
  const levelOffset = sillTopLevelOffsetMm(rules.framing);
  const existingSillKeys = new Set(
    graph.beams
      .filter(b => b.materialType === rules.baseMaterial && b.role === 'sill')
      .map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));

  const created = [];
  for (const [key, { axisCL, isVertical, startCL, endCL }] of candidates) {
    if (existingSillKeys.has(key)) continue; // 冪等
    created.push(graph.addBeam(
      rules.baseMaterial, section, axisCL, isVertical, startCL, endCL,
      { role: 'sill', beamType: '土台', levelOffset },
    ));
    existingSillKeys.add(key);
  }

  const removed = [];
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.materialType !== rules.baseMaterial || beam.role !== 'sill') continue;
    if (beam.dimensionStatus !== 'auto') continue;
    if (candidates.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }

  return { created, removed };
}

// 床梁（role:'floor'、記号FB）の材軸方向。短辺・長辺が同寸（正方形）のときは材軸＝X（横梁、isVertical:false）
// にする（ユーザー裁定2026-09-15。方向自体は既定でユーザー未確認——反転したいときはこの1関数だけ直せばよい）。
function floorBeamIsVertical(w, h) {
  return h < w; // 短辺が垂直方向(h)のときだけ縦梁。同寸・hが長いときは横梁。
}

// 二重防御: 生成しようとしている床梁の軸（isVertical・coord）上に、既存の木造 primary/floor 梁が
// 生成スパン[lo,hi]と重なっていないか。beamGridCellsのセル判定は内部に梁が入り込む矩形を候補から
// 除外するが、findBeamAnchorCLで位置に既存の通り芯・梁芯CLを再利用した場合、その既存CLを軸に持つ
// 別の梁（例: 壁下梁・頭つなぎ）がspanKey（axisCL+clStart+clEnd）だけ見ると別物として重複生成の
// チェックをすり抜けうる——実データmoku1.stqで、壁下梁と同一軸で一部区間だけ重なる床梁、頭つなぎと
// ほぼ同位置・並行な床梁が実際に生成された（spanKeyは異なるが幾何的にほぼ二重梁）。ここで軸+範囲の
// 幾何的な重なりだけを見て最終防波堤とする（beamGridCellsのセル判定とは独立の二重チェック）。
// 【呼び出し側の規律】冪等性はこの関数ではなく呼び出し側（existingFloorKeysのcontinueがこの呼び出しより
// 先に評価される）が担保する——2回目呼び出しでは前回生成した床梁自身のspanKeyがexistingFloorKeysに
// 既にあるため、この関数へ到達する前にcontinueする。そのためこの関数は「自分自身」を除外する必要が無い
// （以前は除外用のexcludeKey引数を持っていたが、冪等性には寄与せずroleも見ないため同一spanKeyの
// primaryまで素通ししうる欠陥だった。QA指摘により削除——existingFloorKeysの先行continue一本化）。
function axisSpanOccupied(graph, materialType, isVertical, coord, lo, hi, tol) {
  return graph.beams.some(b =>
    b.materialType === materialType && (b.role === 'primary' || b.role === 'floor') &&
    b.isVertical === isVertical && Math.abs(b.axisValue - coord) < tol &&
    Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) < hi - tol &&
    Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) > lo + tol);
}

// 二重防御（ステップ3c-2b・下階柱分割）: 下階柱で分割した区間[lo,hi]が、同一軸・同材種の手動固定
// （dimensionStatus!=='auto'）のprimary/secondary梁と幾何的に重なっていないか。分割で生まれた
// 区間キー（spanKey）は分割前の全長で固定された梁のspanKeyとは一致しないため、spanKeyだけの一致判定
// （existingPrimaryKeys）ではすり抜けて重複生成してしまう——axisSpanOccupiedと同型の二重チェックだが、
// 対象role（'primary'|'secondary'）・対象dimensionStatus（手動固定のみ）が異なるため汎用化せず独立させる。
// 呼び出し側（autoFillWoodWallBeams）は実際に分割されたrun（cls.length>2）だけに絞って呼ぶ
// （QA F2・2026-09-16。非分割runの旧spanKeyオンリー判定はこのガードの対象外のまま）。
function lockedFullBeamOverlap(graph, materialType, isVertical, coord, lo, hi, tol) {
  return graph.beams.some(b =>
    b.materialType === materialType && (b.role === 'primary' || b.role === 'secondary') &&
    b.dimensionStatus !== 'auto' &&
    b.isVertical === isVertical && Math.abs(b.axisValue - coord) < tol &&
    Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) < hi - tol &&
    Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) > lo + tol);
}

/**
 * 在来木造の床梁（role:'floor'、記号FB、ステップ3e-2）を、梁で4辺囲まれたセル（framingCells.js
 * beamGridCells）のうち短辺が floorBeamMaxPitchMm(1820) を超えるものへ自動生成し、候補に無い
 * 自動生成の床梁を撤去する。
 *  - セル抽出は木造の大梁（role:'primary'）から作った線分（coord=axisValue、lo/hi=clStart/clEnd.effectiveValue
 *    の min/max）に beamGridCells を適用する（finish/gridCells.js は梁芯を含まないため端が host に届かず使わない）。
 *  - 必要判定: min(短辺,長辺) <= floorBeamMaxPitchMm なら床梁なし（両辺が1820超のときだけ生成）。
 *  - 方向: 短辺方向に架ける（材軸＝短辺と平行）。長辺方向に n=ceil(長辺/1820) 等分し、内部の n-1 本を
 *    等間隔で置く（floorBeamIsVertical。正方形は材軸＝X＝横梁）。
 *  - アンカー: 材軸の直交CL（clStart/clEnd）はセルの両辺を作っている大梁自身の axisCL（座標一致で
 *    大梁を逆引きする——beamGridCellsは線分の集合しか返さないため）。材軸CL（axisCL）は位置に既存の
 *    通り芯・梁芯があればそれを使う（findBeamAnchorCL）。無ければ梁芯CL（discipline:'fuse'、labeled:false）
 *    を自動生成する（excludedWallBeamAxesに記録された座標は生成しない）。extentは絶対座標
 *    （セルの短辺区間。extentLoRefは使わない——壁由来梁芯のような通り芯ブラケットへスナップする理由が
 *    無いため）。**位置に既存の非ラベルCLを再利用したとき、その既存extent（ref付きも解決済みの現在値を
 *    基準に含む）と床梁スパンの和集合を、wallBeamAxes.js bracketExtent（3cのautoFillWallBeamAxesと
 *    同一実装）へ通して直交通り芯へ再ブラケットする**（D1。ref→staticへ落とさず3cと同じ意味論に揃え、
 *    ブラケット先の通り芯が動けば追従する。ブラケットできない側だけ静的な和集合値にフォールバック。
 *    結果は常に和集合以上＝縮めない）。extentLo/extentHiのどちらかがnull（全幅扱い）のCLは触らない
 *    （縮めることになるため）——放置すると床梁の真下に梁芯が描かれずsnap.jsの沿線スナップも効かなく
 *    なる不具合になる（実データmoku1/moku2の2階 x=5460の床梁で確認。conflictしたCLはref付きだった
 *    ため、当初のref除外案では直らなかった）。
 *  - 撤去は graph.beamMap.delete を直接使う（graph.removeBeam は使わない＝excludedBeamSlots を汚さない。
 *    壁線通し梁・小梁と同じ規律）。対象は木造の role:'floor' のうち dimensionStatus==='auto' のみ
 *    （locked/calculated は保持）。CL は孤児になっても撤去しない（壁由来梁芯と同じ裁定）。
 *  - 除外集合（excludedBeamSlots）にあるスロットは候補扱いにしない（生成しない・撤去対象に含める）。
 *  - 二重防御（axisSpanOccupied）: 生成しようとしている軸上に既存の木造primary/floor梁が生成スパンと
 *    幾何的に重なっていれば生成しない（findBeamAnchorCLで既存CLを再利用した際のspanKeyすり抜けの
 *    最終防止。実データで発覚した壁下梁・頭つなぎとの二重梁を防ぐ）。
 *  - 非在来（framing を持たない主構造）は何もしない。
 * @param {object} graph
 * @param {object} project
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodFloorBeams(graph, project) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return { created: [], removed: [] };
  const maxPitch = TRADITIONAL_WOOD_FRAMING.floorBeamMaxPitchMm;

  const primaries = graph.beams.filter(b => b.materialType === rules.baseMaterial && b.role === 'primary');
  const lines = primaries.map(b => ({
    isVertical: b.isVertical,
    coord: b.axisValue,
    lo: Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue),
    hi: Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue),
  }));
  const cells = beamGridCells(lines);

  // セルの辺（isVertical, coord）を作っている大梁自身を座標で逆引きする（clStart/clEndのアンカーに使う。
  // beamGridCellsは線分の集合しか返さないため、生成元の梁オブジェクトへ戻す必要がある）。
  function findEdgeBeam(isVertical, coord) {
    return primaries.find(b => b.isVertical === isVertical && Math.abs(b.axisValue - coord) < CL_OVERLAP_TOL_MM) ?? null;
  }

  const candidateKeys = new Set();
  const created = [];
  const existingFloorKeys = new Set(
    graph.beams
      .filter(b => b.materialType === rules.baseMaterial && b.role === 'floor')
      .map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));

  for (const cell of cells) {
    const w = cell.x2 - cell.x1, h = cell.y2 - cell.y1;
    if (Math.min(w, h) <= maxPitch) continue; // 短辺が1820以下なら床梁不要

    const isVertical = floorBeamIsVertical(w, h);
    const longLen = isVertical ? w : h;
    const longLo  = isVertical ? cell.x1 : cell.y1;
    const shortLo = isVertical ? cell.y1 : cell.x1;
    const shortHi = isVertical ? cell.y2 : cell.x2;
    const n = Math.ceil(longLen / maxPitch);
    if (n < 2) continue; // 内部位置が無い（理論上min(w,h)>maxPitch判定と矛盾しないための安全弁）

    // 材軸の直交CL＝セルの短辺を作っている大梁自身のaxisCL（材軸と直交する向きの大梁）。
    const startEdge = findEdgeBeam(!isVertical, shortLo);
    const endEdge = findEdgeBeam(!isVertical, shortHi);
    if (!startEdge || !endEdge) continue; // 理論上beamGridCellsの被覆保証により必ず見つかるはずの安全弁
    const clStart = startEdge.axisCL, clEnd = endEdge.axisCL;

    const axisType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const pitch = longLen / n;
    for (let i = 1; i < n; i++) {
      const coord = longLo + i * pitch;
      let axisCL = findBeamAnchorCL(graph, axisType, coord);
      if (!axisCL) {
        const excludeKey = wallBeamAxisExcludeKey(isVertical, coord);
        if (graph.excludedWallBeamAxes.has(excludeKey)) continue; // 手動削除の尊重
        axisCL = graph.addCenterLine(axisType, coord, {
          labeled: false, discipline: Discipline.FUSE, extentLo: shortLo, extentHi: shortHi,
        });
      }

      const key = spanKey(axisCL, clStart, clEnd);
      if (graph.excludedBeamSlots.has(key)) continue; // 除外スロットは候補扱いにしない（生成しない・撤去対象に含める）
      candidateKeys.add(key);
      if (existingFloorKeys.has(key)) continue; // 既存（手動固定含む。自分自身の再生成も含む）と重複させない
      // 二重防御: 同一軸上に「このスロットとは別の」既存木造primary/floor梁が生成スパンと重なっていれば
      // 生成しない（findBeamAnchorCLで既存CLを再利用したときのspanKeyすり抜けを幾何的な重なりで最終防止）。
      if (axisSpanOccupied(graph, rules.baseMaterial, isVertical, coord, shortLo, shortHi, CL_OVERLAP_TOL_MM)) continue;

      // F1（D1: 再ブラケット方式）: 位置に既存の非ラベルCL（壁由来梁芯等。findBeamAnchorCLで再利用）を
      // 使う場合、その既存extentが床梁スパン[shortLo,shortHi]を覆っているとは限らない——放置すると、
      // CenterLinesLayerはextent±overhangしか描かないため床梁の真下に梁芯が描かれず、snap.jsの
      // 沿線スナップも効かなくなる（実データmoku1/moku2の2階で確認: 床梁 axis=5460 span=-3640..0 に
      // 対し既存extentは-9100..-7280＝完全に外）。
      // 現在の解決済みextent（ref・static問わず）と床梁スパンの和集合[min(現lo,shortLo),
      // max(現hi,shortHi)]を、wallBeamAxes.js bracketExtent（3cのautoFillWallBeamAxesと同一実装。
      // 直交通り芯へスナップ）へ通し、その結果でrefを張り替える——ref→staticへ落とすのではなく
      // 通り芯ブラケット方式（3c）と同じ意味論に揃えることで、ブラケット先の通り芯が動けばこの梁芯も
      // 追従する（static固定だと追従が失われる）。ブラケットできない側（外側に通り芯が無い）だけ
      // 静的な和集合値にフォールバックする（bracketExtentの戻り値がnullの側）。bracketExtentは
      // 「lo以下の最大値・hi以上の最小値」を返すため、結果は常に和集合以上＝現在値以上を覆う（縮めない）。
      // 【N2】extent未確定（extentLo==null または extentHi==null＝全幅扱いのCL）は触らない——
      // 触ると「全幅」から有限範囲へ縮めることになってしまう。
      // 冪等性: 2回目呼び出しはexistingFloorKeysで先にcontinueするためこのブロックへは到達しない。
      if (!spansEntireAxis(centerLineKind(axisCL)) && axisCL.extentLo != null && axisCL.extentHi != null) {
        const unionLo = Math.min(axisCL.extentLo, shortLo);
        const unionHi = Math.max(axisCL.extentHi, shortHi);
        const gridCLs = isVertical ? graph.gridYs : graph.gridXs; // 直交通り芯（value昇順。wallBeamAxes.jsと同じ規約）
        const { loCL, hiCL } = bracketExtent(gridCLs, unionLo, unionHi);
        graph.setCenterLineExtentRef(axisCL, 'lo', loCL ? { clId: loCL.id, offset: 0 } : null, loCL ? null : unionLo);
        graph.setCenterLineExtentRef(axisCL, 'hi', hiCL ? { clId: hiCL.id, offset: 0 } : null, hiCL ? null : unionHi);
      }

      created.push(graph.addBeam(
        rules.baseMaterial, rules.defaultSections.beam, axisCL, isVertical, clStart, clEnd,
        { role: 'floor', beamType: '床梁' },
      ));
      existingFloorKeys.add(key);
    }
  }

  const removed = [];
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.materialType !== rules.baseMaterial || beam.role !== 'floor') continue;
    if (beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }

  return { created, removed };
}

/**
 * 在来木造の既存部材の断面を主構造ルールへそろえる（ユーザー裁定2026-09-14「全部置き換え（手動固定も含む）」）。
 *  - 柱（杭を除く木造）＝ woodColumnSectionId（階の柱寸の正角。「各階柱寸法」欄＝ステップ4 C-2。
 *    未設定はルール既定の120角）。
 *  - 梁（基礎梁を除く木造）＝ 材幅を「梁を支える1つ下の実体階の柱寸」（resolvedBeamColumnWidthMm。
 *    実機裁定ステップ4 C-2 QA2「柱寸欄は柱カード、梁幅は柱寸転記——同一伏図内で整合させる」）にし、
 *    成は現在の断面の成を保つ（正角105→正角120、105×240→120×240）。graph.beamColumnWidthMm が
 *    未再計算（null）の間は自階の値へ暫定フォールバックする（resolvedBeamColumnWidthMm 自体の規約）。
 *    カタログに無い組み合わせ（断面が引けない・成が未収録）はそろえない（成を無言で縮めない）。
 *  - 土台（role:'sill'）は例外——「柱同寸の横材」は幅・成とも常に自階の柱寸（既に上で
 *    解決済みのcolumnSection）にそろえる（他の梁のように現在の成を保つと、階の柱寸が変わった際に
 *    幅だけ動いて非正角になり「柱同寸」の仕様に反するため）。
 *  dimensionStatus に関わらず書き換える（105角のまま残す選択肢は裁定で退けられた）——柱は解決した値
 *  （個別指定 ?? 階の値。structureRules.js columnWidthMm/columnSectionId）へそろう恒久ルール
 *  （柱寸を個別指定した柱はその値、それ以外は「各階柱寸法」欄＝ステップ4の値。ステップ3・2026-09-17裁定）。
 *  在来以外（framing を持たない主構造）は何もしない。更新した部材idを返す。
 * 呼び出し元（structuralRecompute.js・structuralOrchestration.js下階編集経路）が事前に
 * graph.setBeamColumnWidthMm(beamColumnWidthMm(graph, belowGraph, project)) を書いてから呼ぶこと
 * （QA指摘: belowGraphをここで直接引数に取ると同期経路ごとに belowGraph 解決が分かれる二系統に戻る）。
 * @param {object} graph
 * @param {object} project
 */
export function conformWoodSections(graph, project) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return [];
  const columnSection = woodColumnSectionId(graph, project);
  const columnWidth = findSectionEntry(columnSection)?.width;
  if (!columnWidth) return [];
  const beamWidth = resolvedBeamColumnWidthMm(graph, project) ?? columnWidth;
  const updated = [];
  for (const column of graph.columns) {
    if (column.materialType !== rules.baseMaterial || column.role === 'foundation') continue;
    const key = columnSectionId(column, graph, project);
    if (!key || column.sectionDefId === key) continue;
    column.setField('sectionDefId', key);
    updated.push(column.id);
  }
  for (const beam of graph.beams) {
    if (beam.materialType !== rules.baseMaterial || beam.role === 'foundation') continue;
    if (beam.role === 'sill') {
      if (beam.sectionDefId === columnSection) continue; // 常に柱同寸の正角（幅・成とも）
      beam.setField('sectionDefId', columnSection);
      updated.push(beam.id);
      continue;
    }
    const height = findSectionEntry(beam.sectionDefId)?.height;
    if (height == null) continue; // カタログ外の断面はそろえない
    const key = woodRectSectionKey(beamWidth, Math.max(height, beamWidth));
    if (key == null || beam.sectionDefId === key) continue;
    beam.setField('sectionDefId', key);
    updated.push(beam.id);
  }
  return updated;
}

/**
 * 在来木造の柱（共通柱・個別柱の両方）が壁の中で偏心する量（eccentricity{x,y}）を conform する
 * （ユーザー裁定2026-09-17・B-1／ステップ2で共通柱の帯シフト追従を追加）。真実は
 * column.woodOffsetSide（向きの指定）——eccentricity はここでだけ導出して書き込む派生値
 * （column.setField('eccentricity', ...) の唯一の書き手。他所から直接書かない）。
 *  - 共通柱（columnWidthMm(column,...)===floorWidthMm）は、外壁上に乗っていれば帯の寄せ分
 *    （selfWallSegments[].bandOffset。柱寸法が基準120より細い階の外壁下地帯シフト）だけ偏心する
 *    ——柱自身は「壁の中で自分だけ動く」向きの選択余地が無いため、常にゼロではない。内壁上の
 *    共通柱・柱寸120の階・非在来は従来どおり偏心ゼロ（bandOffsetが無い/0のため）。
 *  - 個別柱（columnWidthMm≠floorWidthMm）は上記に加え、帯の中で外面をそろえる第2項
 *    （woodColumnOffset.js woodColumnEccentricity参照）が乗る。
 *  - 非在来（framing を持たない主構造）・exterior未構築（呼び出し順序の不備）は何もしない。
 *  - 対象は在来木造の柱（役柱=杭を除く）のみ。目標値と現在値が一致すれば書かない（冪等。
 *    毎回書くと structuralRecompute.js の changed 判定が常に true になり undo が空でも積まれる）。
 *  - 梁幅・梁成・壁厚・壁の鮮度キーには一切波及しない（呼び出し元はこの結果を他の conform へ渡さない）。
 * @param {object} graph
 * @param {object} project
 * @param {{outsideSign: Function}|null} exterior - wallGate.js buildExteriorSide(graph) の結果
 * @param {ReturnType<import('./wallBeamAxes.js').createWallSourceCache>} [wallSourceCache] - 1回の
 *   再計算内で壁区間（selfWallSegments）をmemoするキャッシュ（ステップC）。省略時は従来どおり
 *   自前で全走査する。
 * @returns {string[]} 更新した柱id
 */
export function conformWoodColumnEccentricity(graph, project, exterior, wallSourceCache = undefined) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing || exterior == null) return [];
  const floorWidthMm = woodColumnWidthMm(graph, project);
  const segments = selfWallSegments(graph, wallSourceCache);
  const updated = [];
  for (const column of graph.columns) {
    if (column.materialType !== rules.baseMaterial || column.role === 'foundation') continue;
    const width = columnWidthMm(column, graph, project);
    const target = woodColumnEccentricity({
      axisX: column.axisX, axisY: column.axisY, floorWidthMm, columnWidthMm: width,
      side: column.woodOffsetSide ?? {}, segments,
      // QA指摘（B-1）: wallGate.js の outsideSign は名前に反し「内側」の符号を返す（JSDoc
      // どおり最小側+1＝内側方向。実測: moku1/moku2でx=0の柱は+1・x=9100は-1・y=0は-1＝常に
      // 建物内向き）。woodColumnEccentricity/s_faceは「外側方向」の符号を期待するため、ここで
      // 反転してから渡す——明示指定side（±1）の意味・式（s_face*(W-w)/2）自体は変えない。
      outsideSign: (axisValue, isVertical, atCross) => -exterior.outsideSign(axisValue, isVertical, atCross),
    });
    if (column.eccentricity.x === target.x && column.eccentricity.y === target.y) continue;
    column.setField('eccentricity', target);
    updated.push(column.id);
  }
  return updated;
}

// WOOD_DEPTH_BEAM_ROLES（在来木造の梁成自動更新の対象role）は structural/structureRules.js
// （WOOD_BEAM_DEPTH_TABLE の隣。個別採番 numbering.individualBeamRoles と同じ集合を共有する）へ移設済み。

// 座標(x,y)が梁の軸線上にあるか（横梁: |y-axisValue|<tol、縦梁: |x-axisValue|<tol）。
// あれば梁の軸方向の座標（横梁はx、縦梁はy＝支持点・荷重点として扱う値）を返し、無ければnull。
// 柱の「軸上」判定はここに集約する（支持点＝下階柱・荷重点＝自階柱の両方が使う）。
function alongCoordOnAxis(beam, x, y, tol) {
  const onAxis = beam.isVertical ? Math.abs(x - beam.axisValue) < tol : Math.abs(y - beam.axisValue) < tol;
  return onAxis ? (beam.isVertical ? y : x) : null;
}

/**
 * 在来木造の大梁・小梁の断面（sectionDefId）を、支持区間ごとの梁成表引きで自動更新する（ステップ3d）。
 * さらに後段で、受梁（区間内部に自階柱があり、その真下に下階柱が無い梁）の成を、それが取りつく
 * host 梁へ不動点まで伝播する（ステップ3c-3。裁定2026-09-14「受梁を受ける梁は受梁同寸」）。
 *  - 支持点＝梁の両端（clStart/clEnd.effectiveValue）＋1つ下の階の柱（role!=='foundation'）のうち
 *    梁の軸上（CL_OVERLAP_TOL_MM以内）かつ両端の内側にあるもの。スパンは芯々（coord1/coord2は描画用
 *    トリム値のため使わない）。
 *  - 荷重点＝区間内部の自階柱（role!=='foundation'、軸上）＋この梁に端を乗せる他の梁（取りつく先の判定は
 *    findHostPrimaryBeam。十字貫通＝同位置で両方向に相手梁が続く場合は荷重に数えない。crossingBeamLoadCoords）。
 *    ただし取りつく先が床梁（role:'floor'）の端は十字貫通判定を通さず常に荷重点として数える
 *    （大梁の両側から取りつく2本の床梁は別々の荷重点であり、通過しているだけの十字貫通ではないため）。
 *  - 対象・荷重源とも「WOOD_DEPTH_BEAM_ROLES かつ主構造の材種」の梁だけ（他の梁が荷重源になる条件も同じ集合）。
 *  - **受梁の判定**（3c-3）＝区間内部の自階柱の荷重点（columnLoads）のうち、その真下（CL_OVERLAP_TOL_MM
 *    以内）に下階柱（belowSupports）が無いもの。端に乗る柱は直交梁が受けるため対象外（区間内部のみ＝
 *    columnLoads の既存の定義そのまま）。受梁は新しいエンティティ・フラグとして**保存しない**——毎回
 *    この判定から導出するだけ。
 *  - 伝播は`woodFraming.js`の`propagateCarrierDepths`に委ねる（host のさらに先の host へも荷重経路上を
 *    辿って不動点まで反映。host判定・グラフ探査の二重実装はしない——host集合は上記hostMapと同じ
 *    findHostPrimaryBeam呼び出しから作る）。
 *  - **端が下階柱の位置ならhost登録しない**（ユーザー裁定2026-09-16「梁の端が下階柱なら受梁にしない」＝
 *    F1）。下階柱で分割した通し梁は、分割点で2本の半梁が同じ端点を共有し、その点に取りつく直交梁から見ると
 *    `findHostPrimaryBeam`のmin-tol/max+tol判定がどちらの半梁にも一致してしまう（実データで実測：収束後
 *    （sweep3）の1パスで、`targets`の各梁の各端についてこの述語を満たす候補が2件以上になる回数を直接
 *    数えるとmoku1で51件・moku2で57件——参考として3スイープ累計では152/170件相当。全件が候補の一方が
 *    下階柱位置と一致するケースで、`Array.find`の走査順（挿入順）で片方だけに成が伝播しうる状態だった）。
 *    下階柱がある位置は柱が受けるためどちらの半梁へも伝播させる必要が無く、`alongCoordOnAxis`と同じ
 *    述語・tolで「その端が下階柱と同一点か」を判定し、一致すればhost探索自体をスキップする（あいまい
 *    一致を起こす側で断つ——`findHostPrimaryBeam`は柱アンカーとも共有するため変更しない）。修正後は
 *    上記の51/57件とも下階柱位置のスキップに含まれ0件になる（走査順依存の挙動自体、挿入順に依らず
 *    再現しなくなったことを`woodAutoFill.test.js`のF1テストで固定：半梁の追加順を反転しても同じ成になる）。
 *  - dimensionStatus==='auto' の部材のみ更新する（locked/calculated は保持。conformWoodSections が
 *    dimensionStatus を問わず幅だけそろえるのとは意図的に非対称——柱寸法（幅）は階の値として恒久的に
 *    そろえる一方、成は支持・荷重の実況から決まる算定値のため、手動固定を上書きしない）。
 * 在来以外（framing を持たない主構造）・柱既定断面がカタログに無い場合は何もしない。更新した部材idを返す。
 * 成の算定に使う材幅（カタログの断面キー選定）は「梁を支える1つ下の実体階の柱寸」
 * （resolvedBeamColumnWidthMm。実機裁定ステップ4 C-2 QA2）——呼び出し元が事前に
 * graph.setBeamColumnWidthMm(...) を書いてから呼ぶこと（conformWoodSectionsと同じ規律）。
 * @param {object} graph
 * @param {object} project
 * @param {Array|null} [belowColumns] - 1つ下の実体階の柱集合（呼び出し側が peekBelowGraph(graph,project).columns
 *   等で渡す。省略・nullどちらも下階柱を支持点に含めない＝端点2点だけで評価する）
 * @returns {string[]}
 */
export function autoFillWoodBeamDepths(graph, project, belowColumns = []) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return [];
  const columnWidth = resolvedBeamColumnWidthMm(graph, project);
  if (!columnWidth) return [];
  const beams = graph.beams;
  const targets = beams.filter(b => b.materialType === rules.baseMaterial && WOOD_DEPTH_BEAM_ROLES.includes(b.role));
  // belowColumnsはundefined（既定[]）以外にnullが明示的に渡されうる（structuralRecompute.jsの
  // belowGraph?.columns ?? [] は belowGraph が null のときは[]になるが、呼び出し側の直接テスト・
  // 将来の呼び出し追加でnullが渡っても例外を投げないよう防御する）。
  const belowSupportColumns = (belowColumns ?? []).filter(c => c.role !== 'foundation');
  const selfLoadColumns = graph.columns.filter(c => c.role !== 'foundation');

  // 交差梁の端CLごとの host（取りつく先の大梁）マップ: hostBeamId -> [{coord, dir}]（crossingBeamLoadCoordsへ渡す）。
  // 床梁（role:'floor'）の端は十字貫通判定を通さず hostFloorMap へ直接積む——大梁の両側から取りつく
  // 床梁2本は互いに「反対方向から来た別の梁」であり十字貫通（通過しているだけ）ではなく実際の2つの
  // 荷重点なので、crossingBeamLoadCoords（+1/−1が揃うと除外）に通すと消えてしまう（ステップ3e-2の
  // 前提「両側の床梁が荷重として消えない」）。同位置の重複は woodBeamDepthForSpans の dedup が畳む。
  // 同時に、各梁の各端が取りつく先の host を beamId -> Set<hostBeamId> でも集める（受梁の伝播先。3c-3）。
  const hostMap = new Map();
  const hostFloorMap = new Map();
  const hostIdsByBeam = new Map();
  for (const x of targets) {
    for (const [endCL, otherCL] of [[x.clStart, x.clEnd], [x.clEnd, x.clStart]]) {
      // F1（2026-09-16）: この端が下階柱の位置と同一点なら、柱が受けるためhostを探さない（あいまい一致の回避）。
      // AXIS（axisX/axisY）で判定する——個別柱の偏心で支持点判定がずれないため。
      const atBelowColumn = belowSupportColumns.some((c) => {
        const along = alongCoordOnAxis(x, c.axisX, c.axisY, CL_OVERLAP_TOL_MM);
        return along != null && Math.abs(along - endCL.effectiveValue) < CL_OVERLAP_TOL_MM;
      });
      if (atBelowColumn) continue;
      const host = findHostPrimaryBeam(targets, endCL.id, !x.isVertical, x.axisValue);
      if (!host) continue;
      if (x.role === 'floor') {
        const arr = hostFloorMap.get(host.id) ?? [];
        arr.push(x.axisValue);
        hostFloorMap.set(host.id, arr);
      } else {
        const dir = Math.sign(otherCL.effectiveValue - endCL.effectiveValue) || 1;
        const arr = hostMap.get(host.id) ?? [];
        arr.push({ coord: x.axisValue, dir });
        hostMap.set(host.id, arr);
      }
      const hostIds = hostIdsByBeam.get(x.id) ?? new Set();
      hostIds.add(host.id);
      hostIdsByBeam.set(x.id, hostIds);
    }
  }

  // 第1パス: 対象梁それぞれの支持区間ごとの梁成表引き（受梁の伝播をまだ考慮しない、自分の値）と
  // 受梁判定（isCarrier）・伝播先（hostIds）をnodeとして集める。
  const nodes = [];
  for (const beam of targets) {
    const endA = beam.clStart.effectiveValue, endB = beam.clEnd.effectiveValue;
    const lo = Math.min(endA, endB), hi = Math.max(endA, endB);
    // AXIS（axisX/axisY）で支持点・荷重点を取る（3bと同じ理由。個別柱の偏心で支持区間の分け方が
    // ずれないため）。
    const belowSupports = belowSupportColumns
      .map(c => alongCoordOnAxis(beam, c.axisX, c.axisY, CL_OVERLAP_TOL_MM))
      .filter(v => v != null && v >= lo && v <= hi);
    const supports = [endA, endB, ...belowSupports];
    const columnLoads = selfLoadColumns
      .map(c => alongCoordOnAxis(beam, c.axisX, c.axisY, CL_OVERLAP_TOL_MM))
      .filter(v => v != null && v >= lo && v <= hi);
    const crossLoads = crossingBeamLoadCoords(hostMap.get(beam.id) ?? []);
    const floorLoads = hostFloorMap.get(beam.id) ?? [];
    const depth = woodBeamDepthForSpans(supports, [...columnLoads, ...crossLoads, ...floorLoads]);
    if (depth == null) continue;
    // 受梁＝区間内部の自階柱（columnLoads）のうち、真下（tol以内）に下階柱（belowSupports）が無いもの。
    const carried = columnLoads.filter(c => !belowSupports.some(s => Math.abs(s - c) < CL_OVERLAP_TOL_MM));
    nodes.push({ id: beam.id, depth, isCarrier: carried.length > 0, hostIds: [...(hostIdsByBeam.get(beam.id) ?? [])] });
  }

  // 第2パス: 受梁の成をhost梁へ不動点まで伝播した最終的な成で書き戻す。
  const finalDepths = propagateCarrierDepths(nodes);
  const updated = [];
  for (const beam of targets) {
    const depth = finalDepths.get(beam.id);
    if (depth == null) continue;
    const key = woodBeamSectionForDepth(depth, columnWidth);
    if (key == null || beam.dimensionStatus !== 'auto' || beam.sectionDefId === key) continue;
    beam.setField('sectionDefId', key);
    updated.push(beam.id);
  }
  return updated;
}

/**
 * 在来木造の共通仕様（per-floor）の壁下地材を「柱同寸×30」の間柱へ自動選択する
 * （仕様2026-09-14「壁厚が柱寸法と合っていない」→「在来木造は、共通仕様の壁下地材を柱同寸を自動選択」）。
 * 外壁下地（exteriorWallBacking。内外壁も同じ設定）・内壁下地（interiorWallBacking）の両方。
 * 柱寸法は woodColumnWidthMm（階の柱寸。未設定はルール既定の幅）、見込みは backing.studDepthMm(30)。
 * 表（backingClass.js WOOD_STUD_CODE_BY_SIZE）に無い柱寸は何もしない。在来以外は何もしない。
 * 呼び出し元は仕上げモード突入（finish/finishBoundary.js runFinishEntryBoundary）**だけ**——壁は仕上げ脱出時に
 * per-floor の下地材コードから壁厚を決めて全再生成される導出物なので、その直前に揃える。構造再計算
 * （structuralRecompute.js）からは呼ばない: 壁を再生成できない経路で下地材コードだけ変えると、共通仕様は
 * 120×30 でも壁は旧厚のままというズレになる（実機 2026模試 2階で確認。壁の再生成は仕上げ脱出でしか起きない）。
 * @returns {Array<{field:'exteriorWallBacking'|'interiorWallBacking', from:string, to:string}>} 変更した項目
 */
export function conformWoodBacking(graph, project) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing || !rules.backing) return [];
  const columnWidth = woodColumnWidthMm(graph, project);
  const code = columnWidth ? woodStudCodeFor(columnWidth, rules.backing.studDepthMm) : null;
  if (!code) return [];
  const changed = [];
  if (graph.exteriorWallBacking !== code) {
    changed.push({ field: 'exteriorWallBacking', from: graph.exteriorWallBacking, to: code });
    graph.setExteriorWallBacking(code);
  }
  if (graph.interiorWallBacking !== code) {
    changed.push({ field: 'interiorWallBacking', from: graph.interiorWallBacking, to: code });
    graph.setInteriorWallBacking(code);
  }
  return changed;
}
