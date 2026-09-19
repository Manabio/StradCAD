// CL（中心線・補助線・通り芯・梁芯）に関する純粋なジオメトリ計算のうち、spatialIndex/store に
// 依存しないもの。snap.js から分離した理由: snap.js は './store.js'（spatialIndex）を静的 import
// しており、その連鎖で localStorage 等ブラウザ専有APIに触れるため node:test 単体では import できない
// （transform/centerLineOps.js 等、graph実体のみで完結する純関数を node:test から直接検証したいモジュールが
// これらの関数を必要とするケースがある）。snap.js は本モジュールを import して同名を再エクスポートし、
// 既存の import 元（App.jsx・CenterLinesLayer.jsx 等）を壊さない。
import { CenterLineType, DimensionKind, DimensionSide, centerLineKind } from './core.js';
import { isMoveSnapTarget, sameDirectionObstacles, spansEntireAxis } from './core/centerLineKindPolicy.js';

// 中心線の端のはね出し量 (mm)。区分線形:
//   denom <  BASE_DENOM         : (LOW_DENOM, LOW_MM) → (BASE_DENOM, BASE_MM) の直線
//   BASE_DENOM ≤ denom ≤ ZERO_DENOM: (BASE_DENOM, BASE_MM) → (ZERO_DENOM, 0) の直線
//   denom >  ZERO_DENOM         : 0
const OVERHANG_LOW_DENOM  = 50;
const OVERHANG_LOW_MM     = 200;
const OVERHANG_BASE_DENOM = 100;
const OVERHANG_BASE_MM    = 300;
const OVERHANG_ZERO_DENOM = 500;
export function overhangMm(viewport, trim) {
  if (trim) return 0;
  const denom = viewport.scaleDenominator;
  if (denom >= OVERHANG_ZERO_DENOM) return 0;
  if (denom >= OVERHANG_BASE_DENOM) {
    const t = (denom - OVERHANG_BASE_DENOM) / (OVERHANG_ZERO_DENOM - OVERHANG_BASE_DENOM);
    return OVERHANG_BASE_MM * (1 - t);
  }
  const t = (denom - OVERHANG_LOW_DENOM) / (OVERHANG_BASE_DENOM - OVERHANG_LOW_DENOM);
  return Math.max(0, OVERHANG_LOW_MM + (OVERHANG_BASE_MM - OVERHANG_LOW_MM) * t);
}

/**
 * coord を挟む CL ペアを返す。
 */
export function findBracketingCLs(cls, coord) {
  let lo = null, hi = null;
  let loDist = Infinity, hiDist = Infinity;
  for (const cl of cls) {
    const d = cl.value - coord;
    if (d <= 0 && -d < loDist) { loDist = -d; lo = cl; }
    if (d > 0  && d  < hiDist) { hiDist = d;  hi = cl; }
  }
  return [lo, hi];
}

// ----------------------------------------------------------------
// 中心線移動中のスナップ値計算（findCLMoveSnap・findBeamAxisMoveSnap）。
// spatialIndex/store に依存しない純関数のため snap.js から分離（ファイル冒頭コメント参照）。
// ----------------------------------------------------------------

/**
 * 中心線移動中、同種の他中心線へのスナップ値を返す（平面モードの通り芯・中心線・補助線が対象）。
 * 吸着先は centerLineKindPolicy.isMoveSnapTarget（moveSnapTargetKindsベース。障害物集合とは別の
 * 関係）——moving が struct でも梁芯へは吸着しない（moveSnapTargetKinds('struct') は 'beam' を
 * 含まない。障害物集合 sameDirectionObstacleKinds('struct') は 'beam' を含むため流用不可）。
 * moveSnapTargetKinds の導出は VISIBLE_KINDS_BY_MODE に連動する——site/elevation のヒットを有効化
 * するには可視表（VISIBLE_KINDS_BY_MODE）を非空にする必要があり、その時点で吸着先も自動的に広がる
 * （吸着先だけを個別に拡張することはできない設計）。梁芯の移動は専用の findBeamAxisMoveSnap を使う
 * （呼び出し元 interaction/usePointerInteraction.js の updatePointer が
 * `appMode === 'structure' && centerLineKind(cl) === 'beam'` で呼び分ける——appMode==='structure'
 * かつ梁芯のときのみ findBeamAxisMoveSnap、それ以外は本関数）。
 */
