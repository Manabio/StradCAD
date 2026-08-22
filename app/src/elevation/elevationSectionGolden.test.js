// WP-G0（2.5D断面エンジン移行のゴールデン一致ゲート）: buildRoomBand（通常部屋帯）・
// buildVoidBand（吹抜け帯）の出力プリミティブ全体を正規化JSON（キー順ソート・数値はそのまま）で
// 固定する回帰テスト。C:\Users\tatsuya\AppData\Local\Temp\claude\...\section-engine-design.md §8。
//
// このテストは以後の全WP（sectionEngine等）のゲートとして機能する——差分が出たら
// 「エンジン起因かの切り分け（git stash等）をせずに自己判断で修正しない」。
// フィクスチャはelevationBand.test.js/elevationVoid.test.jsの既存ヘルパをそのまま再利用する
// （通常矩形部屋=elevationBand.test.js:29相当、段差付き部屋=elevationBand.test.js:332相当、
// 吹抜け2層=elevationVoid.test.js:36相当）。ゴールデン値は初回実行時の実出力をそのまま埋め込む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand } from './elevationBand.js';
import { buildVoidBand } from './elevationVoid.js';

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
const GOLDEN_NORMAL_RECT = '[{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":0},{"dash":"center","type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":4000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":1200},{"at":-557.5,"dir":"v","dot":true,"foot":0,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4200,"x2":4200,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":7085,"x2":7085,"y1":-2400,"y2":0},{"dash":"center","type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":7142.5,"x2":7142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4142.5,"label":3000,"to":7142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":5642.5,"y":1200},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7400,"x2":7400,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2400,"y2":0},{"dash":"center","type":"line","weight":"thin","x1":7342.5,"x2":7342.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":11342.5,"x2":11342.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7342.5,"label":4000,"to":11342.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":9342.5,"y":1200},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":11600,"x2":11600,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":14485,"x2":14485,"y1":-2400,"y2":0},{"dash":"center","type":"line","weight":"thin","x1":11542.5,"x2":11542.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":14542.5,"x2":14542.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":11542.5,"label":3000,"to":14542.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":13042.5,"y":1200},{"h":400,"type":"rect","w":1200,"x":6392.5,"y":1700},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":6992.5,"y":1900},{"type":"line","weight":"thin","x1":-857.5,"x2":6392.5,"y1":1900,"y2":1900},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1900},{"type":"line","weight":"thin","x1":7592.5,"x2":14842.5,"y1":1900,"y2":1900},{"dir":-1,"type":"miterTriangle","x":14842.5,"y":1900}]';

test('【WP-G0】ゴールデン一致: buildRoomBand（通常矩形部屋）の出力プリミティブが正規化JSONで完全一致する', () => {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const band = buildRoomBand(room, graph, { project: { openingNumberIndex: new Map() } });
  assert.equal(normalize(band.primitives), GOLDEN_NORMAL_RECT);
});

