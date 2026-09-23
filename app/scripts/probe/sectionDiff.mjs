// sectionProbe.mjs の出力（before/after）を比較する（matCodeDiff.mjsと同じ位置づけ）。
// 柱・梁・耐力壁・スラブ・基礎の安定ダンプ（id以外の位置・寸法・sectionDefId・解決値）と、
// 各階のunresolvedSectionIdsの完全一致を要求する（=断面カタログ変更に対する退行検出）。
//
// 使い方: node scripts/probe/sectionDiff.mjs <before.json> <after.json>
// 終了コード: 不一致あり=1、完全一致=0、引数・入力エラー（用法違反）=2。
import fs from 'node:fs';

const USAGE = '用法: sectionDiff.mjs <before.json> <after.json>';

class UsageError extends Error {}

function readJson(p, label) {
  if (!fs.existsSync(p)) throw new UsageError(`${label}が見つかりません: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new UsageError(`${label}を読めません（JSONが壊れています）: ${p}`);
  }
}

const DUMP_KEYS = ['columns', 'beams', 'structuralWalls', 'slabs', 'footings'];

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
    const b = before.planes[name];
    const a = after.planes[name];
    if (!a) { console.log(`NG: after に ${name} が無い`); ok = false; continue; }

    for (const key of DUMP_KEYS) {
      const bArr = b[key] ?? [], aArr = a[key] ?? [];
      if (JSON.stringify(bArr) !== JSON.stringify(aArr)) {
        console.log(`NG: ${name}.${key} が一致しない（件数 before:${bArr.length} after:${aArr.length}）`);
        const bSet = new Set(bArr), aSet = new Set(aArr);
        console.log('  beforeのみ', bArr.filter(x => !aSet.has(x)).slice(0, 5));
        console.log('  afterのみ', aArr.filter(x => !bSet.has(x)).slice(0, 5));
        ok = false;
      }
    }

    const bUnresolved = b.unresolvedSectionIds ?? [], aUnresolved = a.unresolvedSectionIds ?? [];
    if (JSON.stringify(bUnresolved) !== JSON.stringify(aUnresolved)) {
      console.log(`NG: ${name}.unresolvedSectionIds 不一致: before=${JSON.stringify(bUnresolved)} after=${JSON.stringify(aUnresolved)}`);
      ok = false;
    }
  }

  console.log(ok ? 'OK: 全プレーン一致（幾何・sectionDefId・解決値・unresolvedSectionIds完全一致）' : 'NG: 差分あり（上記参照）');
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
