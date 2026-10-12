// 天井の区画・形状（傾斜・円弧・ドーム・部屋の形状）を実機で確認するためのテスト用 .stq を作るスクリプト。
// 展開図に天伏情報を加味する課題（E0 足場）の検証データ。ceiling/ceilingHeightField.js の点問い合わせの期待値もここで確かめる。
//
// 元文書 ceiling-line-test.stq（moku4 由来。2階の主寝室に天井芯 X5460 と区画 左2400／右3000 がある）の2階へ、天井を持つ屋内部屋を使って付ける:
//   (a) 廊下   : 傾斜の区画（部屋の全セル・heightMm 2400・dims [600, 90]＝+y 向きに上がる。部屋の長辺は y）
//   (b) 納戸   : 円弧の区画（heightMm 2400・dims [400, 90]＝軸は y に平行。長辺は y）
//   (c) 予備室 : ドームの区画（heightMm 2300・dims [500]）
//   (d) 子ども1: 部屋レベルの形状（区画なし。setRoomCeilingShape で slope・dims [300, 0]）。CH は既定 2400
//   (e) 主寝室 : 区画（左 2400・右 3000）のまま（平面の段差の検証用）
// 区画の書込みは本番と同じ ceiling/ceilingZones.js createZone。
// 手順: 往復テスト先行 → 編集 → 見下げ・仕上げの格子が全階で不変 → 見上げの差分は2階だけ → buildCeilingHeightField の実測 → 編集後の往復テスト → 書き出し。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeCeilingZoneTestDoc.mjs [出力先.stq]
//   既定の出力先 D:/tatsuya/Download/ceiling-zone-test.stq。既存ファイルは上書きしない。
// 展開図 golden の基準採取（E0。展開図は未変更の状態。条件は --regen＝実アプリが開くときと同じく全階の壁を再生成。
//   保存済みの壁は現行の生成規則と揃っておらず〔2階 壁 61→63・3階 48→47〕、実機で見える姿は再生成後のため）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpElevFigure.mjs scripts/probe/golden-elev-ceiling/ceiling-zone-test D:/tatsuya/Download/ceiling-zone-test.stq --regen
//   node scripts/probe/diffElevGolden.mjs scripts/probe/golden-elev-ceiling/ceiling-zone-test <新しい出力dir>   … 一致で exit 0
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, planCutHeightMmOf, ceilingCutHeightMmOf } from '../../src/core.js';
import { getAllCells } from '../../src/finish/gridCells.js';
import { createZone } from '../../src/ceiling/ceilingZones.js';
import { setRoomCeilingShape, roomCeilingShapeOf } from '../../src/ceiling/roomCeilingShape.js';
import { buildCeilingHeightField } from '../../src/ceiling/ceilingHeightField.js';
import { planSolidsLayerPrimitives, planSolidsLayerPrimitivesUp } from '../../src/plan/planSolidsLayerFilter.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/ceiling-zone-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// ---- 往復（本番の保存〜読込みと同じ経路）と、ダイジェスト ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      centerLines: g.centerLines.map(c => `${c.id}:${c.centerLineType}:${c.value}:${c.discipline}:${c.lineType}:${c.labeled}:${c.extentLo}:${c.extentHi}`).sort(),
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.referenceRoomIds].sort()}:${[...r.cells].sort().join(',')}`).sort(),
      zones: g.rooms.map(r => `${r.id}:${r.ceilingZones.map(z => JSON.stringify(z.toData())).join('|')}`).sort(),
      shapes: g.rooms.map(r => `${r.id}:${JSON.stringify(roomCeilingShapeOf(r))}`).sort(),
    };
  }
  return JSON.stringify(out);
}
function roundTrip(project) {
  const floors = [...project.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
  const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: project.activePlaneId });
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const project2 = new Project('probe', 'probe');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
  const { planes, activePlaneId } = decodePlanes(doc.planes);
  for (const p of planes) {
    project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm);
  }
  for (const f of doc.floors) {
    const g = project2.graphMap.get(f.planeId);
    if (g) restoreGraph(g, f.bytes);
  }
  if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;
  return { json, project2 };
}
const fail = msg => { console.error(`NG: ${msg}`); process.exit(1); };

const srcPath = 'D:/tatsuya/Download/ceiling-line-test.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、2階の部屋へ傾斜・円弧・ドーム・部屋の形状を付ける ===`);

