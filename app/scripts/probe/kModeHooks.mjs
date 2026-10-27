// 【S0 専用】k1 前のコミット d0d8fa8 のコードにだけ当たる。k1 で置換対象（rangeAware 等）が消えたため、
//   以後は K_MODE=current 以外は置換対象 0 箇所で落ちる（current は差し替えなしで動く）。
// 課題(k)（cl-conversion-limits.md 限界16 (k)）S0: 開口由来梁芯の重複ガードの範囲判定を、製品コードを変えずに切り替える
// ESM ロードフック本体（kModeSetup.mjs から registerHooks で登録される同期フック）。読込み時のソース文字列だけを差し替える。
// 環境変数 K_MODE:
//   current（既定）  差し替えなし＝製品どおり（rangeAware は S造だけ true）
//   case1            全主構造で rangeAware=true・端で接するのは別線（S造と同じ判定）
//   case2            非S造は rangeAware=true＋touchCounts:true（端で接するのも重なり＝h2 の「同じ線上は1本」）。S造は現状のまま
// 差し替え箇所（置換前の文字列が見つからなければ throw）:
//   structural/structuralAutoFill.js  autoFillOpeningBeamAxes への opts
//   structural/openingBeamAxes.js     autoFillOpeningBeamAxes の引数と findOpeningBeamAnchorCL の第4引数
const MODE = process.env.K_MODE ?? 'current';
if (!['current', 'case1', 'case2'].includes(MODE)) throw new Error(`K_MODE が不正: ${MODE}`);

function must(src, from, to, label) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`[kModeHooks] 置換対象が ${n} 箇所（1箇所でなければならない）: ${label}`);
  return src.replace(from, () => to);
}

export function load(url, context, nextLoad) {
  const r = nextLoad(url, context);
  if (MODE === 'current' || !url.includes('/app/src/structural/')) return r;
  const isAutoFill = url.endsWith('/structural/structuralAutoFill.js');
  const isOpening = url.endsWith('/structural/openingBeamAxes.js');
  if (!isAutoFill && !isOpening) return r;
  if (r.source == null) return r;
  let src = r.source.toString().split(String.fromCharCode(13)).join('');
  if (isAutoFill) {
    src = must(src, '{ rangeAware: rulesFor(structure).manualBeamAxisOnArchLines === true }',
      `{ rangeAware: true, touch: ${MODE === 'case2'} && rulesFor(structure).manualBeamAxisOnArchLines !== true }`, 'structuralAutoFill opts');
  } else {
    src = must(src, 'export function autoFillOpeningBeamAxes(graph, openingSources, { rangeAware = false } = {}) {',
      'export function autoFillOpeningBeamAxes(graph, openingSources, { rangeAware = false, touch = false } = {}) {', 'signature');
    src = must(src, '{ lo: src.lo, hi: src.hi })', '{ lo: src.lo, hi: src.hi, touchCounts: touch })', 'anchor call');
  }
  return { ...r, source: src, shortCircuit: r.shortCircuit };
}
