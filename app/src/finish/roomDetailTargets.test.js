// 部屋の取り合い（junction）の基準供給（finish/roomDetailTargets.js。部分詳細図 S8a）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PenDir, DetailSlot, DetailDatumRole, DetailDatumKind, DetailAxis, DetailParam, DetailMaterialField } from '../core/constants.js';
import { fitLocal, DetailFitError } from '../detail/detailPlacement.js';
import { junctionTargets, RoomDetailError } from './roomDetailTargets.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_JUNCTION } from '../error.js';
import { baseboardFigure, wallBackedFigure, junctionFigure, move, fixedLen, stretchLen, materialLen } from './roomDetailTestFixtures.js';

const { FLOOR_WALL, WALL_CEILING } = DetailSlot;

test('floorWall: 壁の仕上げ面 origin＝0・end＝−壁厚・FL origin＝0、param wallThickness＝壁厚', () => {
  const t = junctionTargets(wallBackedFigure('df-a'), { slot: FLOOR_WALL, wallThicknessMm: 100 });
  assert.deepEqual(t.targets.datums, { ds0: 0, dt0: 0, ds1: -100 });
  assert.deepEqual(t.targets.params, { [DetailParam.WALL_THICKNESS]: 100 });
  assert.deepEqual(t.targets.materials, {}, '材束縛の無い図は材を載せない');
  // fit の結果: 壁の中（s<0）へ壁厚ぶん伸びる
  const fitted = fitLocal(wallBackedFigure('df-a'), t.targets);
  assert.equal(fitted.error, undefined);
  assert.deepEqual(fitted.strokes[0].points.map(p => [p.s, p.t]), [[0, 0], [-5, 0], [-100, 0]]);
});

test('wallCeiling: t の origin は CEILING_FACE。floorWall の図（FL）は wallCeiling に使えない（UNSUPPORTED_DATUM）', () => {
  const ok = junctionTargets(wallBackedFigure('df-b', WALL_CEILING), { slot: WALL_CEILING, wallThicknessMm: 90 });
  assert.deepEqual(ok.targets.datums, { ds0: 0, dt0: 0, ds1: -90 });
  const wrong = junctionTargets(wallBackedFigure('df-b'), { slot: WALL_CEILING, wallThicknessMm: 90 });
  assert.equal(wrong.error.code, RoomDetailError.UNSUPPORTED_DATUM);
  assert.equal(wrong.error.message, ERR_DETAIL_DATUM_UNSUPPORTED('dt0', `${DetailDatumRole.FL}・${DetailAxis.T}・${DetailDatumKind.ORIGIN}`, DETAIL_TARGET_JUNCTION));
});

test('【失敗系】供給できない基準の組（建具の基準・WALL_FINISH_FACE の t 軸・s の FL など）は UNSUPPORTED_DATUM。junction でない slot は UNSUPPORTED_SLOT', () => {
  const fig = baseboardFigure('df-c');
  const withDatum = d => ({ ...fig, datums: [...fig.datums, { id: 'dx', offsetMm: 0, ...d }] });
  const unsupported = [
    { role: DetailDatumRole.OPENING_OUTER, axis: DetailAxis.S, kind: DetailDatumKind.END },
    { role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.END },
    { role: DetailDatumRole.FL, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN },
    { role: DetailDatumRole.FL, axis: DetailAxis.T, kind: DetailDatumKind.END },
  ];
  for (const d of unsupported) {
    const r = junctionTargets(withDatum(d), { slot: FLOOR_WALL, wallThicknessMm: 100 });
    assert.equal(r.error?.code, RoomDetailError.UNSUPPORTED_DATUM, JSON.stringify(d));
  }
  assert.equal(junctionTargets(fig, { slot: DetailSlot.FIGURE, wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_SLOT);
  assert.equal(junctionTargets(fig, { slot: 'wall', wallThicknessMm: 100 }).error.code, RoomDetailError.UNSUPPORTED_SLOT);
  // 形の壊れた datum は読み飛ばし、fit の検証に任せる（例外にしない）
  assert.doesNotThrow(() => junctionTargets({ ...fig, datums: [null, ...fig.datums] }, { slot: FLOOR_WALL, wallThicknessMm: 100 }));
  assert.doesNotThrow(() => junctionTargets(null, { slot: FLOOR_WALL, wallThicknessMm: 100 }));
});

test('材束縛: 図が引く材コードだけ materialMap から {thickness, x, y} を載せる。無い材・厚みの無い材は載せず fit が UNRESOLVED_MATERIAL', () => {
  const MAT = '101000000001';
  const fig = junctionFigure('df-m', FLOOR_WALL, [
    move(PenDir.UP, materialLen(MAT, DetailMaterialField.THICKNESS, 12)), move(PenDir.LEFT, fixedLen(3)), move(PenDir.LEFT, stretchLen(50)),
  ], { endVertex: 3 });
  const map = new Map([[MAT, { code: MAT, thickness: 9.5, x: 0, y: 0 }], ['999', { code: '999', thickness: 1, x: 0, y: 0 }]]);
  const t = junctionTargets(fig, { slot: FLOOR_WALL, wallThicknessMm: 100, materialMap: map });
  assert.deepEqual(t.targets.materials, { [MAT]: { thickness: 9.5, x: 0, y: 0 } }, '図が引かない材（999）は載せない');
  const fitted = fitLocal(fig, t.targets);
  assert.equal(fitted.error, undefined);
  assert.deepEqual(fitted.strokes[0].points[1], { s: 0, t: -9.5 }, '材の厚みで U が歩く');
  // 材マップ無し・材が無い・厚みが null → 載らず UNRESOLVED_MATERIAL
  for (const materialMap of [null, undefined, new Map(), new Map([[MAT, { code: MAT, thickness: null, x: 90, y: 45 }]])]) {
    const r = junctionTargets(fig, { slot: FLOOR_WALL, wallThicknessMm: 100, materialMap });
    assert.equal(fitLocal(fig, r.targets).error.code, DetailFitError.UNRESOLVED_MATERIAL);
  }
});
