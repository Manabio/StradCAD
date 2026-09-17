/**
 * 平面の壁描画に必要な「壁をまたぐ派生値」を1レンダー分まとめて解決する純モジュール。
 * ShapesLayer.jsx の描画前準備（下地の重複防止・高さが違う壁の取り合い・腰壁垂れ壁・
 * 柱の仕上げ包み・壁ごとの開口・壁ごとの描画線＝resolveWallLines）をレンダラから
 * 切り出したもの。
 *
 * 切り出した理由は2つ:
 *   1. **メモ化の継ぎ目**——これらは graph が変わらない限り同じ結果を返すのに、
 *      ポインタ移動・パン・ズームのたびの再レンダーで毎回やり直していた（カクつきの主因）。
 *      呼び出し側は renderer/graphDerived.js の graphComputed でこの関数ごと包む。
 *   2. **計測・検証可能にするため**——react-konva を静的 import する .jsx は node から
 *      実行できず、コストを単体で測れなかった。
 *
 * 純モジュール（node:test / node 直実行から単体 import 可能。store.js・*.jsx を静的に引かない）。
 *
 * ## 仕上げ材の線（面線・妻線・内側線・木口線）は「領域の境界」で解く
 * 2026-09に線トリム方式（旧 `wallJunctionResolve.js` の6パス＋旧 `finishLineSplits.js`）から
 * **材の領域を合成してその境界を描く**方式（`planWallRegion.js`）へ移行した。
 * 設計意図・移行の道筋は `.claude/plan-wall-region.md`。ここでは領域が解いた結果を
 * 壁ごとの `lines` として持ち回るだけで、取り合いの分類は一切持たない。
 *
 * ## ShapesLayer.jsx に残るロジック（構造的な残余）
 * `.jsx` 側に残るのは**写像であって判断ではない**もの（対象の型・座標をどのKonvaノードへ
 * 対応付けるかという描画特有の関心事）:
 *   - `lines` の各線分を `<Line points>` へ写す（軸の振り分けを含む）
 *   - 下地（間柱）のピッチ配置と柱カットによるセグメント調整
 *   - SCHEMATIC／腰壁・垂れ壁／標準・詳細の分岐（どのKonvaコンポーネントを使うか）
 *   - 腰壁・垂れ壁の天板輪郭の座標変換
 *   - 2a壁（階段下部屋）の描画クリップ（`stairUnderClips`）適用
 *   - `key`/`listening`/`fill` 等のKonva props・配列内の描画順
 */
import { ShapeType } from '@core';
import { LodLevel } from '../viewport.js';
import { resolveWallTJunctions } from './wallJunctionResolve.js';
import { isEndpointAt } from '../transform/centerLineExtend.js';
import { resolveKneeDropOverlays } from '../finish/kneeDropWall.js';
import { columnWallCuts, columnWrapSolids, bareColumnRect } from '../finish/columnWrap.js';
import { resolveWallStuds, columnIntervalsOnWall } from './wallStudLayout.js';
import { indexByAxis, findOpeningsOnWallIndexed } from '../openings/openingGeometry.js';
import { resolveWallRegionLines, wallSpanIntervals } from './planWallRegion.js';
import { graphComputed } from './graphDerived.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';

// 略図LOD で返す下地重複防止の空集合（読み取り専用として共有する）。
const EMPTY_SET = new Set();

