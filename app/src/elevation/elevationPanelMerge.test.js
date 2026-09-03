// 規則A（開放スパンの二重描画の除去。elevationOpenSpan.js）と規則B（パネル統合。
// elevationFaceList.js の mergeSteppedFacesIntoPanel）の受け入れ検証。
// ユーザー実機指摘2026-08「「5」のC1とC2は1枚の壁」——室の南側境界が x -6200..-3400 は y=-1000、
// x -3400..0 は y=0 という1000の段差を1つ挟んだ一続きの面なのに、2枚のパネル（C1・C2）に割れ、
// さらに重複区間（x -3400..-3000）が C1 では「壁」・C2 では「アキ」と二重に描かれていた。
//
// ■ このフィクスチャの作り方（実機再現フィクスチャを書くたびに踏む罠。2026-09に実測で確認）
//   - 通り芯は `labeled:true + Discipline.STRUCT` で作る。`Discipline.ARCH` にすると
//     isDividerCL（finish/gridCells.js）で分割CLから外れ、refreshCells が空を返して
//     **全面の spans が消える**（開放スパンが1本も出ない図になる）。
//   - 無名CLには extentLo/extentHi を必ず与える。与えないと全CLが無限延長の分割CLになり、
//     セルが実機より細かく割れる。すると collectNearCellSegments の straddle（跨ぎ）フラグが
//     実機と反転し、extendFaceWithOpenSpans の規則2/3の判定が丸ごと変わって別物の図になる。
//     （既存の elevationVoidAbove.test.js の makeKneeBoundaryBand() はこの extent を持たない
//     ため、同じ3セルでも実機「5」とは違う面リストになる。あちらは腰壁・見えがかりの
//     フィクスチャとして別途承認済みのもので、実機「5」の再現ではない。）
//
// ■ 実機との既知の差（意図して残している）
//   実機の室「5」は北辺 y=-3500 に実壁が無く（hasRealWall=false で面が落ちる）、そのため
//   D1・B の lo は通り芯値 -3500 のままになる。このフィクスチャは
//   generateRoomWallsFromOutline が必ず壁を作るため、y=-3500 の面（A2）が1枚多く生まれ、
//   D1・B の lo は壁面ぶん 57.5 内側（-3442.5）になる。**C面の検証には影響しない**——
//   合成後の並びで A1 と A2 は隣接せず（あいだに D1）、かつ A1 は A2 を覆う＝世界範囲が
//   重なるため規則Bの条件3も満たさない。実機と同じく統合は起きない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { composeRoomFaces, mergeSteppedFacesIntoPanel } from './elevationFaceList.js';
import { labelFaces } from './elevationFaces.js';
import { layoutBandFaces } from './elevationBand.js';
import { buildRoomBandWithVoidAbove } from './elevationVoid.js';
import { solidPrimitivesForFace } from './elevationSolids.js';
import { structuralColumnContribution } from './section/sectionStructure.js';

const FLOOR_HEIGHT = 3000;
const ARCH = { labeled: false, discipline: Discipline.ARCH };
const ARCH_CL = ARCH;   // 柱位置の無名CL（分割CLとしての意味は持たせない）
const GRID = { labeled: true, discipline: Discipline.STRUCT };

