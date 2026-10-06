// finish/eccentricityFloorSync.js（propagateCLEccentricities）の回帰テスト。
// フィクスチャは finishBoundary.test.js の makeEccentricWallFixture（INTERIOR_WALLの組み立て）・
// makeStairVoidFixture（2階建て・吹抜け連動の最小構成）を参考にした2階建て版
// （段階(e)・2026-09-26。undoRecords方式への切替＝amend廃止を確認する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomFeature } from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { runFinishEntryBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { propagateCLEccentricities, shaftOrStairLinks } from './eccentricityFloorSync.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

// 直下階（below）: 部屋A1/部屋B1をym（y=3000）で分割。自階（above。アクティブ）: 吹抜け/部屋A2を
// 同座標のymで分割し、吹抜け側にRoomFeature.VOIDを立てる——吹抜けは「その階と直下階」で連動する
// （eccentricityFloorSync.js冒頭コメント参照）ため、この最小構成だけで連動先1階を作れる
// （階段連動（stair）はSTAIR/STAIR_VOID一式が要るぶん重いため、より軽い吹抜け（void）側で確認する）。
async function makeVoidLinkedTwoFloorFixture() {
  const project = new Project('proj', 'test');
  const { graph: below } = project.addPlane(0, '1階', 'p1');
  const { graph: above } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';

  // reconcileOnFinishEntry・pullCLEccentricities（runFinishEntryBoundary内。両方とも自階以外の全Planeを
  // peekする）が直下階・自階の両方をpeekしうるため、エントリ境界を呼ぶ前に両方差し替えておく——
  // pullCLEccentricitiesのplanePeeksは「呼び出し時に渡されたgraph引数」を自階として扱うため
  // （project.activePlaneIdではない）、below側のentry境界呼び出し中もaboveがpeek対象になる
  // （この時点ではaboveはまだ空グラフだが、peekが解決できれば足りる）。
  floorSwapManager.peek = async (plane) => {
    if (plane.id === below.plane.id) return below;
    if (plane.id === above.plane.id) return above;
    return null;
  };

  const bx0 = below.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const bx1 = below.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const by0 = below.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const bym = below.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const by1 = below.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const bKeyA = `${bx0.id}:${by0.id}:${bx1.id}:${bym.id}`;
  const bKeyB = `${bx0.id}:${bym.id}:${bx1.id}:${by1.id}`;
  below.addRoom(new Set([bKeyA]), '部屋A1');
  below.addRoom(new Set([bKeyB]), '部屋B1');
  below.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  await runFinishEntryBoundary(below, project);

  const ax0 = above.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ax1 = above.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const ay0 = above.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const aym = above.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const ay1 = above.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
  const aKeyVoid = `${ax0.id}:${ay0.id}:${ax1.id}:${aym.id}`;
  const aKeyA = `${ax0.id}:${aym.id}:${ax1.id}:${ay1.id}`;
  above.addRoom(new Set([aKeyVoid]), '吹抜け').setFeature(RoomFeature.VOID);
  above.addRoom(new Set([aKeyA]), '部屋A2');
  above.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  await runFinishEntryBoundary(above, project);

  const materialMap = await loadMaterialMap();
  return { project, below, above, aym, materialMap };
}

// ---- QA F4/T5: 昇降路（昇降機）は階段規則（設置階〜最上階）で連動することの結線固定 ----
// 3階建て: 1階（below。ym位置に昇降路なし＝通常部屋のみ）／2階（active。ym位置に昇降機）／
// 3階（top。ym位置にも昇降機＝昇降路が上階へ続く）。階段と同じ「設置階〜最上階」ルールなら、
// 2階で偏芯を指定すると3階（上）へは伝播するが、1階（下。昇降機が無い）へは伝播しないはず
// （shaftOrStairLinksがSTAIR/STAIR_VOIDと同格でisShaftFeatureを見ている、という結線を
// 全体実行で固定する——単体テストのshaftOrStairLinks（純関数）だけでは呼び出し側
// linkFlagsOnGraph／linkedGroupForの結線までは守れない）。
async function makeEvLinkedThreeFloorFixture() {
  const project = new Project('proj', 'test');
  const { graph: below }  = project.addPlane(0,    '1階', 'p1');
  const { graph: active } = project.addPlane(3000, '2階', 'p2');
  const { graph: top }    = project.addPlane(6000, '3階', 'p3');
  project.activePlaneId = 'p2';

  floorSwapManager.peek = async (plane) => {
    if (plane.id === below.plane.id)  return below;
    if (plane.id === active.plane.id) return active;
    if (plane.id === top.plane.id)    return top;
    return null;
  };

  function buildGrid(graph) {
    const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
    const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
    const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
    const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
    const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: false, discipline: Discipline.ARCH });
    return { x0, x1, y0, ym, y1 };
  }

  // 1階: ym位置は通常の2部屋（昇降路なし）
  const b = buildGrid(below);
  below.addRoom(new Set([`${b.x0.id}:${b.y0.id}:${b.x1.id}:${b.ym.id}`]), '部屋1A');
  below.addRoom(new Set([`${b.x0.id}:${b.ym.id}:${b.x1.id}:${b.y1.id}`]), '部屋1B');
  below.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  await runFinishEntryBoundary(below, project);

  // 2階（active）: ym位置の下側を昇降機にする
  const a = buildGrid(active);
  active.addRoom(new Set([`${a.x0.id}:${a.y0.id}:${a.x1.id}:${a.ym.id}`]), '昇降路').setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  active.addRoom(new Set([`${a.x0.id}:${a.ym.id}:${a.x1.id}:${a.y1.id}`]), '部屋2B');
  active.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  await runFinishEntryBoundary(active, project);

  // 3階: ym位置の下側にも昇降機（昇降路が上へ続く）
  const t = buildGrid(top);
  top.addRoom(new Set([`${t.x0.id}:${t.y0.id}:${t.x1.id}:${t.ym.id}`]), '昇降路').setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  top.addRoom(new Set([`${t.x0.id}:${t.ym.id}:${t.x1.id}:${t.y1.id}`]), '部屋3B');
  top.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  await runFinishEntryBoundary(top, project);

  const materialMap = await loadMaterialMap();
  return { project, below, active, top, aym: a.ym, materialMap };
}

