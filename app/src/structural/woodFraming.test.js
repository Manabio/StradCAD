// woodFraming.js（在来木造の梁成表・下地割付・袖材・玄関開口・火打ち条件）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature } from '../core/constants.js';
import {
  woodBeamDepthMm, woodBeamSectionKey, woodBeamSectionForDepth, woodBeamDepthForSpans, crossingBeamLoadCoords,
  propagateCarrierDepths,
  studPositions, studSpec, openingJambSpec, entranceOpeningWidthMm, hipBraceAllowed,
  wallRunFaces, faceStudPositions,
} from './woodFraming.js';
import { WOOD_BEAM_DEPTH_TABLE, TRADITIONAL_WOOD_FRAMING, TRADITIONAL_WOOD_BACKING, rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { findSectionEntry, woodRectSectionKey, SECTION_CATALOG } from './sectionCatalog.js';

test('woodBeamDepthMm: 梁成表（最終行は中間荷重3か所＝ユーザー確認済み）を距離区分×中間荷重数で引く', () => {
  // 1820以下
  assert.equal(woodBeamDepthMm(1820, 0), 120);
  assert.equal(woodBeamDepthMm(910, 1), 150);
  assert.equal(woodBeamDepthMm(1820, 2), 210);
  assert.equal(woodBeamDepthMm(1820, 3), 240);
  // 2730以下（1820超）
  assert.equal(woodBeamDepthMm(1821, 0), 240);
  assert.equal(woodBeamDepthMm(2730, 1), 270);
  assert.equal(woodBeamDepthMm(2730, 2), 270);
  assert.equal(woodBeamDepthMm(2730, 3), 300);
  // 3640以下（2730超）
  assert.equal(woodBeamDepthMm(2731, 0), 300);
  assert.equal(woodBeamDepthMm(3640, 1), 330);
  assert.equal(woodBeamDepthMm(3640, 2), 330);
  assert.equal(woodBeamDepthMm(3640, 3), 360);
});

test('woodBeamDepthMm: 表の外（3640超・4か所以上）は表の最大側の値（ユーザー裁定2026-09-14「表の最大値360を使う」）', () => {
  assert.equal(woodBeamDepthMm(3641, 0), 300, '3640超は3640以下の列');
  assert.equal(woodBeamDepthMm(5460, 3), 360, '3640超×3か所＝表の最大値');
  assert.equal(woodBeamDepthMm(1820, 4), 240, '4か所以上は3か所の行');
  assert.equal(woodBeamDepthMm(9999, 9), 360);
});

test('【失敗系】woodBeamDepthMm: 非数・0以下の距離、負や非整数の荷重数は null', () => {
  assert.equal(woodBeamDepthMm(0, 0), null);
  assert.equal(woodBeamDepthMm(NaN, 0), null);
  assert.equal(woodBeamDepthMm(undefined, 0), null);
  assert.equal(woodBeamDepthMm(1820, -1), null);
  assert.equal(woodBeamDepthMm(1820, 1.5), null);
});

test('woodBeamSectionKey: 支持間距離と中間荷重から「柱同寸×成」の断面キーを返し、表のすべての成×正角幅がカタログにある', () => {
  assert.equal(woodBeamSectionKey(3640, 3, 120), 'WOOD-120x360');
  assert.equal(woodBeamSectionKey(1820, 0, 120), 'WOOD-120x120', '成120×幅120＝正角');
  assert.equal(woodBeamSectionKey(1820, 0, 105), 'WOOD-105x120');
  assert.equal(woodBeamSectionKey(2730, 2, 90), 'WOOD-90x270');
  assert.equal(woodBeamSectionKey(5000, 5, 120), 'WOOD-120x360', '表外は最大値');
  for (const width of [90, 105, 120]) {
    for (const row of WOOD_BEAM_DEPTH_TABLE.depthsByLoads) {
      for (const depth of row) {
        assert.equal(woodRectSectionKey(width, depth), `WOOD-${width}x${depth}`, `${width}×${depth} がカタログに無い`);
      }
    }
  }
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.columnSection).width, 120, '在来木造の柱は120角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.hipBraceSection)?.width, 90, '火打ち梁は90角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.purlinSection)?.width, 90, '母屋は90角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.ridgeSection)?.width, 120, '棟木は120角');
  assert.ok(findSectionEntry('WOOD-105x105'), '旧既定 105角 は旧文書のため残す');
});

