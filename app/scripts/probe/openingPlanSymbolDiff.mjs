// openingPlanSymbolProbe.mjs の出力（before/after）を比較する（openingDiff.mjs / sectionDiff.mjsと
// 同じ位置づけ）。各plane×LODのitems（安定キー＋Konva props列）の完全一致、--sweepで採った場合は
// sweep.items（comboKey＋Konva props列）の完全一致も要求する。
//
// 使い方: node scripts/probe/openingPlanSymbolDiff.mjs <before.json> <after.json>
// 終了コード: 不一致あり=1、完全一致=0、引数・入力エラー（用法違反）=2。
import fs from 'node:fs';

const USAGE = '用法: openingPlanSymbolDiff.mjs <before.json> <after.json>';

class UsageError extends Error {}

function readJson(p, label) {
  if (!fs.existsSync(p)) throw new UsageError(`${label}が見つかりません: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new UsageError(`${label}を読めません（JSONが壊れています）: ${p}`);
  }
}

const LOD_LEVELS = ['schematic', 'standard', 'detail'];

// key（または comboKey）で突き合わせ、不一致の先頭数件だけ表示する共通ヘルパ。
function diffItems(label, bItems, aItems, keyField) {
  let ok = true;
  if (JSON.stringify(bItems) === JSON.stringify(aItems)) return true;
  console.log(`NG: ${label} が一致しない（件数 before:${bItems.length} after:${aItems.length}）`);
  const bMap = new Map(bItems.map(i => [i[keyField], i]));
  const aMap = new Map(aItems.map(i => [i[keyField], i]));
  const allKeys = new Set([...bMap.keys(), ...aMap.keys()]);
  let shown = 0;
  for (const key of allKeys) {
    const bi = bMap.get(key), ai = aMap.get(key);
    if (JSON.stringify(bi) === JSON.stringify(ai)) continue;
    ok = false;
    if (shown < 8) {
      if (!bi) console.log(`  afterのみ ${keyField}=${key}`);
      else if (!ai) console.log(`  beforeのみ ${keyField}=${key}`);
      else {
        console.log(`  差分 ${keyField}=${key}`);
        console.log(`    before: ${JSON.stringify(bi.rows)}`);
        console.log(`    after : ${JSON.stringify(ai.rows)}`);
      }
      shown += 1;
    }
  }
  return ok;
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) throw new UsageError('before.json/after.jsonの指定が不足しています');

  const before = readJson(beforePath, 'before.json');
  const after = readJson(afterPath, 'after.json');

  let ok = true;

  const planeNamesBefore = Object.keys(before.planes ?? {}).sort();
  const planeNamesAfter = Object.keys(after.planes ?? {}).sort();
  if (JSON.stringify(planeNamesBefore) !== JSON.stringify(planeNamesAfter)) {
    console.log('NG: plane名の集合が違う', planeNamesBefore, planeNamesAfter);
    ok = false;
  }

  for (const name of planeNamesBefore) {
    const b = before.planes[name], a = after.planes[name];
    if (!a) { console.log(`NG: after に ${name} が無い`); ok = false; continue; }
    for (const lod of LOD_LEVELS) {
      const bItems = b.byLod?.[lod]?.items ?? [];
      const aItems = a.byLod?.[lod]?.items ?? [];
      if (!diffItems(`${name}.${lod}`, bItems, aItems, 'key')) ok = false;
    }
  }

  if (before.sweep || after.sweep) {
    const bItems = before.sweep?.items ?? [];
    const aItems = after.sweep?.items ?? [];
    if (!diffItems('sweep', bItems, aItems, 'comboKey')) ok = false;
  }

  console.log(ok ? 'OK: 全プレーン・LOD（sweep込み）完全一致' : 'NG: 差分あり（上記参照）');
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  throw e;
}
