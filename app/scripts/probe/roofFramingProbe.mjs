// 在来木造の小屋梁（role:'roofBeam'。structural/woodRoofFraming.js。ステップC2b・C2d-2）の実データ確認用probe。
// 本番の反映パスと同じ順序（sweepOrder.mjs sweepUntilConverged。小屋伏図→最上階→…→最下階）で構造再計算を収束させ、
//   - 階ごとの保存データ（serializeGraph）の長さ:ハッシュ（UUID は決定化しているので同じコードなら毎回同じ）
//   - 小屋梁の一覧（軸の通り芯名・区間・両端の host の通り芯名・断面・採番）
//   - 母屋・棟木の線ごとの束の間隔の最大値（小屋梁を数えない「前」→数える「後」）
//   - 収束スイープ数（5以下）
// を出す。**全ての母屋・棟木で束の最大間隔が 1820 以下**でなければ exit 1。ただし「支えの無い端の区間」
// （その位置で、線を挟む左右どちらかに host＝線と平行な大梁が無く、小屋梁が構造上かけられない区間）は除き、
// 除いた区間は一覧に出す（structural-model.md の既知の穴＝壁の無い辺の軒桁と同根）。
//
// 検査する region は2種類（判定は同じ関数 inspectRegion）:
//   主屋根＝屋根専用平面（小屋伏図）の graph ×  mainRoofFramingRegion
//   下屋　＝屋根セルのある実体階の graph × leanToFramingRegions（C2d-2。region ごとに「下屋 [階] lean:…」と見出しを出す）
// 下屋の region を持たない実体階に auto の小屋梁（role:'roofBeam'・dimensionStatus 'auto'）が残っていたら NG
// （region が無くなったら撤去される規則の確認）。
//
// 【この probe が通る経路】矩形の切妻・片流れ・寄棟（C2e-1b）の主屋根・下屋。region が1つも無い文書（在来でない・陸屋根・
//   棟違い・矩形でない切妻/片流れ・屋根なし）は「対象外」と表示して exit 0（小屋梁が0本のことは、他の確認——13.stq の dump 一致——で見る）。
//   寄棟は線の向きが混在するので、「支えの無い端の区間」の host を線ごとに決める（桁行の線＝棟木・環の長辺は大梁だけ、
//   妻側の線＝環の短辺は大梁＋その線と平行な第1段の小屋梁）。棟木の両端に束があるかも検査する（無ければ違反）。
//   寄棟の文書は makeHipRoofTestDoc.mjs が作る（roof-test4.stq）。飛び梁は一覧に [飛び梁] と付く。
// 【矩形でない寄棟の主屋根（C2e-3b）】rect:null・rects の region も同じ inspectRegion を通る。加えて、翼の表（順・向き・矩形・段・
//   棟木か頂点・seed・桁行／妻側の線の部分と延長の印）、取り残し（unassigned。1本でもあれば NG＝被覆性の崩れ）、小屋梁・飛び梁と
//   他の梁の内部での交差（あれば NG）を出す。束の間隔は元の全棟木・母屋で 1820 以下（「支えの無い端の区間」の除外は設けない。
//   超えたら違反）。棟木の両端の束の検査は矩形の寄棟だけ。
// 【L字の下屋（E1b・E2b。翼ごとの片流れ・面ごとの小屋梁）】leanToFramingRegions・leanToFraming は L字の片流れの下屋も region
//   （rect:null・leanToWings・leanToDrains）にする。描画の内訳（翼の表・水下の表・母屋の段の基準・母屋と斜め線の延長前→後・
//   水下の場の計算時間・外形線）は水下への L∞ 距離の場（leanToDrainFraming）。小屋梁も同じ場の面（水下ごと）の母屋を支える。
//   構造の検査（inspectLeanTo）: 面（水下ごと）・棟木と母屋・
//   小屋梁の一覧（host 名つき）・**全母屋・棟木の束の最大間隔（1820 超は NG。
//   「支えの無い端の区間」の除外は設けない）**・小屋梁と他の梁の内部での交差（NG）・同じ軸で重なる小屋梁（NG）・取り残し
//   （unassigned。報告だけで NG にしない＝形によっては残りうる既知の限界）。stray 検査（region の無い階に auto の小屋梁が残って
//   いないか）は構造側の region（leanToFraming）で行う。
// 【通らない経路】なし（矩形・矩形でない寄棟・L字の片流れの主屋根・下屋）。ただし L字の「面」が複数ある形の実データは roof-test1 だけ。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/roofFramingProbe.mjs [入力.stq]   （既定: moku4）
import crypto from 'node:crypto';

