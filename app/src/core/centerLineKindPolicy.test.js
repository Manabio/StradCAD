// centerLineKindPolicy.js の特性テスト。
// A. 原始事実（表そのもの）／B. 導出述語（種別レベルAPI・CLレベルAPI）／
// C. 製品コードとの一致（centerLineOps.js・followerGraph.js・beamAxisMove.js・centerLineConvert.js の
//    現行動作をポリシーの導出結果から計算した期待値と突き合わせる。「既知の乖離」と付記したテストは、
//    製品コードが生の labeled フラグで判定しておりポリシーの種別ベース判定と割れる旧データ限定の
//    ケースを、挙動を変えずにピン留めする）／D. 失敗系。
// この段階ではポリシーは製品コードから未接続（centerLineOps.js等はこれまで通りインラインの種別比較を
// 使う）。製品コード側をこの表へ移行する作業は本ファイルの範囲外（未着手）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CenterLineType, Discipline, CL_OVERLAP_TOL_MM } from './constants.js';
import { centerLineKind } from './centerLine.js';
import { Plane } from './plane.js';
import { Project } from './project.js';
import { PlanGraph } from './planGraph.js';
import {
  CL_KINDS, APP_MODES, VISIBLE_KINDS_BY_MODE, HIT_EXCLUDED_KINDS_BY_MODE, COEXISTENCE,
  ORTHO_ANCHOR_OVERRIDE, WALL_ANCHOR_KINDS, EXTENT_ANCHOR_STYLE, ENDPOINT_RULE_KINDS, FULL_SPAN_KINDS,
  CONVERT_BLOCKING_KINDS,
  kindsVisibleIn, hitTestKinds, kindsVisibleWith, orthoAnchorKinds, sameDirectionObstacleKinds,
  moveSnapTargetKinds,
  coexistenceAt, convertBlockingKinds, mergeableKinds, allowsWallAnchor, extentAnchorStyle,
  hasEndpointRule, spansEntireAxis,
  isOrthoAnchorCandidate, isSameDirectionObstacle, isMoveSnapTarget, isMergeCandidate,
  isRenderTarget, isHitTestTarget,
  coversAlongAxis, orthoAnchorCandidates, orthoAnchorCandidatesForNew, sameDirectionObstacles,
} from './centerLineKindPolicy.js';

// ---- 製品コード（section C）との突き合わせに使う実装 ----
import { addCenterLineFromDialog } from '../transform/centerLineOps.js';
import { computeMoveRange, collectFollowerOffsets } from '../transform/followerGraph.js';
import { beamAxisMoveRange } from '../structural/beamAxisMove.js';
import { checkPromoteToGridGuards, checkDemoteToCenterGuards } from '../transform/centerLineConvert.js';
import { findBracketingCLs, findCLMoveSnap, findBeamAxisMoveSnap } from '../snapGeometry.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// kind に対応する生成規約（centerLineOps.js の props 組み立てと同型）で、graph（center/aux/beam）または
// project.structGraph（struct）へ同座標の別CLを追加する。addCenterLineFromDialog の重複ガードは経由しない
// （ここでは生の graph.addCenterLine で「既に同座標に存在する状態」を直接作る）。
function addCLOfKind(graph, project, clType, value, kind) {
  switch (kind) {
    case 'struct': return project.structGraph.addCenterLine(clType, value, { labeled: true, discipline: Discipline.STRUCT });
    case 'center': return graph.addCenterLine(clType, value, { labeled: false, discipline: Discipline.ARCH });
    case 'aux':    return graph.addCenterLine(clType, value, { labeled: false, lineType: 'dashed' });
    case 'beam':   return graph.addCenterLine(clType, value, { labeled: false, discipline: Discipline.FUSE });
    default: throw new Error(`未知のCL種別: ${kind}`);
  }
}

// ================================================================
// A. 原始事実（表そのもの）
// ================================================================

test('VISIBLE_KINDS_BY_MODE: floorplan/finish/opening=[struct,center,aux]、structure=[struct,beam]、site/elevation=[]', () => {
  assert.deepEqual({ ...VISIBLE_KINDS_BY_MODE }, {
    floorplan: ['struct', 'center', 'aux'],
    finish:    ['struct', 'center', 'aux'],
    opening:   ['struct', 'center', 'aux'],
    structure: ['struct', 'beam'],
    site:      [],
    elevation: [],
  });
});

test('【不変条件】APP_MODES は ui/ModeBar.jsx の MODES の mode 値 ∪ [\'opening\'] と一致する', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../ui/ModeBar.jsx'), 'utf8');
  const modeValues = [...src.matchAll(/mode:\s*'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(modeValues.length >= 4, 'ModeBar.jsx から mode 値を抽出できなかった（正規表現がソースと食い違っている可能性）');
  const expected = [...new Set([...modeValues, 'opening'])].sort();
  assert.deepEqual([...APP_MODES].sort(), expected);
});

test('HIT_EXCLUDED_KINDS_BY_MODE: structure=[struct]のみ、他モードは除外エントリを持たない', () => {
  assert.deepEqual({ ...HIT_EXCLUDED_KINDS_BY_MODE }, { structure: ['struct'] });
});

test('COEXISTENCE: 16セルの値を固定する（原始事実の書き写し。製品コードとの実際の一致はセクションCで別途検証する）', () => {
  assert.deepEqual(
    Object.fromEntries(CL_KINDS.map(k => [k, { ...COEXISTENCE[k] }])),
    {
      struct: { struct: 'forbidden', center: 'promote',  aux: 'allowed',   beam: 'forbidden' },
      center: { struct: 'forbidden', center: 'extent',   aux: 'allowed',   beam: 'allowed'   },
      aux:    { struct: 'allowed',   center: 'allowed',  aux: 'extent',    beam: 'allowed'   },
      beam:   { struct: 'forbidden', center: 'forbidden', aux: 'forbidden', beam: 'extent'   },
    },
  );
});

test('小表: WALL_ANCHOR_KINDS・EXTENT_ANCHOR_STYLE・ENDPOINT_RULE_KINDS・FULL_SPAN_KINDS・CONVERT_BLOCKING_KINDS', () => {
  assert.deepEqual([...WALL_ANCHOR_KINDS], ['aux']);
  assert.deepEqual({ ...EXTENT_ANCHOR_STYLE }, { struct: 'none', center: 'ref', aux: 'overhang', beam: 'ref' });
  assert.deepEqual([...ENDPOINT_RULE_KINDS], ['center', 'beam']);
  assert.deepEqual([...FULL_SPAN_KINDS], ['struct']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(CONVERT_BLOCKING_KINDS).map(([k, v]) => [k, [...v]])),
    { promote: ['struct', 'beam'], demote: ['center', 'aux'] },
  );
});

