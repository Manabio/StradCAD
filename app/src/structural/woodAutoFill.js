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
import { CenterLineType, Discipline, centerLineKind, columnSlotKey, spanKey, findHostPrimaryBeam } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { findSectionEntry, woodRectSectionKey } from './sectionCatalog.js';
import { rulesFor, effectiveStructure, TRADITIONAL_WOOD_FRAMING } from './structureRules.js';
import { selfWallSegments, findBeamAnchorCL, wallBeamAxisExcludeKey, bracketExtent } from './wallBeamAxes.js';
import { woodStudCodeFor } from '../finish/materials/backingClass.js';
import { beamGridCells } from './framingCells.js';
import {
  woodBeamDepthForSpans, woodBeamSectionForDepth, crossingBeamLoadCoords,
  mergeWallIntervals, throughBeamRuns, propagateCarrierDepths, pointsOnWallLines,
} from './woodFraming.js';

// 壁の端部の取り合い許容(mm)。壁の端は**取り合う壁の半厚（仕上げ込み）ぶん控えて生成される**
// （仕上げモードの壁生成。実機: x=0 の縦壁に突き当たる横壁は x=57.5 から始まる）ため、交点・T字・
// コーナーの判定では範囲をこの値だけ外へ広げる。壁厚の上限（RC壁200＋仕上げ）の半分を超える値にし、
// 材の半厚を個別に持ち回らない（壁の外周仕上げの有無で半厚が変わり、`materialRange` 由来の値では
// 控え量に届かない例が実機であった）。壁同士がこれ以上離れて終わる構成は「交わっていない」とみなす。
export const WALL_JUNCTION_TOL_MM = 150;

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
  return graph.centerLines.find(cl =>
    cl.centerLineType === centerLineType &&
    centerLineKind(cl) === 'center' &&
    Math.abs(cl.effectiveValue - coord) < CL_OVERLAP_TOL_MM) ?? null;
}

// 上階柱直下の柱（ステップ3b）のアンカー解決: 通り芯／梁芯（findBeamAnchorCL）→ 壁のある意匠中心線
// （findCenterAnchorCL）。3aの柱アンカー解決（wallIntersectionPointsのループ内の2段）と同じ2段で、
// CLは新設しない（どちらも無ければnull）。裁定（QA F2・2026-09-16）：3b限定の「±柱幅/2の寄せ」
// （3段目）は実データ3文書（moku1/moku2/2026模試）で使用0回・テスト0件・アンカー述語の3つ目の
// コピーだったため削除した——アンカーが無い候補はCLを新設せず素直に見送る。
function resolveWoodColumnAnchorCL(graph, centerLineType, coord) {
  return findBeamAnchorCL(graph, centerLineType, coord) ?? findCenterAnchorCL(graph, centerLineType, coord);
}