// UUID を連番にして決定化する（階ごとのハッシュを同じコードで再現可能にする。製品コードには影響しない診断専用）。
let uuidCounter = 0;
const detUUID = () => { uuidCounter++; return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`; };
crypto.randomUUID = detUUID;
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: detUUID, configurable: true, writable: true });

const { loadDocument } = await import('./loadDoc.mjs');
const { floorSwapManager } = await import('../../src/storage/FloorSwapManager.js');
const { serializeGraph } = await import('../../src/graphSnapshot.js');
const { sweepUntilConverged, planeLabel } = await import('./sweepOrder.mjs');
const { structuralPlaneBelow } = await import('../../src/structural/drawingDesignation.js');
const { mainRoofFramingRegion, leanToFramingRegions, leanToFraming } = await import('../../src/structural/roofFramingRegions.js');
const {
  roofFramingLines, roofStrutPoints, roofRidgeIsVertical, hipFramingWings, purlinLayoutFromRidge,
  roofHipDiagonals, leanToDrainFraming, extendLinesToOutline, extendDiagonalsToOutline,
} = await import('../../src/structural/roofFramingGeometry.js');
const { roofFramingHostMembers } = await import('../../src/structural/framingDrawing.js');
const { rulesFor, effectiveStructure } = await import('../../src/structural/structureRules.js');
const { assignNumbers, applyNumbers } = await import('../../src/structural/memberNumbering.js');
const { CL_OVERLAP_TOL_MM } = await import('../../src/core/constants.js');
const { CenterLineType, RoofShape } = await import('../../src/core.js');

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const MAX_SWEEPS = 8;
const SWEEP_LIMIT = 5; // 収束スイープ数の上限（convergeLimit）
const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

const { project } = loadDocument(src);
// loadDoc.mjs はインメモリ復元のため、非アクティブ階の peek は graphMap から直接返す（他の wood probe と同じ）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);
const roofPlane = project.roofPlane;
if (!roofPlane) { console.log('屋根専用平面が無い文書: 対象外（exit 0）'); process.exit(0); }

// RIDGE_DIRECTION=vertical|horizontal のとき、収束の前に主屋根（最上階の mainRoofSpec）の棟木の向きを上書きする（C2e-1c。
// 切妻の向きを変えたときの小屋梁・束の確認用。保存はしない。主屋根が切妻でなければ region には効かない）。
if (process.env.RIDGE_DIRECTION) {
  const top = structuralPlaneBelow(roofPlane, project);
  const g = top ? project.graphMap.get(top.id) : null;
  if (!g) { console.log('最上階が無いので RIDGE_DIRECTION は無視'); } else {
    g.mainRoofSpec.setField('ridgeDirection', process.env.RIDGE_DIRECTION);
    console.log(`RIDGE_DIRECTION=${process.env.RIDGE_DIRECTION} を最上階の mainRoofSpec へ設定（保存しない）`);
  }
}

const convergedAt = await sweepUntilConverged(project, 'desc', MAX_SWEEPS, (i, changedPlanes) => {
  console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`);
});
// 採番（反映パスの2パス目と同じ。KB の番号を見る）
{
  const tags = assignNumbers(project);
  for (const p of [...project.planes, roofPlane]) applyNumbers(project.graphMap.get(p.id), project, tags);
}

console.log('--- 階ごとの保存データ（長さ:ハッシュ） ---');
for (const p of [...project.planes, roofPlane]) {
  const b = serializeGraph(project.graphMap.get(p.id));
  console.log(`  [${planeLabel(p)}] ${b.length}:${hash(b)}`);
}

const roofGraph = project.graphMap.get(roofPlane.id);
const topPlane = structuralPlaneBelow(roofPlane, project);
const topGraph = topPlane ? project.graphMap.get(topPlane.id) : null;
const mainRegion = mainRoofFramingRegion(topGraph, project);
// 下屋＝実体階ごとの region。矩形でない下屋（L字。rect:null）は描画だけなので lLeanTos に分ける（小屋梁の検査をしない）。
// 構造側の region の無い実体階は stray 検査（auto の小屋梁が残っていないこと）に回す。
const leanTos = [];
const lLeanTos = [];
const strayFloors = [];
for (const p of project.planes) {
  const g = project.graphMap.get(p.id);
  const t0 = performance.now();
  const regions = leanToFramingRegions(g, project);
  const ms = performance.now() - t0;
  for (const region of regions) (region.rect ? leanTos : lLeanTos).push({ plane: p, graph: g, region, ms });
  if (leanToFraming(g, project).regions.length === 0) {
    const stray = g.beams.filter(b => b.role === 'roofBeam' && b.dimensionStatus === 'auto');
    if (stray.length > 0) strayFloors.push({ plane: p, count: stray.length });
  }
}

