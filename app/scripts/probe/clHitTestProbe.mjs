// CLヒットテスト・可視判定（描画可否）・参照候補（CL追加ダイアログ）・建具の相手
// （centerLineKindPolicy.js ステップ6「可視モード表への集約」）を実データで確認する probe
// （調査・回帰用。製品コードからは参照しない）。
//
// 対象（実アプリと同じ関数列。数字は本ステップの実装項目に対応）:
//   1. ヒットテスト（線上・端点・線間）: snap.js resolvePointerTargets が呼ぶ下位純関数
//      findNearestCenterLine／findNearestCenterLineEndpoint（src/snapGeometry.js）を、
//      resolvePointerTargets と同じ kindFilter = k => hitTestKinds(appMode).includes(k) で呼ぶ
//      （resolvePointerTargets 自体は store.js（spatialIndex）依存のため Node から直接呼べない——
//      ファイル冒頭の規約どおり、その下の純関数を同じ引数列で使う。clMoveRangeProbe.mjs と同じ流儀）。
//   2. 描画可否: renderer/CenterLinesLayer.jsx が使う isRenderTarget(cl, appMode)
//      （src/core/centerLineKindPolicy.js）をそのまま記録する——.jsx は実際に描画できないため、
//      「描くかどうか」の判断そのもの（呼び出し側が下していた判断）を記録する。
//   3. CL追加ダイアログの参照候補: App.jsx handleMenuSelect と同じ
//      findNearbyCenterLines(...).filter(cl => hitTestKinds(appMode).includes(centerLineKind(cl)))。
//   4. 建具: openings/openingMove.js openingMoveRange・openingSnapCandidates
//      （appMode を引数に取らない——floorplan/opening 起点の平面ドラッグにも展開図ドラッグにも
//      共通で使われるため。1回だけ計算する）。
//
// 【移行前後の突き合わせ方針（本体を書き換えず・git stash も使わない）】
// 本ステップで書き換えたのは各呼び出し元の「kindFilter/可視種別の求め方」であって、判定の下位関数
// （findNearestCenterLine／findNearestCenterLineEndpoint。ステップ6でsnap.js→snapGeometry.jsへ
// 抽出したのみでアルゴリズムは不変）そのものではない——findNearestCenterLine/findNearbyCenterLines は
// kindFilter を素直な引数として受けるため、旧来のインライン三項演算子（oldClKindFilter）をそのまま
// 渡せば「移行前の呼び出し元が実際に計算していたkindFilter」を寸分違わず再現できる。
// findNearestCenterLineEndpoint だけは通り芯除外が `cl.labeled`（移行前）→
// centerLineKindPolicy.spansEntireAxis（移行後、実質 kind==='struct'）に変わり、こちらはkindFilter
// 引数の外側（関数内部）の変更のため同じ手が使えない——ただし通常経路で作られるCLは
// `cl.labeled === (centerLineKind(cl)==='struct')` が常に成り立つ（centerLineKindKindPolicy.js
// 冒頭の「既知の乖離」節参照）ため、この不変条件を実データで確認できれば、移行後の関数を
// oldClKindFilter で呼んだ結果がそのまま「移行前の結果」と一致する（違反例が実データに無ければ
// 差分ゼロを保証できる）。renderTarget（CenterLinesLayer.jsx）・nearbyCandidates（App.jsx）は
// 旧ロジックをそのまま複写した比較関数（oldIsRenderTarget／oldNearbyKindOk）で計算する
// （このファイル内だけの複写——製品コードは参照しない）。
//
// 【検出力（狙った変異での差分の出方）】
// - HIT_EXCLUDED_KINDS_BY_MODE を空にする変異（構造モードで通り芯が拾われる）: hitTest（1）で
//   appMode='structure'・kind='struct' のレコードの hit 可否が変わる（beforeAfterDiffで検出）。
// - VISIBLE_KINDS_BY_MODE.floorplan に beam を足す変異: hitTest（1）・renderTarget（2）・
//   nearbyCandidates（3）いずれも appMode='floorplan'・kind='beam' のレコードで差分が出る。
// - 建具の障害集合（OPENING_BOUNDARY_KINDS）に aux を足す変異: openings（4）の moveRange が
//   aux CL の位置で縮む（oldIsBlockingKindとの比較で検出）。
//
// 【実データが踏まない経路（実測。summary.clKindCounts で裏取りできる）】
// - aux（補助線）CLは対象3本（moku2-5.stq・moku4.stq・13.stq）すべてで0本（実測:
//   summary.clKindCountsに'aux'キー自体が現れない＝0件。3本ともstruct/center/beamのみで構成される
//   ため——aux絡みの経路（hitTest/renderTarget/nearbyCandidates/openingsいずれも）は実データでは
//   一度も踏まれない。aux経路の保証は単体テスト（centerLineKindPolicy.test.js・snapGeometry.test.js・
//   openingMove.test.js の4種別横断テスト）のみに依る。
// - 13.stq は梁芯（beam）CLも0本——appMode='structure' の beam 関連レコードが13.stqでは
//   常に空（対象そのものが無い）。
// - 建具の有無・本数は各 .stq の構成に依存する——openings配列が空の階は openings セクションが空になる。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/clHitTestProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType, Discipline } from '../../src/core/constants.js';
import { APP_MODES, hitTestKinds, isRenderTarget, spansEntireAxis, isOpeningBoundaryKind, kindsVisibleIn } from '../../src/core/centerLineKindPolicy.js';
import {
  findNearestCenterLine, findNearestCenterLineEndpoint, findNearbyCenterLines, overhangMm,
} from '../../src/snapGeometry.js';
import { openingMoveRange, openingSnapCandidates } from '../../src/openings/openingMove.js';
import { findHostWall } from '../../src/openings/openingGeometry.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku2-5.stq';
const { project } = loadDocument(src);