// 実機1階・室「5」（3セルのL字）＋直上階の吹抜け。
// cell1: x[-6200,-3000] y[-2000,-1000] / cell2: x[-3400,-3000] y[-1000,0] / cell3: x[-3000,0] y[-3500,0]
function makeRoom5() {
  const g1 = new PlanGraph(new Plane('1階', 0, '1階', 1, 1));
  const V = (v, p = ARCH) => g1.addCenterLine(CenterLineType.VERTICAL, v, p);
  const H = (v, p = ARCH) => g1.addCenterLine(CenterLineType.HORIZONTAL, v, p);
  V(-8000, GRID); const x2 = V(-3000, GRID); const x3 = V(0, GRID);
  const y1 = H(0, GRID); H(-7000, GRID);
  const x6200 = V(-6200, { ...ARCH, extentLo: -3500, extentHi: 0 });
  const x3400 = V(-3400, { ...ARCH, extentLo: -1000, extentHi: 0 });   // cell2の範囲だけ
  const y1000 = H(-1000, { ...ARCH, extentLo: -6200, extentHi: -3000 }); // cell1/cell2の境界だけ
  const y2000 = H(-2000, { ...ARCH, extentLo: -8000, extentHi: -3000 }); // 段差CL（X1..X2だけ）
  const y3500 = H(-3500, { ...ARCH, extentLo: -3000, extentHi: 0 });
  const key = (a, b, c, d) => `${a.id}:${b.id}:${c.id}:${d.id}`;
  const cell2Key = key(x3400, y1000, x2, y1);
  const room = g1.addRoom(new Set([key(x6200, y2000, x2, y1000), cell2Key, key(x2, y3500, x3, y1)]), '5');
  generateRoomWallsFromOutline(g1, room);

  const g2 = new PlanGraph(new Plane('2階', FLOOR_HEIGHT, '2階', 1, 1));
  const cl2 = (t, v) => g2.centerLines.find(c => c.centerLineType === t && c.value === v)
    ?? g2.addCenterLine(t, v, ARCH);
  const k2 = (x0, y0, x1, y1v) => [
    cl2(CenterLineType.VERTICAL, x0).id, cl2(CenterLineType.HORIZONTAL, y0).id,
    cl2(CenterLineType.VERTICAL, x1).id, cl2(CenterLineType.HORIZONTAL, y1v).id].join(':');
  const add2 = (cells, name, feature = null) => {
    const r = g2.addRoom(new Set(cells.map(c => k2(...c))), name);
    if (feature) r.setFeature(feature);
    generateRoomWallsFromOutline(g2, r);
    return r;
  };
  const voidRoom = add2([[-3000, -2000, 0, 0]], '吹抜け', RoomFeature.VOID);
  add2([[-8000, -3500, 1000, -2000]], '22');
  add2([[-3000, -7000, 0, -3500]], '階段吹抜け');
  return { g1, g2, room, voidRoom, cell2Key };
}

const band5 = () => {
  const { g1, g2, room, voidRoom } = makeRoom5();
  return buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
};
// 軸の値で壁面を引く（段差見付け面(step)は同じ軸に生まれるので除く）。
const faceAt = (faces, axis, isVertical, inward) =>
  faces.find(f => f.kind !== 'step' && !!f.isVertical === isVertical
    && Math.abs(f.axisCL.effectiveValue - axis) < 1e-6
    && (inward == null || Math.sign(f.inward) === inward));
// 帯の面ラベル（注記帯のテキスト。A/B/C/D＋任意の数字。通り芯丸のX2/Y1等は除く）。
const faceLabels = band => band.primitives
  .filter(p => p.type === 'text' && /^[A-D]\d*$/.test(String(p.text ?? ''))).map(p => p.text);
// 床線（CUTの水平線・帯FL）を、端が一致するものどうし連結した「途切れない鎖」の一覧 [lo,hi]。
// 面の途中の分割点（吹抜け境界等）では途切れず、面と面のあいだ（ギャップ）で切れる。
const floorChains = band => {
  const runs = band.primitives
    .filter(p => p.type === 'line' && p.weight === 'thick' && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(p.y1) < 1e-6)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0]);
  const chains = [];
  for (const [lo, hi] of runs) {
    const last = chains[chains.length - 1];
    if (last && Math.abs(last[1] - lo) < 1e-6) last[1] = hi;
    else chains.push([lo, hi]);
  }
  return chains;
};

// 統合されたCパネル（C1+C2の2枚）だけを layoutBandFaces へ通す。帯全体を組まずに配置規則
// （世界x整合・パネル内CH寸法の抑止・パネル全幅の面ラベル）だけを見るための最小経路。
function panelLayout(ctxExtra = {}) {
  const { g1, room } = makeRoom5();
  const faces = composeRoomFaces(room, g1);
  const c1 = faceAt(faces, 0, false, -1), c2 = faceAt(faces, -1000, false, -1);
  const panel = labelFaces(mergeSteppedFacesIntoPanel([{ ...c1 }, { ...c2 }]));
  assert.equal(panel[0].panelId != null && panel[0].panelId === panel[1].panelId, true,
    '前提: この2枚は統合されているはず');
  // gridCLs:[] は通り芯の退避（avoidGridCollisionX）を無効化して面ラベルの位置だけを見るため。
  const layout = layoutBandFaces(room, g1, panel, { gridCLs: [], ...ctxExtra });
  return { layout, panel };
}

