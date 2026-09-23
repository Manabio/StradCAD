// openingProbe.mjs の出力（before/after）を比較する（sectionDiff.mjsと同じ位置づけ）。
// 各階の建具の安定ダンプ（id以外のcategory/subType/resolved/mechanism/カタログ既定値/寸法/
// 記号/採番タグ/姿図プリミティブ件数）と unresolvedSubTypeKeys の完全一致を要求する
// （＝建具カタログ変更に対する退行検出）。
//
// 使い方: node scripts/probe/openingDiff.mjs <before.json> <after.json>
// 終了コード: 不一致あり=1、完全一致=0、引数・入力エラー（用法違反）=2。
import fs from 'node:fs';

const USAGE = '用法: openingDiff.mjs <before.json> <after.json>';

class UsageError extends Error {}

function readJson(p, label) {
  if (!fs.existsSync(p)) throw new UsageError(`${label}が見つかりません: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new UsageError(`${label}を読めません（JSONが壊れています）: ${p}`);
  }
}

const DUMP_KEYS = ['openings'];

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

    const bUnresolved = b.unresolvedSubTypeKeys ?? [], aUnresolved = a.unresolvedSubTypeKeys ?? [];
    if (JSON.stringify(bUnresolved) !== JSON.stringify(aUnresolved)) {
      console.log(`NG: ${name}.unresolvedSubTypeKeys 不一致: before=${JSON.stringify(bUnresolved)} after=${JSON.stringify(aUnresolved)}`);
      ok = false;
    }
  }

  console.log(ok ? 'OK: 全プレーン一致（建具の解決値・寸法・記号・採番タグ・姿図・unresolvedSubTypeKeys完全一致）' : 'NG: 差分あり（上記参照）');
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
