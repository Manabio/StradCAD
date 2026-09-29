// 宙に浮いた refId（親の通り芯が居ない階固有CL）を持つテスト.stqを作るスクリプト。
// 260929_undo復帰時アーキ壁ドリフト修正.md ステップ4-3（G3の赤→緑を確認するための再現データ）。
//
// D:/tatsuya/Download/13.stq のアクティブ階から、通り芯（structGraph）を refId で参照する
// 階固有CL（はね出し追従の子CL）を1本選び、その親を参照する子CL**すべて**について、
// 階スナップショット（decodeFloorSnapshot。restoreGraphのCL解決を経由しない生のplain object）上で
// refId を実在しないid（'ghost-'+元id）へ書き換える。value は書き換えない
// （現行コードの保存値＝cl.value＝絶対座標のまま）。refOffset も元のまま残す。
//
// 注意（本書§4-3）: 現行コードは復元時に未解決refIdを静的化して消してしまうため、この改変後の
// バイト列は restoreGraph を経由せず、plain object を直接 encode（graphFbs.js。serializeGraphが
// 内部で呼ぶのと同じ関数）して作る——restoreGraphを一度でも通すと即座に静的化されて再現データに
// ならない。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeDanglingRefTest.mjs [入力.stq] [出力先.stq]
import fs from 'node:fs';
import { parseDocumentEnvelope, buildDocumentJson } from '../../src/storage/documentFile.js';
import { decodeFloorSnapshot, decodePlanes } from '../../src/graphSnapshot.js';
import { decode, encode } from '../../src/schema/graphFbs.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const inPath = process.argv[2] ?? 'D:/tatsuya/Download/13.stq';
const outPath = process.argv[3] ?? 'D:/tatsuya/Download/dangling-ref-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const doc = parseDocumentEnvelope(JSON.parse(fs.readFileSync(inPath, 'utf8')));
const { planes, activePlaneId } = doc.planes ? decodePlanes(doc.planes) : { planes: [], activePlaneId: null };
const activePlane = planes.find(p => p.id === activePlaneId) ?? planes[0];
if (!activePlane) { console.error('NG: アクティブ階が見つからない'); process.exit(1); }

const structSnapshot = decode(doc.struct);
const structIds = new Set((structSnapshot.centerLines ?? []).map(cl => cl.id));

const activeFloorEntry = doc.floors.find(f => f.planeId === activePlane.id);
if (!activeFloorEntry) { console.error('NG: アクティブ階のフロアバイト列が見つからない'); process.exit(1); }

// decodeFloorSnapshot は decode(bytes) の生 plain object（restoreGraphのCL解決を経由しない）。
const floorSnapshot = decodeFloorSnapshot(activeFloorEntry.bytes);

// 通り芯(structIds)をrefIdで参照する階固有CL（はね出し追従の子CL）をrefIdでグループ化し、
// 参照本数が最大の親を選ぶ（「同じ親を参照するものすべて」を意味のある形で再現するため）。
const byParent = new Map();
for (const cl of floorSnapshot.centerLines ?? []) {
  if (cl.refId && structIds.has(cl.refId)) {
    if (!byParent.has(cl.refId)) byParent.set(cl.refId, []);
    byParent.get(cl.refId).push(cl);
  }
}
if (byParent.size === 0) {
  console.error(`NG: ${activePlane.name}に通り芯を参照する階固有CLが無い（このデータでは再現できない）`);
  process.exit(1);
}
let chosenParentId = null, chosenChildren = [];
for (const [parentId, children] of byParent) {
  if (children.length > chosenChildren.length) { chosenParentId = parentId; chosenChildren = children; }
}

const ghostId = `ghost-${chosenParentId}`;
console.log(`対象親（通り芯）: ${chosenParentId.slice(0, 8)} → ghostId=${ghostId.slice(0, 14)}...`);
for (const cl of chosenChildren) {
  console.log(`  書き換え: id=${cl.id.slice(0, 8)} value=${cl.value} refOffset=${cl.refOffset} (refId: ${cl.refId.slice(0, 8)} → ${ghostId.slice(0, 14)}...)`);
  cl.refId = ghostId; // value・refOffsetは書き換えない
}

// plain object を直接 encode（restoreGraphは経由しない。上記コメント参照）。
const newFloorBytes = encode(floorSnapshot);

// 検証: 生成後に decodeFloorSnapshot で読み戻し、refIdがghostのまま・valueが絶対座標であること。
const verifySnapshot = decodeFloorSnapshot(newFloorBytes);
const verifyMap = new Map((verifySnapshot.centerLines ?? []).map(cl => [cl.id, cl]));
const structCLMap = new Map((structSnapshot.centerLines ?? []).map(cl => [cl.id, cl]));
const parentCL = structCLMap.get(chosenParentId);
let verifyOk = true;
for (const cl of chosenChildren) {
  const v = verifyMap.get(cl.id);
  if (!v || v.refId !== ghostId || v.value !== cl.value) {
    verifyOk = false;
    console.error(`NG: 生成後の検証に失敗（id=${cl.id.slice(0, 8)}）: refId=${v?.refId} value=${v?.value}`);
    continue;
  }
  // 書き換え前の value が「親.value + refOffset」（はね出し追従の定義どおりの絶対座標）であることを
  // structSnapshot（書き換え対象のCLがまだ解決できていた元データ）から確かめる——書き換え前と同値
  // であることだけを見る従来の検証だと、value自体が最初から筋の通った値かどうかは見ていなかった。
  const expected = parentCL.value + cl.refOffset;
  if (v.value !== expected) {
    verifyOk = false;
    console.error(`NG: id=${cl.id.slice(0, 8)} の value(${v.value}) が 親.value(${parentCL.value})+refOffset(${cl.refOffset})=${expected} と一致しない`);
  }
}
if (!verifyOk) process.exit(1);
console.log(`OK: 生成後の検証（refId=ghost・valueは絶対座標のまま・value===親.value+refOffset）: ${chosenChildren.length}件`);

// ---- 文書を書き出す（アクティブ階だけ差し替え、他はそのまま） ----
const floors = doc.floors.map(f => f.planeId === activePlane.id ? { planeId: f.planeId, bytes: newFloorBytes } : f);
const json = buildDocumentJson({
  floors, struct: doc.struct, planes: doc.planes, site: doc.site, info: doc.info,
  bootPlaneId: doc.bootPlaneId, catalogs: doc.catalogs,
});
fs.writeFileSync(outPath, json);
console.log(`書き出し完了: ${outPath}`);