/**
 * 在来木造の柱を「自階の壁が交差する位置」（ステップ3a）と「1つ上の実体階の柱の直下」（ステップ3b）に
 * 自動生成し、候補に無い自動生成の柱を撤去する。
 *  - 3a候補＝自階の下地オーナー壁（selfWallSegments）の交点・T字・コーナー。各座標を通り芯／梁芯CL（無ければ
 *    壁のある意匠中心線）へ解決できた点だけが対象（解決できない方向がある点は生成しない。壁の梁芯CLは
 *    呼び出し側が先に生成する）。
 *  - 3b候補＝aboveColumns（1つ上の実体階の柱、role!=='foundation'）のうち、自階の壁の下地帯の内側
 *    （pointsOnWallLines）かつ、その壁線の3c（wallSegments。自階＋1つ下の階）と同一のthrough-run
 *    （wallLineThroughRuns）の内側にあるもの。壁が無ければ立てない（帯に一致する壁が無い＝候補から外れる。
 *    その位置の梁は受梁のまま）。アンカーは壁線自身の座標（法線方向）と上階柱の走行方向座標を
 *    resolveWoodColumnAnchorCL（通り芯／梁芯→意匠中心線。3aと同じ2段。CLは新設しない）で解決し、
 *    いずれか解決できなければその候補は見送る。3a・3bは同じslotsへ合流する（columnSlotKeyで自然に重複排除。撤去ループに
 *    別枠を持たせない＝3b由来の柱だけ別ロジックで消えることがない）。
 *  - 除外集合（excludedColumnSlots）・建物フットプリントのゲート（wallGate）は3a・3b共通（通り芯交点の
 *    柱と同じ規律）。
 *  - 壁が無い階は生成も撤去もしない（既存の柱を保全。裁定2026-09-14）。3bもこのガードの対象
 *    （segments.length===0で早期returnするため、壁が無ければ3b候補も一切評価しない）。
 *  - 撤去＝候補に無い位置の柱のうち dimensionStatus==='auto' かつ通常柱（杭を除く）。手動固定は保持し、
 *    除外集合には記録しない（deleteClassificationOverflow と同じ「可逆」の規律。通り芯交点で生成された
 *    旧来の柱を壁交点方式へ置き換えるための移行でもある）。
 * @param {object} graph
 * @param {object} project
 * @param {object|null} [wallGate]
 * @param {object[]} [aboveColumns] - 1つ上の実体階の柱集合（省略・null・[]はいずれも3b候補なし＝従来と同結果）
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} [wallSegments] - 3cと同じ
 *   壁区間（自階＋1つ下の階、マージ不要のプレーン配列）。3bのthrough-run判定に使う。
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodColumns(graph, project, wallGate = null, aboveColumns = [], wallSegments = []) {
  const rules = rulesFor(effectiveStructure(graph, project));
  const segments = selfWallSegments(graph);
  // 壁が1本も無い階（仕上げモード未着手で壁が未生成）は何もしない＝既存の柱を保全する
  // （ユーザー裁定2026-09-14。候補0で全撤去すると、非アクティブ階がモード境界で無通知に柱を失う）。
  // 壁が生成された時点で壁交点方式へ切り替わる。
  if (segments.length === 0) return { created: [], removed: [] };
  const slots = new Map();
  for (const p of wallIntersectionPoints(segments)) {
    // アンカーは通り芯または壁由来の梁芯CL（findBeamAnchorCL＝梁芯の重複ガードと同じ述語）。
    // 無ければ壁のある意匠中心線（findCenterAnchorCL）。
    const verticalCL = findBeamAnchorCL(graph, CenterLineType.VERTICAL, p.x) ?? findCenterAnchorCL(graph, CenterLineType.VERTICAL, p.x);
    const horizontalCL = findBeamAnchorCL(graph, CenterLineType.HORIZONTAL, p.y) ?? findCenterAnchorCL(graph, CenterLineType.HORIZONTAL, p.y);
    if (!verticalCL || !horizontalCL) continue;
    slots.set(columnSlotKey(verticalCL, horizontalCL), { verticalCL, horizontalCL });
  }

  // 3b: 上階柱直下の柱。role:'foundation'（杭）は候補にしない——上階の杭の直下に柱を立てる意味は無い。
  const lineRuns = wallLineThroughRuns(wallSegments);
  const isInRun = (isVertical, coord, along) => {
    const line = lineRuns.find(l => l.isVertical === isVertical && Math.abs(l.coord - coord) < CL_OVERLAP_TOL_MM);
    return !!line?.runs.some(r => along >= r.lo - CL_OVERLAP_TOL_MM && along <= r.hi + CL_OVERLAP_TOL_MM);
  };
  const points = (aboveColumns ?? [])
    .filter(c => c.role !== 'foundation')
    .map(c => ({ x: c.x, y: c.y }));
  // pointsOnWallLinesは1点が複数の壁線に一致する場合、すべての一致を並び順非依存で返す。ここで
  // 決定的タイブレークで1点につき1件へ絞る：runに入る線を優先→|perp-coord|(dist)最小→coord昇順
  // （QA F6・2026-09-16。旧実装はsegments/graph.wallsの走査順で最初に一致した線を採っており、
  // runに入らない線が先に見つかると本来立つはずの候補が消える不具合だった）。
  const bestByPoint = new Map();
  for (const m of pointsOnWallLines(points, segments, WALL_JUNCTION_TOL_MM)) {
    const key = `${m.x}:${m.y}`;
    const candidate = { ...m, inRun: isInRun(m.isVertical, m.coord, m.along) };
    const cur = bestByPoint.get(key);
    if (!cur
      || (candidate.inRun && !cur.inRun)
      || (candidate.inRun === cur.inRun && candidate.dist < cur.dist)
      || (candidate.inRun === cur.inRun && candidate.dist === cur.dist && candidate.coord < cur.coord)) {
      bestByPoint.set(key, candidate);
    }
  }
  for (const { isVertical, coord, along, inRun } of bestByPoint.values()) {
    if (!inRun) continue; // runの外（自由端側）、または壁の無い位置は立てない
    const axisType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const crossType = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const axisCL = resolveWoodColumnAnchorCL(graph, axisType, coord);
    const crossCL = resolveWoodColumnAnchorCL(graph, crossType, along);
    if (!axisCL || !crossCL) continue; // アンカー解決不能な候補は見送る（CLは新設しない）
    const verticalCL = isVertical ? axisCL : crossCL;
    const horizontalCL = isVertical ? crossCL : axisCL;
    slots.set(columnSlotKey(verticalCL, horizontalCL), { verticalCL, horizontalCL });
  }

  const existing = new Set(graph.columns.map(c => columnSlotKey(c.verticalCL, c.horizontalCL)));
  const created = [];
  for (const [key, { verticalCL, horizontalCL }] of slots) {
    if (existing.has(key) || graph.excludedColumnSlots.has(key)) continue;
    if (wallGate && !wallGate.intersectionInBuilding(verticalCL, horizontalCL)) continue;
    created.push(graph.addColumn(rules.baseMaterial, rules.defaultSections.column, verticalCL, horizontalCL, {}));
  }
  const removed = [];
  for (const column of [...graph.columnMap.values()]) {
    if (column.role === 'foundation' || column.dimensionStatus !== 'auto') continue;
    if (slots.has(columnSlotKey(column.verticalCL, column.horizontalCL))) continue;
    graph.columnMap.delete(column.id);
    removed.push(column.id);
  }
  return { created, removed };
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
 * @returns {Array<{isVertical:boolean, coord:number, runs: Array<{lo:number, hi:number}>}>}
 */
