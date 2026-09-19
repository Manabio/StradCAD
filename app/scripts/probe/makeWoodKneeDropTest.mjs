// 在来木造の腰壁・垂れ壁の自由端の端部材（structural/wallEndMember.js）を実データで検証するための
// テスト用 .stq を作るスクリプト（moku4.stq には腰壁・垂れ壁の指定が0件のため。
// .claude/team-lessons「実データに無い構成は往復テスト先行でテスト用.stqを作る」に従う）。
//
// moku4.stq の3階・自由端を持つ内壁2本へ設定する（座標は設計端＝CL位置。壁生成の再生成後の物理端は
// 自由端側がF-3の柱包み分（wallBase/2+wallFinish=72.5mm）だけ外へはね出す——例えばH壁は設計端
// x=0..910、再生成後の物理端はx=72.5..982.5になる。connectedな側の72.5は直交壁とのT字取り合いの
// 控え量で、F-3の自由端protrusionとは別物）:
//   - H壁 y=-9100, 設計端 x=0..910（3階。ユーザー指摘の「X1から910,Y4」に対応する自由端(910,-9100)）
//     → 腰壁 topHeight=1800（>PLAN_CUT_HEIGHT(1500)＝平面切断面が壁本体を貫く＝端部材の断面が
//     平面に出るケース）。
//   - V壁 x=1820, y:-9100..-6442.5（3階。ユーザー指摘の「X2,Y4」に対応する自由端(1820,-9100)）
//     → 垂れ壁 bottomHeight=1000（既定天井高2400 - 1000 = 1400 <= 1500＝切断面が壁本体を貫く
//     ケース。effectiveCeilingHeightで実測してから検証する）。
// さらに2階の同じ通り（(1820,-9100)。3h-2由来の既存自由端）へ低い腰壁 topHeight=800（<=1500＝
// 天板輪郭で描かれ、端部材の断面が出ないケース）を設定し、両方の分岐を1ファイルで確認できるようにする。
//
// キーは resolveWallSpanKey（壁の押下位置からの解決。手組みしない）で求める。isEligibleWallSpan
// （外壁・2a壁は対象外）で弾かれる場合は理由を報告して打ち切る。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeWoodKneeDropTest.mjs [出力先.stq]
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project } from '../../src/core.js';
import {
  isEligibleWallSpan, resolveWallSpanKey, effectiveCeilingHeight, validateKneeDropWall,
} from '../../src/finish/kneeDropWall.js';
import { buildCellToRoom } from '../../src/finish/edgeClassify.js';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/moku4_kd.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const srcPath = 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(srcPath);
console.log(`=== ${srcPath} を読み込み、3階・2階へ腰壁・垂れ壁を設定 ===`);

function findWall(graph, { isVertical, axisValue, endValue }) {
  return graph.walls.find(w => {
    if (w.isVertical !== isVertical || w.backingRange == null) return false;
    if (Math.abs(w.axisCL.effectiveValue - axisValue) > 5) return false;
    const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
    return Math.abs(lo - endValue) < 5 || Math.abs(hi - endValue) < 5;
  });
}

// 壁の内法側へ少しオフセットした押下位置（resolveWallSpanKeyのPRESS_SIDE_EPS相当。壁自身の
// axisOffset符号から内側方向を決める必要は無い——resolveWallSpanKey内部でwall.axisOffsetの符号を
// 見て解決するため、alongだけ壁の走行範囲内の値を渡せばよい）。
function spanKeyFor(graph, wall, alongInsideSpan) {
  const worldPos = wall.isVertical ? { x: 0, y: alongInsideSpan } : { x: alongInsideSpan, y: 0 };
  return resolveWallSpanKey(wall, worldPos, graph);
}

function setKneeOrDrop(label, graph, wall, alongInsideSpan, rec) {
  if (!isEligibleWallSpan(wall, graph)) throw new Error(`${label}: isEligibleWallSpanで対象外（外壁または2a壁）`);
  const key = spanKeyFor(graph, wall, alongInsideSpan);
  if (!key) throw new Error(`${label}: resolveWallSpanKeyがnull（グリッド外・格子未成立）`);
  const cellToRoom = buildCellToRoom(graph);
  const ceiling = effectiveCeilingHeight(graph, key, cellToRoom);
  const check = validateKneeDropWall(rec.knee?.topHeight ?? null, rec.drop?.bottomHeight ?? null, ceiling);
  console.log(`${label}: wall=${wall.id.slice(0, 8)} key=${key} ceiling=${ceiling} validate=`, check);
  if (!check.valid) throw new Error(`${label}: 検証に失敗: ${check.error}`);
  graph.setKneeDropWall(key, rec);
  return key;
}

