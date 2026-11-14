// DXF 読込みのテストで共有する合成 DXF の組み立て部品。
// 同じ中身をテストファイルごとに定義しない（実装方針 12）。製品コードは引かない。

/** [group code, 値] の並びを ASCII DXF の本文にする。 */
export const dxfText = pairs => `${pairs.map(([c, v]) => `${c}\n${v}`).join('\n')}\n`;
/** LINE 1 本（レイヤは既定 '0'）。 */
export const dxfLine = (x1, y1, x2, y2, layer = '0') => [[0, 'LINE'], [8, layer], [10, x1], [20, y1], [11, x2], [21, y2]];
/** SECTION name の本体 body を SECTION〜ENDSEC の対の並びにする。 */
export const dxfSection = (name, body) => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