test('【不変条件】原始事実の表（VISIBLE_KINDS_BY_MODE・COEXISTENCE・ORTHO_ANCHOR_OVERRIDE 他）はすべて Object.freeze されている', () => {
  assert.ok(Object.isFrozen(VISIBLE_KINDS_BY_MODE));
  for (const v of Object.values(VISIBLE_KINDS_BY_MODE)) assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(HIT_EXCLUDED_KINDS_BY_MODE));
  assert.ok(Object.isFrozen(COEXISTENCE));
  for (const v of Object.values(COEXISTENCE)) assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(ORTHO_ANCHOR_OVERRIDE));
  for (const v of Object.values(ORTHO_ANCHOR_OVERRIDE)) assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(WALL_ANCHOR_KINDS));
  assert.ok(Object.isFrozen(EXTENT_ANCHOR_STYLE));
  assert.ok(Object.isFrozen(ENDPOINT_RULE_KINDS));
  assert.ok(Object.isFrozen(FULL_SPAN_KINDS));
  assert.ok(Object.isFrozen(CONVERT_BLOCKING_KINDS));
  for (const v of Object.values(CONVERT_BLOCKING_KINDS)) assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(CL_KINDS));
  assert.ok(Object.isFrozen(APP_MODES));
});

// ================================================================
// B. 導出述語（種別レベルAPI）
// ================================================================

test('orthoAnchorKinds: center/aux は通り芯・中心線・補助線、beam は通り芯のみ（特例）', () => {
  assert.deepEqual(orthoAnchorKinds('center'), ['struct', 'center', 'aux']);
  assert.deepEqual(orthoAnchorKinds('aux'), ['struct', 'center', 'aux']);
  // transform/centerLineOps.js の allPerpCLs（aux分岐）は2026-09-19（ステップ3）に
  // orthoAnchorCandidates 経由へ移行済み——aux も beam を直交端部候補から除外する
  // （このテストが固定する orthoAnchorKinds('aux') の値と一致。移行前の挙動は下記セクションCの
  // 「m5」テストでピン留めしていたが、移行に伴い期待値を反転済み）。
  assert.deepEqual(orthoAnchorKinds('beam'), ['struct']);
});

test('sameDirectionObstacleKinds: struct→全4種、center/aux→通り芯・中心線・補助線、beam→通り芯・梁芯', () => {
  assert.deepEqual(sameDirectionObstacleKinds('struct'), ['struct', 'center', 'aux', 'beam']);
  assert.deepEqual(sameDirectionObstacleKinds('center'), ['struct', 'center', 'aux']);
  assert.deepEqual(sameDirectionObstacleKinds('aux'), ['struct', 'center', 'aux']);
  assert.deepEqual(sameDirectionObstacleKinds('beam'), ['struct', 'beam']);
});

// 「forbidden ペアは必ず sameDirectionObstacleKinds に含まれる」は、COEXISTENCE が双方向とも
// forbidden（＝物理的な同位置共存不可）な組にのみ適用する。片方向だけforbidden（例:
// beam×center=forbidden／center×beam=allowed）は「追加時にbeamを新規種別にする場合だけ拒否する」
// という追加操作固有の非対称規約であり、移動の物理衝突ではない
// （structural/beamAxisMove.js の beamAxisMoveRange コメント参照: 梁芯の移動は中心線・補助線を
// 障害物にしない＝実害が無いため）。片方向forbiddenまで含めると sameDirectionObstacleKinds(beam) は
// center/auxも含めねばならず、beamAxisMoveRangeの現行動作（struct/beamのみ）と食い違う。
test('【不変条件】双方向forbiddenの組（struct⇔struct・struct⇔beam）は必ず sameDirectionObstacleKinds に含まれる', () => {
  const symmetricForbiddenPairs = [];
  for (const a of CL_KINDS) {
    for (const b of CL_KINDS) {
      if (COEXISTENCE[a][b] === 'forbidden' && COEXISTENCE[b][a] === 'forbidden') symmetricForbiddenPairs.push([a, b]);
    }
  }
  assert.ok(symmetricForbiddenPairs.length > 0, '前提: 双方向forbiddenの組が存在する');
  for (const [a, b] of symmetricForbiddenPairs) {
    assert.ok(sameDirectionObstacleKinds(a).includes(b), `${a}×${b} は双方向forbiddenなのに sameDirectionObstacleKinds(${a}) に ${b} が無い`);
  }
});

test('moveSnapTargetKinds: struct/center/auxはいずれも通り芯・中心線・補助線（梁芯を含まない）、beamは通り芯・梁芯', () => {
  assert.deepEqual(moveSnapTargetKinds('struct'), ['struct', 'center', 'aux']);
  assert.deepEqual(moveSnapTargetKinds('center'), ['struct', 'center', 'aux']);
  assert.deepEqual(moveSnapTargetKinds('aux'), ['struct', 'center', 'aux']);
  assert.deepEqual(moveSnapTargetKinds('beam'), ['struct', 'beam']);
  // sameDirectionObstacleKinds（障害物集合）とは別の関係であることの確認: struct×beamは障害物集合では
  // 含まれるが吸着先集合では含まれない（findCLMoveSnapがmoving=structでも梁芯へ吸着しない現行仕様）。
  assert.ok(sameDirectionObstacleKinds('struct').includes('beam'));
  assert.ok(!moveSnapTargetKinds('struct').includes('beam'));
});

test('coexistenceAt: 引数の向きで結果が変わる非対称セル（struct×centerはpromote、center×structはforbidden）', () => {
  assert.equal(coexistenceAt('struct', 'center'), 'promote');
  assert.equal(coexistenceAt('center', 'struct'), 'forbidden');
});

test('convertBlockingKinds: promote(中心線→通り芯)は通り芯・梁芯、demote(通り芯→中心線)は中心線・補助線を拒否する', () => {
  assert.deepEqual(convertBlockingKinds('promote'), ['struct', 'beam']);
  assert.deepEqual(convertBlockingKinds('demote'), ['center', 'aux']);
});

test('mergeableKinds: 現行は同種別のみ', () => {
  for (const kind of CL_KINDS) assert.deepEqual(mergeableKinds(kind), [kind]);
});

test('hitTestKinds: floorplan/finish/opening=通り芯・中心線・補助線、structure=梁芯のみ', () => {
  assert.deepEqual(hitTestKinds('floorplan'), ['struct', 'center', 'aux']);
  assert.deepEqual(hitTestKinds('finish'), ['struct', 'center', 'aux']);
  assert.deepEqual(hitTestKinds('opening'), ['struct', 'center', 'aux']);
  assert.deepEqual(hitTestKinds('structure'), ['beam']);
  // site/elevation は可視モード表が空集合のため hitTestKinds も空になるが、現行 snap.js の
  // clKindFilter（appMode==='structure'以外は一律「梁芯以外」を対象にする）は site/elevation を
  // 特別扱いしていない——つまり現行 snap.js は「描画されないCLでもヒット対象になりうる」実装
  // であり、この関数（可視モード表ベース）の予測とは食い違う。site/elevationで実際に
  // resolvePointerTargets が呼ばれる経路があるかは未確認のまま残る（未裁定）。
  assert.deepEqual(hitTestKinds('site'), []);
  assert.deepEqual(hitTestKinds('elevation'), []);
});

