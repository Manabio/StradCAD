// 部屋の取り合いの解決・fit・失敗の集計（finish/roomDetailJunction.js。部分詳細図 S8a）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot } from '../core/constants.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, detailOwnerRoom } from '../error.js';
import { DetailFitError } from '../detail/detailPlacement.js';
import {
  resolveRoomDetailFigure, fitRoomJunction, roomWallThicknessesMm, wallAssemblyThicknessMm, collectRoomJunctionFailures,
} from './roomDetailJunction.js';
import { baseboardFigure, wallBackedFigure } from './roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_WALL, WALL_CEILING } = DetailSlot;

test.afterEach(() => clearOverlays());

/** 4000×3000 の部屋 1 つと、その壁（generatedWallIds）を持つ階。 */
function graphWithRoom(name = 'LDK') {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y0, y1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 4000), cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  // generateRoomWallsFromOutline は壁を返すだけ。生成壁の id を部屋へ記録するのは呼び出し側（壁再生成）
  room.generatedWallIds = new Set(generateRoomWallsFromOutline(graph, room).map(w => w.id));
  return { graph, room };
}
const install = (...figures) => setOverlay(DF, { user: figures });

test('resolveRoomDetailFigure: 割当て無しは null、割当て有りは図のキーとエントリ、参照切れは entry=null', () => {
  install(baseboardFigure('df-ok'));
  const { room } = graphWithRoom();
  assert.equal(resolveRoomDetailFigure({ room, slot: FLOOR_WALL }), null);
  room.setDetailRefs({ [FLOOR_WALL]: 'df-ok', [WALL_CEILING]: 'df-gone' });
  const ok = resolveRoomDetailFigure({ room, slot: FLOOR_WALL });
  assert.equal(ok.key, 'df-ok');
  assert.equal(ok.entry.key, 'df-ok');
  assert.deepEqual(resolveRoomDetailFigure({ room, slot: WALL_CEILING }), { key: 'df-gone', slot: WALL_CEILING, entry: null });
  // 差し替え口 entryOf
  assert.equal(resolveRoomDetailFigure({ room, slot: FLOOR_WALL, entryOf: () => null }).entry, null);
  assert.equal(resolveRoomDetailFigure({ room: null, slot: FLOOR_WALL }), null);
});

test('roomWallThicknessesMm: 部屋が生成した壁の materialRange の幅を重複なし・昇順で返す。壁の無い部屋・引けない id は空', () => {
  const { graph, room } = graphWithRoom();
  const widths = roomWallThicknessesMm(graph, room);
  assert.ok(widths.length >= 1);
  assert.deepEqual(widths, [...widths].sort((a, b) => a - b));
  assert.equal(new Set(widths).size, widths.length);
  assert.ok(widths.every(w => w > 0));
  const w0 = graph.shapeMap.get([...room.generatedWallIds][0]);
  assert.ok(widths.includes(wallAssemblyThicknessMm(graph, w0)));
  assert.deepEqual(roomWallThicknessesMm(graph, { generatedWallIds: new Set(['nope']) }), []);
  assert.deepEqual(roomWallThicknessesMm(graph, { generatedWallIds: new Set() }), []);
  assert.deepEqual(roomWallThicknessesMm(null, room), []);
});

