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
import { findCatalogEntry, OpeningMechanism, IMPLEMENTED_MECHANISMS, HINGED_MECHANISMS, SASH_OPEN_MECHANISMS } from './openingCatalog.js';
import { buildOpeningElevation } from './openingElevationFigure.js';
import { LodLevel } from '../viewport.js';
import {
  swingDoubleLeafSpecs, swingChildLeafSpecs, fireDoorLeafSpecs, fireFoldLeafSpecs,
  swingChildLengths, openingExteriorDir, resolveSlideLayoutPanels, trackOf,
  planFrameBand, bandPerp, frameInnerSpan, SASH_DEPTH_MM, FRAME_OVERHANG_MM,
  planSymbolPlan, innerSpanOpening, swingClosedLeafSpan, swingOpenPerpDir,
  closedAngleFor, leafOpenAngle, angleVectors, DOOR_OPEN_ANGLE_DEG,
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

// ================================================================
// 平面LOD詳細化: planFrameBand（一般/詳細の唯一の分岐点）・bandPerp・frameInnerSpan
// ================================================================

test('planFrameBand: 一般LOD(detail:false)はaxisValue中心・幅SASH_DEPTH_MMで、faceLo/faceHi/frameDepthを渡しても変わらない', () => {
  const base = planFrameBand({ axisValue: 1000, detail: false });
  assert.deepEqual(base, { lo: 1000 - SASH_DEPTH_MM / 2, hi: 1000 + SASH_DEPTH_MM / 2, center: 1000, depth: SASH_DEPTH_MM });
  const withExtras = planFrameBand({ axisValue: 1000, faceLo: 0, faceHi: 2000, frameDepth: 999, exteriorDir: 1, detail: false });
  assert.deepEqual(withExtras, base, '一般LODはfaceLo/faceHi/frameDepth/exteriorDirを無視するはず');
});

test('planFrameBand: 詳細LOD・frameDepth未設定(null/0/負値)は面間+overhangへ縮退する', () => {
  for (const frameDepth of [null, 0, -50]) {
    const band = planFrameBand({ axisValue: 1000, faceLo: 900, faceHi: 1100, frameDepth, detail: true });
    assert.deepEqual(band, { lo: 900 - FRAME_OVERHANG_MM, hi: 1100 + FRAME_OVERHANG_MM, center: 1000, depth: 200 + FRAME_OVERHANG_MM * 2 }, `frameDepth=${frameDepth}`);
  }
});

test('planFrameBand: 詳細LOD・frameDepth=70・exteriorDir=+1は外部側の面(faceHi+overhang)へ寄せる', () => {
  const band = planFrameBand({ axisValue: 1000, faceLo: 900, faceHi: 1100, frameDepth: 70, exteriorDir: 1, detail: true });
  assert.equal(band.hi, 1100 + FRAME_OVERHANG_MM);
  assert.equal(band.lo, band.hi - 70);
  assert.equal(band.depth, 70);
});

test('planFrameBand: 詳細LOD・frameDepth=70・exteriorDir=-1は反対側の面(faceLo-overhang)へ寄せる', () => {
  const band = planFrameBand({ axisValue: 1000, faceLo: 900, faceHi: 1100, frameDepth: 70, exteriorDir: -1, detail: true });
  assert.equal(band.lo, 900 - FRAME_OVERHANG_MM);
  assert.equal(band.hi, band.lo + 70);
  assert.equal(band.depth, 70);
});

test('planFrameBand: 詳細LOD・exteriorDirが定まらない(null/undefined)ときは面間の中央に置く', () => {
  for (const exteriorDir of [null, undefined]) {
    const band = planFrameBand({ axisValue: 1000, faceLo: 900, faceHi: 1100, frameDepth: 70, exteriorDir, detail: true });
    assert.equal(band.center, (900 + 1100) / 2, `exteriorDir=${exteriorDir}`);
    assert.equal(band.depth, 70);
  }
});

test('planFrameBand: 詳細LOD・frameDepthが壁厚(overhang込み)以上のときは面間いっぱいへ縮退する', () => {
  const band = planFrameBand({ axisValue: 1000, faceLo: 900, faceHi: 1100, frameDepth: 220, exteriorDir: 1, detail: true });
  assert.deepEqual(band, { lo: 900 - FRAME_OVERHANG_MM, hi: 1100 + FRAME_OVERHANG_MM, center: 1000, depth: 220 });
});

test('planFrameBand: faceLo>faceHiと順序が逆でも同じ帯になる', () => {
  const forward = planFrameBand({ axisValue: 1000, faceLo: 900, faceHi: 1100, frameDepth: 70, exteriorDir: 1, detail: true });
  const reversed = planFrameBand({ axisValue: 1000, faceLo: 1100, faceHi: 900, frameDepth: 70, exteriorDir: 1, detail: true });
  assert.deepEqual(forward, reversed);
});

test('bandPerp: t=0/0.25/0.5/1でband.lo〜band.hiを内分する', () => {
  const band = planFrameBand({ axisValue: 1000, detail: false }); // lo=980, hi=1020, depth=40
  assert.equal(bandPerp(band, 0), 980);
  assert.equal(bandPerp(band, 0.25), 990);
  assert.equal(bandPerp(band, 0.5), 1000);
  assert.equal(bandPerp(band, 1), 1020);
});

test('frameInnerSpan: 通常幅は両端からjambWidthぶん内側へ寄せる', () => {
  const span = frameInnerSpan(0, 1000, 30);
  assert.deepEqual(span, { lo: 30, hi: 970, width: 940 });
});

test('【失敗系】frameInnerSpan: width===jambWidth*2はlo/hiが一致し中央へ縮退する（幅ゼロ、反転しない）', () => {
  const span = frameInnerSpan(0, 60, 30);
  assert.deepEqual(span, { lo: 30, hi: 30, width: 0 });
});

test('【失敗系】frameInnerSpan: width<jambWidth*2（開口より枠の内法が広い）でも反転せず中央へ縮退する', () => {
  const span = frameInnerSpan(0, 40, 30); // width=40 < jambWidth*2=60
  assert.equal(span.lo, span.hi, 'lo>hiへ反転してはいけない');
  assert.equal(span.lo, 20, '中央(0+40)/2=20へ縮退するはず');
  assert.equal(span.width, 0);
});

// ================================================================
// QA2巡目（F1〜F6）: 詳細LODディスパッチの「判断」を集約したplanSymbolPlan・innerSpanOpening。
// renderer/OpeningsLayer.jsx は戻り値を消費するだけになったため、その「判断」自体はここで検証する
// （.jsxはnode:testから単体importできず、判断ロジックを.jsxに残すと結線ミスが検出できない。
// F1/F2はまさにこの形で1779/1779緑のまま混入した）。
// ================================================================

// 【U2・失敗系】T1はHINGED_MECHANISMS/SASH_OPEN_MECHANISMSの件数（10/13/6/29）をハードコードした
// 数だけを錨にしており、集合そのものの整合（部分集合関係・排他性）は未検証だった（QA所見）。
// ここで3集合の関係自体を直接検証する。
test('【失敗系】SASH_OPEN_MECHANISMS/HINGED_MECHANISMSはIMPLEMENTED_MECHANISMSの部分集合であり、SASH_OPEN_MECHANISMSとHINGED_MECHANISMSは互いに素である', () => {
  for (const m of SASH_OPEN_MECHANISMS) {
    assert.ok(IMPLEMENTED_MECHANISMS.has(m), `SASH_OPEN_MECHANISMSの${m}はIMPLEMENTED_MECHANISMSに含まれるはず`);
  }
  for (const m of SASH_OPEN_MECHANISMS) {
    assert.ok(!HINGED_MECHANISMS.has(m), `SASH_OPEN_MECHANISMSの${m}はHINGED_MECHANISMSと排他のはず（交差ゼロ）`);
  }
  for (const m of HINGED_MECHANISMS) {
    assert.ok(IMPLEMENTED_MECHANISMS.has(m), `HINGED_MECHANISMSの${m}はIMPLEMENTED_MECHANISMSに含まれるはず`);
  }
});

// 【T1】MUT1（sashFrameSymbol等の呼び出しをnullにする＝frame判定を握りつぶす類の変異）を殺す:
// IMPLEMENTED_MECHANISMS(29件)すべてがDETAILでframe!=='none'になり、かつHINGED_MECHANISMS(10件)は
// 'notched'、SASH_OPEN_MECHANISMS(13件)は'sashOpen'、残り(6件)は'sash'に分類される。
// 【QA所見R3】この6件のうちSLIDE_DOUBLEはOpeningsLayer.jsxの専用ブランチ（slideDoubleDetailSymbol）
// で早期returnされるため、実際にsashFrameSymbolへ到達する「sash」機構は5件（FOLD/PIVOT/SHUTTER/
// OVERHEAD/EMERGENCY）——planSymbolPlan自体はIMPLEMENTED_MECHANISMS全29件を漏れなく分類する
// 総関数であることをここでは検証している（openingPlanSymbolGeometry.js側のJSDoc参照）。
test('planSymbolPlan: IMPLEMENTED_MECHANISMSの29機構すべてがDETAILでframe!==\'none\'になり、HINGED=notched/SASH_OPEN=sashOpen/残り=sashに分類される', () => {
  const band = { lo: 480, hi: 520, center: 500, depth: 40 };
  const mechanisms = [...IMPLEMENTED_MECHANISMS];
  assert.equal(mechanisms.length, 29, 'IMPLEMENTED_MECHANISMSは29機構のはず（done-means前提の変化を検知する）');
  assert.equal(HINGED_MECHANISMS.size, 10);
  assert.equal(SASH_OPEN_MECHANISMS.size, 13);

  let notched = 0, sashOpen = 0, sash = 0;
  for (const mechanism of mechanisms) {
    const plan = planSymbolPlan({ mechanism, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 500, band, jambWidth: 30 });
    assert.notEqual(plan.frame, 'none', `mechanism=${mechanism}: DETAILではframe!=='none'のはず`);
    assert.ok(plan.innerSpan, `mechanism=${mechanism}: frame!=='none'のときinnerSpanはnullでないはず`);
    if (HINGED_MECHANISMS.has(mechanism)) { assert.equal(plan.frame, 'notched'); notched += 1; }
    else if (SASH_OPEN_MECHANISMS.has(mechanism)) { assert.equal(plan.frame, 'sashOpen'); sashOpen += 1; }
    else { assert.equal(plan.frame, 'sash'); sash += 1; }
  }
  assert.equal(notched, 10);
  assert.equal(sashOpen, 13);
  assert.equal(sash, 6);
});

test('planSymbolPlan: SCHEMATIC/STANDARD（lodLevel!==DETAIL）はframe===\'none\'・innerSpan===null', () => {
  const band = { lo: 480, hi: 520, center: 500, depth: 40 };
  for (const lodLevel of [LodLevel.SCHEMATIC, LodLevel.STANDARD]) {
    const plan = planSymbolPlan({ mechanism: OpeningMechanism.SWING, lodLevel, coord1: 0, coord2: 1000, axisValue: 500, band, jambWidth: 30 });
    assert.equal(plan.frame, 'none');
    assert.equal(plan.innerSpan, null);
  }
});

// 【T2】MUT3（蝶番系の回転中心をband.centerに差し替える変異）を殺す: F2のpivotPerpは
// axisValueをband内へクランプした値であり、band.centerではない。frameDepthで帯が寄って
// axisValue自身がband外に出るケース（host.axisValue=900, band={lo:1040,hi:1110,center:1075}）
// ではpivotPerp===band.lo（axisValue側の最寄りの面）になり、band.center(1075)とは一致しない。
test('planSymbolPlan: 蝶番系10機構でpivotPerpはband.centerではなくaxisValueをband内へクランプした値になる（F2）', () => {
  const band = { lo: 1040, hi: 1110, center: 1075, depth: 70 };
  for (const mechanism of HINGED_MECHANISMS) {
    const plan = planSymbolPlan({ mechanism, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 900, band, jambWidth: 30 });
    assert.notEqual(plan.pivotPerp, band.center, `mechanism=${mechanism}: band.centerに差し替わっていないはず`);
    assert.equal(plan.pivotPerp, band.lo, `mechanism=${mechanism}: axisValue(900)はband外なのでband.lo(1040)へクランプされるはず`);
    assert.ok(plan.pivotPerp >= band.lo && plan.pivotPerp <= band.hi, `mechanism=${mechanism}: pivotPerpはband内のはず`);
  }
});

test('【失敗系】planSymbolPlan: frameDepth未設定相当のband（axisValueを含む）ではpivotPerp===axisValueで既存挙動が変わらない', () => {
  const band = { lo: 850, hi: 950, center: 900, depth: 100 }; // axisValue=900を含む
  for (const mechanism of HINGED_MECHANISMS) {
    const plan = planSymbolPlan({ mechanism, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 900, band, jambWidth: 30 });
    assert.equal(plan.pivotPerp, 900, `mechanism=${mechanism}: bandがaxisValueを含む場合はクランプがno-opのはず`);
  }
});

// 【T3】F1・MUT2（innerSpanOpeningを素通しにする変異）を殺す: 実Openingインスタンス（centerCoord等が
// MobXのcomputedとして定義されている）を渡し、{...opening}が拾えないcenterCoordが明示コピーされる
// こと・coord1/coord2/widthがspanへ差し替わること・本体(opening自身)は書き換わらないことを固定する。
function makeRealOpening() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clEnd = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, {});
  return graph.addOpening(wall.axisCL, 1, false, wall.clStart, 5000, 900, OpeningCategory.FITTING, 'singleSwing', {});
}

