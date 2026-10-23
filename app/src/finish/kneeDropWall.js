/**
 * 腰壁・垂れ壁（交点から交点の1区間単位の指定）の解決・検証（仕上げモードで動的ロード）。
 *
 * PlanGraph.kneeDropWalls（key=edgeKey(axisCLId,startCLId,endCLId) → レコード）は「何を
 * 指定したか」だけを保持する。壁側（Wall.axisOffset 等の厚みジオメトリ）へは一切書き込まない
 * ——腰壁・垂れ壁は「天板」の追加描画（ShapesLayer.jsx）と、平面切断高さ以下の腰壁のみ
 * 通常の壁帯描画を天板輪郭に差し替える表示上の分岐であり、壁自体の材構成は変えない。
 *
 * 天端: 壁の仕上げ面と**同面**（幅＝12+壁の層厚+12＝壁厚そのもの）で、壁の上端から厚
 * CAP_THICKNESS ぶんの帯（仕様2026-08の断面図）。腰壁＝床から天端までの寸法（topHeight）。
 * 垂れ壁＝天井から下端までの寸法（bottomHeight。天端の対称扱い）。帯は壁の高さの**内側**に
 * あり、topHeight/bottomHeight を増やさない。
 */

import { edgeKey, CenterLineType, DEFAULT_ROOM_CEILING_HEIGHT, DEFAULT_PLAN_CUT_HEIGHT_MM, planCutHeightMmOf } from '@core';
import { worldToCell, dividerCLsBetween } from './gridCells.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { cellsBeyondBreak } from './stair/stairGeometry.js';
import { stairUnderRoomsOf } from './stair/stairUnderRooms.js';
import { stairPartitionLines, isStairPartitionWall, stairUnderReturnLines, isStairUnderReturnWall } from './stair/stairPartition.js';
import { roomCeilingHeight, roomCeilingTopMm } from './roomMetrics.js';

// 座標比較の許容（elevation/elevationStyle.js の GAP_EPS_MM と同値。finish/ が elevation/ へ
// 依存しないよう独立に持つ。finish/columnWrap.js と同じ形）。
const GAP_EPS = 1e-6;

export const CAP_THICKNESS   = 30;   // mm — 天端の帯の厚さ（仕様2026-08。壁上端から下へ）
// mm — 天端の**壁仕上げ面**からの出幅（仕様2026-08「天端幅 = 12 + 壁の層厚 + 12」の12。
// 壁の層厚＝仕上げ面から仕上げ面までの壁厚で、12はその外側への出。仕上げ材の厚みではない）。
// 出るのは**厚み方向だけ**——長さ方向は壁端で止まる（ユーザー確定2026-08）ため、平面の天端は
// 壁のスパンをそのまま使い capLo/capHi（厚み方向）にだけこの出幅を足す。
export const CAP_OVERHANG    = 12;
/**
 * 平面切断高さの**既定値**のみ（旧参照・テスト用のエイリアス）。階ごとの値は Plane.planCutHeightMm で、
 * 新規コードは必ず `planCutHeightMmOf(graph.plane)` で読むこと。
 */
export const PLAN_CUT_HEIGHT = DEFAULT_PLAN_CUT_HEIGHT_MM; // mm

// 天井高さが解決できない（区間の両側とも部屋がない）ときのエラーメッセージ。
// validateKneeDropWall と KneeDropWallDialog（フィールド未入力でも先出しする上部固定ブロック）の
// 双方で使う唯一の情報源。
export const ERR_CEILING_HEIGHT_UNRESOLVED = '天井高さを解決できません（両側とも部屋がありません）';

const MIN_HEIGHT  = 20; // mm — 腰H・垂れHの下限（天井高さ上限側のマージンも同値）
const BOTH_MARGIN = 20; // mm — 両方指定時の上限式 (腰H+垂れH <= 天井高さ - 2*BOTH_MARGIN) に使う

// 壁スパンと区間の重なりを「有意」とみなす下限(mm)。
// 隅の取り合いで壁端は**隣の区間へ半壁厚ぶん食い込む**——コーナーマップも closeConvexCorners
// （wallGeneration.js）も、角では相手壁の仕上げ面（軸CLから ±(wallBase/2+wallFinish)）まで
// 端点を伸ばすため。ここを微小値（5mm等）にすると「隣の区間の壁が57.5mmはみ出しただけ」を
// 区間の構成壁として拾ってしまい、その壁が**全長にわたって**腰壁天板の輪郭で描き替えられる
// （実機2026-08「21」2階 X2×Y2+3500: 隣室側の壁に天板線が増え、通常の壁帯が消えた）。
// 値は隅の取り合いの許容差（core/wallChamfer.js chamferWalls・renderer/wallJunctionResolve.js
// の CORNER_EXCLUSION・closeConvexCorners の CONTINUE_TOL）と揃えた 150mm。
export const SPAN_OVERLAP_EPS = 150; // mm（ceiling/ceilingOwners.js は「壁の無いすき間の上限」として共用）

