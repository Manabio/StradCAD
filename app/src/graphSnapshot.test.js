import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory, Project, Site, SiteLineKind, RoomKind, RoomFeature, ExteriorLevelRef,
  DEFAULT_SHAFT_WALL_MATERIAL, DEFAULT_SHAFT_SOUNDPROOF, ShaftSoundproof, StairType,
  ElevatorEquipmentCategory, EvUsage, DEFAULT_EV_USAGE, StructuralMaterialType, edgeKey,
  RoofSpec, ROOF_SPEC_KEYS, isDefaultRoofSpec, CEILING_ZONE_KEYS, restoreCeilingZones,
} from './core.js';
import { NON_DEFAULT_ROOF_SPEC } from './finish/roofTestFixtures.js';
import { ByteBuffer } from 'flatbuffers';
import {
  serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs, serializePlanes, decodePlanes,
  serializeSite, decodeSite, restoreSite, decodeFloorSnapshot, encodeFloorSnapshot,
  serializeGraphWithFreshLineIds,
} from './graphSnapshot.js';
import { editSiteLineLength } from './transform/siteEdit.js';
import { encode, decode, ROOM_FEATURE_ENC, ROOM_FEATURE_DEC } from './schema/graphFbs.js';
import { base64ToBytes } from './storage/documentFile.js';
import { BeamAxisOrigin } from './core/centerLine.js';
import { remapLineIdsInSnapshot, makeFreshLineIdMap, findLineIdOccurrences } from './lineIdRemap.js';
import { findDuplicateLineIds } from './lineIdUniqueness.js';

// wallBeamAxes.test.js と同じ方針: ダックタイピングでは effectiveValue 等の実挙動を
// 再現できないため、実 core.js（Plane/PlanGraph）を使う。

function makeGraph(planeId = 'p1', elevation = 0) {
  const plane = new Plane(planeId, elevation, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 水平に走る外壁1本 + 引き違い窓1件を持つグラフを作る。
function makeGraphWithWindow(openingProps) {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const o = graph.addOpening(axisCL, 1, false, clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding', openingProps);
  return { graph, opening: o };
}

test('Stair.entrySide/arrivalSide は FlatBuffers encode→decode で往復し、未指定（null）は null のまま', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const cells = new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]);
  const withSides = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [5, 1, 5], entrySide: 'right', arrivalSide: 'end', entryTurnSteps: 3 });
  const auto = graph.addStair({ type: StairType.WINDING, cells, sections: [5, 5, 4] });
  assert.equal(withSides.totalSteps, 13, '総蹴上数は取りつき回転部（3）を含む: 10+3');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const s1 = restored.stairMap.get(withSides.id);
  assert.equal(s1.entrySide, 'right');
  assert.equal(s1.arrivalSide, 'end');
  assert.equal(s1.entryTurnSteps, 3);
  assert.equal(s1.arrivalTurnSteps, 0);
  assert.equal(s1.totalSteps, 13);
  const s2 = restored.stairMap.get(auto.id);
  assert.equal(s2.entrySide, null);
  assert.equal(s2.arrivalSide, null);
  assert.equal(s2.entryTurnSteps, 0);
});

test('Opening.fixtureType/sillHeight は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2, '復元後に同一IDの開口が存在する');
  assert.equal(o2.fixtureType, 'AW');
  assert.equal(o2.sillHeight, 800);
});

// ---- Wall.bandOffset（柱寸法が基準より細い階の外壁下地帯シフト。core/wall.js Wall.bandOffset
// 参照）の FlatBuffers 往復（schema/graphFbs.js WL.HAS_BAND_OFFSET/BAND_OFFSET を末尾追加） ----
test('Wall.bandOffset は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, -72.5, false, clStart, 0, clEnd, 0, {
    isExteriorWall: true, backingOffset: -7.5, bandOffset: -7.5, backingDepth: 105, wallFinish: 12.5,
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const w2 = restored.shapeMap.get(wall.id);
  assert.ok(w2, '復元後に同一IDの壁が存在する');
  assert.equal(w2.bandOffset, -7.5);
  assert.equal(w2.backingOffset, -7.5, '前提: backingOffsetも往復する（既存フィールド）');
});

test('【失敗系】Wall.bandOffset 未設定（null。旧データ相当）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  // bandOffset は未設定のまま（旧データのフィールド欠落と同値の状態）
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const w2 = restored.shapeMap.get(wall.id);
  assert.ok(w2);
  assert.equal(w2.bandOffset, null);
});

// ---- CenterLine.beamAxisOrigin（梁芯の由来。core/centerLine.js BeamAxisOrigin。
// schema/graphFbs.js CL.BEAM_ORIGINを末尾追加。ステップ2・2026-09-26） ----
test('CenterLine.beamAxisOrigin は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.WALL,
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const cl2 = restored.shapeMap.get(cl.id);
  assert.ok(cl2, '復元後に同一IDの中心線が存在する');
  assert.equal(cl2.beamAxisOrigin, BeamAxisOrigin.WALL);
});

test('【失敗系】CenterLine.beamAxisOrigin 未設定（null。旧データ相当）は encode→decode 後も null のまま（既定値に化けない・field 17なしで復元）', () => {
  const graph = makeGraph();
  // beamAxisOrigin は未設定のまま（旧データのフィールド欠落と同値の状態）
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  assert.equal(cl.beamAxisOrigin, null, '前提');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const cl2 = restored.shapeMap.get(cl.id);
  assert.ok(cl2);
  assert.equal(cl2.beamAxisOrigin, null);
});

// QA対応（ステップ2・2026-09-26）: schema/graphFbs.js readCLはBeamAxisOriginの既知の値以外を
// nullへ正規化する（破損データ・将来削除された由来値が未知の色分岐に漏れるのを防ぐ）。
// 床開口由来（規則O。structural/openingBeamAxes.js。実装指示書「スラブ開口と補強・S造梁芯選定」
// ステップ4・2026-09-28）の往復テスト。上のBeamAxisOrigin.WALLの往復テストと同型。
test('CenterLine.beamAxisOrigin:opening（床開口由来）もFlatBuffers encode→decodeで値ありのまま往復する', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const cl2 = restored.shapeMap.get(cl.id);
  assert.ok(cl2, '復元後に同一IDの中心線が存在する');
  assert.equal(cl2.beamAxisOrigin, BeamAxisOrigin.OPENING);
});

// ---- ステップC2a: 小屋梁（role:'roofBeam'・beamType:'小屋梁'）と梁芯の由来 roofBeam の保存。
// 梁の role は文字列・beamType は extra で保存されるため、スキーマ変更なしで往復する（REASONED→ここで固定）。----
function makeRoofBeamGraph() {
  const graph = makeGraph();
  // 通り芯（struct）は structGraph に属し階のスナップショットに含まれないため、階固有の中心線（ARCH）で組む
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const axis = graph.addCenterLine(CenterLineType.VERTICAL, 1820, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.ROOF_BEAM,
  });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: false, discipline: Discipline.ARCH });
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const roofBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x210', axis, true, y0, y1, { role: 'roofBeam', beamType: '小屋梁' });
  roofBeam.setMemberNo('KB1');
  return { graph, roofBeam, axis };
}

test('【C2a】小屋梁（role:roofBeam・beamType:小屋梁）と梁芯の由来roofBeamはFlatBuffers encode→decodeで往復し、再シリアライズもバイト一致する', () => {
  const { graph, roofBeam, axis } = makeRoofBeamGraph();
  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const b2 = restored.beamMap.get(roofBeam.id);
  assert.ok(b2, '復元後に同一IDの小屋梁が存在する');
  assert.equal(b2.role, 'roofBeam');
  assert.equal(b2.beamType, '小屋梁');
  assert.equal(b2.memberNo, 'KB1');
  assert.equal(b2.sectionDefId, 'WOOD-120x210');
  assert.equal(b2.jointType, 'PIN', '既定のjointType（PIN_ROLES）も往復後に保たれる');
  assert.equal(b2.isPinJoint, true);
  assert.equal(restored.shapeMap.get(axis.id).beamAxisOrigin, BeamAxisOrigin.ROOF_BEAM, '由来roofBeamは既知値として保たれる（nullへ落ちない）');
  // 初回の復元→再シリアライズは小屋梁の有無によらずバイト長が変わる（既存挙動。小屋梁なしでも1736→2944で、
  // C2a以前から。復元時にグラフ側の既定値が書かれるため）。小屋梁の保存が安定するのは2回目以降。
  const second = serializeGraph(restored);
  const restored2 = makeGraph();
  restoreGraph(restored2, second);
  const third = serializeGraph(restored2);
  assert.equal(third.length, second.length, '2周目以降はバイト長が変わらない（小屋梁の保存が安定）');
  assert.ok(third.every((v, i) => v === second[i]), '2周目以降はバイト列が変わらない（小屋梁の保存が安定）');
  assert.equal(restored.beams.filter(b => b.role === 'primary').length, 1, '同居する大梁のroleは不変');
});

test('【C2a】小屋梁は plain object 直渡し（decodeFloorSnapshot経由）でも往復する', () => {
  const { graph, roofBeam } = makeRoofBeamGraph();
  const snapshot = decodeFloorSnapshot(encodeFloorSnapshot(decodeFloorSnapshot(serializeGraph(graph))));
  const restored = makeGraph();
  restoreGraph(restored, snapshot);
  const b2 = restored.beamMap.get(roofBeam.id);
  assert.ok(b2);
  assert.equal(b2.role, 'roofBeam');
  assert.equal(b2.beamType, '小屋梁');
});

test('【C2a】undo: serializeGraph(前)→変更（小屋梁の削除）→restoreGraph(前)で小屋梁が元のid・role・beamTypeで戻る', async () => {
  const { undoManager } = await import('./undoManager.js');
  const { graph, roofBeam } = makeRoofBeamGraph();
  const before = serializeGraph(graph);
  graph.beamMap.delete(roofBeam.id);
  const after = serializeGraph(graph);
  assert.equal(graph.beams.some(b => b.role === 'roofBeam'), false, '前提: 削除済み');
  undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
  undoManager.undo();
  const back = graph.beamMap.get(roofBeam.id);
  assert.ok(back, 'undoで小屋梁が戻る');
  assert.equal(back.role, 'roofBeam');
  assert.equal(back.beamType, '小屋梁');
  undoManager.redo();
  assert.equal(graph.beamMap.has(roofBeam.id), false, 'redoで再び消える');
});

test('【C2a・失敗系】role が空文字で保存された梁は復元時に primary へ落ちる（既知roleの既定。roofBeamへは誤変換されない）', () => {
  const { graph } = makeRoofBeamGraph();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  for (const b of snap.beams) if (b.role === 'roofBeam') b.role = '';
  const restored = makeGraph();
  restoreGraph(restored, decodeFloorSnapshot(encodeFloorSnapshot(snap)));
  assert.equal(restored.beams.filter(b => b.role === 'roofBeam').length, 0);
  assert.equal(restored.beams.length, 2);
  assert.ok(restored.beams.every(b => b.role === 'primary'));
});

test('【失敗系】CenterLine.beamAxisOrigin が既知の値以外（未知の文字列）で書かれていた場合、decode後はnullに正規化される', () => {
  const graph = makeGraph();
  // BeamAxisOriginに存在しない値を直接持たせる（writeCL側は値の妥当性を検証せずそのまま文字列化するため、
  // 破損データ・将来のenum縮小を模せる）。
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: 'bogus-origin',
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const cl2 = restored.shapeMap.get(cl.id);
  assert.ok(cl2);
  assert.equal(cl2.beamAxisOrigin, null, '未知の由来文字列はnullへ落ちる（既知の由来色分岐に漏らさない）');
});

// ---- Room.feature='elevatorEquipment'（昇降機。core/constants.js RoomFeature。
// schema/graphFbs.js ROOM_FEATURE_ENC/DECにelevatorEquipment=9を割当て。実装指示書ステップ1・
// 2026-09-28。昇降路属性の整理でDW/貨物用EV/車両用EVは廃止し「昇降機」1種に統合・番号を9へ
// 変更——2026-09-29。属性の識別子は建築基準法上の「昇降機」に対する誤称だった EV から
// ELEVATOR_EQUIPMENT へ改名——分類（EV／エスカレーター／DW）は器具行が持つ。ユーザー裁定
// 2026-09-29「昇降機の中にEV/エスカレーター/DWがある。昇降機とEV等は並列ではない」） ----
// restoreGraph の3経路（FlatBuffers encode→decode / plain object直渡し / undoスナップショット）の
// うち、undoスナップショット経路（centerLineOps.js等）は before/after を serializeGraph(graph)
// （＝Uint8Array）で採り restoreGraph(graph, bytes) で戻すため、下の「FlatBuffers encode→decode」
// テストと同一の restoreGraph(bytes)→decode→applySnapshot 経路に収束する（REASONED。
// centerLineOps.js:184-196 で確認）。よってundo経路専用のテストは書き分けない。
// plain object経路（本番の呼び出し元は無くなった。restoreGraph の plain object 分岐は残っているので、
// その回帰を防ぐために固定している）は
// decode()を経由せず applySnapshot が d.feature を直接読む（graphSnapshot.js:757-762）ため、
// 別経路として下に固定する。
test('Room.feature=\'elevatorEquipment\'（昇降機）は FlatBuffers encode→decode で往復する', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), '昇降路');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.ok(r2, '復元後に同一IDの部屋が存在する');
  assert.equal(r2.feature, RoomFeature.ELEVATOR_EQUIPMENT);
});

// QA指摘（低3件・3件目）: decode(serializeGraph(graph)) で作った snapshot はFlatBuffersの
// ENC/DECを経由して作られるため、plain object経路がENC/DECと独立に'elevatorEquipment'を保つ
// ことの証明にならない（変異でENC/DECからelevatorEquipmentを除去すると、
// decode(serializeGraph(...))の時点で既にfeatureが失われ、このテストが「plain object経路の
// 検証」として機能しなくなる）。graphSnapshot.js の serialize側（buildSnapshot。rooms要素は
// :105-138付近）が出力する形を手書きし、ENC/DECから独立させる。
// applySnapshot（:560-）が `for (const d of snapshot.XXX)` と ??[] を伴わずに直接読む配列
// （centerLines/points/walls/diagonals/verticalLines/horizontalLines/arcs/circles）だけを埋め、
// rooms 以外は空のまま——他はすべて `?? []` でフォールバックするため省略できる。
test('Room.feature=\'elevatorEquipment\'（昇降機）は restoreGraph への plain object 直渡し（旧JSON文書ファイル読込みと同じ経路）でも往復する', () => {
  const snapshot = {
    centerLines: [], points: [], walls: [], diagonals: [],
    verticalLines: [], horizontalLines: [], arcs: [], circles: [],
    rooms: [{
      id: 'room-shaft-1', name: '昇降路', cells: [], referenceRoomIds: [],
      kind: 'interior', feature: RoomFeature.ELEVATOR_EQUIPMENT, generatedWallIds: [],
    }],
    roomOrder: ['room-shaft-1'],
  };

  const restored = makeGraph();
  restoreGraph(restored, snapshot);

  const r2 = restored.roomMap.get('room-shaft-1');
  assert.ok(r2, '復元後に同一IDの部屋が存在する');
  assert.equal(r2.feature, RoomFeature.ELEVATOR_EQUIPMENT);
});

// ---- 昇降機の仕様追加ステップ2（S4）: ROOM_FEATURE_ENC/DEC 表そのものの検査。ENC/DECは
// schema/graphFbs.js が export する（決定と読み替えをこの表だけに閉じるため。テストは
// 表そのものを直接読み、encode/decodeの往復や手書きバイト操作を経由しない——理由: FlatBuffers
// のバイト列を手で書き換えるのはvtableオフセットの知識を要し脆いため、表を唯一の供給源として
// 直接検査する方がテストの意図が明確になる）。 ----
test('【S4】ROOM_FEATURE_ENC.elevatorEquipment は新番号9', () => {
  assert.equal(ROOM_FEATURE_ENC.elevatorEquipment, 9);
});

test('【S4】ROOM_FEATURE_DEC は旧5〜8（旧ev/dw/freightEv/vehicleEv）と新9をすべて\'elevatorEquipment\'へ読み替える', () => {
  for (const code of [5, 6, 7, 8, 9]) {
    assert.equal(ROOM_FEATURE_DEC[code], 'elevatorEquipment', `code=${code} は 'elevatorEquipment' へ読み替わるはず`);
  }
});

// ---- 屋根（ステップB1a）: Room.feature='roof'=10。kind は EXTERIOR 固定 ----
test('【B1a】ROOM_FEATURE_ENC.roof は10、ROOM_FEATURE_DEC[10] は \'roof\'（既存の番号は不変）', () => {
  assert.equal(ROOM_FEATURE_ENC.roof, 10);
  assert.equal(ROOM_FEATURE_DEC[10], 'roof');
  assert.equal(ROOM_FEATURE_ENC.elevatorEquipment, 9);
  assert.equal(ROOM_FEATURE_ENC.stair, 1);
});

test('【B1a】Room.feature=\'roof\'（kind=EXTERIOR・name=屋根）は FlatBuffers encode→decode で feature・kind・name とも往復する', () => {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '屋根');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.ROOF);

  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));

  const r2 = restored.roomMap.get(room.id);
  assert.ok(r2, '復元後に同一IDの部屋が存在する');
  assert.equal(r2.feature, RoomFeature.ROOF);
  assert.equal(r2.kind, RoomKind.EXTERIOR);
  assert.equal(r2.name, '屋根');
});

test('【B1a】屋根の部屋は階の複製・検討案のコピー（serializeGraphWithFreshLineIds）でも feature・kind・name が残り、セルは振り直した線idを指す', () => {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '屋根');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.ROOF);

  const copy = makeGraph();
  restoreGraph(copy, serializeGraphWithFreshLineIds(graph));

  const r2 = copy.roomMap.get(room.id);
  assert.ok(r2, '複製先に屋根の部屋が残る（room id は不変）');
  assert.equal(r2.feature, RoomFeature.ROOF);
  assert.equal(r2.kind, RoomKind.EXTERIOR);
  assert.equal(r2.name, '屋根');
  const [cellKey] = r2.cells;
  for (const id of cellKey.split(':')) {
    assert.ok(copy.shapeMap.has(id), `セルが指す線id ${id} が複製先に存在する`);
    assert.ok(![x0.id, x1.id, y0.id, y1.id].includes(id), '線idは振り直されている');
  }
});