/**
 * 下地（間柱）描画の重複防止: 同一axisCL上で範囲が重なる正負オフセットの壁ペア
 * （部屋境界の内外両側）は通り芯上の同じ構造材を指すため、正(+)側のみ描画する。
 * 偏芯壁（backingOffset指定あり）は下地帯が通り芯に対して対称でない＝相手側と共有する構造材
 * ではないため、この重複防止の対象外（自分の下地は常に描画・相手側の判定にも使わない）。
 * 新モデル（finish/wallGeneration.js の resolveBackingOwnership/applyBackingOwnership）で
 * 生成された壁は backingOffset を必ず明示（オーナーは0・非オーナーは薄壁でbackingDepth=0）
 * するため、この判定（backingOffset==null）の対象に自然に入らない——ここは旧データ
 * （backingOffset未設定の対称壁ペア）の表示互換のためのフォールバックとして残す。
 *
 * 柱寸法が基準より細い階の外壁下地帯シフト（bandShift。structural/structureRules.js
 * woodBaseColumnWidthMm 参照）は、backingOffset に「本来の偏芯」ではなく帯シフト量
 * （wall.bandOffset。core/wall.js Wall.bandOffset）だけを書く——外壁自身は setOwnerFields
 * の対象外のためbandShift>0の階でも backingOffset===null のまま残らない（=e）。この壁を
 * 単純に backingOffset!=null で除外すると、中庭（同一CLの正負両側がともに外壁）の重複防止が
 * bandShift>0の階だけ効かなくなる（QA F5）。backingOffset が bandOffset と厳密に同じ値
 * （＝帯シフト以外の偏芯を持たない）壁だけを対象に含める——bandOffset側に `?? 0` を当てては
 * ならない: 新モデルの所有権解決は非bandShift壁にも backingOffset=0 を明示するため
 * （bandOffset=null（未設定）と 0 を同じ扱いにすると、bandShiftを一切経由していない
 * ただのオーナー壁まで誤って対象に含めてしまう。実データ11.stqで壁・下地材の生成結果が
 * 変わる回帰を実測——bandOffsetは「未設定(null)」と「帯シフト0(0)」を区別したまま比較する）。
 *
 * この重複防止バケットの対象は「対称フォールバック式（backingDepth==null）の壁ペア」だけに
 * 限る（QA F7）——backingDepth!=null の壁（新モデルの所有権解決が明示した薄壁backingDepth=0・
 * オーナーbackingDepth=W）は対象外にする。外壁は setOwnerFields の対象外のため
 * backingDepth は常にnull（対称フォールバック式のまま）だが、bandShift>0の階では外周辺に接する
 * 「室生成壁」もbackingOffset===bandOffsetの条件を満たしてバケットに入りうる——その室生成壁は
 * 所有権解決で必ずbackingDepthを明示済み（covered=薄壁0・非covered=オーナーW）なので、
 * この壁を負側の外壁の「正側の相手」として誤認すると、実際には下地を持たない薄壁を
 * 正側と誤判定し、外壁側（負側）が deferred（下地描画スキップ）になってしまう——結果、
 * その帯の間柱を誰も描かなくなる（QA実測: moku2柱寸90で1階外壁14本中9本deferred、
 * stud218→153）。backingDepth!=nullの壁を最初から対象外にすれば、外壁（backingDepth常にnull）
 * どうしの中庭ペアだけが従来どおり重複防止の対象になる。
 *
 * 走査は axisCL 単位に束ねる（全壁の総当たりと結果は同一——判定条件が
 * `o.axisCL === w.axisCL` を含むため、別の軸CLの壁は元から一致しない）。
 * @param {object[]} generalShapes
 * @returns {Set<string>}
 */
export function resolveDeferredBackingIds(generalShapes) {
  const deferred = new Set();
  const byAxis = new Map(); // axisCL → 対象壁
  for (const s of generalShapes) {
    if (s.type !== ShapeType.WALL || s.wallFinish == null || s.backingDepth != null) continue;
    const hasOtherEccentricity = s.backingOffset != null && s.backingOffset !== s.bandOffset;
    if (hasOtherEccentricity) continue;
    const bucket = byAxis.get(s.axisCL);
    if (bucket) bucket.push(s);
    else byAxis.set(s.axisCL, [s]);
  }
  for (const bucket of byAxis.values()) {
    const positives = bucket.filter(o => o.axisOffset > 0);
    if (positives.length === 0) continue;
    for (const w of bucket) {
      if (w.axisOffset >= 0) continue;
      const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
      const hasPositiveOverlap = positives.some(o =>
        Math.min(o.coord1, o.coord2) < wHi && Math.max(o.coord1, o.coord2) > wLo);
      if (hasPositiveOverlap) deferred.add(w.id);
    }
  }
  return deferred;
}