test('propagateCLEccentricities【QA F4/T5】: 昇降路（昇降機）に接するCLの偏芯は階段規則で複製される——昇降機が続く上階へは伝播し、昇降機の無い直下階へは伝播しない', async () => {
  const { project, below, active, top, aym, materialMap } = await makeEvLinkedThreeFloorFixture();
  active.setCLEccentricity(aym.id, { mode: 'face', value: 0, side: 1, backing: '' });

  const saveCalls = [];
  const saveFloorFn = async (planeId) => { saveCalls.push(planeId); };

  await propagateCLEccentricities(project, active, [aym.id], { materialMap, saveFloorFn });

  assert.deepEqual(saveCalls, [top.plane.id], '昇降路が続く上階（3階）へは伝播し、昇降路の無い直下階（1階）へは伝播しないはず');
  assert.ok(top.clEccentricities.size > 0, '3階に偏芯レコードが複製されているはず');
  assert.equal(below.clEccentricities.size, 0, '1階には偏芯レコードが複製されないはず');
});

test('propagateCLEccentricities: undoRecordsを渡すと保存した階ごとに{planeId,before,after}がsaveの後に積まれ、peekUndoは不変（amendしない。段階(e)・2026-09-26）', async () => {
  const { project, below, above, aym, materialMap } = await makeVoidLinkedTwoFloorFixture();
  above.setCLEccentricity(aym.id, { mode: 'face', value: 0, side: 1, backing: '' });

  const saveCalls = [];
  const saveFloorFn = async (planeId) => { saveCalls.push(planeId); };
  const undoRecords = [];
  const beforeTop = undoManager.peekUndo();

  await propagateCLEccentricities(project, above, [aym.id], { materialMap, undoRecords, saveFloorFn });

  assert.deepEqual(saveCalls, [below.plane.id], '吹抜け連動先の直下階が1回保存される');
  assert.equal(undoRecords.length, 1);
  assert.equal(undoRecords[0].planeId, below.plane.id);
  assert.ok(undoRecords[0].before, 'beforeバイトが記録される');
  assert.ok(undoRecords[0].after, 'afterバイトが記録される');
  assert.equal(undoManager.peekUndo(), beforeTop, 'amendしないためundoスタックは変化しない');
});

test('propagateCLEccentricities: undoRecords省略時は従来どおり保存のみでundoRecords関連の処理はしない', async () => {
  const { project, below, above, aym, materialMap } = await makeVoidLinkedTwoFloorFixture();
  above.setCLEccentricity(aym.id, { mode: 'face', value: 0, side: 1, backing: '' });

  const saveCalls = [];
  const saveFloorFn = async (planeId) => { saveCalls.push(planeId); };
  await assert.doesNotReject(() => propagateCLEccentricities(project, above, [aym.id], { materialMap, saveFloorFn }));
  assert.deepEqual(saveCalls, [below.plane.id]);
});

test('【失敗系】propagateCLEccentricities: clIds空配列なら何もしない（saveFloorFnも呼ばれずundoRecordsも変化しない）', async () => {
  const { project, above, materialMap } = await makeVoidLinkedTwoFloorFixture();
  const saveCalls = [];
  const saveFloorFn = async (planeId) => { saveCalls.push(planeId); };
  const undoRecords = [];
  await propagateCLEccentricities(project, above, [], { materialMap, undoRecords, saveFloorFn });
  assert.deepEqual(saveCalls, []);
  assert.deepEqual(undoRecords, []);
});

// ---- shaftOrStairLinks（純関数）: 昇降路（昇降機）は階段側の連動ルールに合流する（裁定Q7） ----
test('shaftOrStairLinks: feature=elevatorEquipment の部屋に接するCLは stair フラグが立ち void フラグは立たない', () => {
  const flags = shaftOrStairLinks([{ feature: RoomFeature.ELEVATOR_EQUIPMENT }]);
  assert.deepEqual(flags, { stair: true, void: false });
});

test('shaftOrStairLinks: VOID の部屋に接するCLは void のみ立つ', () => {
  const flags = shaftOrStairLinks([{ feature: RoomFeature.VOID }]);
  assert.deepEqual(flags, { stair: false, void: true });
});

test('shaftOrStairLinks: 通常部屋（feature=null）に接するCLはどちらも立たない', () => {
  const flags = shaftOrStairLinks([{ feature: null }]);
  assert.deepEqual(flags, { stair: false, void: false });
});