test('allowsWallAnchor / extentAnchorStyle / hasEndpointRule / spansEntireAxis', () => {
  assert.deepEqual(CL_KINDS.map(allowsWallAnchor), [false, false, true, false]); // struct,center,aux,beam
  assert.deepEqual(CL_KINDS.map(extentAnchorStyle), ['none', 'ref', 'overhang', 'ref']);
  assert.deepEqual(CL_KINDS.map(hasEndpointRule), [false, true, false, true]);
  assert.deepEqual(CL_KINDS.map(spansEntireAxis), [true, false, false, false]);
});

// ---- B1: CLレベルAPIの肯定側（骨抜き＝常に false/true 固定でも通ってしまう穴を塞ぐ）----

test('isOrthoAnchorCandidate: 肯定側（VERTICAL中心線subject×直交HORIZONTAL補助線・梁芯・同方向中心線、tolMm境界）', () => {
  const { graph } = makeProjectWithGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const coveringAux = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 500, extentHi: 1500,
  });
  assert.equal(isOrthoAnchorCandidate(subject, coveringAux), true, '(i) extentがsubject.valueを含むHORIZONTAL補助線はtrue');

  const nonCoveringAux = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, {
    labeled: false, lineType: 'dashed', extentLo: 1500, extentHi: 1800,
  });
  assert.equal(isOrthoAnchorCandidate(subject, nonCoveringAux), false, '(ii) extentがsubject.valueを含まない同種はfalse');

  const coveringBeam = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 500, extentHi: 1500,
  });
  assert.equal(isOrthoAnchorCandidate(subject, coveringBeam), false, '(iii) extentは含むが種別（梁芯）がorthoAnchorKinds(center)に無いのでfalse');

  const sameDirectionCenter = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(isOrthoAnchorCandidate(subject, sameDirectionCenter), false, '(iv) 同方向（VERTICAL同士）は直交でないのでfalse');

  const tolBoundary = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, {
    labeled: false, lineType: 'dashed', extentLo: 400, extentHi: 900,
  });
  assert.equal(isOrthoAnchorCandidate(subject, tolBoundary, { tolMm: 100 }), true, 'tolMm境界: extentHi+tolMm=1000ちょうど（=subject.value）はtrue');
  assert.equal(isOrthoAnchorCandidate(subject, tolBoundary, { tolMm: 99 }), false, 'tolMm境界: extentHi+tolMm=999<1000で超過のためfalse');
});

test('orthoAnchorCandidates: graph.centerLines を isOrthoAnchorCandidate(subject, other, opts) でフィルタした配列を返す（走査API。graphはcenterLinesゲッターのみ使用しPlanGraphに依存しない）', () => {
  const { graph } = makeProjectWithGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const coveringAux = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 500, extentHi: 1500,
  });
  const nonCoveringAux = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, {
    labeled: false, lineType: 'dashed', extentLo: 1500, extentHi: 1800,
  });
  const coveringBeam = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 500, extentHi: 1500,
  });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 同方向（直交ではない）

  const candidates = orthoAnchorCandidates(graph, subject);
  assert.deepEqual(candidates.map(c => c.id).sort(), [coveringAux.id].sort(), '直交・種別・extent被覆を満たすのは coveringAux のみ（同方向・非被覆・梁芯は除外）');
  assert.equal(candidates.some(c => c.id === nonCoveringAux.id), false);
  assert.equal(candidates.some(c => c.id === coveringBeam.id), false);

  // 最小のダックタイピング（{centerLines}のみ）でも動く＝PlanGraph自体には依存していないことの確認。
  const duckGraph = { centerLines: graph.centerLines };
  const duckCandidates = orthoAnchorCandidates(duckGraph, subject);
  assert.deepEqual(duckCandidates.map(c => c.id), candidates.map(c => c.id));

  // opts（tolMm）はそのまま isOrthoAnchorCandidate へ渡される。
  const tolBoundary = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, {
    labeled: false, lineType: 'dashed', extentLo: 400, extentHi: 900,
  });
  assert.equal(orthoAnchorCandidates(graph, subject, { tolMm: 100 }).some(c => c.id === tolBoundary.id), true);
  assert.equal(orthoAnchorCandidates(graph, subject, { tolMm: 99 }).some(c => c.id === tolBoundary.id), false);
});

// ---- orthoAnchorCandidatesForNew: まだグラフに存在しない新規CL用の走査API ----
// （まだ生成されていないCL向け。ダック型の仮オブジェクトを作らせる代わりにkind・centerLineType・
// coordを明示引数にして、coordの渡し忘れ事故を型で防ぐのが目的。判定本体はisOrthoAnchorCandidateと
// 共有——orthoAnchorCandidatesが薄いラッパーとしてこれへ委譲していることを別テストで確認する）。

test('orthoAnchorCandidatesForNew: kindごとの候補集合はorthoAnchorKindsの予測と一致する（center/aux=通り芯・中心線・補助線、beam=通り芯のみ）', () => {
  const { project, graph } = makeProjectWithGraph();
  const structLo  = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -500, { labeled: true, discipline: Discipline.STRUCT });
  const centerCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const auxCL     = graph.addCenterLine(CenterLineType.HORIZONTAL, 200, { labeled: false, lineType: 'dashed' });
  const beamCL    = graph.addCenterLine(CenterLineType.HORIZONTAL, 400, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH }); // 同方向（直交ではないので常に除外）

  for (const kind of ['center', 'aux', 'beam']) {
    const candidates = orthoAnchorCandidatesForNew(graph, { kind, centerLineType: CenterLineType.VERTICAL, coord: 1000 });
    const allowedKinds = orthoAnchorKinds(kind);
    assert.deepEqual(
      candidates.map(c => c.id).sort(),
      [structLo, centerCL, auxCL, beamCL].filter(c => allowedKinds.includes(centerLineKind(c))).map(c => c.id).sort(),
      `kind=${kind}`,
    );
  }
});

test('orthoAnchorCandidatesForNew: excludeで指定したCLは候補から除外される', () => {
  const { graph } = makeProjectWithGraph();
  const a = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const b = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });

  const withoutExclude = orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.VERTICAL, coord: 1000 });
  assert.deepEqual(withoutExclude.map(c => c.id).sort(), [a.id, b.id].sort());

  const withExclude = orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.VERTICAL, coord: 1000, exclude: a });
  assert.deepEqual(withExclude.map(c => c.id), [b.id]);
});

test('orthoAnchorCandidatesForNew: centerLineTypeがRADIALなら常に空配列（isOrthoAnchorCandidateのsubject RADIAL除外と同型）', () => {
  const { graph } = makeProjectWithGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  assert.deepEqual(orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.RADIAL, coord: 1000 }), []);
});

test('【失敗系】orthoAnchorCandidatesForNew: 未知のkindはthrowする', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(
    () => orthoAnchorCandidatesForNew(graph, { kind: 'wood', centerLineType: CenterLineType.VERTICAL, coord: 1000 }),
    /未知のCL種別: wood/,
  );
});