// ---- 屋根の仕様（ステップB2。Room.roofSpec。FBS の RS テーブル＋RM.ROOF_SPEC=30） ----
// 屋根（全10項目を既定値以外にした RoofSpec）の部屋を1つ持つ graph。屋内の部屋も1つ置く（roofSpec を持たない側の確認用）。
function makeGraphWithRoofRoom(specData = NON_DEFAULT_ROOF_SPEC) {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, opt);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const interior = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '居間');
  const roof = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  roof.setRoofSpec(RoofSpec.fromData(specData));
  return { graph, interior, roof };
}

test('【B2】FlatBuffers encode→decode: 全10項目を既定値以外にした RoofSpec が往復する（出幅0・勾配2.5・形状は明示）', () => {
  const { graph, roof, interior } = makeGraphWithRoofRoom();
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.deepEqual(restored.roomMap.get(roof.id).roofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.equal(restored.roomMap.get(roof.id).roofSpec.eaveOverhangMm, 0);
  assert.equal(restored.roomMap.get(roof.id).roofSpec.slope, 2.5);
  assert.equal(restored.roomMap.get(interior.id).roofSpec, null, '屋根でない部屋は roofSpec を持たない');
});

test('【B2】FlatBuffers: 形状 null（自動）・出幅0 の組が往復する（shape は空文字で保存され null へ戻る）', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, shape: null, eaveOverhangMm: 0, gableOverhangMm: 0 });
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  const spec = restored.roomMap.get(roof.id).roofSpec;
  assert.equal(spec.shape, null);
  assert.equal(spec.eaveOverhangMm, 0);
  assert.equal(spec.gableOverhangMm, 0);
});

test('【B2】graphSnapshot の plain 経路（decodeFloorSnapshot→JSON→restoreGraph）でも RoofSpec が往復する。キー集合は ROOF_SPEC_KEYS', () => {
  const { graph, roof } = makeGraphWithRoofRoom();
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  const plainRoof = snapshot.rooms.find(r => r.id === roof.id);
  assert.deepEqual(Object.keys(plainRoof.roofSpec).sort(), [...ROOF_SPEC_KEYS].sort(), 'FBS 読み側のキー集合 = ROOF_SPEC_KEYS');
  const viaJson = JSON.parse(JSON.stringify(snapshot));
  const restored = makeGraph();
  restoreGraph(restored, viaJson);
  assert.deepEqual(restored.roomMap.get(roof.id).roofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
});

test('【B2】階の複製・検討案のコピー（serializeGraphWithFreshLineIds）でも RoofSpec が残る', () => {
  const { graph, roof } = makeGraphWithRoofRoom();
  const copy = makeGraph();
  restoreGraph(copy, serializeGraphWithFreshLineIds(graph));
  assert.deepEqual(copy.roomMap.get(roof.id).roofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
});

test('【B2・失敗系】屋根なのに roofSpec が欠けたスナップショット（B1a 時点のデータ）は既定値で補う（備考「下野」）', () => {
  const { graph, roof } = makeGraphWithRoofRoom();
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  snapshot.rooms.find(r => r.id === roof.id).roofSpec = null;
  const restored = makeGraph();
  restoreGraph(restored, snapshot);
  const spec = restored.roomMap.get(roof.id).roofSpec;
  assert.ok(spec, 'I1: ROOF の部屋には roofSpec が補われる');
  assert.deepEqual(spec.toData(), {
    shape: null, slope: 3, sheathingMaterial: '101200000008', underlaymentMaterial: '302000000003',
    roofFinish: '', eaveOverhangMm: 455, gableOverhangMm: 455, soffit: '', note: '下野', highSide: null,
    ridgeDirection: null, columnThrough: false,
  });
  // バッファ自体に RS が無い経路（RoofSpec を持たない屋根の部屋を書いて読む）でも同じ
  const noSpec = makeGraphWithRoofRoom();
  noSpec.roof.setRoofSpec(null);
  const viaFbs = makeGraph();
  restoreGraph(viaFbs, serializeGraph(noSpec.graph));
  assert.equal(viaFbs.roomMap.get(noSpec.roof.id).roofSpec.note, '下野');
});

test('【B2・失敗系】屋根でない部屋に roofSpec が付いたスナップショットは復元で捨てる（FBS の RS テーブルを経由しても）', () => {
  const { graph, interior } = makeGraphWithRoofRoom();
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  snapshot.rooms.find(r => r.id === interior.id).roofSpec = { ...NON_DEFAULT_ROOF_SPEC };
  const viaPlain = makeGraph();
  restoreGraph(viaPlain, snapshot);
  assert.equal(viaPlain.roomMap.get(interior.id).roofSpec, null, 'plain 経路');
  const viaFbs = makeGraph();
  restoreGraph(viaFbs, encodeFloorSnapshot(snapshot));
  assert.equal(viaFbs.roomMap.get(interior.id).roofSpec, null, 'FBS 経路');
});

// ---- 主屋根（ステップB3。PlanGraph.mainRoofSpec。FBS の GS.MAIN_ROOF_SPEC=53） ----
// 既定値のときは何も書かない（既存文書のバイト列を変えない）。既定以外のときだけ RS テーブルで書く。
test('【B3】既定値の mainRoofSpec は保存データへ書かれない（decode で null）。何度編集して既定へ戻してもバイト列は同じ', () => {
  const graph = makeGraph();
  const base = serializeGraph(graph);
  assert.equal(decodeFloorSnapshot(base).mainRoofSpec, null, '既定値は GS.MAIN_ROOF_SPEC を書かない');
  assert.equal(graph.mainRoofSpec.toData().note, '', '主屋根の備考の既定は空（下屋の「下野」ではない）');

  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  assert.ok(serializeGraph(graph).length > base.length, '既定以外は RS テーブルぶん長くなる');
  graph.setMainRoofSpec(new RoofSpec());
  assert.deepEqual([...serializeGraph(graph)], [...base], '既定へ戻せばバイト列は元と一致（1バイトも変わらない）');
});

test('【B3】既定値のバイト列は mainRoofSpec のキーが無い snapshot を encode したものと一致する（旧形式と同じ）', () => {
  const { graph } = makeGraphWithRoofRoom(); // 屋根の部屋など他の内容を持つ階でも
  const bytes = serializeGraph(graph);
  const snap = decodeFloorSnapshot(bytes);
  delete snap.mainRoofSpec;
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...bytes]);
});

test('【B3】FlatBuffers encode→decode: 全10項目を既定値以外にした主屋根が往復する（出幅0・勾配2.5・形状は明示）', () => {
  const graph = makeGraph();
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.deepEqual(restored.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
  assert.equal(restored.mainRoofSpec.eaveOverhangMm, 0);
  assert.equal(restored.mainRoofSpec.slope, 2.5);
});

test('【B3】FlatBuffers: 主屋根の形状だけを明示（他は既定）も既定外として保存され、形状 null（自動）に戻した出幅0 も往復する', () => {
  const graph = makeGraph();
  graph.mainRoofSpec.setField('shape', 'flat');
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.mainRoofSpec.shape, 'flat');
  assert.equal(isDefaultRoofSpec(restored.mainRoofSpec), false);

  const graph2 = makeGraph();
  graph2.mainRoofSpec.setField('eaveOverhangMm', 0);
  graph2.mainRoofSpec.setField('gableOverhangMm', 0);
  const restored2 = makeGraph();
  restoreGraph(restored2, serializeGraph(graph2));
  assert.equal(restored2.mainRoofSpec.shape, null);
  assert.equal(restored2.mainRoofSpec.eaveOverhangMm, 0, '出幅0 を既定の455へ読み替えない');
  assert.equal(restored2.mainRoofSpec.gableOverhangMm, 0);
});

test('【B3】plain 経路（decodeFloorSnapshot→JSON→restoreGraph）でも主屋根が往復する。キー集合は ROOF_SPEC_KEYS', () => {
  const graph = makeGraph();
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  assert.deepEqual(Object.keys(snapshot.mainRoofSpec).sort(), [...ROOF_SPEC_KEYS].sort(), 'FBS 読み側のキー集合 = ROOF_SPEC_KEYS');
  const restored = makeGraph();
  restoreGraph(restored, JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
});

test('【B3】階の複製・検討案のコピー（serializeGraphWithFreshLineIds）でも主屋根が残る', () => {
  const graph = makeGraph();
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const copy = makeGraph();
  restoreGraph(copy, serializeGraphWithFreshLineIds(graph));
  assert.deepEqual(copy.mainRoofSpec.toData(), { ...NON_DEFAULT_ROOF_SPEC });
});

test('【B3】既定値のバイト列を復元すると、直前に既定外だった主屋根も既定へ戻る（restoreGraph は clear で初期化する）', () => {
  const graph = makeGraph();
  const defaultBytes = serializeGraph(graph);
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  restoreGraph(graph, defaultBytes);
  assert.deepEqual(graph.mainRoofSpec.toData(), new RoofSpec().toData());
  assert.ok(graph.mainRoofSpec instanceof RoofSpec, '常に RoofSpec（null にしない）');
});

test('【B3・失敗系】旧データ（mainRoofSpec のフィールド・キーが無い）は既定値になる', () => {
  const snapshot = decodeFloorSnapshot(serializeGraph(makeGraph()));
  delete snapshot.mainRoofSpec; // キー自体が無い旧 snapshot
  const restored = makeGraph();
  restoreGraph(restored, snapshot);
  assert.deepEqual(restored.mainRoofSpec.toData(), new RoofSpec().toData());
});

test('【B3・失敗系】壊れた主屋根（未知の shape・負の出幅・slope=0・材料コード欠落）は復元で正規化される（FBS・plain とも）', () => {
  const broken = { shape: 'dome', slope: 0, sheathingMaterial: '', underlaymentMaterial: '', roofFinish: '仕上',
    eaveOverhangMm: -5, gableOverhangMm: NaN, soffit: '軒裏', note: 'メモ' };
  const snapshot = decodeFloorSnapshot(serializeGraph(makeGraph()));
  snapshot.mainRoofSpec = broken;
  for (const [label, input] of [['plain', snapshot], ['FBS', encodeFloorSnapshot(snapshot)]]) {
    const restored = makeGraph();
    restoreGraph(restored, input);
    assert.deepEqual(restored.mainRoofSpec.toData(), {
      shape: null, slope: 3, sheathingMaterial: '101200000008', underlaymentMaterial: '302000000003',
      roofFinish: '仕上', eaveOverhangMm: 455, gableOverhangMm: 455, soffit: '軒裏', note: 'メモ', highSide: null,
      ridgeDirection: null, columnThrough: false,
    }, label);
  }
});

test('【B3】主屋根は屋根の部屋（下屋）の RoofSpec と別の保存先: 両方あっても互いに干渉しない', () => {
  const { graph, roof } = makeGraphWithRoofRoom();
  graph.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, note: '主屋根メモ', slope: 4 }));
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.mainRoofSpec.note, '主屋根メモ');
  assert.equal(restored.mainRoofSpec.slope, 4);
  assert.equal(restored.roomMap.get(roof.id).roofSpec.note, '下野');
  assert.equal(restored.roomMap.get(roof.id).roofSpec.slope, 2.5);
});

// ---- 片流れの高い側（ステップC1b。RoofSpec.highSide。FBS の RS.HIGH_SIDE=9。null は書かない） ----
const HIGH_SIDES = ['top', 'bottom', 'left', 'right'];

test('【C1b】highSide の4値が FBS・plain 経路で往復する（下屋・主屋根とも）', () => {
  for (const highSide of HIGH_SIDES) {
    const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, highSide });
    graph.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, highSide }));
    const viaFbs = makeGraph();
    restoreGraph(viaFbs, serializeGraph(graph));
    assert.equal(viaFbs.roomMap.get(roof.id).roofSpec.highSide, highSide, `下屋 FBS ${highSide}`);
    assert.equal(viaFbs.mainRoofSpec.highSide, highSide, `主屋根 FBS ${highSide}`);
    const snapshot = decodeFloorSnapshot(serializeGraph(graph));
    const viaPlain = makeGraph();
    restoreGraph(viaPlain, JSON.parse(JSON.stringify(snapshot)));
    assert.equal(viaPlain.roomMap.get(roof.id).roofSpec.highSide, highSide, `下屋 plain ${highSide}`);
    assert.equal(viaPlain.mainRoofSpec.highSide, highSide, `主屋根 plain ${highSide}`);
    const copy = makeGraph();
    restoreGraph(copy, serializeGraphWithFreshLineIds(graph));
    assert.equal(copy.roomMap.get(roof.id).roofSpec.highSide, highSide, `複製 ${highSide}`);
    assert.equal(copy.mainRoofSpec.highSide, highSide, `主屋根の複製 ${highSide}`);
  }
});

test('【C1b】主屋根は highSide だけを明示（他は既定）しても既定外として保存・復元される', () => {
  const graph = makeGraph();
  const base = serializeGraph(graph);
  graph.mainRoofSpec.setField('highSide', 'left');
  assert.equal(isDefaultRoofSpec(graph.mainRoofSpec), false);
  assert.ok(serializeGraph(graph).length > base.length);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.mainRoofSpec.highSide, 'left');
  assert.equal(restored.mainRoofSpec.shape, null);
});

test('【C1b】highSide が null のときは何も書かない: 下屋で一度設定して null へ戻したバイト列は、設定前と一致する', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, highSide: null });
  const base = serializeGraph(graph);
  roof.roofSpec.setField('highSide', 'top');
  assert.ok(serializeGraph(graph).length > base.length, '値があれば文字列ぶん長くなる');
  roof.roofSpec.setField('highSide', null);
  assert.deepEqual([...serializeGraph(graph)], [...base]);
  // 旧データ（highSide のキーが無い plain）を encode したバイト列とも一致する（フィールドを書かない）
  const snap = decodeFloorSnapshot(base);
  assert.equal(snap.rooms.find(r => r.id === roof.id).roofSpec.highSide, null, '読みは null');
  delete snap.rooms.find(r => r.id === roof.id).roofSpec.highSide;
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base]);
});

test('【C1b・失敗系】旧データ（highSide のキー・フィールドが無い）は null。壊れた highSide は null へ正規化される（FBS・plain とも）', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, highSide: null });
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  delete snapshot.rooms.find(r => r.id === roof.id).roofSpec.highSide;
  const old = makeGraph();
  restoreGraph(old, snapshot);
  assert.equal(old.roomMap.get(roof.id).roofSpec.highSide, null);
  for (const bad of ['up', 'TOP', 7]) {
    snapshot.rooms.find(r => r.id === roof.id).roofSpec.highSide = bad;
    snapshot.mainRoofSpec = { ...NON_DEFAULT_ROOF_SPEC, highSide: bad };
    for (const [label, input] of [['plain', snapshot]]) {
      const restored = makeGraph();
      restoreGraph(restored, input);
      assert.equal(restored.roomMap.get(roof.id).roofSpec.highSide, null, `${label} 下屋 ${bad}`);
      assert.equal(restored.mainRoofSpec.highSide, null, `${label} 主屋根 ${bad}`);
    }
  }
  // FBS に壊れた文字列が書かれていた場合（文字列の bad だけ）
  snapshot.rooms.find(r => r.id === roof.id).roofSpec.highSide = 'up';
  snapshot.mainRoofSpec = { ...NON_DEFAULT_ROOF_SPEC, highSide: 'up' };
  const viaFbs = makeGraph();
  restoreGraph(viaFbs, encodeFloorSnapshot(snapshot));
  assert.equal(viaFbs.roomMap.get(roof.id).roofSpec.highSide, null);
  assert.equal(viaFbs.mainRoofSpec.highSide, null);
});

// ---- 切妻の棟木の向き（ステップC2e-1c。RoofSpec.ridgeDirection。FBS の RS.RIDGE_DIRECTION=10。null は書かない） ----
const RIDGE_DIRECTIONS = ['vertical', 'horizontal'];

test('【C2e-1c】ridgeDirection の2値が FBS・plain 経路・複製で往復する（下屋・主屋根とも）', () => {
  for (const ridgeDirection of RIDGE_DIRECTIONS) {
    const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, ridgeDirection });
    graph.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, ridgeDirection }));
    const viaFbs = makeGraph();
    restoreGraph(viaFbs, serializeGraph(graph));
    assert.equal(viaFbs.roomMap.get(roof.id).roofSpec.ridgeDirection, ridgeDirection, `下屋 FBS ${ridgeDirection}`);
    assert.equal(viaFbs.mainRoofSpec.ridgeDirection, ridgeDirection, `主屋根 FBS ${ridgeDirection}`);
    const viaPlain = makeGraph();
    restoreGraph(viaPlain, JSON.parse(JSON.stringify(decodeFloorSnapshot(serializeGraph(graph)))));
    assert.equal(viaPlain.roomMap.get(roof.id).roofSpec.ridgeDirection, ridgeDirection, `下屋 plain ${ridgeDirection}`);
    assert.equal(viaPlain.mainRoofSpec.ridgeDirection, ridgeDirection, `主屋根 plain ${ridgeDirection}`);
    const copy = makeGraph();
    restoreGraph(copy, serializeGraphWithFreshLineIds(graph));
    assert.equal(copy.roomMap.get(roof.id).roofSpec.ridgeDirection, ridgeDirection, `複製 ${ridgeDirection}`);
    assert.equal(copy.mainRoofSpec.ridgeDirection, ridgeDirection, `主屋根の複製 ${ridgeDirection}`);
  }
});

test('【C2e-1c】主屋根は ridgeDirection だけを明示（他は既定）しても既定外として保存・復元される', () => {
  const graph = makeGraph();
  const base = serializeGraph(graph);
  graph.mainRoofSpec.setField('ridgeDirection', 'horizontal');
  assert.equal(isDefaultRoofSpec(graph.mainRoofSpec), false);
  assert.ok(serializeGraph(graph).length > base.length);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.mainRoofSpec.ridgeDirection, 'horizontal');
  assert.equal(restored.mainRoofSpec.shape, null);
});

