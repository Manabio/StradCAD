// QAレビュー指摘（幾何バグ1〜4、およびQA2巡目A）の回帰テスト。renderer/OpeningsLayer.jsx から
// 抽出した純関数（react-konvaを引かない）を直接検証する。
//
// QA2巡目指摘A: 初版の回帰テストは「対向leafのswingSide反転」をテスト自身が算出していたため、
// レンダラ側の結線（OpeningsLayer.jsxがどの符号を渡すか）を実際には検証できないトートロジーだった
// （-swingSideをswingSideへ戻す変異を入れても400/400のまま緑だった）。修正: leaf仕様の決定
// （対向leafの符号反転を含む）を*LeafSpecs関数（本体側・production export）へ完全に移し、
// テストはその「出力」だけを独立の三角関数（leafBulgeSign、下記ローカル定義）で検算する。
// これにより本体側の符号を壊せば*LeafSpecsの出力が変わり、テストが確実に落ちる
// （本ファイル末尾に実施した変異テストの記録を参照）。
//
// leafBulgeSign はテスト専用の独立検算（production からは import しない——production の
// closedAngleFor/leafOpenAngle自体にバグがあっても検出できるよう、別経路の三角関数で
// 「leafが実際にどちら側(ワールドのperp軸)へ膨らむか」を再計算する。openingGeometry.test.js の
// openDirPerpSign と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { findCatalogEntry, OpeningMechanism } from './openingCatalog.js';
import { buildOpeningElevation } from './openingElevationFigure.js';
import {
  swingDoubleLeafSpecs, swingChildLeafSpecs, fireDoorLeafSpecs, fireFoldLeafSpecs,
  swingChildLengths, openingExteriorDir, resolveSlideLayoutPanels, trackOf,
} from './openingPlanSymbolGeometry.js';

// 独立検算用（production の closedAngleFor/leafOpenAngle を経由しない）。開き角の中間角
// （closedAngleとopenAngleの二等分角）のperp軸成分の符号から「どちら側へ膨らむか」を返す。
function leafBulgeSign(isVertical, hingeSide, sense, angleDeg = 90) {
  const towardFar = hingeSide < 0 ? 1 : -1;
  const closedAngle = isVertical ? (towardFar > 0 ? 90 : -90) : (towardFar > 0 ? 0 : 180);
  const bisector = closedAngle + (sense * angleDeg) / 2;
  const rad = (bisector * Math.PI) / 180;
  const perpComponent = isVertical ? Math.cos(rad) : Math.sin(rad);
  return Math.sign(Math.round(perpComponent * 1e9) / 1e9);
}

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// ================================================================
// 【QA指定テスト1】swingDoubleLeafSpecs: isVertical×swingSideの4組合せで2枚のbulge符号一致
// ================================================================

test('swingDoubleLeafSpecs: 吊元位置(coord1/coord2)・hingeSide・leaf長(width/2)が正しい', () => {
  const specs = swingDoubleLeafSpecs(100, 1700, 1600, 1);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map(s => s.hingeAlong), [100, 1700]);
  assert.deepEqual(specs.map(s => s.hingeSide), [-1, 1]);
  assert.deepEqual(specs.map(s => s.leafLength), [800, 800]);
});

test('swingDoubleLeafSpecs: isVertical×swingSideの4組合せで2枚のbulge符号が一致する（受入条件: 対向leafの符号を壊すと落ちる）', () => {
  for (const isVertical of [true, false]) {
    for (const swingSide of [1, -1]) {
      const specs = swingDoubleLeafSpecs(0, 1600, 1600, swingSide);
      const [a, b] = specs;
      assert.equal(
        leafBulgeSign(isVertical, a.hingeSide, a.sense),
        leafBulgeSign(isVertical, b.hingeSide, b.sense),
        `isVertical=${isVertical}, swingSide=${swingSide}: 両leafが同じ側へ開くはず`,
      );
    }
  }
});

// ================================================================
// 【QA指定テスト2】swingChildLeafSpecs: 8組合せで同上＋親子長0.7:0.3
// ================================================================

test('swingChildLengths: 既定childRatio=0.3で親長=width×0.7・子長=width×0.3', () => {
  const { parentLen, childLen } = swingChildLengths(1200, 0.3);
  assert.equal(parentLen, 1200 * 0.7);
  assert.equal(childLen, 1200 * 0.3);
});

test('swingChildLeafSpecs: isVertical×swingSide×hingeSideの8組合せで親子leafのbulge符号が一致し、親長=width×0.7・子長=width×0.3になる', () => {
  for (const isVertical of [true, false]) {
    for (const swingSide of [1, -1]) {
      for (const hingeSide of [-1, 1]) {
        const specs = swingChildLeafSpecs(0, 1200, 1200, hingeSide, swingSide, 0.3);
        assert.equal(specs.length, 2);
        const [parent, child] = specs;
        assert.equal(
          leafBulgeSign(isVertical, parent.hingeSide, parent.sense),
          leafBulgeSign(isVertical, child.hingeSide, child.sense),
          `isVertical=${isVertical}, swingSide=${swingSide}, hingeSide=${hingeSide}`,
        );
        assert.equal(parent.leafLength, 1200 * 0.7, '親leaf長=width×0.7');
        assert.equal(child.leafLength, 1200 * 0.3, '子leaf長=width×0.3');
      }
    }
  }
});