// ================================================================
// 規則A: 端の開放スパンは、その先を同室の平行・同向き・より奥の壁面が覆っているなら取り込まない
// ================================================================

test('【実機「5」C2】規則A: 先をC1(y=0)が覆う400の開放スパンは取り込まず、面は壁の区間だけで終わる', () => {
  const { g1, room } = makeRoom5();
  const c2 = faceAt(composeRoomFaces(room, g1), -1000, false, -1);
  assert.ok(c2, 'y=-1000・inward=-1の面（C2）があるはず');
  assert.equal(c2.hi, -3342.5, '400の開放スパンを取り込まず、x=-3400の壁面で終わるはず');
  assert.equal(c2.run, 2800, `run=2800のはず（実際:${c2.run}）`);
  assert.deepEqual(c2.spans.map(s => s.kind), ['wall'], 'アキ（open区間）は残らないはず');
  // 落とした端は「壁断面のない端部」——規則Bのパネル統合が接合端としてこの端を掴む。
  assert.equal(c2.hasWallAtLocal0, false);
  assert.equal(c2.edgeAtLocal0, true);
});

test('【失敗系】規則A: 開放先のFLが違う（informative）区間は、覆われていても従来どおり取り込む', () => {
  const { g1, room, cell2Key } = makeRoom5();
  // cell2（400の開放スパンの先）だけ床を50下げる部分指定を置く＝遠側床線という実体が現れる。
  const sub = g1.addRoom(new Set([cell2Key]), "5'", undefined, new Set([room.id]));
  sub.setFloorLevel(-50);
  const c2 = faceAt(composeRoomFaces(room, g1), -1000, false, -1);
  assert.equal(c2.hi, -3000, 'informativeな区間は規則1で残るはず（規則Aは掛からない）');
  assert.equal(c2.run, 3142.5, '400ぶん延長されたままのはず');
  assert.deepEqual(c2.spans.map(s => s.kind), ['open', 'wall'], '開放区間が残るはず');
  assert.equal(c2.spans[0].farFloorDeltaMm, -50, '遠側のFL差-50が伝わるはず');
});

// ================================================================
// 規則B: 壁面の段差でしか分かれていない同letterの面を1枚のパネルにする
// ================================================================

test('【実機「5」C】規則B: 吹抜け合成後のC1とC2は1枚のパネルになり、面ラベルは"C"1つだけになる', () => {
  const band = band5();
  const labels = faceLabels(band);
  assert.ok(!labels.includes('C2'), `面ラベルに"C2"は存在しないはず（実際:${JSON.stringify(labels)}）`);
  assert.deepEqual(labels.filter(l => l.startsWith('C')), ['C'],
    `C系のラベルは"C"1つだけのはず（実際:${JSON.stringify(labels)}）`);
});

test('【実機「5」C】規則B: パネルの2枚は世界x整合で隙間なく並び、床線が6085を貫いて連続する', () => {
  const band = band5();
  const chains = floorChains(band);
  // 帯全体の床線の鎖を並びごと固定する。A面も偶然6085になるため「6085を含む」だけでは
  // 破壊を検知できない（QA指摘のトートロジー）——**Cのラベルが載っている鎖**を特定して主張する。
  assert.deepEqual(chains.map(([lo, hi]) => Math.round(hi - lo)), [6085, 3385, 2885, 3385, 6085, 885],
    `帯の床線の鎖（面ごと）が変わっているはず（実際:${JSON.stringify(chains.map(c => c.map(Math.round)))}）`);
  const cLabel = band.primitives.find(p => p.type === 'text' && p.text === 'C');
  assert.ok(cLabel, '面ラベル"C"があるはず');
  const cChain = chains.find(([lo, hi]) => cLabel.x >= lo && cLabel.x <= hi);
  assert.ok(cChain, `"C"のラベル(x=${cLabel.x})が載る床線の鎖があるはず`);
  assert.equal(Math.round(cChain[1] - cChain[0]), 6085,
    'Cパネルの床線はC1(3285)+C2(2800)=6085で途切れず1本になるはず（世界x整合＝はね出し・ギャップが入らない）');
});