const tol = CL_OVERLAP_TOL_MM;
const clName = cl => (cl.labeled ? cl.label
  : `${cl.centerLineType === CenterLineType.VERTICAL ? 'x' : 'y'}=${Math.round(cl.effectiveValue)}${cl.beamAxisOrigin ? `(${cl.beamAxisOrigin})` : ''}`);

/**
 * 矩形でない寄棟（rect:null・rects。C2e-3b）の翼の表と振り分けを出す。翼の順・向き・矩形・段・棟木（頂点）・seed、
 * 翼ごとの桁行／妻側の線の部分（延長の印つき）。取り残し（unassigned）が1本でもあれば NG（被覆性の崩れ）。
 * @returns {number} 問題の件数（取り残しの本数）
 */
function printWings(region, F) {
  const { ridges, purlins } = roofFramingLines({
    rect: null, rects: region.rects, shape: region.shape, purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  const { wings, unassigned } = hipFramingWings({ rect: null, rects: region.rects, ridges, purlins, tolMm: tol });
  const lineName = l => `${l.isVertical ? 'x' : 'y'}=${l.coord} ${l.lo}..${l.hi}`;
  const portion = p => `${lineName(p)}${p.extendLo ? `（lo 延長←線の端 ${p.lineLo}）` : ''}${p.extendHi ? `（hi 延長←線の端 ${p.lineHi}）` : ''}`;
  console.log(`--- 翼 ${wings.length} 枚（順＝段の大きい順）。母屋 ${purlins.length} 本・棟木 ${ridges.length} 本 ---`);
  wings.forEach((w, i) => {
    const r = w.rect;
    console.log(`  W${i + 1} 桁行=${w.ketaVertical ? '縦' : '横'} 段=${w.levelMm} 矩形 x ${r.x1}..${r.x2} × y ${r.y1}..${r.y2}  ${w.ridge ? `棟木 ${lineName(w.ridge)}` : '頂点（方形）'}  ridgeCross=${w.ridgeCross} center=${w.center}  seeds=[${w.seeds.join(', ')}]`);
    console.log(`     桁行: ${w.keta.map(portion).join(' / ') || '-'}`);
    console.log(`     妻側 lo: ${w.gableLo.map(portion).join(' / ') || '-'}  hi: ${w.gableHi.map(portion).join(' / ') || '-'}`);
  });
  console.log(`  取り残し（unassigned）: ${unassigned.length} 本${unassigned.length > 0 ? ' — NG（被覆性が崩れている）: ' + unassigned.map(lineName).join(' / ') : ''}`);
  return unassigned.length;
}

/**
 * L字の下屋（rect:null・leanToWings・leanToDrains。E1b）の描画の内訳を出す。翼の表・水下の表と母屋の段の基準・棟木・
 * 母屋と斜め線（延長前→後）・水下の場の計算時間・外形線・取り残し。小屋梁・束の検査はしない（描画だけ。小屋梁は E2）。
 * @returns {number} 取り残しの本数（報告だけ。NG にしない）
 */
function printLeanToDrawing(region, F, ms) {
  const wings = region.leanToWings;
  const lineName = l => `${l.isVertical ? 'x' : 'y'}=${l.coord} ${l.lo}..${l.hi}`;
  console.log(`--- 翼 ${wings.length} 枚（順＝作った順）。計算時間 ${ms.toFixed(1)}ms（leanToFramingRegions の1階分） ---`);
  wings.forEach((w, i) => {
    const r = w.rect;
    const ext = w.domain.filter(d => d.entry !== 'direct').map(d => `x ${d.x1}..${d.x2} × y ${d.y1}..${d.y2}（入り口 ${d.entry}）`);
    console.log(`  W${i + 1} 流れ=${w.highSide} 壁 ${lineName(w.wallEdge)} 奥行き=${w.depthMm} rect x ${r.x1}..${r.x2} × y ${r.y1}..${r.y2}  延長: ${ext.join(' / ') || '-'}`);
  });
  // 水下への L∞ 距離の場（leanToDrainFraming）。水下の表・母屋の段の基準（長手方向の翼の奥行き → 軒までの残り r）・計算時間
  const drainName = d => `${d.isVertical ? 'x' : 'y'}=${d.coord} ${d.lo}..${d.hi}（外側 ${d.isVertical ? (d.outward > 0 ? '右' : '左') : (d.outward > 0 ? '下' : '上')}）`;
  console.log(`--- 水下 ${region.leanToDrains.length} 本: ${region.leanToDrains.map(drainName).join(' / ')} ---`);
  const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: region.leanToPurlinDepthMm, pitchMm: F.purlinPitchMm, startOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol });
  console.log(`  母屋の段の基準: 長手方向の翼の奥行き ${region.leanToPurlinDepthMm} → 軒までの残り r=${eaveGapMm}（段 r + k×${F.purlinPitchMm}）`);
  const t0 = performance.now();
  const field = leanToDrainFraming({ rects: region.rects, drains: region.leanToDrains, pitchMm: F.purlinPitchMm, firstLevelMm: eaveGapMm, tolMm: tol });
  const firstMs = performance.now() - t0;
  let minMs = Infinity;
  for (let k = 0; k < 20; k++) {
    const t1 = performance.now();
    leanToDrainFraming({ rects: region.rects, drains: region.leanToDrains, pitchMm: F.purlinPitchMm, firstLevelMm: eaveGapMm, tolMm: tol });
    minMs = Math.min(minMs, performance.now() - t1);
  }
  console.log(`  水下の場の計算時間（leanToDrainFraming の1回分）初回 ${firstMs.toFixed(1)}ms・以降20回の最小 ${minMs.toFixed(1)}ms`);
  const { purlins, ridges } = roofFramingLines({
    rect: null, rects: region.rects, shape: region.shape, leanToDrains: region.leanToDrains, leanToPurlinDepthMm: region.leanToPurlinDepthMm,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  const drawn = extendLinesToOutline({ lines: purlins, edges: region.edges, tolMm: tol });
  console.log(`--- 棟木 ${ridges.length} 本${ridges.length > 0 ? ': ' + ridges.map(lineName).join(' / ') : ''} ---`);
  console.log(`--- 母屋 ${purlins.length} 本（延長前 → 延長後） ---`);
  purlins.forEach((l, i) => console.log(`  ${lineName(l)}（水下から ${l.levelMm}） → ${drawn[i].lo}..${drawn[i].hi}`));
  const diagonals = roofHipDiagonals({ rect: null, rects: region.rects, shape: region.shape, leanToDrains: region.leanToDrains, tolMm: tol });
  const diagDrawn = extendDiagonalsToOutline({ diagonals, edges: region.edges, valleys: true, tolMm: tol });
  console.log(`--- 隅木・谷木 ${diagonals.length} 本（軒側→上端。延長前 → 延長後の軒側） ---`);
  diagonals.forEach((d, i) => console.log(`  ${d.kind} (${d.x1},${d.y1}) → (${d.x2},${d.y2})  延長後の軒側 (${diagDrawn[i].x1},${diagDrawn[i].y1})`));
  const mismatchedFraming = JSON.stringify(field.diagonals) !== JSON.stringify(diagonals) || JSON.stringify(field.purlins) !== JSON.stringify(purlins) || JSON.stringify(field.ridges) !== JSON.stringify(ridges);
  console.log(`  入口（roofFramingLines・roofHipDiagonals）と leanToDrainFraming の結果の一致: ${mismatchedFraming ? '不一致 — NG' : '一致'}`);
  console.log(`--- 外形線 ${region.outline.length} 閉路 ---`);
  region.outline.forEach((loop, i) => console.log(`  [${i}] ${loop.points.join(',')}`));
  const un = region.leanToUnassigned ?? [];
  console.log(`  取り残し（unassigned）: ${un.length} 件${un.length > 0 ? '（報告のみ。既知の限界）: ' + un.map(u => `x ${u.x1}..${u.x2} × y ${u.y1}..${u.y2}`).join(' / ') : ''}`);
  return un.length;
}

// 小屋梁・飛び梁（roofBeam）が、直交する梁（大梁を含む全部）と内部で交差している組の記述（空なら交差なし）。
function interiorCrossings(graph) {
  const lo = b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const hi = b => Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
  const name = b => `${b.isVertical ? 'x' : 'y'}=${b.axisValue}:${lo(b)}..${hi(b)}（${b.role}）`;
  const out = [];
  for (const a of graph.beams.filter(b => b.role === 'roofBeam')) {
    for (const b of graph.beams) {
      if (a === b || a.isVertical === b.isVertical) continue;
      if (b.axisValue > lo(a) + tol && b.axisValue < hi(a) - tol && a.axisValue > lo(b) + tol && a.axisValue < hi(b) - tol) out.push(`${name(a)} × ${name(b)}`);
    }
  }
  return out;
}

/** 小屋梁（role:'roofBeam'）の一覧（軸の通り芯名・区間・両端の host の通り芯名・断面・採番）を出し、小屋梁の配列を返す。 */
function printKoyaList(graph, listLabel) {
  const koya = graph.beams.filter(b => b.role === 'roofBeam');
  console.log(`--- 小屋梁 ${koya.length} 本（${listLabel}） ---`);
  const sorted = [...koya].sort((a, b) => a.axisValue - b.axisValue || Math.min(a.clStart.effectiveValue, a.clEnd.effectiveValue) - Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue));
  for (const b of sorted) {
    const lo = Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
    const hi = Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
    console.log(`  ${b.isVertical ? 'x' : 'y'}=${b.axisValue}（${clName(b.axisCL)}） ${lo}..${hi}  host: ${clName(b.clStart)} → ${clName(b.clEnd)}  断面=${b.sectionDefId} 採番=${b.memberNo} ${b.dimensionStatus}${b.beamType === '飛び梁' ? '  [飛び梁]' : ''}`);
  }
  return koya;
}

/**
 * L字の下屋（rect:null・leanToDrains。E2b）の構造の検査。面の表（水下ごと）・小屋梁の一覧（host 名つき）・
 * 全母屋の束の最大間隔（1820 超は NG。「支えの無い端の区間」の除外は設けない）・小屋梁と他の梁の内部での交差（NG）・
 * 同じ軸で重なる小屋梁（NG）・取り残し（報告だけ。既知の限界）を出す。
 * @returns {{violations:number, problems:number, koya:number, unassigned:number, strutMaxPitchMm:number}}
 */
function inspectLeanTo(graph, region, listLabel) {
  const rules = rulesFor(effectiveStructure(graph, project));
  const F = rules.framing;
  const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: region.leanToPurlinDepthMm, pitchMm: F.purlinPitchMm, startOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol });
  const faces = leanToDrainFraming({ rects: region.rects, drains: region.leanToDrains, pitchMm: F.purlinPitchMm, firstLevelMm: eaveGapMm, tolMm: tol }).faces;
  console.log(`--- 面 ${faces.length} 枚（水下ごと。小屋梁が支える面。順＝水下の長い順→上・下・左・右→座標順。水下と直交する向きの母屋が混ざる面は、小屋梁の側で向きごとに分ける） ---`);
  faces.forEach((fc, i) => {
    const d = fc.drain;
    console.log(`  F${i + 1} 水下 ${d.isVertical ? 'x' : 'y'}=${d.coord} ${d.lo}..${d.hi}  線の向き=${fc.lineIsVertical ? '縦' : '横'}  母屋 ${fc.lines.length} 本: ${fc.lines.map(l => `${l.isVertical ? 'x' : 'y'}=${l.coord} ${l.lo}..${l.hi}`).join(' / ') || '-'}`);
  });
  const koya = printKoyaList(graph, listLabel);

  const framing = roofFramingLines({
    rect: null, rects: region.rects, shape: region.shape, leanToDrains: region.leanToDrains, leanToPurlinDepthMm: region.leanToPurlinDepthMm,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  const purlins = [...framing.ridges, ...framing.purlins]; // 向かい合う水下があれば棟木も束の対象
  const allMembers = roofFramingHostMembers(graph.beams, rules.baseMaterial);
  const membersWithoutKoya = roofFramingHostMembers(graph.beams.filter(b => b.role !== 'roofBeam'), rules.baseMaterial);
  const maxGap = (line, members) => {
    const alongs = [line.lo, line.hi, ...roofStrutPoints([line], members, tol).map(p => (line.isVertical ? p.y : p.x))].sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i + 1 < alongs.length; i++) max = Math.max(max, alongs[i + 1] - alongs[i]);
    return { max, n: alongs.length };
  };
  console.log(`--- 母屋ごとの束の最大間隔（前＝小屋梁を数えない → 後＝数える。上限 ${F.strutMaxPitchMm}。全母屋 ${purlins.length} 本） ---`);
  let violations = 0;
  let worst = 0;
  for (const line of purlins) {
    const before = maxGap(line, membersWithoutKoya);
    const after = maxGap(line, allMembers);
    const ng = after.max > F.strutMaxPitchMm + tol;
    if (ng) violations++;
    worst = Math.max(worst, after.max);
    console.log(`  母屋 ${line.isVertical ? 'x' : 'y'}=${line.coord}（範囲 ${line.lo}..${line.hi}）: ${before.max} → ${after.max}  束 ${after.n}点${ng ? '  違反' : ''}`);
  }
  console.log(`  全母屋の束の最大間隔: ${worst}（上限 ${F.strutMaxPitchMm}）`);

  const crossings = interiorCrossings(graph);
  console.log(`--- 小屋梁と他の梁の内部での交差: ${crossings.length} 件${crossings.length > 0 ? ' — NG' : ''} ---`);
  for (const c of crossings) console.log(`  ${c}`);
  const overlaps = [];
  for (let i = 0; i < koya.length; i++) {
    for (let j = i + 1; j < koya.length; j++) {
      const a = koya[i];
      const b = koya[j];
      const l = x => Math.min(x.clStart.effectiveValue, x.clEnd.effectiveValue);
      const h = x => Math.max(x.clStart.effectiveValue, x.clEnd.effectiveValue);
      if (a.isVertical === b.isVertical && Math.abs(a.axisValue - b.axisValue) <= tol && Math.min(h(a), h(b)) - Math.max(l(a), l(b)) > tol) overlaps.push(`${a.isVertical ? 'x' : 'y'}=${a.axisValue}`);
    }
  }
  console.log(`--- 同じ軸で重なる小屋梁: ${overlaps.length} 件${overlaps.length > 0 ? ' — NG: ' + overlaps.join(' / ') : ''} ---`);
  const un = region.leanToUnassigned ?? [];
  console.log(`  取り残し（unassigned）: ${un.length} 件（母屋が無いので小屋梁なし。報告のみ。既知の限界）`);
  return { violations, problems: crossings.length + overlaps.length, koya: koya.length, unassigned: un.length, strutMaxPitchMm: F.strutMaxPitchMm };
}