test('【失敗系】orthoAnchorCandidatesForNew: coordが数値でなければthrowする（未指定・undefined・NaN・文字列）', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(() => orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.VERTICAL }), /coord/);
  assert.throws(() => orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.VERTICAL, coord: undefined }), /coord/);
  assert.throws(() => orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.VERTICAL, coord: NaN }), /coord/);
  assert.throws(() => orthoAnchorCandidatesForNew(graph, { kind: 'center', centerLineType: CenterLineType.VERTICAL, coord: '1000' }), /coord/);
});

test('orthoAnchorCandidates: 既存CLオブジェクトのsubjectに対し、orthoAnchorCandidatesForNewへの委譲後も同じ結果を返す（委譲の回帰確認）', () => {
  const { graph } = makeProjectWithGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 500, extentHi: 1500,
  });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, {
    labeled: false, lineType: 'dashed', extentLo: 1500, extentHi: 1800,
  });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 500, extentHi: 1500,
  });

  const viaWrapper = orthoAnchorCandidates(graph, subject);
  const viaForNew = orthoAnchorCandidatesForNew(graph, {
    kind: centerLineKind(subject), centerLineType: subject.centerLineType, coord: subject.value, exclude: subject,
  });
  assert.deepEqual(viaWrapper.map(c => c.id).sort(), viaForNew.map(c => c.id).sort());
  assert.ok(viaWrapper.length > 0, '前提: 候補が実際に1件以上ある（空配列同士の一致で通ってしまう骨抜きを防ぐ）');
});

test('isSameDirectionObstacle: 肯定側（中心線subject×同方向の通り芯・中心線・補助線・梁芯、直交の通り芯は対象外）', () => {
  const { graph } = makeProjectWithGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const otherStruct = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const otherCenter = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const otherAux    = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, lineType: 'dashed' });
  const otherBeam   = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false, discipline: Discipline.FUSE });
  const orthoStruct = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });

  // 期待値は sameDirectionObstacleKinds から計算する（ハードコードしない）。
  const allowedKinds = sameDirectionObstacleKinds('center');
  for (const other of [otherStruct, otherCenter, otherAux, otherBeam]) {
    assert.equal(isSameDirectionObstacle(subject, other), allowedKinds.includes(centerLineKind(other)), `同方向${centerLineKind(other)}`);
  }
  assert.equal(isSameDirectionObstacle(subject, orthoStruct), false, '直交（centerLineType不一致）は対象外');
});

test('sameDirectionObstacles: graph.centerLines を isSameDirectionObstacle(subject, other) でフィルタした配列を返す（走査API）', () => {
  const { graph } = makeProjectWithGraph();
  const subject = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const otherStruct = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const otherBeam   = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 直交（対象外）

  const obstacles = sameDirectionObstacles(graph, subject);
  // subject=center: sameDirectionObstacleKinds('center')=['struct','center','aux']→梁芯は含まれない。
  assert.deepEqual(obstacles.map(c => c.id).sort(), [otherStruct.id].sort());
  assert.equal(obstacles.some(c => c.id === otherBeam.id), false);

  // 最小のダックタイピング（{centerLines}のみ）でも動く。
  const duckGraph = { centerLines: graph.centerLines };
  assert.deepEqual(sameDirectionObstacles(duckGraph, subject).map(c => c.id).sort(), obstacles.map(c => c.id).sort());
});

test('isMoveSnapTarget: 肯定側（subject=struct/center/aux は梁芯を対象にしない、subject=beamは通り芯・梁芯のみ対象）', () => {
  const { graph } = makeProjectWithGraph();
  const structSubject = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const beamSubject    = graph.addCenterLine(CenterLineType.VERTICAL, 100, { labeled: false, discipline: Discipline.FUSE });
  const otherStruct = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const otherCenter = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const otherBeam   = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });

  assert.equal(isMoveSnapTarget(structSubject, otherStruct), true);
  assert.equal(isMoveSnapTarget(structSubject, otherCenter), true);
  assert.equal(isMoveSnapTarget(structSubject, otherBeam), false, 'subject=structでも梁芯は吸着先にならない');

  assert.equal(isMoveSnapTarget(beamSubject, otherStruct), true);
  assert.equal(isMoveSnapTarget(beamSubject, otherBeam), true);
  assert.equal(isMoveSnapTarget(beamSubject, otherCenter), false, 'subject=beamは中心線を吸着先にしない');
});

test('isMergeCandidate: 肯定側（補助線×補助線=true、補助線×中心線=false、相手がlabeled:trueならfalse）', () => {
  const { graph } = makeProjectWithGraph();
  const auxA = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
  const auxB = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, lineType: 'dashed' });
  const center = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const auxLabeledLegacy = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, lineType: 'dashed' });

  assert.equal(isMergeCandidate(auxA, auxB), true, '補助線×補助線（両方labeled:false）はtrue');
  assert.equal(isMergeCandidate(auxA, center), false, '補助線×中心線（種別不一致）はfalse');
  assert.equal(isMergeCandidate(auxA, auxLabeledLegacy), false, '相手がlabeled:trueならfalse');
});

test('isRenderTarget / isHitTestTarget: 4種別×6appModeの全組み合わせが VISIBLE_KINDS_BY_MODE / hitTestKinds の予測と一致する', () => {
  const { project, graph } = makeProjectWithGraph();
  for (const kind of CL_KINDS) {
    const cl = addCLOfKind(graph, project, CenterLineType.VERTICAL, (CL_KINDS.indexOf(kind) + 1) * 1000, kind);
    for (const mode of APP_MODES) {
      assert.equal(isRenderTarget(cl, mode), VISIBLE_KINDS_BY_MODE[mode].includes(kind), `isRenderTarget ${kind}×${mode}`);
      assert.equal(isHitTestTarget(cl, mode), hitTestKinds(mode).includes(kind), `isHitTestTarget ${kind}×${mode}`);
    }
  }
});

// ================================================================
// C. 製品コードとの一致（特性テストの本体）
// ================================================================

test('addCenterLineFromDialog: 中心線の追加extentの直交端部候補は orthoAnchorKinds(center) の予測と一致する（梁芯は選ばれない）', () => {
  const { project, graph } = makeProjectWithGraph();
  const structLo = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -100, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, -50, { labeled: false, discipline: Discipline.FUSE }); // 梁芯（perpCoordに近いが選ばれてはいけない）
  graph.addCenterLine(CenterLineType.HORIZONTAL, 50,  { labeled: false, discipline: Discipline.FUSE }); // 梁芯（同上）
  const auxHi = graph.addCenterLine(CenterLineType.HORIZONTAL, 100, { labeled: false, lineType: 'dashed' });

  // ポリシーの導出結果（orthoAnchorKinds）から期待値を計算する（ハードコードしない）。
  const allowedKinds = orthoAnchorKinds('center');
  const candidates = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && allowedKinds.includes(centerLineKind(cl)));
  const [expectedLo, expectedHi] = findBracketingCLs(candidates, 0);

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  assert.equal(added.extentLoRef?.clId, expectedLo?.id);
  assert.equal(added.extentHiRef?.clId, expectedHi?.id);
  assert.equal(added.extentLoRef?.clId, structLo.id, '梁芯(-50)ではなく通り芯(-100)が選ばれる');
  assert.equal(added.extentHiRef?.clId, auxHi.id, '梁芯(50)ではなく補助線(100)が選ばれる');
});

