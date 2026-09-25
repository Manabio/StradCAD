// centerLineKindPolicy.js の特性テスト。
// A. 原始事実（表そのもの）／B. 導出述語（種別レベルAPI・CLレベルAPI）／
// C. 製品コードとの一致（centerLineOps.js・followerGraph.js・beamAxisMove.js・centerLineConvert.js の
//    現行動作をポリシーの導出結果から計算した期待値と突き合わせる。「既知の乖離」と付記したテストは、
//    製品コードが生の labeled フラグで判定しておりポリシーの種別ベース判定と割れる旧データ限定の
//    ケースを、挙動を変えずにピン留めする）／D. 失敗系／E. 柱アンカー解決（structural/配下が共有する
//    アンカー述語の単体テスト。製品経路（呼び出し側）の突き合わせはstructural/配下の各*.test.jsに置く）。
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
  CONVERT_BLOCKING_KINDS, CROSS_FLOOR_COUNTERPART_KINDS, OPENING_BOUNDARY_KINDS,
  CONVERT_SUBJECT_KINDS, BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE,
  kindsVisibleIn, hitTestKinds, kindsVisibleWith, orthoAnchorKinds, sameDirectionObstacleKinds,
  moveSnapTargetKinds,
  coexistenceAt, convertBlockingKinds, convertSubjectKind, mergeableKinds, allowsWallAnchor, extentAnchorStyle,
  hasEndpointRule, spansEntireAxis, isOpeningBoundaryKind,
  isOrthoAnchorCandidate, isSameDirectionObstacle, isMoveSnapTarget, isMergeCandidate, isConvertSubject,
  usesBeamAxisMoveSnap,
  isRenderTarget, isHitTestTarget,
  coversAlongAxis, orthoAnchorCandidates, orthoAnchorCandidatesForNew, sameDirectionObstacles,
  sameCoordCounterparts, mergeCandidates, candidatesVisibleIn, gridCenterLinesOnAxis,
  FINISH_CELL_DIVIDER_KINDS, isFinishCellDivider,
  UNDER_STAIR_SPLIT_KINDS, isUnderStairSplitKind, axisLineKindOf,
  STRUCTURAL_ANCHOR_KINDS, BEAM_AXIS_KINDS, SUPPORT_SPAN_COLUMN_KINDS,
  structuralAnchorKinds, isStructuralAnchor, structuralAnchorAt, structuralAnchorCandidates,
  beamAxisAt, beamAxisCenterLines, supportSpanColumnCandidates,
  FLOOR_SHARED_KINDS, structuralSyncScopeOfKind, structuralSyncScopeOfConversion,
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

test('CROSS_FLOOR_COUNTERPART_KINDS: 他階の入替え相手種別は中心線・補助線・梁芯（優先順つき。通り芯は含まない）', () => {
  assert.deepEqual([...CROSS_FLOOR_COUNTERPART_KINDS], ['center', 'aux', 'beam']);
});

// QA指摘（ステップ5再QA）で判明した既存の穴: CL_KINDS 自体の並びを固定するリテラルテストが
// 無かった——CL_KINDSは transform/centerLineOps.js addCenterLineFromDialog の existing 選択の
// 優先順（同種別優先の次に使う順）としてそのままimportされて使われるため、この並びが壊れると
// 追加・変換の帰結が広範囲で変わる（M-1参照）。
test('【不変条件】CL_KINDS の並びは 通り芯・中心線・補助線・梁芯 で固定されている', () => {
  assert.deepEqual([...CL_KINDS], ['struct', 'center', 'aux', 'beam']);
});

// 【不変条件】QA指摘m-2: error.js は無import（extractedModuleImportInvariant）のため
// CROSS_FLOOR_COUNTERPART_KINDSと同じ並び順を`CROSS_FLOOR_KIND_ORDER`としてローカルに複写している
// （error.js のformatFloorsByKind参照）——ソースを読むテスト（APP_MODES不変条件と同じ流儀）で
// 複写元と複写先が食い違っていないことを固定する。
test('【不変条件】error.js の CROSS_FLOOR_KIND_ORDER は centerLineKindPolicy.js の CROSS_FLOOR_COUNTERPART_KINDS と一致する', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../error.js'), 'utf8');
  const m = src.match(/CROSS_FLOOR_KIND_ORDER\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'error.js から CROSS_FLOOR_KIND_ORDER の配列リテラルを抽出できなかった（正規表現がソースと食い違っている可能性）');
  const extracted = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(extracted, [...CROSS_FLOOR_COUNTERPART_KINDS]);
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
  assert.ok(Object.isFrozen(CROSS_FLOOR_COUNTERPART_KINDS));
  assert.ok(Object.isFrozen(CL_KINDS));
  assert.ok(Object.isFrozen(APP_MODES));
  assert.ok(Object.isFrozen(OPENING_BOUNDARY_KINDS));
  assert.ok(Object.isFrozen(CONVERT_SUBJECT_KINDS));
  assert.ok(Object.isFrozen(BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE));
  for (const v of Object.values(BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE)) assert.ok(Object.isFrozen(v));
});