test('【失敗系】woodBeamSectionKey: 梁成が引けない・幅が非数/0以下・カタログに無い幅は null', () => {
  assert.equal(woodBeamSectionKey(0, 0, 120), null);
  assert.equal(woodBeamSectionKey(1820, 0, 0), null);
  assert.equal(woodBeamSectionKey(1820, 0, NaN), null);
  assert.equal(woodBeamSectionKey(1820, 0, 150), null, '150幅の木角材はカタログに無い');
});

test('sectionCatalog: 木造エントリは正角（90/105/120）と「正角幅×梁成」の矩形で、材種WOOD・幅≦成', () => {
  const wood = SECTION_CATALOG.filter(s => s.materialType === 'WOOD');
  assert.ok(wood.length >= 3 + 3 * 8, `木造エントリが少ない（${wood.length}）`);
  for (const s of wood) {
    assert.ok([90, 105, 120].includes(s.width), `${s.key}: 幅は正角材の寸法`);
    assert.ok(s.height >= s.width, `${s.key}: 成は幅以上`);
    assert.equal(s.key, `WOOD-${s.width}x${s.height}`);
  }
});

test('woodBeamSectionForDepth: 成→断面キー（材幅＝柱同寸）。woodBeamSectionKeyはこれへ委譲する', () => {
  assert.equal(woodBeamSectionForDepth(360, 120), 'WOOD-120x360');
  assert.equal(woodBeamSectionForDepth(120, 120), 'WOOD-120x120', '成120×幅120＝正角');
  assert.equal(woodBeamSectionForDepth(120, 105), 'WOOD-105x120');
  // woodBeamSectionKey は woodBeamDepthMm→woodBeamSectionForDepth の合成と一致する（委譲の確認）。
  assert.equal(woodBeamSectionKey(1820, 0, 120), woodBeamSectionForDepth(woodBeamDepthMm(1820, 0), 120));
});

test('【失敗系】woodBeamSectionForDepth: 成がnull・幅が非数/0以下・カタログに無い幅は null', () => {
  assert.equal(woodBeamSectionForDepth(null, 120), null);
  assert.equal(woodBeamSectionForDepth(120, 0), null);
  assert.equal(woodBeamSectionForDepth(120, NaN), null);
  assert.equal(woodBeamSectionForDepth(120, 150), null, '150幅の木角材はカタログに無い');
});

test('woodBeamDepthForSpans: 支持点間を区間に分け、各区間の内部荷重数から梁成表を引いた最大値を返す', () => {
  assert.equal(woodBeamDepthForSpans([0, 3640], []), 300, '単一区間・荷重なし');
  assert.equal(woodBeamDepthForSpans([0, 1820], [910]), 150, '単一区間・内部荷重1');
  assert.equal(woodBeamDepthForSpans([0, 1820, 5460], []), 300, '区間最大: [0,1820]=120, [1820,5460]=300 → 300');
  assert.equal(woodBeamDepthForSpans([0, 1820, 3640], [1820]), 120, '荷重が支持点(端)に一致する位置は内部荷重に数えない');
  assert.equal(woodBeamDepthForSpans([0, 1820], [910, 910.3]), 150, '同位置(tol未満)の複数荷重源は1か所にまとめる');
  assert.equal(woodBeamDepthForSpans([0, 0.2, 1820], []), 120, '支持点もtol未満は1点にまとめる');
  assert.equal(woodBeamDepthForSpans([0, 10000], []), 300, '表外の距離は表の最大側の列');
});

test('【失敗系】woodBeamDepthForSpans: 支持点0/1個・非数混入・荷重の非数混入は null', () => {
  assert.equal(woodBeamDepthForSpans([], []), null, '支持点0個');
  assert.equal(woodBeamDepthForSpans([1820], []), null, '支持点1個');
  assert.equal(woodBeamDepthForSpans([0, 0.2], []), null, '支持点がtolでまとまって実質1点');
  assert.equal(woodBeamDepthForSpans([0, NaN], []), null, '支持点に非数混入');
  assert.equal(woodBeamDepthForSpans([0, 1820], [NaN]), null, '荷重に非数混入');
  assert.equal(woodBeamDepthForSpans(null, []), null);
});

test('crossingBeamLoadCoords: 同位置で両方向(+1/-1)そろう十字貫通は除外し、片側だけ(T字)は1か所として残す', () => {
  assert.deepEqual(crossingBeamLoadCoords([{ coord: 910, dir: 1 }, { coord: 910, dir: -1 }]), [], '十字貫通は荷重に数えない');
  assert.deepEqual(crossingBeamLoadCoords([{ coord: 910, dir: 1 }]), [910], 'T字は1か所');
  assert.deepEqual(
    crossingBeamLoadCoords([{ coord: 910, dir: 1 }, { coord: 910, dir: -1 }, { coord: 1820, dir: 1 }]),
    [1820], '貫通する910は除外し、T字の1820だけ残す',
  );
  assert.deepEqual(crossingBeamLoadCoords([]), []);
});

