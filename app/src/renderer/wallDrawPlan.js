/**
 * 平面の壁描画に必要な「壁をまたぐ派生値」を1レンダー分まとめて解決する純モジュール。
 * ShapesLayer.jsx の描画前準備（下地の重複防止・T字取り合い・腰壁垂れ壁・柱の仕上げ包み・
 * 壁ごとの開口・壁ごとの面線/内側線/キャップ抑止の解決＝resolveWallLines）をレンダラから
 * 切り出したもの。挙動は切り出し前と同じ。
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
 * ## ShapesLayer.jsx に残る未検証ロジック（構造的な残余。2026-09時点）
 * このモジュールへ「判断」を寄せたが、`.jsx` 側にはまだ react-konva を静的 import するために
 * node から検証できないロジックが残る——site/stair/柱包みの各レイヤーと同じ扱いで、これらは
 * **写像であって判断ではない**（対象の型・座標をどのKonvaノードへどう対応付けるかという
 * 描画特有の関心事）と整理した上で意図的に残している:
 *   - `wallLines.get(shape.id)` の取り出しと各フィールドへの分配
 *   - `faceSegments`/`finSegments` と実際の描画座標（`faceV`/`plan.finBoundary`、
 *     `shape.isVertical`による軸の振り分け）との対応付け
 *   - cap 抑止フラグ（`capLoSuppressed`/`capHiSuppressed`）を「最初のセグメントの始点」
 *     「最後のセグメントの終点」にのみ適用するインデックス条件（`i===0`/`i===length-1`）
 *   - 下地（間柱）描画の `extended`（`baseExtend`適用）・`studCuts`（柱カット）による
 *     セグメント調整とピッチ配置
 *   - 端点はねだし部の木口（ecap）の描画可否判定・座標計算
 *   - SCHEMATIC/腰壁・垂れ壁/標準・詳細の分岐そのもの（どのKonvaコンポーネントを使うか）
 *   - 腰壁・垂れ壁の`Rect`座標変換
 *   - 2a壁（階段下部屋）の描画クリップ（`stairUnderClips`）適用
 *   - `key`/`listening`/`fill`等のKonva props・配列内の描画順
 * これらをさらに純関数へ追い出す設計（`resolveWallLines`を描画スペック配列
 * `{kind,points}[]`まで進めて`.jsx`を完全な写像にする案）も検討したが、cap/ecap/下地
 * スタッド/腰壁Rectまで移す大改修になり回帰リスクが見合わないため今回は見送る
 * （2026-09 QA協議）。
 */
import { ShapeType } from '@core';
import { LodLevel } from '../viewport.js';
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { resolveWallTJunctions, resolveWallFinSegments, isCapSuppressed, resolveFinVisibility } from './wallJunctionResolve.js';
import { ENDPOINT_EPS } from '../finish/wallFinishJoin.js';
import { isEndpointAt } from '../transform/centerLineExtend.js';
import { resolveKneeDropOverlays } from '../finish/kneeDropWall.js';
import { columnWallCuts } from '../finish/columnWrap.js';
import { indexByAxis, findOpeningsOnWallIndexed } from '../openings/openingGeometry.js';
import { resolveFinishLineMerges } from './finishLineSplits.js';

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
 * 走査は axisCL 単位に束ねる（全壁の総当たりと結果は同一——判定条件が
 * `o.axisCL === w.axisCL` を含むため、別の軸CLの壁は元から一致しない）。
 * @param {object[]} generalShapes
 * @returns {Set<string>}
 */
