// 線種変更の移籍一本化（260929_線種変更の移籍一本化.md ステップ0）: §2.2 の全ケースと
// 「降格すると他の平面に同じ id の線ができる」を、現状で失敗するテストとして固定する。
// 各テストの期待値は裁定後（§3・§4）の仕様。現状の製品コードでは赤になる（通常test実行で確認済み）
// ため、フルスイートを赤にしないよう { todo: '…ステップN で解消' } にする。該当ステップで todo を外す。
// 対照テスト（現状で緑。裁定後も緑のまま）は todo にしない。
// 他の平面の読み出しは本番同型 peek（保存バイトから restoreGraph）で行う。生きたグラフは渡さない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, centerLineKind, StructuralMaterialType } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import {
  ERR_CL_CONVERT_DUP_FLOOR, ERR_CL_CONVERT_SAME_ID_FLOOR, ERR_CL_CONVERT_DUP, ERR_CL_DUPLICATE,
} from '../error.js';
import { worldToCell } from '../finish/gridCells.js';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { scanProjectLineIds } from '../lineIdUniqueness.js';
import {
  addCenterLineFromDialog, promoteCenterToGridWithUndo, demoteGridToCenterWithUndo, bakeCLValue,
  setCenterLineStructuralListener,
} from './centerLineOps.js';
import { withProductionPeek, decodeFloor } from './centerLineTestFixtures.js';

// 裁定 Q9 の文言（ダイアログからの昇格時）。error.js に定数が入るまでは文字列で持つ。
const MSG_DIALOG_PROMOTED = '同位置の中心線を通り芯にしました。';

// 全部屋の全セルキーが、実在する線（自階＋共有グラフ）の id だけで構成されているか。
// finish/roomReinterpret.js findUnresolvableCells は「これから id を削除したら壊れるセル」の先読みで、
// 既に切れている参照は検出しない（QA 指摘）ため、ここで直接照合する。
// 復元した他平面に「その平面固有の中心線」（通り芯を除く）が座標 value に残っているか。
// graph.centerLines は共有グラフの通り芯を合流して返すため、そのまま使うと吸収後の通り芯を
// 「残った中心線」と誤判定する。
function hasOwnCenterLineAt(graph, centerLineType, value) {
  return graph.centerLines.some(c =>
    centerLineKind(c) === 'center' && c.centerLineType === centerLineType && Math.abs(c.value - value) < 1);
}

function allRoomCellRefsResolve(graph, project) {
  const ids = new Set([...graph.centerLines, ...project.structGraph.centerLines].map(c => c.id));
  return graph.rooms.every(r => [...r.cells].every(k => k.split(':').every(id => ids.has(id))));
}

// 1階に中心線 X=3000（cl）が乗り、その上に壁1本、左右に部屋（セルキーが cl.id を含む）がある
// 最小構成（指示書§2.2の条件そのもの）。
function makeFloorWithCenterLineWallAndRooms(planeId = 'p1', planeName = '1階', elevation = 0) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(elevation, planeName, planeId);
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false }); // 中心線
  graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false });
  const wall = graph.addWall(cl, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  const leftKey  = worldToCell(1500, 1500, graph).key;
  const rightKey = worldToCell(4500, 1500, graph).key;
  const leftRoom  = graph.addRoom(new Set([leftKey]), '左');
  const rightRoom = graph.addRoom(new Set([rightKey]), '右');
  assert.ok(leftKey.includes(cl.id) && rightKey.includes(cl.id), '前提: 左右のセルキーが中心線の id を含む');
  return { project, graph, cl, wall, y0, y1, leftKey, rightKey, leftRoom, rightRoom };
}

// 2階建て（p1・p2）だけの最小構成。他の平面の同座標チェック（ケース2）用。
function makeTwoFloors() {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  return { project, p1, p2 };
}

// 2階建て・structGraph に perp軸(Y)の通り芯2本＋対象軸(V)の通り芯2本（isLastGridOnAxis対策）を
// 持つ最小構成（centerLineOps.test.js の同名ヘルパと同型。降格の分身の検証に使う）。
function makeTwoFloorsWithGridCL() {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  return { project, p1, p2, y0, y3, cl };
}

const dialogPayloadV = (value) => ({
  clDialog: { type: 'vertical', worldCoord: Array.isArray(value) ? value[0] : value, perpCoord: 0 },
  value, kind: 'struct', refId: null, refOffset: 0,
});

// QA指摘4のY軸文言テスト用（ui/AddCLDialog.jsx :29 と同じくY軸は符号反転して表示する）。
const dialogPayloadH = (value) => ({
  clDialog: { type: 'horizontal', worldCoord: Array.isArray(value) ? value[0] : value, perpCoord: 0 },
  value, kind: 'struct', refId: null, refOffset: 0,
});

// ---- ケース1: ダイアログで同位置に通り芯（現状は削除して作り直す。壁・部屋の参照が壊れる） ----

// 単一平面（他平面が無い）ため scanProjectLineIds の peek は呼ばれない想定——呼ばれたら想定外として失敗させる。
const noOtherPlanesPeek = async () => { throw new Error('想定外: このprojectには他平面が無いのでpeekは呼ばれないはず'); };

