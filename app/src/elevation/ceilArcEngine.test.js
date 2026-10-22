// 円弧の天井断面（E4）を断面エンジンが弦の ceilProfile で受けることのテスト。
// 体裁の円弧（ceilArcSection.js）と同じ 3 点円から ceilProfileFromSegments が弦の列を作り、E3a-1 の仕組み
// （列の ceilEdge・切断壁の帯が斜線に沿う）がそのまま動く。期待値は手計算（R=(2100²+600²)/(2×600)=3975・中心 z=3000−3975）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildColumns } from './section/sectionEngine.js';
import { buildCutContent } from './section/sectionContent.js';
import { ceilProfileFromSegments, ceilProfileMaxZ } from './elevationBand.js';
import { ceilArcCircleOf, ceilArcZAt } from './ceilArcSection.js';

const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg} 実際:${a} 期待:${b}`);
const SEG = { loX: 0, hiX: 4200, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 2100, chMm: 3000 } };

function fixture(profile) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), x1 = cl(CenterLineType.VERTICAL, 4000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), y1 = cl(CenterLineType.HORIZONTAL, 3000);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'S');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', '3200');
  const cut = {
    seqNo: 'arc', line: { isVertical: false, axisValue: 1500, lo: -100, hi: 4100 },
    viewSign: 1, dirSign: 1, layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: ceilProfileMaxZ(profile) }, baseFloorZ: 0, ceilProfile: profile,
  };
  return { cut, probeCtx: makeProbeContext(cut.layers) };
}

test('【ceilProfile は弦の列】端は元の値・頭頂が節・hiZ は頭頂の 3000・弦と円弧の差 1mm 以下', () => {
  const profile = ceilProfileFromSegments([SEG], 4200, 2400);
  const c = ceilArcCircleOf(SEG);
  assert.ok(profile.length >= 4 && profile.length <= 64);
  assert.equal(profile[0].loX, 0); assert.equal(profile[0].ceilZ, 2400);
  assert.equal(profile.at(-1).hiX, 4200); assert.equal(profile.at(-1).ceilZHi, 2400);
  assert.ok(profile.some(s => s.hiX === 2100 && s.ceilZHi === 3000), '頭頂が節');
  assert.equal(ceilProfileMaxZ(profile), 3000, 'zRange.hiZ は頭頂込みの最大');
  for (const s of profile) {
    // 鉛直差＝同じ x での円弧と弦の高さの差（弦は円弧の内側＝負にならず 1mm 以下）
    for (let k = 0; k <= 20; k++) {
      const x = s.loX + ((s.hiX - s.loX) * k) / 20;
      const d = ceilArcZAt(c, x) - (s.ceilZ + ((s.ceilZHi - s.ceilZ) * (x - s.loX)) / (s.hiX - s.loX));
      assert.ok(d >= -1e-6 && d <= 1 + 1e-6, `鉛直差 1mm 以下 実際:${d}`);
    }
  }
});

test('【失敗系】ceilArc が作れない区間（頭頂が弦の上）は従来の 1 区間のまま（弦に刻まない）', () => {
  const profile = ceilProfileFromSegments([{ ...SEG, ceilArc: { alongX: 2100, chMm: 2400.1 } }], 4200, 2400);
  assert.deepEqual(profile, [{ loX: 0, hiX: 4200, ceilZ: 2400, ceilZHi: 2400 }]);
});

test('【壁の帯が弦に沿う】切断壁の上端は列の高い側の円弧の高さ以下（弦の分だけ 1.2mm 以内）で、平面の低い側（2400）で打ち切られない', () => {
  const { cut, probeCtx } = fixture(ceilProfileFromSegments([SEG], 4200, 2400));
  const c = ceilArcCircleOf(SEG);
  const cols = buildColumns(cut, probeCtx);
  const wallCols = cols.filter(col => col.bands.some(b => b.kind === 'cut'));
  assert.ok(wallCols.length >= 2, '左右の壁の列');
  for (const col of wallCols) {
    const wall = col.bands.find(b => b.kind === 'cut');
    const high = Math.max(ceilArcZAt(c, col.x0), ceilArcZAt(c, col.x1));
    assert.ok(wall.ceilEdge, `x=${col.x0}..${col.x1}: 天端が斜線（弦）に沿う帯`);
    assert.ok(wall.z1 > 2400, '低い側 2400 で打ち切られない');
    assert.ok(wall.z1 <= high + 1e-6 && wall.z1 > high - 1.2, `壁の上端 ${wall.z1} 円弧 ${high}`);
  }
  const outer = wallCols.map(col => col.bands.find(b => b.kind === 'cut').z1);
  near(Math.max(...outer), 2493.0425, '壁の内側端 x=157.5／4042.5 で円弧 2493.04 の 1.2mm 以内', 1.2);
});

test('【出力の全端点が円弧以下】断面エンジンの太線は円弧の高さを超えない（側縁は端の弦の高さで止まる）', () => {
  const { cut, probeCtx } = fixture(ceilProfileFromSegments([SEG], 4200, 2400));
  const c = ceilArcCircleOf(SEG);
  const lines = buildCutContent(cut, probeCtx).content.filter(p => p.type === 'line' && p.weight === 'thick');
  assert.ok(lines.some(p => p.x1 === p.x2 && -p.y1 > 2400 && -p.y1 < 2500 || p.x1 === p.x2 && -p.y2 > 2400 && -p.y2 < 2500), '側縁は 2400 超 2500 未満（円弧の高さ）で止まる');
  for (const p of lines) {
    assert.ok(-p.y1 <= ceilArcZAt(c, p.x1) + 1e-6 && -p.y2 <= ceilArcZAt(c, p.x2) + 1e-6,
      `太線 (${p.x1},${-p.y1})-(${p.x2},${-p.y2}) が円弧より上に出ている`);
  }
});
