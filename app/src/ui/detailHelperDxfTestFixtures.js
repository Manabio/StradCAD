// 部分詳細図ヘルパーの DXF 読込みまわりのテストで共有する部品（合成 DXF の組み立て・読込み）。
// 同じ中身をテストファイルごとに定義しない（実装方針 12）。新しいテストはここから引く。
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadDxf } from './detailHelperForm.js';
import { sha256HexWith } from '../detail/dxf/dxfProvenance.js';
import { dxfText, dxfLine, dxfSection } from '../detail/dxf/dxfTestFixtures.js';

// 下の層（detail/dxf）の共有部品を同じ名前で再 export する。
export { dxfText, dxfLine, dxfSection };
/** 閉じた折れ線（頂点の並びを LINE でつなぎ、最後の点から最初の点へ戻る）。 */
export const dxfPoly = (pts, layer) => pts.flatMap((p, i) => dxfLine(...p, ...pts[(i + 1) % pts.length], layer));
/** 矩形（(x, y) から幅 w・高さ h。DXF の座標＝y 上向き）。 */
export const dxfRect = (x, y, w, h, layer) => dxfPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layer);
/** ENTITIES の中身 body を、単位 mm（$INSUNITS=4）の DXF のバイト列にする。 */
export const dxfBytesOf = body => new TextEncoder().encode(dxfText([
  [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'], ...body, [0, 'ENDSEC'], [0, 'EOF'],
]));
/** 読込みに渡す sha256（Node の webcrypto）。 */
export const dxfDigest = sha256HexWith(webcrypto.subtle);
/** キーを固定する idFactory（JSON の比較用）。 */
export const fixedId = () => 'fixed-id';
/** body を DXF として読み込み、読込み状態（dxf）を返す。失敗はその場で落とす。 */
export const loadDxfBody = async body => {
  const r = await loadDxf({ bytes: dxfBytesOf(body), fileName: 'o.dxf', digest: dxfDigest });
  assert.equal(r.ok, true, r.message);
  return r.dxf;
};