test(
  'addCenterLineFromDialog: 既存の中心線と同位置に通り芯を指定すると、メニューの昇格と同じく移籍になり、壁・部屋の参照が保たれ undo で戻る（指示書§2.2 ケース1・裁定Q7〜Q9）',
  async () => {
    const { project, graph, cl } = makeFloorWithCenterLineWallAndRooms();
    const oldId = cl.id;
    const beforeTop = undoManager.peekUndo();

    const result = await addCenterLineFromDialog(graph, project, dialogPayloadV(3000), null);

    assert.equal(result.done, true);
    assert.equal(graph.walls.length, 1, '期待: 壁は1本のまま（現状は削除連鎖で0本になる）');
    const grid = project.structGraph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 3000);
    assert.equal(grid?.id, oldId, '期待: idは同じまま移籍する（現状は削除+新規作成で新しいidになる）');
    assert.equal(allRoomCellRefsResolve(graph, project), true, '期待: 部屋のセル参照は切れない（現状は左右とも切れる）');
    assert.equal(result.toast, MSG_DIALOG_PROMOTED, '期待: 裁定Q9の文言');
    assert.notEqual(undoManager.peekUndo(), beforeTop, '期待: 確定でundoスタックが+1される');
    assert.deepEqual(
      await scanProjectLineIds(project, { activeGraph: graph, peek: noOtherPlanesPeek }), [],
      '期待: 確定後も線idはプロジェクト全体で一意（重複0件）',
    );

    undoManager.undo();
    assert.equal(graph.walls.length, 1, '期待: undoで壁が元どおりになる（現状は戻らない）');
    assert.equal(graph.centerLines.some(c => c.id === oldId && c.labeled === false), true, '期待: undoで同じidの中心線に戻る');
    assert.equal(allRoomCellRefsResolve(graph, project), true, '期待: undo後もセル参照が解決する');
    assert.deepEqual(
      await scanProjectLineIds(project, { activeGraph: graph, peek: noOtherPlanesPeek }), [],
      '期待: undo後も線idは一意',
    );

    undoManager.redo();
    assert.equal(graph.walls.length, 1, '期待: redoで壁は1本のまま');
    const gridAfterRedo = project.structGraph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 3000);
    assert.equal(gridAfterRedo?.id, oldId, '期待: redoで通り芯が同idのまま共有グラフに戻る');
    assert.equal(allRoomCellRefsResolve(graph, project), true, '期待: redo後もセル参照が解決する');
    assert.deepEqual(
      await scanProjectLineIds(project, { activeGraph: graph, peek: noOtherPlanesPeek }), [],
      '期待: redo後も線idは一意',
    );
  },
);

test('promoteCenterToGridWithUndo（メニュー経由）: 同じ条件で壁は1本のまま・idは移籍で維持され、undoで元どおり（対照。現状で緑）', async () => {
  const { project, graph, cl, wall } = makeFloorWithCenterLineWallAndRooms();
  const oldId = cl.id;
  const beforeTop = undoManager.peekUndo();

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, {});

  assert.equal(toast, null);
  assert.equal(graph.walls.length, 1, '壁は1本のまま');
  assert.equal(graph.walls[0].id, wall.id);
  assert.equal(graph.centerLines.some(c => c.id === oldId && c.labeled === true), true, '同じidのまま通り芯へ移籍している');
  assert.equal(allRoomCellRefsResolve(graph, project), true, '部屋のセル参照は切れない');
  assert.notEqual(undoManager.peekUndo(), beforeTop, 'undoが積まれる');

  undoManager.undo();
  assert.equal(graph.walls.length, 1, 'undoで壁は保持されたまま');
  assert.equal(graph.centerLines.some(c => c.id === oldId && c.labeled === false), true, 'undoで中心線に戻る');
  assert.equal(allRoomCellRefsResolve(graph, project), true, 'undo後もセル参照が解決する');
});

// ---- ケース2: 他の平面(2階)に同座標の線がある場合の、ダイアログ経由3経路 ----
// 裁定 Q1〜Q3: 昇格は他の平面の同座標の「中心線」を吸収し、「補助線」は拒否する。
// 単体追加・スパン配列も同じ規則（2026-09-30 裁定: 通常追加も中心線は吸収。Q4〜Q6 の「拒否して
// 値と平面名を出す」は補助線・保護される梁芯が相手のとき）。

test(
  'addCenterLineFromDialog: 他の平面(2階)に同座標の中心線がある場合、ダイアログの昇格は拒否せず吸収する（指示書§2.2 ケース2a・裁定Q1）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const p2cl = p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false });
    const y1 = p2.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false });
    p2.addWall(p2cl, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn })
    );

    assert.equal(result.done, true, '期待: 吸収して成功する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(
      hasOwnCenterLineAt(decoded, CenterLineType.VERTICAL, 3000),
      false, '期待: 2階の同座標の中心線は吸収されて残らない（現状は通り芯と中心線が同座標で並ぶ）',
    );
    assert.equal(decoded.walls.length, 1, '期待: 2階の壁は残る');
    assert.equal(decoded.walls[0].axisValue, 3000, '期待: 2階の壁の幾何は変わらない');
    const grid = project.structGraph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 3000);
    assert.equal(grid?.id, p1cl.id, '期待: 通り芯のidは1階の中心線のidのまま');
    assert.equal(result.toast, MSG_DIALOG_PROMOTED, '期待: 裁定Q9の文言');
  },
);

test(
  'addCenterLineFromDialog: 他の平面(2階)に同座標の補助線がある場合、通り芯の単体追加は拒否される（指示書§2.2 ケース2b・裁定Q3〜Q5）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, lineType: 'dashed' });
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null)
    );

    assert.equal(result.done, false, '期待: 拒否される（現状は通る＝2階に通り芯と補助線が同座標で並ぶ）');
    assert.match(result.toast ?? '', /2階/, '期待: 平面名を出す');
    assert.match(result.toast ?? '', /通り芯を追加できません/, '期待: 裁定Q5の追加用の文言');
    assert.equal(project.structGraph.centerLines.some(c => c.value === 3000), false, '期待: 通り芯は追加されない');
  },
);

test(
  'addCenterLineFromDialog: スパン配列で一部の値だけ2階の補助線と重なる場合、全体が拒否され値と平面名を出す（指示書§2.2 ケース2c・裁定Q6）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    p2.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, lineType: 'dashed' }); // 3本のうち2000だけ2階と重なる
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV([1000, 2000, 3000]), null)
    );

    assert.equal(result.done, false, '期待: 2000が2階と重なるため全体を拒否する（現状は3本とも追加される）');
    assert.match(result.toast ?? '', /2000/, '期待: 重なった値を出す');
    assert.match(result.toast ?? '', /2階/, '期待: 平面名を出す');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 1本も追加されない');
  },
);