test('【C2e-1c】ridgeDirection が null のときは何も書かない: 設定して null へ戻したバイト列は設定前と一致し、キーの無い旧データを encode したものとも一致する', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, ridgeDirection: null });
  const base = serializeGraph(graph);
  roof.roofSpec.setField('ridgeDirection', 'vertical');
  assert.ok(serializeGraph(graph).length > base.length, '値があれば文字列ぶん長くなる');
  roof.roofSpec.setField('ridgeDirection', null);
  assert.deepEqual([...serializeGraph(graph)], [...base]);
  const snap = decodeFloorSnapshot(base);
  assert.equal(snap.rooms.find(r => r.id === roof.id).roofSpec.ridgeDirection, null, '読みは null');
  delete snap.rooms.find(r => r.id === roof.id).roofSpec.ridgeDirection;
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base]);
});

test('【C2e-1c・失敗系】旧データ（ridgeDirection のキーが無い）は null。壊れた ridgeDirection は null へ正規化される（plain・FBS とも）', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, ridgeDirection: null });
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  delete snapshot.rooms.find(r => r.id === roof.id).roofSpec.ridgeDirection;
  const old = makeGraph();
  restoreGraph(old, snapshot);
  assert.equal(old.roomMap.get(roof.id).roofSpec.ridgeDirection, null);
  for (const bad of ['diagonal', 'VERTICAL', 'top', 7]) {
    snapshot.rooms.find(r => r.id === roof.id).roofSpec.ridgeDirection = bad;
    snapshot.mainRoofSpec = { ...NON_DEFAULT_ROOF_SPEC, ridgeDirection: bad };
    const restored = makeGraph();
    restoreGraph(restored, snapshot);
    assert.equal(restored.roomMap.get(roof.id).roofSpec.ridgeDirection, null, `plain 下屋 ${bad}`);
    assert.equal(restored.mainRoofSpec.ridgeDirection, null, `plain 主屋根 ${bad}`);
  }
  snapshot.rooms.find(r => r.id === roof.id).roofSpec.ridgeDirection = 'diagonal';
  snapshot.mainRoofSpec = { ...NON_DEFAULT_ROOF_SPEC, ridgeDirection: 'diagonal' };
  const viaFbs = makeGraph();
  restoreGraph(viaFbs, encodeFloorSnapshot(snapshot));
  assert.equal(viaFbs.roomMap.get(roof.id).roofSpec.ridgeDirection, null);
  assert.equal(viaFbs.mainRoofSpec.ridgeDirection, null);
});

// ---- 柱貫通（RoofSpec.columnThrough。FBS の RS.COLUMN_THROUGH=11。true のときだけ書く） ----
// 主屋根の RS テーブル（GS.MAIN_ROOF_SPEC=53）に、フィールド番号 fieldNo が書かれているか（vtable の有無）を直接読む。
// 値でなくフィールドの有無を見るのは、既定値のフィールドを書かないこと＝既存文書のバイト列が変わらないことの検査のため。
function mainRoofSpecHasField(bytes, fieldNo) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const o = bb.__offset(root, 4 + 53 * 2);
  assert.ok(o, '前提: 主屋根の RS テーブルがある');
  return bb.__offset(bb.__indirect(root + o), 4 + fieldNo * 2) !== 0;
}

test('【柱貫通】FlatBuffers: false のときは RS の COLUMN_THROUGH(11) を書かない。true のときだけ書く（既存フィールドの有無は対照）', () => {
  const { graph } = makeGraphWithRoofRoom();
  graph.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, highSide: 'top', columnThrough: false }));
  const off = serializeGraph(graph);
  assert.equal(mainRoofSpecHasField(off, 9), true, '対照: highSide(9) は値があれば書かれる（読み取りヘルパーが効いている）');
  assert.equal(mainRoofSpecHasField(off, 11), false, 'false は書かない');
  graph.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, highSide: 'top', columnThrough: true }));
  assert.equal(mainRoofSpecHasField(serializeGraph(graph), 11), true, 'true は書く');
});

test('【柱貫通】FlatBuffers: 下屋の false を true→false と往復させたバイト列は最初と一致する。キーが無い旧データの plain を encode しても一致する', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, columnThrough: false });
  const base = serializeGraph(graph);
  roof.roofSpec.setField('columnThrough', true);
  assert.notDeepEqual([...serializeGraph(graph)], [...base], 'true ではバイト列が変わる');
  roof.roofSpec.setField('columnThrough', false);
  assert.deepEqual([...serializeGraph(graph)], [...base]);
  // 旧データ（columnThrough のキーが無い plain）を encode したバイト列とも一致する（false はフィールドを書かない）
  const snap = decodeFloorSnapshot(base);
  assert.equal(snap.rooms.find(r => r.id === roof.id).roofSpec.columnThrough, false, '読みは false');
  delete snap.rooms.find(r => r.id === roof.id).roofSpec.columnThrough;
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base]);
});

test('【柱貫通】FlatBuffers: true は下屋・主屋根とも往復する。false は false のまま', () => {
  for (const columnThrough of [true, false]) {
    const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, columnThrough });
    graph.setMainRoofSpec(RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, columnThrough }));
    const restored = makeGraph();
    restoreGraph(restored, serializeGraph(graph));
    assert.equal(restored.roomMap.get(roof.id).roofSpec.columnThrough, columnThrough, `下屋 ${columnThrough}`);
    assert.equal(restored.mainRoofSpec.columnThrough, columnThrough, `主屋根 ${columnThrough}`);
  }
});

test('【柱貫通・失敗系】壊れた columnThrough（真偽値でない値）は復元で false へ正規化される', () => {
  const { graph, roof } = makeGraphWithRoofRoom({ ...NON_DEFAULT_ROOF_SPEC, columnThrough: true });
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  for (const bad of ['yes', 1, null]) {
    snapshot.rooms.find(r => r.id === roof.id).roofSpec.columnThrough = bad;
    const restored = makeGraph();
    restoreGraph(restored, snapshot);
    assert.equal(restored.roomMap.get(roof.id).roofSpec.columnThrough, false, `columnThrough=${JSON.stringify(bad)}`);
  }
});

test('【B2・失敗系】壊れた roofSpec（未知の shape・負の出幅・slope=0・材料コード欠落）は復元で正規化される', () => {
  const { graph, roof } = makeGraphWithRoofRoom();
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  snapshot.rooms.find(r => r.id === roof.id).roofSpec = {
    ...NON_DEFAULT_ROOF_SPEC, shape: 'dome', eaveOverhangMm: -3, slope: 0, sheathingMaterial: '', underlaymentMaterial: undefined,
  };
  const restored = makeGraph();
  restoreGraph(restored, snapshot);
  const spec = restored.roomMap.get(roof.id).roofSpec;
  assert.equal(spec.shape, null);
  assert.equal(spec.eaveOverhangMm, 455);
  assert.equal(spec.slope, 3);
  assert.equal(spec.sheathingMaterial, '101200000008');
  assert.equal(spec.underlaymentMaterial, '302000000003');
  assert.equal(spec.gableOverhangMm, 300, '正常な項目は保つ');
});

// ---- 【F4】旧形式の実バッファ（FEATURE列挙値が旧番号5〜8／未知の番号）を restoreGraph で
// 読み込む往復。ROOM_FEATURE_DEC表そのものの直接検査（decode経路を通らない）だけでは製品の
// decode（graphFbs.js の readRoom: ROOM_FEATURE_DEC[r.i8(RM.FEATURE)] ?? null）の `?? null` を
// 守れないため、実バッファを直接書き換えて decode 経路を通す。バイト列中のFEATURE値の
// オフセットは決め打ちにせず、feature以外を完全に同一（CenterLine・Room のidを固定して揃える）
// にした2つのバッファ（feature='elevatorEquipment' と feature='stair'。どちらもROOM_FEATURE_ENCに実在する値で
// RM.FEATUREフィールドの位置は共通）を diff して求める——同一構造で唯一意味のある差はFEATUREの
// 値だけになるため、差分バイトが「ちょうど1箇所」であることまで確認してから使う（前提が崩れたら
// 赤くなる形。固定オフセットの決め打ちを避ける方法として、リード指示のこの方式を採用した）。
function buildFixedRoomBuffer(feature) {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt, 'f4-x0');
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, opt, 'f4-x1');
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt, 'f4-y0');
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt, 'f4-y1');
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'r', 'f4-room');
  room.setFeature(feature);
  return serializeGraph(graph);
}

// feature以外が完全に同一な2バッファをdiffしてFEATUREフィールドのバイトオフセットを求める。
function findFeatureOffset() {
  const evBytes    = buildFixedRoomBuffer(RoomFeature.ELEVATOR_EQUIPMENT);
  const stairBytes = buildFixedRoomBuffer(RoomFeature.STAIR);
  assert.equal(evBytes.length, stairBytes.length, '前提: feature以外は完全に同一構造のはず（長さが同じ）');

  const diffOffsets = [];
  for (let i = 0; i < evBytes.length; i++) {
    if (evBytes[i] !== stairBytes[i]) diffOffsets.push(i);
  }
  assert.equal(diffOffsets.length, 1, `前提: feature以外に差が無いはず（差分バイト数: ${diffOffsets.length}）`);
  const featureOffset = diffOffsets[0];
  assert.equal(evBytes[featureOffset], ROOM_FEATURE_ENC.elevatorEquipment, '前提: 差分位置の値がelevatorEquipment番号のはず');
  assert.equal(stairBytes[featureOffset], ROOM_FEATURE_ENC.stair, '前提: 差分位置の値がstair番号のはず');
  return { evBytes, featureOffset };
}

test('【F4】旧形式バッファ（FEATURE=5〜8）を restoreGraph で読み込むと feature=\'elevatorEquipment\' になる（decode経路を実際に通す）', () => {
  const { evBytes, featureOffset } = findFeatureOffset();

  for (const legacyCode of [5, 6, 7, 8]) {
    const legacyBytes = evBytes.slice();
    legacyBytes[featureOffset] = legacyCode;

    const restored = makeGraph();
    restoreGraph(restored, legacyBytes);
    const r2 = [...restored.roomMap.values()].find(r => r.id === 'f4-room');
    assert.ok(r2, `legacyCode=${legacyCode}: 復元後に部屋が存在する`);
    assert.equal(r2.feature, 'elevatorEquipment', `legacyCode=${legacyCode}: 旧番号は'elevatorEquipment'へ読み替わるはず`);
  }
});

// QA指摘: 旧版はテスト自身の式 `ROOM_FEATURE_DEC[11] ?? null` を評価しているだけで、製品の
// decode の `?? null`（graphFbs.js readRoom）を実際には通していなかった。F4と同じバイト差し替え
// 方式で code=11（未知の番号。10 は屋根に割当て済み）のバッファを decode() へ直接通し、
// Room.feature が null になることを確かめる形へ置き換える。
// restoreGraph ではなく decode() を直接呼ぶ理由（実測で確認・REASONED→VERIFIED）: readRoom の
// `?? null` を外して確かめようとしたところ、restoreGraph 経由では赤にならなかった——
// graphSnapshot.js の applySnapshot 側にも独立した `const feature = … (d.feature ?? null);`
// という二重目の ?? null があり（プレーンobject直渡し経路のための保護）、readRoom側の値が
// undefined になってもこちらが吸収してしまう。decode() を直接呼んで返り値の room.feature を
// 見ることで、readRoom自身の `?? null` だけを対象にした検出力のあるテストにする。
test('【失敗系・S4】旧形式バッファのFEATUREが未知の番号（11）だと decode() の返り値で feature=null になる（decode自身の ?? null を対象にする）', () => {
  const { evBytes, featureOffset } = findFeatureOffset();
  const unknownBytes = evBytes.slice();
  unknownBytes[featureOffset] = 11;

  const snapshot = decode(unknownBytes);
  const r2 = snapshot.rooms.find(r => r.id === 'f4-room');
  assert.ok(r2, 'decode結果に部屋が存在する');
  assert.equal(r2.feature, null, '未知の番号はROOM_FEATURE_DECに要素が無く、decode側の ?? null で吸収されるはず');
});

test('【失敗系】Room.feature が未知の文字列（\'zz\'）で書かれていた場合、encode→decode 後は null に正規化される（ROOM_FEATURE_ENCに無い→0）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), '未知属性');
  // setFeatureは値の妥当性を検証せずそのまま代入するため、破損データ・将来削除された属性値を模せる
  // （beamAxisOriginの前例と同じ手法）。
  room.setFeature('zz');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.ok(r2);
  assert.equal(r2.feature, null, '未知の属性文字列はnullへ落ちる（既知の属性色分岐に漏らさない）');
});

test('Opening.fixtureType/sillHeight 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({});

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, null);
  assert.equal(o2.sillHeight, null);
});

test('Opening.fixtureType: JW も往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'JW', sillHeight: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.equal(o2.fixtureType, 'JW');
  assert.equal(o2.sillHeight, 0, '0mm（掃き出し窓相当）は null と区別されて保持される');
});

// ---- 未知記号（ユーザー追加分。列挙 FIXTURE_TYPE_ENC に無い記号）----
// ステップ10g（2026-09-23）: Q5裁定によりユーザー追加記号を認めるため、FIXTURE_TYPE_STR（文字列
// フィールド、Opening末尾に追加）に生の記号を書く。旧仕様（列挙のみ）では null にフォールバック
// していたが、現仕様では記号そのものが往復する。int8側（OP.FIXTURE_TYPE）は0のまま書かれるため、
// この文字列フィールドを持たない旧ビルドで読むと未知記号はnull→カテゴリ既定記号に落ちる（片方向非互換）。
test('Opening.fixtureType: 未知の値("XX")は encode→decode で例外にならず記号そのまま往復し、他フィールドは無傷', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'XX', sillHeight: 950 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  assert.doesNotThrow(() => restoreGraph(restored, bytes));

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, 'XX', '列挙に無い記号はFIXTURE_TYPE_STRへ書かれ、復元時そのまま返る');
  assert.equal(o2.sillHeight, 950, 'fixtureTypeが未知でも他フィールドは無傷');
  assert.equal(o2.width, 1690);
  assert.equal(o2.subType, 'doubleSliding');
  assert.equal(o2.category, OpeningCategory.WINDOW);
});

// ---- 既知記号は文字列フィールドを使わない（新フィールドはユーザー追加記号専用。既存データのバイト数は増えない）----
test('Opening.fixtureType: 既知記号(AW)はFIXTURE_TYPE_STRへ書かれず、未知記号より書込みバイト数が少ない', () => {
  const known   = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  const unknown = makeGraphWithWindow({ fixtureType: 'ZZ', sillHeight: 800 });

  const knownBytes   = serializeGraph(known.graph);
  const unknownBytes = serializeGraph(unknown.graph);

  assert.ok(
    unknownBytes.length > knownBytes.length,
    '既知記号はFIXTURE_TYPE_STRを書かないため、未知記号より短い（新フィールドが既存データを肥大化させない証拠）',
  );
  assert.ok(
    unknownBytes.length < knownBytes.length + 32,
    '差分は文字列フィールド1個分程度（オフセット4B+vtable2B+文字列本体+パディング）に収まる',
  );

  const restored = makeGraph();
  restoreGraph(restored, knownBytes);
  assert.equal(restored.shapeMap.get(known.opening.id).fixtureType, 'AW');
});

test('Opening.fixtureType: 既知記号(AW)のバイト長は未設定(null)と完全一致する（既存文書は1バイトも増えない）', () => {
  const known = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  const none  = makeGraphWithWindow({ fixtureType: null, sillHeight: 800 });
  assert.equal(serializeGraph(known.graph).length, serializeGraph(none.graph).length);
});

// QA指摘Minor-1（10g・2026-09-23）: FIXTURE_TYPE_ENC は plain object なので 'constructor' 等の prototype 名を
// `=== undefined` で判定すると既知扱いになり、文字列にも int8 にも書かれず往復で null に消えていた。
test('Opening.fixtureType: prototype名の記号(constructor/toString)も他の未知記号と同じく往復する', () => {
  for (const sym of ['constructor', 'toString', '__proto__']) {
    const { graph, opening } = makeGraphWithWindow({ fixtureType: sym, sillHeight: 800 });
    const restored = makeGraph();
    restoreGraph(restored, serializeGraph(graph));
    assert.equal(restored.shapeMap.get(opening.id).fixtureType, sym, `記号 ${sym} が往復しない`);
  }
});

// ---- Opening削除→undo相当の復元（App.jsx handleMenuSelect 'opening-del' と同じ操作パターン）----
test('Opening削除→undo相当: removeShape後にaddOpening(同id, {fixtureType, sillHeight})で両フィールドが復元される', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 700 });
  const before = {
    fixtureType: opening.fixtureType, sillHeight: opening.sillHeight,
    axisCL: opening.axisCL, wallSide: opening.wallSide, isVertical: opening.isVertical,
    refCL: opening.refCL, refOffset: opening.refOffset, width: opening.width,
    category: opening.category, subType: opening.subType,
    hingeSide: opening.hingeSide, swingSide: opening.swingSide,
  };

  graph.removeShape(opening.id);
  assert.equal(graph.shapeMap.has(opening.id), false, '削除直後は存在しない');

  // App.jsx の undo（opening-del）と同一パターン: 同一IDで addOpening し直す
  const restored = graph.addOpening(
    before.axisCL, before.wallSide, before.isVertical, before.refCL, before.refOffset, before.width,
    before.category, before.subType,
    { hingeSide: before.hingeSide, swingSide: before.swingSide, fixtureType: before.fixtureType, sillHeight: before.sillHeight },
    opening.id,
  );

  assert.equal(restored.id, opening.id);
  assert.equal(restored.fixtureType, 'AW');
  assert.equal(restored.sillHeight, 700);
});