// 押下位置から部屋側セルを解決する際のオフセット(mm)。edgeClassify.js の ADJACENT_SAMPLE_EPS と同水準。
const PRESS_SIDE_EPS = 10; // mm

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（edgeClassify.js と同型）。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * 軸CLの一致判定: **id ではなく世界座標（向き＋位置）で見る**。
 *
 * 同じ通りに別々のCLが2本ある図面が実在する（実機「21」2階の`5d54f984@-3500`と
 * `faaf4c30@-3500`。片方はY2からの相対、片方は絶対で作られたもの）。id一致で照合すると、
 * 面や壁が持つCLと腰壁レコードが持つCLが食い違って**指定が無いことになる**——出隅処理で
 * 同型の不具合を踏んでいる（`.claude/data-model.md`「出隅の取り合い」）。同じ向き・同じ位置の
 * CLは空間的に同じ通りなので、座標で照合する方が厳密に頑健で、階をまたぐ参照にもそのまま効く
 * （断面エンジンは他階のグラフを世界座標で読む）。
 */
const AXIS_MATCH_EPS = 0.5; // mm
// export: elevation/elevationFaces.js の wallCoverageGapsOnFace（面の軸と同じ通りの実壁を
// 拾う判定）も同じ規約を要る——通り一致は常にid比較ではなく座標で見る、という決定を1箇所に置く。
export function sameAxisLine(a, b) {
  return !!a && !!b && a.centerLineType === b.centerLineType
    && Math.abs(a.effectiveValue - b.effectiveValue) <= AXIS_MATCH_EPS;
}

/**
 * 軸CL（と同じ通り）・区間[spanLo,spanHi]に重なる graph.kneeDropWalls のレコードを列挙する。
 * key=edgeKey(axisCLId,startCLId,endCLId) の解読（key.split(':')→CL解決→lo/hi→スパン重なり判定）
 * はこの関数のみで行う——キー形式を所有するこのファイルへ集約し、次の3つが消費者として使う:
 *   - 本ファイルの kneeDropZRangesAt（断面エンジンが sectionHits.js 経由で引く）… 腰壁・垂れ壁の**実体**
 *     （壁のz存在範囲）。展開図に現れる腰壁の断面・天端・端部・アキの標記はすべてここが源。
 *   - elevation/elevationFaceList.js の kneeDropRecordFor … 面分割（袖壁の高さ）。
 *   - elevation/elevationFigure.js の kneeDropGapsOnFace … **描画ではなく配置の都合**。
 *     段差見付け面（kind==='step'。断面エンジンに対応概念が無い専用描画）と、壁2段書き
 *     ラベルの回避範囲（エンジンの出力は buildFaceFigure の後に積まれるため見えない）。
 * knee/drop指定の有無によるフィルタは呼び出し側の責務のまま（全レコードを返す）。
 * @param {object} graph
 * @param {import('@core').CenterLine} axisCL 壁・面の軸CL（idではなく座標で照合する。sameAxisLine）
 * @param {number} spanLo
 * @param {number} spanHi
 * @returns {Array<{key:string, rec:object, lo:number, hi:number}>} スパンが重ならないものは含まない
 */
export function kneeDropRecordsOnAxis(graph, axisCL, spanLo, spanHi) {
  const out = [];
  if (!axisCL) return out;
  for (const [key, rec] of graph.kneeDropWalls) {
    const [keyAxisCLId, startCLId, endCLId] = key.split(':');
    if (!sameAxisLine(getShape(graph, keyAxisCLId), axisCL)) continue;
    const startCL = getShape(graph, startCLId);
    const endCL   = getShape(graph, endCLId);
    if (!startCL || !endCL) continue;
    const lo = Math.min(startCL.value, endCL.value);
    const hi = Math.max(startCL.value, endCL.value);
    if (hi <= spanLo || lo >= spanHi) continue; // スパンが重ならない
    out.push({ key, rec, lo, hi });
  }
  return out;
}

/**
 * 「1本の壁」に対応する腰壁・垂れ壁レコードを返す（該当が複数あっても先頭）。
 * kneeDropRecordsOnAxis との違いは**隅の取り合いぶんのはみ出しを重なりとみなさない**こと
 * （SPAN_OVERLAP_EPS の説明参照）。素の重なり判定（kneeDropRecordsOnAxis）は面単位の列挙
 * （elevationFigure の kneeDropGapsOnFace）が使うため変えない——「壁がその区間の構成壁か」を
 * 問う経路はこちらか kneeDropRecordsAtPointOnWall を通る（平面の kneeDropWallGeometry と同じ判定）。
 * @param {object} graph
 * @param {import('@core').CenterLine} axisCL 壁の軸CL
 * @param {number} wLo 壁スパンの下側
 * @param {number} wHi 壁スパンの上側
 * @returns {{key:string, rec:object, lo:number, hi:number}|null}
 */
export function kneeDropRecordForWallSpan(graph, axisCL, wLo, wHi) {
  return kneeDropRecordsOnAxis(graph, axisCL, wLo, wHi)
    .find(r => isConstituentWall(r, wLo, wHi)) ?? null;
}

/**
 * wall（袖壁・腰壁）に対応する kneeDropWalls のレコードを返す（kneeDropRecordForWallSpan。
 * key解読は本ファイルに集約。QA修正L1）。axisCLId一致＋スパン重なりで判定し、
 * 該当が複数あっても先頭を採用する（隅の取り合いぶんだけ隣区間へ食い込んだ壁は対象外
 * ——平面の腰壁描画と同じ判定にする）。腰壁指定（knee）が無ければnull（=partitionCutAtLocal0/Runは
 * topHeight無し＝天井までのCUT枠になる）。elevationFaceList.js から移した（展開図リファクタ S1:
 * section/cuts が面の体裁層を import しないため。elevationFaceList.js が再公開する）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @returns {{knee?:{topHeight:number}, drop?:{bottomHeight:number}}|null}
 */