/**
 * 1つの region の小屋梁の一覧と束の間隔を出し、違反数・除外区間数・小屋梁の本数を返す。
 * 矩形でない寄棟（C2e-3b）は、翼の表・取り残し・交差の検査を加え、束の間隔の「除外」は設けない（1820 超は全て違反）。
 * graph は region の小屋梁を載せる平面（主屋根＝屋根専用平面、下屋＝その実体階）。
 */
function inspectRegion(graph, region, listLabel) {
  const rules = rulesFor(effectiveStructure(graph, project));
  const F = rules.framing;
  console.log('region:', JSON.stringify(region));
  let problems = 0; // 矩形でない寄棟の取り残し・交差の件数（束の間隔の違反とは別に数える）
  const wingProblems = region.rect ? 0 : printWings(region, F);

  // ---- 小屋梁の一覧 ----
  const koya = printKoyaList(graph, listLabel);

  // ---- 束の間隔 ----
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, rects: region.rects ?? null, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  const lines = [...ridges.map(l => ({ ...l, kind: '棟木' })), ...purlins.map(l => ({ ...l, kind: '母屋' }))];
  const allMembers = roofFramingHostMembers(graph.beams, rules.baseMaterial);
  const membersWithoutKoya = roofFramingHostMembers(graph.beams.filter(b => b.role !== 'roofBeam'), rules.baseMaterial);
  const gapsOf = (line, members) => {
    const alongs = [line.lo, line.hi, ...roofStrutPoints([line], members, tol).map(p => (line.isVertical ? p.y : p.x))]
      .sort((a, b) => a - b);
    const gaps = [];
    for (let i = 0; i + 1 < alongs.length; i++) gaps.push({ a: alongs[i], b: alongs[i + 1], len: alongs[i + 1] - alongs[i] });
    return { alongs, gaps, max: Math.max(...gaps.map(g => g.len)) };
  };
  // 「支えの無い端の区間」: 位置 p（区間 a..b の中、a から910ごとの全点を試す）で、線を挟む左右の両方に host
  // （線と平行で p を跨ぐ大梁）があれば小屋梁をかけられた＝除外しない。どちらかが無ければ構造上かけられない＝除外して一覧に出す。
  // 寄棟（C2e-1b）は線の向きが混在するので、host は線ごとに決める: 桁行の線（棟木・環の長辺）は大梁だけ、妻側の線（環の短辺）は
  // 大梁＋その線と平行な小屋梁（第1段）。桁行の向きは roofRidgeIsVertical（正方形は横）。切妻・片流れは全ての線が同じ向きで、
  // 平行な小屋梁は無い（小屋梁は線と直交する）ので従来どおり大梁だけ。飛び梁は妻側の線と直交するので host にならない。
  const isHip = region.shape === RoofShape.HIP;
  const ketaVertical = isHip && region.rect ? roofRidgeIsVertical(region.rect, tol) : null;
  const hostsOf = (line) => graph.beams.filter(b => b.isVertical === line.isVertical && b.materialType === rules.baseMaterial
    && (b.role === 'primary' || (isHip && line.isVertical !== ketaVertical && b.role === 'roofBeam')));
  const boundedAt = (line, p) => {
    if (!region.rect) return true; // 矩形でない寄棟は「支えの無い端の区間」を設けない（1820 超は全て違反）
    const spans = hostsOf(line).filter(b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) - tol <= p && p <= Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) + tol);
    return spans.some(b => b.axisValue < line.coord - tol) && spans.some(b => b.axisValue > line.coord + tol);
  };
  console.log(`--- 母屋・棟木ごとの束の最大間隔（前＝小屋梁を数えない → 後＝小屋梁を数える。上限 ${F.strutMaxPitchMm}） ---`);
  let violations = 0;
  const excluded = [];
  for (const line of lines) {
    const before = gapsOf(line, membersWithoutKoya);
    const after = gapsOf(line, allMembers);
    const over = after.gaps.filter(g => g.len > F.strutMaxPitchMm + tol);
    const notes = [];
    for (const g of over) {
      // 区間内の910グリッドの全点を試す（2点だけだと、それ以外の位置ならかけられる区間まで除外してしまう）。
      const samples = [];
      for (let p = g.a + F.gridModuleMm; p < g.b - tol; p += F.gridModuleMm) samples.push(p);
      if (samples.some(p => boundedAt(line, p))) { violations++; notes.push(`違反 ${g.a}..${g.b}（${g.len}）`); }
      else { excluded.push({ line, ...g }); notes.push(`除外 ${g.a}..${g.b}（${g.len}。支えの無い端の区間）`); }
    }
    // 寄棟の棟木は、両端（隅木の上端）の下に横架材（束）が要る。端の束が無ければ違反。
    let endNote = '';
    if (isHip && region.rect && line.kind === '棟木') {
      const along = roofStrutPoints([line], allMembers, tol).map(p => (line.isVertical ? p.y : p.x));
      const missing = [line.lo, line.hi].filter(e => !along.some(a => Math.abs(a - e) <= tol));
      if (missing.length > 0) { violations++; endNote = `  違反 棟木の端に束なし（${missing.join(', ')}）`; } else endNote = '  棟木の両端に束あり';
    }
    const axisName = line.isVertical ? 'x' : 'y';
    console.log(`  ${line.kind} ${axisName}=${line.coord}（範囲 ${line.lo}..${line.hi}）: ${before.max} → ${after.max}  束 ${after.alongs.length}点${notes.length ? '  ' + notes.join(' / ') : ''}${endNote}`);
  }
  if (excluded.length > 0) {
    console.log('--- 除外した区間（支えの無い端） ---');
    for (const e of excluded) console.log(`  ${e.line.kind} ${e.line.isVertical ? 'x' : 'y'}=${e.line.coord} の ${e.a}..${e.b}（${e.len}）`);
  }
  if (!region.rect) {
    const crossings = interiorCrossings(graph);
    console.log(`--- 小屋梁・飛び梁と他の梁の内部での交差: ${crossings.length} 件${crossings.length > 0 ? ' — NG' : ''} ---`);
    for (const c of crossings) console.log(`  ${c}`);
    problems = crossings.length + wingProblems;
  }
  return { violations, problems, excluded: excluded.length, koya: koya.length, strutMaxPitchMm: F.strutMaxPitchMm };
}