// snap.js CL_THRESHOLD_PX／SNAP_THRESHOLD_PX と同値（snap.js自体はstore.js経由でlocalStorageに
// 触れるためNodeから直接importできない——値だけをここに複写する。clMoveRangeProbe.mjsと同じ流儀）。
const CL_THRESHOLD_PX = 8;
const SNAP_THRESHOLD_PX = 20;
// 実アプリの既定ズーム相当（viewport.js DEFAULT_PX_PER_MM=96/25.4、scaleDenominator=100）。
const DEFAULT_PX_PER_MM = 96 / 25.4;
const SCALE = DEFAULT_PX_PER_MM / 100;
const VIEWPORT = { scaleDenominator: 100 };

// ---- 移行前ロジックの複写（このファイル内専用。製品コードは参照しない）----
// snap.js resolvePointerTargets（移行前）: appMode==='structure'なら梁芯のみ、それ以外は梁芯以外。
function oldClKindFilter(appMode) {
  return appMode === 'structure' ? (k => k === 'beam') : (k => k !== 'beam');
}
// renderer/CenterLinesLayer.jsx（移行前、L61-68相当）。
function oldIsRenderTarget(cl, appMode) {
  const kind = centerLineKind(cl);
  if (kind === 'beam' && appMode !== 'structure') return false;
  const isArchCL = !cl.labeled && cl.discipline === Discipline.ARCH;
  if (isArchCL && appMode === 'structure') return false;
  return true;
}
// App.jsx handleMenuSelect（移行前）: appMode==='structure' ? kind==='beam' : kind!=='beam'。
function oldNearbyKindOk(kind, appMode) {
  return appMode === 'structure' ? kind === 'beam' : kind !== 'beam';
}
// openings/openingMove.js isBlockingKind（移行前・移行後とも同じ集合。差分ゼロを確認する対照用）。
function oldIsBlockingKind(kind) { return kind === 'struct' || kind === 'center'; }
// openings/openingMove.js openingSnapCandidates（移行前）: 梁芯だけを除外。
function oldOpeningSnapKindOk(kind) { return kind !== 'beam'; }

function describeCL(cl) {
  return cl ? { id: cl.id, kind: centerLineKind(cl), centerLineType: cl.centerLineType, value: Math.round(cl.value) } : null;
}
// hitTest結果の要約（id/kindのみ。座標はqueryのdescribeCLと突き合わせれば十分なため省く）。
function describeHit(cl) {
  return cl ? { id: cl.id, kind: centerLineKind(cl) } : null;
}
function hitEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.id === b.id;
}

// CLごとの代表「沿線(along)」座標: extentLo/Hiがあれば中点、無ければ0（struct等）。
function representativeAlong(cl) {
  return cl.extentLo != null && cl.extentHi != null ? Math.round((cl.extentLo + cl.extentHi) / 2) : 0;
}
function worldOf(cl, along) {
  const isV = cl.centerLineType === CenterLineType.VERTICAL;
  return isV ? { wx: cl.value, wy: along } : { wx: along, wy: cl.value };
}

const results = { hitTest: [], renderTarget: [], nearbyCandidates: [], openings: [] };
const kindCounts = {};
const diffCounts = {}; // `${recordType}:${appMode}` -> 差分件数
const bump = (key) => { diffCounts[key] = (diffCounts[key] ?? 0) + 1; };