export function kneeDropRecordFor(wall, graph) {
  const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
  const found = kneeDropRecordForWallSpan(graph, wall.axisCL, wLo, wHi);
  return found ? found.rec : null;
}

// 壁スパン[wLo,wHi]がレコード区間の構成壁か。重なりが SPAN_OVERLAP_EPS を超えるか、壁全体が
// 区間に収まる（150mm未満の短い壁も構成壁。閾値で切ると短い腰壁が全高で描かれる）。
function isConstituentWall(r, wLo, wHi) {
  const overlap = Math.min(r.hi, wHi) - Math.max(r.lo, wLo);
  return overlap > SPAN_OVERLAP_EPS || overlap >= (wHi - wLo) - 1e-6;
}

/**
 * 壁の長さ方向の1点（幅±eps）に掛かる腰壁・垂れ壁レコードのうち、**その壁が区間の構成壁である**
 * ものだけを返す（本ファイルの kneeDropZRangesAt 用。断面エンジンは sectionHits.js 経由で引く）。
 * 点クエリだけだと、隅の取り合いで隣区間へ半壁厚ぶん食い込んだ壁端（57.5mm）が隣区間の
 * 腰壁指定を拾い、その壁端だけが腰壁の高さで描かれる（実機2026-09「22」2階 A1×X2: 全高の
 * 壁の端57.5mmだけが腰壁800の残骸になり、壁の見えがかりエッジが壁端＝CL右側ではなくCL上に
 * 立った）。平面の resolveKneeDropOverlays が同じ隅を同じ閾値で除外しており、両者を揃える。
 * 1本の壁が複数区間にまたがる（mergeSegments で結合された壁）場合は、点の掛かる区間ごとに
 * 従来どおり指定が切り替わる——区間との重なりが有意なら構成壁だから。
 * @param {object} graph
 * @param {import('@core').Wall} wall
 * @param {number} pointCoord 壁の長さ方向の世界座標
 * @param {number} eps 点クエリの半幅(mm)
 * @returns {Array<{key:string, rec:object, lo:number, hi:number}>}
 */
export function kneeDropRecordsAtPointOnWall(graph, wall, pointCoord, eps) {
  const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
  return kneeDropRecordsOnAxis(graph, wall.axisCL, pointCoord - eps, pointCoord + eps)
    .filter(r => isConstituentWall(r, wLo, wHi));
}

// kneeDropRecordsAtPointOnWall（区間重なり判定）への点クエリ用の微小幅(mm)。GAP_EPSより大きく
// PROBE_EPS_MMより小さい値にして、区間境界ちょうどのレコードも安定して拾えるようにする。
const POINT_QUERY_EPS_MM = 0.5;

// POINT_QUERY_EPS_MMの点クエリが0件だったときの再クエリ幅(mm)——隅の取り合いで壁端がレコード
// 区間の外へ食い込む量の許容差。SPAN_OVERLAP_EPSと同じ規約値（isConstituentWallが壁の全スパン基準で
// 使う許容差そのもの。chamferWalls・wallJunctionResolveのCORNER_EXCLUSION・closeConvexCornersの
// CONTINUE_TOLとも揃えた150mm）——kneeDropZRangesAt参照。sectionEmit.js の EDGE_ON_CORNER_EPS_MM とも同値。
const CORNER_OVERHANG_EPS_MM = 150;