test('OPENING_BOUNDARY_KINDS: 建具がまたげない境界種別は通り芯・中心線（補助線・梁芯はまたげる）', () => {
  assert.deepEqual([...OPENING_BOUNDARY_KINDS], ['struct', 'center']);
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

// ---- CONVERT_SUBJECT_KINDS・isConvertSubject（変換元として妥当かの判定。
// transform/centerLineConvert.js の入力ガードと interaction/clMenuGating.js が共有する）----

test('CONVERT_SUBJECT_KINDS: promoteの主体は中心線、demoteの主体は通り芯', () => {
  assert.deepEqual({ ...CONVERT_SUBJECT_KINDS }, { promote: 'center', demote: 'struct' });
});

test('convertSubjectKind: promote/demoteそれぞれの主体種別を返す', () => {
  assert.equal(convertSubjectKind('promote'), 'center');
  assert.equal(convertSubjectKind('demote'), 'struct');
});

// 種別ごとのduckオブジェクト（centerLineKind/isGridCenterLineが見るフィールドのみ持つ）。
function makeDuckCL(kind, labeled, centerLineType) {
  const base = { centerLineType, labeled };
  switch (kind) {
    case 'struct': return { ...base, discipline: Discipline.STRUCT, lineType: 'center' };
    case 'center': return { ...base, discipline: Discipline.ARCH,   lineType: 'center' };
    case 'aux':    return { ...base, discipline: Discipline.ARCH,   lineType: 'dashed' };
    case 'beam':   return { ...base, discipline: Discipline.FUSE,   lineType: 'center' };
    default: throw new Error(`未知のCL種別: ${kind}`);
  }
}

// isConvertSubject総当り: 4種別（kind）×labeled(2値)×centerLineType(3値)×direction(2値)=48通り。
// 期待値はリテラルの表で固定する（isConvertSubject自身の式を再計算しない）。
// [labeled:false, labeled:true] の順。centerLineType===RADIALは表を使わず常にfalse（除外）。
const ISCONVERT_SUBJECT_EXPECTED = {
  promote: { struct: [false, false], center: [true, true], aux: [false, false], beam: [false, false] },
  demote:  { struct: [false, true],  center: [false, false], aux: [false, false], beam: [false, false] },
};

test('isConvertSubject: 総当り（4種別×labeled2値×centerLineType3値×direction2値）', () => {
  for (const direction of ['promote', 'demote']) {
    for (const kind of CL_KINDS) {
      for (const [i, labeled] of [false, true].entries()) {
        for (const centerLineType of [CenterLineType.VERTICAL, CenterLineType.HORIZONTAL, CenterLineType.RADIAL]) {
          const cl = makeDuckCL(kind, labeled, centerLineType);
          const expected = centerLineType === CenterLineType.RADIAL
            ? false
            : ISCONVERT_SUBJECT_EXPECTED[direction][kind][i];
          assert.equal(
            isConvertSubject(cl, direction), expected,
            `direction=${direction} kind=${kind} labeled=${labeled} centerLineType=${centerLineType}`,
          );
        }
      }
    }
  }
});

test('【失敗系】isConvertSubject: clがfalsyならthrowする', () => {
  assert.throws(() => isConvertSubject(null, 'promote'), /isConvertSubject: clは必須です/);
  assert.throws(() => isConvertSubject(undefined, 'demote'), /isConvertSubject: clは必須です/);
});

test('【失敗系】convertSubjectKind/isConvertSubject: 未知の変換方向はthrowする', () => {
  assert.throws(() => convertSubjectKind('sideways'), /未知の変換方向: sideways/);
  assert.throws(() => convertSubjectKind(undefined), /未知の変換方向: undefined/);
  const cl = makeDuckCL('center', false, CenterLineType.VERTICAL);
  assert.throws(() => isConvertSubject(cl, 'sideways'), /未知の変換方向: sideways/);
});

// ---- BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE・usesBeamAxisMoveSnap（CL移動中pointermoveの梁芯専用
// スナップ呼び分け。interaction/usePointerInteraction.js が使う）----

test('BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE: structureモードのみ梁芯を対象とする', () => {
  assert.deepEqual({ ...BEAM_AXIS_MOVE_SNAP_KINDS_BY_MODE }, { structure: ['beam'] });
});

test('usesBeamAxisMoveSnap: 総当り（4種別×全appMode。structureかつ梁芯のときのみtrue）', () => {
  for (const appMode of APP_MODES) {
    for (const kind of CL_KINDS) {
      const cl = makeDuckCL(kind, true, CenterLineType.VERTICAL);
      const expected = appMode === 'structure' && kind === 'beam';
      assert.equal(usesBeamAxisMoveSnap(cl, appMode), expected, `appMode=${appMode} kind=${kind}`);
    }
  }
});

test('【失敗系】usesBeamAxisMoveSnap: 未知のappModeはthrowする', () => {
  const cl = makeDuckCL('beam', true, CenterLineType.VERTICAL);
  assert.throws(() => usesBeamAxisMoveSnap(cl, 'unknown'), /未知のappMode: unknown/);
});

test('hitTestKinds: floorplan/finish/opening=通り芯・中心線・補助線、structure=梁芯のみ', () => {
  assert.deepEqual(hitTestKinds('floorplan'), ['struct', 'center', 'aux']);
  assert.deepEqual(hitTestKinds('finish'), ['struct', 'center', 'aux']);
  assert.deepEqual(hitTestKinds('opening'), ['struct', 'center', 'aux']);
  assert.deepEqual(hitTestKinds('structure'), ['beam']);
  // site/elevation は可視モード表が空集合のため hitTestKinds も空になる。snap.js
  // resolvePointerTargets の clKindFilter はステップ6（2026-09-20）で hitTestKinds(appMode) 経由へ
  // 移行済み——唯一の呼び出し元 usePointerInteraction.js updateSnap の到達可能性を確認済みのため
  // （site はホイールズーム経由でのみ到達し結果は未使用、elevation は到達経路自体が無い。
  // core/centerLineKindPolicy.js HIT_EXCLUDED_KINDS_BY_MODE コメント参照）、可視モード表に揃えても
  // ユーザーに見える挙動は変わらない（「未裁定」は解消）。
  assert.deepEqual(hitTestKinds('site'), []);
  assert.deepEqual(hitTestKinds('elevation'), []);
});

test('allowsWallAnchor / extentAnchorStyle / hasEndpointRule / spansEntireAxis / isOpeningBoundaryKind', () => {
  assert.deepEqual(CL_KINDS.map(allowsWallAnchor), [false, false, true, false]); // struct,center,aux,beam
  assert.deepEqual(CL_KINDS.map(extentAnchorStyle), ['none', 'ref', 'overhang', 'ref']);
  assert.deepEqual(CL_KINDS.map(hasEndpointRule), [false, true, false, true]);
  assert.deepEqual(CL_KINDS.map(spansEntireAxis), [true, false, false, false]);
  assert.deepEqual(CL_KINDS.map(isOpeningBoundaryKind), [true, true, false, false]);
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

// ---- sameCoordCounterparts: 同座標の相手を列挙する走査API（種別による絞り込みは行わない）----

test('sameCoordCounterparts: value・centerLineTypeが一致するCLを種別を問わず列挙する（tolMm境界・exclude）', () => {
  const { graph } = makeProjectWithGraph();
  const structCl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const centerCl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const farCl    = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const orthoCl  = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: 1000 });
  assert.deepEqual(result.map(c => c.id).sort(), [structCl.id, centerCl.id].sort(), '種別を問わず同座標・同方向のCLをすべて返す');
  assert.equal(result.some(c => c.id === farCl.id), false, '座標が異なれば含まれない');
  assert.equal(result.some(c => c.id === orthoCl.id), false, '方向が異なれば含まれない');

  const withExclude = sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: 1000, exclude: structCl });
  assert.deepEqual(withExclude.map(c => c.id), [centerCl.id], 'excludeで指定したCL自身は除外される（オブジェクト参照比較）');

  // 最小のダックタイピング（{centerLines}のみ）でも動く（tolBoundary追加前の時点で比較する）。
  const duckGraph = { centerLines: graph.centerLines };
  assert.deepEqual(sameCoordCounterparts(duckGraph, { centerLineType: CenterLineType.VERTICAL, value: 1000 }).map(c => c.id).sort(), result.map(c => c.id).sort());

  const tolBoundary = graph.addCenterLine(CenterLineType.VERTICAL, 1000.4, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: 1000 }).some(c => c.id === tolBoundary.id), true, '既定tolMm(CL_OVERLAP_TOL_MM=0.5)未満の差はtrue（0.4<0.5）');
  assert.equal(sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: 1000, tolMm: 0.3 }).some(c => c.id === tolBoundary.id), false, 'tolMmを狭めれば境界外になる');
});