export function resolveDeferredBackingIds(generalShapes) {
  const deferred = new Set();
  const byAxis = new Map(); // axisCL → 対象壁
  for (const s of generalShapes) {
    if (s.type !== ShapeType.WALL || s.wallFinish == null || s.backingOffset != null) continue;
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
 * 壁1本分の描画ライン（開口分割・仕上げ面線・内側線・キャップ抑止）を解決する純関数。
 * ShapesLayer.jsx が下していた判断（面線・内側線をどこで切るか、キャップを描くか）を
 * ここへ集約し、.jsx は返り値を `<Line>` へ写すだけにする——以前はこの判断が.jsx内に
 * インラインで書かれており、呼び出し側が正しい引数を渡すかを検証するテストが0本だった
 * （`isCapSuppressed`へ空のcapSuppressを渡す・`resolveWallFinSegments`の戻り値を無視する・
 * 仕上げ面線をfinCuts側の区間で切る、のいずれの変異もフルスイートが緑のままだった＝
 * QA指摘）。wallDrawPlan.test.js が実Wallインスタンスでこの関数の呼び出し結果を検証する。
 *
 * @param {import('@core').Wall} wall
 * @param {{openings?:object[], junction?:object, colCuts?:object}} [deps]
 *   junction: wallJunctions.get(wall.id)（resolveWallTJunctionsの結果。endExtend/spanCutsは
 *     描画上の壁スパンを置き換え／切り欠き、endWrapは端部の仕上げ材の回り込みを立てる）
 *   colCuts: columnCuts.get(wall.id)（columnWallCutsの結果。face/fin/backingの3区間を持つ）
 * @returns {{
 *   segments:[number,number][],
 *   faceSegments:[number,number][],
 *   finSegments:[number,number][],
 *   finBoundary:number,
 *   finVisible:boolean,
 *   spanLo:number,
 *   spanHi:number,
 *   endWrapLo:number|null,
 *   endWrapHi:number|null,
 *   capLoSuppressed:boolean,
 *   capHiSuppressed:boolean,
 *   capValues:number[],
 *   ecapValues:number[],
 * }}
 *   capValues/ecapValues: 妻線・木口線を引く長さ方向の位置（抑止判定・描画条件を適用済み）。
 *   厚み方向の範囲は wall.materialRange。
 *   spanLo/spanHi: 描画上の壁スパン（endExtend適用後）。endWrapLo/Hi: その端を仕上げ材で
 *   取り巻く木口線の位置（null＝取り巻かない）。
 */
export function resolveWallLines(wall, { openings = [], junction, colCuts, endpointAt } = {}) {
  // **描画上の壁スパン**: 低い壁（腰壁）とL字の端部で取り合う高い壁は、その端を相手の帯の
  // 遠位面まで伸ばして描く（wallJunctionResolve.js パス0のendExtend。ユーザー確定2026-09
  // 「高い方の壁仕上げ材が端部を覆う」）。ここで1回だけ広げれば、面線・内側線・妻線・下地・
  // 開口分割のすべてが同じ端点に従う——モデルの端点（wall.coord1/coord2）は変えない。
  const endExtend = junction?.endExtend ?? {};
  const lo = endExtend.lo ?? Math.min(wall.coord1, wall.coord2);
  const hi = endExtend.hi ?? Math.max(wall.coord1, wall.coord2);
  // 開口がある区間を除いた複数の区間に分割する（openingsはcoord1昇順が前提）。
  const rawSegments = [];
  let cursor = lo;
  for (const o of openings) {
    if (o.coord1 > cursor) rawSegments.push([cursor, o.coord1]);
    cursor = Math.max(cursor, o.coord2);
  }
  if (cursor < hi) rawSegments.push([cursor, hi]);
  // 高い壁の帯に覆われる区間は描かない（低い壁側。パス0のspanCuts）。segmentsを直接削るため、
  // 面線・内側線・妻線・下地・腰壁の天板輪郭がまとめて従う。
  const spanCuts = junction?.spanCuts ?? [];
  const segments = spanCuts.length === 0 ? rawSegments
    : rawSegments.flatMap(([a, b]) => subtractIntervals(a, b, spanCuts));

  const baseExtend  = junction?.baseExtend ?? {};
  const faceCuts    = junction?.faceCuts ?? [];
  const finCuts     = junction?.finCuts ?? [];
  const finEnd      = junction?.finEnd ?? {};
  const capSuppress = junction?.capSuppress ?? {};
  // 端部を仕上げ材で取り巻く端（パス0のendWrap）: 外側線（面線・妻線）は端まで描き、内側線は
  // 端から仕上げ厚ぶん手前で止めて、そこへ木口線（endWrapLo/Hiの位置）を渡す。内側線の止め先は
  // パス2と同じ`finEnd`で表す——「内側線の端点を取り合う相手の内側線の位置に置く」規則の、
  // 相手が**自分の端に回り込んだ仕上げ材**である場合。
  const endWrap = junction?.endWrap ?? {};
  const finish = wall.wallFinish > 0 ? wall.wallFinish : 0;
  const wrapLo = endWrap.lo && finish > 0 ? lo + finish : null;
  const wrapHi = endWrap.hi && finish > 0 ? hi - finish : null;
  const finEndWrapped = { ...finEnd };
  if (wrapLo != null) finEndWrapped.lo = wrapLo;
  if (wrapHi != null) finEndWrapped.hi = wrapHi;

  // 仕上げ面線・仕上げ境界線（fin線）専用のセグメント: 直交する通し壁側からのカットが
  // あれば、その区間だけ切り欠く。柱の仕上げ包み（柱壁）が占める区間も同じ切り欠きとして
  // 扱う（columnWallCuts）。**層ごとに区間が違う**——仕上げ面線は柱壁の外形幅・T字通し壁の
  // 全材幅（faceCuts）、仕上げ境界線は内側境界の幅・T字通し壁の下地幅（finCuts）で切る
  // （同じ区間で切ると柱側の境界線と端が食い違い、柱を一周して見える）。
  const cutBy = (baseCuts, extra) => (baseCuts.length === 0 && extra.length === 0) ? segments
    : segments.flatMap(([a, b]) => subtractIntervals(a, b, [...baseCuts, ...extra]));
  const faceSegments = cutBy(faceCuts, colCuts?.face ?? []);
  const finSegments = resolveWallFinSegments({
    segments, lo, hi, finEnd: finEndWrapped, finCuts, columnFinCuts: colCuts?.fin ?? [],
  });

  // cap線（妻線）抑止判定は自壁の物理両端（最初のセグメントの始点＝lo端／最後のセグメントの
  // 終点＝hi端）でのみ意味を持つ（開口で分割された中間セグメント境界は対象外）。
  const segCount = segments.length;
  const capLoSuppressed = segCount > 0 && isCapSuppressed('lo', 0, segCount, { baseExtend, capSuppress });
  const capHiSuppressed = segCount > 0 && isCapSuppressed('hi', segCount - 1, segCount, { baseExtend, capSuppress });
  // 妻線（cap）・木口線（ecap）を**引く位置**もここで決める（.jsx は写像するだけにする）。
  // 判断をここへ寄せた理由は2つ:
  //  1. 分割検出（finishLineSplits.js）が「描かれる仕上げ線」を漏れなく見るため——実機2026-09の
  //     出隅では直交壁の妻線・木口線が相手壁の仕上げ線と同一直線に並んで1本を構成しており、
  //     .jsx 側にしか位置が無いと検出から漏れる（ユーザー指摘「黒線が残っている」）。
  //  2. 抑止フラグと位置が別ファイルに分かれていると、片方だけ直したときに食い違う。
  // 妻線: セグメント境界ごと。自壁の物理両端だけ抑止判定を効かせる（中間境界は開口の縁）。
  const capValues = [];
  segments.forEach(([a, b], i) => {
    if (!(i === 0 && capLoSuppressed)) capValues.push(a);
    if (!(i === segCount - 1 && capHiSuppressed)) capValues.push(b);
  });
  // 木口線: 端部はねだし部（軸CLの線分範囲越え＋その端がCLの端点）か、低い壁の端部を覆った端
  // （endWrap）。位置は端から仕上げ厚ぶん内側で、実在するセグメントの内部に限る。
  const ecapValues = [];
  if (finish > 0) {
    const cl = wall.axisCL;
    const tips = [
      { wrap: wrapLo, beyond: cl?.extentLo != null && lo < cl.extentLo - ENDPOINT_EPS && !!endpointAt?.lo, capV: lo + finish },
      { wrap: wrapHi, beyond: cl?.extentHi != null && hi > cl.extentHi + ENDPOINT_EPS && !!endpointAt?.hi, capV: hi - finish },
    ];
    for (const t of tips) {
      if (t.wrap == null && !t.beyond) continue;
      if (!segments.some(([a, b]) => t.capV > a && t.capV < b)) continue;
      ecapValues.push(t.capV);
    }
  }
  // fin線（仕上げ／下地の境界線）の位置・可視性は壁単体の性質（他壁との取り合いを見ない）
  // ——resolveFinVisibility が唯一の供給源（wallJunctionResolve.js のパス2候補判定
  // ＝makeView と同じ関数）。ShapesLayer.jsx はこれを読むだけにする。
  const { finBoundary, finVisible } = resolveFinVisibility(wall);
  return {
    segments,
    faceSegments,
    finSegments,
    finBoundary,
    finVisible,
    spanLo: lo,
    spanHi: hi,
    endWrapLo: wrapLo,
    endWrapHi: wrapHi,
    capLoSuppressed,
    capHiSuppressed,
    capValues,
    ecapValues,
  };
}

/**
 * 1レンダー分の壁描画準備をまとめて解決する。
 * @param {object} graph
 * @param {string} lodLevel - viewport.lodLevel（LodLevel）
 * @returns {{
 *   deferredBackingIds: Set<string>,
 *   wallJunctions: Map<string, object>|null,
 *   kneeDropOverlays: Map<string, object>|null,
 *   columnCuts: Map<string, object>|null,
 *   wallLines: Map<string, object>,
 *   finishMerges: Map<string, [number,number]|null>|null,
 * }}
 */
export function buildWallDrawPlan(graph, lodLevel) {
  const detail = lodLevel === LodLevel.DETAIL;
  const schematic = lodLevel === LodLevel.SCHEMATIC;
  const walls = graph.walls;

  // 壁ごとの開口（開口位置で壁線にギャップを入れるための区間分割）。従来は壁1本ごとに
  // graph.openings を総当たりしていた（O(壁 × 開口)）。coord1 昇順は resolveWallLines の
  // 区間分割が前提にしているためここで確定させる。openingsByWall自体は resolveWallLines
  // へ渡すためだけの中間値で、外部消費者はいない（ShapesLayer.jsxはwallLines経由でしか
  // segmentsを読まない）ため返り値には含めない。
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

  // 壁のT字取り合い（突き当たり）解決: 詳細LODでのみ、ジオメトリを変えずに描画時だけ反映する
  // （wallJunctionResolve.js。resolveStairSideLines と同じ「描画ルールを幾何モジュールに
  // 集約しレンダラは写像するだけ」というパターン）。壁全般が対象——手動壁・部屋壁・外壁・
  // 階段下壁を区別しない。
  const wallJunctions = detail ? resolveWallTJunctions(walls, kneeDropOverlays) : null;
  // 柱の仕上げ包み（柱壁）と取り合う区間。柱を描かないモード（仕上げ・敷地）でも
  // 壁の見た目は「柱に取られた区間」を反映してよい——柱は実在するため。
  const columnCuts = schematic ? null : columnWallCuts(graph);

  // 壁ごとの描画ライン（開口分割・仕上げ面線・内側線・キャップ抑止）をここでまとめて解決する
  // （resolveWallLines。ShapesLayer.jsx は返り値を写像するだけにする）。SCHEMATIC では
  // wallJunctions/columnCuts がともにnullのため、面線・内側線・キャップ抑止は自然に
  // 無変更（segmentsのみが単線描画に使われる）になる。
  const wallLines = new Map();
  for (const wall of walls) {
    wallLines.set(wall.id, resolveWallLines(wall, {
      openings: openingsByWall.get(wall.id),
      junction: wallJunctions?.get(wall.id),
      colCuts: columnCuts?.get(wall.id),
      // 木口線の「端点はねだし」判定にCLの端点かどうかが要る（graph依存なのでここで解決して渡す）。
      endpointAt: detail && wall.axisCL
        ? { lo: isEndpointAt(graph, wall.axisCL, 'lo'), hi: isEndpointAt(graph, wall.axisCL, 'hi') }
        : null,
    }));
  }

  return {
    deferredBackingIds: detail ? resolveDeferredBackingIds(graph.generalShapes) : EMPTY_SET,
    wallJunctions,
    kneeDropOverlays,
    columnCuts,
    wallLines,
    // 分かれて描かれている仕上げ線を1本にまとめる指示（finishLineSplits.js）。
    // 内側線・妻線・木口線は詳細LODでしか描かないので詳細のみ。null＝まとめない。
    finishMerges: detail
      ? resolveFinishLineMerges(collectFinishLines(walls, wallLines, kneeDropOverlays))
      : null,
  };
}

/**
 * 描かれる仕上げ線（面線・内側線）を、分割検出（finishLineSplits.js）が食べる形へ写す。
 * key は ShapesLayer.jsx が <Line> に付ける key と同じ文字列にする——検出結果をレンダラ側で
 * 線分ごとに引き当てるため（色分けも本実装の延長対象の特定も同じキーで引く）。
 * 腰壁・垂れ壁（kneeDropOverlays に載る壁）は**除く**——これらは仕上げ線ではなく天板幅の
 * 矩形輪郭（Rect）で描かれ、face/fin/cap/ecap のどれも描かれない。除かないと「描かれていない線」を
 * 連なりに数えてしまい、実機2026-09の2階X2×Y1+2000では垂れ壁の面線が本体（body）として拾われた。
 *
 * @param {object[]} walls
 * @param {Map<string, object>} wallLines - resolveWallLines の結果
 * @param {Map<string, object>|null} kneeDropOverlays - resolveKneeDropOverlays の結果
 * @returns {Array<{key:string, vertical:boolean, at:number, lo:number, hi:number, fillerMax:number}>}
 */
export function collectFinishLines(walls, wallLines, kneeDropOverlays) {
  const lines = [];
  for (const wall of walls) {
    if (wall.wallFinish == null) continue; // 仕上げ厚不明（手動壁）は仕上げ線を持たない
    if (kneeDropOverlays?.has(wall.id)) continue; // 腰壁・垂れ壁は矩形輪郭で描かれる
    const plan = wallLines.get(wall.id);
    if (!plan) continue;
    // 「埋めるために足された線分」と見なす長さの上限＝その壁の材幅（厚み）。角を埋める線分は
    // 原理的に材幅を超えない。妻線・木口線は定義上ちょうど材幅になる。
    const { lo: mLo, hi: mHi } = wall.materialRange;
    const fillerMax = mHi - mLo;
    // 線種が同じ線分どうしだけをまとめる（違う色・線幅・破線をまとめると見た目が変わる）。
    const styleKey = `${wall.color}|${wall.lineWeight}|${wall.lineType}`;
    const push = (key, vertical, at, lo, hi, mergeLo = lo, mergeHi = hi) =>
      lines.push({ key, vertical, at, lo, hi, mergeLo, mergeHi, fillerMax, styleKey });
    // 面線・内側線は壁と同じ向きに走る。
    plan.faceSegments.forEach(([lo, hi], i) =>
      push(`${wall.id}:face:${i}`, wall.isVertical, wall.axisValue, lo, hi));
    if (plan.finVisible) {
      plan.finSegments.forEach(([lo, hi], i) =>
        push(`${wall.id}:fin:${i}`, wall.isVertical, plan.finBoundary, lo, hi));
    }
    // 妻線・木口線は壁と**直交**する向きに走り、厚み方向の材の範囲いっぱいに引かれる。
    // 出隅では、これが相手壁の仕上げ線と同一直線に並んで1本の線を構成する。
    plan.capValues.forEach((v, i) =>
      push(`${wall.id}:cap:${i}`, !wall.isVertical, v, mLo, mHi));
    // 木口線だけは「まとめるときに使う区間」を**自壁の内側線まで**に切り詰める（ユーザー確定
    // 2026-09「案A」）。内側線どうしが取り合うのが仕上げ材の規則で、材幅いっぱいのまま採ると
    // まとめた内側線が相手の内側線を通り越して仕上げ面まで達する。描画そのもの（lo/hi）は
    // 材幅のまま——まとめられなかった木口線は従来どおり2重線の内側として全幅で描く。
    const finB = plan.finBoundary;
    const eLo = wall.faceDir > 0 ? mLo : finB;
    const eHi = wall.faceDir > 0 ? finB : mHi;
    plan.ecapValues.forEach((v, i) =>
      push(`${wall.id}:ecap:${i}`, !wall.isVertical, v, mLo, mHi, eLo, eHi));
  }
  return lines;
}