test(
  'addCenterLineFromDialog: Y軸スパンで一部の値だけ2階の補助線と重なる場合、文言の値は画面表示（符号反転・整数）に合わせる（QA指摘4）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    p2.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, lineType: 'dashed' }); // ワールドY=2000（画面表示は-2000）
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadH([1000, 2000, 3000]), null)
    );

    assert.equal(result.done, false, '期待: 2000が2階と重なるため全体を拒否する');
    assert.match(result.toast ?? '', /Y=-2000/, `期待: Y軸は画面表示どおり符号反転した整数（実際: ${result.toast}）`);
    assert.equal(/Y=2000\b/.test(result.toast ?? ''), false, '期待: 符号反転前の値は出さない');
    assert.match(result.toast ?? '', /2階/, '期待: 平面名を出す');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 1本も追加されない');
  },
);

// 他の平面(2階)の同座標に中心線＋その上の壁がある2階建て。単体追加・スパン配列の吸収の検証用。
function makeTwoFloorsWithSecondFloorCenterLineWall(x) {
  const { project, p1, p2 } = makeTwoFloors();
  const p2cl = p2.addCenterLine(CenterLineType.VERTICAL, x, { labeled: false });
  const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false });
  const y1 = p2.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false });
  p2.addWall(p2cl, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };
  return { project, p1, p2, p2cl, store, saveFloorFn };
}

test(
  'addCenterLineFromDialog: 他の平面(2階)に同座標の中心線がある場合、通り芯の単体追加は拒否せず吸収し、2階の壁は通り芯を軸に残る（2026-09-30 裁定）',
  async () => {
    const { project, p1, p2, store, saveFloorFn } = makeTwoFloorsWithSecondFloorCenterLineWall(3000);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn })
    );

    assert.equal(result.done, true, '期待: 吸収して成功する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(
      hasOwnCenterLineAt(decoded, CenterLineType.VERTICAL, 3000),
      false, '期待: 2階の同座標の中心線は吸収されて残らない（現状は通り芯と中心線が同座標で並ぶ）',
    );
    assert.equal(decoded.walls.length, 1, '期待: 2階の壁は残る');
    assert.equal(decoded.walls[0].axisValue, 3000, '期待: 2階の壁の幾何は変わらない');
    const grid = project.structGraph.centerLines.find(c => c.value === 3000);
    assert.equal(project.structGraph.centerLines.filter(c => c.value === 3000).length, 1, '期待: 通り芯は1本');
    // QA指摘9: 壁は通り芯そのもの（新id）を軸にする（吸収前の自平面固有の中心線idのまま残らない）。
    assert.equal(decoded.walls[0].axisCL.id, grid.id, '期待: 2階の壁のaxisCL.idは通り芯のidと一致する');
    assert.deepEqual(
      await scanProjectLineIds(project, { activeGraph: p1, peek: async (plane) => decodeFloor(project, plane, store.get(plane.id)) }),
      [], '期待: 確定後も線idはプロジェクト全体で一意（重複0件）',
    );
  },
);

test(
  'addCenterLineFromDialog: スパン配列で一部の値が2階の中心線と重なる場合、その中心線を吸収して全本を追加する（2026-09-30 裁定）',
  async () => {
    const { project, p1, p2, store, saveFloorFn } = makeTwoFloorsWithSecondFloorCenterLineWall(2000);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV([1000, 2000, 3000]), null, { saveFloorFn })
    );

    assert.equal(result.done, true, '期待: 吸収して成功する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(
      hasOwnCenterLineAt(decoded, CenterLineType.VERTICAL, 2000),
      false, '期待: 2階の X=2000 の中心線は吸収されて残らない',
    );
    assert.equal(decoded.walls.length, 1, '期待: 2階の壁は残る');
    assert.equal(decoded.walls[0].axisValue, 2000, '期待: 2階の壁の幾何は変わらない');
    const grid = project.structGraph.centerLines.find(c => c.value === 2000);
    assert.deepEqual(
      project.structGraph.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL).map(c => c.value).sort((a, b) => a - b),
      [1000, 2000, 3000], '期待: 3本とも追加される',
    );
    // QA指摘9: 壁は通り芯そのもの（新id）を軸にする。
    assert.equal(decoded.walls[0].axisCL.id, grid.id, '期待: 2階の壁のaxisCL.idは通り芯のidと一致する');
    assert.deepEqual(
      await scanProjectLineIds(project, { activeGraph: p1, peek: async (plane) => decodeFloor(project, plane, store.get(plane.id)) }),
      [], '期待: 確定後も線idはプロジェクト全体で一意（重複0件）',
    );
  },
);

test(
  'addCenterLineFromDialog: スパン配列で同じ他平面の中心線を2本（X=2000・3000）吸収すると、両方とも吸収され1本も残らない（QA指摘1・平面単位化の回帰確認）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false });
    const y1 = p2.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false });
    const walls = [];
    for (const x of [2000, 3000]) {
      const c = p2.addCenterLine(CenterLineType.VERTICAL, x, { labeled: false });
      walls.push(p2.addWall(c, 0, true, y0, 0, y1, 0, { isExteriorWall: false }));
    }
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };
    const beforeTop = undoManager.peekUndo();

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV([2000, 3000]), null, { saveFloorFn })
    );

    assert.equal(result.done, true, '期待: 両方とも吸収して成功する');
    let decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    const ownVerticalCount = decoded.centerLines.filter(c =>
      c.centerLineType === CenterLineType.VERTICAL && !project.structGraph.shapeMap.has(c.id)).length;
    assert.equal(ownVerticalCount, 0, '期待: 2階の自平面固有の縦中心線は0本（旧実装は1本残った）');
    assert.equal(decoded.walls.length, 2, '期待: 2階の壁は2本とも残る');
    for (const w of decoded.walls) {
      assert.equal(project.structGraph.shapeMap.has(w.axisCL.id), true, `期待: 壁(axisValue=${w.axisValue})は通り芯を軸にする`);
    }
    assert.deepEqual(
      project.structGraph.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL).map(c => c.value).sort((a, b) => a - b),
      [2000, 3000], '期待: 2本とも通り芯化される',
    );
    assert.notEqual(undoManager.peekUndo(), beforeTop, '期待: undoが積まれる');

    undoManager.undo();
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    const ownVerticalAfterUndo = decoded.centerLines.filter(c =>
      c.centerLineType === CenterLineType.VERTICAL && !project.structGraph.shapeMap.has(c.id)).length;
    assert.equal(ownVerticalAfterUndo, 2, '期待: undoで2階の自平面固有の中心線が2本とも元に戻る');
    assert.equal(decoded.walls.length, 2, '期待: undo後も2階の壁は2本とも残る');
    for (const w of decoded.walls) {
      assert.equal(project.structGraph.shapeMap.has(w.axisCL.id), false, `期待: undoで壁(axisValue=${w.axisValue})は自平面固有の中心線に戻る`);
    }
    assert.equal(project.structGraph.centerLines.length, 0, '期待: undoで通り芯は共有グラフから消える');
  },
);