// QA指摘（ステップ7再QA・Minor E）: 許容誤差が「開区間」（`<`であって`<=`ではない）であることを
// 直接固定するテストが無かった（`<`→`<=`の変異がフルsuiteで緑になっていた）。
// 浮動小数の丸め誤差で不安定にならないよう、CL位置は0・照合値はCL_OVERLAP_TOL_MM自体（=0.5、2進で
// 正確に表現できる値）を使う——`0.5`や`0.25`は2進浮動小数点で誤差なく表現できるため、
// `Math.abs(0 - 0.5)`は必ず厳密に`0.5`になり、`0.5 < 0.5`の判定が決定的にfalseになる。
test('【失敗系】sameCoordCounterparts: 差がちょうど既定tolMm(CL_OVERLAP_TOL_MM)のCLは一致しない（開区間。`<`であって`<=`ではない）', () => {
  const { graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(
    sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: CL_OVERLAP_TOL_MM }).some(c => c.id === cl.id),
    false, '差がちょうどtolMm（開区間の境界そのもの）は含まれない',
  );
  assert.equal(
    sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: CL_OVERLAP_TOL_MM / 2 }).some(c => c.id === cl.id),
    true, '差がtolMm未満なら含まれる',
  );
});

// ---- mergeCandidates: kind・centerLineTypeが一致しlabeled:falseな結合候補を列挙する走査API ----
// （transform/centerLineMerge.js findCenterLineMergeMatch が使う。centerLineOps.js virtualCandidateの
// ようにdiscipline/lineTypeを持たない仮想候補向けに、kindを明示引数で受け取る——isMergeCandidateの
// ようにsubjectオブジェクトからcenterLineKind(subject)を導出しない。ステップ7、2026-09-20）。

test('mergeCandidates: centerLineType・kindが一致しlabeled:falseなCLだけを列挙する（tolMmではなくlabeled/kind/excludeで絞る）', () => {
  const { graph } = makeProjectWithGraph();
  const auxA = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
  const auxB = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, lineType: 'dashed' });
  const centerCl = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const labeledAux = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, lineType: 'dashed' });
  const orthoAux = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, lineType: 'dashed' });

  const result = mergeCandidates(graph, { centerLineType: CenterLineType.VERTICAL, kind: 'aux' });
  assert.deepEqual(result.map(c => c.id).sort(), [auxA.id, auxB.id].sort(), 'labeled:false・kind一致・centerLineType一致のみ');
  assert.equal(result.some(c => c.id === centerCl.id), false, '種別違いは含まれない');
  assert.equal(result.some(c => c.id === labeledAux.id), false, 'labeled:trueは含まれない（kindはauxで一致していても）');
  assert.equal(result.some(c => c.id === orthoAux.id), false, 'centerLineType違いは含まれない');

  const withExclude = mergeCandidates(graph, { centerLineType: CenterLineType.VERTICAL, kind: 'aux', exclude: [auxA.id] });
  assert.deepEqual(withExclude.map(c => c.id), [auxB.id], 'excludeのidは除外される');

  // 最小のダックタイピング（{centerLines}のみ）でも動く。
  const duckGraph = { centerLines: graph.centerLines };
  assert.deepEqual(mergeCandidates(duckGraph, { centerLineType: CenterLineType.VERTICAL, kind: 'aux' }).map(c => c.id).sort(), result.map(c => c.id).sort());
});

test('【失敗系】mergeCandidates: 未知のkindはthrowする', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(() => mergeCandidates(graph, { centerLineType: CenterLineType.VERTICAL, kind: 'wood' }), /未知のCL種別: wood/);
});

// ---- gridCenterLinesOnAxis: gridCenterLines(graph)の方向つき・昇順版（走査API。
// transform/centerLineConvert.js outermostGridExtentRefs・isLastGridOnAxis が使う）----

test('gridCenterLinesOnAxis: centerLineType一致の通り芯をvalue昇順で返す（非昇順に挿入しても並べ替える）', () => {
  const { project, graph } = makeProjectWithGraph();
  const v3000 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const v0    = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const v1000 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const h0    = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT }); // 直交（方向違い）
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH }); // 通り芯でない（中心線）は含まない

  const result = gridCenterLinesOnAxis(graph, CenterLineType.VERTICAL);

  assert.deepEqual(result, [v0, v1000, v3000], '挿入順（3000→0→1000）に関わらずvalue昇順で返す');
  assert.equal(result.some(c => c.id === h0.id), false, '方向違いは含まれない');
});

test('【失敗系】gridCenterLinesOnAxis: centerLineTypeが未指定/nullはthrowする', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(() => gridCenterLinesOnAxis(graph, undefined), /gridCenterLinesOnAxis: centerLineTypeは必須です/);
  assert.throws(() => gridCenterLinesOnAxis(graph, null), /gridCenterLinesOnAxis: centerLineTypeは必須です/);
});

// ---- candidatesVisibleIn: appModeで可視な種別のうちcenterLineTypeが一致するCLを列挙する走査API ----
// （openings/openingMove.js openingSnapCandidates が使う。ステップ7、2026-09-20）。

// QA指摘（ステップ7再QA・Minor F）: 期待値を kindsVisibleIn(appMode) から組む自己参照テストだった
// （kindsVisibleIn は candidatesVisibleIn 自身が内部で呼ぶ関数そのもの——VISIBLE_KINDS_BY_MODE を
// 壊す変異があっても期待値側が一緒に動いてしまい赤にならない）。snapGeometry.test.js の
// HIT_TEST_KINDS_LITERAL と同じ流儀でリテラル表に差し替える。
const VISIBLE_KINDS_LITERAL = {
  floorplan: ['struct', 'center', 'aux'],
  finish:    ['struct', 'center', 'aux'],
  opening:   ['struct', 'center', 'aux'],
  structure: ['struct', 'beam'],
  site:      [],
  elevation: [],
};