/**
 * 腰壁・垂れ壁指定を反映したwallのz存在**範囲の並び**（§5.2 step2）。
 * 指定なし=[[floorZ,ceilZ]]（全高）。腰壁指定=[[floorZ,floorZ+topHeight]]、垂れ壁指定=
 * [[ceilZ-bottomHeight,ceilZ]]。
 *
 * **両方同時指定（＝アキ）は2つの範囲を返す**（腰壁の帯と垂れ壁の帯）。旧実装は「腰壁優先の
 * if/else」で垂れ壁側を捨てており、その結果アキの上を塞ぐ垂れ壁が実体として存在しないことに
 * なって、`open`帯が腰壁の天端から**天井まで**伸びていた（アキ＝四角い穴にならない）。
 * アキの表現をエンジンへ一本化するにはここが実体を正しく持っていなければならない。
 * 退化（腰壁と垂れ壁が接する／重なる）した指定は1本へ潰す——穴が無いなら壁は連続した1枚。
 * elevation/section/sectionHits.js から移した（展開図リファクタ S1: 平面の立体モデル plan/planSolids.js
 * が展開図エンジンの内部を引かないため。sectionHits.js が再公開する）。
 * @param {object} graph
 * @param {import('@core').Wall} wall
 * 点クエリに掛かるレコードでも、**wall自身がその区間の構成壁でなければ無視する**
 * （kneeDropRecordsAtPointOnWall）。隅の取り合いで隣区間へ食い込んだ壁端が隣区間の腰壁指定を
 * 拾うと、全高の壁の端だけが腰壁の高さになる（実機2026-09「22」2階 A1×X2の「腰壁の残骸」）。
 *
 * 逆に、狭い点クエリ（±POINT_QUERY_EPS_MM）が**0件**、かつ**pointCoordがwall自身の端
 * （wLo/wHi＝wall.coord1/coord2）からCORNER_OVERHANG_EPS_MM以内**のときだけ、検索窓を
 * ±CORNER_OVERHANG_EPS_MMへ広げて再クエリする（wall自身が区間の構成壁かの判定＝
 * isConstituentWallは`kneeDropRecordsAtPointOnWall`内で従来どおりwallの全スパン基準のまま
 * 変えない）。壁自身がその区間の腰壁として指定された本人でも、隅の取り合いで壁端がレコード
 * 区間の外（例: 区間端CLから57.5mm先）へ食い込むと、その食い込み部の点だけを見る狭い点クエリは
 * レコードのhi/loの外に出てしまい0件になる（実機2026-09「6」面C x=0: knee壁-1500..57.5のうち
 * 57.5mm食い込み部手前が全高に落ちていた）。CORNER_OVERHANG_EPS_MMは隅の取り合いの許容差
 * （SPAN_OVERLAP_EPSと同じ規約値。chamferWalls・wallJunctionResolveの
 * CORNER_EXCLUSION・closeConvexCornersのCONTINUE_TOLとも揃えた150mm）。
 * **「壁自身の端から150mm以内」の絞り込みが必須**（QA是正2026-09）——これが無いと、
 * mergeSegmentsで結合された長い壁（例: X1..X3の1本）の、区間境界(X2)の手前150mm
 * （壁自身の端からは遠いがレコード境界には近い点）まで隣区間の腰壁指定を拾ってしまい、
 * 全高であるべき区間が腰壁の高さへ縮む誤爆になる（区間境界の手前で切り替わる従来挙動が壊れる）。
 * @param {number} pointCoord - 点クエリ位置（wall自身の長さ方向座標）
 * @param {number} floorZ
 * @param {number} ceilZ
 * @param {{zAt:(along:number)=>number}|null} [wallTop] - 壁の天端プロファイル（絶対z。隔て壁の斜め天端）。
 *   あれば腰壁・垂れ壁より先に判定し、[floorZ, min(ceilZ, zAt(pointCoord))] の1件を返す
 *   （天端≦床なら空）。各件は topAt（along→天端z）を持つ。無ければ従来どおり。
 * @param {{worldLo:number, worldHi:number}|null} [span] - 列の幅（wallTop があるときだけ使う）。あれば天端は
 *   **幅の両端の高い方**（max）で取る——斜面を水平の帯で近似するとき、遮る範囲を広めに倒す（隠すべきものを
 *   描かない側）。省略は pointCoord の1点。
 * @returns {Array<{z0:number, z1:number, topAt?:(along:number)=>number}>} 1件 or 2件（z0昇順）。wallTopで潰れたら0件。
 */
export function kneeDropZRangesAt(graph, wall, pointCoord, floorZ, ceilZ, wallTop = null, span = null) {
  if (wallTop) {
    const top = span ? Math.max(wallTop.zAt(span.worldLo), wallTop.zAt(span.worldHi)) : wallTop.zAt(pointCoord);
    const z1 = Math.min(ceilZ, top);
    return z1 > floorZ ? [{ z0: floorZ, z1, topAt: wallTop.zAt }] : [];
  }
  let records = kneeDropRecordsAtPointOnWall(graph, wall, pointCoord, POINT_QUERY_EPS_MM);
  if (records.length === 0) {
    const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
    const nearWallEnd = pointCoord < wLo + CORNER_OVERHANG_EPS_MM || pointCoord > wHi - CORNER_OVERHANG_EPS_MM;
    if (nearWallEnd) {
      records = kneeDropRecordsAtPointOnWall(graph, wall, pointCoord, CORNER_OVERHANG_EPS_MM);
    }
  }
  for (const { rec } of records) {
    if (!rec.knee && !rec.drop) continue;
    const kneeTop  = rec.knee ? floorZ + rec.knee.topHeight : null;
    const dropBase = rec.drop ? ceilZ - rec.drop.bottomHeight : null;
    if (kneeTop != null && dropBase != null) {
      // アキ（四角い穴）: 腰壁 [floorZ, kneeTop] と垂れ壁 [dropBase, ceilZ]。
      if (dropBase <= kneeTop + GAP_EPS) return [{ z0: floorZ, z1: ceilZ }]; // 穴が潰れる指定
      return [{ z0: floorZ, z1: kneeTop }, { z0: dropBase, z1: ceilZ }];
    }
    if (kneeTop != null) return [{ z0: floorZ, z1: kneeTop }];
    return [{ z0: dropBase, z1: ceilZ }];
  }
  return [{ z0: floorZ, z1: ceilZ }];
}

/**
 * 押した壁と**繋がっている壁の連続範囲**（同じ通り・同じ向きで、隙間なく続く壁の集合）の
 * 両端を返す。端の座標だけでなく、その端を与えた壁の端点CL（clStart/clEnd）も返す
 * ——区間キーはCLで書くため。
 *
 * 隣り合う壁は隅の取り合いで半壁厚ぶん食い違う（端点は相手壁の仕上げ面まで伸びる）ので、
 * 連続とみなす隙間の許容は SPAN_OVERLAP_EPS と同値にする（同じ「隅の取り合いの許容差」）。
 * 壁の生成側（axisOffsetの符号）では分けない——同じ通りの1枚の壁が、部屋ごとに±両側の
 * 壁として生成されるのが通常だから。
 * @param {object} graph
 * @param {import('@core').Wall} wall
 * @returns {{lo:number, hi:number, loCL, hiCL}}
 */