// ---- 1. 往復テスト先行（編集前）----
{
  const { project2 } = roundTrip(project);
  if (digestProject(project) !== digestProject(project2)) fail('往復テスト不一致（編集前。書いて読み直したダイジェストが元と異なる）');
  console.log('OK: 往復テスト一致（編集前）');
}

// ---- 編集前の出力（見下げ・見上げ。階ごと）と仕上げの格子 ----
function outputs(proj) {
  const down = {}, up = {}, finishCells = {};
  proj.planes.forEach((plane, idx) => {
    const graph = proj.graphMap.get(plane.id);
    const below = idx > 0 ? proj.planes[idx - 1] : null;
    const belowGraph = below ? proj.graphMap.get(below.id) : null;
    const belowPeek = belowGraph ? { graph: belowGraph, floorHeightMm: plane.elevation - below.elevation } : null;
    const above = idx + 1 < proj.planes.length ? proj.planes[idx + 1] : null;
    const aboveGraph = above ? proj.graphMap.get(above.id) : null;
    const abovePeek = aboveGraph ? { graph: aboveGraph, floorHeightMm: above.elevation - plane.elevation } : null;
    const selfRiserOf = s => stairRiserOf(s, proj, plane);
    const strip = ps => JSON.stringify(ps.map(p => ({ key: p.key, cls: p.cls, w: p.weight, pts: p.points, style: p.style, src: p.source?.id })));
    down[plane.name] = strip(planSolidsLayerPrimitives({ graph, belowPeek, selfRiserOf, cutZ: planCutHeightMmOf(plane) }));
    up[plane.name] = planSolidsLayerPrimitivesUp({ graph, abovePeek, selfRiserOf, cutZ: ceilingCutHeightMmOf(plane) });
    finishCells[plane.name] = JSON.stringify(getAllCells(graph));
  });
  return { down, up, finishCells };
}
const upStr = ps => JSON.stringify(ps.map(p => ({ key: p.key, pts: p.points, style: p.style, src: p.source?.id })));
const before = outputs(project);
const beforeUpStr = Object.fromEntries(Object.entries(before.up).map(([k, ps]) => [k, upStr(ps)]));

// ---- 2. 編集（2階）----
const plane2 = project.planes.find(p => p.name === '2階');
const g2 = project.graphMap.get(plane2.id);
const roomOf = name => {
  const hits = g2.rooms.filter(r => r.name === name);
  if (hits.length !== 1) fail(`2階の「${name}」が ${hits.length} 件（ceiling-line-test.stq の構成が変わった？）`);
  return hits[0];
};
const kairou = roomOf('廊下'), nando = roomOf('納戸'), yobi = roomOf('予備室'), kodomo = roomOf('子ども1'), shushin = roomOf('主寝室');
const zoneAll = (room, spec) => runInAction(() => {
  const { zones, zoneId } = createZone(g2, room, room.cells, spec);
  if (!zoneId) fail(`${room.name}: 区画が作れない（${JSON.stringify(spec)}）`);
  room.setCeilingZones(zones);
});
zoneAll(kairou, { heightMm: 2400, shape: 'slope', dims: [600, 90] });
zoneAll(nando, { heightMm: 2400, shape: 'arc', dims: [400, 90] });
zoneAll(yobi, { heightMm: 2300, shape: 'dome', dims: [500] });
runInAction(() => setRoomCeilingShape(kodomo, { shape: 'slope', dims: [300, 0] }));
console.log('付けたもの: 廊下=傾斜[600,90]・納戸=円弧[400,90]・予備室=ドーム[500]・子ども1=部屋の形状 傾斜[300,0]・主寝室=区画 2400/3000（元のまま）');