test('【失敗系】innerSpanOpening: 実Openingインスタンス（centerCoordがMobX computed）でもcenterCoordを保持し、coord1/coord2/widthはspanへ差し替わり、本体は書き換わらない', () => {
  const opening = makeRealOpening();
  assert.equal(opening.centerCoord, 5000);
  assert.equal(opening.coord1, 4550);
  assert.equal(opening.coord2, 5450);

  const span = frameInnerSpan(opening.coord1, opening.coord2, 30); // {lo:4580, hi:5420, width:840}
  const spanOpening = innerSpanOpening(opening, span);

  assert.equal(spanOpening.centerCoord, 5000, '{...opening}はMobX computedのcenterCoordを拾えないため明示コピーが必須（F1の実バグ）');
  assert.equal(spanOpening.coord1, 4580);
  assert.equal(spanOpening.coord2, 5420);
  assert.equal(spanOpening.width, 840);
  assert.equal(opening.width, 900, '本体(Opening)自身は書き換わっていないはず（MobX observableへの誤書き込み防止）');
  assert.equal(opening.coord1, 4550, '本体のcoord1も不変のはず');
});

// 【T4】境界幅（width∈{0,40,60}）でplanSymbolPlanのinnerSpanが例外なくfiniteかつlo<=hiを保つ
// （PIVOT=='sash'代表・SLIDE_LAYOUT=='sashOpen'代表・FOLD=='sash'代表——frame分類の異なる3機構）。
test('【失敗系】planSymbolPlan: width∈{0,40,60}のPIVOT/SLIDE_LAYOUT/FOLDでinnerSpanが常にfinite・lo<=hi', () => {
  const band = { lo: 480, hi: 520, center: 500, depth: 40 };
  for (const width of [0, 40, 60]) {
    for (const mechanism of [OpeningMechanism.PIVOT, OpeningMechanism.SLIDE_LAYOUT, OpeningMechanism.FOLD]) {
      const jambWidth = Math.min(30, width / 2);
      const coord1 = 500, coord2 = 500 + width;
      const plan = planSymbolPlan({ mechanism, lodLevel: LodLevel.DETAIL, coord1, coord2, axisValue: 500, band, jambWidth });
      assert.ok(Number.isFinite(plan.innerSpan.lo), `mechanism=${mechanism}, width=${width}: innerSpan.loがfiniteでない`);
      assert.ok(Number.isFinite(plan.innerSpan.hi), `mechanism=${mechanism}, width=${width}: innerSpan.hiがfiniteでない`);
      assert.ok(plan.innerSpan.lo <= plan.innerSpan.hi, `mechanism=${mechanism}, width=${width}: innerSpan.lo<=hiでない`);
    }
  }
});