function wallRunOf(graph, wall) {
  const peers = graph.walls.filter(w =>
    w.isVertical === wall.isVertical && sameAxisLine(w.axisCL, wall.axisCL));

  const endsOf = (w) => (w.coord1 <= w.coord2)
    ? { lo: w.coord1, hi: w.coord2, loCL: w.clStart, hiCL: w.clEnd }
    : { lo: w.coord2, hi: w.coord1, loCL: w.clEnd,   hiCL: w.clStart };

  let run = endsOf(wall);
  // 端が伸びなくなるまで繰り返す（1回の走査では、後ろに現れた壁が前の壁を繋げる場合を拾えない）
  for (let grew = true; grew;) {
    grew = false;
    for (const w of peers) {
      const e = endsOf(w);
      if (e.lo > run.hi + SPAN_OVERLAP_EPS || e.hi < run.lo - SPAN_OVERLAP_EPS) continue; // 繋がっていない
      if (e.lo < run.lo) { run = { ...run, lo: e.lo, loCL: e.loCL }; grew = true; }
      if (e.hi > run.hi) { run = { ...run, hi: e.hi, hiCL: e.hiCL }; grew = true; }
    }
  }
  return run;
}

/**
 * 壁の押下位置（ワールド座標）から、腰壁・垂れ壁の対象区間キー（edgeKey）を解決する。
 * 壁の部屋側（axisOffsetの符号側）へ微小オフセットしてセルを解決し、壁の長さ方向のセル境界
 * CLペアをedgeKeyへ正規化する（computeNamedBoundaryEdges と同じ正規化規則）。
 *
 * ただしセル境界は**押した壁より長いことがある**——セルは部屋側の領域片であり、その辺に
 * 沿って壁が途切れていても1枚のセルのままだから（実機「10」2階 X3: Y2〜Y1 が1セルで、
 * 通り上には Y2〜-3500 と -2000〜Y1 の2本の壁が分断して建つ）。セル境界をそのまま区間に
 * すると、指定していない別の壁まで同じ区間の構成壁として腰壁になる。そこで区間を
 * **押した壁の連続範囲**（wallRunOf）で内側へ詰める。詰めるのは常に狭める方向だけなので、
 * 1本の壁がセルをまたぐ場合の「セル単位で指定できる」粒度は変わらない。
 * @param {import('@core').Wall} wall
 * @param {{x:number,y:number}} worldPos
 * @param {object} graph
 * @returns {string|null} 解決不能（グリッド外・格子未成立）なら null
 */
export function resolveWallSpanKey(wall, worldPos, graph) {
  const axisCL = wall.axisCL;
  const axisV  = axisCL.effectiveValue;
  const along  = wall.isVertical ? worldPos.y : worldPos.x;
  const dir    = Math.sign(wall.axisOffset) || 1;
  const probe  = axisV + dir * PRESS_SIDE_EPS;

  const cell = wall.isVertical
    ? worldToCell(probe, along, graph)
    : worldToCell(along, probe, graph);
  if (!cell) return null;

  const [leftId, topId, rightId, bottomId] = cell.key.split(':');
  const [sId, eId] = wall.isVertical ? [topId, bottomId] : [leftId, rightId];
  const sCL = getShape(graph, sId), eCL = getShape(graph, eId);
  if (!sCL || !eCL) return null;
  let [loCL, hiCL] = sCL.value <= eCL.value ? [sCL, eCL] : [eCL, sCL];

  // 連続範囲で内側へ詰める。端のCLが区間の内側にあるときだけ差し替える（外側＝セルの方が
  // 狭いならセルのまま）。詰めた結果が潰れる（lo>=hi）組み合わせは採らない。
  const run = wallRunOf(graph, wall);
  if (run.loCL && run.loCL.value > loCL.value && run.loCL.value < hiCL.value) loCL = run.loCL;
  if (run.hiCL && run.hiCL.value < hiCL.value && run.hiCL.value > loCL.value) hiCL = run.hiCL;

  return edgeKey(axisCL.id, loCL.id, hiCL.id);
}

/**
 * 区間キーの幾何と、そこに重なる全Wallの実面範囲（materialRange のmin/max合算）を解決する。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom buildCellToRoom(graph) の結果
 * @returns {{axisCL, isVertical:boolean, lo:number, hi:number, faceLo:number, faceHi:number,
 *   walls:import('@core').Wall[], roomNeg, roomPos} | null}
 *   faceLo/faceHi = 区間に重なる壁群の仕上げ全幅（材が存在する範囲の外包絡）。
 *   壁が1本も無ければ null（孤児区間）。
 */