const plane3 = project.planes.find(p => p.name === '3階');
const plane2 = project.planes.find(p => p.name === '2階');
const g3 = project.graphMap.get(plane3.id);
const g2 = project.graphMap.get(plane2.id);

// 3階: H壁 y=-9100, x:72.5..910（自由端(910,-9100)）→ 腰壁1800（切断面が貫く＝端部材の断面が出る）。
const hWall = findWall(g3, { isVertical: false, axisValue: -9100, endValue: 910 });
if (!hWall) throw new Error('3階のH壁（y=-9100, 端910）が見つかりません');
const kneeKey = setKneeOrDrop('3階 腰壁(H, 910側)', g3, hWall, 490, { knee: { topHeight: 1800 }, drop: null });

// 3階: V壁 x=1820, y:-9100..-6442.5（自由端(1820,-9100)）→ 垂れ壁（切断面が貫くbottomHeightを実測から決める）。
const vWall = findWall(g3, { isVertical: true, axisValue: 1820, endValue: -9100 });
if (!vWall) throw new Error('3階のV壁（x=1820, 端-9100）が見つかりません');
const dropVKey = spanKeyFor(g3, vWall, -7900);
if (!dropVKey) throw new Error('3階V壁: resolveWallSpanKeyがnull');
const dropCeiling3 = effectiveCeilingHeight(g3, dropVKey, buildCellToRoom(g3));
if (dropCeiling3 == null) throw new Error('3階V壁: 天井高さが解決できません');
const dropBottomHeight = Math.max(20, dropCeiling3 - 1400); // ceiling-bottomHeight=1400 <= PLAN_CUT_HEIGHT(1500)
console.log(`3階 垂れ壁(V, -9100側): ceiling=${dropCeiling3} → bottomHeight=${dropBottomHeight}（ceiling-bottomHeight=${dropCeiling3 - dropBottomHeight}）`);
const dropKey = setKneeOrDrop('3階 垂れ壁(V, -9100側)', g3, vWall, -7900, { knee: null, drop: { bottomHeight: dropBottomHeight } });

// 2階: V壁 x=1820, y:-9100..-6442.5（既存の3h-2由来の自由端(1820,-9100)。3階とは別の階・別Wall）
// → 低い腰壁800（<=PLAN_CUT_HEIGHT＝天板輪郭で描かれ、端部材の断面は出ない）。
const vWall2 = findWall(g2, { isVertical: true, axisValue: 1820, endValue: -9100 });
if (!vWall2) throw new Error('2階のV壁（x=1820, 端-9100）が見つかりません');
const lowKneeKey = setKneeOrDrop('2階 低い腰壁(V, -9100側)', g2, vWall2, -7900, { knee: { topHeight: 800 }, drop: null });

console.log('keys:', { kneeKey, dropKey, lowKneeKey });

// ---- 往復テスト（既存ファイルは上書きしない。書いて読み直して部屋・壁・腰壁垂れ壁のダイジェスト一致を確認） ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${w.axisCL.effectiveValue}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${[...r.cells].sort().join(',')}`).sort(),
      kneeDropWalls: [...g.kneeDropWalls.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`).sort(),
    };
  }
  return JSON.stringify(out);
}

const floors = [...project.planes].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const planesBytes = serializePlanes(project);
const json = buildDocumentJson({ floors, struct, planes: planesBytes, site: null, info: null, bootPlaneId: project.activePlaneId });

// 読み直して同じ digest になることを確認（loadDoc.mjsと同じ復元経路）。
const doc = parseDocumentEnvelope(JSON.parse(json));
const project2 = new Project('probe', 'probe');
restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
const { planes: decodedPlanes, activePlaneId } = decodePlanes(doc.planes);
for (const p of decodedPlanes) {
  project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId);
}
for (const f of doc.floors) {
  const g = project2.graphMap.get(f.planeId);
  if (g) restoreGraph(g, f.bytes);
}
if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;

const before = digestProject(project);
const after = digestProject(project2);
if (before !== after) {
  console.error('NG: 往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
  process.exitCode = 1;
} else {
  console.log('OK: 往復テスト一致（壁・部屋・腰壁垂れ壁のダイジェストが書き戻し後も同一）');
}

if (process.exitCode) process.exit(process.exitCode);

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