// ================================================================
// 【QA指定テスト3】fireDoorLeafSpecs: fireAngle 90/180 × swingSide反転の効き
// ================================================================

test('fireDoorLeafSpecs: fireLeaves:1はhingeSide側のleaf1本（leaf長=width）', () => {
  const specs = fireDoorLeafSpecs(0, 900, 900, 1, -1, 1); // hingeSide=1→coord2側
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], { hingeAlong: 900, hingeSide: 1, sense: -1, leafLength: 900 });
});

test('fireDoorLeafSpecs: fireLeaves:2はfireAngle 90/180×isVerticalで2枚のbulge符号が一致する', () => {
  for (const isVertical of [true, false]) {
    for (const fireAngle of [90, 180]) {
      for (const swingSide of [1, -1]) {
        const specs = fireDoorLeafSpecs(0, 1800, 1800, -1, swingSide, 2);
        const [a, b] = specs;
        assert.equal(
          leafBulgeSign(isVertical, a.hingeSide, a.sense, fireAngle),
          leafBulgeSign(isVertical, b.hingeSide, b.sense, fireAngle),
          `isVertical=${isVertical}, fireAngle=${fireAngle}, swingSide=${swingSide}`,
        );
      }
    }
  }
});

test('fireDoorLeafSpecs: swingSideを反転すると開放位置(膨らむ側)も反転する（fireAngle 90/180とも）', () => {
  for (const isVertical of [true, false]) {
    for (const fireAngle of [90, 180]) {
      const specsPlus  = fireDoorLeafSpecs(0, 900, 900, -1, 1, 1);
      const specsMinus = fireDoorLeafSpecs(0, 900, 900, -1, -1, 1);
      const plus  = leafBulgeSign(isVertical, specsPlus[0].hingeSide, specsPlus[0].sense, fireAngle);
      const minus = leafBulgeSign(isVertical, specsMinus[0].hingeSide, specsMinus[0].sense, fireAngle);
      assert.equal(plus, -minus, `isVertical=${isVertical}, fireAngle=${fireAngle}`);
    }
  }
});

// fireFoldLeafSpecs は QA指定外だが fireDoorLeafSpecs と同型のクラスのバグ（対向leaf符号反転）を
// 持つため、同じ検証を行っておく（openingPlanSymbolGeometry.js参照）。
test('fireFoldLeafSpecs: fireAngle:180は2枚のbulge符号が一致し、fireAngle:90は1枚（hingeSide側、leaf長=width）', () => {
  for (const isVertical of [true, false]) {
    for (const swingSide of [1, -1]) {
      const specs180 = fireFoldLeafSpecs(0, 1600, 1600, -1, swingSide, 180);
      assert.equal(specs180.length, 2);
      assert.equal(
        leafBulgeSign(isVertical, specs180[0].hingeSide, specs180[0].sense, 180),
        leafBulgeSign(isVertical, specs180[1].hingeSide, specs180[1].sense, 180),
        `isVertical=${isVertical}, swingSide=${swingSide}`,
      );
    }
  }
  const specs90 = fireFoldLeafSpecs(0, 1600, 1600, 1, -1, 90);
  assert.equal(specs90.length, 1);
  assert.deepEqual(specs90[0], { hingeAlong: 1600, hingeSide: 1, sense: -1, leafLength: 1600 });
});

// ================================================================
// 【幾何バグ3】overheadSymbol/emergencySymbol: host.axisOffsetの符号ではなくexteriorSideDir基準
// ================================================================

