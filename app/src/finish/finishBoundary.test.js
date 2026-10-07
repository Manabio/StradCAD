// finish/finishBoundary.js（runFinishExitBoundary）の回帰テスト。
// フィクスチャ方針は structural/structuralOrchestration.test.js と同じ（IDBを経由しない
// 「最上階（唯一の実体階）からの退出・goingToStructure=false」シナリオに限定する。
// runStructuralModeSetup 等のIDB経路は node:test 環境で indexedDB未定義になるため対象外）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { serializeGraph } from '../graphSnapshot.js';
import { floorBytesEqual } from '../floorOps.js';
import { overlayGeneration } from '../catalog/catalogRegistry.js';
import { createFinishExitStamps } from './finishExitStamp.js';
import { Project,CenterLineType, Discipline, StairType, RoomFeature, centerLineKind } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { cellsBeyondBreak } from './stair/stairGeometry.js';
import { WALL_KEY_VERSION } from './wallFreshnessKey.js';

function makeSinglePlaneProject() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- ステップ2（壁由来梁芯の追従）統合フィクスチャ ----
// 2部屋（部屋A: y0-ym、部屋B: ym-y1）が共有するym CLに「面合わせ」CL偏芯を指定する。
// 通常の対称壁は下地帯中心が常にCL上に固定される（下地材コードを変えても動かない）ため、
// 「下地材コード変更で下地帯中心が動く」を再現できるのはCL偏芯壁・階段下(2a)壁だけ
// （実測で確認済み。ステップ3以前は2aが再脱出時に壁を作り直さないため検証に使えず、
// CL偏芯を用いていた。ステップ3裁定「案B」で2aも毎回作り直されるようになったため、
// 2a壁を使った統合テストは下の makeStairUnder2aFixture 側に別途用意する）。
async function makeEccentricWallFixture() {
  const { project, graph } = makeSinglePlaneProject();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const keyA = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const keyB = `${x0.id}:${ym.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([keyA]), '部屋A');
  graph.addRoom(new Set([keyB]), '部屋B');

  // エッジ（INTERIOR_WALLへのトポロジー分類）を先に整える（fmode不要の経路）。
  await runFinishEntryBoundary(graph, project);
  // conformWoodBacking（entry境界内・在来木造の下地材自動選択）の影響を避けるため、
  // 主構造は entry の後に設定する（下地材コードを自分で制御するため）。
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setCLEccentricity(ym.id, { mode: 'face', value: 0, side: 1, backing: '' });

  const materialMap = await loadMaterialMap();
  const fmode = { materialMap, stairUnderRooms: () => [] };
  return { project, graph, ym, fmode };
}

// ---- ステップ3統合フィクスチャ: SWITCHBACK・L字部屋＋2a部屋（under）----
// finish/stair/stairUnderWalls.test.js の makeStairUnderFixture と同一構成。在来木造を設定して
// reflectStructuralAfterFinishExit 経由で壁由来梁芯（fuse）が自動生成される状態を作る。
async function makeStairUnder2aFixture() {
  const { project, graph } = makeSinglePlaneProject();
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const stairCells = new Set([landingKey, outboundKey, returnKey]);
  const roomCells  = new Set([landingKey, outboundKey]); // L字。returnKeyは部屋自身に含めない。
  const room = graph.addRoom(roomCells, '階段');
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
  const under = graph.addRoom(new Set(beyond), '階段下');

  const materialMap = await loadMaterialMap();
  const fmode = { materialMap, stairUnderRooms: () => [{ stair, room: under, splitCLIds: new Set() }] };
  return { project, graph, xm, stair, room, under, fmode };
}

function ownerWallOn(graph, clId) {
  return graph.walls.find(w => w.axisCL.id === clId && w.backingDepth > 0);
}
function backingCenterOf(wall) {
  return (wall.backingRange.lo + wall.backingRange.hi) / 2;
}
function beamCLAt(graph, isVertical, value) {
  const type = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  return graph.centerLines.find(cl => cl.centerLineType === type && centerLineKind(cl) === 'beam' && Math.abs(cl.value - value) < 1) ?? null;
}

// ---- QA F1・F4回帰: fmode.materialMapがnullの脱出は鍵を書かず、undoも増やさない ----
test('runFinishExitBoundary【QA F1・F4回帰】: fmode.materialMapがnullなら鮮度キーを書かない・undoエントリを増やさない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  const fmode = { materialMap: null }; // モード切替中・材ロード未完了に相当
  const keyBefore = graph.wallFreshnessKey;
  const undoBefore = undoManager.peekUndo();

  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });

  assert.equal(graph.wallFreshnessKey, keyBefore, 'materialMap無しでは鮮度キーを書き換えない（nullのまま）');
  assert.equal(undoManager.peekUndo(), undoBefore, 'materialMap無しでは壁関連のundoエントリを増やさない');
});

// ---- 対照: fmode自体がnull（旧仕様の主経路）でも同様に鍵を書かない ----
test('runFinishExitBoundary【対照】: fmode自体がnullでも鮮度キーを書かない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  const keyBefore = graph.wallFreshnessKey;
  const undoBefore = undoManager.peekUndo();

  await runFinishExitBoundary(graph, project, null, { goingToStructure: false });

  assert.equal(graph.wallFreshnessKey, keyBefore);
  assert.equal(undoManager.peekUndo(), undoBefore);
});

// ---- QA F4回帰（正の経路）: regenerated=trueの脱出は鮮度キーを書き、undoで壁と同じ1エントリで戻る ----
test('runFinishExitBoundary【QA F4回帰】: regenerated=trueの脱出は鮮度キーを書き、undoで壁と同じ1エントリで旧値へ戻る', async () => {
  const { project, graph } = makeSinglePlaneProject();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([key]), '部屋A');

  const materialMap = await loadMaterialMap();
  const fmode = { materialMap, stairUnderRooms: () => [] };

  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });

  assert.ok(graph.wallFreshnessKey?.startsWith(`${WALL_KEY_VERSION}|`), '鮮度キーがバージョン接頭辞付きで書かれている');
  assert.ok(graph.walls.length > 0, '壁が生成されている');

  undoManager.undo();
  assert.equal(graph.wallFreshnessKey, null, 'undoで鍵が旧値（null）へ戻る');
  assert.equal(graph.walls.length, 0, 'undoで壁と同じ1エントリとして戻るため壁も消える');

  undoManager.redo();
  assert.ok(graph.wallFreshnessKey?.startsWith(`${WALL_KEY_VERSION}|`), 'redoで鍵が再度書かれる');
  assert.ok(graph.walls.length > 0, 'redoで壁も復帰する');
});

// ---- ステップ2統合: 下地材コード変更→壁由来梁芯の追従→undo1回で全部戻る ----
test('runFinishExitBoundary【ステップ2統合】: 下地材コード変更で下地帯中心が動くと壁由来梁芯がCL idを保持したまま新中心へ追従し、undo1回で壁・鍵・梁芯値がすべて戻る', async () => {
  const { project, graph, ym, fmode } = await makeEccentricWallFixture();

  // 1回目: 下地コードA（既定＝□-90×45）
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const ownerBefore = ownerWallOn(graph, ym.id);
  assert.ok(ownerBefore, '前提: CL偏芯で下地オーナー壁が生成されている');
  const centerBefore = backingCenterOf(ownerBefore);
  const beamBefore = beamCLAt(graph, false, centerBefore);
  assert.ok(beamBefore, '前提: 下地帯中心に壁由来梁芯（在来木造・selfAndBelow）が生成されている');
  const beamId = beamBefore.id;
  const keyAfter1st = graph.wallFreshnessKey;

  // 2回目: 下地コードB（□-120×45。thickness 120）へ変更 → CL偏芯壁の下地帯中心が動く
  graph.setInteriorWallBacking('101400000001');
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });

  const ownerAfter = ownerWallOn(graph, ym.id);
  const centerAfter = backingCenterOf(ownerAfter);
  assert.notEqual(centerAfter, centerBefore, '前提: 下地帯中心が実際に動いた');

  const beamAfter = graph.centerLines.find(cl => cl.id === beamId);
  assert.ok(beamAfter, '梁芯CLは撤去されず残っている');
  assert.equal(beamAfter.value, centerAfter, '梁芯の値がCL idを保持したまま新中心に一致する');
  const orphanedAtOldCenter = graph.centerLines.some(cl =>
    cl.id !== beamId && centerLineKind(cl) === 'beam' && Math.abs(cl.value - centerBefore) < 1);
  assert.equal(orphanedAtOldCenter, false, '旧座標に重複した梁芯が残っていない');

  // undo1回で壁・鍵・梁芯値がすべて戻ることを確認
  undoManager.undo();
  assert.equal(graph.wallFreshnessKey, keyAfter1st, 'undoで鍵が1回目脱出時点の値へ戻る');
  const ownerUndone = ownerWallOn(graph, ym.id);
  assert.equal(backingCenterOf(ownerUndone), centerBefore, 'undoで壁の下地帯中心が旧位置へ戻る');
  const beamUndone = graph.centerLines.find(cl => cl.id === beamId);
  assert.equal(beamUndone.value, centerBefore, 'undoで梁芯の値も同じ1エントリで旧中心へ戻る');

  // redoで再度追従する
  undoManager.redo();
  const beamRedone = graph.centerLines.find(cl => cl.id === beamId);
  assert.equal(beamRedone.value, centerAfter, 'redoで梁芯の値が新中心へ再度追従する');
});

// ---- ステップ2: toに既に別の壁由来梁芯があれば、保護されない旧梁芯は吸収されて撤去される
// （案B・ユーザー裁定・2026-09-26。旧: 追従をスキップし旧梁芯を残していた）----
test('【案B】runFinishExitBoundary: 新中心の位置に既に別の壁由来梁芯があれば、保護されない元の梁芯は吸収されて撤去され、undoで同idで戻る', async () => {
  const { project, graph, ym, fmode } = await makeEccentricWallFixture();

  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const ownerBefore = ownerWallOn(graph, ym.id);
  const centerBefore = backingCenterOf(ownerBefore);
  const beamBefore = beamCLAt(graph, false, centerBefore);
  assert.ok(beamBefore, '前提: 下地帯中心に壁由来梁芯が生成されている');
  const beamId = beamBefore.id;

  // 下地コードBに変えたときの新中心（-15mm）へ、あらかじめ「既に別の梁芯がある」状態を作る
  // （実運用ではユーザーが別途その位置に梁芯を持つ通り芯化・別壁由来の梁芯を残すケースに相当）。
  const conflictingCenter = centerBefore - 15; // 90→120で backingOffset が -57.5→-72.5 動く分（実測）
  const conflictingCL = graph.addCenterLine(CenterLineType.HORIZONTAL, conflictingCenter, {
    labeled: false, discipline: Discipline.FUSE,
  });
  const conflictingCLId = conflictingCL.id;

  graph.setInteriorWallBacking('101400000001');
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });

  const ownerAfter = ownerWallOn(graph, ym.id);
  const centerAfter = backingCenterOf(ownerAfter);
  assert.equal(centerAfter, conflictingCenter, '前提: 壁自体の下地帯中心は想定どおり動いている');

  assert.equal(graph.centerLines.some(cl => cl.id === beamId), false, '保護されない元の梁芯CLは吸収されて撤去される（案B）');
  assert.equal(graph.centerLines.find(cl => cl.id === conflictingCLId)?.value, conflictingCenter, '競合していた梁芯（相手）はそのまま残り値も変わらない');

  // undoで吸収された梁芯（同id）が戻ることを確認（壁の下地帯中心自体の巻き戻しは
  // 「ステップ2統合」テストで別途確認済みのため、ここでは案B固有の吸収undoに絞る）。
  // このフィクスチャはgoingToStructure:falseのためrunFinishExitBoundary内部の
  // reflectStructuralAfterFinishExitがrecomputeActiveStructural(pushUndo既定true)を呼び、
  // 構造変化があれば「案B吸収を含むメイン1エントリ」の**後に**別エントリを積む（実測で確認——
  // 「ステップ2統合」フィクスチャでは構造変化が無くこの追加エントリが立たないため1回のundoで
  // 足りるが、本フィクスチャでは2回必要）。undoManager.undoを2回呼ぶ。
  undoManager.undo(); // 構造再計算分（案Bとは無関係）
  undoManager.undo(); // メインエントリ（案Bの吸収を含む）
  const beamUndone = graph.centerLines.find(cl => cl.id === beamId);
  assert.ok(beamUndone, 'undoで吸収された梁芯が同じidで復元される');
  assert.equal(beamUndone.value, centerBefore, 'undoで復元された梁芯の値も旧中心のまま');

  // redoで再度吸収される
  undoManager.redo();
  undoManager.redo();
  assert.equal(graph.centerLines.some(cl => cl.id === beamId), false, 'redoで再び吸収され撤去される');
});

// ---- ステップ3統合: 2a壁で初めてステップ2の追従が効く（下地材コード変更→2a壁backingDepth変化→追従） ----
test('runFinishExitBoundary【ステップ3統合】: 下地材コード変更で2a壁のbackingDepthも他の壁と同時に変わり、2a壁の下地帯中心にある壁由来梁芯がCL id保持のまま新中心へ追従する', async () => {
  const { project, graph, xm, fmode } = await makeStairUnder2aFixture();

  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const laneWallBefore = graph.walls.find(w => w.axisCL.id === xm.id && w.backingDepth > 0);
  assert.ok(laneWallBefore, '前提: xm CL上に2aのルール6レーン壁（下地オーナー）が生成されている');
  const depthBefore = laneWallBefore.backingDepth;
  const centerBefore = backingCenterOf(laneWallBefore);
  const beamBefore = beamCLAt(graph, true, centerBefore);
  assert.ok(beamBefore, '前提: 2a壁の下地帯中心に壁由来梁芯（在来木造・selfAndBelow）が生成されている');
  const beamId = beamBefore.id;

  // 下地コードを変更（□-90×45→□-120×45）して2回目脱出 → 2a壁も他の壁と同じく作り直され、
  // backingDepthが変わる（ステップ3裁定「案B」で初めて2a壁が材変更に追従できるようになった）。
  graph.setExteriorWallBacking('101400000001'); // roomWallDimsはexteriorWallBacking由来（edgeComposition.js）
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });

  const laneWallAfter = graph.walls.find(w => w.axisCL.id === xm.id && w.backingDepth > 0);
  assert.ok(laneWallAfter, '2回目脱出後もxm CL上に2aレーン壁がある');
  assert.notEqual(laneWallAfter.id, laneWallBefore.id, '2a壁は作り直されるためwall idは変わる');
  assert.notEqual(laneWallAfter.backingDepth, depthBefore, '前提: 2a壁のbackingDepthが下地材コード変更で実際に変わった');
  const centerAfter = backingCenterOf(laneWallAfter);
  assert.notEqual(centerAfter, centerBefore, '前提: 2a壁の下地帯中心が実際に動いた');

  const beamAfter = graph.centerLines.find(cl => cl.id === beamId);
  assert.ok(beamAfter, '壁由来梁芯CLは撤去されず残っている');
  assert.equal(beamAfter.value, centerAfter, '2a壁の追従で梁芯がCL idを保持したまま新中心に一致する');
});

// ---- ステップ3統合: 2回目脱出で2a壁が作り直された後、undo1回でgeneratedWallIds・壁実体がid含めて戻る ----
test('runFinishExitBoundary【ステップ3統合】: 2回目脱出で2a壁が作り直された後、undo1回で2a部屋のgeneratedWallIdsと壁実体がidまで1回目の状態へ戻る', async () => {
  const { project, graph, under, fmode } = await makeStairUnder2aFixture();

  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const idsAfter1st = [...under.generatedWallIds].sort();
  assert.ok(idsAfter1st.length > 0, '前提: 1回目で2a壁が生成されている');

  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const idsAfter2nd = [...under.generatedWallIds].sort();
  assert.notDeepEqual(idsAfter2nd, idsAfter1st, '前提: 2回目脱出で2a壁が作り直されid変化する（ステップ3裁定）');

  undoManager.undo();
  const idsAfterUndo = [...under.generatedWallIds].sort();
  assert.deepEqual(idsAfterUndo, idsAfter1st,
    'undo1回で2a部屋のgeneratedWallIdsがidまで1回目の状態へ戻る');
  for (const id of idsAfterUndo) {
    assert.ok(graph.shapeMap.has(id), `壁実体${id}もundoで復元されている`);
  }
});

// ---- QA V1回帰フィクスチャ: 直下階にSTRAIGHT階段、自階（最上階・アクティブ）にSTAIR_VOID ----
// stairPortEdges(stair, belowGraph, ['arrival']) の到達辺が extraStairOpenings として壁生成に
// 効く最小構成——直下階の解決を誤ると壁の形状が変わる（QA実測: 5セグメント差）。
// withStair:false は「直下階に階段を作らない」対照構成（QA W1: peekLowerGraphが常にnullを
// 返す壊れた実装でも(a)(b)(c)が互いに一致するだけでは検出できないため、直下階の階段の
// 有無で実際に壁が変わることをテスト冒頭の前提assertで固定する用）。
function makeStairVoidFixture({ withStair = true } = {}) {
  const project = new Project('proj', 'test');
  const { graph: below } = project.addPlane(0, '1階', 'p1');
  const { graph: above } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';

  const bx0 = below.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const bx1 = below.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const by0 = below.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const by1 = below.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  if (withStair) {
    const belowKey = `${bx0.id}:${by0.id}:${bx1.id}:${by1.id}`;
    const belowRoom = below.addRoom(new Set([belowKey]), '階段');
    below.addStair({
      type: StairType.STRAIGHT, cells: new Set([belowKey]), roomId: belowRoom.id,
      upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
    });
  }

  const ax0 = above.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ax1 = above.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const ax2 = above.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const ay0 = above.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ay1 = above.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const voidKey = `${ax0.id}:${ay0.id}:${ax1.id}:${ay1.id}`;
  const restKey = `${ax1.id}:${ay0.id}:${ax2.id}:${ay1.id}`;
  above.addRoom(new Set([voidKey]), '吹抜け').setFeature(RoomFeature.STAIR_VOID);
  above.addRoom(new Set([restKey]), '部屋A');

  return { project, below, above };
}

// 壁の形状だけを比較するダイジェスト（wall id・axisCL idはケースごとに新規生成され揃わないため、
// 実座標（axisValue・両端・下地帯）で幾何のみを比較する。scripts/probe/diffPlanRegen.mjs と同じ考え方）。
function wallDigest(graph) {
  return graph.walls.map(w => [
    w.isVertical, Math.round(w.axisValue), Math.round(w.coord1), Math.round(w.coord2),
    Math.round(w.materialRange.lo), Math.round(w.materialRange.hi),
  ].join(':')).sort().join('|');
}

test('【QA V1回帰】runFinishExitBoundary: fmode._lowerGraphが正しい直下階・null・別階のいずれでも直下階の実peekへフォールバックし同じ壁になる', async () => {
  const materialMap = await loadMaterialMap();
  const originalPeek = floorSwapManager.peek;

  async function runCase(lowerGraphFactory, { withStair = true } = {}) {
    const { project, below, above } = makeStairVoidFixture({ withStair });
    floorSwapManager.peek = async (plane) => (plane.id === below.plane.id ? below : null);
    try {
      await runFinishEntryBoundary(above, project);
      const fmode = { materialMap, stairUnderRooms: () => [], _lowerGraph: lowerGraphFactory(below) };
      await runFinishExitBoundary(above, project, fmode, { goingToStructure: false });
    } finally {
      floorSwapManager.peek = originalPeek;
    }
    return wallDigest(above);
  }

  // (a) fmode._lowerGraphが正しい直下階を指す（実peekへのフォールバックは不要）
  const digestA = await runCase(below => below);
  assert.ok(digestA.length > 0, '前提: 壁が生成されている');

  // 前提（QA W1）: 直下階の階段の有無で実際に壁が変わる構成であることを固定する——
  // peekLowerGraphが常にnullを返す壊れた実装でも(a)(b)(c)は「互いに一致」するだけで
  // 検出できない（直下階を一切解決できていない点は3通りとも同じため）。直下階に階段が
  // 無い（＝実装が壊れて直下階を解決できていないのと同じ入力になる）ケースとdigestAが
  // 異なることを先に確認し、この後の一致assertが無意味な比較になっていないことを示す。
  const digestNoLowerStair = await runCase(below => below, { withStair: false });
  assert.notEqual(digestA, digestNoLowerStair,
    '前提: 直下階の階段の有無で壁が変わる構成であること');

  // (b) fmode._lowerGraphが無い（null）→実peekへフォールバックする
  const digestB = await runCase(() => null);
  assert.equal(digestB, digestA, 'キャッシュが無い(null)場合も実peekへフォールバックし同じ壁になる');

  // (c) fmode._lowerGraphが別階を指す（無関係の単独階）→plane不一致で実peekへフォールバックする
  const { graph: otherPlaneGraph } = new Project('other', 'other').addPlane(0, '別階', 'zzz');
  const digestC = await runCase(() => otherPlaneGraph);
  assert.equal(digestC, digestA, '別階を指すキャッシュでもplane不一致で実peekへフォールバックし同じ壁になる');
});

// ---- 省略の印（stamps。階切替で無編集の階の脱出を丸ごと省く。2-3b）----
// 2階建て（below=p1・above=p2。above が自階）。他の平面 p1 のバイト列・世代はメモリ上のスタブ。
// 1回目の脱出は壁が無い状態から壁を作るので自階の正規形が変わり、印は付かない。印が付くのは2回目の脱出から、
// 省くのは3回目から。
async function makeStampFixture() {
  const { project, below, above } = makeStairVoidFixture({ withStair: false });
  const store = new Map([['p1', serializeGraph(below)]]);
  const gens = new Map([['p1', '1']]);
  const stamps = createFinishExitStamps({ loadFloorFn: async (id) => store.get(id) ?? null, generationOf: (id) => gens.get(id) ?? '0' });
  const materialMap = await loadMaterialMap();
  const fmode = { materialMap, stairUnderRooms: () => [], materialOverlayGeneration: overlayGeneration() };
  const peekCalls = [];
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => { peekCalls.push(plane.id); return plane.id === 'p1' ? below : null; };
  await runFinishEntryBoundary(above, project);
  return {
    project, below, above, store, gens, stamps, fmode, peekCalls,
    exit: (opts = {}) => runFinishExitBoundary(above, project, opts.fmode === undefined ? fmode : opts.fmode, { goingToStructure: false, ...opts.args }),
    restore: () => { floorSwapManager.peek = originalPeek; },
  };
}

test('【stamps】(a) stamps 省略: 戻り値は { skipped:false }、壁・undo は従来どおり（無編集の2回目も全部行う）', async () => {
  const f = await makeStampFixture();
  try {
    const r1 = await f.exit();
    assert.deepEqual(r1, { skipped: false });
    assert.ok(f.above.walls.length > 0, '前提: 壁が生成された');
    const u1 = undoManager.peekUndo();
    const r2 = await f.exit();
    assert.deepEqual(r2, { skipped: false });
    assert.notEqual(undoManager.peekUndo(), u1, '省略なしでは2回目も undo エントリを積む');
  } finally { f.restore(); }
});

test('【stamps】(b) 無編集で続けて脱出: 1回目・2回目は全部行い、3回目は省く（undo 不変・バイト列不変・peek なし）', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    const r1 = await f.exit({ args });
    assert.deepEqual(r1, { skipped: false });
    assert.ok(f.above.walls.length >= 1, '前提: 壁が1本以上ある');
    assert.ok(f.above.wallFreshnessKey, '前提: regenerated が真（鮮度キーが書かれた）');
    const r2 = await f.exit({ args }); // この脱出で印が付く
    assert.deepEqual(r2, { skipped: false });
    const undoTop = undoManager.peekUndo();
    const before = serializeGraph(f.above);
    const ids = f.above.walls.map(w => w.id).join(',');
    f.peekCalls.length = 0;
    const r3 = await f.exit({ args });
    assert.deepEqual(r3, { skipped: true });
    assert.equal(undoManager.peekUndo(), undoTop, '省いた脱出は undo エントリを積まない');
    assert.equal(floorBytesEqual(serializeGraph(f.above), before), true, 'バイト列は前後で同一');
    assert.equal(f.above.walls.map(w => w.id).join(','), ids, '壁 id も不変');
    assert.deepEqual(f.peekCalls, [], '他の階を peek していない（何も行っていない）');
    const r4 = await f.exit({ args });
    assert.deepEqual(r4, { skipped: true }, '以後も省く');
  } finally { f.restore(); }
});

test('【stamps】(c) 自階を編集すると次は全部行い、編集が壁へ反映される', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    await f.exit({ args });
    await f.exit({ args });
    assert.deepEqual(await f.exit({ args }), { skipped: true }, '前提: 無編集なら省く');
    const keyBefore = f.above.wallFreshnessKey;
    const digestBefore = wallDigest(f.above);
    f.above.setInteriorWallBacking('101400000009');
    const r = await f.exit({ args });
    assert.deepEqual(r, { skipped: false });
    assert.notEqual(f.above.wallFreshnessKey, keyBefore, '編集（下地材）が鮮度キーへ反映された');
    assert.ok(f.above.walls.length > 0);
    assert.equal(typeof digestBefore, 'string');
  } finally { f.restore(); }
});

test('【stamps】(d) 他の平面のバイト列を内容の違うものへ差し替えて世代を進めると、次は全部行う', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    await f.exit({ args });
    await f.exit({ args });
    assert.deepEqual(await f.exit({ args }), { skipped: true }, '前提: 無編集なら省く');
    runInAction(() => f.below.setDefaultCeilingHeight(2999));
    f.store.set('p1', serializeGraph(f.below));
    f.gens.set('p1', '2');
    assert.deepEqual(await f.exit({ args }), { skipped: false });
  } finally { f.restore(); }
});

test('【stamps】(e) fmode が null（材未ロード）の脱出は印が付かず、次も全部行う', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    for (let i = 0; i < 4; i++) assert.deepEqual(await f.exit({ fmode: null, args }), { skipped: false }, `${i + 1}回目`);
    assert.deepEqual(await f.stamps.canSkip(f.above, f.project), { skip: false, reason: 'noStamp' });
  } finally { f.restore(); }
});

test('【stamps】(e2) 材マスタ未ロード（regenerated:false）の脱出は、世代が合っていても印が付かない', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    const fm = { materialMap: null, stairUnderRooms: () => [], materialOverlayGeneration: overlayGeneration() };
    for (let i = 0; i < 3; i++) await f.exit({ fmode: fm, args });
    assert.deepEqual(await f.stamps.canSkip(f.above, f.project), { skip: false, reason: 'noStamp' });
  } finally { f.restore(); }
});

test('【stamps】直下階キャッシュ: 突入後に直下階が書き換わった（世代が進んだ）fmode では印が付かず、書換えが無ければ付く', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    const cached = (gen) => ({ ...f.fmode, _lowerGraph: f.below, lowerGraphGeneration: gen });
    // 書換え無し: 従来どおり2回目で印が付き、3回目は省く
    await f.exit({ fmode: cached('1'), args });
    await f.exit({ fmode: cached('1'), args });
    assert.deepEqual(await f.exit({ fmode: cached('1'), args }), { skipped: true });
    // 突入後に直下階の IDB が書き換わった（世代が進む）。キャッシュは '1' のまま
    runInAction(() => f.below.setDefaultCeilingHeight(2999)); // 内容の違う直下階へ
    f.store.set('p1', serializeGraph(f.below));
    f.gens.set('p1', '2');
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.exit({ fmode: cached('1'), args }), { skipped: false }, `${i + 1}回目`);
    assert.deepEqual(await f.stamps.canSkip(f.above, f.project), { skip: false, reason: 'noStamp' });
  } finally { f.restore(); }
});

test('【stamps】(f) 脱出の途中で例外 → 例外は上へ伝わり、印は付かない（以前の印も消える）', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps };
    await f.exit({ args });
    await f.exit({ args });
    assert.equal((await f.stamps.canSkip(f.above, f.project)).skip, true, '前提: 印がある');
    f.above.setInteriorWallBacking('101400000009'); // 編集して全部行う側へ進ませる
    const boom = { get materialMap() { throw new Error('boom'); }, materialOverlayGeneration: overlayGeneration() };
    await assert.rejects(() => f.exit({ fmode: boom, args }), /boom/);
    assert.deepEqual(await f.stamps.canSkip(f.above, f.project), { skip: false, reason: 'noStamp' });
  } finally { f.restore(); }
});

test('【stamps】(g) goingToStructure:true と stamps を同時に渡しても壊れない', async () => {
  const f = await makeStampFixture();
  try {
    const args = { stamps: f.stamps, goingToStructure: true };
    assert.deepEqual(await f.exit({ args }), { skipped: false });
    assert.deepEqual(await f.exit({ args }), { skipped: false });
    assert.ok(f.above.walls.length > 0);
  } finally { f.restore(); }
});

// ---- 配線（ソース走査。App.jsx・finishBoundary.js） ----
const readSrc = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8');
const codeLines = (src) => src.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

test('【配線】App.jsx: finish.exit は floorSwitch のときだけ保管庫を渡す／保管庫は本物の loadFloor・floorWriteGeneration で作る', () => {
  const code = codeLines(readSrc('App.jsx'));
  assert.match(code, /^\s*exit: \(graph, \{ toMode, floorSwitch \}\) => runFinishExitBoundary\(graph, project, modeRef\.current, \{ goingToStructure: toMode === 'structure', stamps: floorSwitch \? getFinishExitStamps\(\) : null, saveActiveFloorFn: saveFloor \}\),$/m);
  assert.match(code, /createFinishExitStamps\(\{ loadFloorFn: loadFloor, generationOf: floorWriteGeneration \}\)/);
  assert.match(code, /^\s*const finishExitStampsRef = useRef\(null\);$/m);
});

test('【配線】App.jsx: floorSwitch:true で exit を呼ぶのは switchFloorKeepingMode だけ（handleModeChange・handleFloorSwitch は false）', () => {
  const code = codeLines(readSrc('App.jsx'));
  const trues = code.split(/\r?\n/).filter(l => /\.exit\?\.\(.*floorSwitch: true/.test(l));
  assert.equal(trues.length, 1);
  const body = (name) => {
    const s = code.indexOf(`async function ${name}(`);
    assert.ok(s >= 0, name);
    const e = code.indexOf('\n  }\n', s);
    return code.slice(s, e);
  };
  assert.match(body('switchFloorKeepingMode'), /exit\?\.\(graph, \{ toMode: appMode, floorSwitch: true \}\)/);
  assert.match(body('handleFloorSwitch'), /exit\?\.\(project\.activeGraph, \{ toMode: 'floorplan', floorSwitch: false \}\)/);
  assert.match(body('handleModeChange'), /exit\?\.\(graph, \{ toMode: newMode, floorSwitch: false \}\)/);
});

test('【配線】finishBoundary.js: canSkip は resolveStairContext より前、endFullExit は refreshWallsAllFloors より後', () => {
  const src = readSrc('finish/finishBoundary.js');
  const s = src.indexOf('export async function runFinishExitBoundary');
  const code = codeLines(src.slice(s));
  const idx = (t) => { const i = code.indexOf(t); assert.ok(i >= 0, t); return i; };
  assert.ok(idx('stamps.canSkip(') < idx('await resolveStairContext('));
  assert.ok(idx('stamps.beginFullExit(') < idx('await resolveStairContext('));
  assert.ok(idx('stamps.endFullExit(') > idx('await refreshWallsAllFloors('));
  assert.match(code, /stamps\.endFullExit\(graph, project, stampProbe, \{ regenerated \}\)/);
});
