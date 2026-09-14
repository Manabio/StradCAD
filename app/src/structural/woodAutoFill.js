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
import { CenterLineType, centerLineKind, columnSlotKey } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { findSectionEntry, woodRectSectionKey } from './sectionCatalog.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { selfWallSegments, findBeamAnchorCL } from './wallBeamAxes.js';
import { woodStudCodeFor } from '../finish/materials/backingClass.js';

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

/**
 * 在来木造の柱を「自階の壁が交差する位置」に自動生成し、壁交点に無い自動生成の柱を撤去する。
 *  - 候補＝自階の下地オーナー壁（selfWallSegments）の交点・T字・コーナー。各座標を通り芯／梁芯CL（無ければ
 *    壁のある意匠中心線）へ解決できた点だけが対象（解決できない方向がある点は生成しない。壁の梁芯CLは
 *    呼び出し側が先に生成する）。
 *  - 除外集合（excludedColumnSlots）・建物フットプリントのゲート（wallGate）は通り芯交点の柱と同じ規律。
 *  - 壁が無い階は生成も撤去もしない（既存の柱を保全。裁定2026-09-14）。
 *  - 撤去＝候補に無い位置の柱のうち dimensionStatus==='auto' かつ通常柱（杭を除く）。手動固定は保持し、
 *    除外集合には記録しない（deleteClassificationOverflow と同じ「可逆」の規律。通り芯交点で生成された
 *    旧来の柱を壁交点方式へ置き換えるための移行でもある）。
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodColumns(graph, project, wallGate = null) {
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
