// 課題(h) S0: hReproMeasure.mjs の --out JSON 同士を比べる読み取り専用の比較ツール。
// 目的: 基準（USER 梁芯なし）と再現データの収束後の差、および再現データの USER 梁芯削除前後の差を出す。
// 引数: <基準.json> <再現.json>   （どちらも hReproMeasure.mjs --out の出力。再現側は --delete 付きだと削除の段も比較する）
// 出力: 標準出力。梁の役割別本数、基準にあって再現に無い梁／その逆（role・向き・軸・区間）、対象座標の梁芯。
// 使い方: node scripts/probe/hReproCompare.mjs base.json repro.json   （ローダー不要。import は node 標準だけ）
import fs from 'node:fs';

const [basePath, reproPath] = process.argv.slice(2);
if (!basePath || !reproPath) { console.error('usage: hReproCompare.mjs <base.json> <repro.json>'); process.exit(1); }
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const repro = JSON.parse(fs.readFileSync(reproPath, 'utf8'));

const bkey = (b) => `${b.role}|${b.dir}${b.axis}|${b.lo}..${b.hi}`;
const axkey = (a) => `${a.dir}${a.value}[${a.extentLo},${a.extentHi}]${a.origin}`;

function diff(label, a, b) {
  const as = new Set(a.beams.map(bkey)), bs = new Set(b.beams.map(bkey));
  const onlyA = [...as].filter(k => !bs.has(k)), onlyB = [...bs].filter(k => !as.has(k));
  const aa = new Set(a.beamAxes.map(axkey)), ba = new Set(b.beamAxes.map(axkey));
  console.log(`--- ${label}`);
  console.log(`  roleCount  A=${JSON.stringify(a.roleCount)} B=${JSON.stringify(b.roleCount)}  columns A=${a.columnTotal} B=${b.columnTotal}  excluded A=${JSON.stringify(a.excludedWallBeamAxes)} B=${JSON.stringify(b.excludedWallBeamAxes)}`);
  console.log(`  Aだけの梁(${onlyA.length}): ${onlyA.join('  ')}`);
  console.log(`  Bだけの梁(${onlyB.length}): ${onlyB.join('  ')}`);
  console.log(`  Aだけの梁芯: ${[...aa].filter(k => !ba.has(k)).join('  ')}`);
  console.log(`  Bだけの梁芯: ${[...ba].filter(k => !aa.has(k)).join('  ')}`);
}

diff('基準(A) vs 再現の収束後(B)', base.afterConverge, repro.afterConverge);
if (repro.afterDelete) {
  diff('再現の収束後(A) vs USER梁芯削除直後(B)', repro.afterConverge, repro.afterDelete);
  repro.passes.forEach((p, i) => diff(`削除直後(A) vs 再計算${i + 1}回目(B)`, i === 0 ? repro.afterDelete : repro.passes[i - 1], p));
  diff('基準(A) vs 再計算3回目(B)', base.afterConverge, repro.passes[2]);
  console.log('対象座標 削除前:', JSON.stringify(repro.coordBefore));
  console.log('対象座標 再計算3回目:', JSON.stringify(repro.coordAfterPass3));
}