test('【実機「5」C】規則B: パネル内2枚目のxCursorは世界x整合（ギャップも延長も入らない）', () => {
  const { layout } = panelLayout();
  const [a, b] = layout.faceRuns;
  assert.equal(b.xCursor - a.xCursor, 3285,
    'C1のrun(3285)ぶんだけ進めて置く＝2枚が接する（実際:' + (b.xCursor - a.xCursor) + '）');
  // 接合部の壁中心線（世界x=-3400）は両メンバーが同じ帯内xへ落とすこと（世界x整合の証拠）。
  assert.equal(a.xCursor + a.boundary.hi, b.xCursor + b.boundary.lo,
    '接合部の壁中心線が両メンバーで同じ位置に来るはず');
});

test('【実機「5」C】規則B: 面ラベルはパネル全幅の中心に1つだけ置かれる（C1単体の中心ではない）', () => {
  const { layout } = panelLayout();
  const [a, b] = layout.faceRuns;
  const labels = layout.primitives.filter(p => p.type === 'text' && /^[A-D]\d*$/.test(String(p.text ?? '')));
  assert.deepEqual(labels.map(p => p.text), ['C'], 'ラベルはパネルで1つだけのはず');
  const panelMid = ((a.xCursor + a.boundary.lo) + (b.xCursor + b.boundary.hi)) / 2;
  const c1Mid = a.xCursor + (a.boundary.lo + a.boundary.hi) / 2;
  assert.equal(labels[0].x, panelMid, `パネル全幅(${panelMid})の中心に置くはず`);
  assert.notEqual(labels[0].x, c1Mid, `C1単体の中心(${c1Mid})ではないはず`);
});

test('【実機「5」C】規則B: パネル内の継ぎ目にはCH寸法（縦dim）を立てない', () => {
  // 継ぎ目の左右で天井の起点が変わる状況を作る（faceOverrideは階段帯が使う既存のフック）。
  // これが無いと継ぎ目判定自体が成立せず、抑止の有無を区別できない。
  const ov = (face, i) => (i === 0
    ? { floorSegments: [{ loX: 0, hiX: face.run, floorDeltaMm: 0, chMm: 2600 }] } : null);
  const { layout } = panelLayout({ faceOverride: ov });
  const [a, b] = layout.faceRuns;
  const panelLo = a.xCursor + a.boundary.lo, panelHi = b.xCursor + b.boundary.hi;
  const inside = layout.primitives.filter(p => p.type === 'dim' && p.dir === 'v'
    && p.at > panelLo && p.at < panelHi);
  assert.deepEqual(inside, [],
    `パネルの内側に縦のCH寸法が立ってはいけない（立つとCH_DIM_OFFSET_MMぶん世界x整合が壊れる。実際:${JSON.stringify(inside.map(p => p.at))}）`);
});

test('【実機「5」C】規則B: 重複区間(x -3400..-3000)は1回だけ描かれ、アキ（バツ）が残らない', () => {
  const band = band5();
  // ROW1の寸法の鎖: 壁芯間6200 = 3000 + 400 + 2800（400が重複区間。1回だけ現れる）。
  const dims = band.primitives.filter(p => p.type === 'dim' && p.dir === 'h')
    .map(p => ({ from: p.from, to: p.to, label: p.label }));
  const four = dims.filter(d => d.label === 400);
  assert.equal(four.length, 1, `400の寸法は1本だけのはず（実際:${JSON.stringify(dims.map(d => d.label))}）`);
  // アキのバツ印（斜めの thin 線）がCパネルの範囲に入っていないこと。
  const panelLo = four[0].from - 3000, panelHi = four[0].to + 2800;
  const crosses = band.primitives.filter(p => p.type === 'line' && p.weight === 'thin'
    && Math.abs(p.x1 - p.x2) > 1 && Math.abs(p.y1 - p.y2) > 1
    && Math.min(p.x1, p.x2) >= panelLo - 1 && Math.max(p.x1, p.x2) <= panelHi + 1);
  assert.deepEqual(crosses, [], 'Cパネルにアキ（バツ）は描かれないはず');
});

test('【実機「5」】規則B: 他の面（A・B・D）のラベル・枚数・走り範囲は変わらない', () => {
  const labels = faceLabels(band5());
  assert.deepEqual(labels, ['A1', 'D1', 'A2', 'B', 'C', 'D2'],
    `C以外の面はそのまま（実際:${JSON.stringify(labels)}）`);
});

// ================================================================
// 失敗系（統合してはいけない組）: 実フィクスチャのC1/C2を1点だけ崩して不成立にする
// ================================================================