// ---- WoodBeam の梁成の手入力と表示用の値（A2-2a）の往復 ----
function makeGraphWithWoodBeam(props = {}) {
  const graph = makeGraph();
  // 自グラフ固有の線（ARCH）にする——snapshot に含まれ、restoreGraph 単体で梁の参照CLが解決できる。
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), x1 = cl(CenterLineType.VERTICAL, 3640), y0 = cl(CenterLineType.HORIZONTAL, 0);
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x300', y0, false, x0, x1, { role: 'primary', ...props });
  return { graph, beam };
}
const beamExtra = (graph) => {
  const [b] = decode(serializeGraph(graph)).beams;
  return Object.fromEntries(b.extraKeys.map((k, i) => [k, b.extraVals[i]]));
};

test('WoodBeam.woodManualDepthMm/woodAutoDepthMm/woodDepthFollowsManual: FBS encode→decode と restoreGraph で往復し、キーが extraKeys にそろう', () => {
  const { graph, beam } = makeGraphWithWoodBeam({ woodManualDepthMm: 360, woodAutoDepthMm: 240, woodDepthFollowsManual: true });
  const extra = beamExtra(graph);
  assert.equal(extra.woodManualDepthMm, '360');
  assert.equal(extra.woodAutoDepthMm, '240');
  assert.equal(extra.woodDepthFollowsManual, 'true');
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  const b2 = restored.beamMap.get(beam.id);
  assert.deepEqual([b2.woodManualDepthMm, b2.woodAutoDepthMm, b2.woodDepthFollowsManual], [360, 240, true]);
});

test('WoodBeam: 3フィールドが null（旧データ相当）ならキーを書かず、null のまま往復し、非 null よりバイト長が短い', () => {
  const { graph, beam } = makeGraphWithWoodBeam();
  const extra = beamExtra(graph);
  for (const k of ['woodManualDepthMm', 'woodAutoDepthMm', 'woodDepthFollowsManual']) assert.equal(k in extra, false, `${k} は書かない`);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  const b2 = restored.beamMap.get(beam.id);
  assert.deepEqual([b2.woodManualDepthMm, b2.woodAutoDepthMm, b2.woodDepthFollowsManual], [null, null, null]);
  const full = makeGraphWithWoodBeam({ woodManualDepthMm: 360, woodAutoDepthMm: 240, woodDepthFollowsManual: true });
  assert.ok(serializeGraph(full.graph).length > serializeGraph(graph).length);
});

test('WoodBeam: 3フィールドが null の梁を複数持つグラフは、全梁の extraKeys に3キーが1つも出ない（旧文書とバイト列が同じ形）', () => {
  const { graph, beam } = makeGraphWithWoodBeam();
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x2 = cl(CenterLineType.VERTICAL, 7280), y1 = cl(CenterLineType.HORIZONTAL, 3640);
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y1, false, beam.clStart, x2, { role: 'secondary', beamType: '小梁' });
  const beams = decode(serializeGraph(graph)).beams;
  assert.equal(beams.length, 2);
  for (const b of beams) {
    for (const k of ['woodManualDepthMm', 'woodAutoDepthMm', 'woodDepthFollowsManual']) {
      assert.equal(b.extraKeys.includes(k), false, `${k} は null なら書かない`);
    }
  }
});

test('WoodBeam: wood で始まる全インスタンスフィールドを非 null にすると、全てが extraKeys に載る（列挙漏れの突合）', () => {
  const { graph, beam } = makeGraphWithWoodBeam();
  const woodKeys = Object.keys(beam).filter(k => k.startsWith('wood'));
  assert.ok(woodKeys.length >= 3, `前提: wood* フィールドが3つ以上ある（実際:${woodKeys}）`);
  for (const k of woodKeys) beam.setField(k, 1);
  const extra = beamExtra(graph);
  for (const k of woodKeys) assert.equal(k in extra, true, `${k} が graphSnapshot の beams の packExtraFields 列挙に無い（保存・undo・階切替で消える）`);
});

// ---- Opening.height の FlatBuffers 往復（Finding 4 回帰） ----
test('Opening.height は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, 1170);
});

test('Opening.height 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  assert.equal(opening.height, null, '未指定時はnullが既定');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, null);
});

// ---- Finding 3 の決定を明文化: height=0 は不正値としてnullに正規化される ----
test('Opening.height=0 は不正値として encode→decode 後は null に正規化される（sillHeightの0(掃き出し窓)とは異なる規約）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, null, 'graphFbs.js の OP.HEIGHT は「0=未設定」規約（r.f64(OP.HEIGHT) || null）。' +
    'sillHeightの0（掃き出し窓）とは異なり、heightの0は物理的に無効な値のため常にnullへ丸められる');
});

// ---- 建具表の新規5フィールド（finish/materialGlass/frameDepth/hardware/note）のFBS往復 ----
test('建具表の新規5フィールドは FlatBuffers encode→decode で値ありのまま往復する', () => {
  const { graph, opening } = makeGraphWithWindow({
    fixtureType: 'AW', sillHeight: 800, height: 1170,
    finish: '内部塗装', materialGlass: 'アルミ', frameDepth: 105, hardware: 'クレセント錠', note: '網戸付き',
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.finish, '内部塗装');
  assert.equal(o2.materialGlass, 'アルミ');
  assert.equal(o2.frameDepth, 105);
  assert.equal(o2.hardware, 'クレセント錠');
  assert.equal(o2.note, '網戸付き');
});

test('建具表の新規5フィールドは未設定（null）なら encode→decode 後も null のまま', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170 });
  assert.equal(opening.finish, null);
  assert.equal(opening.materialGlass, null);
  assert.equal(opening.frameDepth, null);
  assert.equal(opening.hardware, null);
  assert.equal(opening.note, null);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.finish, null);
  assert.equal(o2.materialGlass, null);
  assert.equal(o2.frameDepth, null);
  assert.equal(o2.hardware, null);
  assert.equal(o2.note, null);
});

// ---- Opening.handleHeight の FlatBuffers 往復 ----
test('Opening.handleHeight は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, handleHeight: 900 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.handleHeight, 900);
});

test('Opening.handleHeight 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  assert.equal(opening.handleHeight, null, '未指定時はnullが既定');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.handleHeight, null);
});

test('Opening.handleHeight=0 は不正値として encode→decode 後は null に正規化される（heightと同じ規約）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, handleHeight: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.handleHeight, null);
});

// ---- frameDepth=0 は height と同じ規約で不正値としてnullに正規化される ----
test('Opening.frameDepth=0 は不正値として encode→decode 後は null に正規化される', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170, frameDepth: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.frameDepth, null, '0mmの見込みは物理的に無効な値のためnullへ丸められる（heightと同じ規約）');
});

// ---- 三方枠の新規2フィールド（frameFaceWidth/frameProjection・記号SSF）のFBS往復 ----
test('三方枠（記号SSF・見付/出幅）は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const { graph, opening } = makeGraphWithWindow({
    fixtureType: 'SSF', frameFaceWidth: 25, frameProjection: 15,
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, 'SSF');
  assert.equal(o2.frameFaceWidth, 25);
  assert.equal(o2.frameProjection, 15);
});

test('frameFaceWidth/frameProjection は未設定（null）なら encode→decode 後も null のまま', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW' });
  assert.equal(opening.frameFaceWidth, null);
  assert.equal(opening.frameProjection, null);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.frameFaceWidth, null);
  assert.equal(o2.frameProjection, null);
});

test('frameFaceWidth=0 は不正値として encode→decode 後は null に正規化される（frameDepthと同じ規約）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'SSF', frameFaceWidth: 0, frameProjection: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.frameFaceWidth, null);
  assert.equal(o2.frameProjection, null);
});

// ---- QA G2: 巾木を""へクリアした部屋はFlatBuffers往復後も""のまま（既定値へ化けない） ----
// graphSnapshot.js:620-622 は「新しいRoomを作ってから空でないフィールドだけ上書きする」実装
// （if (val) room.finish.setField(...)）のため、RoomFinishコンストラクタの既定値が非空だと
// ユーザーがクリアした""が復元のたびに既定値へ巻き戻ってしまう（回帰防止）。
test('【失敗系・QA G2】Room.finish.baseboardMaterial/Heightを""にクリアした部屋はFlatBuffers往復後も""のまま', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  // 一度初期値を入れてから、ユーザーがクリアした状態を再現する。
  room.finish.setField('baseboardMaterial', '木製出幅木');
  room.finish.setField('baseboardHeight', 'h=60');
  room.finish.setField('baseboardMaterial', '');
  room.finish.setField('baseboardHeight', '');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.ok(r2, '復元後に同一IDの部屋が存在する');
  assert.equal(r2.finish.baseboardMaterial, '', '空にクリアした巾木材が既定値へ化けてはいけない');
  assert.equal(r2.finish.baseboardHeight, '', '空にクリアした巾木高さが既定値へ化けてはいけない');
});

// ---- 巾木に値がある場合は従来どおり往復する（G2修正の非破壊確認） ----
test('Room.finish.baseboardMaterial/Heightに値がある場合はFlatBuffers往復で値のまま保持される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  room.finish.setField('baseboardMaterial', 'タイル巾木');
  room.finish.setField('baseboardHeight', 'h=100');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.equal(r2.finish.baseboardMaterial, 'タイル巾木');
  assert.equal(r2.finish.baseboardHeight, 'h=100');
});

// ---- 起動時復元の順序不変条件（store.js 起動IIFE の回帰防止） ----
// restoreGraph は壁の軸CL・端点CLを resolveCL（自グラフ → _structGraph の順）で解決し、
// 解決できない壁を例外もログもなく捨てる。よって「通り芯（restoreStructCLs）→ フロア
// （restoreGraph）」の順を守らないと、通り芯参照の壁が無音で失われる。

// 通り芯を structGraph に持ち、それを参照する壁をフロアグラフに持つ Project を作る。
function makeProjectWithStructWall() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階'); // _structGraph = project.structGraph が自動配線される
  const axisCL  = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const clStart = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const clEnd   = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  return { project, graph, axisCL, wall };
}

test('【失敗系】通り芯復元前に restoreGraph すると、通り芯参照の壁は例外なく無音で失われる（順序を誤った場合の挙動の固定）', () => {
  const { project, graph, wall } = makeProjectWithStructWall();
  const bytesFloor = serializeGraph(graph);
  void project; // structGraph は復元しない（順序誤りを再現）

  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');
  // project2.structGraph は空のまま（既定通り芯すら無い＝保存IDは解決不能）
  assert.doesNotThrow(() => restoreGraph(graph2, bytesFloor));
  assert.equal(graph2.shapeMap.has(wall.id), false, '軸CLを解決できない壁は復元されない');
});

test('通り芯（restoreStructCLs）→ フロア（restoreGraph）の順なら、壁が同一IDで復元され軸CLはstructGraph上のCLとオブジェクト同一', () => {
  const { project, graph, axisCL, wall } = makeProjectWithStructWall();
  const bytesFloor  = serializeGraph(graph);
  const bytesStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);

  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, bytesStruct, project2.memberGroupLedger);
  restoreGraph(graph2, bytesFloor);

  const w2 = graph2.shapeMap.get(wall.id);
  assert.ok(w2, '復元後に同一IDの壁が存在する');
  assert.equal(w2.axisCL, project2.structGraph.shapeMap.get(axisCL.id), '軸CLは復元後structGraphのCLをオブジェクトとして直接参照する');
});

test('restoreStructCLs は既存の structGraph 内容を置換し、既定通り芯を重複させない', () => {
  const project = new Project('proj', 'test');
  const src = project.structGraph;
  src.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  src.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  src.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const bytes = serializeStructCLs(src, project.structuralInfo, project.memberGroupLedger);

  // 復元先には store.js の起動時と同様の既定通り芯2本が先に入っている。
  const project2 = new Project('proj2', 'test');
  const dst = project2.structGraph;
  const defV = dst.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: true, discipline: Discipline.STRUCT });
  const defH = dst.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });

  restoreStructCLs(dst, project2.structuralInfo, bytes, project2.memberGroupLedger);

  assert.equal(dst.centerLines.length, 3, 'スナップショットの3本に置換され、既定分と重複しない');
  assert.equal(dst.shapeMap.has(defV.id), false, '既定通り芯（縦）は残らない');
  assert.equal(dst.shapeMap.has(defH.id), false, '既定通り芯（横）は残らない');
});

// ---- undo復帰時アーキ壁ドリフト修正（260929指示書）ステップ1: 再現テスト ----
// 階固有CL（子）が通り芯（親、structGraph側）へrefId+refOffsetで追従するケースの往復。
// 真因: core/centerLine.js value() は refId未解決時に _value + refOffset を返すため、
// _value が絶対座標のままの参照付きCLは「参照が解決できなくなった瞬間」に refOffset が
// 二重加算される（graphSnapshot.js buildSnapshotは cl._value を保存する）。

// 親（通り芯。project.structGraph）value=1000 に refOffset=500 で追従する子CL（階固有）を作る。
function makeGraphWithRefChild(refOffset = 500) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階');
  const parent = project.structGraph.addCenterLine(
    CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // value（作成時引数）は実際の呼び出し元（addCenterLineFromDialog）と同様、絶対座標を渡す
  // （ダイアログでユーザーが入力する座標。refOffsetは別途 value-親.value から算出される）。
  const child = graph.addCenterLine(
    CenterLineType.VERTICAL, 1000 + refOffset,
    { labeled: false, discipline: Discipline.ARCH, refId: parent.id, refOffset });
  return { project, graph, parent, child };
}

test('参照付き階固有CL（親=通り芯）は serializeGraph→restoreGraph で value・refId が不変', () => {
  const { project, graph, parent, child } = makeGraphWithRefChild();
  assert.equal(child.value, 1500, '前提: 親1000 + refOffset500 = 1500');

  const bytesStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const bytesFloor   = serializeGraph(graph);

  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, bytesStruct, project2.memberGroupLedger);
  restoreGraph(graph2, bytesFloor);

  const child2 = graph2.shapeMap.get(child.id);
  assert.ok(child2);
  assert.equal(child2.value, 1500, '親が解決できる限りvalueは変わらない');
  assert.equal(child2.refId, parent.id, '親が解決できるあいだrefIdは維持される');
});

// QA差し戻しMajor-2（260929）: 上のテストは子を_value=1500（親1000+refOffset500）のまま作るため、
// buildSnapshotをcl._value保存へ戻しても親移動が無ければ緑のまま＝検出力が無い。
// 親を後から動かし、_value（作成時の古い値）とvalue（計算値）を乖離させてから往復させる。
test('【QA差し戻しMajor-2】親(通り芯)を後から移動した参照付き子CLは、serializeGraph→restoreGraphの往復後もvalueが親移動後の座標のまま（_valueへ戻すと赤になる）', () => {
  const { project, graph, parent, child } = makeGraphWithRefChild();
  assert.equal(child.value, 1500);

  parent.value = 2000; // 親を移動（refIdで追従する子はvalueが2500になるが、_valueは1500のまま乖離する）
  assert.equal(child.value, 2500, '前提: 親移動後、子はrefOffset分ずれて2500');
  assert.notEqual(child._value, child.value, '前提: _valueは古い1500のままでvalueと乖離している');

  // 親を宙に浮かせる（指示書§1.2最下行と同じ最小実験）
  project.structGraph.shapeMap.delete(parent.id);

  const bytesFloor = serializeGraph(graph);
  restoreGraph(graph, bytesFloor);

  const child2 = graph.shapeMap.get(child.id);
  assert.ok(child2);
  assert.equal(child2.value, 2500, 'cl.value(計算値)を保存するため、親移動後の座標のまま復元される（cl._valueに戻すと1500に化けて赤）');
  assert.equal(child2.refId, null, '解決できない参照は静的化される');
});

test('親（通り芯）を _reparentChildCenterLines を経由せず直接消して宙に浮かせた後、serializeGraph→restoreGraphでもvalueは絶対座標(1500)のまま不変で、refIdは静的化される（G1・G2。HEADでは2000に化ける＝赤）', () => {
  const { project, graph, child } = makeGraphWithRefChild();
  assert.equal(child.value, 1500);

  // 指示書§1.2最下行の最小実験: _removeShape/removeCenterLine（reparent含む）を通さず直接消す
  project.structGraph.shapeMap.delete(child.refId);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let graph2;
  try {
    const bytesFloor = serializeGraph(graph);
    graph2 = graph; // 同一グラフへ復元（restoreGraphはgraph.clear()するため往復として成立する）
    restoreGraph(graph2, bytesFloor);
  } finally {
    console.warn = originalWarn;
  }

  const child2 = graph2.shapeMap.get(child.id);
  assert.ok(child2);
  assert.equal(child2.value, 1500, '宙に浮いた参照でもvalueは絶対座標1500のまま（HEADでは_value1500+refOffset500=2000に化ける）');
  assert.equal(child2.refId, null, '解決できない参照は復元時に静的化される（G2）');
  assert.equal(child2._referencedCL, null);

  const dangling = graph2.centerLines.filter(cl => cl.refId && !cl._referencedCL);
  assert.equal(dangling.length, 0, '復元後、宙に浮いたrefIdを持つCLは0件（G2）');

  assert.equal(warnings.length, 1, '静的化時にconsole.warnが1回呼ばれる');
});

test('【失敗系ではない対照】親が解決できる通常ケースの復元ではconsole.warnは呼ばれない（0回）', () => {
  const { graph } = makeGraphWithRefChild();

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    restoreGraph(graph, serializeGraph(graph));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});