// 【T5・見送り】segmentedな境界での詳細LOD時exteriorDir一致性テストは見送る。理由:
// exteriorSideDirのalong引数によるsegmented判定はopeningGeometry.test.js（234〜250行）で
// 既にfindCounterpartWall/exteriorSideDir単体として厚く検証済み。F1の実体（along=opening.centerCoord
// がinnerSpanOpeningのcenterCoord消失により undefined 化する）はT3で直接固定済みのため、同じ配線点を
// 別のsegmented fixtureで再確認しても検証価値が重複するだけで新規に検出できるバグが無い。

// ---- 詳細LODの片開き戸「閉じた状態の扉」の四角（swingClosedLeafSpan） ----
// 扉の四角は開いた位置ではなく閉じた位置に描く（開いた扉は1本線＋円弧）。
// 直交方向は方立の欠き込み（pivotPerp 〜 壁中心側へ扉厚）と同じ区間になることを検算する。

test('swingClosedLeafSpan: hingeSide<0 は吊元から座標増加方向へ leafLength ぶん伸びる', () => {
  const span = swingClosedLeafSpan({
    hingeAlong: 1025, hingeSide: -1, leafLength: 755, pivotPerp: 0, outward: 1, thickness: 30,
  });
  assert.equal(span.alongLo, 1025);
  assert.equal(span.alongHi, 1780);
  // 欠き込みと同じ向き（壁中心側＝-outward）へ扉厚ぶん
  assert.equal(span.perpLo, -30);
  assert.equal(span.perpHi, 0);
});

