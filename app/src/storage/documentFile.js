// .stq 文書ファイル（文書全体＝全階・plane一覧・通り芯/構造情報/採番台帳・敷地・カタログ同梱）の
// エンベロープ構築・パース。IndexedDB・DOM に依存しない純モジュール
// （node:test から単体 import 可能に保つこと）。
//
// エンベロープは JSON（先頭 '{'）——「読込み」の形式判別（parseOpenedFileBytes が先頭バイトで
// JSON / FlatBuffers を判別する）を変えずに、旧形式（単一グラフ FlatBuffers・旧JSONスナップ
// ショット）と共存させるため。旧JSONスナップショットとは format キーの有無で区別する。
//
// catalogs（カタログ束の同梱）は optional。version は 1 のまま——旧 .stq
// （catalogs 無し）はそのまま開け、新 .stq を旧ビルドで開いても catalogs は未知キーとして
// 無視される（片方向の後方互換）。catalog/catalogCodec.js・catalogBundle.js は葉モジュールのため
// このファイル（同じく葉）から静的 import してよい。

import { encodeCatalogBundle, decodeCatalogBundle } from '../catalog/catalogCodec.js';
import { validateBundle, migrateBundle, formatMigrationNotice } from '../catalog/catalogBundle.js';

const FORMAT  = 'stq-document';
const VERSION = 1;

// Uint8Array → base64。大容量でも引数上限に当たらない1文字ずつの変換方式
// （localSnapshot.js の writeLocalAutosave と同方式）。
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

/**
 * 文書エンベロープの JSON 文字列を構築する。
 * info（調査・計画情報）だけはFBSバイト列ではなくプレーンJSONのため base64 にせず
 * オブジェクトのまま持つ（storage/projectInfo.js 参照）。
 * catalogs（カタログ束。省略・null可）は encodeCatalogBundle でバイト列化してから base64 にする
 * ——呼び出し側（store.js）はカタログ束オブジェクトをそのまま渡せばよい（二重にエンコードしない）。
 * @param {{ floors: Array<{planeId: string, bytes: Uint8Array}>,
 *           struct: Uint8Array|null, planes: Uint8Array|null, site: Uint8Array|null,
 *           info: object|null, bootPlaneId: string|null, catalogs?: object|null }} doc
 */
export function buildDocumentJson({ floors, struct, planes, site, info, bootPlaneId, catalogs }) {
  return JSON.stringify({
    format:  FORMAT,
    version: VERSION,
    bootPlaneId: bootPlaneId ?? null,
    struct: struct ? bytesToBase64(struct) : null,
    planes: planes ? bytesToBase64(planes) : null,
    site:   site   ? bytesToBase64(site)   : null,
    info:   info ?? null,
    floors: floors.map(f => ({ planeId: f.planeId, bytes: bytesToBase64(f.bytes) })),
    catalogs: catalogs ? bytesToBase64(encodeCatalogBundle(catalogs)) : null,
  });
}

/** パース済みJSONが文書エンベロープかどうか（旧JSONスナップショットとの区別）。 */
export function isDocumentEnvelope(data) {
  return !!data && typeof data === 'object' && data.format === FORMAT;
}

/**
 * 文書エンベロープを検証し、バイト列へ復元して返す。不正な内容は例外を投げる
 * （呼び出し側はストア消去より前に必ずこの検証を通すこと——不正ファイルで既存文書を
 * 消さないため）。catalogs があれば decodeCatalogBundle → validateBundle まで通し、
 * 壊れていればその場で例外にする（他のフィールドと同じ「ストア消去より前に弾く」契約に乗る）。
 * 旧 .stq（catalogs 無し）は catalogs: null・migrated: [] を返す。
 *
 * QA指摘Minor-2（ステップ14-S再指摘）: 移行（migrateBundle）が起きた内容を戻り値の
 * `migrated`（catalogBundle.js migrateBundle の migrated[] そのもの）として呼び出し側
 * （store.js importDocument）へ渡す——本関数自身はconsole.warn止まりで、利用者に見える通知
 * （project.setCatalogError等）を出す手段を持たない（純モジュール・DOM/store非依存の方針）ため、
 * 通知の組み立て・発火は呼び出し側の責務にする（catalogOverlayLoader.jsのonNoticeと同じ役割分担）。
 */
export function parseDocumentEnvelope(data) {
  if (!isDocumentEnvelope(data)) throw new Error('stq文書ファイルではありません');
  if (data.version !== VERSION) throw new Error(`未対応の文書バージョンです: ${data.version}`);
  if (!Array.isArray(data.floors)) throw new Error('文書のフロアデータが不正です');
  let catalogs = null;
  let migrated = [];
  if (data.catalogs) {
    if (typeof data.catalogs !== 'string') throw new Error('文書のカタログ同梱データが不正です');
    const decoded = decodeCatalogBundle(base64ToBytes(data.catalogs));
    // ステップ14-S（裁定1）: validateBundle の前に migrateBundle を通す——修正前の
    // parseSectionSpec のバグで作られた不正データ（例: 負の断面）を持つ .stq でも開けるように、
    // 検証で弾く前に正しい内容へ書き換えて救済する（catalog/catalogOverlayLoader.js と同じ手順）。
    // 移行後の束をそのまま catalogs として返す——呼び出し側（store.js importDocument）が
    // 種別ごとに分割してIDBへ書き戻すため、追加の書戻し処理は不要。
    const migratedResult = migrateBundle(decoded);
    for (const m of migratedResult.migrated) console.warn(`カタログ移行: ${formatMigrationNotice(m)}`);
    validateBundle(migratedResult.bundle);
    catalogs = migratedResult.bundle;
    migrated = migratedResult.migrated;
  }
  return {
    bootPlaneId: typeof data.bootPlaneId === 'string' ? data.bootPlaneId : null,
    struct: data.struct ? base64ToBytes(data.struct) : null,
    planes: data.planes ? base64ToBytes(data.planes) : null,
    site:   data.site   ? base64ToBytes(data.site)   : null,
    info:   (data.info && typeof data.info === 'object') ? data.info : null,
    floors: data.floors.map(f => {
      if (typeof f?.planeId !== 'string' || typeof f?.bytes !== 'string') {
        throw new Error('文書のフロアデータが不正です');
      }
      return { planeId: f.planeId, bytes: base64ToBytes(f.bytes) };
    }),
    catalogs,
    migrated,
  };
}
