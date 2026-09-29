// スナップショットの往復冪等性（G4）確認用probe。参照解決の成否に依存せず、
// serializeGraph→restoreGraph（同一graphへ2回）で全CL・全壁のフィールドがidキーで不変であることを見る
// （260929_undo復帰時アーキ壁ドリフト修正.md ステップ4-2。案A＋Bの検証）。
// 通り芯側も serializeStructCLs→restoreStructCLs→serializeStructCLs で同様に比較する。
//
// index比較は禁止（decodeの配列順は生成順に依存し得るため）——id をキーにMap化してから比較する。
//
// checkValueSelfConsistency（G1本体）: 2回のdecode同士（例: d1 vs d2）を比較するだけの
// compareRows では、宙に浮いたrefIdによる案A以前の不良（未解決でもrefOffsetを加算し続ける）を
// 検出できない——「安定して間違ったまま」になるため round-trip の2点間には差が出ない
// （worktree 7f436a2実測で確認: compareRowsだけだと差分0のまま）。restoreGraph直後の
// 「生きたgraphのcl.value」を「復元元にしたbytesのvalueフィールド」と突き合わせることで、
// この種の不良を単発の往復でも検出する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/snapshotRoundTripProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../../src/graphSnapshot.js';
import { decode } from '../../src/schema/graphFbs.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/13.stq';

// 復元中のconsole.warn件数を数える（案B: 宙に浮いたrefId等の静的化warn。本番同型の観測点）。
let warnCount = 0;
const originalWarn = console.warn;
console.warn = (...args) => { warnCount++; originalWarn(...args); };

const CL_FIELDS = ['id', 'centerLineType', 'value', 'refId', 'refOffset',
  'extentLoRef', 'extentHiRef', 'extentLo', 'extentHi', 'labeled', 'trim', 'beamAxisOrigin'];
const WALL_FIELDS = ['axisCLId', 'axisOffset', 'isVertical', 'clStartId', 'startOffset', 'clEndId', 'endOffset',
  'wallFinish', 'backingOffset', 'backingDepth', 'finishSide', 'bandOffset', 'isRoomWall', 'isExteriorWall'];

function byId(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.id, r);
  return m;
}

// 自己整合性チェック（G1の核）: restoreGraph(g, bytes) 直後の「生きたgraphのcl.value（getter）」が、
// 復元元にした bytes を decode した「保存されていた value フィールド」と一致するはず——
// serializeGraph→restoreGraph は「保存した絶対座標を復元後も保つ」契約のため。
// 単純な2回round-tripのdecode同士比較（compareRows）だけでは、参照未解決時の意味のズレ
// （案A以前: refId未解決でも refOffset を加算し続ける不良）が「安定して間違ったまま」になり
// 検出できない（実測: 修正前worktreeでも compareRows は差分0 になる）——このチェックが無いと
// G1の「往復で絶対座標が不変」を実質的に検証できていないことになる。
function checkValueSelfConsistency(liveCLs, decodedRows, label, ngList) {
  const liveMap = new Map(liveCLs.map(cl => [cl.id, cl]));
  for (const row of decodedRows) {
    const live = liveMap.get(row.id);
    if (live === undefined) { ngList.push(`${label}[${row.id.slice(0, 8)}]: 復元後に生きたCLが見つからない`); continue; }
    if (live.value !== row.value) {
      ngList.push(`${label}[${row.id.slice(0, 8)}].value: 保存値=${row.value} だが復元後の生きたcl.value=${live.value}（差=${live.value - row.value}）`);
    }
    // extentLo/extentHi（null同士は一致扱い）: buildSnapshot（graphSnapshot.js）は
    // extentLoRef/extentHiRef が設定されているCLについては常に「静的フォールバック値
    // （cl._extentLo/_extentHi。valueと違い、参照解決後の計算値ではなく素の値）」を保存する
    // ——value（案Aでcl._value→cl.valueへ変更済み）とは異なり、extentLo/Hiはこの往復修正の対象外
    // （§5節に記載無し）。そのため refあり・解決済みのCLでは「生きたcl.extentLo（計算値）」と
    // 「row.extentLo（静的フォールバック）」は一致しないのが正常（実測: 13.stqだけで66件超）——
    // これを無条件に比較すると誤検出の山になる。ここでは refLo/HiRef が無い（静的指定のみの）CLに
    // 限定して比較する——このケースはgetterがそのまま_extentLo/_extentHiを返すため、素の値どうしの
    // 一致がそのまま「往復で絶対座標が保たれているか」の検証になる（refありCLの検証は
    // extentLoRef/HiRefそのものの静的化（案B）がcheckValueSelfConsistency外のconsole.warn件数で
    // 別途観測される）。
    for (const [f, refField] of [['extentLo', 'extentLoRef'], ['extentHi', 'extentHiRef']]) {
      if (row[refField] != null) continue;
      const liveVal = live[f] ?? null, rowVal = row[f] ?? null;
      if (liveVal !== rowVal) {
        ngList.push(`${label}[${row.id.slice(0, 8)}].${f}: 保存値=${rowVal} だが復元後の生きたcl.${f}=${liveVal}`);
      }
    }
  }
}