export function wallLineThroughRuns(wallSegments) {
  const points = wallIntersectionPoints(wallSegments);
  return groupWallLines(wallSegments).map(line => {
    const merged = mergeWallIntervals(line.intervals, WALL_JUNCTION_TOL_MM);
    const linePoints = points
      .filter(p => Math.abs((line.isVertical ? p.x : p.y) - line.coord) < CL_OVERLAP_TOL_MM)
      .map(p => (line.isVertical ? p.y : p.x));
    return { isVertical: line.isVertical, coord: line.coord, runs: throughBeamRuns(linePoints, merged, WALL_JUNCTION_TOL_MM) };
  });
}

/**
 * 在来木造の壁線上の通し梁（role:'primary'、記号G。ステップ3c-2）を自動生成し、候補に無い自動生成の
 * 梁（role:'primary'|'secondary', dimensionStatus==='auto'）を撤去する。通り芯グリッドの大梁・梁芯CL上の
 * 小梁（autoFillBeams/autoFillSecondaryBeams）の代わりにこちらが生成する——呼び出し側
 * （structural/structuralAutoFill.js autoFillBeamsForStructure）が主構造ルールの選択子
 * （beamPlacement:'wallRuns'）で振り分ける。
 *  - 候補＝壁線（wallSegments。自階＋1つ下の階、呼び出し側がマージせず渡す）を線（isVertical,coord）
 *    ごとにまとめ、各線の壁区間を mergeWallIntervals で連結、その線上の壁の交点（wallIntersectionPoints）
 *    をthroughBeamRuns へ通した「通しで架けられる区間」。柱の位置では切らない（3dの前提＝両端＋下階柱が
 *    支持点。支持点は端点候補であって分割規則ではない）。自由端には伸ばさない。
 *  - 各区間の端は通り芯または壁由来の梁芯CL（無ければ壁のある意匠中心線。柱と同じ findBeamAnchorCL /
 *    findCenterAnchorCL）へ解決する。軸線自身・端のいずれかが解決できない区間は生成しない（continue）。
 *  - wallGate.spanInBuilding で鉛直連続性をゲートする（host大梁がゲート済みなのと同じ規律）。
 *  - 除外集合（excludedBeamSlots）・既存梁との重複は spanKey で確認する（柱・小梁と同じ規律）。
 *  - 壁が1本も無い階（wallSegments.length===0）・framing を持たない主構造は何もしない（生成も撤去もしない。
 *    autoFillWoodColumns と同じ「壁ゼロの階は既存部材を保全」裁定）。
 *  - 撤去は graph.beamMap.delete を直接使う（graph.removeBeam は使わない＝excludedBeamSlots を汚さない。
 *    deleteClassificationOverflow・resolveSecondaryBeamsForAxis と同じ規律）。子スリーブは連鎖削除する。
 *    対象は主構造材種の role:'primary'|'secondary' のうち dimensionStatus==='auto' のみ
 *    （locked/calculated は保持）。
 *  - **候補スロットに旧方式の小梁（role:'secondary'）が既に居座っている場合は、それを道を空けてから
 *    通し梁(role:'primary')へ置き換える**（`existing` 判定は role:'primary' の占有だけを「満たされた」と
 *    みなす——role を見ずに spanKey だけで判定すると、梁芯CL方式で生成された旧・小梁が同じ位置に残った
 *    まま「既存扱い」で新規生成をスキップし、かつ下段の撤去ループも候補キー一致で保持してしまうため、
 *    その位置がいつまでも role:'secondary' のまま role:'primary' に昇格しない事故になる（実データ
 *    moku1.stq の頭つなぎ・壁下梁で複数箇所再発）。占有物が手動固定（dimensionStatus!=='auto'）なら
 *    重複させず生成を見送る（他の`dimensionStatus`ガードと同じ規律）。
 * @param {object} graph
 * @param {object} project
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} wallSegments
 * @param {object|null} [wallGate]
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodWallBeams(graph, project, wallSegments, wallGate = null) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing || !(wallSegments?.length)) return { created: [], removed: [] };

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
  const created = [];
  const removed = [];

  for (const line of wallLineThroughRuns(wallSegments)) {
    const axisType = line.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const axisCL = findBeamAnchorCL(graph, axisType, line.coord) ?? findCenterAnchorCL(graph, axisType, line.coord);
    if (!axisCL) continue; // アンカー解決不能な線は生成しない（例外を投げない）

    const crossType = line.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;

    for (const run of line.runs) {
      const startCL = findBeamAnchorCL(graph, crossType, run.lo) ?? findCenterAnchorCL(graph, crossType, run.lo);
      const endCL   = findBeamAnchorCL(graph, crossType, run.hi) ?? findCenterAnchorCL(graph, crossType, run.hi);
      if (!startCL || !endCL) continue; // アンカー解決不能な端は生成しない（例外を投げない）
      if (wallGate && !wallGate.spanInBuilding(axisCL, line.isVertical, startCL, endCL)) continue;

      const key = spanKey(axisCL, startCL, endCL);
      // 除外スロット（手動削除の尊重）は candidateKeys に加えない——生成しないだけでなく、下段の撤去
      // ループの対象（＝撤去してよい）にも含める。ここで加えてしまうと、除外スロットに居座る旧方式の
      // auto小梁が「候補あり」として撤去も生成もされず永久に残る事故になる（QA指摘・再発防止）。
      if (graph.excludedBeamSlots.has(key)) continue;
      candidateKeys.add(key);
      if (existingPrimaryKeys.has(key)) continue;

      // 候補スロットの占有物（旧方式の小梁等）を道を空ける。手動固定が占有していれば重複させず見送る。
      const occupants = byKey.get(key) ?? [];
      if (occupants.some(b => b.dimensionStatus !== 'auto')) continue;
      for (const b of occupants) {
        for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === b.id) graph.sleeveMap.delete(s.id);
        graph.beamMap.delete(b.id);
        removed.push(b.id);
      }

      created.push(graph.addBeam(
        rules.baseMaterial, rules.defaultSections.beam, axisCL, line.isVertical, startCL, endCL,
        { role: 'primary', beamType: '大梁' },
      ));
      existingPrimaryKeys.add(key);
    }
  }

  for (const beam of [...graph.beamMap.values()]) {
    if (beam.materialType !== rules.baseMaterial) continue;
    if (beam.role !== 'primary' && beam.role !== 'secondary') continue;
    if (beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
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
      if (axisCL.labeled === false && axisCL.extentLo != null && axisCL.extentHi != null) {
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
 *  - 柱（杭を除く木造）＝ framing.columnSection（120角）。
 *  - 梁（基礎梁を除く木造）＝ 材幅を柱同寸にし、成は現在の断面の成を保つ（正角105→正角120、105×240→120×240）。
 *    カタログに無い組み合わせ（断面が引けない・成が未収録）はそろえない（成を無言で縮めない）。
 *  dimensionStatus に関わらず書き換える（105角のまま残す選択肢は裁定で退けられた）——在来木造の柱寸は
 *  部材ごとの値ではなく階の値（「各階柱寸法」欄＝ステップ4）なので、再計算のたびに欄の値へそろう恒久ルール。
 *  在来以外（framing を持たない主構造）は何もしない。更新した部材idを返す。
 */