test('addCenterLineFromDialog: 梁芯の追加extentの直交端部候補は orthoAnchorKinds(beam) の予測と一致する（通り芯のみ。手前の梁芯・中心線・補助線は選ばれない）', () => {
  const { project, graph } = makeProjectWithGraph();
  // kindsVisibleWith('beam') は元々 struct・beam の2種類しか含まない（beamは'structure'モードでしか
  // 可視でなく、そのモードの可視種別は['struct','beam']のため）——center/aux は特例の有無に関わらず
  // orthoAnchorKinds('beam') に入らない。ORTHO_ANCHOR_OVERRIDE（beam→struct限定の特例）が無いと
  // 変わるのは「beam自身」が候補に含まれるかどうかだけなので、特例を外す変異を検出するには
  // 手前（通り芯より近い側）に直交の**梁芯**を置く必要がある（中心線・補助線を置くだけでは
  // orthoAnchorKinds('beam')の値が変わらず変異を検出できない）。中心線・補助線も併置し、
  // そちらは特例の有無によらず常に除外されることを合わせて固定する。
  const structLo = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -200, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, -100, { labeled: false, discipline: Discipline.FUSE }); // 梁芯（struct(-200)より近い。特例が外れると選ばれてしまう）
  graph.addCenterLine(CenterLineType.HORIZONTAL, -50,  { labeled: false, discipline: Discipline.ARCH }); // 中心線（さらに近いが、特例の有無に関わらず対象外）
  graph.addCenterLine(CenterLineType.HORIZONTAL, 50,   { labeled: false, lineType: 'dashed' });          // 補助線（同上）
  graph.addCenterLine(CenterLineType.HORIZONTAL, 100,  { labeled: false, discipline: Discipline.FUSE }); // 梁芯（struct(200)より近い。特例が外れると選ばれてしまう）
  const structHi = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 200, { labeled: true, discipline: Discipline.STRUCT });

  const allowedKinds = orthoAnchorKinds('beam');
  const candidates = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && allowedKinds.includes(centerLineKind(cl)));
  const [expectedLo, expectedHi] = findBracketingCLs(candidates, 0);

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'beam', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000 && centerLineKind(cl) === 'beam');
  assert.ok(added, '梁芯が追加されているはず');
  assert.equal(added.extentLoRef?.clId, expectedLo?.id);
  assert.equal(added.extentHiRef?.clId, expectedHi?.id);
  assert.equal(added.extentLoRef?.clId, structLo.id, '手前の梁芯(-100)・中心線(-50)ではなく通り芯(-200)が選ばれる');
  assert.equal(added.extentHiRef?.clId, structHi.id, '手前の補助線(50)・梁芯(100)ではなく通り芯(200)が選ばれる');
});

for (const movingKind of ['center', 'aux', 'struct']) {
  test(`computeMoveRange: 移動種別=${movingKind} の障害物は sameDirectionObstacleKinds(${movingKind}) の予測と一致する`, () => {
    const { graph } = makeProjectWithGraph();
    const movingProps = {
      struct: { labeled: true,  discipline: Discipline.STRUCT },
      center: { labeled: false, discipline: Discipline.ARCH },
      aux:    { labeled: false, lineType: 'dashed' },
    }[movingKind];
    const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, movingProps);

    graph.addCenterLine(CenterLineType.VERTICAL, -5000, { labeled: true,  discipline: Discipline.STRUCT });
    graph.addCenterLine(CenterLineType.VERTICAL, -3000, { labeled: false, discipline: Discipline.ARCH });
    graph.addCenterLine(CenterLineType.VERTICAL, -2000, { labeled: false, lineType: 'dashed' });
    graph.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.FUSE });
    graph.addCenterLine(CenterLineType.VERTICAL, 1000,  { labeled: false, discipline: Discipline.FUSE });
    graph.addCenterLine(CenterLineType.VERTICAL, 2000,  { labeled: false, lineType: 'dashed' });
    graph.addCenterLine(CenterLineType.VERTICAL, 3000,  { labeled: false, discipline: Discipline.ARCH });
    graph.addCenterLine(CenterLineType.VERTICAL, 5000,  { labeled: true,  discipline: Discipline.STRUCT });

    const bundle = { centerLines: graph.centerLines, walls: graph.walls, diagonals: [] };
    const { offsetOf } = collectFollowerOffsets(bundle, moving);
    const range = computeMoveRange(bundle, moving, offsetOf);

    // ポリシーの導出結果（sameDirectionObstacleKinds）から期待値を計算する（ハードコードしない）。
    const allowedKinds = sameDirectionObstacleKinds(movingKind);
    const candidates = graph.centerLines.filter(cl =>
      cl.centerLineType === CenterLineType.VERTICAL && cl.id !== moving.id && allowedKinds.includes(centerLineKind(cl)));
    let expectedMin = -Infinity, expectedMax = Infinity;
    for (const cl of candidates) {
      if (cl.value < 0 && cl.value > expectedMin) expectedMin = cl.value;
      if (cl.value > 0 && cl.value < expectedMax) expectedMax = cl.value;
    }

    assert.equal(range.min, expectedMin);
    assert.equal(range.max, expectedMax);
  });
}

test('beamAxisMoveRange: 障害物は sameDirectionObstacleKinds(beam) の予測（通り芯・梁芯のみ）と一致する', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 10000,  { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 3500, { labeled: false, discipline: Discipline.ARCH }); // 中心線（障害物にならないはず）
  graph.addCenterLine(CenterLineType.VERTICAL, 6500, { labeled: false, lineType: 'dashed' });           // 補助線（同上）
  const a = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const b = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.FUSE });

  const allowedKinds = sameDirectionObstacleKinds('beam');
  const expectedRangeFor = (cl) => {
    const candidates = graph.centerLines.filter(c =>
      c.centerLineType === CenterLineType.VERTICAL && c.id !== cl.id && allowedKinds.includes(centerLineKind(c)));
    let min = -Infinity, max = Infinity;
    for (const c of candidates) {
      if (c.value < cl.value && c.value > min) min = c.value;
      if (c.value > cl.value && c.value < max) max = c.value;
    }
    return {
      min: min === -Infinity ? -Infinity : min + CL_OVERLAP_TOL_MM,
      max: max === Infinity ? Infinity : max - CL_OVERLAP_TOL_MM,
    };
  };

  assert.deepEqual(beamAxisMoveRange(graph, a), expectedRangeFor(a));
  assert.deepEqual(beamAxisMoveRange(graph, b), expectedRangeFor(b));
});

// ---- M-1(ステップ4QA指摘): labeled→種別ベース統一で解消された「既知の乖離」の反転ピン留め。
// 移行前は生の `other.labeled` を見ていたため、旧データ（`{labeled:true, discipline:ARCH}` のような
// labeled と種別が食い違う異常値）も障害物・スナップ吸着先になっていた。移行後は種別ベース
// （sameDirectionObstacleKinds('beam')=['struct','beam']）のため、通り芯でない旧データは障害物に
// ならない——この反転を明示的にピン留めする（transform/centerLineOps.js のm4/m5と同じ流儀）。