test('swingClosedLeafSpan: hingeSide>0 は吊元から座標減少方向へ伸び、outward<0 は厚みが逆側へ出る', () => {
  const span = swingClosedLeafSpan({
    hingeAlong: 1780, hingeSide: 1, leafLength: 755, pivotPerp: 100, outward: -1, thickness: 30,
  });
  assert.equal(span.alongLo, 1025);
  assert.equal(span.alongHi, 1780);
  assert.equal(span.perpLo, 100);
  assert.equal(span.perpHi, 130);
});

test('【失敗系】swingClosedLeafSpan: leafLength=0（間口が枠に食われた縮退）でも lo<=hi の有限区間を返す', () => {
  const span = swingClosedLeafSpan({
    hingeAlong: 500, hingeSide: -1, leafLength: 0, pivotPerp: 0, outward: 0, thickness: 30,
  });
  assert.equal(span.alongLo, 500);
  assert.equal(span.alongHi, 500);
  // outward=0 は 1（外向き）として扱い、厚み0の潰れた四角にしない
  assert.equal(span.perpLo, -30);
  assert.equal(span.perpHi, 0);
});

// ================================================================
// 「開く方向反転」で扉が閉じる壁面（回転中心・閉じた扉の四角・方立の欠き込み）が反対側へ移る
// ================================================================