test('宙に浮いたrefIdを含むCLの静的化後は、serialize→restore→serializeでバイト列が一致する（2回目と3回目が一致）', () => {
  const { project, graph, child } = makeGraphWithRefChild();
  project.structGraph.shapeMap.delete(child.refId);

  const originalWarn = console.warn;
  console.warn = () => {};
  let bytes2, bytes3;
  try {
    const bytes1 = serializeGraph(graph);
    restoreGraph(graph, bytes1); // 1回目の復元で静的化が起きる
    bytes2 = serializeGraph(graph);
    restoreGraph(graph, bytes2); // 2回目は既にrefId=nullなので静的化は起きない
    bytes3 = serializeGraph(graph);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(Array.from(bytes2), Array.from(bytes3), '静的化後の往復は冪等');
});

// ---- QA差し戻しMajor-3（260929）: extent参照（clId型・wallId型）の静的化失敗系 ----

test('【失敗系】extentLoRef/extentHiRefのclIdが復元時に解決できないと静的化され、console.warnが2回呼ばれる', () => {
  const graph = makeGraph();
  const loCL = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const hiCL = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const aux  = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, lineType: 'dashed' });
  graph.setCenterLineExtentRef(aux, 'lo', { clId: loCL.id });
  graph.setCenterLineExtentRef(aux, 'hi', { clId: hiCL.id });
  assert.equal(aux.extentLo, 0);
  assert.equal(aux.extentHi, 3000);

  // 参照先を detachFromCenterLine/teardown を経由せず直接消す（指示書§1.2最下行と同型の最小実験）
  graph.shapeMap.delete(loCL.id);
  graph.shapeMap.delete(hiCL.id);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    restoreGraph(graph, serializeGraph(graph));
  } finally {
    console.warn = originalWarn;
  }

  const aux2 = graph.shapeMap.get(aux.id);
  assert.ok(aux2);
  assert.equal(aux2.extentLoRef, null, 'lo側は静的化される');
  assert.equal(aux2.extentHiRef, null, 'hi側は静的化される');
  assert.equal(aux2._extentLoCL, null);
  assert.equal(aux2._extentHiCL, null);
  assert.equal(warnings.length, 2, 'lo・hiそれぞれで1回ずつ、計2回warnされる');
});

test('extentLoRef/extentHiRefのclIdが解決できる通常ケースでは静的化されずwarnは0回', () => {
  const graph = makeGraph();
  const loCL = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const hiCL = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const aux  = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, lineType: 'dashed' });
  graph.setCenterLineExtentRef(aux, 'lo', { clId: loCL.id });
  graph.setCenterLineExtentRef(aux, 'hi', { clId: hiCL.id });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    restoreGraph(graph, serializeGraph(graph));
  } finally {
    console.warn = originalWarn;
  }

  const aux2 = graph.shapeMap.get(aux.id);
  assert.ok(aux2);
  assert.equal(aux2.extentLoRef?.clId, loCL.id);
  assert.equal(aux2.extentHiRef?.clId, hiCL.id);
  assert.equal(warnings.length, 0);
});

// 壁の軸CLをstructGraphから欠落させ、壁自体が復元で捨てられる構成（restoreGraphの壁解決は
// 例外もログもなく捨てる仕様。§606-608コメント参照）を使ってwallId型のextentRefを検証する。
function makeProjectWithAuxRefWall() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階');
  const axisCL  = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const clStart = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const clEnd   = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const aux = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, lineType: 'dashed' });
  graph.setCenterLineExtentRef(aux, 'lo', { wallId: wall.id });
  return { project, graph, wall, aux };
}

test('【失敗系】extentLoRefのwallIdが指す壁が復元で失われると静的化され、console.warnが1回呼ばれる', () => {
  const { graph, wall, aux } = makeProjectWithAuxRefWall();
  assert.equal(typeof aux.extentLo, 'number', '前提: 壁経由でextentLoが解決できている');

  const bytesFloor = serializeGraph(graph);

  // 復元先のstructGraphは空のまま（意図的に軸CLを欠落させ、壁が復元されない状態を作る）
  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    restoreGraph(graph2, bytesFloor);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(graph2.shapeMap.has(wall.id), false, '前提: 軸CLが無いので壁は復元されない');
  const aux2 = graph2.shapeMap.get(aux.id);
  assert.ok(aux2);
  assert.equal(aux2.extentLoRef, null, '壁を失った参照は静的化される');
  assert.equal(aux2._extentLoWall, null);
  assert.equal(warnings.length, 1);
});

test('extentLoRefのwallIdが指す壁が復元でも維持されれば参照は解決されwarnは0回（対照）', () => {
  const { project, graph, wall, aux } = makeProjectWithAuxRefWall();

  const bytesStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const bytesFloor   = serializeGraph(graph);

  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, bytesStruct, project2.memberGroupLedger);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    restoreGraph(graph2, bytesFloor);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(graph2.shapeMap.has(wall.id), '前提: 軸CLが解決できるので壁は復元される');
  const aux2 = graph2.shapeMap.get(aux.id);
  assert.ok(aux2);
  assert.equal(aux2.extentLoRef?.wallId, wall.id, '壁が残れば参照は維持される');
  assert.ok(aux2._extentLoWall);
  assert.equal(warnings.length, 0);
});

// ---- Ship A: plane一覧（serializePlanes/decodePlanes）の FlatBuffers 往復 ----
test('serializePlanes → decodePlanes は plane一覧（通常階・検討階・屋根平面）を往復する', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階',   'p1', 1, 1);
  project.addPlane(3000, '2階',   'p2', 2, 1);
  project.addPlane(0,    '検討A', 'alt1', 1, 1, true, 'p1', 0);
  project.addPlane(6000, '小屋伏', 'roof1', 2, 1, false, null, 0, true, 'p2');
  project.activePlaneId = 'p2';

  const bytes = serializePlanes(project);
  const { planes, activePlaneId } = decodePlanes(bytes);

  assert.equal(activePlaneId, 'p2');
  assert.equal(planes.length, 4);

  const byId = Object.fromEntries(planes.map(p => [p.id, p]));
  assert.equal(byId.p1.elevation, 0);
  assert.equal(byId.p1.name, '1階');
  assert.equal(byId.p1.startFloor, 1);
  assert.equal(byId.p1.stories, 1);
  assert.equal(byId.p1.isAlternative, false);
  assert.equal(byId.p1.referenceId, null, '検討でない階のreferenceIdはnullのまま戻る');
  assert.equal(byId.p1.isRoofPlane, false);
  assert.equal(byId.p1.roofForPlaneId, null);

  assert.equal(byId.p2.elevation, 3000);
  assert.equal(byId.p2.startFloor, 2);

  assert.equal(byId.alt1.isAlternative, true);
  assert.equal(byId.alt1.referenceId, 'p1');
  assert.equal(byId.alt1.altIndex, 0);

  assert.equal(byId.roof1.isRoofPlane, true);
  assert.equal(byId.roof1.roofForPlaneId, 'p2');
});

test('serializePlanes → decodePlanes: activePlaneId 未設定（null）は往復後も null のまま', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.activePlaneId = null; // addPlane は初回のみ自動設定するため明示的に戻す

  const bytes = serializePlanes(project);
  const { activePlaneId } = decodePlanes(bytes);
  assert.equal(activePlaneId, null);
});

// ---- QA指摘: readPlaneの "|| 1" フォールバック（旧データ用の既定値補完）に、有効な負値・非0値が
// 巻き込まれて化けないことを確認する ----
test('serializePlanes → decodePlanes: 地下階(startFloor:-1)・stories:2・altIndex:2 は "|| 1" フォールバックに巻き込まれず往復する', () => {
  const project = new Project('proj', 'test');
  project.addPlane(-3000, 'B1階', 'b1', -1, 2); // 地下階: startFloor=-1（addSkipZeroの符号規約）, 2層分
  project.addPlane(0,     '1階',  'p1', 1, 1);
  project.addPlane(0,     '検討C', 'alt1', 1, 1, true, 'p1', 2); // 3番目の検討（altIndex:2）

  const bytes = serializePlanes(project);
  const { planes } = decodePlanes(bytes);
  const byId = Object.fromEntries(planes.map(p => [p.id, p]));

  assert.equal(byId.b1.startFloor, -1, '負のstartFloor（地下階）は readPlane の "r.f64(START_FLOOR) || 1" フォールバックで1に化けない');
  assert.equal(byId.b1.stories, 2, 'stories:2は "|| 1" フォールバックで1に化けない');
  assert.equal(byId.alt1.altIndex, 2, 'altIndex:2は0扱いされず往復する');
});

// ---- 平面の切断高（S1。Plane.planCutHeightMm）----
test('serializePlanes → decodePlanes: planCutHeightMm が階ごとに往復する（既定値の階・変更した階・検討階）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.addPlane(0, '検討A', 'alt1', 1, 1, true, 'p1', 0);
  project.planeMap.get('p2').planCutHeightMm = 1200;
  project.planeMap.get('p3').planCutHeightMm = 1234.5;
  project.planeMap.get('alt1').planCutHeightMm = 900;

  const { planes } = decodePlanes(serializePlanes(project));
  const byId = Object.fromEntries(planes.map(p => [p.id, p]));
  assert.equal(byId.p1.planCutHeightMm, 1500, '既定の階は既定値');
  assert.equal(byId.p2.planCutHeightMm, 1200);
  assert.equal(byId.p3.planCutHeightMm, 1234.5);
  assert.equal(byId.alt1.planCutHeightMm, 900);
});

test('decodePlanes: 切断高フィールドの無い旧データ（フィールド無し・0）は既定 1500 になる', () => {
  // 旧10フィールド版が書いたバイト列と同等（フィールド10が欠落＝書込みは 0 を省略する）
  const bytes = encode({
    planes: [
      { id: 'old', elevation: 0, name: '1階', startFloor: 1, stories: 1, isAlternative: false,
        referenceId: null, altIndex: 0, isRoofPlane: false, roofForPlaneId: null },
      { id: 'zero', elevation: 3000, name: '2階', startFloor: 2, stories: 1, isAlternative: false,
        referenceId: null, altIndex: 0, isRoofPlane: false, roofForPlaneId: null, planCutHeightMm: 0 },
    ],
    activePlaneId: 'old',
  });
  const { planes } = decodePlanes(bytes);
  assert.deepEqual(planes.map(p => p.planCutHeightMm), [1500, 1500]);
});

// ---- 天伏の切断高（Plane.ceilingCutHeightMm。planCutHeightMm と同型）----
test('serializePlanes → decodePlanes: ceilingCutHeightMm が階ごとに往復する（既定値の階・変更した階・検討階）。平面の切断高とは独立', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.addPlane(0, '検討A', 'alt1', 1, 1, true, 'p1', 0);
  project.planeMap.get('p2').ceilingCutHeightMm = 2200;
  project.planeMap.get('p2').planCutHeightMm = 1200;
  project.planeMap.get('p3').ceilingCutHeightMm = 2234.5;
  project.planeMap.get('alt1').ceilingCutHeightMm = 1900;

  const { planes } = decodePlanes(serializePlanes(project));
  const byId = Object.fromEntries(planes.map(p => [p.id, p]));
  assert.equal(byId.p1.ceilingCutHeightMm, 1500, '既定の階は既定値');
  assert.equal(byId.p2.ceilingCutHeightMm, 2200);
  assert.equal(byId.p2.planCutHeightMm, 1200);
  assert.equal(byId.p3.ceilingCutHeightMm, 2234.5);
  assert.equal(byId.alt1.ceilingCutHeightMm, 1900);
});

test('decodePlanes: 天伏の切断高フィールドの無い旧データ（フィールド無し・0）は既定 1500 になる。平面の切断高は保つ', () => {
  const bytes = encode({
    planes: [
      { id: 'old', elevation: 0, name: '1階', startFloor: 1, stories: 1, isAlternative: false,
        referenceId: null, altIndex: 0, isRoofPlane: false, roofForPlaneId: null, planCutHeightMm: 1100 },
      { id: 'zero', elevation: 3000, name: '2階', startFloor: 2, stories: 1, isAlternative: false,
        referenceId: null, altIndex: 0, isRoofPlane: false, roofForPlaneId: null, planCutHeightMm: 1200, ceilingCutHeightMm: 0 },
    ],
    activePlaneId: 'old',
  });
  const { planes } = decodePlanes(bytes);
  assert.deepEqual(planes.map(p => p.ceilingCutHeightMm), [1500, 1500]);
  assert.deepEqual(planes.map(p => p.planCutHeightMm), [1100, 1200]);
});

// ---- 失敗パス: decodePlanesへの不正バイト列 ----
test('decodePlanes: 不正なバイト列（他データの断片）を渡しても例外を投げず、planes:[]・activePlaneId:nullへグレースフルにフォールバックする', () => {
  // graphFbs.js の手書きreaderはフィールド不在時にデフォルト値（空vec/空str）を返す設計のため、
  // 構造化されていないバイト列でも例外にはならない（GS.PLANES/GS.ACTIVE_PLANE_IDが読めない
  // ＝存在しないフィールド扱いになるだけ）。この挙動はdecode()共通で、planes専用の防御コードは無い。
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotThrow(() => decodePlanes(garbage));
  const { planes, activePlaneId } = decodePlanes(garbage);
  assert.deepEqual(planes, []);
  assert.equal(activePlaneId, null);
});

// ---- decodeFloorSnapshot（保存時の使用エントリ収集専用。restoreGraphの「実グラフへ適用する」
// 部分を持たない薄い再公開。catalog/usedEntries.js から使う）----
test('decodeFloorSnapshot: decode()結果にrestoreGraphと同じ材コード正規化（applyDocumentCodeNormalization）を通す', () => {
  const graph = makeGraph();
  graph.exteriorWallBacking = '111111111150'; // 旧体系（振り直し前）のコード
  const bytes = serializeGraph(graph);

  const snapshot = decodeFloorSnapshot(bytes);
  assert.notEqual(snapshot.exteriorWallBacking, '111111111150', '本体の振り直し表で正規化されている');

  const restored = makeGraph();
  restoreGraph(restored, bytes);
  assert.equal(snapshot.exteriorWallBacking, restored.exteriorWallBacking, 'restoreGraphが実グラフへ適用する値と同一');
});

test('decodeFloorSnapshot: PlanGraphへ適用しない（呼び出しに graph 引数を取らない）——バイト列を渡すだけで完結する', () => {
  const graph = makeGraph();
  const bytes = serializeGraph(graph);
  assert.doesNotThrow(() => decodeFloorSnapshot(bytes));
});

// ---- 敷地（project.site）の FlatBuffers 往復（serializeSite/decodeSite/restoreSite）----

test('serializeSite → restoreSite: 底辺+三角形1個の往復（id・座標・lineKind・redPointIdまで一致、実体同一性も保つ）', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  // redPointId をあえて startPointId と異なる endPoint 側に設定（RED_PT の書き込みミス検出用）
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY, undefined, ep.id);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  const apexPt   = site.addPoint(640, 480);
  const tri       = site.addTriangle(baseLine, apexPt, SiteLineKind.BOUNDARY);
  const redLine   = site.addLine(sp, apexPt, SiteLineKind.BOUNDARY, undefined, sp.id);
  const blueLine  = site.addLine(ep, apexPt, SiteLineKind.ROAD,     undefined, ep.id);
  site.history.push({
    type: 'triangle', baseLineId: baseLine.id,
    redLineId: redLine.id, redLen: 800, redKind: SiteLineKind.BOUNDARY,
    blueLineId: blueLine.id, blueLen: 600, blueKind: SiteLineKind.ROAD,
    triangleId: tri.id, triangleLineKind: SiteLineKind.BOUNDARY, side: 1,
  });

  const bytes = serializeSite(site);
  const data  = decodeSite(bytes);
  const restored = new Site();
  restoreSite(restored, data);

  assert.equal(restored.points.length, 3);
  assert.equal(restored.lines.length, 3);
  assert.equal(restored.triangles.length, 1);
  assert.equal(restored.lineOrder.length, 3);
  assert.equal(restored.history.length, 2);

  const rBase = restored.lineMap.get(baseLine.id);
  assert.ok(rBase);
  assert.equal(rBase.lineKind, SiteLineKind.SURVEY);
  assert.equal(rBase.redPointId, ep.id, 'redPointId(endPoint側)がstartPointIdへ化けずに保持される');
  assert.equal(rBase.startPoint, restored.pointMap.get(sp.id), '実体同一性: startPointは復元後pointMapの同一オブジェクト');
  assert.equal(rBase.endPoint,   restored.pointMap.get(ep.id));

  const rTri = restored.triangleMap.get(tri.id);
  assert.ok(rTri);
  assert.equal(rTri.apexPoint.x, 640);
  assert.equal(rTri.apexPoint.y, 480);
  assert.equal(rTri.lineKind, SiteLineKind.BOUNDARY);
  assert.equal(rTri.baseLine, restored.lineMap.get(baseLine.id), '実体同一性: baseLineは復元後lineMapの同一オブジェクト');

  assert.deepEqual([...restored.lineOrder], [baseLine.id, redLine.id, blueLine.id]);

  assert.equal(restored.history[0].type, 'base');
  assert.equal(restored.history[0].lineId, baseLine.id);
  assert.equal(restored.history[0].length, 1000);
  assert.equal(restored.history[1].type, 'triangle');
  assert.equal(restored.history[1].redLineId, redLine.id);
  assert.equal(restored.history[1].redLen, 800);
  assert.equal(restored.history[1].blueLineId, blueLine.id);
  assert.equal(restored.history[1].side, 1);
});

test('serializeSite → restoreSite: 復元後に editSiteLineLength(本番経路) が編集を継続できる', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  const bytes = serializeSite(site);
  const restored = new Site();
  restoreSite(restored, decodeSite(bytes));

  const rLine = restored.lines[0];
  const result = editSiteLineLength(restored, rLine.id, 2000);

  assert.equal(result.ok, true, '復元データでも辺長編集が本番経路（editSiteLineLength）で継続できる');
  assert.equal(rLine.endPoint.x, 2000);
  assert.equal(restored.history[0].length, 2000);
});

test('serializeSite → restoreSite: side=-1の三角形往復でapex座標とhistory.sideの符号が保持される', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  const apexPt  = site.addPoint(500, -400); // 底辺の反対側（負のside相当）
  const tri      = site.addTriangle(baseLine, apexPt, SiteLineKind.SURVEY);
  const redLine  = site.addLine(sp, apexPt, SiteLineKind.SURVEY, undefined, sp.id);
  const blueLine = site.addLine(ep, apexPt, SiteLineKind.SURVEY, undefined, ep.id);
  site.history.push({
    type: 'triangle', baseLineId: baseLine.id,
    redLineId: redLine.id, redLen: redLine.length, redKind: SiteLineKind.SURVEY,
    blueLineId: blueLine.id, blueLen: blueLine.length, blueKind: SiteLineKind.SURVEY,
    triangleId: tri.id, triangleLineKind: SiteLineKind.SURVEY, side: -1,
  });

  const bytes = serializeSite(site);
  const restored = new Site();
  restoreSite(restored, decodeSite(bytes));

  const rTri = restored.triangleMap.get(tri.id);
  assert.equal(rTri.apexPoint.x, 500, 'apex座標のxが復元前と一致');
  assert.equal(rTri.apexPoint.y, -400, 'apex座標のyが復元前と一致');
  assert.equal(restored.history[1].side, -1, '負のsideが符号を保ったまま復元される');
});