/**
 * 壁1本分の描画ラインを解決する純関数。仕上げ材の線（面線・妻線・内側線・木口線）と天板の輪郭
 * （腰壁・垂れ壁）は `planWallRegion.js` が領域の境界として解いた結果（`regionLines`）をそのまま
 * 持ち回り、ここでは**領域に載らない要素**（略図の単線・下地スタッドの配置範囲）だけを組み立てる。
 *
 * @param {import('@core').Wall} wall
 * @param {{openings?:object[], junction?:object, regionLines?:object[],
 *   backingSpan?:[number,number]|null}} [deps]
 *   junction: wallJunctions.get(wall.id)（endExtend＝描画上の壁スパン／spanCutsで切り欠く区間）
 * @returns {{
 *   segments:[number,number][],
 *   lines:Array<{vertical:boolean, at:number, lo:number, hi:number, kind:string, ids:string[], style?:string}>,
 *   backingSpan:[number,number]|null,
 *   spanLo:number,
 *   spanHi:number,
 * }}
 *   segments: 開口・spanCuts で分割した描画上のスパン（略図の単線と下地スタッドの配置に使う）。
 *   lines: 描く線分（世界mm座標）。kind は仕上げ材の 'face'|'cap'|'fin'|'ecap'（描画は同一）と天板の
 *     'kd'|'kdcap'（`style` が 'knee'=実線／'drop'=破線）。ids は畳まれた1本に寄与したすべての壁のid。
 *   backingSpan: 下地スタッドを並べる長さ方向の範囲（突き合わせ延長・端部の回り込み反映済み）。
 */
export function resolveWallLines(wall, { openings = [], junction, regionLines = null, backingSpan = null } = {}) {
  // **描画上の壁スパン**: 低い壁（腰壁）とL字の端部で取り合う高い壁は、その端を相手の帯の
  // 遠位面まで伸ばして描く（wallJunctionResolve.js パス0のendExtend）。ここで1回だけ広げれば
  // 単線・下地の入力が同じ端点に従う——モデルの端点（wall.coord1/coord2）は変えない。
  const endExtend = junction?.endExtend ?? {};
  const lo = endExtend.lo ?? Math.min(wall.coord1, wall.coord2);
  const hi = endExtend.hi ?? Math.max(wall.coord1, wall.coord2);
  const segments = wallSpanIntervals(lo, hi, openings, junction?.spanCuts ?? []);
  return { segments, lines: regionLines ?? [], backingSpan, spanLo: lo, spanHi: hi };
}

/**
 * 平面で描く柱の仕上げ包み（柱壁）——壁に完全に埋まる柱・包み厚0の柱を除いたもの。
 * 壁の領域（buildWallDrawPlan）と柱壁の描画（renderer/StructuralLayer.jsx）が**同じ結果を共有**する
 * 入口。柱×壁の総当たりで graph が変わらない限り同じなので graph 単位にキャッシュする（graphDerived.js。
 * 略図LODでも同じ値なのでキーに LOD は要らない）。腰壁・垂れ壁（天板の輪郭で描かれる壁）と取り合う
 * 辺は柱壁が自分で描く——全高の柱壁が勝ち、そこへ天板が突き当たる（finish/columnWrap.js の `continued`）。
 * @param {object} graph
 * @returns {Array<{column:object, wrapped:object}>}
 */
export function planColumnWraps(graph) {
  // 主構造ルールで柱包みを持たない構造（在来木造）は包みなし＝空（structureRules.js drawing.columnFinishWrap）。
  if (!rulesFor(effectiveStructure(graph)).drawing.columnFinishWrap) return [];
  return graphComputed(graph, 'planColumnWraps', () => columnWrapSolids(graph,
    { capOutlineWallIds: new Set(resolveKneeDropOverlays(graph).keys()) })
    .filter(w => !w.hidden && Object.values(w.wrapped.covers).some(v => v > 0))
    .map(({ column, wrapped }) => ({ column, wrapped })));
}