test('propagateCarrierDepths: 1段伝播（carrierの成をhostへmaxで反映）', () => {
  const result = propagateCarrierDepths([
    { id: 'carrier', depth: 300, isCarrier: true, hostIds: ['host'] },
    { id: 'host', depth: 240, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('carrier'), 300, 'carrier自身の成は不変');
  assert.equal(result.get('host'), 300, 'hostの成はcarrierと同寸へ上がる');
});

test('propagateCarrierDepths: 多段伝播（hostのhostまで、伝播元がcarrierかどうかは問わない）', () => {
  const result = propagateCarrierDepths([
    { id: 'carrier', depth: 360, isCarrier: true, hostIds: ['host1'] },
    { id: 'host1', depth: 240, isCarrier: false, hostIds: ['host2'] },
    { id: 'host2', depth: 120, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('host1'), 360, 'carrierから直接伝播');
  assert.equal(result.get('host2'), 360, 'host1が上がった分がさらにhost2へ伝播（荷重経路を辿る）');
});

test('propagateCarrierDepths: hostのほうが元々大きければ据え置き', () => {
  const result = propagateCarrierDepths([
    { id: 'carrier', depth: 240, isCarrier: true, hostIds: ['host'] },
    { id: 'host', depth: 300, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('host'), 300, 'carrierより大きいhostの成は下げない');
});

test('propagateCarrierDepths: isCarrier=falseのノードは起点にならない（同じ成・hostIdsでも伝播しない）', () => {
  const result = propagateCarrierDepths([
    { id: 'notCarrier', depth: 300, isCarrier: false, hostIds: ['host'] },
    { id: 'host', depth: 120, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('host'), 120, 'carrierでない梁からは伝播しない');
});

test('propagateCarrierDepths: 循環（A→B→A）があっても停止し、両者ともmaxの成に収束する', () => {
  const result = propagateCarrierDepths([
    { id: 'a', depth: 300, isCarrier: true, hostIds: ['b'] },
    { id: 'b', depth: 120, isCarrier: false, hostIds: ['a'] },
  ]);
  assert.equal(result.get('a'), 300);
  assert.equal(result.get('b'), 300);
});

test('【失敗系】propagateCarrierDepths: 未知hostId・非数depthは無視し例外を投げない', () => {
  assert.doesNotThrow(() => {
    const result = propagateCarrierDepths([
      { id: 'carrier', depth: 300, isCarrier: true, hostIds: ['missing', 'host'] },
      { id: 'host', depth: 120, isCarrier: false, hostIds: [] },
      { id: 'nanDepth', depth: NaN, isCarrier: true, hostIds: ['host'] },
    ]);
    assert.equal(result.get('host'), 300, '未知hostIdは無視しつつ、存在するhostへは伝播する');
    assert.equal(result.has('nanDepth'), false, '非数depthのノードは結果に含めない');
    assert.equal(result.has('missing'), false);
  });
  assert.deepEqual([...propagateCarrierDepths([]).entries()], []);
  assert.deepEqual([...propagateCarrierDepths(null).entries()], []);
});

test('studPositions: AB間の両端に (L − (商−1)×455)/2 をとり、残りを455で割り付ける（位置は材の中心）', () => {
  // L=2730: 商=6 → 内側5ピッチ=2275、両端=(2730−2275)/2=227.5
  assert.deepEqual(studPositions(2730), [227.5, 682.5, 1137.5, 1592.5, 2047.5, 2502.5]);
  // L=1820: 商=4 → 内側3ピッチ=1365、両端=227.5
  assert.deepEqual(studPositions(1820), [227.5, 682.5, 1137.5, 1592.5]);
  // ピッチ違い（外壁の「縦下地間隔」変更）: L=1820, p=303 → 商=6 → 内側5×303=1515、両端=152.5
  assert.deepEqual(studPositions(1820, 303), [152.5, 455.5, 758.5, 1061.5, 1364.5, 1667.5]);
  // 対称性: 最初と最後の位置は両端から同じ距離。材厚（studSpec.depth）には依存しない。
  const p = studPositions(3000);
  assert.ok(Math.abs(p[0] - (3000 - p[p.length - 1])) < 1e-9);
  assert.equal(TRADITIONAL_WOOD_BACKING.studPitchMm, 455, '既定ピッチ455');
});

test('【失敗系】studPositions: 距離が2ピッチ未満は中央1本、0以下・非数・ピッチ0以下は空配列', () => {
  assert.deepEqual(studPositions(900), [450]);   // 商=1 → 内側0ピッチ → 中央
  assert.deepEqual(studPositions(300), [150]);   // 商=0 → 中央1本（0本にはしない）
  assert.deepEqual(studPositions(0), []);
  assert.deepEqual(studPositions(-1), []);
  assert.deepEqual(studPositions(NaN), []);
  assert.deepEqual(studPositions(1820, 0), []);
});

test('studSpec / openingJambSpec: 壁下地＝柱寸×30、外壁アルミ窓の袖＝柱寸×45・扉の袖＝柱同寸、クリアランス5', () => {
  assert.deepEqual(studSpec(120), { width: 120, depth: 30 });
  assert.deepEqual(openingJambSpec('window', 120), { width: 120, depth: 45, clearanceMm: 5 });
  assert.deepEqual(openingJambSpec('door', 120), { width: 120, depth: 120, clearanceMm: 5 });
  assert.deepEqual(openingJambSpec('door', 105), { width: 105, depth: 105, clearanceMm: 5 });
});

test('【失敗系】studSpec / openingJambSpec: 未知の種別・柱寸が非数/0以下は null', () => {
  assert.equal(studSpec(0), null);
  assert.equal(studSpec(NaN), null);
  assert.equal(openingJambSpec('shutter', 120), null);
  assert.equal(openingJambSpec('window', 0), null);
  assert.equal(openingJambSpec('window', NaN), null);
});

test('entranceOpeningWidthMm: 玄関建具部分の基礎・両袖取付柱の開口＝扉幅＋両端5mm（既定はルール値）', () => {
  assert.equal(entranceOpeningWidthMm(900), 910);
  assert.equal(rulesFor(TRADITIONAL_WOOD_STRUCTURE).foundation.entranceClearanceMm, 5);
  assert.equal(entranceOpeningWidthMm(900, 10), 920);
  assert.equal(entranceOpeningWidthMm(0), null);
  assert.equal(entranceOpeningWidthMm(900, -1), null);
});

test('hipBraceAllowed: 16㎡以下の四角は可、吹抜け(VOID)は可、階段(STAIR)・階段吹抜け(STAIR_VOID)・削除済み(UNDEFINED)・非四角・16㎡超は不可', () => {
  assert.equal(hipBraceAllowed({ areaM2: 16, isRectangle: true }), true);
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.VOID }), true, '吹抜けには設置可能');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.STAIR }), false, '階段内は不可');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.STAIR_VOID }), false, '階段吹抜けも階段内');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.UNDEFINED }), false, '削除済み部屋は床なし');
  assert.equal(hipBraceAllowed({ areaM2: 16.01, isRectangle: true }), false, '16㎡超は不可');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: false }), false, '四角でなければ不可');
  assert.equal(hipBraceAllowed({ areaM2: 0, isRectangle: true }), false);
  assert.equal(TRADITIONAL_WOOD_FRAMING.hipBraceMaxAreaM2, 16);
});