test('promoteCenterToGridWithUndo（メニュー経由）: 他の平面に同座標の補助線があれば拒否される（対照。裁定Q3。現状で緑）', async () => {
  const { project, p1, p2 } = makeTwoFloors();
  const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
  p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, lineType: 'dashed' });
  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

  const { toast } = await withProductionPeek(project, store, () => promoteCenterToGridWithUndo(p1, project, p1cl, {}));

  assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: p2.plane.name, kind: 'aux' }]));
  assert.equal(project.structGraph.centerLines.length, 0, '昇格は行われない');
});

test(
  'promoteCenterToGridWithUndo（メニュー経由）: 他の平面の同座標の中心線は拒否せず吸収し、その平面の壁は通り芯を軸に残る（裁定Q1・Q2）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const p2cl = p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const p2clId = p2cl.id;
    const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false });
    const y1 = p2.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false });
    p2.addWall(p2cl, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

    const { toast } = await withProductionPeek(project, store, () =>
      promoteCenterToGridWithUndo(p1, project, p1cl, { saveFloorFn })
    );

    assert.equal(toast, null, '期待: 吸収して成功する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    // decoded.centerLines は自階＋共有グラフ（通り芯）を合流するため、昇格後は必ずvalue=3000の
    // 通り芯（新たにstructGraphへ移ったp1cl）を含んでしまい「吸収されて残らない」判定に使えない
    // ——吸収対象だったp2cl自身（自階固有の中心線）がshapeMapから消えたかで確認する。
    assert.equal(decoded.shapeMap.has(p2clId), false, '期待: 2階の同座標の中心線は吸収されて残らない');
    assert.equal(decoded.walls.length, 1, '期待: 2階の壁は残る');
    assert.equal(decoded.walls[0].axisValue, 3000, '期待: 2階の壁の幾何は変わらない');
  },
);

// ---- ケース3: 平面をidを保ったまま複製した後の昇格 ----

test(
  'promoteCenterToGridWithUndo: idを保ったまま複製した平面を複製先で移動した後、複製元で昇格すると、同じidの線を検出して拒否し複製先の壁は動かない（指示書§2.2 複製後の昇格・裁定Q11）',
  async () => {
    const { project, graph: p1, cl } = makeFloorWithCenterLineWallAndRooms('p1', '1階');
    const clId = cl.id;
    const bytesForDup = serializeGraph(p1);
    const { graph: p1Dup, plane: dupPlane } = project.addPlane(0, '1階複製', 'p1dup');
    restoreGraph(p1Dup, bytesForDup);
    const dupCl = p1Dup.shapeMap.get(clId);
    runInAction(() => bakeCLValue(dupCl, 3500));
    assert.equal(p1Dup.walls[0].axisValue, 3500, '前提: 複製先の壁は移動後3500にある');

    const store = new Map([[dupPlane.id, serializeGraph(p1Dup)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

    const { toast } = await withProductionPeek(project, store, () =>
      promoteCenterToGridWithUndo(p1, project, cl, { saveFloorFn })
    );

    // 裁定Q11: 同じ id の線が他の平面にあれば、書き換えずに拒否して平面名を出す。
    assert.ok(toast, '期待: 同じidの線が他の平面にあるため拒否される');
    assert.match(toast, /1階複製/, '期待: 拒否の文言に平面名を出す');
    assert.equal(p1.centerLines.some(c => c.id === clId && c.labeled === false), true, '期待: 拒否時は複製元の中心線を書き換えない');
    const decoded = decodeFloor(project, dupPlane, store.get(dupPlane.id));
    assert.equal(decoded.walls[0].axisValue, 3500, '期待: 複製先の壁は動かない');
  },
);

// ---- ケース4: 降格が他の平面に作る複製（分身）の id ----

test(
  '降格すると他の平面に新しいidの中心線ができる（分身の廃止）。壁の幾何は変わらない（指示書§2.3・裁定Q1・ステップ3）',
  async () => {
    const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
    const clId = cl.id;
    p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });

    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

    const { toast } = await withProductionPeek(project, store, () =>
      demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn })
    );
    assert.equal(toast, null);

    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    const p2CenterLine = decoded.centerLines.find(
      c => c.centerLineType === CenterLineType.VERTICAL && Math.abs(c.value - 1000) < 1 && c.labeled === false,
    );
    assert.ok(p2CenterLine, '前提: 2階に複製された中心線がある');
    assert.notEqual(p2CenterLine.id, clId, '期待: 2階の中心線のidは1階と異なるはず（現状は同じid＝分身）');
    assert.equal(decoded.walls.length, 1, '2階の壁は残る');
    assert.equal(decoded.walls[0].axisValue, 1000, '2階の壁の幾何は降格の前後で変わらない');
  },
);

// ---- QA指摘是正（ステップ5）: ダイアログ昇格の失敗経路・中止経路・裁定Q7/Q8の直接確認 ----