export function kneeDropWallGeometry(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const { axisCL, isVertical, lo, hi, roomNeg, roomPos } = geo;

  let faceLo = Infinity, faceHi = -Infinity;
  const walls = [];
  for (const w of graph.walls) {
    // 軸の一致は id ではなく通り（向き＋座標）で見る（sameAxisLine。同じ通りに別CLが2本ある
    // 図面があり、id一致だと区間の構成壁を取りこぼす）。
    if (!sameAxisLine(w.axisCL, axisCL) || w.isVertical !== isVertical) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (Math.min(wHi, hi) - Math.max(wLo, lo) <= SPAN_OVERLAP_EPS) continue;
    const mr = w.materialRange;
    faceLo = Math.min(faceLo, mr.lo);
    faceHi = Math.max(faceHi, mr.hi);
    walls.push(w);
  }
  if (walls.length === 0) return null;

  return { axisCL, isVertical, lo, hi, faceLo, faceHi, walls, roomNeg, roomPos };
}

/**
 * 壁が腰壁・垂れ壁指定の対象として適格か（外壁と、2a壁＝階段下部屋の偏芯壁は対象外）。
 * 2a壁は generateStairUnderWalls 固有の偏芯式で生成される別管理の壁で、通常の壁帯描画の
 * 前提（materialRange の単純合算）がそのまま成立しないため対象から除く（.claude/data-model.md
 * 「内周壁は仕上げ脱出境界で全削除・導出再生成する」2a節参照）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @returns {boolean}
 */
export function isEligibleWallSpan(wall, graph) {
  if (wall.isExteriorWall) return false;
  // 隔て壁（在来木造の折返し・回り階段〔U 字系〕）は対象外（S5 までの暫定。座標照合）
  if (isStairPartitionWall(wall, stairPartitionLines(graph))) return false;
  // 復路下の壁も対象外（座標照合。stairPartition.js stairUnderReturnLines）
  if (isStairUnderReturnWall(wall, stairUnderReturnLines(graph))) return false;
  for (const stair of graph.stairs) {
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size === 0) continue;
    for (const room of stairUnderRoomsOf(stair, graph, beyond)) {
      if (room.generatedWallIds.has(wall.id)) return false;
    }
  }
  return true;
}

/**
 * 区間の両側の部屋の天井高さのうち低い方を返す（片側が部屋なしならその側は無視）。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom
 * @returns {number|null} 両側とも部屋なし（区間の幾何が解決できない）なら null
 */
export function effectiveCeilingHeight(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const heights = [];
  for (const room of [geo.roomNeg, geo.roomPos]) {
    if (!room) continue;
    heights.push(roomCeilingHeight(graph, room).mm);
  }
  if (heights.length === 0) return null;
  return Math.min(...heights);
}

/**
 * 区間の両側の部屋の「床段差＋天井高さ」（階の FL からの天井面の高さ。ceilingSurfaces の zMm と同じ式）のうち低い方。
 * effectiveCeilingHeight（床段差を含まない）は変えず、壁の上端（planSolids.js wallCeilProfile）用に別に持つ。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom
 * @returns {number|null} 区間の幾何が解決できない・両側とも部屋なしなら null
 */
export function effectiveCeilingTopFromFloor(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const tops = [];
  for (const room of [geo.roomNeg, geo.roomPos]) {
    if (!room) continue;
    tops.push(roomCeilingTopMm(graph, room));
  }
  if (tops.length === 0) return null;
  return Math.min(...tops);
}

/**
 * 階の部屋の「床段差＋天井高」がすべて既定の天井高（graph.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT。層の天井と同じ値）
 * に等しいときのその値（早道。壁の上端は区間に割らずこの値）。部屋が無い・値が違う部屋がある・既定値と違うときは null。
 * 既定値と等しいときだけ使うのは、部屋の無い区間の値（層の天井）が早道の有無で変わらないようにするため。
 * @param {object} graph
 * @returns {number|null}
 */
export function uniformCeilingTopMm(graph) {
  const dflt = graph.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT;
  let any = false;
  for (const room of graph.rooms) {
    if (roomCeilingTopMm(graph, room) !== dflt) return null;
    any = true;
  }
  return any ? dflt : null;
}

/**
 * 壁の長さ方向を、壁と直交する分割CLで区間に割り、区間ごとの effectiveCeilingTopFromFloor を返す
 * （planSolids.js wallCeilProfile 用。ユーザー裁定 2026-10-22「部屋ごとの天井に合わせる」）。
 * 上端が同じ（null どうしを含む）隣の区間は結合する＝区間の境は上端が替わる所だけ。
 * 区間はCL値で表す（端の区間は壁の端点CL clStart／clEnd まで）。壁の座標は隅の取り合いでCL値からずれるので、
 * 呼び出し側は壁の座標の点をこの区間へ当てる（端は最初／最後の区間へ寄せる）。
 * @param {object} graph
 * @param {import('@core').Wall} wall axisCL・clStart・clEnd を持つ壁
 * @param {Map<string, import('@core').Room>} cellToRoom
 * @param {{uniformTop?: number|null}} [opts] uniformTop＝階の全部屋の天井面の高さが同じときのその値（uniformCeilingTopMm）。
 *   数値なら分割CLも部屋も引かず、壁全長を 1 区間（top＝その値）にする
 * @returns {Array<{lo:number, hi:number, top:number|null}>} lo 昇順。壁の端点CLが解決できなければ []
 */