// 実機「5」の合成後の並びからC1/C2の隣接ペアを取り出す（失敗系はこれを1点だけ崩す）。
function stepPair() {
  const { g1, room } = makeRoom5();
  const faces = composeRoomFaces(room, g1);
  const c1 = faceAt(faces, 0, false, -1), c2 = faceAt(faces, -1000, false, -1);
  return [{ ...c1 }, { ...c2 }];
}
const merged = faces => mergeSteppedFacesIntoPanel(faces).some(f => f.panelId != null);

test('規則B: 前提確認——崩していないC1/C2の隣接ペアは統合される（下の失敗系が空振りでない証拠）', () => {
  assert.equal(merged(stepPair()), true, 'C1→C2の並びは統合されるはず');
});

test('【失敗系】規則B条件4: 面リスト上で隣接していなければ統合しない（実機「5」のD1/D3型の暴発防止）', () => {
  const [c1, c2] = stepPair();
  const { g1, room } = makeRoom5();
  const between = faceAt(composeRoomFaces(room, g1), -3400, true, 1); // あいだに残った別パネル
  assert.equal(merged([c1, between, c2]), false, 'あいだに他の面があれば統合しないはず');
});

test('【失敗系】規則B条件3: 世界範囲が重なる組は統合しない（2階室22のC1/C2型）', () => {
  const [c1, c2] = stepPair();
  c2.hi = c1.lo + 885; c2.run = c2.hi - c2.lo;  // 885重なる（室22の実測と同じ重なり方）
  assert.equal(merged([c1, c2]), false, '重なる組は「段差で分かれた1枚」ではないので統合しないはず');
});

test('【失敗系】規則B条件3: 隙間がCORNER_TOL_MM(200)を超えて離れていれば統合しない', () => {
  const [c1, c2] = stepPair();
  c2.hi = c1.lo - 300; c2.lo = c2.hi - c2.run;
  assert.equal(merged([c1, c2]), false, '300離れた組は接していないので統合しないはず');
});

test('【失敗系】規則B条件5: 接合端の天井の起点（吹抜けの有無）が違えば統合しない', () => {
  const [c1, c2] = stepPair();
  // C1の接合端（ローカルrun側）だけ上階の吹抜けが掛かっている＝天井の絶対高さが違う。
  c1.voidAbove = { voidLocal: [{ lo: c1.run - 1000, hi: c1.run }] };
  assert.equal(merged([c1, c2]), false, '接合端のprofileが違えば1枚のパネルにできないはず');
});

test('【失敗系】規則B条件6: 接合部にどちらの壁断面も無ければ統合しない（返し壁の無い開放的な段差）', () => {
  const [c1, c2] = stepPair();
  c1.hasWallAtLocalRun = false; c2.hasWallAtLocal0 = false;
  assert.equal(merged([c1, c2]), false, '接合部に壁断面が無ければ統合しないはず');
});

test('【失敗系】規則B条件1・2: 段差見付け面(step)・軸が同じ面は統合しない', () => {
  const [c1, c2] = stepPair();
  assert.equal(merged([{ ...c1, kind: 'step' }, c2]), false, 'step面は対象外のはず');
  const sameAxis = { ...c2, axisCL: c1.axisCL };
  assert.equal(merged([c1, sameAxis]), false, '奥行き0（同一平面）は段差ではないので対象外のはず');
});

test('規則B: 3枚以上は連鎖で1つのパネルになり、ラベルは全メンバー共通の"C"1つになる', () => {
  const { g1, room } = makeRoom5();
  const faces = composeRoomFaces(room, g1);
  const c1 = { ...faceAt(faces, 0, false, -1) }, c2 = { ...faceAt(faces, -1000, false, -1) };
  // 3枚目: y=-2000の面がC2のlo端(-6142.5)へさらに接して続く（段差2つ・返し壁2枚のL字）。
  const y2000 = g1.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === -2000);
  const c3 = { ...c2, axisCL: y2000, lo: -9000, hi: -6142.5, run: 2857.5, originWorld: -6142.5,
    hasWallAtLocal0: false, edgeAtLocal0: true, hasWallAtLocalRun: true, edgeAtLocalRun: false };
  const out = labelFaces(mergeSteppedFacesIntoPanel([c1, c2, c3]));
  assert.equal(new Set(out.map(f => f.panelId)).size, 1, '3枚とも同じpanelIdのはず');
  assert.equal(out.every(f => f.panelId != null), true, '3枚ともpanelIdを持つはず');
  assert.deepEqual(out.map(f => f.label), ['C', 'C', 'C'], 'C1/C2/C3に割れず全て"C"のはず');
  // 連鎖した接合端は両側とも「壁断面あり」へ書き換わる（はね出し・探査延長が止まる）。
  assert.equal(out[1].hasWallAtLocal0, true);
  assert.equal(out[1].hasWallAtLocalRun, true);
});