// ---- 2'. 他モードに漏れない: 見下げ・仕上げの格子は全階で編集前後で一致 ----
const after = outputs(project);
let leak = false;
for (const name of Object.keys(before.down)) {
  if (before.down[name] !== after.down[name]) { leak = true; console.error(`NG: 見下げ（平面）の出力が変わった: ${name}`); }
  if (before.finishCells[name] !== after.finishCells[name]) { leak = true; console.error(`NG: 仕上げの格子が変わった: ${name}`); }
}
if (leak) process.exit(1);
console.log('OK: 見下げ（平面）・仕上げの格子は全階で編集前後とも同一');

// ---- 3. 見上げは 2階だけ変わる ----
for (const name of Object.keys(beforeUpStr)) {
  const changed = beforeUpStr[name] !== upStr(after.up[name]);
  console.log(`  見上げ ${name}: ${changed ? '【差分あり】' : '（同一）'}`);
  if (changed !== (name === '2階')) fail(`見上げの差分が 2階だけになっていない（${name}）`);
}

// ---- 3'. 天井高の点問い合わせ（ceilingHeightField）の実測。期待値は形状の定義から独立に計算する ----
const field = buildCeilingHeightField(g2);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const rectsOf = room => field.surfaces.filter(s => s.roomId === room.id).flatMap(s => s.rects);
const centerOf = r => ({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 });
const bboxOf = rects => ({
  x1: Math.min(...rects.map(r => r.x1)), x2: Math.max(...rects.map(r => r.x2)),
  y1: Math.min(...rects.map(r => r.y1)), y2: Math.max(...rects.map(r => r.y2)),
});
const report = (label, x, y, z, expected, tol = 0.01) => {
  const ok = z !== undefined && near(z, expected, tol);
  console.log(`  ${ok ? 'OK' : 'NG'} ${label} (${x}, ${y}) zMm=${z === undefined ? 'null' : Math.round(z * 1000) / 1000} 期待 ${Math.round(expected * 1000) / 1000}`);
  if (!ok) process.exitCode = 1;
};
const zAtPt = (x, y) => field.zAt(x, y)?.zMm;
console.log('--- 代表点の天井高（層 FL 基準。ceilingHeightField.zAt）---');
{ // (a) 廊下: +y 向きに 2400→3000。bbox の y 範囲で線形。両端のセル（y1 / y2 に接するセル）の中心と、bbox 端 1mm 内側
  const rects = rectsOf(kairou), b = bboxOf(rects);
  console.log(`廊下 傾斜 bbox y ${b.y1}..${b.y2}`);
  for (const r of rects) {
    const c = centerOf(r);
    report('廊下', c.x, c.y, zAtPt(c.x, c.y), 2400 + 600 * (c.y - b.y1) / (b.y2 - b.y1));
  }
  const lowCell = centerOf(rects.find(r => r.y1 === b.y1)), highCell = centerOf(rects.find(r => r.y2 === b.y2));
  report('廊下 低い側の端', lowCell.x, b.y1 + 1, zAtPt(lowCell.x, b.y1 + 1), 2400 + 600 / (b.y2 - b.y1), 0.01);
  report('廊下 高い側の端', highCell.x, b.y2 - 1, zAtPt(highCell.x, b.y2 - 1), 3000 - 600 / (b.y2 - b.y1), 0.01);
}
{ // (b) 納戸: 軸 y に平行の円弧。幅 w は x 方向。中心線（x の中央）で 2400+400、縁で 2400
  const rects = rectsOf(nando), b = bboxOf(rects);
  const w = b.x2 - b.x1, rise = Math.min(400, w / 2), R = (w * w / 4 + rise * rise) / (2 * rise);
  const zArc = x => 2400 + Math.sqrt(R * R - (x - (b.x1 + b.x2) / 2) ** 2) - (R - rise);
  const cy = centerOf(rects[0]).y, xm = (b.x1 + b.x2) / 2;
  report('納戸 中心線', xm, cy, zAtPt(xm, cy), 2800);
  report('納戸 縁(左 1mm 内側)', b.x1 + 1, cy, zAtPt(b.x1 + 1, cy), zArc(b.x1 + 1));
  report('納戸 縁(右 1mm 内側)', b.x2 - 1, cy, zAtPt(b.x2 - 1, cy), zArc(b.x2 - 1));
}
{ // (c) 予備室: ドーム。各セル中心で積型放物面の式と一致。bbox の中心に最も近いセル中心が最も高い
  const rects = rectsOf(yobi), b = bboxOf(rects);
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2, hx = (b.x2 - b.x1) / 2, hy = (b.y2 - b.y1) / 2;
  let top = -Infinity;
  for (const r of rects) {
    const c = centerOf(r), p = (c.x - cx) / hx, q = (c.y - cy) / hy;
    const z = zAtPt(c.x, c.y);
    report('予備室', c.x, c.y, z, 2300 + 500 * (1 - p * p) * (1 - q * q));
    top = Math.max(top, z);
  }
  if (!(top > 2300 && top <= 2800)) fail(`予備室 ドームの最高点が (2300, 2800] に入らない: ${top}`);
}
{ // (d) 子ども1: 部屋の形状 傾斜 +x 向き 300。CH は既定 2400（床段差 0）。bbox の x 範囲で線形
  const rects = rectsOf(kodomo), b = bboxOf(rects);
  for (const r of rects) {
    const c = centerOf(r);
    report('子ども1', c.x, c.y, zAtPt(c.x, c.y), 2400 + 300 * (c.x - b.x1) / (b.x2 - b.x1));
  }
}
{ // (e) 主寝室: 左 2400・右 3000（天井芯 X5460 の両側）
  report('主寝室 左', 4550, -5460, zAtPt(4550, -5460), 2400);
  report('主寝室 右', 6370, -5460, zAtPt(6370, -5460), 3000);
  if (field.zAt(4550, -5460)?.roomId !== shushin.id) fail('主寝室の点が主寝室の面にならない');
}
if (process.exitCode) fail('代表点の天井高が期待値と一致しない');

