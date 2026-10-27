// 課題(k) k4: k4StaticProbe.mjs の出力2つ（修正前 base・修正後 new）を比べる。
// 出すもの: 階ごとの梁芯・梁・柱の差（主構造別の集計つき）、収束回数が違うファイル、エラーが食い違うファイル。
// 引数: <base.json> <new.json>
// 使い方（app/ で実行）: node scripts/probe/k4StaticCompare.mjs base.json new.json
import fs from 'node:fs';

const [basePath, newPath] = process.argv.slice(2);
if (!basePath || !newPath) { console.error('usage: k4StaticCompare.mjs <base.json> <new.json>'); process.exit(1); }
const [a, b] = [basePath, newPath].map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
const diff = (x, y) => {
  const c = new Map(); for (const k of x) c.set(k, (c.get(k) ?? 0) + 1);
  const add = []; for (const k of y) { if ((c.get(k) ?? 0) > 0) c.set(k, c.get(k) - 1); else add.push(k); }
  const rem = []; for (const [k, n] of c) for (let i = 0; i < n; i++) rem.push(k);
  return { add, rem };
};
const by = {}; let files = 0, planes = 0, diffPlanes = 0, sweepDiff = 0;
for (let i = 0; i < a.length; i++) {
  const ra = a[i], rb = b[i];
  files++;
  if (ra.error || rb.error) { if (ra.error !== rb.error) console.log('ERRDIFF', ra.file); continue; }
  if (ra.sweeps !== rb.sweeps) { sweepDiff++; console.log('SWEEPS', ra.file, ra.sweeps, rb.sweeps); }
  for (let j = 0; j < ra.planes.length; j++) {
    const pa = ra.planes[j], pb = rb.planes[j];
    planes++;
    const s = by[pa.structure] ??= { planes: 0, diff: 0, axes: 0, beams: 0, cols: 0, removedBeams: 0, addedBeams: 0 };
    s.planes++;
    const da = diff(pa.axes, pb.axes), db = diff(pa.beams, pb.beams), dc = diff(pa.columns, pb.columns);
    const n = da.add.length + da.rem.length + db.add.length + db.rem.length + dc.add.length + dc.rem.length;
    if (n) {
      diffPlanes++; s.diff++; s.axes += da.add.length + da.rem.length; s.beams += db.add.length + db.rem.length; s.cols += dc.add.length + dc.rem.length;
      s.removedBeams += db.rem.length; s.addedBeams += db.add.length;
      console.log(`DIFF ${ra.file} ${pa.plane} [${pa.structure}] 梁芯±${da.add.length + da.rem.length} 梁 -${db.rem.length}/+${db.add.length} 柱±${dc.add.length + dc.rem.length}`);
      for (const k of da.rem) console.log('   axis- ' + k);
      for (const k of da.add) console.log('   axis+ ' + k);
      for (const k of db.rem) console.log('   beam- ' + k);
      for (const k of db.add) console.log('   beam+ ' + k);
    }
  }
}
console.log(JSON.stringify({ files, planes, diffPlanes, sweepDiff, by }, null, 1));