test('【失敗系】規則B: 2枚目が1枚目の-ローカルx側へ戻る並びは統合しない（配置式の前提を守る）', () => {
  const [c1, c2] = stepPair();
  // C2→C1 の順（2枚目が先頭メンバーの左へ続く）。幾何は同じでも帯の配置式が成立しない。
  assert.equal(merged([c2, c1]), false, '接合の向きが逆なら統合しないはず');
  assert.equal(merged([c1, c2]), true, '正しい向きなら統合するはず（比較対象）');
});

test('【失敗系】規則B: 統合が1件も起きない面リストは、panelIdを持たず現行と同一に採番される', () => {
  const { g1, room } = makeRoom5();
  const faces = composeRoomFaces(room, g1);   // 自階のみ＝C1とC2のあいだにD2が残る
  assert.equal(faces.some(f => f.panelId != null), false, '自階の並びでは統合は起きないはず');
  assert.deepEqual(faces.map(f => f.label), ['A1', 'D1', 'A2', 'B', 'C1', 'D2', 'C2', 'D3'],
    '従来どおり面数で採番されるはず');
  // C以外の面の走り範囲は規則A・規則Bのどちらでも変わらない（D4）。
  assert.deepEqual(faces.filter(f => !f.label.startsWith('C')).map(f => [f.label, f.lo, f.hi]), [
    ['A1', -6142.5, -2942.5], ['D1', -3442.5, -1942.5], ['A2', -2942.5, -57.5],
    ['B', -3442.5, -57.5], ['D2', -1057.5, -57.5], ['D3', -1942.5, -1057.5],
  ]);
});

// ================================================================
// 統合パネルの接合部と柱型の取り合い（2026-09。2.5D加算レイヤの調査で確定した経緯の固定）。
// パネルの接合部（世界x=-3400の返し壁）に柱が立つと、柱型の片縁は接合部と同じ位置に来る。
// 見付け幅の2本は**両方emitされており**、帯で片方が接合部の端の縦線（同じmedium）と
// 完全一致して dedupeCoincidentLines に畳まれる——「1本しか描かれない＝片縁が欠けている」
// のではない。clampPrimsToRun は run端ちょうどの縦線を動かさないので落ちもしない。
// ================================================================

function makeRoom5WithColumn() {
  const s = makeRoom5();
  const cx = s.g1.addCenterLine(CenterLineType.VERTICAL, -3190, ARCH_CL);
  const cy = s.g1.addCenterLine(CenterLineType.HORIZONTAL, -200, ARCH_CL);
  // C1面（y=0の壁）とx=-3400の壁の両方へ150mm以内で接続する位置に立つ柱。
  s.g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', cx, cy, {});
  return s;
}

// 面のローカルx（世界→面）。lo/hi・originWorld・dirSignの規約はbuildRoomFacesと同じ。
const toLocalX = (face, world) => (world - face.originWorld) * face.dirSign;

test('【2026-09】柱型は接合部でも両縁2本がemitされる（solidPrimitivesForFace単体）', () => {
  const { g1, room } = makeRoom5WithColumn();
  const c1 = faceAt(composeRoomFaces(room, g1), 0, false, -1);
  const col = structuralColumnContribution([{ graph: g1, floorZMm: 0, role: 'self' }])[0];
  assert.ok(col, '前提: 柱の包み外形が作れているはず');
  const verticals = solidPrimitivesForFace(c1, { graph: g1, ceilingHeight: 2400 })
    .filter(p => p.type === 'line' && Math.abs(p.x1 - p.x2) < 1e-6 && p.weight === 'medium');
  const xs = verticals.map(p => p.x1).sort((a, b) => a - b);
  assert.equal(verticals.length, 2, `柱型は両縁2本のはず（実際:${JSON.stringify(xs)}）`);
  // 見付け幅の両端＝柱の包み外形の両縁。lo側の縁はちょうどrun端（＝パネルの接合部）に来る。
  assert.deepEqual(xs, [toLocalX(c1, col.xHi), toLocalX(c1, col.xLo)].sort((a, b) => a - b),
    '両縁とも柱の包み外形どおりの位置のはず');
  assert.equal(xs[1], c1.run, 'run端ちょうどの縦線もクランプで落ちずに残るはず');
});