test('serializeSite → restoreSite: SiteLineKind全種が往復する（Object.values参照のため種別追加時に自動で対象拡大する）', () => {
  const site = new Site();
  const kinds = Object.values(SiteLineKind);
  const lineIds = kinds.map((kind, i) => {
    const sp = site.addPoint(i * 1000, 0);
    const ep = site.addPoint(i * 1000 + 500, 0);
    return site.addLine(sp, ep, kind).id;
  });

  const bytes = serializeSite(site);
  const restored = new Site();
  restoreSite(restored, decodeSite(bytes));

  kinds.forEach((kind, i) => {
    assert.equal(restored.lineMap.get(lineIds[i]).lineKind, kind);
  });
});

test('serializeSite → restoreSite: 空siteの往復は例外なく全コレクションが空のまま', () => {
  const site = new Site();
  const bytes = serializeSite(site);
  const restored = new Site();

  assert.doesNotThrow(() => restoreSite(restored, decodeSite(bytes)));
  assert.equal(restored.points.length, 0);
  assert.equal(restored.lines.length, 0);
  assert.equal(restored.triangles.length, 0);
  assert.equal(restored.lineOrder.length, 0);
  assert.equal(restored.history.length, 0);
});

// ---- 失敗系: 参照解決できない敷地線分 ----
test('【失敗系】serializeSite → restoreSite: 参照解決できない線分（存在しないpointIdを指す）は黙って捨てられ他は無傷', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const goodLine = site.addLine(sp, ep, SiteLineKind.SURVEY);

  const bytes = serializeSite(site);
  const data  = decodeSite(bytes);
  // 参照解決できない線分をデータ破損として混入（存在しないpointIdを指す）
  data.lines.push({ id: 'bad-line', startPointId: 'missing-1', endPointId: 'missing-2', lineKind: 'survey', redPointId: 'missing-1' });
  data.lineOrder.push('bad-line');

  const restored = new Site();
  assert.doesNotThrow(() => restoreSite(restored, data));

  assert.equal(restored.lines.length, 1, '解決できない線分は捨てられ、既存の線分だけが残る');
  assert.ok(restored.lineMap.get(goodLine.id), '既存の線分は無傷');
  assert.equal(restored.lineMap.has('bad-line'), false);
  assert.deepEqual([...restored.lineOrder], [goodLine.id], 'lineOrderからも黙って除外される');
});

// ---- 失敗系: lineOrderに載っていない線分（破損データ）は無音でorderedLinesから消える ----
// 注意: data.lineOrder が全体として空（length===0）の場合は restoreSite が
// 「復元値なし＝addLineが自然に積んだ順序を維持」と解釈するため対象外（他の正常系テストで
// カバー済み）。ここでは lineOrder が非空のまま、特定の1本だけが欠落したケースを再現する。
test('【失敗系】serializeSite → restoreSite: lineOrderに載っていない線分はlineMapに残るがorderedLinesに現れない', () => {
  const site = new Site();
  const sp1 = site.addPoint(0, 0);
  const ep1 = site.addPoint(1000, 0);
  const line1 = site.addLine(sp1, ep1, SiteLineKind.SURVEY);
  const sp2 = site.addPoint(0, 1000);
  const ep2 = site.addPoint(1000, 1000);
  const line2 = site.addLine(sp2, ep2, SiteLineKind.SURVEY);

  const bytes = serializeSite(site);
  const data  = decodeSite(bytes);
  // lineOrderから line1 だけを意図的に落とす（データ破損の再現。lines/points側は健全なまま、
  // lineOrder自体は非空を維持=line2は残す）
  data.lineOrder = data.lineOrder.filter(id => id !== line1.id);
  assert.deepEqual(data.lineOrder, [line2.id], '前提: lineOrderはline2だけを含む（空にはしない）');

  const restored = new Site();
  restoreSite(restored, data);

  assert.ok(restored.lineMap.get(line1.id), 'lineMapには残る（実体は失われない）');
  const orderedIds = restored.orderedLines.map(l => l.id);
  assert.equal(orderedIds.includes(line1.id), false, 'lineOrderに無いため三斜タブ表示用のorderedLinesには現れない（現状挙動の固定。末尾補完はしない）');
  assert.deepEqual(orderedIds, [line2.id], 'lineOrderに残った線分だけがorderedLinesに現れる');
});

// ---- 失敗パス: decodeSiteへの不正バイト列 ----
test('decodeSite: 不正なバイト列（他データの断片）を渡しても例外を投げずnullへフォールバックする', () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotThrow(() => decodeSite(garbage));
  assert.equal(decodeSite(garbage), null, 'GS.SITEフィールドが読めない＝不在扱いでnull');
});

// ==================================================================
// 旧データ互換: 仕上げ面の向きが未指定のまま逆向きに保存された仕上げ薄壁の正規化
// （normalizeLegacyFinishSide。finish/stair/stairUnderWalls.js ルール6の階段側薄壁）。
// 材の帯は変えず、面線と内側線の**役割**だけを正しい向きへ入れ替える。
// ==================================================================
function makeThinWall(axisOffset, props) {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.VERTICAL,   -1500, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.HORIZONTAL, -6000, { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.HORIZONTAL, -3500, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, axisOffset, true, clStart, 0, clEnd, 0,
    { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 0, ...props });
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  return restored.shapeMap.get(wall.id);
}

test('復元: 向き未指定で逆向きに保存された階段側仕上げ薄壁は、帯を変えずに向きだけ正規化される', () => {
  // 旧実装が生成した形: axisOffset=-(50+12.5)、finishSide なし → faceDir=-1（面が帯の遠い側）
  const w = makeThinWall(-62.5, {});

  assert.deepEqual(w.materialRange, { lo: -1562.5, hi: -1550 }, '材の帯は変わらないはず');
  assert.equal(w.faceDir, 1, '仕上げ面は階段側（軸CL寄り）を向くはず');
  assert.equal(w.axisValue, -1550, '面は帯の軸CL寄りの端');
  assert.equal(w.axisValue - w.faceDir * w.wallFinish, -1562.5, '内側線は帯の反対の端');
});

test('【失敗系】復元: finishSide を持つ壁・ルール2の薄壁・下地を持つ壁は正規化の対象外', () => {
  // finishSide 明示済み（通常の壁生成 resolveBackingOwnership・CL偏芯・修正後の生成）
  const explicit = makeThinWall(-62.5, { finishSide: -1 });
  assert.equal(explicit.axisOffset, -62.5);
  assert.equal(explicit.faceDir, -1);

  // ルール2の薄壁（|axisOffset|===wallFinish）は元から正しい向き
  const rule2 = makeThinWall(-12.5, {});
  assert.equal(rule2.axisOffset, -12.5);
  assert.equal(rule2.faceDir, -1);

  // 下地を持つ壁（backingDepth>0）は対象外
  const owner = makeThinWall(-102.5, { backingOffset: -45, backingDepth: 90 });
  assert.equal(owner.axisOffset, -102.5);
  assert.equal(owner.faceDir, -1);
});

// ---- 屋外部屋の仕上げレベル（exteriorSlope/exteriorLevelRef/exteriorLevel）----
test('Room.exteriorSlope/exteriorLevelRef/exteriorLevel は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), '屋外');
  room.setKind(RoomKind.EXTERIOR);
  room.setExteriorSlope(50);
  room.setExteriorLevelRef(ExteriorLevelRef.GL);
  room.setExteriorLevel(150);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.ok(r2, '復元後に同一IDの部屋が存在する');
  assert.equal(r2.exteriorSlope, 50);
  assert.equal(r2.exteriorLevelRef, ExteriorLevelRef.GL);
  assert.equal(r2.exteriorLevel, 150);
});

test('Room.exteriorSlope/exteriorLevelRef/exteriorLevel 未設定（旧データ相当）は encode→decode 後も null/"room" のまま（既定値に化けない）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), '屋外');
  room.setKind(RoomKind.EXTERIOR);
  // exteriorSlope/exteriorLevelRef/exteriorLevel は未設定のまま（旧データのフィールド欠落と同値の状態）

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.equal(r2.exteriorSlope, null);
  assert.equal(r2.exteriorLevelRef, ExteriorLevelRef.ROOM);
  assert.equal(r2.exteriorLevel, null);
});

// ---- 壁の鮮度キー（graph.wallFreshnessKey。finish/wallFreshnessKey.js）の FlatBuffers 往復 ----
test('graph.wallFreshnessKey は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const graph = makeGraph();
  graph.setWallFreshnessKey('v1|ext=CODE-A|int=CODE-B|str=木造（在来）|col=WOOD-120x120|rooms=');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.wallFreshnessKey, 'v1|ext=CODE-A|int=CODE-B|str=木造（在来）|col=WOOD-120x120|rooms=');
});

test('graph.wallFreshnessKey 未設定（null。旧データ相当）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const graph = makeGraph();
  // wallFreshnessKey は未設定のまま（旧データのフィールド欠落と同値の状態）

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.wallFreshnessKey, null);
});

// ---- QA F(Missing tests): PlanGraph.clear() が wallFreshnessKey をリセットすることの固定 ----
// restoreGraph は applySnapshot 内で graph.clear() を先に呼んでから復元する（graphSnapshot.js:538）。
// clear() が wallFreshnessKey をリセットしなければ、鍵なしスナップショット（旧データ・鍵未計算の階）を
// 「既に鍵を持つ graph」へ restore したときに古い鍵が残留し、次の境界処理が「鮮度あり」と誤判定する。
test('PlanGraph.clear(): wallFreshnessKey が非nullの状態から呼ぶと null に戻る', () => {
  const graph = makeGraph();
  graph.setWallFreshnessKey('v1|ext=X|int=Y|str=|col=|rooms=');
  graph.clear();
  assert.equal(graph.wallFreshnessKey, null);
});

// ---- QA F3/T3: PlanGraph.clear() が shaftWallMaterial／shaftSoundproof を既定へ戻すことの固定 ----
test('PlanGraph.clear()【QA T3】: shaftWallMaterial／shaftSoundproofが非既定の状態から呼ぶと既定値に戻る', () => {
  const graph = makeGraph();
  graph.setShaftWallMaterial('301000000020');
  graph.setShaftSoundproof(ShaftSoundproof.INSULATION);
  graph.clear();
  assert.equal(graph.shaftWallMaterial, DEFAULT_SHAFT_WALL_MATERIAL);
  assert.equal(graph.shaftSoundproof, DEFAULT_SHAFT_SOUNDPROOF);
});

test('restoreGraph: wallFreshnessKey が非nullのgraphへ、鍵を持たないスナップショットをrestoreすると（clear()経由で）nullへ戻る（古い鍵の残留防止）', () => {
  const stale = makeGraph();
  stale.setWallFreshnessKey('v1|ext=STALE|int=STALE|str=|col=|rooms=');

  const source = makeGraph(); // wallFreshnessKey未設定のまま
  const bytes = serializeGraph(source);
  restoreGraph(stale, bytes);

  assert.equal(stale.wallFreshnessKey, null);
});

// ---- 在来木造の各階柱寸法（graph.woodColumnWidthMm。ステップ4 C-2a）の FlatBuffers 往復 ----
test('graph.woodColumnWidthMm 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const graph = makeGraph();

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.woodColumnWidthMm, null);
});

test('graph.woodColumnWidthMm は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const graph = makeGraph();
  graph.setWoodColumnWidthMm(105);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.woodColumnWidthMm, 105);
});

test('【失敗系】graph.woodColumnWidthMm に 0 を設定すると encode→decode 後は null になる（OP.HEIGHTと同じ0=未指定の規約）', () => {
  const graph = makeGraph();
  graph.setWoodColumnWidthMm(0);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.woodColumnWidthMm, null);
});

// ---- 昇降路（isShaftFeature）の壁材・防音材（graph.shaftWallMaterial / shaftSoundproof）の
// FlatBuffers 往復（ステップ2a・2026-09-28） ----
test('graph.shaftWallMaterial は FlatBuffers encode→decode で値ありのまま往復する', () => {
  const graph = makeGraph();
  graph.setShaftWallMaterial('301000000020');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.shaftWallMaterial, '301000000020');
});

// QA F3: restore先が最初から既定値（makeGraph()直後）だと、restoreGraphが実際に何もしなくても
// 「既定値のまま」に見えてしまい恒真になる。restore先を先に非既定値へ設定してから、
// shaft未設定のグラフ（FBSエンコード＝旧データ相当。フィールド省略）をrestoreし、
// 既定値へ戻ることを確認する（clear()→フィールド欠落で既定に戻る、を実際に検証する）。
test('graph.shaftWallMaterial 未設定相当（旧データ。フィールド欠落）は encode→decode 後も既定値（PB12.5）のまま（restore先を非既定値にしてから確認）', () => {
  const source = makeGraph();
  source.shaftWallMaterial = null; // setterを経由せず直接null化（真に「フィールド欠落」の値をFBSへ流す。
  // setterだと既定値'301000000002'という truthy な文字列が書き込まれ、decode側の`|| null`
  // フォールバックを一切通らない＝旧データ相当を再現できないため）

  const bytes = serializeGraph(source);
  const restored = makeGraph();
  restored.setShaftWallMaterial('301000000020'); // 非既定値に設定してから復元する
  restoreGraph(restored, bytes);

  assert.equal(restored.shaftWallMaterial, DEFAULT_SHAFT_WALL_MATERIAL);
});

// plain object 直渡し経路（旧JSON文書ファイル読込み）でも同様に、restore先を非既定値にしてから
// キー自体が無いsnapshotを渡し、恒真にならない形で既定値維持を固定する。
test('【QA F3】graph.shaftWallMaterial 未設定相当（plain object直渡し。キー自体が無い旧JSON相当）は restore後も既定値（PB12.5）のまま', () => {
  const snapshot = {
    centerLines: [], points: [], walls: [], diagonals: [],
    verticalLines: [], horizontalLines: [], arcs: [], circles: [],
    rooms: [], roomOrder: [],
  }; // shaftWallMaterialキー自体が無い旧データ相当

  const restored = makeGraph();
  restored.setShaftWallMaterial('301000000020'); // 非既定値に設定してから復元する
  restoreGraph(restored, snapshot);

  assert.equal(restored.shaftWallMaterial, DEFAULT_SHAFT_WALL_MATERIAL);
});

test('graph.shaftSoundproof は FlatBuffers encode→decode で insulation のまま往復する', () => {
  const graph = makeGraph();
  graph.setShaftSoundproof(ShaftSoundproof.INSULATION);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  assert.equal(restored.shaftSoundproof, ShaftSoundproof.INSULATION);
});

// QA F3: 同様に restore先を非既定値にしてから、shaft未設定のグラフ（FBSエンコード）をrestoreする。
test('graph.shaftSoundproof 未設定相当（旧データ。フィールド欠落）は encode→decode 後も既定値（none）のまま（restore先を非既定値にしてから確認）', () => {
  const source = makeGraph(); // shaftSoundproof未設定のまま（既定=none）

  const bytes = serializeGraph(source);
  const restored = makeGraph();
  restored.setShaftSoundproof(ShaftSoundproof.INSULATION); // 非既定値に設定してから復元する
  restoreGraph(restored, bytes);

  assert.equal(restored.shaftSoundproof, DEFAULT_SHAFT_SOUNDPROOF);
});

test('【QA F3】graph.shaftSoundproof 未設定相当（plain object直渡し。キー自体が無い旧JSON相当）は restore後も既定値（none）のまま', () => {
  const snapshot = {
    centerLines: [], points: [], walls: [], diagonals: [],
    verticalLines: [], horizontalLines: [], arcs: [], circles: [],
    rooms: [], roomOrder: [],
  }; // shaftSoundproofキー自体が無い旧データ相当

  const restored = makeGraph();
  restored.setShaftSoundproof(ShaftSoundproof.INSULATION); // 非既定値に設定してから復元する
  restoreGraph(restored, snapshot);

  assert.equal(restored.shaftSoundproof, DEFAULT_SHAFT_SOUNDPROOF);
});

// ---- 梁が参照する下階柱寸の派生値（graph.beamColumnWidthMm。実機裁定ステップ4 C-2 QA4）は
// 非永続——structuralRecompute.js/structuralOrchestration.js が再計算のたびに書く一時キャッシュで、
// FlatBuffers（schema/graphFbs.js）にもgraphSnapshot.jsのper-floorフィールドにも含めない。
// restoreGraphは内部でgraph.clear()を呼ぶため、encode元の値が何であってもdecode先は常にnullへ戻る
// （standardBeamSectionForが読むresolvedBeamColumnWidthMmは、未再計算=nullの間は自階のwoodColumnWidthMmで
// 暫定し、次の再計算で補正される設計——.claude/structural-model.md C-2節参照）。----
test('graph.beamColumnWidthMm は非永続——encode→decode（restoreGraph）で復元されず常にnullへ戻る', () => {
  const graph = makeGraph();
  graph.setBeamColumnWidthMm(105); // 直前の再計算で書かれた値（encode元）

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restored.setBeamColumnWidthMm(999); // decode先に既に別の値が入っていても（restoreGraphのclear()で消える想定）

  restoreGraph(restored, bytes);

  assert.equal(restored.beamColumnWidthMm, null,
    'beamColumnWidthMmがFlatBuffers往復で復元されている（非永続フィールドのはずが永続化されてしまっている）');
});

