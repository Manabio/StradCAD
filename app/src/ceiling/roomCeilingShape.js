/**
 * 部屋（親部屋・部分指定の子）の天井の形状・寸法（S12a。純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 *
 * 保存先は Room.customOverrides の2キー（FBS・graphSnapshot・undo スナップショット・仕上げ再解釈は汎用の keys/vals で往復するので変更なし）:
 *   ceilingShape … 'slope' | 'arc' | 'dome'（平面のときはキーを置かない）
 *   ceilingDims  … '500,90' のようなカンマ区切りの文字列（個数・値域は core/ceilingZone.js normalizeCeilingShape）
 * 見上げの「残り」の面（ceilingSurfaces.js。区画に入らなかったセル）がこの形状で描かれる。天井高は既存の CH（ceilingHeight）が基準高を兼ねる。
 * 子は親の形状を継承しない（部屋ごとに1つ）。
 */
import { CeilingShape } from '../core/constants.js';
import { normalizeCeilingShape, CEILING_SHAPE_DIM_COUNT } from '../core/ceilingZone.js';

export const ROOM_CEILING_SHAPE_KEY = 'ceilingShape';
export const ROOM_CEILING_DIMS_KEY = 'ceilingDims';

const FLAT = Object.freeze({ shape: CeilingShape.FLAT, dims: Object.freeze([]) });

/**
 * 部屋の天井の形状と寸法を読む（getFinishInfo 経由）。壊れた値（未知の形状・個数違い・数値でない・値域外）は例外にせず平面・[]。
 * room が null／getFinishInfo を持たないときも平面。
 * @returns {{shape: string, dims: number[]}}
 */
export function roomCeilingShapeOf(room) {
  if (typeof room?.getFinishInfo !== 'function') return { shape: FLAT.shape, dims: [] };
  const info = room.getFinishInfo();
  const rawShape = info?.[ROOM_CEILING_SHAPE_KEY];
  if (typeof rawShape !== 'string' || rawShape === '') return { shape: FLAT.shape, dims: [] };
  const rawDims = info[ROOM_CEILING_DIMS_KEY];
  return normalizeCeilingShape(rawShape, parseDimsText(rawShape, rawDims));
}

const DIM_TOKEN = /^-?\d+(\.\d+)?$/;

/**
 * '500,90' を数値配列にする（厳密）。要素数が形状の個数と一致し、各要素が 10進の数値表記のときだけ Number にする。
 * それ以外（空要素 '500,,90'・16進 '0x1F4'・個数違い・未知の形状）は null＝平面に落とす。
 */
function parseDimsText(shape, rawDims) {
  const n = CEILING_SHAPE_DIM_COUNT[shape];
  if (n === undefined) return null;
  const tokens = String(rawDims ?? '').split(',').map(s => s.trim());
  if (n === 0) return tokens.length === 1 && tokens[0] === '' ? [] : null;
  if (tokens.length !== n || !tokens.every(t => DIM_TOKEN.test(t))) return null;
  return tokens.map(Number);
}

/**
 * 部屋の天井の形状と寸法を書く。先に正規化し、平面（不正値も平面に落ちる）なら2キーとも消す。
 * 呼び側が withFinishUndo(graph, …) で包む前提（ここは undo を積まない）。
 * @returns {{shape: string, dims: number[]}} 実際に書いた（正規化後の）値
 */
export function setRoomCeilingShape(room, { shape, dims }) {
  const norm = normalizeCeilingShape(shape, dims);
  if (norm.shape === CeilingShape.FLAT) {
    room.clearOverride(ROOM_CEILING_SHAPE_KEY);
    room.clearOverride(ROOM_CEILING_DIMS_KEY);
  } else {
    room.setOverride(ROOM_CEILING_SHAPE_KEY, norm.shape);
    room.setOverride(ROOM_CEILING_DIMS_KEY, norm.dims.join(','));
  }
  return norm;
}

/**
 * 天井高（CH 欄 ceilingHeight）の下書きを部屋へ書く。呼び側が withFinishUndo で包む前提。
 * 原文から変わっていなければ触らない（仕上げ表のレンジ表記「2300～3500」を壊さない）／空なら override を消す／正の数なら数値で書く。
 * @param {object} room
 * @param {string} draftText 入力欄の文字列
 * @param {string|null|undefined} originalText 入力欄を開いたときの原文
 * @returns {boolean} 受理した（触らなかった場合を含む）なら true。正の数でない文字列は書かず false
 */
export function applyRoomCeilingHeightDraft(room, draftText, originalText) {
  const draft = String(draftText ?? '').trim();
  if (draft === String(originalText ?? '').trim()) return true;
  if (draft === '') {
    room.clearOverride('ceilingHeight');
    return true;
  }
  const n = Number(draft);
  if (!Number.isFinite(n) || n <= 0) return false;
  room.setOverride('ceilingHeight', n);
  return true;
}
