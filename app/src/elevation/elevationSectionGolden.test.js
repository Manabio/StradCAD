// WP-G0（2.5D断面エンジン移行のゴールデン一致ゲート）: buildRoomBand（通常部屋帯）・
// buildVoidBand（吹抜け帯）の出力プリミティブ全体を正規化JSON（キー順ソート・数値はそのまま）で
// 固定する回帰テスト。C:\Users\tatsuya\AppData\Local\Temp\claude\...\section-engine-design.md §8。
//
// このテストは以後の全WP（sectionEngine等）のゲートとして機能する——差分が出たら
// 「エンジン起因かの切り分け（git stash等）をせずに自己判断で修正しない」。
// 更新履歴: ユーザー明示指示2026-08その13で寸法線の足をCLから実画面3mm手前で止めるようにし、
// `foot`の値だけが変わったため再生成した（他のキー・値は不変であることを構造比較で確認済み）。
// 更新履歴: 問題修正2026-08その9で一点鎖線に`dashAnchor`（寸法行へ位相を合わせるアンカー）を
// 追加したためゴールデンを再生成した。既存の値は1つも変わっておらず、差分は`dash:'center'`の線への
// 同キー追加のみであることを構造比較で確認済み（＝エンジン起因の変化ではないと切り分け済み）。
// 更新履歴: 「壁の輪郭を断面エンジンへ一本化」で吹抜け帯（buildVoidBand）も共通経路
// （appendBandCutContent→buildCutContent）を通すようにしたため、ケース3だけ再生成した。
// 差分は**追加16本のみ**（削除・値の変更は0本）で、その全てが既存の端の縦線
// （x=面端・weight:'medium'・y=-2400..2900）を**層境界 y=0 で2分割した部分線分**
// （2900..0＝下階の壁／0..-2400＝設置階の壁）——合併すると元の1本と同一区間・同一線種に
// なるため、描画結果は変わらない（1本ずつ照合済み）。ケース1・2（buildRoomBand）は
// 断面エンジンを通した後も**完全一致のまま**＝通常の部屋帯の見た目は不変。
// フィクスチャはelevationBand.test.js/elevationVoid.test.jsの既存ヘルパをそのまま再利用する
// （通常矩形部屋=elevationBand.test.js:29相当、段差付き部屋=elevationBand.test.js:332相当、
// 吹抜け2層=elevationVoid.test.js:36相当）。ゴールデン値は初回実行時の実出力をそのまま埋め込む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { buildRoomBand } from './elevationBand.js';
import { buildVoidBand } from './elevationVoid.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildColumns } from './section/sectionEngine.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './section/sectionCutPlane.js';

