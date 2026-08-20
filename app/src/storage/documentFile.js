// .strad 文書ファイル（文書全体＝全階・plane一覧・通り芯/構造情報/採番台帳・敷地）の
// エンベロープ構築・パース。IndexedDB・DOM に依存しない純モジュール
// （node:test から単体 import 可能に保つこと）。
//
// エンベロープは JSON（先頭 '{'）——「開く」の形式判別（parseOpenedFileBytes が先頭バイトで
// JSON / FlatBuffers を判別する）を変えずに、旧形式（単一グラフ FlatBuffers・旧JSONスナップ
// ショット）と共存させるため。旧JSONスナップショットとは format キーの有無で区別する。

const FORMAT  = 'strad-document';
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
 * @param {{ floors: Array<{planeId: string, bytes: Uint8Array}>,
 *           struct: Uint8Array|null, planes: Uint8Array|null, site: Uint8Array|null,
 *           bootPlaneId: string|null }} doc
 */
export function buildDocumentJson({ floors, struct, planes, site, bootPlaneId }) {
  return JSON.stringify({
    format:  FORMAT,
    version: VERSION,
    bootPlaneId: bootPlaneId ?? null,
    struct: struct ? bytesToBase64(struct) : null,
    planes: planes ? bytesToBase64(planes) : null,
    site:   site   ? bytesToBase64(site)   : null,
    floors: floors.map(f => ({ planeId: f.planeId, bytes: bytesToBase64(f.bytes) })),
  });
}

/** パース済みJSONが文書エンベロープかどうか（旧JSONスナップショットとの区別）。 */
export function isDocumentEnvelope(data) {
  return !!data && typeof data === 'object' && data.format === FORMAT;
}

/**
 * 文書エンベロープを検証し、バイト列へ復元して返す。不正な内容は例外を投げる
 * （呼び出し側はストア消去より前に必ずこの検証を通すこと——不正ファイルで既存文書を
 * 消さないため）。
 */
export function parseDocumentEnvelope(data) {
  if (!isDocumentEnvelope(data)) throw new Error('strad文書ファイルではありません');
  if (data.version !== VERSION) throw new Error(`未対応の文書バージョンです: ${data.version}`);
  if (!Array.isArray(data.floors)) throw new Error('文書のフロアデータが不正です');
  return {
    bootPlaneId: typeof data.bootPlaneId === 'string' ? data.bootPlaneId : null,
    struct: data.struct ? base64ToBytes(data.struct) : null,
    planes: data.planes ? base64ToBytes(data.planes) : null,
    site:   data.site   ? base64ToBytes(data.site)   : null,
    floors: data.floors.map(f => {
      if (typeof f?.planeId !== 'string' || typeof f?.bytes !== 'string') {
        throw new Error('文書のフロアデータが不正です');
      }
      return { planeId: f.planeId, bytes: base64ToBytes(f.bytes) };
    }),
  };
}
