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
    'roofPlaneHeight', 'stairsBelowRemoval', 'stairVoidReconcile', 'elevatorCopy', 'exteriorRoom',
    'mainRoofCarry', 'switchToAddedFloor', 'structuralReflect', 'elevatorRenumber',
  ]);
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
    FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE,
  ]);
  assert.deepEqual(byName.stairVoidReconcile, [
    FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
    FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE,
  ]);
  assert.deepEqual(byName.elevatorCopy, [FLOOR_ORDER_KIND.INSERT]);
  assert.deepEqual(byName.elevatorRenumber, [FLOOR_ORDER_KIND.DELETE]);
  assert.deepEqual(byName.exteriorRoom, [FLOOR_ORDER_KIND.INSERT]);
  assert.deepEqual(byName.stairsBelowRemoval, [FLOOR_ORDER_KIND.DELETE]);
  assert.deepEqual(byName.switchToAddedFloor, [FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER]);
  assert.deepEqual(byName.structuralReflect, [
    FLOOR_ORDER_KIND.INSERT, FLOOR_ORDER_KIND.ADD_LOWER, FLOOR_ORDER_KIND.DELETE,
    FLOOR_ORDER_KIND.REORDER, FLOOR_ORDER_KIND.CHANGE,
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
// （stairsBelowRemoval・stairVoidReconcile・elevatorRenumber）は他階の peek を避けるためfakeに差し替える。
test('DELETE のとき structuralReflect 相当の follower が呼ばれる', async () => {
  const project = makeProjectWithThreeFloors();
  let structuralCalled = false;
  const followers = floorOrderFollowers.map((f) => {
    if (f.name === 'structuralReflect') {
      return { ...f, async run() { structuralCalled = true; } };
    }
    if (f.name === 'stairsBelowRemoval' || f.name === 'stairVoidReconcile' || f.name === 'elevatorRenumber') {
      return { ...f, before: undefined, async run() {} };
    }
    return f;
  });

  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates: [],
    removePlane: () => { project.removePlane('p2'); return Promise.resolve(); },
    removedPlane: project.planeMap.get('p2'),
    below: null,
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

// 階変更（CHANGE）は stairVoidReconcile と structuralReflect だけが呼ばれる（stairsBelowRemovalはdeleteのみ）。
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
    'await removeStairsOnPlane(ctx.project, ctx.below, ctx.floorIo);',
    'runInAction(() => { for (const s of [...g.stairs]) removeStairOnFloor(g, s); });',
    'const copied = await copyElevatorsToNewFloor({ project: ctx.project, activeGraph: ctx.sourceGraph, newPlane: ctx.addedPlane });',
    'await addNewFloorRoomFromSource(ctx.project, ctx.sourceGraph, ctx.addedPlane, makeFloorName(ctx.newStartFloor, 1));',
    '.filter(p => p.isAlternative && p.referenceId === ctx.below.id);',
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

// QA指摘2026-10-01再裁定: 最上階idが変わる操作（最上階の上へのINSERT）では屋根平面を作り直さない
// （undoの記録の外にある屋根平面を階操作の時点で作り直すと、undoで旧屋根平面が戻らない）。
test('roofPlaneHeight: 最上階の上へのINSERT（idが変わる）では屋根平面を作り直さない', async () => {
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
  assert.equal(project.roofPlane.roofForPlaneId, 'p3', 'roofForPlaneIdは古いまま（新しい最上階p4には追従しない）');
  assert.equal(project.planeMap.size, planeCountBefore + 1, '増えるのは追加したp4の1つだけ（削除→新設はしていない）');
});