test('wallAssemblyThicknessMm: 下地オーナー壁＋仕上げ薄壁は合併幅・単独壁は従来どおり・別軸や重ならない壁は混ぜない・空隙は全幅', () => {
  const axis = { id: 'cl1', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0 };
  const wall = (c1, c2, mr, br = null, ax = axis) => ({ axisCL: ax, coord1: c1, coord2: c2, materialRange: mr, backingRange: br });
  const owner = wall(0, 4000, { lo: 0, hi: 72.5 }, { lo: -60, hi: 60 });
  const thin = wall(0, 4000, { lo: 60, hi: 72.5 }); // 仕上げ薄壁（下地なし・片側 12.5）
  const g = walls => ({ walls });
  assert.equal(wallAssemblyThicknessMm(g([owner, thin]), thin), 132.5, '薄壁側から見ても組の全幅');
  assert.equal(wallAssemblyThicknessMm(g([owner, thin]), owner), 132.5);
  assert.equal(wallAssemblyThicknessMm(g([thin]), thin), 12.5, '単独は従来どおり');
  assert.equal(wallAssemblyThicknessMm(g([wall(0, 4000, { lo: 0, hi: 90 })]), { ...thin, materialRange: { lo: 0, hi: 90 } }), 90);
  assert.equal(wallAssemblyThicknessMm(g([owner, wall(0, 4000, { lo: 500, hi: 600 }, null, { id: 'cl2', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 500 })]), thin), 132.5, '別軸の壁は混ぜない');
  const sameLineOtherId = { id: 'cl1b', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0 };
  assert.equal(wallAssemblyThicknessMm(g([owner, wall(0, 4000, { lo: 100, hi: 200 }, null, sameLineOtherId)]), thin), 200 + 60, '別 id でも同じ通りなら同じ組（座標で見る）');
  assert.equal(wallAssemblyThicknessMm(g([owner, wall(4000, 5000, { lo: 500, hi: 600 })]), thin), 132.5, 'スパンが重ならない壁は混ぜない（端が接するだけ）');
  const gap = wall(1000, 2000, { lo: 200, hi: 300 });
  assert.equal(wallAssemblyThicknessMm(g([thin, gap]), thin), 300 - 60, '空隙があっても lo〜hi の全幅');
  assert.equal(wallAssemblyThicknessMm(g([]), wall(0, 10, null)), null, '範囲が引けない壁は null');
});

test('fitRoomJunction: 図のキー×壁厚で fit（メモ共有）。図が無いのは NO_FIGURE、壁厚に収まらないのは FIXED_EXCEEDS_TARGET、slot と基準の組が合わないのは UNSUPPORTED_DATUM', () => {
  install(wallBackedFigure('df-wb'));
  const a = fitRoomJunction({ figureKey: 'df-wb', slot: FLOOR_WALL, wallThicknessMm: 100 });
  assert.deepEqual(a.strokes[0].points.map(p => [p.s, p.t]), [[0, 0], [-5, 0], [-100, 0]]);
  assert.equal(fitRoomJunction({ figureKey: 'df-wb', slot: FLOOR_WALL, wallThicknessMm: 100 }), a, '同じ鍵はメモを返す');
  const thin = fitRoomJunction({ figureKey: 'df-wb', slot: FLOOR_WALL, wallThicknessMm: 4 });
  assert.equal(thin.error.code, DetailFitError.FIXED_EXCEEDS_TARGET);
  assert.equal(fitRoomJunction({ figureKey: 'df-none', slot: FLOOR_WALL, wallThicknessMm: 100 }).error.code, 'noFigure');
  // wallCeiling に FL の図を割り当てたら基準の組が合わない（失敗は {error}・例外にしない）
  assert.equal(fitRoomJunction({ figureKey: 'df-wb', slot: WALL_CEILING, wallThicknessMm: 100 }).error.code, 'unsupportedDatum');
});

test('collectRoomJunctionFailures: 正常な割当ては失敗に出ない。壁の無い部屋は fit を試さない', () => {
  install(wallBackedFigure('df-wb'));
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-wb' });
  assert.deepEqual(collectRoomJunctionFailures(graph), []);
  const bare = new PlanGraph(new Plane('p2', 0, '2階', 2, 1));
  const r2 = bare.addRoom(new Set(['a:b:c:d']), '壁なし');
  r2.setDetailRefs({ [FLOOR_WALL]: 'df-wb' });
  assert.deepEqual(collectRoomJunctionFailures(bare), [], '壁厚が引けない部屋は試さない');
});

