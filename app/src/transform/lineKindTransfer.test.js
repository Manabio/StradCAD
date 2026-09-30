// 線種変更の移籍一本化（260929_線種変更の移籍一本化.md ステップ0）: §2.2 の全ケースと
// 「降格すると他の平面に同じ id の線ができる」を、現状で失敗するテストとして固定する。
// 各テストの期待値は裁定後（§3・§4）の仕様。現状の製品コードでは赤になる（通常test実行で確認済み）
// ため、フルスイートを赤にしないよう { todo: '…ステップN で解消' } にする。該当ステップで todo を外す。
// 対照テスト（現状で緑。裁定後も緑のまま）は todo にしない。
// 他の平面の読み出しは本番同型 peek（保存バイトから restoreGraph）で行う。生きたグラフは渡さない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, centerLineKind } from '../core.js';
import { ERR_CL_CONVERT_DUP_FLOOR } from '../error.js';
import { worldToCell } from '../finish/gridCells.js';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import {
  addCenterLineFromDialog, promoteCenterToGridWithUndo, demoteGridToCenterWithUndo, bakeCLValue,
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

// ---- ケース1: ダイアログで同位置に通り芯（現状は削除して作り直す。壁・部屋の参照が壊れる） ----

test(
  'addCenterLineFromDialog: 既存の中心線と同位置に通り芯を指定すると、メニューの昇格と同じく移籍になり、壁・部屋の参照が保たれ undo で戻る（指示書§2.2 ケース1・裁定Q7〜Q9）',
  { todo: '線種変更の移籍一本化 ステップ5 で解消' },
  async () => {
    const { project, graph, cl } = makeFloorWithCenterLineWallAndRooms();
    const oldId = cl.id;

    const result = await addCenterLineFromDialog(graph, project, dialogPayloadV(3000), null);

    assert.equal(result.done, true);
    assert.equal(graph.walls.length, 1, '期待: 壁は1本のまま（現状は削除連鎖で0本になる）');
    const grid = project.structGraph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 3000);
    assert.equal(grid?.id, oldId, '期待: idは同じまま移籍する（現状は削除+新規作成で新しいidになる）');
    assert.equal(allRoomCellRefsResolve(graph, project), true, '期待: 部屋のセル参照は切れない（現状は左右とも切れる）');
    assert.equal(result.toast, MSG_DIALOG_PROMOTED, '期待: 裁定Q9の文言');

    undoManager.undo();
    assert.equal(graph.walls.length, 1, '期待: undoで壁が元どおりになる（現状は戻らない）');
    assert.equal(graph.centerLines.some(c => c.id === oldId && c.labeled === false), true, '期待: undoで同じidの中心線に戻る');
    assert.equal(allRoomCellRefsResolve(graph, project), true, '期待: undo後もセル参照が解決する');
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
  { todo: '線種変更の移籍一本化 ステップ5 で解消' },
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
  { todo: '線種変更の移籍一本化 ステップ6 で解消' },
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
  { todo: '線種変更の移籍一本化 ステップ6 で解消' },
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
  { todo: '線種変更の移籍一本化 ステップ6 で解消' },
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
    assert.equal(project.structGraph.centerLines.filter(c => c.value === 3000).length, 1, '期待: 通り芯は1本');
  },
);

test(
  'addCenterLineFromDialog: スパン配列で一部の値が2階の中心線と重なる場合、その中心線を吸収して全本を追加する（2026-09-30 裁定）',
  { todo: '線種変更の移籍一本化 ステップ6 で解消' },
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
    assert.deepEqual(
      project.structGraph.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL).map(c => c.value).sort((a, b) => a - b),
      [1000, 2000, 3000], '期待: 3本とも追加される',
    );
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