test(
  'addCenterLineFromDialog: ダイアログの昇格で他平面のpeekがrejectしたらrejectし、1階の中心線は同id・labeled:falseのまま・共有グラフに無く・undo未積み（QA指摘是正）',
  async () => {
    const { project, p1 } = makeTwoFloors();
    const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const clId = p1cl.id;
    const beforeTop = undoManager.peekUndo();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async () => { throw new Error('peek failed'); };
    try {
      await assert.rejects(
        () => addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null),
        /peek failed/,
      );
    } finally {
      floorSwapManager.peek = originalPeek;
    }
    assert.equal(p1.centerLines.some(c => c.id === clId && c.labeled === false), true, '期待: 1階の中心線は同id・labeled:falseのまま');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 共有グラフに通り芯は無い');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: ダイアログの昇格で他平面への保存が途中失敗したらrejectし、storeの2階はbeforeバイトのまま・自階/共有グラフも元のまま・undo未積み（QA指摘是正）',
  async () => {
    const { project, p1, p2, store } = makeTwoFloorsWithSecondFloorCenterLineWall(3000);
    const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false }); // 昇格対象
    const clId = p1cl.id;
    const beforeBytes = store.get(p2.plane.id);
    const saveFloorFn = async () => { throw new Error('save failed'); };
    const beforeTop = undoManager.peekUndo();

    await withProductionPeek(project, store, async () => {
      await assert.rejects(
        () => addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn }),
        /save failed/,
      );
    });

    assert.equal(store.get(p2.plane.id), beforeBytes, '期待: 2階のstoreはbeforeバイトのまま');
    assert.equal(p1.centerLines.some(c => c.id === clId && c.labeled === false), true, '期待: 自階は元のまま（中心線のまま）');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 共有グラフに通り芯は増えない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: ダイアログの昇格で他平面に同じidの線が残っていれば（裁定Q11）拒否し、undo不変（QA指摘是正）',
  async () => {
    const { project, graph: p1, cl } = makeFloorWithCenterLineWallAndRooms('p1', '1階');
    const clId = cl.id;
    const bytesForDup = serializeGraph(p1);
    const { graph: p1Dup, plane: dupPlane } = project.addPlane(0, '1階複製', 'p1dup');
    restoreGraph(p1Dup, bytesForDup);
    const store = new Map([[dupPlane.id, serializeGraph(p1Dup)]]);
    const beforeTop = undoManager.peekUndo();

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null)
    );

    assert.equal(result.done, false);
    assert.equal(result.toast, ERR_CL_CONVERT_SAME_ID_FLOOR([dupPlane.name]));
    assert.equal(p1.centerLines.some(c => c.id === clId && c.labeled === false), true, '期待: 拒否時は書き換えない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: ダイアログの昇格で他平面(2階)に同座標の補助線があれば拒否する（裁定Q3。QA指摘是正）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, lineType: 'dashed' });
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const beforeTop = undoManager.peekUndo();

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null)
    );

    assert.equal(result.done, false);
    assert.equal(result.toast, ERR_CL_CONVERT_DUP_FLOOR([{ name: p2.plane.name, kind: 'aux' }]));
    assert.equal(p1.centerLines.some(c => c.id === p1cl.id && c.labeled === false), true, '期待: 自階は不変（中心線のまま）');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 裁定Q7 — ダイアログのvalue・refId・refOffsetは捨て、既存の中心線の座標・idをそのまま使う（0.3mmずれ・別の通り芯への参照指定でも既存を優先）',
  async () => {
    const { project, graph, cl } = makeFloorWithCenterLineWallAndRooms(); // cl.value === 3000, refIdなし
    const oldId = cl.id;
    const decoyRef = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 9999, { labeled: true, discipline: Discipline.STRUCT });
    const payload = {
      clDialog: { type: 'vertical', worldCoord: 3000.3, perpCoord: 0 },
      value: 3000.3, kind: 'struct', refId: decoyRef.id, refOffset: 500,
    };

    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, true);
    const grid = project.structGraph.shapeMap.get(oldId);
    assert.ok(grid, '期待: 同じidのまま通り芯へ移籍する');
    assert.equal(grid.value, 3000, '期待: 座標は既存の中心線のまま（ダイアログの3000.3は捨てる）');
    assert.equal(grid.refId, null, '期待: ダイアログのrefId指定は捨てる（既存の中心線はrefId無しだった）');
  },
);

test(
  'addCenterLineFromDialog: 裁定Q8 — 保護される梁芯（lockedの柱が乗る）が同座標にあれば通り芯の昇格を拒否し、梁芯・中心線とも残る・undo不変（QA指摘是正）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const clId = cl.id;
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
    const beamAxisId = beamAxis.id;
    const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
    graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beamAxis, y0, { dimensionStatus: 'locked' }); // 手動固定
    const beforeTop = undoManager.peekUndo();

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, false, '期待: 保護される梁芯があるため拒否される');
    assert.equal(result.toast, ERR_CL_CONVERT_DUP('beam'));
    assert.equal(graph.shapeMap.has(clId), true, '期待: 中心線は残る（昇格されない）');
    assert.equal(graph.shapeMap.has(beamAxisId), true, '期待: 保護された梁芯も残る');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 裁定Q8 — refId付き（手動追加の可能性）の梁芯が同座標にあれば通り芯の昇格を拒否し、梁芯・中心線とも残る（QA指摘是正）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const clId = cl.id;
    const refTarget = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: refTarget.id, refOffset: 1000 });
    const beamAxisId = beamAxis.id;

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, false, '期待: refId付きの梁芯は保護されるため拒否される');
    assert.equal(result.toast, ERR_CL_CONVERT_DUP('beam'));
    assert.equal(graph.shapeMap.has(clId), true, '期待: 中心線は残る');
    assert.equal(graph.shapeMap.has(beamAxisId), true, '期待: refId付きの梁芯は残る（保護される）');
  },
);