// 独立検算（leafBulgeSignと同じ方針。production の swingSideTowardPerp を経由せず、
// leafが実際にどちら側へ膨らむかの符号を三角関数から直接求める）。
function expectedOpenPerpSign(isVertical, hingeSide, swingSide) {
  return leafBulgeSign(isVertical, hingeSide, swingSide);
}

test('swingOpenPerpDir: 片開き系はleafが実際に膨らむ側（独立検算）と一致し、非蝶番系は0', () => {
  const entry = findCatalogEntry('fitting', 'singleSwing');
  for (const isVertical of [false, true]) {
    for (const hingeSide of [-1, 1]) {
      for (const swingSide of [-1, 1]) {
        assert.equal(
          swingOpenPerpDir(isVertical, hingeSide, swingSide, OpeningMechanism.SWING, entry),
          expectedOpenPerpSign(isVertical, hingeSide, swingSide),
          `isVertical=${isVertical}, hingeSide=${hingeSide}, swingSide=${swingSide}`,
        );
      }
    }
  }
  assert.equal(swingOpenPerpDir(false, -1, 1, OpeningMechanism.SLIDE_DOUBLE), 0, '非蝶番系は0（回転中心は従来どおりaxisValue）');
});

test('swingOpenPerpDir: 両開き系は実効吊元-1で計算する（opening.hingeSideに依らずcoord1側leafと一致）', () => {
  const dbl = findCatalogEntry('fitting', 'doubleSwing');
  const specs = swingDoubleLeafSpecs(0, 1800, 1800, 1);
  const coord1Leaf = specs[0];
  for (const hingeSide of [-1, 1]) {
    assert.equal(
      swingOpenPerpDir(false, hingeSide, 1, OpeningMechanism.SWING_DOUBLE, dbl),
      leafBulgeSign(false, coord1Leaf.hingeSide, coord1Leaf.sense),
      `hingeSide=${hingeSide}: 両開きはopening.hingeSideに依らずcoord1側leafの膨らむ側と一致するはず`,
    );
  }
});

