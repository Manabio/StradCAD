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
import { CenterLineType, centerLineKind, columnSlotKey, findHostPrimaryBeam } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { findSectionEntry, woodRectSectionKey } from './sectionCatalog.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { selfWallSegments, findBeamAnchorCL } from './wallBeamAxes.js';
import { woodStudCodeFor } from '../finish/materials/backingClass.js';
import { woodBeamDepthForSpans, woodBeamSectionForDepth, crossingBeamLoadCoords, propagateCarrierDepths } from './woodFraming.js';

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