test('【失敗系】hipBraceAllowed: cell が undefined/null でも例外を投げず false', () => {
  assert.equal(hipBraceAllowed(undefined), false);
  assert.equal(hipBraceAllowed(null), false);
});

test('structureRules: 在来木造だけが framing/backing を持ち、柱120角・梁既定＝柱同寸・梁天端FL−100・床梁1820・下地455等の値を返す', () => {
  const r = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(r.defaultSections.column, 'WOOD-120x120');
  assert.equal(r.defaultSections.beam, r.framing.columnSection, '梁の既定断面は柱同寸の正角');
  assert.equal(r.framing.beamTopBelowFLMm, 100);
  assert.equal(r.framing.floorBeamMaxPitchMm, 1820);
  assert.equal(r.backing.studDepthMm, 30);
  assert.equal(r.foundation.sillWidthMm, 150);
  assert.equal(r.foundation.sectionDefaults.baseWidth, 600);
  for (const key of ['木造（2"×4"）', 'S造', 'SRC造', 'RC造(ラーメン)', 'RC造(壁式)', '未定']) {
    assert.equal(rulesFor(key).framing, null, `${key} は framing を持たない`);
    assert.equal(rulesFor(key).backing, null, `${key} は backing を持たない`);
  }
  assert.equal(rulesFor('木造（2"×4"）').defaultSections.column, 'WOOD-105x105', '2×4の既定断面は変えない');
});