// ----------------------------------------------------------------
// ステップ6-3 着手前の確認（最初に確かめる仮定）: 同一の生きたグラフに対する
// restoreGraph(graph, serializeGraph(graph)) が安全か（id・部屋/辺/CL偏芯・観測者が壊れないか）。
// カタログの指示UI適用（materialコードの読み替え確定後、アクティブ階を往復させて新コードを
// 反映する）で使う想定の呼び出し形そのもの。
//
// 結論（VERIFIED・このテストで確認）: 安全。serializeGraph(graph) は encode() で完全に独立した
// バイト列を返すため、その後の restoreGraph(graph, bytes) は「別文書をこのgraphへ読み込む」の
// と同じ経路（applySnapshot が graph.clear() してから再構築する）。id・値は保持される
// （既存の往復テスト群と同じ保証）。ただし graph.clear() は shapeMap/roomMap の**実体**を
// 作り直すため、復元前に取得した Room/Wall 等のオブジェクト参照は復元後は「別オブジェクト」
// になる（id は同じでも === では一致しない）——この関数を「今生きているgraph」に対して呼ぶ
// 呼び出し側は、復元後は必ず graph.roomMap.get(id) 等で**引き直す**こと（直接保持した参照を
// 使い続けない）。これは既存の undo/redo（centerLineOps.js等）が同じ restoreGraph(graph, bytes)
// パターンを使う際に既に前提としている制約と同じ（.claude/undo-redo.md「フロア切替は
// 同一graphオブジェクトへ復元される」）。
// ----------------------------------------------------------------
test('【仮定確認・ステップ6-3着手前】restoreGraph(graph, serializeGraph(graph))は同一の生きたグラフに対して安全: id・部屋のcustomOverrides・CL偏芯backingは保持される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  room.setOverride('wallMaterial', '301000000001');
  graph.setCLEccentricity(y0.id, { mode: 'value', value: 0, side: 1, backing: '101400000007' });
  const roomIdBefore = room.id;
  const roomRefBefore = room; // 復元後にこの参照が生きたグラフの一部で「無くなる」ことを確認する

  // カタログ解決の反映と同じ呼び出し形: 同一グラフを自分自身のバイト列で復元する。
  restoreGraph(graph, serializeGraph(graph));

  // id・値は保持される
  assert.ok(graph.roomMap.has(roomIdBefore), '同一IDの部屋が復元後も存在する');
  const roomAfter = graph.roomMap.get(roomIdBefore);
  assert.equal(roomAfter.customOverrides.get('wallMaterial'), '301000000001');
  assert.equal(graph.clEccentricities.get(y0.id)?.backing, '101400000007');

  // 観測者への影響: clear()で実体が作り直されるため、復元前に握っていたオブジェクト参照は
  // 復元後のgraphの一部ではなくなる（=== では別物）。呼び出し側はidで引き直す必要がある。
  assert.notEqual(roomAfter, roomRefBefore, '復元後のRoomは新しいオブジェクト（clear()で作り直される）');
  assert.equal(graph.roomMap.size, 1, '部屋は重複せず1件のまま');
});

// S3: 天井材・天井仕上げ（customOverrides.ceilingPanel / ceilingFinish）は FBS の汎用 override として往復し、
// 旧の自由文字列 finish.ceilingMaterial も不変（データとして残す）。既定は読み時補完なので保存データには出ない。
test('【S3】serializeGraph→restoreGraph: ceilingPanel／ceilingFinish の override と旧 finish.ceilingMaterial の文字列が往復で不変。未指定の部屋には override が増えない', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   8000, { labeled: false, discipline: Discipline.ARCH });
  const withOv = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  const plain = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), '寝室');
  withOv.setOverride('ceilingPanel', '301000000002');
  withOv.setOverride('ceilingFinish', '302000000001');
  withOv.finish.setField('ceilingMaterial', 'PB t=9.5 + VC');

  restoreGraph(graph, serializeGraph(graph));

  const a = graph.roomMap.get(withOv.id);
  assert.equal(a.customOverrides.get('ceilingPanel'), '301000000002');
  assert.equal(a.customOverrides.get('ceilingFinish'), '302000000001');
  assert.equal(a.getFinishInfo().ceilingPanel, '301000000002');
  assert.equal(a.finish.ceilingMaterial, 'PB t=9.5 + VC');
  const b = graph.roomMap.get(plain.id);
  assert.equal(b.customOverrides.has('ceilingPanel'), false);
  assert.equal(b.customOverrides.has('ceilingFinish'), false);
  assert.equal(b.getFinishInfo().ceilingPanel, '301000000001'); // 旧文書でも既定が出る
  assert.equal(b.getFinishInfo().ceilingFinish, '302000000001');
});

// QA指摘Minor-3（2026-09-22）: 上記の仮定確認に、構造参照（structGraph由来）のaxisCLを持つ壁と
// Edge.overridesを含むグラフの自己往復を1本追加する——restoreGraphは自グラフをclear()するが
// graph._structGraph（project.structGraph）はclear()しないため、通り芯参照の壁も無音消失せず
// 復元されるはず（順序不変条件テスト「通り芯→フロアの順」と同じ解決経路。ただしこちらは
// structGraphを再構築しない自己往復のケース）。
test('【仮定確認・ステップ6-3・QA指摘Minor-3】restoreGraph(graph, serializeGraph(graph))は構造参照(structGraph由来)のaxisCLを持つ壁・Edge.overridesも保ったまま安全に往復する', () => {
  const { graph, wall } = makeProjectWithStructWall();
  const wallCountBefore = graph.walls.length;
  const edge = graph.addEdge('e1');
  edge.setOverride('wallFinish', '301000000002');

  restoreGraph(graph, serializeGraph(graph));

  assert.equal(graph.walls.length, wallCountBefore, '壁本数が保たれる（構造参照CLを解決できず無音消失していない）');
  const w2 = graph.shapeMap.get(wall.id);
  assert.ok(w2, '壁が同一IDで復元される');
  assert.equal(w2.isExteriorWall, true, '壁のプロパティも保たれる');
  const e2 = graph.getEdge('e1');
  assert.ok(e2, 'エッジが復元される');
  assert.equal(e2.overrides.get('wallFinish'), '301000000002', 'Edge.overridesが保たれる');
});

// ----------------------------------------------------------------
// 材コードの正規化（4.6・R7・ステップ3b）: restoreGraph は3経路
// （FlatBuffersバイト列・旧JSON文字列・plain object）のどこから来た snapshot でも
// applyDocumentCodeNormalization を1回通す。対象4箇所（*_BACKING・rooms[].overrides・
// edges[].overrides・clEccentricities[].backing）が旧コードから新コードへ変わることを確認する。
// ----------------------------------------------------------------
test('restoreGraph: 旧材コードは3経路（FlatBuffersバイト列・旧JSON文字列・plain object）すべてで新コードに正規化される', () => {
  const graph = makeGraph();
  graph.setExteriorWallBacking('111111111150'); // → 201200000017（振れ止め-25×10）
  graph.setInteriorWallBacking('111111111160'); // → 101400000010（□-45×30）
  graph.setCeilingBacking('111111111170');      // → 301000000006（強化せっこうボード t=15）
  graph.setFloorBacking('111111111180');        // → 101200000008（構造用合板 t=12）

  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const roomKey = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([roomKey]), '部屋A');
  room.setOverride('wallMaterial', '111111111165'); // → 301000000001（せっこうボード t=9.5）

  const edge = graph.addEdge('e1');
  edge.setOverride('wallFinish', '111111111166'); // → 301000000002（せっこうボード t=12.5）

  graph.setCLEccentricity(y0.id, { mode: 'value', value: 0, side: 1, backing: '111111111157' }); // → 101400000007（□-60×45）

  const bytes = serializeGraph(graph);
  const snapshotObj = decode(bytes); // plain object 経路・JSON文字列経路の元ネタ（デコード済みの完全なsnapshot形）
  const jsonStr = JSON.stringify(snapshotObj);

  const paths = [
    ['FlatBuffersバイト列', bytes],
    ['旧JSON文字列', jsonStr],
    ['plain object', snapshotObj],
  ];
  for (const [label, data] of paths) {
    const restored = makeGraph();
    restoreGraph(restored, data);

    assert.equal(restored.exteriorWallBacking, '201200000017', `${label}: exteriorWallBacking`);
    assert.equal(restored.interiorWallBacking, '101400000010', `${label}: interiorWallBacking`);
    assert.equal(restored.ceilingBacking,      '301000000006', `${label}: ceilingBacking`);
    assert.equal(restored.floorBacking,        '101200000008', `${label}: floorBacking`);

    const r2 = restored.roomMap.get(room.id);
    assert.ok(r2, `${label}: 部屋が復元されている`);
    assert.equal(r2.customOverrides.get('wallMaterial'), '301000000001', `${label}: rooms[].overrides`);

    const e2 = restored.getEdge('e1');
    assert.ok(e2, `${label}: エッジが復元されている`);
    assert.equal(e2.overrides.get('wallFinish'), '301000000002', `${label}: edges[].overrides`);

    assert.equal(restored.clEccentricities.get(y0.id)?.backing, '101400000007', `${label}: clEccentricities[].backing`);
  }
});

// ---- 昇降機器具行（equipmentRows。昇降機の仕様追加 ステップ3 S1）----

test('graph.equipmentRows は FlatBuffers encode→decode で全フィールドが往復する（同一idで復元）', () => {
  const graph = makeGraph();
  graph.addEquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: EvUsage.PASSENGER_FREIGHT, no: 2,
    cellKeys: new Set(['a:b:c:d', 'e:f:g:h']), roomId: 'room1',
  });
  const before = graph.equipmentRows.map(r => r.toData());

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const after = restored.equipmentRows.map(r => r.toData());
  assert.deepEqual(after, before);
});

test('graph.equipmentRows は restoreGraph への plain object 直渡し（旧JSON文書ファイル読込みと同じ経路）でも往復する', () => {
  const graph = makeGraph();
  graph.addEquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: DEFAULT_EV_USAGE, no: 1,
    cellKeys: new Set(['a:b:c:d']), roomId: null,
  });
  const before = graph.equipmentRows.map(r => r.toData());

  const json = JSON.parse(JSON.stringify({ equipmentRows: before }));
  const restored = makeGraph();
  restoreGraph(restored, {
    centerLines: [], points: [], walls: [], diagonals: [],
    verticalLines: [], horizontalLines: [], arcs: [], circles: [],
    rooms: [], roomOrder: [],
    ...json,
  });

  assert.deepEqual(restored.equipmentRows.map(r => r.toData()), before);
});

// QA指摘（ステップ3全体）: 往復テスト（encode→decode）だけでは、writeEquipmentRow・readEquipmentRowの
// 両方が参照する共有定数 EQ（graphFbs.js）のフィールド番号を入れ替える変異を検出できない
// （書き手も読み手も同じ入れ替え後の番号を使うため、往復では整合したまま値がズレて見えない）。
// 既知の正しいバイト列を固定値として埋め込み、その decode() 結果が期待値と一致することを見る。
test('【固定バイト列】graph.equipmentRows: 既知の正しいFlatBuffersバイト列をdecodeすると、category・usage・no・cellKeys・roomIdが期待どおり復元される（EQフィールド番号入れ替えの検出用）', () => {
  // 生成元（2026-09-29・HEAD=97fbc3e + ステップ3 S1〜S5未コミット差分の時点）:
  //   const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  //   graph.addEquipmentRow({ id: 'eq-fixed-1', category: ElevatorEquipmentCategory.EV,
  //     usage: EvUsage.FREIGHT, no: 3, cellKeys: new Set(['ka:kb:kc:kd', 'ke:kf:kg:kh']),
  //     roomId: 'room-fixed-1' });
  //   console.log(bytesToBase64(serializeGraph(graph))); // documentFile.js の bytesToBase64
  // id等はすべて固定文字列（乱数のidを含まない）ため環境が変わっても値は不変。
  const FIXED_BYTES_B64 = 'eAAAAAAAAAAAAG4AxADAALwAuAC0ALAArACoAKQAoACcAJgAAACUAAAAkACMAIgAhAB0AHAAAABsAGgAZABgAFwAWABUAFAATABAADwAOAA0AEgAMAAsACgAJAAgAAAAeAAcABgARAAUABAAAAAMAAAACAAAAAQAbgAAAMAAAABcAQAAbAEAANwBAADgAQAA4AEAAOABAAC4AQAAuAEAALgBAAC4AQAAuAEAAMwBAADMAQAAzAEAAMwBAADMAQAAzAEAAMwBAADMAQAAzAEAAMwBAADMAQAAzAEAAMwBAADMAQAAzAEAABABAADsAQAAAAAAAADAokAAAAAABAEAABQBAAAkAQAAsAEAADABAACkAQAAqAEAAKgBAACoAQAAqAEAAKgBAACoAQAAqAEAAKwBAACsAQAArAEAAAEAAAAUAAAAEAAkACAAHAAYAAwACAAEABAAAABMAAAAHAAAAAAAAAAAAAhAAAAAAEwAAABUAAAAWAAAAAIAAAAYAAAABAAAAAsAAABrZTprZjprZzpraAALAAAAa2E6a2I6a2M6a2QADAAAAHJvb20tZml4ZWQtMQAAAAAHAAAAZnJlaWdodAACAAAAZXYAAAoAAABlcS1maXhlZC0xAAAMAAAAMzAxMDAwMDAwMDAyAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAMTAxNDAwMDAwMDA3AAAAAAwAAAAxMDE0MDAwMDAwMTIAAAAADAAAADEwMTQwMDAwMDAwNQAAAAAMAAAAMTAxNDAwMDAwMDA1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const bytes = base64ToBytes(FIXED_BYTES_B64);

  const snapshot = decode(bytes);

  assert.equal(snapshot.equipmentRows.length, 1);
  const row = snapshot.equipmentRows[0];
  assert.equal(row.id, 'eq-fixed-1');
  assert.equal(row.category, ElevatorEquipmentCategory.EV);
  assert.equal(row.usage, EvUsage.FREIGHT);
  assert.equal(row.no, 3);
  assert.deepEqual([...row.cellKeys].sort(), ['ka:kb:kc:kd', 'ke:kf:kg:kh']);
  assert.equal(row.roomId, 'room-fixed-1');
});

test('【失敗系】graph.equipmentRows: 旧データ（equipmentRowsキー自体が無いFlatBuffersバイト列）を restoreGraph で読み込むと行0件になる（既定値へ黙って落ちない・例外にもならない）', () => {
  const source = makeGraph(); // equipmentRowsを一切追加しない（旧スキーマ相当）
  const bytes = serializeGraph(source);

  const restored = makeGraph();
  restored.addEquipmentRow({ id: 'stale', category: 'ev', usage: DEFAULT_EV_USAGE, no: 1, cellKeys: new Set(['x:y:z:w']) });
  restoreGraph(restored, bytes); // clear()で一旦空になってから復元される

  assert.deepEqual(restored.equipmentRows.map(r => r.id), []);
});

test('【失敗系】graph.addEquipmentRow({}) は EquipmentRow のコンストラクタ throw をそのまま伝える（黙って既定値に落ちない）', () => {
  const graph = makeGraph();
  assert.throws(() => graph.addEquipmentRow({}));
  assert.equal(graph.equipmentRows.length, 0, '例外時に半端な行が残らない');
});

// ---- 線idの一括振り直し・往復テスト ----
// 壁・部屋（セルキー）・建具・構造材（柱・梁）・refIdで別の線を参照する中心線・
// extentLoRef/HiRefで別の線を参照する中心線・idをキーにした辞書（柱芯オフセット・CL偏芯・腰壁）を
// 持つPlanGraphを作り、
// serializeGraph → decodeFloorSnapshot → makeFreshLineIdMap + remapLineIdsInSnapshot →
// encodeFloorSnapshot → restoreGraph の往復で、壁・部屋・建具・構造材の本数と幾何が保たれ、
// 線のidはすべて変わっていて、findLineIdOccurrencesが[]であることを確かめる。
// 座標はすべて異なる非ゼロ値にする（0どうしの取り違えを座標一致で見逃さないため）。
function makeGraphForLineIdRemap() {
  const graph = makeGraph();
  const x0     = graph.addCenterLine(CenterLineType.VERTICAL,   100,  { labeled: true, discipline: Discipline.ARCH });
  const x1     = graph.addCenterLine(CenterLineType.VERTICAL,   3100, { labeled: true, discipline: Discipline.ARCH });
  const xExtra = graph.addCenterLine(CenterLineType.VERTICAL,   6100, { labeled: true, discipline: Discipline.ARCH });
  const y0     = graph.addCenterLine(CenterLineType.HORIZONTAL, 200,  { labeled: true, discipline: Discipline.ARCH });
  const y1     = graph.addCenterLine(CenterLineType.HORIZONTAL, 3200, { labeled: true, discipline: Discipline.ARCH });
  // 別の線をrefIdで参照する中心線（x0から500mmずれた位置に追従する子CL）
  const xRef = graph.addCenterLine(CenterLineType.VERTICAL, 600, {
    labeled: false, discipline: Discipline.ARCH, refId: x0.id, refOffset: 500,
  });
  // extentLoRef/extentHiRefで別の2本の線を参照する中心線（区間限定の中心線相当）
  const xSpan = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH,
    extentLoRef: { clId: x0.id, offset: 0 }, extentHiRef: { clId: xExtra.id, offset: 0 },
  });

  const wall    = graph.addWall(y0, 75, false, x0, 0, x1, 0, { isExteriorWall: true });
  const key     = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room    = graph.addRoom(new Set([key]), 'LDK');
  const opening = graph.addOpening(y0, 1, false, x0, 1000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  const column  = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, y0, {});
  const beam    = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', y0, false, x0, x1, { role: 'primary' });
  graph.setColumnAxisOffset(x0.id, 15); // idをキーにした辞書（柱芯オフセット）
  graph.setCLEccentricity(y0.id, { mode: 'value', value: 30, side: 1, backing: '2x4' }); // idをキーにした辞書（CL偏芯）
  graph.setKneeDropWall(edgeKey(y0.id, x0.id, x1.id), { knee: { topHeight: 1500 }, drop: null });

  return { graph, x0, x1, xExtra, y0, y1, xRef, xSpan, wall, room, opening, column, beam, key };
}