export function ceilingTopSectionsAlongWall(graph, wall, cellToRoom, { uniformTop = null } = {}) {
  if (!(wall.axisCL && wall.clStart && wall.clEnd)) return [];
  const lo = Math.min(wall.clStart.value, wall.clEnd.value);
  const hi = Math.max(wall.clStart.value, wall.clEnd.value);
  if (Number.isFinite(uniformTop)) return [{ lo, hi, top: uniformTop }];
  const [loCL, hiCL] = wall.clStart.value <= wall.clEnd.value ? [wall.clStart, wall.clEnd] : [wall.clEnd, wall.clStart];
  const perp = wall.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const cls = [loCL, ...dividerCLsBetween(graph, perp, lo, hi), hiCL];
  const out = [];
  for (let i = 0; i + 1 < cls.length; i++) {
    const top = effectiveCeilingTopFromFloor(graph, edgeKey(wall.axisCL.id, cls[i].id, cls[i + 1].id), cellToRoom);
    const prev = out[out.length - 1];
    if (prev && prev.top === top) prev.hi = cls[i + 1].value;
    else out.push({ lo: cls[i].value, hi: cls[i + 1].value, top });
  }
  return out;
}

/**
 * 腰壁高さ・垂れ壁高さの入力値を検証する。
 * @param {number|null} kneeTop 腰壁の上端寸法(mm)。null=腰壁指定なし
 * @param {number|null} dropBottom 垂れ壁の下端寸法(mm)。null=垂れ壁指定なし
 * @param {number|null} ceilingHeight effectiveCeilingHeight の結果
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateKneeDropWall(kneeTop, dropBottom, ceilingHeight) {
  if (kneeTop == null && dropBottom == null) return { valid: true, error: null }; // 両方未指定＝解除
  if (ceilingHeight == null) return { valid: false, error: ERR_CEILING_HEIGHT_UNRESOLVED };

  const max = ceilingHeight - MIN_HEIGHT;
  if (kneeTop != null && !(kneeTop >= MIN_HEIGHT && kneeTop <= max)) {
    return { valid: false, error: `腰壁高さは${MIN_HEIGHT}〜${max}mmで指定してください` };
  }
  if (dropBottom != null && !(dropBottom >= MIN_HEIGHT && dropBottom <= max)) {
    return { valid: false, error: `垂れ壁高さは${MIN_HEIGHT}〜${max}mmで指定してください` };
  }
  if (kneeTop != null && dropBottom != null) {
    const limit = ceilingHeight - 2 * BOTH_MARGIN;
    if (kneeTop + dropBottom > limit) {
      return { valid: false, error: `腰壁高さ＋垂れ壁高さは${limit}mm以下にしてください` };
    }
  }
  return { valid: true, error: null };
}

/**
 * 描画用: 腰壁・垂れ壁が指定された区間に重なる全WallのID → 描画オーバーレイ情報のMapを返す
 * （wallJunctionResolve.js の resolveWallTJunctions と同様、毎レンダー解決）。
 *
 * 優先順位（同一区間に腰壁・垂れ壁が同居する場合）: 腰壁が平面切断高さを貫く
 * （topHeight > 階の切断高）ときは常に通常の壁帯描画を優先し、垂れ壁のオーバーレイも
 * 出さない（要件の明示規則）。腰壁が貫かない（<=階の切断高）ときは腰壁の天板輪郭が
 * 常に優先される（腰壁天板より低い切断面には他に描くものが無いため）。腰壁指定が無い区間
 * でのみ垂れ壁の判定（切断面が壁本体を貫くか）を行う。
 * 見上げ（天伏）は opts で切り替える（kneeDropUpOptions）: 切断高は平面の値ではなく区間ごとの天伏の切断高（cutHeightOf。平面の切断高を使わない＝
 * 裁定 2026-10-18「天伏の切断高は平面と変える」）、同じ区間に腰壁と垂れ壁が同居するときは天井に近い垂れ壁を採る（preferDrop）。
 * opts 省略（平面）は従来どおりで出力不変。opts を渡したときだけ overlay に cutMm（その区間の切断高）を足す。
 * @param {object} graph
 * @param {{cutHeightOf?: ((geo: object) => number)|null, preferDrop?: boolean}} [opts]
 *   cutHeightOf＝区間の幾何（kneeDropWallGeometry の結果）から切断高を返す。省略は平面の切断高。preferDrop＝腰壁・垂れ壁の同時指定を垂れ壁として扱う
 * @returns {Map<string, {mode:'knee'|'drop', capLo:number, capHi:number, topHeight?:number, cutMm?:number}>}
 *   topHeight は mode==='knee' のみ（planWallHeight が読む平面での壁の高さ）。
 */
