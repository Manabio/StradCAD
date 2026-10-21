// floorOrderChange.js（「階の並びが変わった」1つの出来事の唯一の入口）の不変条件。
// 途中階の上階追加と階移動の振り直し一本化 ステップ3。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { Project } from './core/project.js';
import { applyPlaneMetas, collectPlaneMetas } from './floorOps.js';
import { stripCommentLines } from './uiBusySourceScan.js';

// ---- (a) レジストリの name の並び・appliesTo が固定されている ----

test('floorOrderFollowers: name の並びが固定されている', () => {
  assert.deepEqual(floorOrderFollowers.map(f => f.name), [
    'roofPlaneHeight', 'elevatorCopy', 'stairCopy', 'basementCenterLines', 'basementInit', 'exteriorRoom', 'stairVoidReconcile',
    'mainRoofCarry', 'switchToAddedFloor', 'stairRiserFollow', 'wallRefresh', 'structuralReflect', 'elevatorRenumber',
  ]);
});

// S4（2026-10-21）: 階追加の順序。昇降路 → 階段の複製 → 外壁内側の部屋 → 階段吹抜けの整合 → 階の切替。
// 階段吹抜けの整合を階段の複製より前に置くと、N の階段の足元へ先に STAIR_VOID が付いて写した階段と二重になり、
// 上の階の吹抜けが孤児として未定義化される。切替の後に置くと ctx.sourceGraph が切替前の古い束縛になる。
test('floorOrderFollowers: 階追加の順序は elevatorCopy < stairCopy < exteriorRoom < stairVoidReconcile < switchToAddedFloor', () => {
  const names = floorOrderFollowers.map(f => f.name);
  // S5c-2: 下階追加の地階の初期化（外壁 CL・地階構造）は stairCopy の後・stairVoidReconcile の前
  const order = ['elevatorCopy', 'stairCopy', 'basementCenterLines', 'basementInit', 'exteriorRoom', 'stairVoidReconcile', 'switchToAddedFloor'].map(n => names.indexOf(n));
  assert.ok(order.every(i => i >= 0), `follower が見つからない: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `順序が崩れている: ${order}`);
  // DELETE・REORDER・CHANGE の stairVoidReconcile は roofPlaneHeight の後・structuralReflect の前のまま
  assert.ok(names.indexOf('roofPlaneHeight') < names.indexOf('stairVoidReconcile'));
  assert.ok(names.indexOf('stairVoidReconcile') < names.indexOf('structuralReflect'));
});

// B3: 主屋根の引き継ぎは INSERT（上に階を追加）だけ。下への追加・削除・並べ替え・階変更では写さない。
// 新階への書込みなので階の切替（switchToAddedFloor）より前に並ぶ。
test('floorOrderFollowers: mainRoofCarry は INSERT のみで、switchToAddedFloor より前', () => {
  const names = floorOrderFollowers.map(f => f.name);
  const carry = floorOrderFollowers.find(f => f.name === 'mainRoofCarry');
  assert.deepEqual(carry.appliesTo, [FLOOR_ORDER_KIND.INSERT]);
  assert.ok(names.indexOf('mainRoofCarry') < names.indexOf('switchToAddedFloor'));
});

test('floorOrderFollowers: 各followerのappliesToが固定されている', () => {
  const byName = Object.fromEntries(floorOrderFollowers.map(f => [f.name, f.appliesTo]));
  assert.deepEqual(byName.roofPlaneHeight, [
    FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
    FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE, FLOOR_ORDER_KIND.HEIGHTS,
  ]);
  assert.deepEqual(byName.wallRefresh, [FLOOR_ORDER_KIND.HEIGHTS]);
  assert.deepEqual(byName.stairRiserFollow, [FLOOR_ORDER_KIND.HEIGHTS]);
  assert.deepEqual(byName.stairVoidReconcile, [
    FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
    FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE,
  ]);
  assert.deepEqual(byName.elevatorCopy, [FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER]); // ADD_LOWER は S5c-2（Q7）
  assert.deepEqual(byName.basementCenterLines, [FLOOR_ORDER_KIND.ADD_LOWER]);
  assert.deepEqual(byName.basementInit, [FLOOR_ORDER_KIND.ADD_LOWER]);
  assert.deepEqual(byName.stairCopy, [FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER]);
  assert.deepEqual(byName.elevatorRenumber, [FLOOR_ORDER_KIND.DELETE]);
  assert.deepEqual(byName.exteriorRoom, [FLOOR_ORDER_KIND.INSERT]);
  // 階削除で他の階の階段は消さない（S3・2026-10-21）。撤去した follower が戻っていないこと。
  assert.equal(byName.stairsBelowRemoval, undefined);
  assert.deepEqual(byName.switchToAddedFloor, [FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER]);
  assert.deepEqual(byName.structuralReflect, [
    FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
    FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE, FLOOR_ORDER_KIND.HEIGHTS,
  ]);
});

// ---- (b) applyFloorOrderChange の配線（フェイクfollowersで検証）----

function makeUi() {
  return {
    notified: [],
    switched: [],
    syncChangedCount: 0,
    notify(msg) { this.notified.push(msg); },
    switchFloor(planeId) { this.switched.push(planeId); return Promise.resolve(true); },
    onFloorSyncChanged() { this.syncChangedCount++; },
  };
}

function makeProjectWithThreeFloors() {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  return project;
}

test('applyFloorOrderChange: kindでフィルタされ、beforeが本体より前・runが登録順に走る', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const fakeFollowers = [
    {
      name: 'onlyInsert',
      appliesTo: [FLOOR_ORDER_KIND.INSERT],
      async before() { calls.push('onlyInsert.before'); },
      async run() { calls.push('onlyInsert.run'); },
    },
    {
      name: 'onlyDelete',
      appliesTo: [FLOOR_ORDER_KIND.DELETE],
      async run() { calls.push('onlyDelete.run'); },
    },
    {
      name: 'both',
      appliesTo: [FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.DELETE],
      async run() { calls.push('both.run'); },
    },
  ];

  const updates = [{ id: 'p3', name: '4階', startFloor: 4, elevation: 9000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates,
    addPlane: () => project.addPlane(12000, '3階', 'new', 3, 1),
    ui: makeUi(),
  }, fakeFollowers);

  // kind='insert'に該当しない'onlyDelete'は呼ばれない。before→run、登録順（onlyInsert→both）。
  assert.deepEqual(calls, ['onlyInsert.before', 'onlyInsert.run', 'both.run']);
});

// QA指摘2: beforeは本体（removePlane/addPlane）より前に走る。beforeの時点でctx.removedPlaneが
// 渡っていることも確認する（delete系followerのbeforeが削除前に器具idを読む前提）。
test('applyFloorOrderChange: before は removePlane/addPlane より前に走る（delete・removePlane）', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  let removedPlaneSeenInBefore = null;
  const fakeFollowers = [
    {
      name: 'f',
      appliesTo: [FLOOR_ORDER_KIND.DELETE],
      async before(ctx) { calls.push('f.before'); removedPlaneSeenInBefore = ctx.removedPlane; },
      async run() { calls.push('f.run'); },
    },
  ];
  const removedPlane = project.planeMap.get('p2');

  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates: [],
    removePlane: () => { calls.push('body'); project.removePlane('p2'); return Promise.resolve(); },
    removedPlane,
    ui: makeUi(),
  }, fakeFollowers);

  assert.deepEqual(calls, ['f.before', 'body', 'f.run']);
  assert.equal(removedPlaneSeenInBefore, removedPlane, 'beforeの時点でctx.removedPlaneが渡っている必要がある');
});

test('applyFloorOrderChange: before は removePlane/addPlane より前に走る（insert・addPlane）', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const fakeFollowers = [
    {
      name: 'f',
      appliesTo: [FLOOR_ORDER_KIND.INSERT],
      async before() { calls.push('f.before'); },
      async run() { calls.push('f.run'); },
    },
  ];

  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: [],
    addPlane: () => { calls.push('body'); return project.addPlane(9000, '4階', 'new', 4, 1); },
    ui: makeUi(),
  }, fakeFollowers);

  assert.deepEqual(calls, ['f.before', 'body', 'f.run']);
});

// QA指摘3: switchToAddedFloor（実物）がfalseを返したらhaltedとなり、後続（構造反映相当）のfollowerは
// 呼ばれない。trueなら呼ばれる対照も確認する。
test('【失敗系】switchToAddedFloor: ui.switchFloor が false なら halted で後続（構造反映）は呼ばれない', async () => {
  const project = makeProjectWithThreeFloors();
  const switchToAddedFloor = floorOrderFollowers.find(f => f.name === 'switchToAddedFloor');
  let structuralCalled = false;
  const fakeStructural = {
    name: 'fakeStructural', appliesTo: [FLOOR_ORDER_KIND.INSERT], async run() { structuralCalled = true; },
  };
  const ui = makeUi();
  ui.switchFloor = (id) => { ui.switched.push(id); return Promise.resolve(false); };

  const result = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: [],
    addPlane: () => project.addPlane(9000, '4階', 'new', 4, 1),
    ui,
  }, [switchToAddedFloor, fakeStructural]);

  assert.equal(result.halted, true);
  assert.equal(structuralCalled, false, 'switchFloor失敗時は後続followerが呼ばれてはいけない');
});

test('対照: switchToAddedFloor: ui.switchFloor が true なら後続（構造反映）が呼ばれる', async () => {
  const project = makeProjectWithThreeFloors();
  const switchToAddedFloor = floorOrderFollowers.find(f => f.name === 'switchToAddedFloor');
  let structuralCalled = false;
  const fakeStructural = {
    name: 'fakeStructural', appliesTo: [FLOOR_ORDER_KIND.INSERT], async run() { structuralCalled = true; },
  };
  const ui = makeUi(); // switchFloorは既定でtrueを返す

  const result = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: [],
    addPlane: () => project.addPlane(9000, '4階', 'new', 4, 1),
    ui,
  }, [switchToAddedFloor, fakeStructural]);

  assert.equal(result.halted, false);
  assert.equal(structuralCalled, true, 'switchFloor成功時は後続followerが呼ばれる必要がある');
});

// QA指摘6: DELETE のとき structuralReflect 相当の follower が呼ばれる。実物レジストリの appliesTo
// フィルタを使い、structuralReflect だけ記録用fakeに差し替える。delete専用の他の実物follower
// （stairVoidReconcile・elevatorRenumber）は他階の peek を避けるためfakeに差し替える。
test('DELETE のとき structuralReflect 相当の follower が呼ばれる', async () => {
  const project = makeProjectWithThreeFloors();
  let structuralCalled = false;
  const followers = floorOrderFollowers.map((f) => {
    if (f.name === 'structuralReflect') {
      return { ...f, async run() { structuralCalled = true; } };
    }
    if (f.name === 'stairVoidReconcile' || f.name === 'elevatorRenumber') {
      return { ...f, before: undefined, async run() {} };
    }
    return f;
  });

  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates: [],
    removePlane: () => { project.removePlane('p2'); return Promise.resolve(); },
    removedPlane: project.planeMap.get('p2'),
    ui: makeUi(),
  }, followers);

  assert.equal(structuralCalled, true, 'DELETEでもstructuralReflectが呼ばれる必要がある');
});

// 途中階の上階追加と階移動の振り直し一本化 ステップ4（Q1裁定）: ドラッグ移動（REORDER）は
// stairVoidReconcile→structuralReflectの順で呼ばれ、insert専用のelevatorCopy・exteriorRoom・
// switchToAddedFloorは（appliesToによるフィルタで）呼ばれない。
test('REORDER のとき stairVoidReconcile→structuralReflect の順で呼ばれ、insert専用のfollowerは呼ばれない', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const followers = floorOrderFollowers.map((f) => {
    if (f.name === 'stairVoidReconcile') return { ...f, async run() { calls.push('stairVoidReconcile'); } };
    if (f.name === 'structuralReflect') return { ...f, async run() { calls.push('structuralReflect'); } };
    if (f.name === 'elevatorCopy' || f.name === 'exteriorRoom' || f.name === 'switchToAddedFloor') {
      return { ...f, async run() { calls.push(f.name); } }; // appliesToで除外される想定（呼ばれたら検出する）
    }
    return f;
  });

  const updates = [{ id: 'p2', name: '5階', startFloor: 5, elevation: 12000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.REORDER,
    updates,
    sourceGraph: {},
    ui: makeUi(),
  }, followers);

  assert.deepEqual(calls, ['stairVoidReconcile', 'structuralReflect']);
});

// 階変更（CHANGE）は stairVoidReconcile と structuralReflect だけが呼ばれる（elevatorRenumber等のdelete専用は除外）。
test('CHANGE のとき stairVoidReconcile と structuralReflect だけが呼ばれる', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const followers = floorOrderFollowers.map((f) => {
    if (f.name === 'structuralReflect') return { ...f, async run() { calls.push('structuralReflect'); } };
    return { ...f, async run() { calls.push(f.name); } }; // 他はappliesToで除外される想定（呼ばれたら検出する）
  });

  const updates = [{ id: 'p2', name: '5階', startFloor: 5, elevation: 12000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.CHANGE,
    updates,
    sourceGraph: {},
    ui: makeUi(),
  }, followers);

  assert.deepEqual(calls, ['roofPlaneHeight', 'stairVoidReconcile', 'structuralReflect'], 'roofPlaneHeightもCHANGEに適用される');
});

// QA指摘5: floorOrderChange.js のソース（コメント行除去後）で、追従処理の主要呼び出し行が
// 1行まるごとの形で存在する（行末コメントに元の式を残す変異・条件式の差し替えを見逃さないため。
// team-lessons「配線テストが行末コメントに残した元の式に一致して合格する」対応）。
test('floorOrderFollowers ソース: 主要呼び出し行が1行まるごとの形で存在する', () => {
  const src = fs.readFileSync(new URL('./floorOrderChange.js', import.meta.url), 'utf8');
  const code = stripCommentLines(src);

  const expectedLines = [
    "if (copied.status === 'copied' && copied.skipped.length > 0) {",
    "if (renumbered.status === 'renumbered') ctx.ui.onFloorSyncChanged();",
    'await reconcileAllStairVoids(ctx.project, ctx.floorIo);',
    // elevatorCopy: INSERT は従来どおり（floorIo なし・直下階から）。ADD_LOWER だけ floorIo と sourceGraph（当該階）を渡す
    'const { peekFn, saveFloorFn } = isLower ? (ctx.floorIo ?? {}) : {};',
    'project: ctx.project, activeGraph: ctx.sourceGraph, newPlane: plane,',
    '...(isLower ? { sourceGraph: ctx.sourceGraph } : {}),',
    'for (const plane of isLower ? ctx.addedPlanes : [ctx.addedPlane]) {',
    'writeBasementStructure(ctx.project, ctx.sourceGraph, ctx.addedPlanes);',
    'await addNewFloorRoomFromSource(ctx.project, ctx.sourceGraph, ctx.addedPlane, makeFloorName(ctx.newStartFloor, 1));',
  ];
  for (const line of expectedLines) {
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(code, new RegExp(`^\\s*${escaped}\\s*$`, 'm'),
      `期待する行が1行まるごとの形で見つからない: ${line}`);
  }
});

test('applyFloorOrderChange: insertでは、run実行時点でupdatesが既にPlaneメタへ書かれ、addedPlaneが追加済み', async () => {
  const project = makeProjectWithThreeFloors();
  let seenDuringRun = null;
  const fakeFollowers = [
    {
      name: 'probe',
      appliesTo: [FLOOR_ORDER_KIND.INSERT],
      async run(ctx) {
        seenDuringRun = {
          p3Name: project.planeMap.get('p3').name,
          addedPlaneId: ctx.addedPlane.id,
          targetPlaneId: ctx.targetPlaneId,
        };
      },
    },
  ];

  const updates = [{ id: 'p3', name: '4階', startFloor: 4, elevation: 9000 }];
  const result = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates,
    addPlane: () => project.addPlane(6000, '3階', 'new', 3, 1),
    ui: makeUi(),
  }, fakeFollowers);

  assert.equal(seenDuringRun.p3Name, '4階', 'run時点でp3のメタが振り直し後の値になっている必要がある');
  assert.equal(seenDuringRun.addedPlaneId, 'new');
  assert.equal(seenDuringRun.targetPlaneId, 'new');
  assert.equal(result.addedPlane.id, 'new');
});

test('applyFloorOrderChange: deleteでは、removePlaneの後にupdatesが書かれてからfollowerのrunが走る', async () => {
  const project = makeProjectWithThreeFloors();
  let seenDuringRun = null;
  const fakeFollowers = [
    {
      name: 'probe',
      appliesTo: [FLOOR_ORDER_KIND.DELETE],
      async run() {
        seenDuringRun = {
          hasP2: project.planeMap.has('p2'),
          p3Name: project.planeMap.get('p3').name,
        };
      },
    },
  ];

  const updates = [{ id: 'p3', name: '2階', startFloor: 2, elevation: 3000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates,
    removePlane: () => { project.removePlane('p2'); return Promise.resolve(); },
    ui: makeUi(),
  }, fakeFollowers);

  assert.equal(seenDuringRun.hasP2, false, 'removePlane後はp2が消えている必要がある');
  assert.equal(seenDuringRun.p3Name, '2階', 'run時点でp3のメタが振り直し後の値になっている必要がある');
});

test('applyFloorOrderChange: followerのrunがfalseを返したら以降のfollowerを止める', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const fakeFollowers = [
    { name: 'first', appliesTo: [FLOOR_ORDER_KIND.INSERT], async run() { calls.push('first'); return false; } },
    { name: 'second', appliesTo: [FLOOR_ORDER_KIND.INSERT], async run() { calls.push('second'); } },
  ];

  const result = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: [],
    addPlane: () => project.addPlane(9000, '4階', 'new', 4, 1),
    ui: makeUi(),
  }, fakeFollowers);

  assert.deepEqual(calls, ['first'], 'secondは呼ばれてはいけない');
  assert.equal(result.halted, true);
});

test('applyFloorOrderChange: addPlane/removePlaneどちらも無ければ applyPlaneMetas(updates) のみ行う（reorder/change相当）', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const fakeFollowers = [
    { name: 'noop', appliesTo: [FLOOR_ORDER_KIND.REORDER], async run() { calls.push('noop'); } },
  ];

  const updates = [{ id: 'p2', name: '5階', startFloor: 5, elevation: 12000 }];
  const result = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.REORDER,
    updates,
    ui: makeUi(),
  }, fakeFollowers);

  assert.equal(project.planeMap.get('p2').name, '5階');
  assert.deepEqual(calls, ['noop']);
  assert.equal(result.addedPlane, null);
});

// ---- (c) 失敗系: followerのrunがthrowしたら伝播し、後続followerは走らない ----

test('【失敗系】applyFloorOrderChange: followerのrunがthrowしたら伝播し、後続followerは呼ばれない', async () => {
  const project = makeProjectWithThreeFloors();
  const calls = [];
  const fakeFollowers = [
    { name: 'boom', appliesTo: [FLOOR_ORDER_KIND.INSERT], async run() { calls.push('boom'); throw new Error('boom'); } },
    { name: 'never', appliesTo: [FLOOR_ORDER_KIND.INSERT], async run() { calls.push('never'); } },
  ];

  await assert.rejects(
    () => applyFloorOrderChange(project, {
      kind: FLOOR_ORDER_KIND.INSERT,
      updates: [],
      addPlane: () => project.addPlane(9000, '4階', 'new', 4, 1),
      ui: makeUi(),
    }, fakeFollowers),
    /boom/,
  );
  assert.deepEqual(calls, ['boom'], 'neverは呼ばれてはいけない');
});

// 'lower'のn=0等、到達しない想定だがaddPlane()がplaneを返さなかった場合。addedPlane/targetPlaneIdは
// nullのままにし、switchToAddedFloor（既定レジストリに登録されている実物。reflectStructuralAfterFloorAdd
// 等の重い追従処理を避けるため、switchToAddedFloorだけを抜き出したfollowers配列で検証する）は
// switchFloorを呼ばずtrueを返す（throwしない）。
test('【失敗系】applyFloorOrderChange: addPlaneが{ plane: null }を返しても例外にならず、switchFloorは呼ばれない', async () => {
  const project = makeProjectWithThreeFloors();
  const ui = makeUi();
  const switchToAddedFloor = floorOrderFollowers.find(f => f.name === 'switchToAddedFloor');

  const result = await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.ADD_LOWER,
    updates: [],
    addPlane: () => ({ plane: null }),
    ui,
  }, [switchToAddedFloor]);

  assert.equal(result.addedPlane, null);
  assert.equal(result.halted, false);
  assert.deepEqual(ui.switched, [], 'switchFloorが呼ばれてはいけない');
});

// ---- (d) applyPlaneMetas は stories が undefined のエントリでは stories を書かない ----

test('【不変条件】applyPlaneMetas: stories が undefined のエントリ（renumberPlanesFrom系の更新一覧）では stories を書き換えない', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 3); // stories=3の一般階
  const before = collectPlaneMetas(project);
  assert.equal(before[0].stories, 3);

  // renumberPlanesFrom系の更新一覧はstoriesを持たない
  applyPlaneMetas(project, [{ id: 'p1', name: '2階', startFloor: 2, elevation: 3000 }]);

  const plane = project.planeMap.get('p1');
  assert.equal(plane.name, '2階');
  assert.equal(plane.startFloor, 2);
  assert.equal(plane.elevation, 3000);
  assert.equal(plane.stories, 3, 'storiesがundefinedのエントリではstoriesを書き換えてはいけない');
});

// ---- (e) roofPlaneHeight follower（§5-8。屋根平面の高さは最上階に従属） ----

test('roofPlaneHeight: project.roofPlaneが無いときは何もしない（屋根平面を新設しない）', async () => {
  const project = makeProjectWithThreeFloors();
  const sizeBefore = project.planeMap.size;

  const updates = [{ id: 'p3', name: '5階', startFloor: 5, elevation: 12000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.CHANGE,
    updates,
    sourceGraph: {},
    ui: makeUi(),
  }, [floorOrderFollowers.find(f => f.name === 'roofPlaneHeight')]);

  assert.equal(project.planeMap.size, sizeBefore, 'roofPlaneが無いプロジェクトに屋根平面を作ってはいけない');
  assert.equal(project.roofPlane, null);
});

test('roofPlaneHeight: 最上階idが同じまま高さ・階番号が変わったら屋根平面の高さが追従する', async () => {
  const project = makeProjectWithThreeFloors();
  const { syncRoofPlane } = await import('./structural/roofPlane.js');
  const roof = syncRoofPlane(project); // 最上階(p3: elevation=6000,startFloor=3)の上に屋根平面ができる
  assert.equal(roof.elevation, 6001);
  assert.equal(roof.startFloor, 3);

  // p3の振り直し（挿入で1段ずれた想定）: elevation/startFloorだけ動き、idは変わらない
  const updates = [{ id: 'p3', name: '4階', startFloor: 4, elevation: 9000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates,
    addPlane: () => project.addPlane(6000, '3階', 'new', 3, 1),
    sourceGraph: {},
    ui: makeUi(),
  }, [floorOrderFollowers.find(f => f.name === 'roofPlaneHeight')]);

  const roofAfter = project.roofPlane;
  assert.equal(roofAfter.id, roof.id, '最上階idが同じなら屋根平面を作り直さない');
  assert.equal(roofAfter.elevation, 9001, '屋根平面の高さは最上階+1に追従する必要がある');
  assert.equal(roofAfter.startFloor, 4);
});

// QA指摘2026-10-01: roofPlaneHeightがstructuralReflectより前に走る（屋根平面の高さを合わせてから
// 構造反映が屋根平面を読む）ことを、変異（順序入替え）で検出できる形で固定する。
test('roofPlaneHeight: 途中挿入（最上階idは同じ）でstructuralReflectより前に屋根平面の高さが新しい最上階+1になっている', async () => {
  const project = makeProjectWithThreeFloors();
  const { syncRoofPlane } = await import('./structural/roofPlane.js');
  syncRoofPlane(project); // 最上階(p3: elevation=6000,startFloor=3)の上に屋根平面ができる

  const roofPlaneHeight = floorOrderFollowers.find(f => f.name === 'roofPlaneHeight');
  let elevationSeenByStub = null;
  const stub = {
    name: 'stub',
    appliesTo: [FLOOR_ORDER_KIND.INSERT],
    run(ctx) { elevationSeenByStub = ctx.project.roofPlane.elevation; },
  };

  const updates = [{ id: 'p3', name: '4階', startFloor: 4, elevation: 9000 }];
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates,
    addPlane: () => project.addPlane(6000, '3階', 'new', 3, 1),
    sourceGraph: {},
    ui: makeUi(),
  }, [roofPlaneHeight, stub]);

  assert.equal(elevationSeenByStub, 9001, 'roofPlaneHeightはstubより前に走り、屋根平面の高さを新しい最上階+1へ合わせている必要がある');
});

// QA指摘2026-10-01再裁定: 最上階idが変わる操作（最上階の上へのINSERT）でも屋根平面を作り直さない
// （undoの記録の外にある屋根平面を階操作の時点で作り直すと、undoで旧屋根平面が戻らない）。
// 2026-10-21: 作り直さず新しい最上階へ付け替える（id を保つので undo の最後の follow で紐づけが戻る）。
test('roofPlaneHeight: 最上階の上へのINSERT（idが変わる）では屋根平面を作り直さず、新しい最上階p4へ付け替えて高さも追従する', async () => {
  const project = makeProjectWithThreeFloors();
  const { syncRoofPlane } = await import('./structural/roofPlane.js');
  const roof = syncRoofPlane(project); // roofForPlaneId='p3'
  const planeCountBefore = project.planeMap.size;

  // 最上階の上へ新しい最上階p4を追加する（p3の上。updatesは無し＝p3は動かない）
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: [],
    addPlane: () => project.addPlane(9000, '4階', 'p4', 4, 1),
    sourceGraph: {},
    ui: makeUi(),
  }, [floorOrderFollowers.find(f => f.name === 'roofPlaneHeight')]);

  assert.equal(project.roofPlane.id, roof.id, '屋根平面のidは変わらない（作り直していない）');
  assert.equal(project.roofPlane.roofForPlaneId, 'p4', 'roofForPlaneIdは新しい最上階p4へ付け替わる');
  assert.equal(project.roofPlane.elevation, 9001, '高さも新しい最上階+1');
  assert.equal(project.roofPlane.startFloor, 4);
  assert.equal(project.planeMap.size, planeCountBefore + 1, '増えるのは追加したp4の1つだけ（削除→新設はしていない）');
});

// 本番の floorOrderFollowers の並びのまま、structuralReflect だけ stub に差し替える（roofPlaneHeight は実物。
// 他の follower は何もしない fake）。stub が実行される位置で、屋根平面の roofForPlaneId・elevation が
// すでに新しい最上階を指している（roofPlaneHeight が structuralReflect より前にある）ことを固定する。
async function roofLinkSeenByStructuralReflect(project, opts) {
  let seen = null;
  const followers = floorOrderFollowers.map((f) => {
    if (f.name === 'structuralReflect') {
      return { ...f, async run(ctx) { seen = { forId: ctx.project.roofPlane.roofForPlaneId, elevation: ctx.project.roofPlane.elevation }; } };
    }
    if (f.name === 'roofPlaneHeight') return f;
    return { ...f, before: undefined, async run() {} };
  });
  await applyFloorOrderChange(project, { sourceGraph: {}, ui: makeUi(), ...opts }, followers);
  return seen;
}

test('roofPlaneHeight（本番の並び）: 最上階の上へのINSERTで、structuralReflect が見る屋根平面は新しい最上階 p4', async () => {
  const project = makeProjectWithThreeFloors();
  const { syncRoofPlane } = await import('./structural/roofPlane.js');
  syncRoofPlane(project);
  const seen = await roofLinkSeenByStructuralReflect(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: [],
    addPlane: () => project.addPlane(9000, '4階', 'p4', 4, 1),
  });
  assert.deepEqual(seen, { forId: 'p4', elevation: 9001 });
});

test('roofPlaneHeight（本番の並び）: CHANGE で最上階が p1 に入れ替わると、structuralReflect が見る屋根平面は p1', async () => {
  const project = makeProjectWithThreeFloors();
  const { syncRoofPlane } = await import('./structural/roofPlane.js');
  syncRoofPlane(project);
  const seen = await roofLinkSeenByStructuralReflect(project, {
    kind: FLOOR_ORDER_KIND.CHANGE, updates: [{ id: 'p1', name: '1階', startFloor: 4, elevation: 9000 }],
  });
  assert.deepEqual(seen, { forId: 'p1', elevation: 9001 });
});

test('roofPlaneHeight（本番の並び）: 最上階 p3 の DELETE で、structuralReflect が見る屋根平面は p2', async () => {
  const project = makeProjectWithThreeFloors();
  const { syncRoofPlane } = await import('./structural/roofPlane.js');
  syncRoofPlane(project);
  const seen = await roofLinkSeenByStructuralReflect(project, {
    kind: FLOOR_ORDER_KIND.DELETE, updates: [], removedPlane: project.planeMap.get('p3'),
    removePlane: () => { project.removePlane('p3'); return Promise.resolve(); },
  });
  assert.deepEqual(seen, { forId: 'p2', elevation: 3001 });
});