test('remapLineIdsInSnapshot: 壁・部屋・建具・構造材・refId/extentRef参照CL・id辞書を持つPlanGraphのserializeGraph→remap→restoreGraphの往復で、本数と幾何が保たれ、線idはすべて変わる', () => {
  const { graph, x0, xExtra, wall, room, opening, column, beam, xRef, xSpan } = makeGraphForLineIdRemap();
  // 元グラフの「自グラフ固有」の線id全部（makeFreshLineIdMapが1本でも取りこぼすと、その線だけ旧idの
  // まま残り、下の「線idはすべて変わっている」検査がこの集合との一致で赤くなる）。
  const originalLineIds = graph.centerLines.map(cl => cl.id);

  const before = {
    wallCount: graph.walls.length,
    wallAxisValue: wall.axisCL.effectiveValue,
    wallStartValue: wall.clStart.effectiveValue,
    wallEndValue: wall.clEnd.effectiveValue,
    columnCount: graph.columns.length,
    beamCount: graph.beams.length,
    columnAxisValue: column.verticalCL.effectiveValue,
    columnHorizontalAxisValue: column.horizontalCL.effectiveValue,
    beamAxisValue: beam.axisCL.effectiveValue,
    beamStartValue: beam.clStart.effectiveValue,
    beamEndValue: beam.clEnd.effectiveValue,
    openingWidth: opening.width,
    openingAxisValue: opening.axisCL.effectiveValue,
    columnAxisOffset: graph.columnAxisOffsets.get(x0.id),
    clEccentricity: { ...graph.clEccentricities.get(wall.axisCL.id) },
    kneeDropWallCount: graph.kneeDropWalls.size,
    refCLValue: xRef.effectiveValue,
    xSpanExtentLoValue: xSpan.extentLo,
    xSpanExtentHiValue: xSpan.extentHi,
    // 部屋のセルが指す4本のCLの座標値（順序を保った幾何の指紋）
    roomCellValues: [...room.cells][0].split(':').map(id => graph.shapeMap.get(id).effectiveValue),
  };

  const bytes = serializeGraph(graph);
  const snapshot = decodeFloorSnapshot(bytes);
  const idMap = makeFreshLineIdMap(snapshot);
  assert.equal(idMap.size, snapshot.centerLines.length, '前提: 全中心線に新idが割り当てられる');

  const remapped = remapLineIdsInSnapshot(snapshot, idMap);
  // 事後条件: 旧idが1つも残っていない
  assert.deepEqual(findLineIdOccurrences(remapped, [...idMap.keys()]), []);
  // 入力（snapshot）は書き換えられていない
  assert.notDeepEqual(remapped, snapshot);
  assert.deepEqual([...snapshot.centerLines.map(c => c.id)], [...idMap.keys()], '入力snapshotの中心線idは元のまま');

  const newBytes = encodeFloorSnapshot(remapped);
  const restored = makeGraph('p1-restored');
  restoreGraph(restored, newBytes);

  // 本数
  assert.equal(restored.walls.length, before.wallCount);
  assert.equal(restored.columns.length, before.columnCount);
  assert.equal(restored.beams.length, before.beamCount);
  assert.equal(restored.rooms.length, 1);

  // 幾何（壁の軸・始終点の座標値）
  const w2 = restored.walls[0];
  assert.equal(w2.axisCL.effectiveValue, before.wallAxisValue);
  assert.equal(w2.clStart.effectiveValue, before.wallStartValue);
  assert.equal(w2.clEnd.effectiveValue, before.wallEndValue);

  // 幾何（柱・梁の軸のeffectiveValue）
  const c2 = restored.columns[0];
  assert.equal(c2.verticalCL.effectiveValue, before.columnAxisValue);
  assert.equal(c2.horizontalCL.effectiveValue, before.columnHorizontalAxisValue);
  const b2 = restored.beams[0];
  assert.equal(b2.axisCL.effectiveValue, before.beamAxisValue);
  assert.equal(b2.clStart.effectiveValue, before.beamStartValue);
  assert.equal(b2.clEnd.effectiveValue, before.beamEndValue);

  // 部屋のセル（新idのキーになっているが、指す4本のCLの座標値は不変）
  const r2 = restored.rooms[0];
  const restoredCellValues = [...r2.cells][0].split(':').map(id => restored.shapeMap.get(id).effectiveValue);
  assert.deepEqual(restoredCellValues, before.roomCellValues);

  // 建具
  const o2 = [...restored.shapeMap.values()].find(s => s.category === OpeningCategory.WINDOW);
  assert.ok(o2, '復元後に建具が存在する');
  assert.equal(o2.width, before.openingWidth);
  assert.equal(o2.axisCL.effectiveValue, before.openingAxisValue);

  // idをキーにした辞書（柱芯オフセット・CL偏芯・腰壁）
  const newX0Id = idMap.get(x0.id);
  const newY0Id = idMap.get(wall.axisCL.id);
  const newX1Id = idMap.get(wall.clEnd.id);
  assert.equal(restored.columnAxisOffsets.get(newX0Id), before.columnAxisOffset);
  assert.deepEqual({ ...restored.clEccentricities.get(newY0Id) }, before.clEccentricity);
  assert.equal(restored.kneeDropWalls.size, before.kneeDropWallCount);
  assert.equal(restored.kneeDropWalls.has(edgeKey(newY0Id, newX0Id, newX1Id)), true,
    '腰壁のキーは新idのedgeKeyで引ける');

  // refIdで別の線を参照する中心線: 新x0のidを指し、effectiveValueは不変
  const xRef2 = restored.shapeMap.get(idMap.get(xRef.id));
  assert.ok(xRef2);
  assert.equal(xRef2.refId, newX0Id);
  assert.equal(xRef2.effectiveValue, before.refCLValue);

  // extentLoRef/extentHiRefで別の2本の線を参照する中心線: 参照先のidが新idへ張り替わり、区間の値は不変
  const xSpan2 = restored.shapeMap.get(idMap.get(xSpan.id));
  assert.ok(xSpan2);
  assert.equal(xSpan2.extentLoRef?.clId, newX0Id);
  assert.equal(xSpan2.extentHiRef?.clId, idMap.get(xExtra.id));
  assert.equal(xSpan2.extentLo, before.xSpanExtentLoValue);
  assert.equal(xSpan2.extentHi, before.xSpanExtentHiValue);

  // 線のidはすべて変わっている（元グラフの自グラフ固有の線id全部が、復元後のどのCLのidにも一致しない）
  const originalIdSet = new Set(originalLineIds);
  for (const cl of restored.centerLines) {
    assert.equal(originalIdSet.has(cl.id), false, `線id ${cl.id} は旧idのままではいけない`);
  }
});

test('【失敗系】remapLineIdsInSnapshot: idMapに空文字の旧idがあるとthrow', () => {
  const { graph } = makeGraphForLineIdRemap();
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  const idMap = new Map([['', 'new-id-1']]);
  assert.throws(() => remapLineIdsInSnapshot(snapshot, idMap));
});

test('【失敗系】remapLineIdsInSnapshot: idMapに重複する新idがあるとthrow', () => {
  const { graph, x0, x1 } = makeGraphForLineIdRemap();
  const idMap = new Map([[x0.id, 'dup-new-id'], [x1.id, 'dup-new-id']]);
  assert.throws(() => remapLineIdsInSnapshot(decodeFloorSnapshot(serializeGraph(graph)), idMap));
});

// ---- serializeGraphWithFreshLineIds（検討案の追加・コピー用。線種変更の移籍一本化 ステップ2）----
// graphSnapshot.js側に buildSnapshot → makeFreshLineIdMap → remapLineIdsInSnapshot → encode を
// 1関数にまとめたもの。上の往復テストと同じ手順を1関数呼び出しで確かめる。

test('serializeGraphWithFreshLineIds: 壁・部屋・建具・構造材の本数と幾何が保たれ、線idはプロジェクト全体で一意（重複0件）になり、壁・部屋・建具・構造材のidは元のまま変わらない', () => {
  const { graph, wall, room, opening, column, beam } = makeGraphForLineIdRemap();
  const originalLineIds = graph.centerLines.map(cl => cl.id);

  const before = {
    wallCount: graph.walls.length,
    wallAxisValue: wall.axisCL.effectiveValue,
    columnCount: graph.columns.length,
    beamCount: graph.beams.length,
    beamAxisValue: beam.axisCL.effectiveValue,
    openingWidth: opening.width,
    roomCellValues: [...room.cells][0].split(':').map(id => graph.shapeMap.get(id).effectiveValue),
  };

  const bytes = serializeGraphWithFreshLineIds(graph);
  const restored = makeGraph('p1-copy');
  restoreGraph(restored, bytes);

  // 本数・幾何
  assert.equal(restored.walls.length, before.wallCount);
  assert.equal(restored.walls[0].axisCL.effectiveValue, before.wallAxisValue);
  assert.equal(restored.columns.length, before.columnCount);
  assert.equal(restored.beams.length, before.beamCount);
  assert.equal(restored.beams[0].axisCL.effectiveValue, before.beamAxisValue);
  const o2 = [...restored.shapeMap.values()].find(s => s.category === OpeningCategory.WINDOW);
  assert.equal(o2.width, before.openingWidth);
  const r2 = restored.rooms[0];
  const restoredCellValues = [...r2.cells][0].split(':').map(id => restored.shapeMap.get(id).effectiveValue);
  assert.deepEqual(restoredCellValues, before.roomCellValues);

  // (b) 複製先の線idが元の自グラフ固有の線idと1つも重ならない
  const restoredLineIds = restored.centerLines.map(cl => cl.id);
  const originalIdSet = new Set(originalLineIds);
  for (const id of restoredLineIds) assert.equal(originalIdSet.has(id), false, `線id ${id} が元のidと重複している`);

  // (c) findDuplicateLineIds が [] （プロジェクト全体で一意という不変条件を、複製元・複製先の
  // 2平面ぶんのエントリで直接検査する）
  const duplicates = findDuplicateLineIds([
    { planeId: 'orig', planeName: '元', ids: originalLineIds },
    { planeId: 'copy', planeName: '複製先', ids: restoredLineIds },
  ]);
  assert.deepEqual(duplicates, []);

  // (d) 線以外（壁・部屋・建具・構造材）のidは元のまま変わらない（Q10「線だけ」）
  assert.equal(restored.walls[0].id, wall.id);
  assert.equal(restored.rooms[0].id, room.id);
  assert.equal(o2.id, opening.id);
  assert.equal(restored.columns[0].id, column.id);
  assert.equal(restored.beams[0].id, beam.id);
});

test('【失敗系】serializeGraphWithFreshLineIds: newIdが同じ値を2回返すとthrowし、入力グラフは変わらない（振り直し前に平面を追加してはならない設計の前提）', () => {
  const { graph } = makeGraphForLineIdRemap();
  const bytesBefore = serializeGraph(graph);

  assert.throws(() => serializeGraphWithFreshLineIds(graph, { newId: () => 'always-same-id' }));

  const bytesAfter = serializeGraph(graph);
  assert.deepEqual(bytesAfter, bytesBefore, '入力グラフのバイト列は振り直し失敗の前後で変わらない');
});

// ---- 天井区画（S5。Room.ceilingZones。FBS の CZ テーブル＋RM.CEILING_ZONES=31。区画が無い部屋は vector を書かない） ----
// 2部屋（居間・寝室）を持つ階。居間の区画に zones を付ける。
function makeGraphWithZones(zonesData) {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   1000, opt);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const cellA = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const cellB = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`;
  const living = graph.addRoom(new Set([cellA, cellB]), '居間');
  const bed = graph.addRoom(new Set(), '寝室');
  living.setCeilingZones(restoreCeilingZones(zonesData ? zonesData({ cellA, cellB }) : []));
  return { graph, living, bed, cellA, cellB };
}
const ZONES_FULL = ({ cellA, cellB }) => [
  { id: 'za', cells: [cellA], heightMm: null, shape: 'dome', dims: [1200] },
  { id: 'zb', cells: [cellB], heightMm: 2750.5, shape: 'slope', dims: [1500.5, 270] },
];

test('【S5・S6a】FlatBuffers encode→decode: 区画（高さ null と有限・dome の dims [1200]・slope の dims [1500.5, 270]）が往復する。区画の無い部屋は []', () => {
  const { graph, living, bed, cellA, cellB } = makeGraphWithZones(ZONES_FULL);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.deepEqual(restored.roomMap.get(living.id).ceilingZones.map(z => z.toData()), [
    { id: 'za', cells: [cellA], heightMm: null, shape: 'dome', dims: [1200] },
    { id: 'zb', cells: [cellB], heightMm: 2750.5, shape: 'slope', dims: [1500.5, 270] },
  ]);
  assert.deepEqual([...restored.roomMap.get(bed.id).ceilingZones], []);
  assert.ok(Object.isFrozen(restored.roomMap.get(living.id).ceilingZones));
});

test('【S5】plain 経路（decodeFloorSnapshot→JSON→restoreGraph）でも往復し、読み側の区画のキー集合は CEILING_ZONE_KEYS', () => {
  const { graph, living } = makeGraphWithZones(ZONES_FULL);
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  const plain = snapshot.rooms.find(r => r.id === living.id);
  for (const z of plain.ceilingZones) assert.deepEqual(Object.keys(z).sort(), [...CEILING_ZONE_KEYS].sort());
  const restored = makeGraph();
  restoreGraph(restored, JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.roomMap.get(living.id).ceilingZones.map(z => z.toData()), living.ceilingZones.map(z => z.toData()));
});

// i 番目の部屋の FBS テーブルに、フィールド番号 fieldNo が書かれているか（vtable の有無）を直接読む。
function roomHasField(bytes, roomIdx, fieldNo) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const vecOff = root + bb.__offset(root, 4 + 9 * 2); // GS.ROOMS=9
  const table = bb.__indirect(bb.__vector(vecOff) + roomIdx * 4);
  return bb.__offset(table, 4 + fieldNo * 2) !== 0;
}

test('【S5】区画の無い部屋は RM.CEILING_ZONES(31) を書かない（空の vector も作らない）。区画のある部屋だけが書く（読み取りの対照つき）', () => {
  const { graph, living, bed } = makeGraphWithZones(ZONES_FULL);
  const bytes = serializeGraph(graph);
  const idx = id => graph.roomOrder.indexOf(id);
  assert.equal(roomHasField(bytes, idx(living.id), 31), true, '対照: 区画のある部屋は書く（読み取りヘルパーが効いている）');
  assert.equal(roomHasField(bytes, idx(living.id), 2), true, '対照: 既存フィールド CELLS(2)');
  assert.equal(roomHasField(bytes, idx(bed.id), 31), false, '区画の無い部屋は書かない');
  living.setCeilingZones([]);
  assert.equal(roomHasField(serializeGraph(graph), idx(living.id), 31), false, 'setCeilingZones([]) 後も書かない');
});

test('【S5】区画の無いグラフのバイト列は不変: ceilingZones のキーが無い snapshot の encode と一致し、区画を付けて外しても元と一致する', () => {
  const { graph, living, cellA } = makeGraphWithZones(null);
  const base = serializeGraph(graph);
  const snap = decodeFloorSnapshot(base);
  snap.rooms.forEach(r => { delete r.ceilingZones; });
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base], '旧形式（キー無し）と同じバイト列＝空の vector を書かない');

  living.setCeilingZones(restoreCeilingZones([{ id: 'za', cells: [cellA], heightMm: 2400 }]));
  assert.ok(serializeGraph(graph).length > base.length, '区画ありは CZ ぶん長くなる');
  living.setCeilingZones([]);
  assert.deepEqual([...serializeGraph(graph)], [...base], 'setCeilingZones([]) 後も元と同じ（1バイトも変わらない）');
});

test('【S5・失敗系】旧データ（ceilingZones が無い snapshot）は []。壊れた区画は復元で正規化され、不正は捨てられる', () => {
  const { graph, living, cellA, cellB } = makeGraphWithZones(ZONES_FULL);
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  const plain = snapshot.rooms.find(r => r.id === living.id);
  plain.ceilingZones = [
    { id: 'ok', cells: [cellB, cellA, cellA], heightMm: 2600, shape: 'slope', dims: [0, 45] },
    { id: '', cells: [cellA], heightMm: 2400 },
    { id: 'empty', cells: [cellA], heightMm: null },
  ];
  const restored = makeGraph();
  restoreGraph(restored, snapshot);
  assert.deepEqual(restored.roomMap.get(living.id).ceilingZones.map(z => z.toData()), [
    { id: 'ok', cells: [cellA, cellB].sort(), heightMm: 2600, shape: 'flat', dims: [] },
  ], '壊れた傾斜（ライズ 0・向き 45）は区画を捨てずセルと高さを残して flat・[] へ落ちる。id なしと指定なし（先の区画にセルも取られた）は捨てる');

  delete snapshot.rooms.find(r => r.id === living.id).ceilingZones; // 旧データ（キー自体が無い）
  const old = makeGraph();
  restoreGraph(old, snapshot);
  assert.deepEqual([...old.roomMap.get(living.id).ceilingZones], []);
});

test('【S5】階の複製・検討案のコピー（serializeGraphWithFreshLineIds）では区画のセルの線 id も振り直され、部屋のセルと同じ新 id を指す', () => {
  const { graph, living } = makeGraphWithZones(ZONES_FULL);
  const copy = makeGraph();
  restoreGraph(copy, serializeGraphWithFreshLineIds(graph));
  const room = copy.roomMap.get(living.id);
  assert.equal(room.ceilingZones.length, 2);
  const roomCellIds = new Set([...room.cells].flatMap(k => k.split(':')));
  const origIds = new Set([...living.cells].flatMap(k => k.split(':')));
  for (const z of room.ceilingZones) {
    assert.ok(z.cells.every(c => room.cells.has(c)), '区画のセルは部屋のセルと同じ新キー');
    for (const id of z.cells.flatMap(k => k.split(':'))) {
      assert.ok(roomCellIds.has(id));
      assert.ok(!origIds.has(id), '旧 id のまま残っていない');
    }
  }
  assert.deepEqual(room.ceilingZones.map(z => [z.id, z.heightMm, z.shape, z.dims]), [['za', null, 'dome', [1200]], ['zb', 2750.5, 'slope', [1500.5, 270]]]);
});