test('wallRunFaces: 下地区間を壁上の柱区間で面（2点間）に分け、柱で終わる端に印を付ける', () => {
  // 柱 [-60,60]（区間の始端に柱面が接する＝T字の相手壁上の柱）・[1760,1880]・[3580,3700]
  assert.deepEqual(wallRunFaces(60, 3700, [[1760, 1880], [-60, 60], [3580, 3700]]), [
    { lo: 60, hi: 1760, columnAtLo: true, columnAtHi: true },
    { lo: 1880, hi: 3580, columnAtLo: true, columnAtHi: true },
  ]);
  // 開口の縁で終わる区間（柱なし）は両端とも false
  assert.deepEqual(wallRunFaces(2803, 3553, [[-60, 60], [3580, 3700]]),
    [{ lo: 2803, hi: 3553, columnAtLo: false, columnAtHi: false }]);
  // 区間の途中で始まる／終わる柱は面の端を柱面へ寄せる
  assert.deepEqual(wallRunFaces(0, 1000, [[900, 1020]]), [{ lo: 0, hi: 900, columnAtLo: false, columnAtHi: true }]);
  assert.deepEqual(wallRunFaces(0, 1000, [[-20, 100]]), [{ lo: 100, hi: 1000, columnAtLo: true, columnAtHi: false }]);
});

test('【失敗系】wallRunFaces: 幅0以下の区間は空、区間外・不正な柱区間は無視、柱に覆い尽くされた区間は面なし', () => {
  assert.deepEqual(wallRunFaces(100, 100, [[0, 50]]), []);
  assert.deepEqual(wallRunFaces(NaN, 100, []), []);
  assert.deepEqual(wallRunFaces(0, 1000, [[2000, 2120], [NaN, 10], [500, 400]]),
    [{ lo: 0, hi: 1000, columnAtLo: false, columnAtHi: false }]);
  assert.deepEqual(wallRunFaces(0, 100, [[-10, 110]]), []);
  assert.deepEqual(wallRunFaces(0, 100, null), [{ lo: 0, hi: 100, columnAtLo: false, columnAtHi: false }]);
});

test('faceStudPositions: 柱で終わる端は柱面から10mmクリアランスの端部材（中心25）、内側は面の全長を455で割付', () => {
  // L=1700（柱面〜柱面）: 商3 → 内側2ピッチ=910、両端395 → 395/850/1305 ＋ 端部材 25/1675
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true, columnAtHi: true }), [25, 395, 850, 1305, 1675]);
  // 片側だけ柱（もう一方は開口の縁）: 端部材は柱側だけ
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true }), [25, 395, 850, 1305]);
  assert.deepEqual(faceStudPositions(1700, { columnAtHi: true }), [395, 850, 1305, 1675]);
  // 柱なし（両端とも開口の縁など）は studPositions のまま
  assert.deepEqual(faceStudPositions(1700, {}), studPositions(1700));
  // 値はルール（クリアランス10・材厚30・ピッチ455）から
  assert.equal(TRADITIONAL_WOOD_BACKING.studColumnClearanceMm, 10);
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true, columnAtHi: true }, { clearanceMm: 20, depthMm: 40 }),
    [40, 395, 850, 1305, 1660]);
  // ピッチ違い（外壁の「縦下地間隔」）: L=1700, p=303 → 商5 → 内側4×303=1212、両端244
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true, columnAtHi: true }, { pitchMm: 303 }),
    [25, 244, 547, 850, 1153, 1456, 1675]);
});

test('【失敗系】faceStudPositions: 端部材と重なる割付材は落とす、端部材が入らない短い面は空、非数・0以下は空', () => {
  // L=100: 端部材 25/75、中央の割付材50は端部材と重なる（材厚30）ので落とす
  assert.deepEqual(faceStudPositions(100, { columnAtLo: true, columnAtHi: true }), [25, 75]);
  // L=70: 端部材は片側（25）だけ入る（もう一方 70-40=30 < 40 で重なる）
  assert.deepEqual(faceStudPositions(70, { columnAtLo: true, columnAtHi: true }), [25]);
  // L=30: 端部材（クリアランス10＋材厚30=40）が入らない → 割付材の中央15は面に収まる
  assert.deepEqual(faceStudPositions(30, { columnAtLo: true, columnAtHi: true }), [15]);
  assert.deepEqual(faceStudPositions(13, { columnAtLo: true, columnAtHi: false }), []);
  assert.deepEqual(faceStudPositions(0, { columnAtLo: true }), []);
  assert.deepEqual(faceStudPositions(NaN, {}), []);
  assert.deepEqual(faceStudPositions(1700, {}, { depthMm: 0 }), []);
  assert.deepEqual(faceStudPositions(1700, {}, { clearanceMm: -1 }), []);
});