test('【旧データ限定・種別ベースへ統一】beamAxisMoveRange: labeled:trueでも種別が通り芯でないCL（{labeled:true, discipline:ARCH}）は障害物にならない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.ARCH });
  assert.equal(centerLineKind(legacy), 'center', '前提: discipline=ARCHなのでcenter種別（labeled:trueだが種別は通り芯でない旧データ）');
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });

  const range = beamAxisMoveRange(graph, beam);
  assert.equal(range.min, 0 + CL_OVERLAP_TOL_MM);
  assert.equal(range.max, 10000 - CL_OVERLAP_TOL_MM, '移行前は旧データ(4000)で止まっていたが、移行後は種別ベースのため素通りし通り芯(10000)で止まる');
});

for (const movingKind of ['struct', 'center', 'aux']) {
  test(`findCLMoveSnap: 移動種別=${movingKind} の吸着先種別は moveSnapTargetKinds(${movingKind}) の予測と一致する（梁芯を除外）`, () => {
    const { graph } = makeProjectWithGraph();
    const movingProps = {
      struct: { labeled: true,  discipline: Discipline.STRUCT },
      center: { labeled: false, discipline: Discipline.ARCH },
      aux:    { labeled: false, lineType: 'dashed' },
    }[movingKind];
    const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, movingProps);
    graph.addCenterLine(CenterLineType.VERTICAL, 3, { labeled: false, discipline: Discipline.FUSE }); // 梁芯（最も近い）
    const struct = graph.addCenterLine(CenterLineType.VERTICAL, 6, { labeled: true, discipline: Discipline.STRUCT });

    const targetKinds = moveSnapTargetKinds(movingKind);
    assert.ok(!targetKinds.includes('beam'), '前提: moveSnapTargetKindsは梁芯を含まない');
    const snap = findCLMoveSnap(graph, moving, 0, 0, 8, 1, 1);
    assert.equal(snap, struct.value, `moving=${movingKind}: 梁芯(3)ではなく通り芯(6)へ吸着するはず`);
  });
}

test('findBeamAxisMoveSnap: 障害物は sameDirectionObstacleKinds(beam) の予測（通り芯・梁芯のみ）と一致する', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH }); // 中心線（障害物にならないはず）
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: false, lineType: 'dashed' });          // 補助線（同上）
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.FUSE });

  const allowedKinds = sameDirectionObstacleKinds('beam');
  const obstacles = graph.centerLines.filter(c =>
    c.centerLineType === CenterLineType.VERTICAL && c.id !== moving.id && allowedKinds.includes(centerLineKind(c)));
  let lo = -Infinity, hi = Infinity;
  for (const c of obstacles) {
    if (c.value < moving.value && c.value > lo) lo = c.value;
    if (c.value > moving.value && c.value < hi) hi = c.value;
  }
  const expectedMid = (lo + hi) / 2;

  const snap = findBeamAxisMoveSnap(graph, moving, expectedMid, 0, 50, 1, 1);
  assert.equal(snap, expectedMid, '中心線・補助線は障害物にならず通り芯0・10000の中点へ吸着するはず');
});

test('【旧データ限定・種別ベースへ統一】findBeamAxisMoveSnap: labeled:trueでも種別が通り芯でないCL（{labeled:true, lineType:dashed}）を挟んでも中点は通り芯基準のまま', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: true, lineType: 'dashed' });
  assert.equal(centerLineKind(legacy), 'aux', '前提: lineType=dashedなのでaux種別（labeled:trueだが種別は通り芯でない旧データ）');
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.FUSE });

  const snap = findBeamAxisMoveSnap(graph, moving, 5000, 0, 50, 1, 1);
  assert.equal(snap, 5000, '移行前は旧データ(6000)がhi側障害物になり中点が変わっていたが、移行後は種別ベースのため素通りし通り芯0・10000の中点(5000)へ吸着する');
});

test('checkPromoteToGridGuards: 拒否する既存種別は convertBlockingKinds(\'promote\') の予測と一致する', () => {
  for (const candidateKind of CL_KINDS) {
    const { project, graph } = makeProjectWithGraph();
    const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 昇格対象の中心線
    addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, candidateKind); // 同座標に別のCL（種別=candidateKind）

    const expectedBlocked = convertBlockingKinds('promote').includes(candidateKind);
    const error = checkPromoteToGridGuards(graph, project.structGraph, cl);
    assert.equal(!!error, expectedBlocked, `candidateKind=${candidateKind}`);
  }
});

test('checkDemoteToCenterGuards: 拒否する既存種別は convertBlockingKinds(\'demote\') の予測と一致する', () => {
  for (const candidateKind of CL_KINDS) {
    const { project, graph } = makeProjectWithGraph();
    // NO_GRID/LAST_GRIDガードを通すための最小構成（直交2本＋同軸2本）。
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
    const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

    addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, candidateKind); // 移籍先の階グラフに同座標のCL

    const expectedBlocked = convertBlockingKinds('demote').includes(candidateKind);
    const error = checkDemoteToCenterGuards(graph, project.structGraph, cl);
    assert.equal(!!error, expectedBlocked, `candidateKind=${candidateKind}`);
  }
});

// ---- B2: COEXISTENCE 16セルの製品コードとの一致（addCenterLineFromDialogを実際に呼んで検証）----