test(
  'addCenterLineFromDialog: promoteCenterToGridWithUndoが中止（他平面への保存中に通り芯がstructGraphから消えた）した場合は成功扱いにせず、done:false・toast:null・undo未積みで終える（QA指摘4是正）',
  async () => {
    const { project, p1, store } = makeTwoFloorsWithSecondFloorCenterLineWall(3000);
    const p1cl = p1.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false }); // 昇格対象
    const beforeTop = undoManager.peekUndo();
    const saveFloorFn = async (planeId, bytes) => {
      store.set(planeId, bytes);
      // 保存の直後（applyCenterLineAbsorptionOnPromote内から呼ばれる）に、別操作でこの通り芯が
      // structGraphから消えたことを模す——promoteCenterToGridWithUndoの再確認ガードを踏ませる。
      runInAction(() => { project.structGraph.shapeMap.delete(p1cl.id); });
    };

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn })
    );

    assert.equal(result.done, false, '期待: 中止は成功扱いにしない');
    assert.equal(result.toast, null, '期待: 中止はエラーではないためtoastは出さない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

// ---- ステップ6: 通常追加（単体・スパン配列）の他平面チェック（裁定Q4〜Q6・Q8） ----

test(
  'addCenterLineFromDialog: 自階の保護されない壁由来梁芯と同座標に通り芯を単体追加すると、拒否せず吸収して梁芯が撤去される（裁定Q8）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
    const beamAxisId = beamAxis.id;
    const beforeTop = undoManager.peekUndo();

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, true, '期待: 拒否せず吸収して成功する');
    assert.equal(graph.shapeMap.has(beamAxisId), false, '期待: 保護されない梁芯は撤去される');
    const grid = project.structGraph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000);
    assert.ok(grid, '期待: 通り芯が追加される');
    assert.notEqual(undoManager.peekUndo(), beforeTop, '期待: undoが積まれる');

    undoManager.undo();
    assert.equal(graph.shapeMap.has(beamAxisId), true, '期待: undoで梁芯が復活する');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: undoで通り芯が消える');

    undoManager.redo();
    assert.equal(graph.shapeMap.has(beamAxisId), false, '期待: redoで再び梁芯が撤去される');
    assert.equal(project.structGraph.centerLines.length, 1, '期待: redoで通り芯が戻る');
  },
);

test(
  'addCenterLineFromDialog: 自階の保護される壁由来梁芯（lockedの柱が乗る）と同座標に通り芯を単体追加すると拒否される（裁定Q8）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
    const beamAxisId = beamAxis.id;
    const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
    graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beamAxis, y0, { dimensionStatus: 'locked' });
    const beforeTop = undoManager.peekUndo();

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, false, '期待: 保護される梁芯があるため拒否される');
    assert.equal(result.toast, ERR_CL_DUPLICATE('beam'));
    assert.equal(graph.shapeMap.has(beamAxisId), true, '期待: 梁芯は残る');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

// ---- リード裁定（線種変更の移籍一本化 ステップ6是正・2026-09-30・QA指摘2）: 由来USER（手動追加材）は無条件で保護 ----

test(
  'addCenterLineFromDialog: 由来USER（ダイアログのkind:beamで手動追加）の梁芯と同座標に通り芯を単体追加すると拒否され、梁芯と生成済み小梁が残る（QA指摘2）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
    const beamPayload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 1500 }, value: 1000, kind: 'beam', refId: null, refOffset: 0 };
    const beamResult = await addCenterLineFromDialog(graph, project, beamPayload, { scaleDenominator: 100 });
    assert.equal(beamResult.done, true, '前提: 手動梁芯の追加が成功する');
    const beamAxis = graph.centerLines.find(c => centerLineKind(c) === 'beam');
    assert.equal(beamAxis?.beamAxisOrigin, BeamAxisOrigin.USER, '前提: ダイアログ追加の梁芯は由来USER');
    const beamAxisId = beamAxis.id;
    const beforeTop = undoManager.peekUndo();

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, false, '期待: 由来USERの梁芯は保護されるため拒否される');
    assert.equal(graph.shapeMap.has(beamAxisId), true, '期待: 梁芯は残る');
    assert.equal(project.structGraph.centerLines.some(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000), false, '期待: 通り芯は追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'promoteCenterToGridWithUndo（メニュー経由）: 由来USER（手動追加材）の梁芯が同座標にあれば拒否する（QA指摘2）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const clId = cl.id;
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
      labeled: false, discipline: Discipline.FUSE, refId: null, beamAxisOrigin: BeamAxisOrigin.USER,
    });
    const beamAxisId = beamAxis.id;

    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, {});

    assert.equal(toast, ERR_CL_CONVERT_DUP('beam'), '期待: 由来USERの梁芯は保護されるため拒否される');
    assert.equal(graph.shapeMap.has(clId), true, '期待: 中心線は残る（昇格されない）');
    assert.equal(graph.shapeMap.has(beamAxisId), true, '期待: 由来USERの梁芯も残る');
  },
);

test(
  'addCenterLineFromDialog: 由来WALL（壁由来自動生成）・refId無し・柱なしの梁芯は従来どおり拒否せず吸収する（QA指摘2・対照）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
      labeled: false, discipline: Discipline.FUSE, refId: null, beamAxisOrigin: BeamAxisOrigin.WALL,
    });
    const beamAxisId = beamAxis.id;

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, true, '期待: 由来WALLは従来どおり吸収されて成功する');
    assert.equal(graph.shapeMap.has(beamAxisId), false, '期待: 由来WALLの梁芯は撤去される');
  },
);

// ---- リード裁定（線種変更の移籍一本化 ステップ6是正・2026-09-30・QA指摘3）: 同座標に区間の離れた梁芯が複数本 ----

test(
  'addCenterLineFromDialog: 自階の同座標に区間の離れた梁芯が2本あり、両方とも保護されなければ両方とも吸収される（QA指摘3）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const b1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 1000 });
    const b2 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: 2000, extentHi: 3000 });

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, true, '期待: 両方とも保護されないため吸収して成功する');
    assert.equal(graph.shapeMap.has(b1.id), false, '期待: 区間[0,1000]の梁芯が撤去される');
    assert.equal(graph.shapeMap.has(b2.id), false, '期待: 区間[2000,3000]の梁芯も撤去される');
    assert.equal(project.structGraph.centerLines.length, 1, '期待: 通り芯は1本追加される');
  },
);