// 面線 faceLo=850 / faceHi=1000（壁厚150mm）、詳細LODのband=面±10mm。
const FACES = { faceLo: 850, faceHi: 1000 };
const DETAIL_BAND = { lo: 840, hi: 1010, center: 925, depth: 170 };

test('planSymbolPlan: 蝶番系の回転中心は「扉が開く側の壁面」——openPerpDirの符号でfaceHi/faceLoが切り替わる', () => {
  for (const mechanism of HINGED_MECHANISMS) {
    const hi = planSymbolPlan({ mechanism, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 1000, band: DETAIL_BAND, jambWidth: 30, ...FACES, openPerpDir: 1 });
    const lo = planSymbolPlan({ mechanism, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 1000, band: DETAIL_BAND, jambWidth: 30, ...FACES, openPerpDir: -1 });
    assert.equal(hi.pivotPerp, FACES.faceHi, `${mechanism}: +側へ開くならfaceHiで閉じるはず`);
    assert.equal(lo.pivotPerp, FACES.faceLo, `${mechanism}: -側へ開くならfaceLoで閉じるはず（axisValue=1000のままではない＝不具合の再発防止）`);
    assert.equal(hi.leafOutward, 1);
    assert.equal(lo.leafOutward, -1);
  }
});

test('回帰: 「開く方向反転」（swingSideの反転）で閉じた扉の四角が反対の壁面へ移り、壁厚の中に納まる', () => {
  const entry = findCatalogEntry('fitting', 'singleSwing');
  const common = { mechanism: OpeningMechanism.SWING, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 900, axisValue: 1000, band: DETAIL_BAND, jambWidth: 30, ...FACES };
  const spanOf = (swingSide) => {
    const openPerpDir = swingOpenPerpDir(false, -1, swingSide, OpeningMechanism.SWING, entry);
    const plan = planSymbolPlan({ ...common, openPerpDir });
    return swingClosedLeafSpan({
      hingeAlong: 0, hingeSide: -1, leafLength: 900,
      pivotPerp: plan.pivotPerp, outward: plan.leafOutward, thickness: 30,
    });
  };
  // 水平壁・hingeSide=-1 では perpDir=(-1)*swingSide*hingeSide=swingSide——
  // swingSide=-1 が -perp（faceLo=850）側、+1 が +perp（faceHi=1000）側。
  const a = spanOf(-1), b = spanOf(1);
  assert.notDeepEqual(
    [a.perpLo, a.perpHi], [b.perpLo, b.perpHi],
    '開く方向反転で閉じた扉の四角は別の面へ移るはず（元の面に残るのが不具合）',
  );
  for (const [label, span] of [['反転前', a], ['反転後', b]]) {
    assert.ok(span.perpLo >= FACES.faceLo - 1e-9 && span.perpHi <= FACES.faceHi + 1e-9,
      `${label}: 閉じた扉(厚30mm)は壁厚(${FACES.faceLo}〜${FACES.faceHi})の中に納まるはず（壁の外へ出ない）`);
  }
  assert.ok(Math.abs(a.perpLo - FACES.faceLo) < 1e-9, 'swingSide=-1は-側の面で閉じるはず');
  assert.ok(Math.abs(b.perpHi - FACES.faceHi) < 1e-9, 'swingSide=+1は+側の面で閉じるはず');
});

test('planSymbolPlan: 非蝶番系・面線が無い呼び出しは従来どおりaxisValueをband内へクランプする（既存挙動の維持）', () => {
  const band = { lo: 1040, hi: 1110, center: 1075, depth: 70 };
  const noFace = planSymbolPlan({ mechanism: OpeningMechanism.SWING, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 900, band, jambWidth: 30 });
  assert.equal(noFace.pivotPerp, band.lo, '面線が渡らなければaxisValue(900)をband内へクランプ（F2の挙動）');
  const slide = planSymbolPlan({ mechanism: OpeningMechanism.SLIDE_DOUBLE, lodLevel: LodLevel.DETAIL, coord1: 0, coord2: 1000, axisValue: 900, band: DETAIL_BAND, jambWidth: 30, ...FACES, openPerpDir: 0 });
  assert.equal(slide.pivotPerp, 900, '非蝶番系（openPerpDir=0）はaxisValueのまま');
});