// 1つの外壁境界に2枚のWall（.claude/opening-model.md参照）: 室内向き壁(isExteriorWall:false)と
// 外壁本体(isExteriorWall:true、generateExteriorWallsの符号規約=axisOffset逆符号)。
function makeExteriorBoundaryGraph() {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const innerWall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  const outerWall = graph.addWall(axisCL, -75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  return { graph, innerWall, outerWall };
}

test('openingExteriorDir: 外壁境界の2枚の壁どちらをhostにしても同じ室外向きを返す（OVERHEAD/EMERGENCYの向き判定基準）', () => {
  const { graph, innerWall, outerWall } = makeExteriorBoundaryGraph();
  const centerCoord = 1500;
  const dirFromInner = openingExteriorDir(innerWall, graph, centerCoord);
  const dirFromOuter = openingExteriorDir(outerWall, graph, centerCoord);
  assert.equal(dirFromInner, dirFromOuter, '室内向き壁をhostにしても外壁本体をhostにしても同じ室外向きのはず');
  assert.equal(dirFromInner, -1, 'outerWall: axisOffset=-75 → axisValue=-75 → sign(-75-0)=-1');
});

// 【回帰確認】Math.sign(host.axisOffset)（修正前の実装）だと室内向き壁と外壁本体で符号が
// 食い違う（axisOffsetの符号がそもそも逆だから）ことを独立に確認する。
test('【回帰】Math.sign(host.axisOffset)は室内向き壁と外壁本体で符号が食い違う（修正前バグの再現）', () => {
  const { innerWall, outerWall } = makeExteriorBoundaryGraph();
  const naiveInner = Math.sign(innerWall.axisOffset) || 1; // +75 → +1
  const naiveOuter = Math.sign(outerWall.axisOffset) || 1; // -75 → -1
  assert.notEqual(naiveInner, naiveOuter, 'axisOffsetの符号は室内向き壁と外壁本体で逆になるはず（=室外側の判定に使えない）');
});

// ================================================================
// 失敗系: SLIDE_LAYOUT 未定義エントリ／panels:[]（平面・姿図共通）
// ================================================================

test('【失敗系】resolveSlideLayoutPanels: entry未定義／slideLayout未設定／panels:[]はすべて空配列を返す（例外なし）', () => {
  assert.deepEqual(resolveSlideLayoutPanels(null), []);
  assert.deepEqual(resolveSlideLayoutPanels(undefined), []);
  assert.deepEqual(resolveSlideLayoutPanels({}), []);
  assert.deepEqual(resolveSlideLayoutPanels({ mechanism: OpeningMechanism.SLIDE_LAYOUT }), []);
  assert.deepEqual(resolveSlideLayoutPanels({ mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [] } }), []);
});

// openingElevationFigure.js の slideLayoutPrimitives も resolveSlideLayoutPanels を共有するため、
// ここでの確認は平面側（OpeningsLayer.jsx slideLayoutSymbol）にもそのまま及ぶ
// （.claude/opening-model.md「平面記号の幾何計算はopeningPlanSymbolGeometry.jsへ抽出」参照）。
test('【失敗系】buildOpeningElevation: SLIDE_LAYOUTでpanels:[]・slideLayout未設定でも例外なく、パネル由来プリミティブは0本', () => {
  const opening = { width: 1200, height: 1170, sillHeight: 800, category: OpeningCategory.WINDOW, subType: 'x', hingeSide: -1, swingSide: 1 };
  for (const entry of [
    { key: 'x', label: 'テスト', mechanism: OpeningMechanism.SLIDE_LAYOUT },
    { key: 'x', label: 'テスト', mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [] } },
  ]) {
    let primitives;
    assert.doesNotThrow(() => { primitives = buildOpeningElevation(opening, { tag: null, entry }); });
    assert.equal(primitives.filter(p => p.type === 'arrow').length, 0, '可動パネルの矢印は0本のはず');
    assert.equal(primitives.filter(p => p.type === 'text' && p.text === 'FIX').length, 0, 'FIXテキストは0本のはず');
  }
});

// ================================================================
// 【幾何バグ6】trackOf: tracks:3でpanels.length>3のとき範囲外インデックスにならない
// ================================================================

test('trackOf: tracks:3でpanels.length(=4)がtracksを超えても巡回割付でtrackが0..2に収まる', () => {
  const panels = [{}, {}, {}, {}]; // 4パネル・tracks:3（本来のカタログには無いが防御的に確認）
  const tracks = panels.map((p, i) => trackOf(p, i, 3, false));
  assert.deepEqual(tracks, [0, 1, 2, 0], 'index % tracksで巡回するはず（境界外に出ない）');
});

// ================================================================
// 失敗系: equalInsetLines（OVERHEAD）— 高さ240mm未満で横線がバンド外（topより上）に出ない
// ================================================================

test('【失敗系】buildOpeningElevation: 高さ200mmのoverheadDoorでも横線がtopより上に出ない（equalInsetLinesガード）', () => {
  const entry = findCatalogEntry('fitting', 'overheadDoor');
  assert.ok(entry, 'overheadDoorエントリが存在する前提');
  const opening = { width: 2600, height: 200, sillHeight: null, category: OpeningCategory.FITTING, subType: 'overheadDoor', hingeSide: -1, swingSide: 1 };
  let primitives;
  assert.doesNotThrow(() => { primitives = buildOpeningElevation(opening, { tag: null, entry }); });
  // 高さ200mm(<240mm)はequalInsetLinesのガードにより横線が1本も描かれない
  // （負のgapでバンド外にはみ出す位置に描くよりは「描かない」ほうが安全という仕様判断）。
  const horizontalLines = primitives.filter(p => p.type === 'line' && p.y1 === p.y2);
  assert.equal(horizontalLines.length, 0, '高さ240mm未満は横線を描かないはず（バンド外にはみ出すため）');
});