// ---- 主屋根 ----
let failed = false;
let violations = 0;
let excludedCount = 0;
let koyaTotal = 0;
let strutMaxPitchMm = 1820;
if (!mainRegion) {
  console.log('主屋根の小屋組の region なし（在来でない／陸屋根・棟違い／矩形でない切妻・片流れ／屋根なし）: 対象外');
  const n = roofGraph.beams.filter(b => b.role === 'roofBeam').length;
  console.log(`  小屋梁の本数: ${n}（0であるはず）`);
  if (n > 0) failed = true;
} else {
  if (!mainRegion.rect) {
    const xs = mainRegion.rects.flatMap(r => [r.x1, r.x2]);
    const ys = mainRegion.rects.flatMap(r => [r.y1, r.y2]);
    console.log('主屋根: 矩形でない寄棟（C2e-3b。翼ごとに小屋梁・飛び梁）');
    console.log(`  セル矩形 ${mainRegion.rects.length} 個  外接 x ${Math.min(...xs)}..${Math.max(...xs)} / y ${Math.min(...ys)}..${Math.max(...ys)}`);
  }
  const r = inspectRegion(roofGraph, mainRegion, roofGraph.plane.name || '小屋伏図');
  violations += r.violations; excludedCount += r.excluded; koyaTotal += r.koya; strutMaxPitchMm = r.strutMaxPitchMm;
  if (r.problems > 0) {
    console.log(`NG: 矩形でない寄棟の取り残し（被覆性）・交差が合計 ${r.problems} 件`);
    failed = true;
  }
  if (r.koya === 0) {
    console.log('NG: region があるのに小屋梁が0本（この文書は小屋梁が要る形のはず）');
    failed = true;
  }
}