test(
  'addCenterLineFromDialog: 自階の同座標に区間の離れた梁芯が2本あり、片方だけ保護されれば全体を拒否し両方とも残る（QA指摘3）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const b1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 1000 });
    const b2 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
      labeled: false, discipline: Discipline.FUSE, extentLo: 2000, extentHi: 3000, beamAxisOrigin: BeamAxisOrigin.USER,
    });
    const beforeTop = undoManager.peekUndo();

    const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
    const result = await addCenterLineFromDialog(graph, project, payload, null);

    assert.equal(result.done, false, '期待: 片方が保護されるため全体を拒否する');
    assert.equal(graph.shapeMap.has(b1.id), true, '期待: 保護されない側も残る（部分撤去しない）');
    assert.equal(graph.shapeMap.has(b2.id), true, '期待: 保護される側も残る');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 他の平面(2階)の同座標に区間の離れた梁芯が2本あり、両方とも保護されなければ両方とも吸収される（QA指摘3）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const b1 = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 1000 });
    const b2 = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: 2000, extentHi: 3000 });
    const b1Id = b1.id, b2Id = b2.id;
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(1000), null, { saveFloorFn })
    );

    assert.equal(result.done, true, '期待: 両方とも吸収して成功する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(b1Id), false, '期待: 2階の区間[0,1000]の梁芯が撤去される');
    assert.equal(decoded.shapeMap.has(b2Id), false, '期待: 2階の区間[2000,3000]の梁芯も撤去される');
  },
);

test(
  'addCenterLineFromDialog: 他の平面(2階)の同座標に区間の離れた梁芯が2本あり、片方だけ保護されれば拒否し両方とも残る（QA指摘3）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const b1 = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 1000 });
    const b2 = p2.addCenterLine(CenterLineType.VERTICAL, 1000, {
      labeled: false, discipline: Discipline.FUSE, extentLo: 2000, extentHi: 3000, beamAxisOrigin: BeamAxisOrigin.USER,
    });
    const b1Id = b1.id, b2Id = b2.id;
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(1000), null)
    );

    assert.equal(result.done, false, '期待: 片方が保護されるため拒否する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(b1Id), true, '期待: 保護されない側も残る（部分撤去しない）');
    assert.equal(decoded.shapeMap.has(b2Id), true, '期待: 保護される側も残る');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
  },
);

test(
  'addCenterLineFromDialog: 保護される梁芯（由来USER）で拒否したとき構造同期リスナーは呼ばれない（QA指摘9）',
  async () => {
    const project = new Project('proj', 'test');
    const { graph } = project.addPlane(0, '1階', 'p1');
    const beamAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
      labeled: false, discipline: Discipline.FUSE, refId: null, beamAxisOrigin: BeamAxisOrigin.USER,
    });
    let calls = 0;
    setCenterLineStructuralListener(() => { calls++; });
    try {
      const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 };
      const result = await addCenterLineFromDialog(graph, project, payload, null);
      assert.equal(result.done, false, '期待: 保護される梁芯があるため拒否される');
      assert.equal(graph.shapeMap.has(beamAxis.id), true, '期待: 梁芯は残る');
      assert.equal(calls, 0, '期待: 拒否経路は構造同期リスナーを呼ばない');
    } finally {
      setCenterLineStructuralListener(null);
    }
  },
);

test(
  'addCenterLineFromDialog: 手順c（他平面の壁由来梁芯の吸収）の保存が失敗したら巻き戻り、undo未積み・共有グラフ不変（QA指摘9）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const beamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE, refId: null });
    const beamAxisId = beamAxis.id;
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const beforeBytes = store.get(p2.plane.id);
    const saveFloorFn = async () => { throw new Error('save failed'); };
    const beforeTop = undoManager.peekUndo();

    await withProductionPeek(project, store, async () => {
      await assert.rejects(
        () => addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn }),
        /save failed/,
      );
    });

    assert.deepEqual(store.get(p2.plane.id), beforeBytes, '期待: 2階のstoreはbeforeバイトのまま');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(beamAxisId), true, '期待: 2階の梁芯は撤去されず残る');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 他の平面(2階)に保護されない壁由来梁芯がある場合、通り芯の単体追加は拒否せず吸収する（裁定Q1・Q8）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const beamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE, refId: null });
    const beamAxisId = beamAxis.id;
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn })
    );

    assert.equal(result.done, true, '期待: 吸収して成功する');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(beamAxisId), false, '期待: 2階の保護されない梁芯は撤去される');
  },
);

test(
  'addCenterLineFromDialog: 他の平面(2階)に保護される壁由来梁芯がある場合、通り芯の単体追加は拒否され平面名を出す',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const beamAxis = p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE, refId: null });
    const beamAxisId = beamAxis.id;
    const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
    p2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beamAxis, y0, { dimensionStatus: 'locked' });
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null)
    );

    assert.equal(result.done, false, '期待: 保護される梁芯があるため拒否される');
    assert.match(result.toast ?? '', /2階/, '期待: 平面名を出す');
    assert.match(result.toast ?? '', /通り芯を追加できません/, '期待: 裁定Q5の追加用の文言');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
    const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(beamAxisId), true, '期待: 2階の梁芯は書き換えない');
  },
);