test('planSymbolPlan: 一般LOD（STANDARD）は便宜的なbandでクランプせず、回転中心を実際の壁面に置く', () => {
  const stdBand = { lo: 980, hi: 1020, center: 1000, depth: 40 }; // axisValue±20mmの便宜帯
  const plan = planSymbolPlan({ mechanism: OpeningMechanism.SWING, lodLevel: LodLevel.STANDARD, coord1: 0, coord2: 1000, axisValue: 1000, band: stdBand, jambWidth: 30, ...FACES, openPerpDir: -1 });
  assert.equal(plan.frame, 'none', '一般LODはframe==="none"のまま');
  assert.equal(plan.pivotPerp, FACES.faceLo, 'band.lo(980)へ吸着せず、反対の壁面(850)に置くはず');
});

// ================================================================
// 片開き戸（SWING）の動作線円弧と、閉じた扉・開いた扉の接続（ユーザー確認2026-09で確定した仕様）
//   ・円弧の中心 = 閉じた扉の吊元側・外面（開く側の壁面）の角
//   ・半径       = 扉長（＝閉じた扉の戸先側・外面の角まで）
//   ・1/4円で、終点＝開いた扉の先端に一致する（開いた扉が動作線に届く）
// renderer/OpeningsLayer.jsx swingLeafSymbol / swingSymbol はこの3点を合成するだけなので、
// 合成元（closedAngleFor / leafOpenAngle / angleVectors / swingClosedLeafSpan）の整合をここで固定する。
// ================================================================

test('SWING: 動作線円弧は「閉じた扉の吊元側・外面の角」中心・半径=扉長の1/4円で、始点=閉じた扉の戸先側の角／終点=開いた扉の先端に一致する', () => {
  // 水平壁（isVertical=false → ワールドx=長さ方向along・y=直交方向perp）。
  // 幅900・吊元側後退25・戸先側後退20 → 吊元along=25, 扉長=855。壁面perp=1000、開く側=+perp。
  const isVertical = false, hingeSide = -1, swingSide = 1;
  const hingeAlong = 25, leafLength = 855, pivotPerp = 1000, thickness = 30;
  const outward = swingOpenPerpDir(isVertical, hingeSide, swingSide, OpeningMechanism.SWING, findCatalogEntry('fitting', 'singleSwing'));
  assert.equal(outward, 1, '前提: この向きでは+perp側へ開く');

  const span = swingClosedLeafSpan({ hingeAlong, hingeSide, leafLength, pivotPerp, outward, thickness });
  // 中心（=吊元・壁面）が閉じた扉の「吊元側・外面」の角であること
  assert.equal(span.alongLo, hingeAlong, '閉じた扉の吊元側の辺は吊元alongと一致するはず');
  assert.equal(span.perpHi, pivotPerp, '閉じた扉の外面は開く側の壁面(pivotPerp)と一致するはず');
  assert.equal(span.perpLo, pivotPerp - thickness, '扉厚は壁の中心側へ入るはず');

  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle   = leafOpenAngle(closedAngle, swingSide);
  assert.equal(Math.abs(openAngle - closedAngle), DOOR_OPEN_ANGLE_DEG, '1/4円（90°）のはず');

  // 円弧の始点・終点（中心 + 半径 × 各角度の単位ベクトル。arcPathD と同じ式）
  const at = (angle) => {
    const { dir } = angleVectors(angle);
    return {
      along: Math.round(hingeAlong + dir.x * leafLength),
      perp:  Math.round(pivotPerp  + dir.y * leafLength),
    };
  };
  const start = at(closedAngle), end = at(openAngle);
  assert.deepEqual(start, { along: span.alongHi, perp: pivotPerp },
    '始点は閉じた扉の戸先側・外面の角（along=880, perp=壁面）のはず');
  assert.deepEqual(end, { along: hingeAlong, perp: pivotPerp + leafLength },
    '終点は開いた扉の先端（吊元から壁に直交して扉長ぶん）のはず＝開いた扉が動作線に届く');
});