export function conformWoodSections(graph, project) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return [];
  const columnSection = rules.framing.columnSection;
  const columnWidth = findSectionEntry(columnSection)?.width;
  if (!columnWidth) return [];
  const updated = [];
  for (const column of graph.columns) {
    if (column.materialType !== rules.baseMaterial || column.role === 'foundation') continue;
    if (column.sectionDefId === columnSection) continue;
    column.setField('sectionDefId', columnSection);
    updated.push(column.id);
  }
  for (const beam of graph.beams) {
    if (beam.materialType !== rules.baseMaterial || beam.role === 'foundation') continue;
    const height = findSectionEntry(beam.sectionDefId)?.height;
    if (height == null) continue; // カタログ外の断面はそろえない
    const key = woodRectSectionKey(columnWidth, Math.max(height, columnWidth));
    if (key == null || beam.sectionDefId === key) continue;
    beam.setField('sectionDefId', key);
    updated.push(beam.id);
  }
  return updated;
}

// 在来木造の梁成自動更新（ステップ3d）の対象role。柱と同じく主構造の主要構造（framing）を持つ階の
// 木造部材だけが対象——対象梁（成を更新する側）と荷重源（他の梁の荷重点として数える側）の両方が
// この定数を読む（foundation/eaves/roof/landing は対象外。梁成表は主要構造の大梁・小梁・床梁の話であり、
// 基礎梁・軒桁・小屋梁・踊り場受け梁は別の算定・別の扱いを持つため）。'floor'（床梁、ステップ3e-2）を
// 加えたのは床梁自身も梁成表の対象であり、床梁の端も host（大梁）の荷重として数える必要があるため。
export const WOOD_DEPTH_BEAM_ROLES = Object.freeze(['primary', 'secondary', 'floor']);

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
 *  - dimensionStatus==='auto' の部材のみ更新する（locked/calculated は保持。conformWoodSections が
 *    dimensionStatus を問わず幅だけそろえるのとは意図的に非対称——柱寸法（幅）は階の値として恒久的に
 *    そろえる一方、成は支持・荷重の実況から決まる算定値のため、手動固定を上書きしない）。
 * 在来以外（framing を持たない主構造）・柱既定断面がカタログに無い場合は何もしない。更新した部材idを返す。
 * @param {object} graph
 * @param {object} project
 * @param {Array|null} [belowColumns] - 1つ下の実体階の柱集合（呼び出し側が peekBelowGraph(graph,project).columns
 *   等で渡す。省略・nullどちらも下階柱を支持点に含めない＝端点2点だけで評価する）
 * @returns {string[]}
 */
export function autoFillWoodBeamDepths(graph, project, belowColumns = []) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return [];
  const columnWidth = findSectionEntry(rules.framing.columnSection)?.width;
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
    const belowSupports = belowSupportColumns
      .map(c => alongCoordOnAxis(beam, c.x, c.y, CL_OVERLAP_TOL_MM))
      .filter(v => v != null && v >= lo && v <= hi);
    const supports = [endA, endB, ...belowSupports];
    const columnLoads = selfLoadColumns
      .map(c => alongCoordOnAxis(beam, c.x, c.y, CL_OVERLAP_TOL_MM))
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
 * 柱寸法は主構造ルールの柱既定断面の幅（framing.columnSection）、見込みは backing.studDepthMm(30)。
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
  const columnWidth = findSectionEntry(rules.framing.columnSection)?.width;
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