test(
  'addCenterLineFromDialog: スパン配列で1本が他平面の中心線、別の1本が補助線と重なる場合、全体を拒否し補助線側の値と平面名だけを出し、何も保存しない（裁定Q1・Q3・Q6）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false }); // 中心線（吸収対象・拒否理由に出ない）
    p2.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, lineType: 'dashed' }); // 補助線（拒否理由）
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    let saveCalls = 0;
    const saveFloorFn = async (planeId, bytes) => { saveCalls++; store.set(planeId, bytes); };
    const beforeTop = undoManager.peekUndo();

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV([1000, 2000, 3000]), null, { saveFloorFn })
    );

    assert.equal(result.done, false, '期待: 一部が補助線と重なるため全体を拒否する');
    assert.match(result.toast ?? '', /2000/, '期待: 補助線側の値を出す');
    assert.equal(/1000/.test(result.toast ?? ''), false, '期待: 中心線側（吸収対象）の値は出さない');
    assert.match(result.toast ?? '', /2階/);
    assert.equal(saveCalls, 0, '期待: 何も保存されない');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 1本も追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 通常追加で他平面の中心線を吸収した後、undoでその平面の中心線が復活し壁が解決、共有グラフから通り芯が消える。redoで戻る',
  async () => {
    const { project, p1, p2, p2cl, store, saveFloorFn } = makeTwoFloorsWithSecondFloorCenterLineWall(3000);
    const p2clId = p2cl.id;

    const result = await withProductionPeek(project, store, () =>
      addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn })
    );
    assert.equal(result.done, true);

    undoManager.undo();
    let decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(p2clId), true, '期待: undoで2階の中心線が復活する');
    assert.equal(decoded.walls.length, 1, '期待: 壁は残る');
    assert.equal(decoded.walls[0].axisValue, 3000, '期待: 壁はその中心線idに解決する');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: undoで共有グラフから通り芯が消える');

    undoManager.redo();
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.shapeMap.has(p2clId), false, '期待: redoで再び吸収される');
    assert.equal(decoded.walls[0].axisValue, 3000, '期待: 壁の幾何は変わらない');
    assert.equal(project.structGraph.centerLines.length, 1, '期待: redoで通り芯が戻る');
  },
);

test(
  'addCenterLineFromDialog: 通常追加で他平面のpeekがrejectしたらrejectし、共有グラフ・undoは不変',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const beforeTop = undoManager.peekUndo();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async () => { throw new Error('peek failed'); };
    try {
      await assert.rejects(
        () => addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null),
        /peek failed/,
      );
    } finally {
      floorSwapManager.peek = originalPeek;
    }
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 通常追加中に他平面peekの間でアクティブ階が切り替わったら、手順eの前で中止し巻き戻す（QA指摘6）',
  async () => {
    const { project, p1, p2 } = makeTwoFloors();
    const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
    const beforeTop = undoManager.peekUndo();
    const originalPeek = floorSwapManager.peek;
    let switched = false;
    floorSwapManager.peek = async (plane) => {
      const temp = decodeFloor(project, plane, store.get(plane.id));
      // 他平面peek（IDBを伴うawait）の間に、階切替やhistoryナビゲーションで
      // アクティブ階が変わりうる（promoteCenterToGridWithUndoのM-2ガードと同じ想定）。
      if (!switched) { switched = true; project.activePlaneId = p2.plane.id; }
      return temp;
    };
    try {
      const result = await addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null);
      assert.equal(result.done, false, '期待: 中止は成功扱いにしない');
      assert.equal(result.toast, null, '期待: 中止はエラーではないためtoastは出さない');
    } finally {
      floorSwapManager.peek = originalPeek;
      project.activePlaneId = p1.plane.id;
    }
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 通り芯は追加されない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);

test(
  'addCenterLineFromDialog: 通常追加で複数平面の中心線吸収中に後続平面の保存が失敗したら、先に保存した平面もbeforeへ戻し、共有グラフから追加した通り芯が消え、undoは積まれない',
  async () => {
    const project = new Project('proj', 'test');
    const { graph: p1 } = project.addPlane(0, '1階', 'p1');
    const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
    const { graph: p3 } = project.addPlane(6000, '3階', 'p3');
    const p2cl = p2.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const p2clId = p2cl.id;
    const y0 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false });
    const y1 = p2.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false });
    p2.addWall(p2cl, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
    const p3cl = p3.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false });
    const p3clId = p3cl.id;
    // QA指摘5是正: graphSnapshot.js（常設の寸法線8本を復元時に補う）のため、直接構築した
    // グラフを一度も peek（decodeFloor＝restoreGraph往復）していないバイト列と、peek済みの
    // グラフを再シリアライズしたバイト列とではバイト長が変わる（初回往復だけ増える。2回目以降は
    // 安定）——保存前後のバイト厳密一致で検証するには、ここで一度
    // `serializeGraph(decodeFloor(...))` により正規化してから基準値（beforeP2/beforeP3）を
    // 採る必要がある（qa6_rb.mjsのnorm関数と同じ手順）。
    const norm = (g) => serializeGraph(decodeFloor(project, g.plane, serializeGraph(g)));
    const store = new Map([
      [p2.plane.id, norm(p2)],
      [p3.plane.id, norm(p3)],
    ]);
    const beforeP2 = store.get(p2.plane.id);
    const beforeP3 = store.get(p3.plane.id);
    const saveFloorFn = async (planeId, bytes) => {
      if (planeId === p3.plane.id) throw new Error('save failed');
      store.set(planeId, bytes);
    };
    const beforeTop = undoManager.peekUndo();

    await withProductionPeek(project, store, async () => {
      await assert.rejects(
        () => addCenterLineFromDialog(p1, project, dialogPayloadV(3000), null, { saveFloorFn }),
        /save failed/,
      );
    });

    assert.deepEqual(store.get(p2.plane.id), beforeP2, '期待: 2階はbeforeバイトのまま（正規化済み基準とバイト厳密一致）');
    assert.deepEqual(store.get(p3.plane.id), beforeP3, '期待: 3階はbeforeバイトのまま（そもそも保存前）');
    const decodedP2 = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decodedP2.shapeMap.has(p2clId), true, '期待: 2階の中心線は吸収前のまま残る（巻き戻る）');
    assert.equal(decodedP2.walls.length, 1, '期待: 2階の壁は残る');
    assert.equal(decodedP2.walls[0].axisValue, 3000, '期待: 2階の壁はその中心線idのまま');
    const decodedP3 = decodeFloor(project, p3.plane, store.get(p3.plane.id));
    assert.equal(decodedP3.shapeMap.has(p3clId), true, '期待: 3階の中心線も吸収されていない');
    assert.equal(project.structGraph.centerLines.length, 0, '期待: 追加した通り芯は共有グラフから消える');
    assert.equal(p1.centerLines.length, 0, '期待: 自階に中心線の交点・従属物が残らない');
    assert.equal(p1.columns.length, 0, '期待: 自階に柱の従属物も残らない');
    assert.equal(undoManager.peekUndo(), beforeTop, '期待: undoは積まれない');
  },
);