// リテラル表が実装（VISIBLE_KINDS_BY_MODE）から乖離していないことの一回きりの確認（このテストだけは
// VISIBLE_KINDS_BY_MODEを参照する——下のテストは変異検出のためリテラル表を直接使う）。
test('VISIBLE_KINDS_LITERAL: VISIBLE_KINDS_BY_MODE の値と一致する（このテストファイル内リテラル表のドリフト検知）', () => {
  for (const mode of APP_MODES) assert.deepEqual(VISIBLE_KINDS_LITERAL[mode], [...VISIBLE_KINDS_BY_MODE[mode]], `mode=${mode}`);
});

test('candidatesVisibleIn: VISIBLE_KINDS_LITERAL(appMode)とcenterLineTypeの両方で絞り込む', () => {
  const { project, graph } = makeProjectWithGraph();
  for (const kind of CL_KINDS) {
    addCLOfKind(graph, project, CenterLineType.VERTICAL, (CL_KINDS.indexOf(kind) + 1) * 1000, kind);
  }
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH }); // centerLineType違い

  for (const appMode of APP_MODES) {
    const result = candidatesVisibleIn(graph, { appMode, centerLineType: CenterLineType.VERTICAL });
    assert.deepEqual(
      result.map(c => centerLineKind(c)).sort(),
      [...VISIBLE_KINDS_LITERAL[appMode]].sort(),
      `appMode=${appMode}`,
    );
    assert.ok(result.every(c => c.centerLineType === CenterLineType.VERTICAL), `appMode=${appMode}: centerLineType違いは含まれない`);
  }

  // 最小のダックタイピング（{centerLines}のみ）でも動く。
  const duckGraph = { centerLines: graph.centerLines };
  assert.deepEqual(
    candidatesVisibleIn(duckGraph, { appMode: 'floorplan', centerLineType: CenterLineType.VERTICAL }).map(c => c.id).sort(),
    candidatesVisibleIn(graph, { appMode: 'floorplan', centerLineType: CenterLineType.VERTICAL }).map(c => c.id).sort(),
  );
});

test('【失敗系】candidatesVisibleIn: 未知のappModeはthrowする', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(() => candidatesVisibleIn(graph, { appMode: 'renovation', centerLineType: CenterLineType.VERTICAL }), /未知のappMode: renovation/);
});

test('【失敗系】sameCoordCounterparts: centerLineType未指定はthrow、valueが数値でなければthrow（未指定・undefined・NaN・文字列）', () => {
  const { graph } = makeProjectWithGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.throws(() => sameCoordCounterparts(graph, { value: 1000 }), /centerLineType/);
  assert.throws(() => sameCoordCounterparts(graph, { centerLineType: null, value: 1000 }), /centerLineType/);
  assert.throws(() => sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL }), /value/);
  assert.throws(() => sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: undefined }), /value/);
  assert.throws(() => sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: NaN }), /value/);
  assert.throws(() => sameCoordCounterparts(graph, { centerLineType: CenterLineType.VERTICAL, value: '1000' }), /value/);
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

// ---- renderer/CenterLinesLayer.jsx の描画可否移行（labeledベース→種別ベース）で反転した
// 旧データ限定ピン留め（QA指摘Major2）。移行前は `!cl.labeled && cl.discipline===ARCH` で判定して
// おり、labeled:trueだが種別がcenter/auxの旧データは構造モードでも除外されず描画されていた。
// isRenderTargetは種別（centerLineKind）のみで判定するため、この種の旧データは構造モードで
// 描画対象外になる（floorplan/finish/openingは旧コードもlabeledを見ておらず変化なし）。

test('【旧データ限定・種別ベースへ統一】isRenderTarget: {labeled:true, discipline:ARCH}（種別 center）は構造モードで描画対象外（移行前は描画されていた）', () => {
  const { graph } = makeProjectWithGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.ARCH });
  assert.equal(centerLineKind(legacy), 'center', '前提: discipline=ARCHなのでcenter種別（labeled:trueだが種別は通り芯でない旧データ）');
  assert.equal(isRenderTarget(legacy, 'structure'), false, '移行後は種別ベースのため構造モードでは描画対象外（移行前は isArchCL=!cl.labeled&&... がfalseになり描画されていた）');
  assert.equal(isRenderTarget(legacy, 'floorplan'), true, 'floorplanは旧コードも種別ベース相当のため変化なし');
});

test('【旧データ限定・種別ベースへ統一】isRenderTarget: {labeled:true, lineType:dashed}（種別 aux）は構造モードで描画対象外（移行前は描画されていた）', () => {
  const { graph } = makeProjectWithGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, lineType: 'dashed' });
  assert.equal(centerLineKind(legacy), 'aux', '前提: lineType=dashedなのでaux種別（labeled:trueだが種別は通り芯でない旧データ）');
  assert.equal(isRenderTarget(legacy, 'structure'), false, '移行後は種別ベースのため構造モードでは描画対象外（移行前は isArchCL=!cl.labeled&&... がfalseになり描画されていた）');
  assert.equal(isRenderTarget(legacy, 'floorplan'), true, 'floorplanは旧コードも種別ベース相当のため変化なし');
});

// ---- isFinishCellDivider: finish/gridCells.js isDividerCL の判定本体（FINISH_CELL_DIVIDER_KINDS） ----
// 中心線側は種別（centerLineKind）のみで判定し labeled は見ない——線上ヒットの範囲判定
// （snapGeometry.js findNearestCenterLine）は既に種別ベース（spansEntireAxis）のため、同じ
// 旧データの線についてセル分割線としての扱いだけ生labeledを残すと、「ヒットは種別で判定される
// のにセル分割はlabeled依存のまま」という食い違いが残る。
test('FINISH_CELL_DIVIDER_KINDS: セル分割線になる種別（通り芯側を除く）は中心線のみ（labeledの値は問わない）', () => {
  assert.deepEqual([...FINISH_CELL_DIVIDER_KINDS], ['center']);
});

