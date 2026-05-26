const KIND_LABEL = { struct: '構造芯', center: '中心線', aux: '補助線' };

export const ERR_CL_DUPLICATE = (kind) =>
  `既に同じ位置に${KIND_LABEL[kind]}があり、追加できません。`;

export const ERR_CL_CENTER_UPGRADED =
  '同位置に中心線があります。その中心線を削除して、追加する構造芯を参照するように変更します。';

export const ERR_CL_STRUCT_EXISTS =
  '同位置に構造芯があり、追加できません。';

export const ERR_DRAW = 'Draw error:';