test('COEXISTENCE: 製品コード addCenterLineFromDialog の帰結が coexistenceAt(newKind, existingKind) の予測と一致する（forbidden/promote/allowed/extentの重複・分離を実際に再現）', () => {
  const vp = { scaleDenominator: 100 };
  const clType = CenterLineType.VERTICAL;
  const perpType = CenterLineType.HORIZONTAL;
  const value = 1000;

  // extent種別（同種別center/aux/beam）の2配置はどちらも同じ直交環境（通り芯2本 1000/3000、
  // perpCoord=2000）を使う——新規側の extentLo/Hi は center/beam なら常にブラケットそのもの
  // [1000, 3000]、aux は初回追加（anyAuxRefsCLがfalse）ではね出し込みの静的値になるため
  // [1000-overhang, 3000+overhang] とやや広くなる（centerLineOps.js:449/473 の overhang 減算・加算）。
  // 既存側に明示的な数値extentを与えることで、どちらの配置も null 短絡
  // （centerLineOps.js:517-518 `newExtentLo==null || ... || exLo==null || exHi==null`）を経由せず、
  // 実際の区間重なり演算（degenerate=false の閉区間比較、L519 `!(newExtentHi<=exLo||newExtentLo>=exHi)`）
  // を通す。
  // 重ねた配置: 既存[500,3500]は新規の実extent（center/beam:[1000,3000]、aux:[700,3300]相当）を
  // 包含し重なる。離した配置: 既存[5000,8000]は新規の実extentより十分右に離れており重ならない。
  function placeExisting(graph, project, kind, extentLo, extentHi) {
    if (kind === 'struct') return project.structGraph.addCenterLine(clType, value, { labeled: true, discipline: Discipline.STRUCT });
    if (kind === 'aux') return graph.addCenterLine(clType, value, { labeled: false, lineType: 'dashed', extentLo, extentHi });
    const discipline = kind === 'beam' ? Discipline.FUSE : Discipline.ARCH;
    return graph.addCenterLine(clType, value, { labeled: false, discipline, extentLo, extentHi });
  }
  function makeBracketedFixture() {
    const { project, graph } = makeProjectWithGraph();
    project.structGraph.addCenterLine(perpType, 1000, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(perpType, 3000, { labeled: true, discipline: Discipline.STRUCT });
    return { project, graph };
  }

  for (const newKind of CL_KINDS) {
    for (const existingKind of CL_KINDS) {
      const outcome = coexistenceAt(newKind, existingKind);
      const label = `${newKind}→${existingKind}(${outcome})`;

      if (outcome === 'extent') {
        // 重ねた配置（既存[500,3500]が新規の実extentを包含して重なる。struct existingKindは
        // placeExistingがextent引数を無視するためnull短絡になるが、struct×struct/beamはそもそも
        // 'extent'に分類されない=このifには来ない——existingKindは常にcenter/aux/beamのいずれか）。
        {
          const { project, graph } = makeBracketedFixture();
          const existingCl = placeExisting(graph, project, existingKind, 500, 3500);
          const result = addCenterLineFromDialog(
            graph, project,
            { clDialog: { type: 'vertical', worldCoord: value, perpCoord: 2000 }, value, kind: newKind, refId: null, refOffset: 0 },
            vp,
          );
          assert.equal(result.done, false, `${label} 重ねた配置`);
          assert.ok(typeof result.toast === 'string' && result.toast.length > 0, `${label} 重ねた配置: toastが入る`);
          assert.ok(graph.centerLines.some(cl => cl.id === existingCl.id), `${label} 重ねた配置: 既存は残る`);
        }
        // 離した配置（既存[5000,8000]は新規の実extentより右に離れており重ならない）
        {
          const { project, graph } = makeBracketedFixture();
          const existingCl = placeExisting(graph, project, existingKind, 5000, 8000);
          const result = addCenterLineFromDialog(
            graph, project,
            { clDialog: { type: 'vertical', worldCoord: value, perpCoord: 2000 }, value, kind: newKind, refId: null, refOffset: 0 },
            vp,
          );
          assert.equal(result.done, true, `${label} 離した配置`);
          assert.ok(graph.centerLines.some(cl => cl.id === existingCl.id), `${label} 離した配置: 既存は残る`);
          const added = graph.centerLines.filter(cl =>
            cl.centerLineType === clType && Math.abs(cl.value - value) < 1 && cl.id !== existingCl.id);
          assert.equal(added.length, 1, `${label} 離した配置: 新規が1本追加される`);
        }
        continue;
      }

      const { project, graph } = makeProjectWithGraph();
      const existingCl = addCLOfKind(graph, project, clType, value, existingKind);
      const result = addCenterLineFromDialog(
        graph, project,
        { clDialog: { type: 'vertical', worldCoord: value, perpCoord: 0 }, value, kind: newKind, refId: null, refOffset: 0 },
        vp,
      );

      if (outcome === 'forbidden') {
        assert.equal(result.done, false, label);
        assert.ok(typeof result.toast === 'string' && result.toast.length > 0, `${label}: toastが入る`);
        assert.ok(graph.centerLines.some(cl => cl.id === existingCl.id), `${label}: 既存は残る`);
      } else if (outcome === 'promote') {
        assert.equal(result.done, true, label);
        assert.equal(graph.shapeMap.has(existingCl.id), false, `${label}: 既存（中心線）は削除される`);
        assert.ok(project.structGraph.centerLines.some(cl =>
          cl.centerLineType === clType && Math.abs(cl.value - value) < 1 && centerLineKind(cl) === 'struct'), `${label}: structGraphに通り芯が増える`);
      } else if (outcome === 'allowed') {
        assert.equal(result.done, true, label);
        assert.equal(result.toast, null, `${label}: toastはnull`);
        assert.ok(graph.centerLines.some(cl => cl.id === existingCl.id), `${label}: 既存は残る`);
        const added = graph.centerLines.filter(cl =>
          cl.centerLineType === clType && Math.abs(cl.value - value) < 1 && cl.id !== existingCl.id && centerLineKind(cl) === newKind);
        assert.equal(added.length, 1, `${label}: 新規（種別=${newKind}）が1本追加される`);
      } else {
        assert.fail(`未知のcoexistenceAt結果: ${outcome}`);
      }
    }
  }
});

// ---- M4(b): 追加extentのステップ3移行（centerLineOps.js を orthoAnchorCandidates 経由へ移行）で
// 種別ベースへ統一されたピン留めテスト。旧データ（`{labeled:true, discipline:'arch'}` のような
// labeled と種別が食い違う異常値。AddCLDialog経由の通常追加は必ず labeled:false を明示するため
// ダイアログ経由では作れない——直接 graph.addCenterLine で模した「旧データ」としてのみ再現する）は、
// 移行前は生の labeled フラグで候補に混ざっていたが、移行後は orthoAnchorKinds の種別ベース予測と
// 一致するようになった（現行の生成経路は0件・旧データ限定の理論上のケース）。

test('【旧データ限定・種別ベースへ統一】addCenterLineFromDialog(kind:beam) の直交端部候補は種別ベース（orthoAnchorKinds(beam)=[struct]のみ）——labeled:trueでも種別が通り芯でない旧データは候補にしない', () => {
  const { project, graph } = makeProjectWithGraph();
  const structFar = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -500, { labeled: true, discipline: Discipline.STRUCT });
  const legacyLabeledCenter = graph.addCenterLine(CenterLineType.HORIZONTAL, -100, { labeled: true, discipline: Discipline.ARCH });
  assert.equal(centerLineKind(legacyLabeledCenter), 'center', '前提: centerLineKindは種別ベースなので中心線のまま（旧データが実際に作れることの確認）');

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'beam', refId: null, refOffset: 0 },
    { scaleDenominator: 100 },
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000 && centerLineKind(cl) === 'beam');
  // 移行後の実際の挙動: orthoAnchorCandidates は種別ベースで判定するため、labeled:trueでも
  // centerLineKindが'center'の旧データ（legacyLabeledCenter, -100）は候補にならず、
  // struct(-500)が選ばれる。
  assert.equal(added.extentLoRef?.clId, structFar.id, '移行後は種別ベースで絞るため、labeled:trueでも中心線（centerLineKind==="center"）は候補にならずstruct(-500)が選ばれる');

  // ポリシーの種別ベース予測（orthoAnchorKinds('beam')は'struct'のみ）と一致することを確認する。
  const allowedKinds = orthoAnchorKinds('beam');
  const policyCandidates = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && allowedKinds.includes(centerLineKind(cl)));
  const [policyExpectedLo] = findBracketingCLs(policyCandidates, 0);
  assert.equal(policyExpectedLo?.id, structFar.id, 'ポリシー予測は種別ベースなのでlegacyLabeledCenterを候補にせずstruct(-500)を選ぶ');
  assert.equal(added.extentLoRef?.clId, policyExpectedLo?.id, '移行後は製品コードの実際の結果とポリシー予測が一致する（旧データ限定シナリオでの乖離は解消）');
});