// ---- 下屋（実体階。C2d-2） ----
for (const { plane, graph, region } of leanTos) {
  console.log(`=== 下屋 [${planeLabel(plane)}] ${region.key} ===`);
  const r = inspectRegion(graph, region, `${planeLabel(plane)}の伏図（この階の小屋梁の全数）`);
  violations += r.violations; excludedCount += r.excluded; koyaTotal += r.koya; strutMaxPitchMm = r.strutMaxPitchMm;
}
// ---- L字の下屋（E1b の描画の内訳＋E2b の構造の検査） ----
for (const { plane, graph, region, ms } of lLeanTos) {
  console.log(`=== 下屋 [${planeLabel(plane)}] ${region.key}（L字。面ごとの小屋梁） ===`);
  console.log('region:', JSON.stringify(region));
  printLeanToDrawing(region, rulesFor(effectiveStructure(graph, project)).framing, ms);
  const r = inspectLeanTo(graph, region, `${planeLabel(plane)}の伏図（この階の小屋梁の全数）`);
  violations += r.violations; koyaTotal += r.koya; strutMaxPitchMm = r.strutMaxPitchMm;
  if (r.problems > 0) {
    console.log(`NG: L字の下屋の小屋梁の交差・同軸の重なりが合計 ${r.problems} 件`);
    failed = true;
  }
}
for (const s of strayFloors) {
  console.log(`NG: 下屋の region が無い階 [${planeLabel(s.plane)}] に auto の小屋梁が ${s.count} 本残っている`);
  failed = true;
}
if (!mainRegion && leanTos.length === 0 && lLeanTos.length === 0 && !failed) {
  console.log('小屋組の region が1つも無い文書: 対象外（exit 0）');
  process.exit(0);
}

// ---- 判定 ----
if (convergedAt === null || convergedAt > SWEEP_LIMIT) {
  console.log(`NG: 収束スイープ数 ${convergedAt ?? '未収束'}（上限 ${SWEEP_LIMIT}）`);
  failed = true;
}
if (violations > 0) {
  console.log(`NG: 束の最大間隔が ${strutMaxPitchMm} を超える区間が ${violations} 件（除外対象でない）`);
  failed = true;
}
console.log(`収束スイープ数: ${convergedAt}（上限 ${SWEEP_LIMIT}）  小屋梁: ${koyaTotal}本  除外区間: ${excludedCount}件${leanTos.length > 0 ? `  下屋: ${leanTos.length}件` : ''}${lLeanTos.length > 0 ? `  L字の下屋: ${lLeanTos.length}件` : ''}`);
console.log(failed ? 'RESULT: NG' : 'RESULT: OK');
process.exit(failed ? 1 : 0);