test('【2026-09】帯では柱型の片縁が接合部の端の縦線と畳まれ、接合部xの縦線は1本のままになる', () => {
  const { g1, g2, room, voidRoom } = makeRoom5WithColumn();
  const opts = { floorHeightAboveMm: FLOOR_HEIGHT };
  const without = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, opts);
  const with_ = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2,
    { ...opts, solids: { upperGraph: g2, floorHeightMm: FLOOR_HEIGHT } });
  const mediumVerticalXs = band => band.primitives
    .filter(p => p.type === 'line' && p.weight === 'medium' && Math.abs(p.x1 - p.x2) < 1e-6
      && Math.abs(Math.min(p.y1, p.y2) + 2400) < 1e-6 && Math.abs(Math.max(p.y1, p.y2)) < 1e-6)
    .map(p => p.x1);
  const before = mediumVerticalXs(without), after = mediumVerticalXs(with_);
  const added = after.filter(x => !before.includes(x));
  assert.equal(added.length, 1, `帯に増える縦線は1本だけのはず（実際:${JSON.stringify(added)}）`);
  // 増えた1本は柱型の内側の縁（C1ローカル3000）。もう片方は接合部（ローカル3285）にあり、
  // solids無しの帯にも既に同じ線がある＝畳まれた相手。
  const c1 = faceAt(composeRoomFaces(room, g1), 0, false, -1);
  const col = structuralColumnContribution([
    { graph: g1, floorZMm: 0, role: 'self' },
    { graph: g2, floorZMm: FLOOR_HEIGHT, role: 'above' }])[0];
  const jointX = added[0] + (toLocalX(c1, col.xLo) - toLocalX(c1, col.xHi));
  assert.equal(before.filter(x => Math.abs(x - jointX) < 1e-6).length, 1,
    '接合部の端の縦線はsolids無しでも1本ある（柱型の片縁と同一位置・同一線種）');
  assert.equal(after.filter(x => Math.abs(x - jointX) < 1e-6).length, 1,
    '柱型を足しても接合部xの縦線は1本のまま（dedupeCoincidentLinesが畳む）');
});

// ================================================================
// 多層帯の巾木（ユーザー実機指摘2026-09「壁のないところに巾木はない」）のうち、
// **hi側へ延長された面（実機「5」A）**の検証。開放スパンに邪魔されず「合成による延長範囲」
// だけを見るため、実機と同じCL延長を持つこのフィクスチャで固定する。
// ================================================================
test('【実機修正2026-09・A型】多層帯: hi側へ延長された面の巾木は、自階の壁がある範囲だけになる', () => {
  const { g1, g2, room, voidRoom } = makeRoom5();
  room.finish.setField('baseboardHeight', 'h=60');
  const a1 = faceAt(composeRoomFaces(room, g1), -2000, false, 1);
  assert.deepEqual((a1.spans ?? []).map(s => s.kind), ['wall'],
    '前提: この面に開放スパンは無い（＝巾木の途切れは合成による延長だけに由来する）');
  const band = buildRoomBandWithVoidAbove(room, g1, voidRoom, g2, { floorHeightAboveMm: FLOOR_HEIGHT });
  const level = z => band.primitives.filter(p => p.type === 'line' && !p.dash
    && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(-p.y1 - z) < 1e-6)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0]);
  const chains = segs => segs.reduce((out, [lo, hi]) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - lo) < 1e-6) last[1] = hi; else out.push([lo, hi]);
    return out;
  }, []);
  const floor = chains(level(0)), base = chains(level(60));
  // A1は帯の先頭パネル（xCursor=0）。合成で 3200 → 6085 へ延長されている。
  assert.deepEqual(floor[0], [0, 6085], '前提: A1パネルは合成で6085へ延長されている');
  assert.deepEqual(base[0], [0, a1.run],
    `1階の壁がある0..${a1.run}だけに巾木が引かれ、延長された先には引かれないはず（実際:${JSON.stringify(base[0])}）`);
});