// ---- 4. 編集後の往復テスト ----
const { json, project2 } = roundTrip(project);
if (digestProject(project) !== digestProject(project2)) fail('往復テスト不一致（編集後。区画・部屋の形状が書いて読み直して一致しない）');
const g2b = project2.graphMap.get(plane2.id);
const back = name => g2b.rooms.find(r => r.name === name);
const shapeOfZone = name => back(name).ceilingZones.map(z => z.shape).join(',');
if (shapeOfZone('廊下') !== 'slope' || shapeOfZone('納戸') !== 'arc' || shapeOfZone('予備室') !== 'dome' || roomCeilingShapeOf(back('子ども1')).shape !== 'slope') {
  fail('往復後に区画の形状または部屋の形状が失われた');
}
// 読み直した後の点問い合わせも同じ（保存形式を通しても高さが変わらない）
const field2 = buildCeilingHeightField(g2b);
for (const [x, y] of [[4550, -5460], [6370, -5460], ...rectsOf(kairou).map(centerOf).map(c => [c.x, c.y]), ...rectsOf(yobi).map(centerOf).map(c => [c.x, c.y])]) {
  if (field2.zAt(x, y)?.zMm !== field.zAt(x, y)?.zMm) fail(`往復後に天井高が変わった (${x}, ${y})`);
}
console.log('OK: 往復テスト一致（編集後。区画の形状・部屋の形状・点問い合わせの高さが書き戻し後も同一）');

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