/**
 * 1レンダー分の壁描画準備をまとめて解決する。
 * @param {object} graph
 * @param {string} lodLevel - viewport.lodLevel（LodLevel）
 * @param {{clipGroups?: Map<string, string>|null}} [opts]
 *   clipGroups: 壁id → 描画クリップの単位。2a壁（階段下部屋の偏芯壁）は壁id単位の Group clipFunc
 *   で描画が切られるため、領域の境界を畳むときに単位が違う壁の線を1本にしない
 *   （planWallRegion.js の wallInput）。graph だけでは決まらない情報なので呼び出し側
 *   （ShapesLayer.jsx）が渡し、graphComputed のキーにも符号化する。省略時は畳み方に制約なし。
 * @returns {{
 *   deferredBackingIds: Set<string>,
 *   wallJunctions: Map<string, object>|null,
 *   kneeDropOverlays: Map<string, object>|null,
 *   columnCuts: Map<string, object>|null,
 *   wallLines: Map<string, object>,
 *   wallStuds: Map<string, {centers:number[], depth:number}>,
 * }}
 *   wallStuds: 詳細LODの壁下地材（間柱断面）の長さ方向の中心位置と材厚（wallStudLayout.js）。詳細以外は空。
 */
export function buildWallDrawPlan(graph, lodLevel, { clipGroups = null } = {}) {
  const detail = lodLevel === LodLevel.DETAIL;
  const schematic = lodLevel === LodLevel.SCHEMATIC;
  const walls = graph.walls;

  // 壁ごとの開口（開口位置で壁線にギャップを入れるための区間分割）。従来は壁1本ごとに
  // graph.openings を総当たりしていた（O(壁 × 開口)）。coord1 昇順は区間分割が前提に
  // しているためここで確定させる。
  const openingIndex = indexByAxis(graph.openings);
  const openingsByWall = new Map();
  for (const wall of walls) {
    const found = findOpeningsOnWallIndexed(wall, openingIndex);
    if (found.length > 0) openingsByWall.set(wall.id, found.sort((a, b) => a.coord1 - b.coord1));
  }

  // 腰壁・垂れ壁の描画オーバーレイ。略図LOD（単線）では特別描画なし。
  // **壁の取り合い解決より先に**求める——平面での壁の高さ（腰壁か否か）はここが情報源で、
  // 高さが違う壁の組は取り合わない（高い方が優先。wallJunctionResolve.js のパス0）。
  const kneeDropOverlays = schematic ? null : resolveKneeDropOverlays(graph);

  // 壁をまたぐ端の解決（wallJunctionResolve.js）。領域が使うのはパス0（高さが違う壁の取り合い＝
  // 低い壁の帯を覆う `endExtend`・覆われる区間 `spanCuts`・端部の回り込み `endWrap`）だけで、パス6
  // （通り抜けた端の詰め）は `segments`（略図の単線・天板の輪郭・下地スタッド）にしか効かない
  // （planWallRegion.js の `regionSpan`）。**標準LODでも走らせる**——標準LODも領域方式で描く
  // （ユーザー確定2026-09）ので、パス0の `spanCuts` が無いと詳細では隠れる交差部の駒が閉じた矩形として
  // 残る（実機 2階 (0,-2000)）。略図LODは単線だけなので要らない。
  const wallJunctions = schematic ? null : resolveWallTJunctions(walls, kneeDropOverlays);
  // 柱の仕上げ包み（柱壁）。柱を描かないモード（仕上げ・敷地）でも壁の見た目は「柱に取られた区間」を
  // 反映してよい——柱は実在するため。柱壁は**全高の壁**なので、天板の輪郭で描かれる壁（腰壁・垂れ壁）と
  // 取り合う辺は壁側へ譲らない（`capOutlineWallIds`。finish/columnWrap.js の `continued`）。
  //  - `columnWraps` … 柱壁の外形（材）と内側境界（下地）の矩形。領域の**覆い判定にだけ**参加させ、境界は
  //    出さない（planWallRegion.js）——柱壁の線は renderer/StructuralLayer.jsx が `continued` で
  //    「壁の面線が引き継ぐ辺」を省いて描く。どちらが描くかは finish/columnWrap.js の `continued` 1箇所。
  //  - `columnCuts` … 下地スタッドを消す区間（`backing`。columnWallCuts の canRemoveBacking）にだけ使う。
  const capOutlineWallIds = kneeDropOverlays ? new Set(kneeDropOverlays.keys()) : undefined;
  // 柱包みを持たない構造（在来木造）は素の柱断面で壁を欠き取る（noCover。finish/columnWrap.js）。
  const noCover = !rulesFor(effectiveStructure(graph)).drawing.columnFinishWrap;
  const columnCuts = schematic ? null : columnWallCuts(graph, { capOutlineWallIds, noCover });
  const columnWraps = schematic ? null : planColumnWraps(graph)
    .map(({ column, wrapped }) => ({ id: column.id, outer: wrapped, finishes: wrapped.finishes ?? {} }));

  // 仕上げ材の線は**材の領域の境界**として1回で解く（planWallRegion.js）。標準LODは面線と妻線だけを
  // 描くが、それも同じ領域の境界なので同じ経路を通す（内側線・木口線は `detail` で抑止）。
  // 略図LODは単線（segments）だけなので領域は要らない。
  // 端点はねだし（軸CLの線分範囲を越えた端＝木口線を出す端）は下地の端の正規化にしか効かず、
  // 標準LODでは下地の辺を描かないので詳細LODでだけ解く（graph の総当たりを標準LODで払わない）。
  const endpointAtByWall = new Map();
  if (detail) {
    for (const wall of walls) {
      if (!wall.axisCL) continue;
      endpointAtByWall.set(wall.id, {
        lo: isEndpointAt(graph, wall.axisCL, 'lo'), hi: isEndpointAt(graph, wall.axisCL, 'hi'),
      });
    }
  }
  const region = schematic ? null : resolveWallRegionLines(walls, {
    junctions: wallJunctions, openingsByWall, kneeDropOverlays, endpointAtByWall,
    columnWraps, clipGroups, detail,
  });

  const wallLines = new Map();
  for (const wall of walls) {
    wallLines.set(wall.id, resolveWallLines(wall, {
      openings: openingsByWall.get(wall.id),
      junction: wallJunctions?.get(wall.id),
      regionLines: region?.lines.get(wall.id) ?? null,
      backingSpan: region?.backingSpans.get(wall.id) ?? null,
    }));
  }

  const deferredBackingIds = detail ? resolveDeferredBackingIds(graph.generalShapes) : EMPTY_SET;

  // 詳細のみ: 壁下地材（間柱断面）の位置（renderer/wallStudLayout.js）。主構造ルールの選択子 studLayout で
  // 固定ピッチ（従来）／柱間の面割付（在来木造。壁上の柱＝素の柱断面の区間で面に分ける）を選ぶ。
  // wallFinish は generateRoomWallsFromOutline/generateExteriorWalls 生成時のみ確定（手動壁は null）。
  // backingRange===null は「下地なし＝仕上げのみの薄壁」、deferred は同軸の相手に下地を委ねる対称壁。
  const wallStuds = new Map();
  if (detail) {
    const rules = rulesFor(effectiveStructure(graph));
    const columnRects = rules.studLayout === 'betweenColumns'
      ? graph.columns.filter(c => c.role !== 'foundation').map(c => bareColumnRect(c)) : [];
    for (const wall of walls) {
      if (wall.wallFinish == null || !wall.backingRange || deferredBackingIds.has(wall.id)) continue;
      const studs = resolveWallStuds(wallLines.get(wall.id), {
        layout: rules.studLayout, backing: rules.backing,
        columnIntervals: columnIntervalsOnWall(wall, columnRects),
        studCuts: columnCuts?.get(wall.id)?.backing ?? [],
      });
      if (studs) wallStuds.set(wall.id, studs);
    }
  }

  return {
    deferredBackingIds,
    wallJunctions,
    kneeDropOverlays,
    columnCuts,
    wallLines,
    wallStuds,
  };
}