// ---- m5: 追加extentのステップ3移行で反転したピン留めテスト（2026-09-18裁定: 補助線の追加extentは
// 梁芯を端部候補にしない。補助線は壁になれず、端が壁で止まるのは作図上のトリムだけのため、追加extentも
// 「主体と同じモードで可視な種別」＝通り芯・中心線・補助線に揃える）。

test('【裁定反映済み】addCenterLineFromDialog(kind:aux) の直交端部候補は梁芯を含まない（2026-09-18裁定。orthoAnchorKinds(\'aux\')と一致）', () => {
  const { project, graph } = makeProjectWithGraph();
  const nearBeam  = graph.addCenterLine(CenterLineType.HORIZONTAL, -100, { labeled: false, discipline: Discipline.FUSE });
  const farStruct = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -500, { labeled: true, discipline: Discipline.STRUCT });

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 },
    { scaleDenominator: 100 },
  );

  assert.equal(result.done, true);
  const added = graph.centerLines.find(cl => centerLineKind(cl) === 'aux' && cl.centerLineType === CenterLineType.VERTICAL);
  // aux は初回追加時（isReferencedByAuxがfalse）は直交CL参照ではなく、はね出し量を引いた静的値になる
  // （EXTENT_ANCHOR_STYLE.auxの'overhang'）ため、extentLoRefではなくextentLoの数値で確認する。
  assert.equal(added.extentLoRef, null, '前提: 初回追加のためref化されず静的値になる');
  const OVERHANG_AT_DENOM_100 = 300; // snapGeometry.js overhangMm: denom===100はBASE_MM(300)そのもの
  // 移行後の実際の挙動: orthoAnchorCandidates は梁芯(-100)を候補から除外するため、struct(-500)が選ばれる。
  assert.equal(added.extentLo, farStruct.value - OVERHANG_AT_DENOM_100, '移行後は梁芯(-100)が候補から除外され、struct(-500)が端部として選ばれる');

  // ポリシー予測（orthoAnchorKinds('aux')は梁芯を含まない）と実際の結果が一致することを確認する。
  const allowedKinds = orthoAnchorKinds('aux');
  assert.ok(!allowedKinds.includes('beam'), '前提: ポリシーのorthoAnchorKinds(aux)は梁芯を含まない');
  assert.notEqual(added.extentLo, nearBeam.value - OVERHANG_AT_DENOM_100, '移行後の実際の結果はnearBeam基準ではない（=梁芯が候補から除外されていることの確認）');
});

// ================================================================
// D. 失敗系
// ================================================================

test('【失敗系】未知のCL種別は throw する', () => {
  assert.throws(() => coexistenceAt('wood', 'struct'), /未知のCL種別: wood/);
  assert.throws(() => coexistenceAt('struct', 'wood'), /未知のCL種別: wood/);
  assert.throws(() => orthoAnchorKinds('wood'), /未知のCL種別: wood/);
  assert.throws(() => sameDirectionObstacleKinds('wood'), /未知のCL種別: wood/);
  assert.throws(() => moveSnapTargetKinds('wood'), /未知のCL種別: wood/);
  assert.throws(() => mergeableKinds('wood'), /未知のCL種別: wood/);
  assert.throws(() => allowsWallAnchor('wood'), /未知のCL種別: wood/);
  assert.throws(() => extentAnchorStyle('wood'), /未知のCL種別: wood/);
  assert.throws(() => hasEndpointRule('wood'), /未知のCL種別: wood/);
  assert.throws(() => spansEntireAxis('wood'), /未知のCL種別: wood/);
  assert.throws(() => kindsVisibleWith('wood'), /未知のCL種別: wood/);
});

test('【失敗系】未知・未指定の appMode は throw する', () => {
  assert.throws(() => kindsVisibleIn('renovation'), /未知のappMode: renovation/);
  assert.throws(() => kindsVisibleIn(undefined), /未知のappMode: undefined/);
  assert.throws(() => kindsVisibleIn(null), /未知のappMode: null/);
  assert.throws(() => hitTestKinds('renovation'), /未知のappMode: renovation/);
});

test('【失敗系】未知の変換方向は throw する', () => {
  assert.throws(() => convertBlockingKinds('sideways'), /未知の変換方向: sideways/);
  assert.throws(() => convertBlockingKinds(undefined), /未知の変換方向: undefined/);
});

test('【失敗系】isOrthoAnchorCandidate: RADIAL は主体・相手どちらでも false（throwしない）', () => {
  const { graph } = makeProjectWithGraph();
  const radial = graph.addCenterLine(CenterLineType.RADIAL, 30, { labeled: false, discipline: Discipline.ARCH });
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });

  assert.equal(isOrthoAnchorCandidate(radial, h), false, '主体がRADIAL');
  assert.equal(isOrthoAnchorCandidate(v, radial), false, '相手がRADIAL');
});

test('【失敗系】coversAlongAxis: extentの片側が未解決(null)なら true、labeled:true の非struct CLも true（旧データ互換）', () => {
  const { graph } = makeProjectWithGraph();
  const auxUnresolved = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: 0, extentHi: null,
  });
  assert.equal(coversAlongAxis(auxUnresolved, 99999), true, 'hi側未解決なら全域扱い');

  const legacyLabeledCenter = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: true, discipline: Discipline.ARCH, extentLo: -100, extentHi: 100,
  });
  assert.equal(centerLineKind(legacyLabeledCenter), 'center', '前提: discipline=ARCHなのでcenter種別');
  assert.equal(coversAlongAxis(legacyLabeledCenter, 99999), true, 'labeled:trueは種別を問わず全域扱い（旧データ互換）');

  const normalAux = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, lineType: 'dashed', extentLo: -100, extentHi: 100,
  });
  assert.equal(coversAlongAxis(normalAux, 99999), false, '通常の補助線はextent範囲外なら覆わない');
  assert.equal(coversAlongAxis(normalAux, 0), true, 'extent範囲内なら覆う');
});

test('【失敗系】自身除外: isOrthoAnchorCandidate/isSameDirectionObstacle/isMergeCandidateは同一オブジェクトに対しfalse', () => {
  const { graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const h  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });

  assert.equal(isOrthoAnchorCandidate(h, h), false);
  assert.equal(isSameDirectionObstacle(cl, cl), false);
  assert.equal(isMergeCandidate(cl, cl), false);
});

test('【失敗系】isRenderTarget/isHitTestTarget も未知のappModeでthrowする', () => {
  const { graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  assert.throws(() => isRenderTarget(cl, 'renovation'), /未知のappMode: renovation/);
  assert.throws(() => isHitTestTarget(cl, 'renovation'), /未知のappMode: renovation/);
});