export function findCLMoveSnap(graph, movingCL, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  const isV   = movingCL.centerLineType === CenterLineType.VERTICAL;
  const scale = isV ? scaleX : scaleY;
  const coord = isV ? wx : wy;
  let best = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (cl.id === movingCL.id || cl.centerLineType !== movingCL.centerLineType) continue;
    if (!isMoveSnapTarget(movingCL, cl)) continue;
    const dist = Math.abs(cl.value - coord) * scale;
    if (dist < thresholdPx && dist < minDist) { minDist = dist; best = cl.value; }
  }
  return best;
}

/**
 * 梁芯CL（centerLineKind==='beam'）移動中のスナップ値を返す。findCLMoveSnap と違い通り芯・他の梁芯の
 * 値そのものへは吸着しない（beamAxisMoveRange が到達不能にしている禁止位置のため）。吸着先は「両隣の
 * 障害物（通り芯・他の梁芯）に挟まれた区間」の中点・3等分点（1/3, 2/3）——「大梁間の中央に小梁1本」
 * 「小梁2本を等間隔」という実務上よくある配置。障害物の定義は structural/beamAxisMove.js の
 * beamAxisMoveRange と同じ centerLineKindPolicy.sameDirectionObstacles（'beam'→通り芯・他の梁芯のみ）
 * を共有する（ポリシーは core/ に置くことで、snap.js/structural/ 双方から参照でき「レイヤ分離のため
 * 独立実装」だった重複が解消済み）。中心線・補助線（labeled:falseの通常CL）とは同位置に到達し得るが、
 * 小梁の生成はhost（大梁の有無）だけで決まるため実害はない（beamAxisMoveRange参照）。
 * 等ピッチスナップ（3本以上）・複数梁芯の一括移動は次フェーズ（.claude/structural-model.md参照）。
 */
export function findBeamAxisMoveSnap(graph, movingCL, wx, wy, thresholdPx, scaleX, scaleY) {
  if (!graph) return null;
  const isV   = movingCL.centerLineType === CenterLineType.VERTICAL;
  const scale = isV ? scaleX : scaleY;
  const coord = isV ? wx : wy;
  let lo = -Infinity, hi = Infinity;
  for (const other of sameDirectionObstacles(graph, movingCL)) {
    const v = other.effectiveValue;
    if (v < movingCL.value) { if (v > lo) lo = v; }
    else if (v > movingCL.value) { if (v < hi) hi = v; }
  }
  if (lo === -Infinity || hi === Infinity) return null; // 片側に障害物が無ければ中点・3等分点は定義できない
  const candidates = [(lo + hi) / 2, lo + (hi - lo) / 3, lo + (hi - lo) * 2 / 3];
  let best = null, minDist = Infinity;
  for (const v of candidates) {
    const dist = Math.abs(v - coord) * scale;
    if (dist < thresholdPx && dist < minDist) { minDist = dist; best = v; }
  }
  return best;
}

// ----------------------------------------------------------------
// CLのポインタヒット判定（線上・端点）。
// spatialIndex/store に依存しない純関数のため snap.js から分離（ファイル冒頭コメント参照）。
// ----------------------------------------------------------------

/**
 * カーソルに最も近い中心線を返す。
 * VERTICAL  → X 方向スクリーン距離
 * HORIZONTAL → Y 方向スクリーン距離
 * viewport を渡すと、ラベルなしCLの描画範囲（オーバーハング込み）外を除外する。
 * kindFilter(centerLineKind(cl)) が true の種別だけを対象にする（既定は梁芯を除外＝非構造モード用。
 * 構造モードの呼び出し元は `k => k === 'beam'` を渡し、梁芯だけをヒットテスト対象にする——
 * 「通り芯上でマウスが反応しない」既存仕様は維持しつつ、梁芯だけは選択・削除・延長/短縮できるようにする
 * ため appMode で無条件 null にせず kindFilter で絞る（interaction/usePointerInteraction.js updateSnap 参照）。
 * 呼び出し元 snap.js resolvePointerTargets は kindFilter を centerLineKindPolicy.hitTestKinds(appMode)
 * から導出する（k => hitTestKinds(appMode).includes(k)）。
 */
export function findNearestCenterLine(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport = null, kindFilter = k => k !== 'beam') {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (!kindFilter(centerLineKind(cl))) continue;
    const isV  = cl.centerLineType === CenterLineType.VERTICAL;
    const isH  = cl.centerLineType === CenterLineType.HORIZONTAL;
    const dist = isV ? Math.abs(cl.value - wx) * scaleX
               : isH ? Math.abs(cl.value - wy) * scaleY
               : Infinity;
    if (dist >= thresholdPx || dist >= minDist) continue;
    // ラベルなしCL: extentLo/Hi が設定されていれば描画範囲（オーバーハング込み）外を除外
    if (!cl.labeled && cl.extentLo != null && cl.extentHi != null) {
      const along    = isV ? wy : wx;
      const overhang = viewport ? overhangMm(viewport, cl.trim) : 0;
      if (along < cl.extentLo - overhang || along > cl.extentHi + overhang) continue;
    }
    minDist = dist;
    nearest = cl;
  }
  return nearest;
}