test('isFinishCellDivider: 4種別×labeled2値の総当り（通り芯=labeled必須、中心線=labeledの値を問わず常にtrue、補助線・梁芯=常にfalse）', () => {
  const { graph, project } = makeProjectWithGraph();
  let v = 1000;
  for (const kind of CL_KINDS) {
    for (const labeled of [true, false]) {
      const cl = kind === 'struct'
        ? project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline: Discipline.STRUCT })
        : graph.addCenterLine(CenterLineType.VERTICAL, v, {
          labeled,
          discipline: kind === 'beam' ? Discipline.FUSE : Discipline.ARCH,
          lineType: kind === 'aux' ? 'dashed' : 'center',
        });
      v += 1000;
      const expected = kind === 'struct' ? labeled : kind === 'center';
      assert.equal(isFinishCellDivider(cl), expected, `kind=${kind} labeled=${labeled}`);
    }
  }
});

test('【旧データ限定・種別ベースへ統一】isFinishCellDivider: {labeled:true, discipline:ARCH, lineType:center}（通り芯でも補助線でもないのにlabeled:trueな旧データ）はHEADの不参加から、移行後は分割線に参加する', () => {
  const { graph } = makeProjectWithGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000,
    { labeled: true, discipline: Discipline.ARCH, lineType: 'center' });
  assert.equal(centerLineKind(legacy), 'center', '前提: 通り芯でも補助線でもないためcenter種別になる');
  assert.equal(isFinishCellDivider(legacy), true,
    '旧実装（!labeled && lineType!==dashed && discipline===ARCH）はlabeled:trueで即falseだったが、' +
    '種別ベース（centerLineKind(cl)==="center"。labeledを問わない）ではtrueになる');
});

test('【旧データ限定・種別ベースへ統一】isFinishCellDivider: {labeled:true, discipline:STRUCT, lineType:dashed}は通り芯側（isGridCenterLine）にもcenter側にも該当せずfalse', () => {
  const { graph } = makeProjectWithGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000,
    { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(centerLineKind(legacy), 'aux', '前提: lineType=dashedが最優先されaux種別になる');
  assert.equal(isFinishCellDivider(legacy), false,
    '旧実装（labeled&&discipline===STRUCT）はtrueだったが、種別ベース（isGridCenterLine）はlineType:dashedをauxと判定しfalseになる');
});

// ---- isUnderStairSplitKind: finish/stair/stairUnderSplit.js isSplitCLFor の種別判定本体 ----
test('UNDER_STAIR_SPLIT_KINDS: 階段下分割CLとして認める種別は中心線のみ（labeledの値は問わない）', () => {
  assert.deepEqual([...UNDER_STAIR_SPLIT_KINDS], ['center']);
});

test('isUnderStairSplitKind: 4種別×labeled2値の総当り（中心線のみtrue。labeledの値を問わない）', () => {
  const { graph, project } = makeProjectWithGraph();
  let v = 1000;
  for (const kind of CL_KINDS) {
    for (const labeled of [true, false]) {
      const cl = kind === 'struct'
        ? project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline: Discipline.STRUCT })
        : graph.addCenterLine(CenterLineType.VERTICAL, v, {
          labeled,
          discipline: kind === 'beam' ? Discipline.FUSE : Discipline.ARCH,
          lineType: kind === 'aux' ? 'dashed' : 'center',
        });
      v += 1000;
      assert.equal(isUnderStairSplitKind(cl), kind === 'center', `kind=${kind} labeled=${labeled}`);
    }
  }
});

// ---- axisLineKindOf: finish/edgeClassify.js classifyAxisLineType の判定本体 ----
test('axisLineKindOf: 4種別×labeled2値の総当り（struct=labeled必須でgrid、aux=常にaux、center/beam=常にcenter）', () => {
  const { graph, project } = makeProjectWithGraph();
  let v = 1000;
  for (const kind of CL_KINDS) {
    for (const labeled of [true, false]) {
      const cl = kind === 'struct'
        ? project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline: Discipline.STRUCT })
        : graph.addCenterLine(CenterLineType.VERTICAL, v, {
          labeled,
          discipline: kind === 'beam' ? Discipline.FUSE : Discipline.ARCH,
          lineType: kind === 'aux' ? 'dashed' : 'center',
        });
      v += 1000;
      const expected = kind === 'struct' && labeled ? 'grid' : kind === 'aux' ? 'aux' : 'center';
      assert.equal(axisLineKindOf(cl), expected, `kind=${kind} labeled=${labeled}`);
    }
  }
});

test('【旧データ限定・種別ベースへ統一】axisLineKindOf: {labeled:true, discipline:STRUCT, lineType:dashed}はHEADの「通り芯(grid)」から、移行後は「補助線(aux)」になる', () => {
  const { graph } = makeProjectWithGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000,
    { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(axisLineKindOf(legacy), 'aux',
    '旧実装（discipline===STRUCT&&labeled優先）はgrid（通り芯）だったが、種別ベース（isGridCenterLine。' +
    'centerLineKindがlineType:dashedを先に見る）ではauxになる');
});

// ---- 【失敗系】isFinishCellDivider・isUnderStairSplitKind・axisLineKindOf: discipline／lineType を
// 持たない未生成の仮想候補（ダック型オブジェクト）を渡すと、centerLineKind が黙って既定種別
// 'center' に落ちるため、実CLへの適用を前提とするこれらの述語も「中心線扱い」の結果を返す
// （現行挙動のピン留め。呼び出し側は実CL／POJOスナップショット以外を渡さない前提を守ること）。
test('【失敗系】isFinishCellDivider・isUnderStairSplitKind・axisLineKindOf: discipline/lineTypeを持たない仮想候補は黙って中心線扱い（center）になる', () => {
  const virtual = { labeled: false };
  assert.equal(isFinishCellDivider(virtual), true);
  assert.equal(isUnderStairSplitKind(virtual), true);
  assert.equal(axisLineKindOf(virtual), 'center');
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
// C2. ステップ6（可視モード表への集約）: 製品コードの呼び出し形そのものの不変条件
// renderer/CenterLinesLayer.jsx・snap.js resolvePointerTargets・App.jsx handleMenuSelect は
// いずれも react-konva/store.js/.jsx 依存のため import して実行できない——「呼び出し側が
// ポリシー関数を実際に呼んでいるか」は挙動（isRenderTarget/hitTestKinds自体の一致）だけでは
// 検出できない（floorplan/finish/opening/structureでは旧インライン条件とポリシー関数が数学的に
// 同値なため、呼び出しを丸ごと削って旧インライン条件に戻しても既存の機能テストは赤にならない
// ——QA実測: 3箇所とも無効化してnpm testを実行し3336 pass/0 failのまま）。
// ソーステキストを読んで「ポリシー関数を実際に呼んでいるか／旧インライン条件が残っていないか」を
// 固定する（renderer/MemberTagLayer.invariants.test.js・wallRefresh.test.js の
// runStructuralExitBoundary不変条件・本ファイル冒頭のAPP_MODES/CROSS_FLOOR_KIND_ORDER不変条件と
// 同じ「ソースを読む」流儀）。
// ================================================================

// 関数本体を波括弧の対応数で抽出する（引数の分割代入 `opts = {}` の直後、`) {` の { から対応する }
// まで——先頭の { だと引数側の分割代入を拾ってしまう。wallRefresh.test.js の
// runStructuralExitBoundary不変条件と同じ抽出法）。
function extractFunctionBody(src, startMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) return null;
  const parenCloseIdx = src.indexOf(') {', startIdx);
  const braceStart = src.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(braceStart, i + 1);
}

// 行コメントを落とす（コメント中の旧パターンの記述を「コードが残っている」と誤検知しないため）。
function stripLineComments(text) {
  return text.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '')).join('\n');
}