// ---- ケース2: 段差付き部屋（部分指定floorLevel+300。elevationBand.test.js:332相当） ----
const GOLDEN_STEP_ROOM = '[{"type":"line","weight":"thick","x1":0,"x2":1885,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":1885,"x2":3885,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":1885,"x2":1885,"y1":0,"y2":-300},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":-300},{"at":4442.5,"dir":"v","dot":true,"foot":3942.5,"from":-2400,"label":2100,"to":-300,"type":"dim"},{"dash":"center","type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":1942.5,"x2":1942.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":2000,"to":1942.5,"type":"dim"},{"at":600,"dir":"h","dot":true,"from":1942.5,"label":2000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":1200},{"at":-557.5,"dir":"v","dot":true,"foot":0,"from":-2400,"label":"2400","to":0,"type":"dim"},{"type":"line","weight":"thick","x1":5200,"x2":8085,"y1":0,"y2":0},{"type":"line","weight":"medium","x1":5200,"x2":8085,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":5200,"x2":5200,"y1":0,"y2":-2400},{"type":"line","weight":"thick","x1":8085,"x2":8085,"y1":0,"y2":-2400},{"type":"line","weight":"thick","x1":5200,"x2":8085,"y1":-2400,"y2":-2400},{"h":2100,"type":"rect","w":2885,"weight":"medium","x":5200,"y":-2400},{"dash":"center","type":"line","weight":"thin","x1":5200,"x2":8085,"y1":-2400,"y2":-300},{"dash":"center","type":"line","weight":"thin","x1":8085,"x2":5200,"y1":-2400,"y2":-300},{"anchor":"middle","baseline":"middle","text":"ア キ","type":"text","x":6642.5,"y":-1350},{"dash":"center","type":"line","weight":"thin","x1":5142.5,"x2":5142.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":8142.5,"x2":8142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":5142.5,"label":3000,"to":8142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B1","type":"text","x":6642.5,"y":1200},{"at":4642.5,"dir":"v","dot":true,"foot":5200,"from":-2400,"label":2400,"to":0,"type":"dim"},{"type":"line","weight":"thick","x1":8900,"x2":11785,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":8900,"x2":11785,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":8900,"x2":8900,"y1":-2400,"y2":-300},{"type":"line","weight":"medium","x1":11785,"x2":11785,"y1":-2400,"y2":-300},{"dash":"center","type":"line","weight":"thin","x1":8842.5,"x2":8842.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":11842.5,"x2":11842.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":8842.5,"label":3000,"to":11842.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B2","type":"text","x":10342.5,"y":1200},{"at":8342.5,"dir":"v","dot":true,"foot":8900,"from":-2400,"label":2100,"to":-300,"type":"dim"},{"type":"line","weight":"thick","x1":12100,"x2":14100,"y1":-300,"y2":-300},{"type":"line","weight":"thick","x1":14100,"x2":15985,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":14100,"x2":14100,"y1":-300,"y2":0},{"type":"line","weight":"thick","x1":12100,"x2":15985,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":12100,"x2":12100,"y1":-2400,"y2":-300},{"type":"line","weight":"medium","x1":15985,"x2":15985,"y1":-2400,"y2":0},{"at":16542.5,"dir":"v","dot":true,"foot":16042.5,"from":-2400,"label":2400,"to":0,"type":"dim"},{"dash":"center","type":"line","weight":"thin","x1":12042.5,"x2":12042.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":14042.5,"x2":14042.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":16042.5,"x2":16042.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":12042.5,"label":2000,"to":14042.5,"type":"dim"},{"at":600,"dir":"h","dot":true,"from":14042.5,"label":2000,"to":16042.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":14042.5,"y":1200},{"type":"line","weight":"thick","x1":16800,"x2":19685,"y1":0,"y2":0},{"type":"line","weight":"thick","x1":16800,"x2":19685,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":16800,"x2":16800,"y1":-2400,"y2":0},{"type":"line","weight":"medium","x1":19685,"x2":19685,"y1":-2400,"y2":0},{"dash":"center","type":"line","weight":"thin","x1":16742.5,"x2":16742.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":19742.5,"x2":19742.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":16742.5,"label":3000,"to":19742.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":18242.5,"y":1200},{"h":400,"type":"rect","w":1200,"x":8992.5,"y":1700},{"anchor":"middle","baseline":"middle","text":"LDK","type":"text","x":9592.5,"y":1900},{"type":"line","weight":"thin","x1":-857.5,"x2":8992.5,"y1":1900,"y2":1900},{"dir":1,"type":"miterTriangle","x":-857.5,"y":1900},{"type":"line","weight":"thin","x1":10192.5,"x2":20042.5,"y1":1900,"y2":1900},{"dir":-1,"type":"miterTriangle","x":20042.5,"y":1900}]';

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
const GOLDEN_VOID_2LAYER = '[{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":0,"x2":3885,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":0,"x2":0,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":3885,"x2":3885,"y1":-2400,"y2":2900},{"dash":"center","type":"line","weight":"thin","x1":-57.5,"x2":-57.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":3942.5,"x2":3942.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":-57.5,"label":4000,"to":3942.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"A","type":"text","x":1942.5,"y":1200},{"at":-557.5,"dir":"v","dot":true,"foot":0,"from":-2400,"label":5300,"to":2900,"type":"dim"},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":4200,"x2":7085,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":4200,"x2":4200,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":7085,"x2":7085,"y1":-2400,"y2":2900},{"dash":"center","type":"line","weight":"thin","x1":4142.5,"x2":4142.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":7142.5,"x2":7142.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":4142.5,"label":3000,"to":7142.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"B","type":"text","x":5642.5,"y":1200},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":7400,"x2":11285,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":7400,"x2":7400,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":11285,"x2":11285,"y1":-2400,"y2":2900},{"dash":"center","type":"line","weight":"thin","x1":7342.5,"x2":7342.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":11342.5,"x2":11342.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":7342.5,"label":4000,"to":11342.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"C","type":"text","x":9342.5,"y":1200},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":2900,"y2":2900},{"type":"line","weight":"thick","x1":11600,"x2":14485,"y1":-2400,"y2":-2400},{"type":"line","weight":"medium","x1":11600,"x2":11600,"y1":-2400,"y2":2900},{"type":"line","weight":"medium","x1":14485,"x2":14485,"y1":-2400,"y2":2900},{"dash":"center","type":"line","weight":"thin","x1":11542.5,"x2":11542.5,"y1":-2550,"y2":600},{"dash":"center","type":"line","weight":"thin","x1":14542.5,"x2":14542.5,"y1":-2550,"y2":600},{"at":600,"dir":"h","dot":true,"from":11542.5,"label":3000,"to":14542.5,"type":"dim"},{"anchor":"middle","baseline":"middle","size":13,"text":"D","type":"text","x":13042.5,"y":1200},{"h":400,"type":"rect","w":1200,"x":6392.5,"y":3400},{"anchor":"middle","baseline":"middle","text":"吹抜け","type":"text","x":6992.5,"y":3600},{"type":"line","weight":"thin","x1":-857.5,"x2":6392.5,"y1":3600,"y2":3600},{"dir":1,"type":"miterTriangle","x":-857.5,"y":3600},{"type":"line","weight":"thin","x1":7592.5,"x2":14842.5,"y1":3600,"y2":3600},{"dir":-1,"type":"miterTriangle","x":14842.5,"y":3600}]';

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