function compareRows(before, after, fields, label, ngList) {
  const bMap = byId(before), aMap = byId(after);
  if (bMap.size !== aMap.size) {
    ngList.push(`${label}: 件数が変化（${bMap.size} → ${aMap.size}）`);
  }
  for (const [id, b] of bMap) {
    const a = aMap.get(id);
    if (!a) { ngList.push(`${label}[${id.slice(0, 8)}]: 消失`); continue; }
    for (const f of fields) {
      const bv = JSON.stringify(b[f] ?? null), av = JSON.stringify(a[f] ?? null);
      if (bv !== av) ngList.push(`${label}[${id.slice(0, 8)}].${f}: ${bv} → ${av}`);
    }
  }
  for (const id of aMap.keys()) {
    if (!bMap.has(id)) ngList.push(`${label}[${id.slice(0, 8)}]: 新規出現`);
  }
}

console.log(`=== ${src} ===`);
const { project } = loadDocument(src);
const ngList = [];
const floorSummaries = [];

// ---- 各階: serializeGraph→restoreGraph→serializeGraph を2回 ----
for (const plane of project.planes) {
  const g = project.graphMap.get(plane.id);
  if (!g) continue;
  const s1 = serializeGraph(g);
  const d1 = decode(s1);
  restoreGraph(g, s1);
  checkValueSelfConsistency(g.centerLines, d1.centerLines, `${plane.name}.CL自己整合性(restore後1回目)`, ngList);
  const s2 = serializeGraph(g);
  const d2 = decode(s2);
  restoreGraph(g, s2);
  checkValueSelfConsistency(g.centerLines, d2.centerLines, `${plane.name}.CL自己整合性(restore後2回目)`, ngList);
  const s3 = serializeGraph(g);
  const d3 = decode(s3);

  compareRows(d1.centerLines, d2.centerLines, CL_FIELDS, `${plane.name}.CL(1→2)`, ngList);
  compareRows(d2.centerLines, d3.centerLines, CL_FIELDS, `${plane.name}.CL(2→3)`, ngList);
  compareRows(d1.walls, d2.walls, WALL_FIELDS, `${plane.name}.壁(1→2)`, ngList);
  compareRows(d2.walls, d3.walls, WALL_FIELDS, `${plane.name}.壁(2→3)`, ngList);

  floorSummaries.push(`${plane.name}: CL=${d1.centerLines.length}本 壁=${d1.walls.length}本`);
}

// ---- 通り芯: serializeStructCLs→restoreStructCLs→serializeStructCLs を2回 ----
{
  const s1 = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const d1 = decode(s1);
  restoreStructCLs(project.structGraph, project.structuralInfo, s1, project.memberGroupLedger);
  checkValueSelfConsistency(project.structGraph.centerLines, d1.centerLines, '通り芯.CL自己整合性(restore後1回目)', ngList);
  const s2 = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const d2 = decode(s2);
  restoreStructCLs(project.structGraph, project.structuralInfo, s2, project.memberGroupLedger);
  checkValueSelfConsistency(project.structGraph.centerLines, d2.centerLines, '通り芯.CL自己整合性(restore後2回目)', ngList);
  const s3 = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const d3 = decode(s3);

  compareRows(d1.centerLines, d2.centerLines, CL_FIELDS, '通り芯.CL(1→2)', ngList);
  compareRows(d2.centerLines, d3.centerLines, CL_FIELDS, '通り芯.CL(2→3)', ngList);

  floorSummaries.push(`通り芯: CL=${d1.centerLines.length}本`);
}

console.warn = originalWarn;

console.log('階ごとの本数:');
for (const s of floorSummaries) console.log(`  ${s}`);
console.log(`console.warn件数（復元中の静的化観測）: ${warnCount}`);

if (ngList.length > 0) {
  console.log(`NG: ${ngList.length}件の差分`);
  for (const line of ngList.slice(0, 30)) console.log(`  ${line}`);
  if (ngList.length > 30) console.log(`  ...他${ngList.length - 30}件`);
  process.exitCode = 1;
} else {
  console.log(`OK: snapshotRoundTripProbe 差分0（${src}）`);
}