test('【不変条件】renderer/CenterLinesLayer.jsx: 描画スキップが isRenderTarget(cl, appMode) 単独で、旧インライン条件（isArchCL・isBeamAxis&&appMode の形そのもの）が残っていない', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../renderer/CenterLinesLayer.jsx'), 'utf8');
  const code = stripLineComments(src);
  assert.ok(/if\s*\(\s*!isRenderTarget\(cl,\s*appMode\)\s*\)\s*return null;/.test(code),
    'isRenderTarget(cl, appMode) による早期returnが見つからない（描画スキップがポリシー関数から外れている疑い）');
  // 禁止パターンはHEAD（移行前）に実在した旧条件の形そのものに絞る（QA指摘Minor A: appMode===/!=='structure'
  // 単体を禁止すると無害な将来コード（例: 描画スタイル用のisStructMode変数）で偽陽性になる。
  // `git show HEAD:app/src/renderer/CenterLinesLayer.jsx` で確認した旧コード:
  //   const isArchCL = !cl.labeled && cl.discipline === Discipline.ARCH;
  //   if (isArchCL && appMode === 'structure') return null;
  //   const isBeamAxis = centerLineKind(cl) === 'beam';
  //   if (isBeamAxis && appMode !== 'structure') return null;
  // のうち、`isBeamAxis`単体は現行コードでも描画スタイル判定用に正当に残るため、`isBeamAxis`と
  // `appMode`の組合せ式・`isArchCL`という識別子そのものに限定する）。
  assert.ok(!/\bisArchCL\b/.test(code),
    '旧インライン条件の識別子（isArchCL = !cl.labeled && cl.discipline === Discipline.ARCH）が残っている');
  assert.ok(!/isBeamAxis\s*&&\s*appMode\s*!==\s*'structure'/.test(code),
    '旧インライン条件（isBeamAxis && appMode !== \'structure\'）の組合せ式が残っている');
  assert.ok(!/appMode\s*===\s*'structure'\s*\)\s*return null/.test(code),
    '旧インライン条件（... && appMode === \'structure\') return null; の形）が残っている');
});

test('【不変条件】snap.js: resolvePointerTargets の CL 種別フィルタがポリシー（hitTestKinds / isHitTestTarget）から導出され、\'beam\' のインライン比較が無い', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../snap.js'), 'utf8');
  const body = extractFunctionBody(src, 'export function resolvePointerTargets(');
  assert.ok(body, 'resolvePointerTargets が見つからない');
  const code = stripLineComments(body);
  assert.ok(/hitTestKinds\(appMode\)/.test(code) || /isHitTestTarget\(/.test(code),
    'hitTestKinds(appMode)／isHitTestTarget(...) の呼び出しが見つからない（clKindFilterが旧インライン三項へ戻っている疑い）');
  assert.ok(!/'beam'/.test(code),
    "'beam' のインライン比較が残っている（旧条件 appMode==='structure'?k==='beam':k!=='beam' への回帰）");
});

test('【不変条件】App.jsx: CL追加メニューの参照候補がポリシー（isHitTestTarget / hitTestKinds）で絞られる', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const idx = src.indexOf('findNearbyCenterLines(');
  assert.ok(idx >= 0, 'findNearbyCenterLines( の呼び出しが見つからない');
  const code = stripLineComments(src.slice(idx, idx + 500));
  assert.ok(
    /\.filter\(cl\s*=>\s*isHitTestTarget\(cl,\s*appMode\)\)/.test(code) ||
    /\.filter\(cl\s*=>\s*hitTestKinds\(appMode\)\.includes\(centerLineKind\(cl\)\)\)/.test(code),
    'findNearbyCenterLines(...) の直後にポリシー（isHitTestTarget/hitTestKinds）由来のフィルタが見つからない'
  );
  assert.ok(!/appMode\s*===\s*'structure'\s*\?\s*centerLineKind\(cl\)\s*===\s*'beam'/.test(code),
    '旧インライン三項（appMode===\'structure\'?kind===\'beam\':kind!==\'beam\'）が残っている');
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
  assert.throws(() => isOpeningBoundaryKind('wood'), /未知のCL種別: wood/);
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

// ================================================================
// E. 柱アンカー解決（structural/wallBeamAxes.js・woodAutoFill.js・structuralAutoFill.js が共有する述語）
// ================================================================

// addCLOfKind と同じ生成規約だが labeled を明示できる版（旧データ＝labeledと種別が食い違うCLを作るため）。
function addCLOfKindLabeled(graph, project, clType, value, kind, labeled) {
  switch (kind) {
    case 'struct': return project.structGraph.addCenterLine(clType, value, { labeled, discipline: Discipline.STRUCT });
    case 'center': return graph.addCenterLine(clType, value, { labeled, discipline: Discipline.ARCH });
    case 'aux':    return graph.addCenterLine(clType, value, { labeled, lineType: 'dashed' });
    case 'beam':   return graph.addCenterLine(clType, value, { labeled, discipline: Discipline.FUSE });
    default: throw new Error(`未知のCL種別: ${kind}`);
  }
}

test('structuralAnchorKinds: primary=[struct,beam]、secondary=[center]、any=[struct,center,beam]（CL_KINDS順）', () => {
  assert.deepEqual([...structuralAnchorKinds('primary')], ['struct', 'beam']);
  assert.deepEqual([...structuralAnchorKinds('secondary')], ['center']);
  assert.deepEqual([...structuralAnchorKinds('any')], ['struct', 'center', 'beam']);
  assert.deepEqual({ ...STRUCTURAL_ANCHOR_KINDS }, { primary: ['struct', 'beam'], secondary: ['center'] });
  assert.deepEqual([...BEAM_AXIS_KINDS], ['beam']);
  assert.deepEqual([...SUPPORT_SPAN_COLUMN_KINDS], ['struct', 'center']);
});

test('isStructuralAnchor: 4種別×labeled2値×tier3段の総当り（labeledの値は結果を左右しない——通り芯側もlabeled不問）', () => {
  const EXPECTED = {
    primary:   { struct: true,  center: false, aux: false, beam: true },
    secondary: { struct: false, center: true,  aux: false, beam: false },
    any:       { struct: true,  center: true,  aux: false, beam: true },
  };
  for (const tier of ['primary', 'secondary', 'any']) {
    for (const kind of CL_KINDS) {
      for (const labeled of [true, false]) {
        const { graph, project } = makeProjectWithGraph();
        const cl = addCLOfKindLabeled(graph, project, CenterLineType.VERTICAL, 1000, kind, labeled);
        assert.equal(isStructuralAnchor(cl, tier), EXPECTED[tier][kind],
          `tier=${tier} kind=${kind} labeled=${labeled}`);
      }
    }
  }
});

test('【旧データ限定・種別ベースへ統一】isStructuralAnchor: {labeled:false, discipline:STRUCT}（種別struct）はtier=primaryでtrue', () => {
  // HEADのfindBeamAnchorCLは `cl.labeled || kind==='beam'` のため、labeled:falseなstruct種別は一致しなかった
  // （非該当）。isStructuralAnchorは種別（centerLineKind）のみで判定するため一致する（該当）——
  // 製品経路でのD7ピン留めはstructural/wallBeamAxes.test.jsに置く。
  const { graph, project } = makeProjectWithGraph();
  const legacy = addCLOfKindLabeled(graph, project, CenterLineType.VERTICAL, 1000, 'struct', false);
  assert.equal(centerLineKind(legacy), 'struct');
  assert.equal(isStructuralAnchor(legacy, 'primary'), true);
});

test('structuralAnchorAt: tol境界（|Δ|=0.5は不一致・0.4999は一致）', () => {
  const { graph, project } = makeProjectWithGraph();
  const struct = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'struct');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000 + CL_OVERLAP_TOL_MM, tier: 'primary' }), null,
    '|Δ|=CL_OVERLAP_TOL_MM(0.5)ちょうどは不一致（< であって <= ではない）');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000 + CL_OVERLAP_TOL_MM - 0.0001, tier: 'primary' }), struct,
    '|Δ|=0.4999は一致');
});