test('【失敗系】collectRoomJunctionFailures: 参照切れは notFound、壁厚に収まらない図は fit 失敗の行になり、主語は部屋名・slot の日本語ラベルが文に入る', () => {
  install(wallBackedFigure('df-tight', FLOOR_WALL, 5000));
  const { graph, room } = graphWithRoom('LDK');
  room.setDetailRefs({ [FLOOR_WALL]: 'df-tight', [WALL_CEILING]: 'df-gone' });
  const failures = collectRoomJunctionFailures(graph);
  const notFound = failures.find(f => f.slot === WALL_CEILING);
  assert.equal(notFound.reason, ERR_DETAIL_FIGURE_NOT_FOUND(detailOwnerRoom('LDK'), WALL_CEILING));
  assert.equal(notFound.message, ERR_DETAIL_FIT_FAILED('df-gone', '部屋「LDK」', notFound.reason, WALL_CEILING));
  assert.ok(notFound.message.includes('部屋「LDK」 の壁と天井の詳細図がカタログに見つかりません'), notFound.message);
  assert.equal(notFound.wallThickness, undefined, '参照切れは壁厚を持たない');
  const fit = failures.find(f => f.slot === FLOOR_WALL);
  assert.equal(fit.roomId, room.id);
  assert.equal(fit.symbolKey, '部屋「LDK」');
  assert.ok(fit.wallThickness > 0);
  assert.equal(fit.label, 'テストdf-tight');
  assert.equal(fit.message, ERR_DETAIL_FIT_FAILED(fit.label, '部屋「LDK」', fit.reason, FLOOR_WALL));
  assert.ok(fit.message.includes('の床と壁に合わせられません'), fit.message);
});

test('collectRoomJunctionFailures: seen を共有すると同じ組は 1 回だけ。同じ壁厚の複数の壁は 1 行にまとまり、部屋が違えば別の行', () => {
  install(wallBackedFigure('df-tight', FLOOR_WALL, 5000));
  const { graph, room } = graphWithRoom('LDK');
  room.setDetailRefs({ [FLOOR_WALL]: 'df-tight' });
  const seen = new Set();
  const first = collectRoomJunctionFailures(graph, seen);
  assert.equal(first.length, roomWallThicknessesMm(graph, room).length, '壁厚ごとに 1 行（4 枚の壁が同じ壁厚なら 1 行）');
  assert.deepEqual(collectRoomJunctionFailures(graph, seen), [], 'seen が共有されていれば 2 回目は 0 件');
  const second = graphWithRoom('寝室');
  second.room.setDetailRefs({ [FLOOR_WALL]: 'df-tight' });
  assert.equal(collectRoomJunctionFailures(second.graph, seen).length, first.length, '別の部屋は別の行');
});

test('collectRoomJunctionFailures: 材マップの有無で材束縛の図の成否が変わる（未ロードの結果をメモに残さない）', () => {
  const MAT = '101000000001';
  const fig = wallBackedFigure('df-mat');
  // 5 mm の固定の手を材の厚みへ束縛する
  fig.strokes[0].moves[0] = { dir: 'L', len: { mm: 5, mode: 'material', code: MAT, field: 'thickness' } };
  install(fig);
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-mat' });
  const noMap = collectRoomJunctionFailures(graph, new Set());
  assert.ok(noMap.length >= 1 && noMap[0].reason.includes(MAT), '材マップ無しは未解決');
  const withMap = collectRoomJunctionFailures(graph, new Set(), { materialMap: new Map([[MAT, { thickness: 5, x: 0, y: 0 }]]) });
  assert.deepEqual(withMap, [], '後から材マップが渡れば解ける（未解決の結果をメモしていない）');
});

test('【失敗系】collectRoomJunctionFailures: 材はあるが厚みが null なら UNRESOLVED_MATERIAL でメモされず、材マップを差し替えて再実行すると解ける', () => {
  const MAT = '101000000002';
  const fig = wallBackedFigure('df-mat-null');
  fig.strokes[0].moves[0] = { dir: 'L', len: { mm: 5, mode: 'material', code: MAT, field: 'thickness' } };
  install(fig);
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-mat-null' });
  const nullThickness = collectRoomJunctionFailures(graph, new Set(), { materialMap: new Map([[MAT, { thickness: null, x: 0, y: 0 }]]) });
  assert.ok(nullThickness.length >= 1 && nullThickness[0].reason.includes(MAT), '厚み null は未解決');
  const resolved = collectRoomJunctionFailures(graph, new Set(), { materialMap: new Map([[MAT, { thickness: 5, x: 0, y: 0 }]]) });
  assert.deepEqual(resolved, [], '材マップを差し替えれば解ける（失敗をメモしていない）');
});
