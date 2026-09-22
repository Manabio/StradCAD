// matCodeProbe.mjs の出力（before=振り直し前のHEAD／after=振り直し後）を比較する
// （diffPlanRegen.mjsと同じ位置づけ）。壁・柱・梁の安定ダンプ（id以外の位置・寸法）は完全一致を
// 要求し、backing（exterior/interior/ceiling/floorBacking）は「beforeの値をcatalog/
// legacyMaterialCodes.jsのLEGACY_MATERIAL_CODE_ALIASESで正規化した値」がafterの値と一致することを
// 要求する（=退行なく振り直しだけが効いていることの確認）。
//
// 【検出力の限界】matCodeProbe.mjsのヘッダ参照——在来木造文書はexterior/interiorWallBackingが
// conformWoodBackingで上書きされるため、この2フィールドの差分検出には非在来木造文書
// （例: 13.stq）を使うこと。
//
// 使い方: node scripts/probe/matCodeDiff.mjs <before.json> <after.json>
// 終了コード: 不一致あり=1、完全一致=0、引数・入力エラー（用法違反）=2。
import fs from 'node:fs';
import { LEGACY_MATERIAL_CODE_ALIASES } from '../../src/catalog/legacyMaterialCodes.js';

const USAGE = '用法: matCodeDiff.mjs <before.json> <after.json>';

class UsageError extends Error {}

function readJson(p, label) {
  if (!fs.existsSync(p)) throw new UsageError(`${label}が見つかりません: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new UsageError(`${label}を読めません（JSONが壊れています）: ${p}`);
  }
}

function normCode(c) {
  if (c == null) return c;
  return Object.prototype.hasOwnProperty.call(LEGACY_MATERIAL_CODE_ALIASES, c) ? LEGACY_MATERIAL_CODE_ALIASES[c] : c;
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
    const b = before.planes[name];
    const a = after.planes[name];
    if (!a) { console.log(`NG: after に ${name} が無い`); ok = false; continue; }

    for (const key of ['walls', 'columns', 'beams']) {
      const bArr = b[key], aArr = a[key];
      if (JSON.stringify(bArr) !== JSON.stringify(aArr)) {
        console.log(`NG: ${name}.${key} が一致しない（件数 before:${bArr.length} after:${aArr.length}）`);
        const bSet = new Set(bArr), aSet = new Set(aArr);
        console.log('  beforeのみ', bArr.filter(x => !aSet.has(x)).slice(0, 5));
        console.log('  afterのみ', aArr.filter(x => !bSet.has(x)).slice(0, 5));
        ok = false;
      }
    }

    for (const field of ['exteriorWallBacking', 'interiorWallBacking', 'ceilingBacking', 'floorBacking']) {
      const bVal = normCode(b.backing[field]);
      const aVal = a.backing[field];
      if (bVal !== aVal) {
        console.log(`NG: ${name}.backing.${field} 不一致: normalize(before)=${bVal} after=${aVal}（before生値=${b.backing[field]}）`);
        ok = false;
      }
    }
    if (a.backing.exteriorWallBackingClass !== b.backing.exteriorWallBackingClass) {
      console.log(`NG: ${name}.backing.exteriorWallBackingClass 不一致: before=${b.backing.exteriorWallBackingClass} after=${a.backing.exteriorWallBackingClass}`);
      ok = false;
    }
  }

  console.log(ok ? 'OK: 全プレーン一致（幾何完全一致・backingは正規化後一致）' : 'NG: 差分あり（上記参照）');
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