test('structuralAnchorAt: 座標比較はeffectiveValue基準（pendingDelta込み）——valueでは一致しない', () => {
  const { graph, project } = makeProjectWithGraph();
  const struct = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'struct');
  struct.pendingDelta = 50;
  assert.equal(struct.effectiveValue, 1050);
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1050, tier: 'primary' }), struct,
    'effectiveValue(1050)に一致する座標で見つかる');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'primary' }), null,
    'value(1000)そのものでは見つからない（pendingDelta込みのeffectiveValueで判定するため）');
});

test('structuralAnchorAt: 同tierに2本あるとき graph 追加順で最初が返る（sortしない）', () => {
  const { graph, project } = makeProjectWithGraph();
  const first = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'center');
  addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'center');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'secondary' }), first);
});

test('structuralAnchorAt: 値の大小と追加順が逆でも、tol内の複数候補からgraph追加順で最初が返る（value昇順sortではない）', () => {
  const { graph, project } = makeProjectWithGraph();
  // 追加順=1000.3(先)→999.8(後)。value昇順にsortすると999.8が先頭になり結果が変わってしまう。
  const addedFirst = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000.3, 'center');
  addCLOfKind(graph, project, CenterLineType.VERTICAL, 999.8, 'center');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'secondary' }), addedFirst,
    'graph追加順で先に現れる1000.3側が返る（value昇順にsortして探索していれば999.8が返ってしまう）');
});

test('structuralAnchorAt: 同座標(tol内)に通り芯＋中心線があるとき、tierごとに一致する種別だけが返る', () => {
  const { graph, project } = makeProjectWithGraph();
  const struct = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'struct');
  const center = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'center');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'primary' }), struct);
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'secondary' }), center);
});

test('structuralAnchorAt: 同座標(tol内)に補助線＋梁芯があるとき、補助線はどのtierにも一致しない', () => {
  const { graph, project } = makeProjectWithGraph();
  addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'aux');
  const beam = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'beam');
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'primary' }), beam);
  assert.equal(structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'secondary' }), null);
});

test('【最大の罠】同座標に中心線と梁芯が両方あるとき、tier=primary→secondaryのチェーンは配列順に関係なく梁芯を返す（tier=any単発に畳むと配列順で中心線が返ってしまう）', () => {
  const { graph, project } = makeProjectWithGraph();
  // 追加順=中心線→梁芯（配列でも中心線が先）。
  const center = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'center');
  const beam = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'beam');
  const coord = 1000;
  const chainResult =
    structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord, tier: 'primary' }) ??
    structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord, tier: 'secondary' });
  assert.equal(chainResult, beam, 'チェーン（primary→secondaryの??）は中心線が配列で先でも梁芯（第1候補）を返す');
  const collapsedResult = structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord, tier: 'any' });
  assert.equal(collapsedResult, center,
    '対照: tier=any単発に畳むと配列順で先に現れる中心線を返してしまう（チェーンを畳んではいけない理由の実証）');
});

test('structuralAnchorCandidates: tier=anyはcenterLineType一致・struct/center/beamのみをgraph順で返す（補助線を含まない）', () => {
  const { graph, project } = makeProjectWithGraph();
  const struct = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'struct');
  const center = addCLOfKind(graph, project, CenterLineType.VERTICAL, 2000, 'center');
  addCLOfKind(graph, project, CenterLineType.VERTICAL, 2500, 'aux');
  const beam = addCLOfKind(graph, project, CenterLineType.VERTICAL, 3000, 'beam');
  addCLOfKind(graph, project, CenterLineType.HORIZONTAL, 1000, 'struct'); // 別軸は含まれない
  assert.deepEqual(
    structuralAnchorCandidates(graph, { centerLineType: CenterLineType.VERTICAL, tier: 'any' }),
    [struct, center, beam]);
});