export function resolveKneeDropOverlays(graph, opts = {}) {
  const result = new Map();
  if (graph.kneeDropWalls.size === 0) return result;
  const { cutHeightOf = null, preferDrop = false } = opts;
  const cellToRoom = buildCellToRoom(graph);
  const planCutHeight = planCutHeightMmOf(graph.plane); // 階の属性（Plane.planCutHeightMm）

  for (const [key, rec] of graph.kneeDropWalls) {
    if (!rec.knee && !rec.drop) continue;
    const geo = kneeDropWallGeometry(graph, key, cellToRoom);
    if (!geo) continue;
    const capLo = geo.faceLo - CAP_OVERHANG, capHi = geo.faceHi + CAP_OVERHANG;
    const cutHeight = cutHeightOf ? cutHeightOf(geo) : planCutHeight;

    let overlay = null;
    if (preferDrop && rec.drop && rec.knee && rec.knee.topHeight > cutHeight) {
      // 見上げで腰壁が切断される（天端が切断高より上）ときは通常の壁（垂れ壁の破線も出さない）
    } else if (rec.knee && !(preferDrop && rec.drop)) {
      // topHeight は「平面での壁の高さ」（planWallHeight）の情報源も兼ねる——壁同士の
      // 取り合いで高い方を優先するための比較に使う。
      if (rec.knee.topHeight <= cutHeight) {
        overlay = { mode: 'knee', capLo, capHi, topHeight: rec.knee.topHeight };
      }
    } else if (rec.drop) {
      const ceilingHeight = effectiveCeilingHeight(graph, key, cellToRoom);
      // 垂れ壁の下端（床からの高さ = ceilingHeight - bottomHeight）が平面切断高さより上にあれば、
      // 切断面は壁本体を貫かない（notCutByPlane）——このときだけ天板輪郭の破線オーバーレイを出す。
      // 下端が切断面以下（=切断面が壁本体を貫く）なら通常の壁帯描画のまま。
      const notCutByPlane = ceilingHeight != null && (ceilingHeight - rec.drop.bottomHeight) > cutHeight;
      if (notCutByPlane) overlay = { mode: 'drop', capLo, capHi };
    }
    if (!overlay) continue;
    if (cutHeightOf) overlay.cutMm = cutHeight;

    for (const w of geo.walls) {
      if (!result.has(w.id)) result.set(w.id, overlay);
    }
  }
  // 天板どうしが角で出会う取り合い（ユーザー確定2026-09「天板の内側・外側どうしでトリムし、
  // 端部の線は描かない」）は、天板を高さクラスごとの領域として解く renderer/planWallRegion.js
  // （`resolveCapLines`）の帰結として得る——ここは帯の位置と線種・高さを供給するだけ。
  return result;
}

/**
 * 天板の輪郭（resolveKneeDropOverlays の結果）を、この向きの図に描くか。
 * 見下げ（'down'）は全部描く。見上げ（'up'・天伏）では、天伏の切断高より低い腰壁は
 * 切断面の下にあって見えない（見上げの視線に入らない）ので描かない。垂れ壁は天井から下がって
 * 見えるので従来どおり描く。腰壁の天端が切断高以上なら切断される壁＝従来の描画に任せる。
 * @param {{mode:'knee'|'drop', topHeight?:number}|null|undefined} overlay
 * @param {'up'|'down'} direction
 * @param {number} ceilingCutMm 階の天伏切断高（ceilingCutHeightMmOf）
 * @returns {boolean}
 */
export function shouldDrawCapOutline(overlay, direction, ceilingCutMm) {
  if (!overlay) return false;
  if (direction !== 'up') return true;
  if (overlay.mode !== 'knee') return true;
  return !(overlay.topHeight < (overlay.cutMm ?? ceilingCutMm)); // 区間ごとの切断高（見上げの解決）があればそれを優先
}

// 区間に沿って壁の切断高を問う位置（区間の割合）
const ALONG_SAMPLES = [0.25, 0.5, 0.75];

/**
 * 見上げ（天伏）で resolveKneeDropOverlays に渡す opts。区間の切断高＝区間に沿った数点で wallCutAt（ceiling/ceilingCutHeight.js
 * ceilingCutResolverOf の wallCutAt＝壁の両側の天井のある部屋の切断高の小さい方。両側とも天井が無ければ階の値）を引いた最小。
 * 腰壁・垂れ壁の同時指定は垂れ壁を採る。
 * @param {(isVertical: boolean, axisMm: number, alongMm: number) => number} wallCutAt
 */
export function kneeDropUpOptions(wallCutAt) {
  return {
    preferDrop: true,
    cutHeightOf: geo => {
      const axis = geo.axisCL.effectiveValue;
      let min = Infinity;
      for (const t of ALONG_SAMPLES) min = Math.min(min, wallCutAt(geo.isVertical, axis, geo.lo + (geo.hi - geo.lo) * t));
      return min;
    },
  };
}

/**
 * 平面での壁の高さ(mm)——「壁同士の取り合いは**高い方が優先**」（ユーザー確定2026-09）を
 * 判定するための唯一の供給源。
 *
 * 平面切断高さ以下の腰壁は天板輪郭（`resolveKneeDropOverlays` の mode==='knee'）で描かれ、
 * **切断面には存在しない**——その天端高さがそのまま高さになる。それ以外の壁は切断面に
 * 切られる＝腰壁より必ず高いので `Infinity` を返す（天井高さを引かない: 比較にしか使わない
 * 値であり、実高さを持ち出すと部屋ごとの天井高さの差で取り合いが揺れる）。
 * 垂れ壁（mode==='drop'）は対象外＝従来どおり `Infinity` 扱い——確定した規則は腰壁のみ。
 * @param {Map<string, object>|null|undefined} overlays resolveKneeDropOverlays の結果
 * @param {string} wallId
 * @returns {number}
 */
export function planWallHeight(overlays, wallId) {
  const o = overlays?.get(wallId);
  return o?.mode === 'knee' ? o.topHeight : Infinity;
}