function makeGraph(name = 'p1', elevation = 0) {
  const plane = new Plane(name, elevation, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// キー順ソート（配列順は保持。数値はそのまま）。
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function normalize(primitives) {
  return JSON.stringify(sortKeys(primitives));
}

// ---- ケース1: 通常矩形部屋（elevationBand.test.js:29相当） ----
const GOLDEN_NORMAL_RECT = '[{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":4000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4200,"x2":4200,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":7085,"x2":7085,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7142.5,"x2":7142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4142.5,"label":3000,"to":7142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":5642.5,"y":900},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7400,"x2":7400,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7342.5,"x2":7342.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11342.5,"x2":11342.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7342.5,"label":4000,"to":11342.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":9342.5,"y":900},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":11600,"x2":11600,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":14485,"x2":14485,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11542.5,"x2":11542.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":14542.5,"x2":14542.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":11542.5,"label":3000,"to":14542.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":13042.5,"y":900},{"h":400,"type":"rect","w":1200,"x":6392.5,"y":1400},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":6992.5,"y":1600},{"type":"line","weight":"thin","x1":-857.5,"x2":6392.5,"y1":1600,"y2":1600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1600},{"type":"line","weight":"thin","x1":7592.5,"x2":14842.5,"y1":1600,"y2":1600},{"dir":-1,"type":"miterTriangle","x":14842.5,"y":1600}]';

test('【WP-G0】ゴールデン一致: buildRoomBand（通常矩形部屋）の出力プリミティブが正規化JSONで完全一致する', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const band = buildRoomBand(room, graph, { project: { openingNumberIndex: new Map() } });
  assert.equal(normalize(band.primitives), GOLDEN_NORMAL_RECT);
});

// ---- ケース2: 段差付き部屋（部分指定floorLevel+300。elevationBand.test.js:332相当） ----
const GOLDEN_STEP_ROOM = '[{"type":"line","weight":"thick","x1":0,"x2":1885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":1885,"x2":3885,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":1885,"x2":1885,"y1":0,"y2":-300},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":-300},{"at":4442.5,"dir":"v","dot":true,"foot":4032.5,"from":-2400,"label":2100,"to":-300,"type":"dim"},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":1942.5,"x2":1942.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":2000,"to":1942.5,"type":"dim"},{"at":600,"dir":"h","dot":true,"from":1942.5,"label":2000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":5200,"x2":8085,"y1":0,"y2":0},{"type":"line","weight":"medium","x1":5200,"x2":8085,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":5200,"x2":5200,"y1":0,"y2":-2400},{"type":"line","weight":"thick","x1":8085,"x2":8085,"y1":0,"y2":-2400},{"type":"line","weight":"thick","x1":5200,"x2":8085,"y1":-2400,"y2":-2400},{"h":2100,"type":"rect","w":2885,"weight":"medium","x":5200,"y":-2400},{"dash":"center","type":"line","weight":"thin","x1":5200,"x2":8085,"y1":-2400,"y2":-300},{"dash":"center","type":"line","weight":"thin","x1":8085,"x2":5200,"y1":-2400,"y2":-300},{"anchor":"middle","baseline":"middle","text":"ア キ","type":"text","x":6642.5,"y":-1350},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":5142.5,"x2":5142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":8142.5,"x2":8142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":5142.5,"label":3000,"to":8142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B1","type":"text","x":6642.5,"y":900},{"at":4642.5,"dir":"v","dot":true,"foot":5052.5,"from":-2400,"label":2400,"to":0,"type":"dim"},{"type":"line","weight":"thick","x1":8900,"x2":11785,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":8900,"x2":11785,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":8900,"x2":8900,"y1":-2400,"y2":-300},{"type":"line","weight":"medium","x1":11785,"x2":11785,"y1":-2400,"y2":-300},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":8842.5,"x2":8842.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11842.5,"x2":11842.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":8842.5,"label":3000,"to":11842.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B2","type":"text","x":10342.5,"y":900},{"at":8342.5,"dir":"v","dot":true,"foot":8752.5,"from":-2400,"label":2100,"to":-300,"type":"dim"},{"type":"line","weight":"thick","x1":12100,"x2":14100,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":14100,"x2":15985,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":14100,"x2":14100,"y1":-300,"y2":0},{"type":"line","weight":"thick","x1":12100,"x2":15985,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":12100,"x2":12100,"y1":-2400,"y2":-300},{"type":"line","weight":"medium","x1":15985,"x2":15985,"y1":-2400,"y2":0},{"at":16542.5,"dir":"v","dot":true,"foot":16132.5,"from":-2400,"label":2400,"to":0,"type":"dim"},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":12042.5,"x2":12042.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":14042.5,"x2":14042.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":16042.5,"x2":16042.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":12042.5,"label":2000,"to":14042.5,"type":"dim"},{"at":600,"dir":"h","dot":true,"from":14042.5,"label":2000,"to":16042.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":14042.5,"y":900},{"type":"line","weight":"thick","x1":16800,"x2":19685,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":16800,"x2":19685,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":16800,"x2":16800,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":19685,"x2":19685,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":16742.5,"x2":16742.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":19742.5,"x2":19742.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":16742.5,"label":3000,"to":19742.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":18242.5,"y":900},{"h":400,"type":"rect","w":1200,"x":8992.5,"y":1400},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":9592.5,"y":1600},{"type":"line","weight":"thin","x1":-857.5,"x2":8992.5,"y1":1600,"y2":1600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1600},{"type":"line","weight":"thin","x1":10192.5,"x2":20042.5,"y1":1600,"y2":1600},{"dir":-1,"type":"miterTriangle","x":20042.5,"y":1600}]';

test('【WP-G0】ゴールデン一致: buildRoomBand（段差付き部屋・部分指定floorLevel+300）の出力プリミティブが正規化JSONで完全一致する', () => {
  const graph = makeGraph();
  const x0   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x1   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const leftKey  = `${x0.id}:${y0.id}:${xMid.id}:${y1.id}`;
  const rightKey = `${xMid.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([leftKey, rightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([rightKey]), '小上がり', undefined, new Set([room.id]));
  child.setFloorLevel(300);

  const band = buildRoomBand(room, graph, { project: { openingNumberIndex: new Map() } });
  assert.equal(normalize(band.primitives), GOLDEN_STEP_ROOM);
});

// ---- ケース3: 吹抜け2層帯（elevationVoid.test.js:36相当） ----
const GOLDEN_VOID_2LAYER = '[{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":2900},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":4000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":5300,"to":2900,"type":"dim"},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4200,"x2":4200,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":7085,"x2":7085,"y1":-2400,"y2":2900},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7142.5,"x2":7142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4142.5,"label":3000,"to":7142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":5642.5,"y":900},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7400,"x2":7400,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2400,"y2":2900},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7342.5,"x2":7342.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11342.5,"x2":11342.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7342.5,"label":4000,"to":11342.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":9342.5,"y":900},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":11600,"x2":11600,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":14485,"x2":14485,"y1":-2400,"y2":2900},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11542.5,"x2":11542.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":14542.5,"x2":14542.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":11542.5,"label":3000,"to":14542.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":13042.5,"y":900},{"__o":"recessLo","type":"line","weight":"medium","x1":0,"x2":0,"y1":2900,"y2":0},{"__o":"recessHi","type":"line","weight":"medium","x1":3885,"x2":3885,"y1":2900,"y2":0},{"__o":"recessLo","type":"line","weight":"medium","x1":0,"x2":0,"y1":0,"y2":-2400},{"__o":"recessHi","type":"line","weight":"medium","x1":3885,"x2":3885,"y1":0,"y2":-2400},{"__o":"recessLo","type":"line","weight":"medium","x1":4200,"x2":4200,"y1":2900,"y2":0},{"__o":"recessHi","type":"line","weight":"medium","x1":7085,"x2":7085,"y1":2900,"y2":0},{"__o":"recessLo","type":"line","weight":"medium","x1":4200,"x2":4200,"y1":0,"y2":-2400},{"__o":"recessHi","type":"line","weight":"medium","x1":7085,"x2":7085,"y1":0,"y2":-2400},{"__o":"recessLo","type":"line","weight":"medium","x1":7400,"x2":7400,"y1":2900,"y2":0},{"__o":"recessHi","type":"line","weight":"medium","x1":11285,"x2":11285,"y1":2900,"y2":0},{"__o":"recessLo","type":"line","weight":"medium","x1":7400,"x2":7400,"y1":0,"y2":-2400},{"__o":"recessHi","type":"line","weight":"medium","x1":11285,"x2":11285,"y1":0,"y2":-2400},{"__o":"recessLo","type":"line","weight":"medium","x1":11600,"x2":11600,"y1":2900,"y2":0},{"__o":"recessHi","type":"line","weight":"medium","x1":14485,"x2":14485,"y1":2900,"y2":0},{"__o":"recessLo","type":"line","weight":"medium","x1":11600,"x2":11600,"y1":0,"y2":-2400},{"__o":"recessHi","type":"line","weight":"medium","x1":14485,"x2":14485,"y1":0,"y2":-2400},{"h":400,"type":"rect","w":1200,"x":6392.5,"y":3400},{"anchor":"middle","baseline":"middle","text":"吹抜け","type":"text","x":6992.5,"y":3600},{"type":"line","weight":"thin","x1":-857.5,"x2":6392.5,"y1":3600,"y2":3600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":3600},{"type":"line","weight":"thin","x1":7592.5,"x2":14842.5,"y1":3600,"y2":3600},{"dir":-1,"type":"miterTriangle","x":14842.5,"y":3600}]';

test('【WP-G0】ゴールデン一致: buildVoidBand（吹抜け2層帯）の出力プリミティブが正規化JSONで完全一致する', () => {
  const graph = makeGraph('p1', 2900);
  const voidRoom = makeRectRoom(graph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  const lowerGraph = makeGraph('p0', 0);
  makeRectRoom(lowerGraph, 0, 0, 4000, 3000, 'LDK');
  const floorHeightBelowMm = 2900;

  const band = buildVoidBand(voidRoom, graph, lowerGraph, { floorHeightBelowMm });
  assert.equal(normalize(band.primitives), GOLDEN_VOID_2LAYER);
});

// ---- 失敗系: 正規化関数自体が並び替えても差分を検知することを保証する（変異への感度チェック） ----
test('【失敗系・WP-G0】normalize: プリミティブの並びが変わればゴールデンと不一致になる（ゲートの実効性）', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const band = buildRoomBand(room, graph, { project: { openingNumberIndex: new Map() } });
  const reordered = [...band.primitives].reverse();
  assert.notEqual(normalize(reordered), GOLDEN_NORMAL_RECT);
});

// ============================================================================
// 「壁の輪郭を断面エンジンへ一本化」の視覚回帰ゲート（ケース4〜7）
//
// 上のケース1〜3は矩形・段差だけで、移行対象4つ（袖壁・腰壁の断面枠／腰壁の天端・端部／
// アキ／開放スパン）を1つも通らない——**移行の差分を検知できないゴールデン**だった。
// 移行の各ステップで差分を取り「増減した線を1本ずつ説明できること」を条件にするため、
// 4つの対象それぞれを最小構成で通すケースを固定する。
//
// 腰壁は**室内の間仕切り**に置く（確定仕様「外壁除外」。外壁に置いた合成は実機に存在しない
// 構成であり、腰壁の上に現実には無い「外部が見えている」断面をエンジンへ与えてしまう）。
// ============================================================================

const V = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const H = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
const BAND_CTX = { project: { openingNumberIndex: new Map() } };

/**
 * 2室（LDK 0..4000×0..3000 ／ 和室 同幅×3000..6000）が y=3000 の間仕切りを共有する図。
 * LDK側の面C（y=3000）の左半分 x=0..2000 に腰壁・垂れ壁レコードを置く。
 * @param {{knee?:object, drop?:object}} rec
 */
function makeTwoRoomsWithKneeSpan(rec) {
  const graph = makeGraph();
  const x0 = V(graph, 0), xm = V(graph, 2000), x1 = V(graph, 4000);
  const y0 = H(graph, 0), ym = H(graph, 3000), y1 = H(graph, 6000);
  const ldk = graph.addRoom(new Set([
    `${x0.id}:${y0.id}:${xm.id}:${ym.id}`, `${xm.id}:${y0.id}:${x1.id}:${ym.id}`,
  ]), 'LDK');
  generateRoomWallsFromOutline(graph, ldk);
  const wa = graph.addRoom(new Set([
    `${x0.id}:${ym.id}:${xm.id}:${y1.id}`, `${xm.id}:${ym.id}:${x1.id}:${y1.id}`,
  ]), '和室');
  generateRoomWallsFromOutline(graph, wa);
  graph.setKneeDropWall(edgeKey(ym.id, x0.id, xm.id), rec);
  return { graph, room: ldk };
}

/** 矩形室（0..6000×0..3000）の面A（y=0）へ、x=3000から室内へ突き出す腰壁袖壁（高さ900）。 */
function makeRoomWithKneeSleeveWall() {
  const graph = makeGraph();
  const x0 = V(graph, 0), x1 = V(graph, 6000), y0 = H(graph, 0), y1 = H(graph, 3000);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  // 袖壁は**片面ずつのWallオブジェクト**（sectionEmit.jsのcutWallRuns参照）。実データと同じ
  // 構成（軸CLから±57.5・仕上げ12.5）で2枚置く。
  const sx = V(graph, 3000), ys = H(graph, 800);
  graph.addWall(sx,  57.5, true, y0, 0, ys, 0, { isRoomWall: false, isExteriorWall: false, wallFinish: 12.5 });
  graph.addWall(sx, -57.5, true, y0, 0, ys, 0, { isRoomWall: false, isExteriorWall: false, wallFinish: 12.5 });
  graph.setKneeDropWall(edgeKey(sx.id, y0.id, ys.id), { knee: { topHeight: 900 } });
  return { graph, room };
}

/**
 * 開放スパン（elevationOpenSpan.test.jsのmakeWallThenOpenRoomと同型）: 上段は他室との実壁、
 * 下段は同室内が壁なしで継続し、その先の床がFL+300。
 */
function makeOpenSpanRoom() {
  const graph = makeGraph();
  const x0 = V(graph, 0), x1 = V(graph, 2000), x2 = V(graph, 4000);
  const y0 = H(graph, 0), y1 = H(graph, 1000), y2 = H(graph, 2000);
  const other = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), '他室');
  generateRoomWallsFromOutline(graph, other);
  const room = graph.addRoom(new Set([
    `${x0.id}:${y0.id}:${x1.id}:${y1.id}`,
    `${x0.id}:${y1.id}:${x1.id}:${y2.id}`,
    `${x1.id}:${y1.id}:${x2.id}:${y2.id}`,
  ]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([`${x1.id}:${y1.id}:${x2.id}:${y2.id}`]), '部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(300);
  return { graph, room };
}

const GOLDEN_KNEE_SPAN = '[{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":4000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4200,"x2":4200,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":7085,"x2":7085,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7142.5,"x2":7142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4142.5,"label":3000,"to":7142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":5642.5,"y":900},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7400,"x2":7400,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7342.5,"x2":7342.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11342.5,"x2":11342.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7342.5,"label":4000,"to":11342.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":9342.5,"y":900},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":11600,"x2":11600,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":14485,"x2":14485,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11542.5,"x2":11542.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":14542.5,"x2":14542.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":11542.5,"label":3000,"to":14542.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":13042.5,"y":900},{"__o":"recessHi","type":"line","weight":"medium","x1":9342.5,"x2":9342.5,"y1":-900,"y2":-2400},{"type":"line","weight":"medium","x1":9342.5,"x2":11285,"y1":-900,"y2":-900},{"type":"line","weight":"thin","x1":9342.5,"x2":11285,"y1":-850,"y2":-850},{"__o":"recessHi","type":"line","weight":"medium","x1":11285,"x2":11285,"y1":0,"y2":-900},{"h":1500,"type":"rect","w":1942.5,"weight":"medium","x":9342.5,"y":-2400},{"anchor":"middle","baseline":"middle","text":"ア キ","type":"text","x":10313.75,"y":-1650},{"dash":"center","type":"line","weight":"thin","x1":9342.5,"x2":11285,"y1":-900,"y2":-2400},{"dash":"center","type":"line","weight":"thin","x1":9342.5,"x2":11285,"y1":-2400,"y2":-900},{"h":400,"type":"rect","w":1200,"x":6392.5,"y":1400},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":6992.5,"y":1600},{"type":"line","weight":"thin","x1":-857.5,"x2":6392.5,"y1":1600,"y2":1600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1600},{"type":"line","weight":"thin","x1":7592.5,"x2":14842.5,"y1":1600,"y2":1600},{"dir":-1,"type":"miterTriangle","x":14842.5,"y":1600}]';

test('【視覚回帰】ゴールデン一致: 腰壁（室内間仕切りの一部が高さ900）の帯', () => {
  const { graph, room } = makeTwoRoomsWithKneeSpan({ knee: { topHeight: 900 }, drop: null });
  assert.equal(normalize(buildRoomBand(room, graph, BAND_CTX).primitives), GOLDEN_KNEE_SPAN);
});

const GOLDEN_KNEE_SLEEVE = '[{"type":"line","weight":"thick","x1":0,"x2":3092.5,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":0,"x2":3092.5,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":2942.5,"x2":2942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":3000,"to":2942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A1","type":"text","x":1442.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":3350,"x2":6385,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":3350,"x2":6385,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":6385,"x2":6385,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3442.5,"x2":3442.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":6442.5,"x2":6442.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":3442.5,"label":3000,"to":6442.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A2","type":"text","x":4942.5,"y":900},{"type":"line","weight":"thick","x1":6700,"x2":9585,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":6700,"x2":9585,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":6700,"x2":6700,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":9585,"x2":9585,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":6642.5,"x2":6642.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":9642.5,"x2":9642.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":6642.5,"label":3000,"to":9642.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":8142.5,"y":900},{"type":"line","weight":"thick","x1":9900,"x2":15785,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":9900,"x2":15785,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":9900,"x2":9900,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":15785,"x2":15785,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":9842.5,"x2":9842.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":15842.5,"x2":15842.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":9842.5,"label":6000,"to":15842.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":12842.5,"y":900},{"type":"line","weight":"thick","x1":16100,"x2":18985,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":16100,"x2":18985,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":16100,"x2":16100,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":18985,"x2":18985,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":16042.5,"x2":16042.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":19042.5,"x2":19042.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":16042.5,"label":3000,"to":19042.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":17542.5,"y":900},{"__o":"cutEdgeLo","type":"line","weight":"thick","x1":2885,"x2":2885,"y1":0,"y2":-900},{"__o":"cutEdgeHi","type":"line","weight":"thick","x1":3000,"x2":3000,"y1":0,"y2":-900},{"type":"line","weight":"thick","x1":2885,"x2":3000,"y1":-900,"y2":-900},{"type":"line","weight":"thin","x1":2885,"x2":3000,"y1":-850,"y2":-850},{"__o":"cutEdgeLo","type":"line","weight":"thick","x1":3385,"x2":3385,"y1":0,"y2":-900},{"__o":"cutEdgeHi","type":"line","weight":"thick","x1":3500,"x2":3500,"y1":0,"y2":-900},{"type":"line","weight":"thick","x1":3385,"x2":3500,"y1":-900,"y2":-900},{"type":"line","weight":"thin","x1":3385,"x2":3500,"y1":-850,"y2":-850},{"h":400,"type":"rect","w":1200,"x":8642.5,"y":1400},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":9242.5,"y":1600},{"type":"line","weight":"thin","x1":-857.5,"x2":8642.5,"y1":1600,"y2":1600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1600},{"type":"line","weight":"thin","x1":9842.5,"x2":19342.5,"y1":1600,"y2":1600},{"dir":-1,"type":"miterTriangle","x":19342.5,"y":1600}]';

test('【視覚回帰】ゴールデン一致: 腰壁袖壁で面が2断片に分割される帯（袖壁の断面枠）', () => {
  const { graph, room } = makeRoomWithKneeSleeveWall();
  assert.equal(normalize(buildRoomBand(room, graph, BAND_CTX).primitives), GOLDEN_KNEE_SLEEVE);
});

const GOLDEN_KNEE_DROP_GAP = '[{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":4000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4200,"x2":4200,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":7085,"x2":7085,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7142.5,"x2":7142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4142.5,"label":3000,"to":7142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":5642.5,"y":900},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7400,"x2":7400,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7342.5,"x2":7342.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11342.5,"x2":11342.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7342.5,"label":4000,"to":11342.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":9342.5,"y":900},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":11600,"x2":11600,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":14485,"x2":14485,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":11542.5,"x2":11542.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":14542.5,"x2":14542.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":11542.5,"label":3000,"to":14542.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":13042.5,"y":900},{"__o":"recessHi","type":"line","weight":"medium","x1":9342.5,"x2":9342.5,"y1":-900,"y2":-2000},{"type":"line","weight":"medium","x1":9342.5,"x2":11285,"y1":-900,"y2":-900},{"type":"line","weight":"thin","x1":9342.5,"x2":11285,"y1":-850,"y2":-850},{"__o":"recessHi","type":"line","weight":"medium","x1":11285,"x2":11285,"y1":0,"y2":-900},{"type":"line","weight":"medium","x1":9342.5,"x2":11285,"y1":-2000,"y2":-2000},{"__o":"recessHi","type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2000,"y2":-2400},{"h":1100,"type":"rect","w":1942.5,"weight":"medium","x":9342.5,"y":-2000},{"anchor":"middle","baseline":"middle","text":"ア キ","type":"text","x":10313.75,"y":-1450},{"dash":"center","type":"line","weight":"thin","x1":9342.5,"x2":11285,"y1":-900,"y2":-2000},{"dash":"center","type":"line","weight":"thin","x1":9342.5,"x2":11285,"y1":-2000,"y2":-900},{"h":400,"type":"rect","w":1200,"x":6392.5,"y":1400},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":6992.5,"y":1600},{"type":"line","weight":"thin","x1":-857.5,"x2":6392.5,"y1":1600,"y2":1600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1600},{"type":"line","weight":"thin","x1":7592.5,"x2":14842.5,"y1":1600,"y2":1600},{"dir":-1,"type":"miterTriangle","x":14842.5,"y":1600}]';

test('【視覚回帰】ゴールデン一致: アキ（腰壁900＋垂れ壁 下端400）のある帯', () => {
  const { graph, room } = makeTwoRoomsWithKneeSpan({ knee: { topHeight: 900 }, drop: { bottomHeight: 400 } });
  assert.equal(normalize(buildRoomBand(room, graph, BAND_CTX).primitives), GOLDEN_KNEE_DROP_GAP);
});

const GOLDEN_OPEN_SPAN = '[{"type":"line","weight":"thick","x1":0,"x2":1885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":0,"x2":1885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":1885,"x2":1885,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":1942.5,"x2":1942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":2000,"to":1942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A1","type":"text","x":942.5,"y":900},{"at":-557.5,"dir":"v","dot":true,"foot":-147.5,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":2200,"x2":4085,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":2200,"x2":4085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":2200,"x2":2200,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":4085,"x2":4085,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3200,"x2":4085,"y1":-300,"y2":-300},{"h":2100,"type":"rect","w":885,"weight":"medium","x":3200,"y":-2400},{"dash":"center","type":"line","weight":"thin","x1":3200,"x2":4085,"y1":-2400,"y2":-300},{"dash":"center","type":"line","weight":"thin","x1":4085,"x2":3200,"y1":-2400,"y2":-300},{"anchor":"middle","baseline":"middle","text":"ア キ","type":"text","x":3642.5,"y":-1350},{"type":"line","weight":"medium","x1":3200,"x2":3200,"y1":0,"y2":-2400},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":2142.5,"x2":2142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":3142.5,"x2":3142.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":2142.5,"label":1000,"to":3142.5,"type":"dim"},{"at":600,"dir":"h","dot":true,"from":3142.5,"label":1000,"to":4142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B1","type":"text","x":3142.5,"y":900},{"type":"line","weight":"thick","x1":4285,"x2":4435,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":4435,"x2":6435,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":4435,"x2":4435,"y1":0,"y2":-300},{"type":"line","weight":"thick","x1":4285,"x2":6435,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4435,"x2":4435,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":6435,"x2":6435,"y1":-2400,"y2":-300},{"at":6992.5,"dir":"v","dot":true,"foot":6582.5,"from":-2400,"label":2100,"to":-300,"type":"dim"},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":4492.5,"x2":4492.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":6492.5,"x2":6492.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4492.5,"label":2000,"to":6492.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A2","type":"text","x":5492.5,"y":900},{"type":"line","weight":"thick","x1":7250,"x2":8135,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":7250,"x2":8135,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7250,"x2":7250,"y1":-2400,"y2":-300},{"type":"line","weight":"medium","x1":8135,"x2":8135,"y1":-2400,"y2":-300},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":7192.5,"x2":7192.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":8192.5,"x2":8192.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7192.5,"label":1000,"to":8192.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B2","type":"text","x":7692.5,"y":900},{"type":"line","weight":"thick","x1":8450,"x2":10450,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":10450,"x2":12335,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":10450,"x2":10450,"y1":-300,"y2":0},{"type":"line","weight":"thick","x1":8450,"x2":12335,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":8450,"x2":8450,"y1":-2400,"y2":-300},{"type":"line","weight":"medium","x1":12335,"x2":12335,"y1":-2400,"y2":0},{"at":12892.5,"dir":"v","dot":true,"foot":12482.5,"from":-2400,"label":2400,"to":0,"type":"dim"},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":8392.5,"x2":8392.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":10392.5,"x2":10392.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":12392.5,"x2":12392.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":8392.5,"label":2000,"to":10392.5,"type":"dim"},{"at":600,"dir":"h","dot":true,"from":10392.5,"label":2000,"to":12392.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":10392.5,"y":900},{"type":"line","weight":"thick","x1":13150,"x2":15035,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":13150,"x2":15035,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":13150,"x2":13150,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":15035,"x2":15035,"y1":-2400,"y2":0},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":13092.5,"x2":13092.5,"y1":-2550,"y2":600},{"dash":"center","dashAnchor":600,"type":"line","weight":"thin","x1":15092.5,"x2":15092.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":13092.5,"label":2000,"to":15092.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":14092.5,"y":900},{"__o":"recessLo","type":"line","weight":"thin","x1":3200,"x2":3200,"y1":0,"y2":-2400},{"__o":"recessHi","type":"line","weight":"thin","x1":4085,"x2":4085,"y1":0,"y2":-2400},{"__o":"recessHi","type":"line","weight":"thin","x1":4435,"x2":4435,"y1":0,"y2":-2400},{"h":400,"type":"rect","w":1200,"x":6667.5,"y":1400},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":7267.5,"y":1600},{"type":"line","weight":"thin","x1":-857.5,"x2":6667.5,"y1":1600,"y2":1600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1600},{"type":"line","weight":"thin","x1":7867.5,"x2":15392.5,"y1":1600,"y2":1600},{"dir":-1,"type":"miterTriangle","x":15392.5,"y":1600}]';

test('【視覚回帰】ゴールデン一致: 開放スパン（壁区間の先が同室内で壁なし・開放先FL+300）のある帯', () => {
  const { graph, room } = makeOpenSpanRoom();
  assert.equal(normalize(buildRoomBand(room, graph, BAND_CTX).primitives), GOLDEN_OPEN_SPAN);
});

// ---- 手順1のゲート: 単層スタックでも断面エンジンが期待どおりの列を返す ----
test('【手順1】単層スタック（自階のみ）でも断面エンジンが面全域を覆う列を返し、壁を見えがかりとして拾う', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const faces = composeRoomFaces(room, graph);
  const CH = roomCeilingHeight(graph, room).mm;
  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  const probeCtx = makeProbeContext(layers);
  for (const face of faces) {
    // 仮想切断線は面の軸から室内側へ下がる（壁芯ちょうどだと切断面が壁の中を通り、
    // 見えがかり候補も所有Roomも取れない。sectionCutPlane.js冒頭）。単層でも効くこと。
    const offsetMm = cutPlaneOffsetMm(face, layers);
    assert.ok(offsetMm > 0, `${face.label}: 単層でも切断面オフセットが正になるはず（実際:${offsetMm}）`);
    const cut = {
      seqNo: face.label, dirSign: face.dirSign, face, viewSign: faceViewSign(face),
      line: faceCutLine(face, offsetMm), layers, zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
      ceilProfile: [{ loX: 0, hiX: face.run, ceilZ: CH }],
    };
    const columns = buildColumns(cut, probeCtx);
    assert.ok(columns.length > 0, `${face.label}: 列が1つ以上返るはず`);
    // 隙間なく面全域を覆う。
    assert.ok(Math.abs(columns[0].x0) < 1e-6, `${face.label}: 先頭列がx=0から始まるはず`);
    assert.ok(Math.abs(columns[columns.length - 1].x1 - face.run) < 1e-6,
      `${face.label}: 末尾列がx=runで終わるはず（実際:${columns[columns.length - 1].x1} / run=${face.run}）`);
    for (let i = 0; i + 1 < columns.length; i++) {
      assert.ok(Math.abs(columns[i].x1 - columns[i + 1].x0) < 1e-6, `${face.label}: 列に隙間があってはならない`);
    }
    // 単層でも天井高さの上限がCHに解決され、その面の壁が床〜天井の見えがかりとして拾えている。
    const bands = columns.flatMap(c => c.bands);
    const seen = bands.find(b => b.kind === 'wall' && b.z0 === 0 && b.z1 === CH);
    assert.ok(seen, `${face.label}: 床0〜天井${CH}の見えがかり壁帯が拾えるはず（実際:${JSON.stringify(bands)}）`);
    assert.ok(seen.distMm > 0, `${face.label}: 見えがかり距離は切断面オフセットぶん正になるはず`);
  }
});

// ---- 失敗系: 単層スタックで上階を渡していないのに'above'層の帯が現れないこと ----
test('【失敗系・手順1】単層スタックの列には self 以外の層由来の帯が現れない', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const face = composeRoomFaces(room, graph)[0];
  const CH = roomCeilingHeight(graph, room).mm;
  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  const columns = buildColumns({
    seqNo: 'A', dirSign: face.dirSign, face, viewSign: faceViewSign(face),
    line: faceCutLine(face, cutPlaneOffsetMm(face, layers)), layers,
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  }, makeProbeContext(layers));
  const roles = new Set(columns.flatMap(c => c.bands).map(b => b.layerRole).filter(Boolean));
  assert.deepEqual([...roles], ['self'], `self層だけのはず（実際:${[...roles]}）`);
});