test('beamAxisAt: 梁芯のみに一致する（通り芯には一致しない——findWallBeamAxisCLと同じ意図的な区別）', () => {
  const { graph, project } = makeProjectWithGraph();
  addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'struct');
  const beam = addCLOfKind(graph, project, CenterLineType.VERTICAL, 2000, 'beam');
  assert.equal(beamAxisAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000 }), null,
    '通り芯には一致しない（壁由来梁芯の追従が通り芯を動かす事故を防ぐため）');
  assert.equal(beamAxisAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 2000 }), beam);
});

test('beamAxisCenterLines: centerLineType省略時は全軸の梁芯を、指定時はその軸だけを返す', () => {
  const { graph, project } = makeProjectWithGraph();
  const beamV = addCLOfKind(graph, project, CenterLineType.VERTICAL, 1000, 'beam');
  const beamH = addCLOfKind(graph, project, CenterLineType.HORIZONTAL, 2000, 'beam');
  addCLOfKind(graph, project, CenterLineType.VERTICAL, 3000, 'struct');
  assert.deepEqual(beamAxisCenterLines(graph), [beamV, beamH]);
  assert.deepEqual(beamAxisCenterLines(graph, { centerLineType: CenterLineType.VERTICAL }), [beamV]);
});

test('supportSpanColumnCandidates: centerLineType一致のstruct/centerだけをkind付きでgraph順に返す（梁芯・補助線を含まない）', () => {
  const { graph, project } = makeProjectWithGraph();
  const struct = addCLOfKind(graph, project, CenterLineType.HORIZONTAL, 1000, 'struct');
  const center = addCLOfKind(graph, project, CenterLineType.HORIZONTAL, 2000, 'center');
  addCLOfKind(graph, project, CenterLineType.HORIZONTAL, 3000, 'beam');
  addCLOfKind(graph, project, CenterLineType.HORIZONTAL, 4000, 'aux');
  assert.deepEqual(
    supportSpanColumnCandidates(graph, { centerLineType: CenterLineType.HORIZONTAL }),
    [{ cl: struct, kind: 'struct' }, { cl: center, kind: 'center' }]);
});

test('【失敗系】structuralAnchorKinds/isStructuralAnchor/structuralAnchorAt/structuralAnchorCandidates: 未知のtier・必須引数欠落はthrowする', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(() => structuralAnchorKinds('unknown'), /未知のtier: unknown/);
  assert.throws(() => isStructuralAnchor(null, 'primary'), /clは必須/);
  assert.throws(() => isStructuralAnchor(undefined, 'primary'), /clは必須/);
  assert.throws(() => isStructuralAnchor({ discipline: Discipline.STRUCT, labeled: true }, 'unknown'), /未知のtier: unknown/);
  assert.throws(() => structuralAnchorAt(graph, { coord: 1000, tier: 'primary' }), /centerLineType/);
  assert.throws(() => structuralAnchorAt(graph, { centerLineType: null, coord: 1000, tier: 'primary' }), /centerLineType/);
  assert.throws(() => structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, tier: 'primary' }), /coord/);
  assert.throws(() => structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: NaN, tier: 'primary' }), /coord/);
  assert.throws(() => structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: '1000', tier: 'primary' }), /coord/);
  assert.throws(() => structuralAnchorAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: 1000, tier: 'unknown' }), /未知のtier: unknown/);
  assert.throws(() => structuralAnchorCandidates(graph, { tier: 'any' }), /centerLineType/);
  assert.throws(() => structuralAnchorCandidates(graph, { centerLineType: CenterLineType.VERTICAL, tier: 'unknown' }), /未知のtier: unknown/);
});

test('【失敗系】beamAxisAt/supportSpanColumnCandidates: centerLineType欠落・coord非数値はthrowする', () => {
  const { graph } = makeProjectWithGraph();
  assert.throws(() => beamAxisAt(graph, { coord: 1000 }), /centerLineType/);
  assert.throws(() => beamAxisAt(graph, { centerLineType: CenterLineType.VERTICAL }), /coord/);
  assert.throws(() => beamAxisAt(graph, { centerLineType: CenterLineType.VERTICAL, coord: NaN }), /coord/);
  assert.throws(() => supportSpanColumnCandidates(graph, {}), /centerLineType/);
  assert.throws(() => supportSpanColumnCandidates(graph, { centerLineType: null }), /centerLineType/);
});

// ---- structuralSyncScopeOfKind（原始事実13。structural/structuralSync.js の起動scope導出。
// 段階(a)「通り芯削除→構造同期」・2026-09-25）----

test('structuralSyncScopeOfKind: struct→"all"（FLOOR_SHARED_KINDS＝全階共有）、center→"activeAndAbove"、aux→null、beam→null（専用経路のため除外）', () => {
  assert.equal(structuralSyncScopeOfKind('struct'), 'all');
  assert.equal(structuralSyncScopeOfKind('center'), 'activeAndAbove');
  assert.equal(structuralSyncScopeOfKind('aux'), null, '補助線は直接には構造を起動しない（中心線のextent参照経由の間接効果のみ。段階(d)で別途対応）');
  assert.equal(structuralSyncScopeOfKind('beam'), null, '梁芯は専用経路（wallBeamAxes.js）を持つため対象外（条件10）');
});

test('FLOOR_SHARED_KINDS は struct のみ（通り芯だけが project.structGraph に置かれ全階共有される）', () => {
  assert.deepEqual(FLOOR_SHARED_KINDS, ['struct']);
});

test('【失敗系】structuralSyncScopeOfKind: 未知の種別はthrowする', () => {
  assert.throws(() => structuralSyncScopeOfKind('wood'), /未知のCL種別: wood/);
});

// ---- structuralSyncScopeOfConversion（段階(c)「昇格・降格→構造同期」・2026-09-25） ----

test('structuralSyncScopeOfConversion: どちらかが"all"なら全体で"all"（昇格center→struct、降格struct→center）', () => {
  assert.equal(structuralSyncScopeOfConversion('center', 'struct'), 'all', '昇格（中心線→通り芯）');
  assert.equal(structuralSyncScopeOfConversion('struct', 'center'), 'all', '降格（通り芯→中心線）');
});

test('structuralSyncScopeOfConversion: どちらも"all"でなければ非nullの方（"activeAndAbove"）を使う', () => {
  assert.equal(structuralSyncScopeOfConversion('center', 'center'), 'activeAndAbove');
});

test('structuralSyncScopeOfConversion: 両方nullならnull', () => {
  assert.equal(structuralSyncScopeOfConversion('aux', 'aux'), null);
});

test('【失敗系】structuralSyncScopeOfConversion: 未知の種別はthrowする', () => {
  assert.throws(() => structuralSyncScopeOfConversion('wood', 'struct'), /未知のCL種別: wood/);
});