/**
 * 長押し位置に近接する中心線（ラベルなし）を参照元候補として返す。
 * - clType を渡すと同種CLのみ（線分追加）。null なら垂直/水平両方（壁追加）。
 * - はね出し（オーバーハング）部分は除外: 沿線座標が実範囲 [extentLo, extentHi] 内のCLのみ。
 * - スクリーン距離が近い順にソート。
 * 呼び出し元 App.jsx handleMenuSelect は、戻り値をさらに centerLineKindPolicy.hitTestKinds(appMode)
 * で絞る（本関数自体は種別を問わず「ラベルなし＝非通り芯」全部を対象にする。ファイル冒頭コメント・
 * core/centerLineKindPolicy.js の既知の乖離節も参照——本関数の `cl.labeled` 除外は種別条件の無い
 * 「labeled以外＝aux/center/beam全部」の除外で、本ステップの移行対象外）。
 */
export function findNearbyCenterLines(graph, wx, wy, thresholdPx, scaleX, scaleY, clType = null) {
  if (!graph) return [];
  const hits = [];
  for (const cl of graph.centerLines) {
    if (cl.labeled) continue;
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
    if (!isV && !isH) continue;
    if (clType && cl.centerLineType !== clType) continue;
    const scale = isV ? scaleX : scaleY;
    const perp  = isV ? wx : wy;  // 線に垂直な座標
    const along = isV ? wy : wx;  // 線に沿った座標
    const dist  = Math.abs(cl.value - perp) * scale;
    if (dist >= thresholdPx) continue;
    // はね出し除外: 沿線座標が実範囲外なら候補から外す
    if (cl.extentLo != null && cl.extentHi != null &&
        (along < cl.extentLo || along > cl.extentHi)) continue;
    hits.push({ cl, dist });
  }
  return hits.sort((a, b) => a.dist - b.dist).map(h => h.cl);
}

// ----------------------------------------------------------------
// CENTER寸法（中心線寸法）「到達」判定・非ラベルCLの描画延伸範囲。
// renderer/CenterLinesLayer.jsx の clExtent（非labeled分岐）と renderer/GutterLayer.jsx の
// buildRowAnchors（centerBoundary到達判定）が使う純ロジックをここへ集約する。
// findNearestCenterLineEndpoint（下記）が「外寸法側のはね出し線分」を同じ基準で判定するため、
// および node:test から実PlanGraphで検証するため。
// ----------------------------------------------------------------

/**
 * 中心線・補助線（labeled:false）の描画延伸範囲 [lo, hi] を返す（オーバーハング込み）。
 * renderer/CenterLinesLayer.jsx の clExtent は、これに labeled:true 分岐（ガター座標=width/height
 * 依存のため純関数化できない）を足したもの——重複実装を避けるため clExtent 側はこの関数へ委譲する。
 * extentLo/Hi 未確定の古いデータは labeled 直交CLのmin/maxへフォールバックする（clExtentと同じ挙動）。
 */
export function nonLabeledClExtent(cl, graph, viewport) {
  const isV      = cl.centerLineType === CenterLineType.VERTICAL;
  const perpType = isV ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const overhang = overhangMm(viewport, cl.trim);
  if (cl.extentLo == null || cl.extentHi == null) {
    const vals = graph.centerLines
      .filter(p => p.centerLineType === perpType && p.labeled)
      .map(p => p.effectiveValue);
    if (vals.length === 0) return null;
    return [Math.min(...vals) - overhang, Math.max(...vals) + overhang];
  }
  return [cl.extentLo - overhang, cl.extentHi + overhang];
}

/**
 * 非ラベルCL（中心線・補助線・梁芯）の side端（'lo'|'hi'）が、直交方向の最外通り芯
 * （CENTER寸法の基準＝DimensionLine.centerBoundary）へ「到達」しているか。
 * renderer/GutterLayer.jsx buildRowAnchors の到達判定（ext[0] <= boundary <= ext[1]）と
 * 同じ基準を再利用する（別基準を発明しない）。
 * side='lo'（extentLo・Y/X座標の小さい側）はTOP(isV)/LEFT(isH)行、side='hi'（extentHi・大きい側）は
 * BOTTOM(isV)/RIGHT(isH)行に対応する（y軸下向き正）。
 * 対応するCENTER寸法行（4行）が graph に無い場合・直交グリッドが無い場合は false（到達なし扱い）。
 */