// 「labeled と種別が一致する」不変条件（centerLineKindPolicy.js既知の乖離節）の実データ確認。
// 違反が無ければ、findNearestCenterLineEndpoint を oldClKindFilter で呼んだ結果がそのまま
// 「移行前(cl.labeledベース)の結果」と一致する（本ファイル冒頭コメント参照）。
const labeledKindMismatches = [];

for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;

  // struct（通り芯）は project.structGraph が全階共通で持つため、graph.centerLines のgetterが
  // structGraph.centerLines を合成して返す実装を前提にする（PlanGraph参照）。合成していなければ
  // 下のsummary.clKindCounts.structが0件になり実出力で気づける。
  const allCLs = graph.centerLines.filter(cl => cl.centerLineType !== CenterLineType.RADIAL);
  for (const cl of allCLs) {
    const kind = centerLineKind(cl);
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    if (!!cl.labeled !== (kind === 'struct')) {
      labeledKindMismatches.push({ plane: plane.name, id: cl.id, kind, labeled: cl.labeled });
    }
  }

  // 軸ごとにvalue昇順ソート（「線間」クエリ点の構成に使う）。
  const byAxis = { [CenterLineType.VERTICAL]: [], [CenterLineType.HORIZONTAL]: [] };
  for (const cl of allCLs) byAxis[cl.centerLineType]?.push(cl);
  for (const arr of Object.values(byAxis)) arr.sort((a, b) => a.value - b.value);

  for (const appMode of APP_MODES) {
    const newFilter = k => hitTestKinds(appMode).includes(k);
    const oldFilter = oldClKindFilter(appMode);

    // ---- 1. ヒットテスト（線上）----
    for (const cl of allCLs) {
      const { wx, wy } = worldOf(cl, representativeAlong(cl));
      const after = findNearestCenterLine(graph, wx, wy, CL_THRESHOLD_PX, SCALE, SCALE, VIEWPORT, newFilter);
      const before = findNearestCenterLine(graph, wx, wy, CL_THRESHOLD_PX, SCALE, SCALE, VIEWPORT, oldFilter);
      const changed = !hitEqual(before, after);
      if (changed) bump(`hitTest.line:${appMode}`);
      results.hitTest.push({
        plane: plane.name, appMode, queryType: 'line',
        query: describeCL(cl), before: describeHit(before), after: describeHit(after), changed,
      });
    }

    // ---- 1. ヒットテスト（端点。非struct・extentLo/Hi確定済みのみ）----
    for (const cl of allCLs) {
      if (cl.labeled || cl.extentLo == null || cl.extentHi == null) continue;
      const isV = cl.centerLineType === CenterLineType.VERTICAL;
      const overhang = overhangMm(VIEWPORT, cl.trim);
      for (const [side, along] of [['lo', cl.extentLo - overhang], ['hi', cl.extentHi + overhang]]) {
        const wx = isV ? cl.value : along;
        const wy = isV ? along : cl.value;
        const after = findNearestCenterLineEndpoint(graph, wx, wy, CL_THRESHOLD_PX, SCALE, SCALE, VIEWPORT, newFilter);
        // before: 通り芯除外は cl.labeled ベース（移行前）——上の不変条件が実データで成り立つ限り、
        // 現行関数（spansEntireAxisベース）を oldFilter で呼んだ結果と等しいはず（ファイル冒頭コメント）。
        const before = findNearestCenterLineEndpoint(graph, wx, wy, CL_THRESHOLD_PX, SCALE, SCALE, VIEWPORT, oldFilter);
        const beforeCl = before?.cl ?? null, afterCl = after?.cl ?? null;
        const changed = !hitEqual(beforeCl, afterCl) || (before?.side ?? null) !== (after?.side ?? null);
        if (changed) bump(`hitTest.endpoint-${side}:${appMode}`);
        results.hitTest.push({
          plane: plane.name, appMode, queryType: `endpoint-${side}`,
          query: describeCL(cl),
          before: beforeCl ? { id: beforeCl.id, kind: centerLineKind(beforeCl), side: before.side } : null,
          after: afterCl ? { id: afterCl.id, kind: centerLineKind(afterCl), side: after.side } : null,
          changed,
        });
      }
    }

    // ---- 1. ヒットテスト（線間。同軸で隣接するCLペアの中点）----
    for (const arr of Object.values(byAxis)) {
      for (let i = 0; i + 1 < arr.length; i++) {
        const a = arr[i], b = arr[i + 1];
        const mid = (a.value + b.value) / 2;
        const isV = a.centerLineType === CenterLineType.VERTICAL;
        const wx = isV ? mid : 0;
        const wy = isV ? 0 : mid;
        const after = findNearestCenterLine(graph, wx, wy, CL_THRESHOLD_PX, SCALE, SCALE, VIEWPORT, newFilter);
        const before = findNearestCenterLine(graph, wx, wy, CL_THRESHOLD_PX, SCALE, SCALE, VIEWPORT, oldFilter);
        const changed = !hitEqual(before, after);
        if (changed) bump(`hitTest.between:${appMode}`);
        results.hitTest.push({
          plane: plane.name, appMode, queryType: 'between',
          query: { centerLineType: a.centerLineType, between: [describeCL(a), describeCL(b)], mid: Math.round(mid) },
          before: describeHit(before), after: describeHit(after), changed,
        });
      }
    }

    // ---- 2. 描画可否 ----
    for (const cl of allCLs) {
      const after = isRenderTarget(cl, appMode);
      const before = oldIsRenderTarget(cl, appMode);
      const changed = before !== after;
      if (changed) bump(`renderTarget:${appMode}`);
      results.renderTarget.push({ plane: plane.name, appMode, query: describeCL(cl), before, after, changed });
    }

    // ---- 3. CL追加ダイアログの参照候補（App.jsx handleMenuSelect と同じ関数列） ----
    for (const cl of allCLs) {
      const { wx, wy } = worldOf(cl, representativeAlong(cl));
      const rawNearby = findNearbyCenterLines(graph, wx, wy, SNAP_THRESHOLD_PX * 2, SCALE, SCALE, cl.centerLineType);
      const after = rawNearby.filter(c => hitTestKinds(appMode).includes(centerLineKind(c)));
      const before = rawNearby.filter(c => oldNearbyKindOk(centerLineKind(c), appMode));
      const afterIds = after.map(c => c.id).sort().join(',');
      const beforeIds = before.map(c => c.id).sort().join(',');
      const changed = afterIds !== beforeIds;
      if (changed) bump(`nearbyCandidates:${appMode}`);
      results.nearbyCandidates.push({
        plane: plane.name, appMode, query: describeCL(cl),
        before: before.map(describeCL), after: after.map(describeCL), changed,
      });
    }
  }

  // ---- 4. 建具（appMode非依存。1回だけ計算） ----
  for (const o of graph.openings ?? []) {
    const wall = findHostWall(o, graph);
    if (!wall) { results.openings.push({ plane: plane.name, openingId: o.id, hostWall: null }); continue; }
    const range = openingMoveRange(wall, o, graph); // 現行実装＝after（isBlockingKind経由）
    const candidates = range ? openingSnapCandidates(wall, o, graph, range) : [];
    // isBlockingKindの前後差分を対照的に確認する（openingMoveRangeの計算式自体は変えていないため、
    // ここでは「同じCL集合に対してold/newのisBlockingKind判定が食い違う本数」を数える）。
    let blockingKindDiff = 0;
    for (const cl of allCLs) {
      const kind = centerLineKind(cl);
      if (oldIsBlockingKind(kind) !== isOpeningBoundaryKind(kind)) blockingKindDiff++;
    }
    if (blockingKindDiff > 0) bump('openings.isBlockingKind');
    let snapKindDiff = 0;
    const floorplanKinds = kindsVisibleIn('floorplan');
    for (const cl of allCLs) {
      const kind = centerLineKind(cl);
      if (oldOpeningSnapKindOk(kind) !== floorplanKinds.includes(kind)) snapKindDiff++;
    }
    if (snapKindDiff > 0) bump('openings.snapKind');
    const kindOfCandidate = c => (c.cl ? centerLineKind(c.cl) : c.kind);
    const byKind = {};
    for (const c of candidates) { const k = kindOfCandidate(c); byKind[k] = (byKind[k] ?? 0) + 1; }
    results.openings.push({
      plane: plane.name, openingId: o.id, wallId: wall.id,
      moveRange: range ? { min: Math.round(range.min), max: Math.round(range.max) } : null,
      snapCandidateCount: candidates.length,
      snapCandidateKindCounts: byKind,
      isBlockingKindDiffCount: blockingKindDiff,
      snapKindDiffCount: snapKindDiff,
    });
  }
}

console.log(JSON.stringify({
  summary: {
    src,
    planeCount: project.planes.length,
    clKindCounts: kindCounts,
    openingCount: results.openings.length,
    hitTestRecordCount: results.hitTest.length,
    renderTargetRecordCount: results.renderTarget.length,
    nearbyCandidateRecordCount: results.nearbyCandidates.length,
    labeledKindInvariantViolations: labeledKindMismatches, // 空配列なら不変条件成立（本ファイル冒頭コメントの前提が成立）
    diffCounts, // キー "recordType:appMode" -> before/after が食い違ったレコード数（0が期待値。site/elevationのみ非0を許容）
  },
  ...results,
}, null, 2));