export function clSideReachesCenterBoundary(cl, side, graph, viewport) {
  const isV = cl.centerLineType === CenterLineType.VERTICAL;
  const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
  if (!isV && !isH) return false;
  const dimSide = isV
    ? (side === 'lo' ? DimensionSide.TOP  : DimensionSide.BOTTOM)
    : (side === 'lo' ? DimensionSide.LEFT : DimensionSide.RIGHT);
  const row = graph.dimensionLines.find(d => d.dimensionKind === DimensionKind.CENTER && d.side === dimSide);
  const boundary = row?.centerBoundary;
  if (boundary == null) return false;
  const ext = nonLabeledClExtent(cl, graph, viewport);
  return !!ext && ext[0] <= boundary && boundary <= ext[1];
}

/**
 * カーソルに最も近い、非ラベルCL（中心・補助線・梁芯）の端点を返す（延長/短縮メニュー用）。
 * ヒット域は2種類:
 *   1) 突端（extentLo-overhang / extentHi+overhang）の8px円——到達可否に関わらず常時（従来どおり）。
 *   2) 外寸法側のはね出し線分上（extent〜突端。clSideReachesCenterBoundary が true の側のみ）——
 *      垂直距離判定は findNearestCenterLine の線上ヒットと同じ式。到達していない側・extent内側の
 *      線上ヒットは変更しない（findNearestCenterLine 側の挙動のまま）。
 * 通り芯・RADIAL・extentLo/Hi未確定のCLは対象外。通り芯の除外は種別ベース
 * （centerLineKindPolicy.spansEntireAxis。通り芯は常に全軸に及び「延長/短縮する端」という概念自体を
 * 持たないため——FULL_SPAN_KINDS=['struct']）——2026-09-20移行前は生の `cl.labeled` を見ていたが、
 * 通常経路で作られるCLは labeled と種別が必ず一致する（通り芯のみ labeled:true）ため実害は無い。
 * 既知の乖離（旧データ限定）: `{labeled:true, discipline:'arch'}` のような旧データ（centerLineKindは
 * 'center'）は、移行前は `cl.labeled` により対象外だったが、移行後は種別ベースのため対象になりうる
 * （centerLineKindPolicy.test.js／snapGeometry.test.js の該当ピン留めテスト参照）。
 * kindFilterは findNearestCenterLine と同じ規約（既定は梁芯を除外、構造モードは `k => k === 'beam'` で
 * 梁芯だけに絞る。呼び出し元 snap.js resolvePointerTargets は centerLineKindPolicy.hitTestKinds(appMode)
 * から導出する）。
 * @returns {{cl, side:'lo'|'hi'}|null}
 */
export function findNearestCenterLineEndpoint(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport, kindFilter = k => k !== 'beam') {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (spansEntireAxis(centerLineKind(cl)) || !kindFilter(centerLineKind(cl))) continue;
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
    if (!isV && !isH) continue;
    if (cl.extentLo == null || cl.extentHi == null) continue;
    const overhang = overhangMm(viewport, cl.trim);

    // 1) 突端の8px円判定（従来どおり）
    const tips = [
      { side: 'lo', along: cl.extentLo - overhang },
      { side: 'hi', along: cl.extentHi + overhang },
    ];
    for (const { side, along } of tips) {
      const tx = isV ? cl.value : along;
      const ty = isV ? along    : cl.value;
      const dist = Math.hypot((tx - wx) * scaleX, (ty - wy) * scaleY);
      if (dist < thresholdPx && dist < minDist) { minDist = dist; nearest = { cl, side }; }
    }

    // 2) 外寸法側のはね出し線分上（extent〜突端）。
    // along===extentLo/extentHi ちょうど（extent内側の線上ヒットとの境界点）は意図的にこちら
    // （端点ラジアル）側に含める——lo/hiの範囲を [extentLo, extentHi] のように閉区間で取るため。
    if (overhang > 0) {
      const perp = isV ? Math.abs(cl.value - wx) * scaleX : Math.abs(cl.value - wy) * scaleY;
      if (perp < thresholdPx && perp < minDist) {
        const along = isV ? wy : wx;
        const segs = [
          { side: 'lo', lo: cl.extentLo - overhang, hi: cl.extentLo },
          { side: 'hi', lo: cl.extentHi,             hi: cl.extentHi + overhang },
        ];
        for (const { side, lo, hi } of segs) {
          if (along < lo || along > hi) continue;
          if (!clSideReachesCenterBoundary(cl, side, graph, viewport)) continue;
          minDist = perp; nearest = { cl, side };
        }
      }
    }
  }
  return nearest;
}
