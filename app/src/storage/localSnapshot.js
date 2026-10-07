// 文書ファイル（.stq）の書き出し・読み込みパース処理。App.jsx から抽出し、
// ディスパッチ（id分岐）・FileReader配線・toast表示は App.jsx に残す。
// 旧「読込み/書出し」メニューが使っていた localStorage 自動保存（単一グラフ）は廃止済み——
// 残骸キーの掃除だけを clearLocalAutosave が担う。

// 旧・単一グラフ自動保存のキー（廃止済み。現在は掃除のためだけに参照する）。
const LEGACY_AUTOSAVE_KEY = 'strad-autosave';

// 旧・自動保存データの残骸を消去する（「新規（全消去）」メニュー専用）。キー文字列の唯一の
// 所有者はこのモジュール——他モジュール（store.js 等）はハードコードしないこと。
export function clearLocalAutosave() {
  localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
}

// オープン中の文書ファイル名（読込みした File.name、または保存で確定した名前。拡張子付き）の
// localStorage キー。読込みは location.reload() を伴うため reload をまたいで残す。キー文字列の唯一の所有者はこのモジュール。
const OPENED_FILE_NAME_KEY = 'strad-opened-file-name';
// 上の名前が「実際の保存名として確認できていない」印（'1'）。実名を取れないブラウザ（<a download> 退避）で
// 保存したときに立て、表示では名前の後ろにグレーの「(?)」を付ける（ユーザー指示2026-10-07。表示名のまま確定して
// ブラウザが「(1)」を付けていても気づけるように）。読込み・ピッカー保存で確定名になれば消す。
const OPENED_FILE_NAME_UNCONFIRMED_KEY = 'strad-opened-file-name-unconfirmed';

// オープン中の文書ファイル名。未設定なら null。
export function getOpenedFileName() {
  return localStorage.getItem(OPENED_FILE_NAME_KEY);
}

// オープン中の文書ファイル名と確定の有無。未設定なら null。表示（App.jsx）はこちらを使う。
export function getOpenedFileInfo() {
  const name = getOpenedFileName();
  if (name == null) return null;
  return { name, confirmed: localStorage.getItem(OPENED_FILE_NAME_UNCONFIRMED_KEY) !== '1' };
}

// confirmed=false は「実際の保存名として確認できていない」（退避経路で保存した）印。既定は確定扱い（読込みの File.name は実名）。
export function setOpenedFileName(name, confirmed = true) {
  localStorage.setItem(OPENED_FILE_NAME_KEY, name);
  if (confirmed) localStorage.removeItem(OPENED_FILE_NAME_UNCONFIRMED_KEY);
  else localStorage.setItem(OPENED_FILE_NAME_UNCONFIRMED_KEY, '1');
}

export function clearOpenedFileName() {
  localStorage.removeItem(OPENED_FILE_NAME_KEY);
  localStorage.removeItem(OPENED_FILE_NAME_UNCONFIRMED_KEY);
}

// 読込みしたファイル名から保存ダイアログ用の名前（拡張子なし）を得る。末尾の .stq（大小無視）だけを外す。
export function saveNameFromOpenedFileName(name) {
  return name.replace(/\.stq$/i, '');
}

// 既定の文書ファイル名（拡張子なし・保存日時入り）。保存ダイアログの初期値に使う。
export function defaultDocumentFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `strad-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 文書ファイル（JSONエンベロープ文字列。store.js の exportDocument が構築）を
// .stq としてダウンロード書き出しする（「読込み」が読める形式）。
// fileName は拡張子なしでも可（.stq を補う）。省略時は既定名。
export function downloadDocumentFile(json, fileName = defaultDocumentFileName()) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = fileName.endsWith('.stq') ? fileName : `${fileName}.stq`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// OS の保存ダイアログ（showSaveFilePicker）が使えるか。使えるなら名前も OS 側で指定できるので、
// アプリ側のファイル名ダイアログ（SaveFileDialog）は出さない（ユーザー裁定2026-10-07。二重入力の解消）。
// 非対応ブラウザ（<a download> 退避）では名前を指定できる場所が他に無いため、アプリ側のダイアログを出す。
export function supportsSaveFilePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

// 保存先の確定（2段階）。showSaveFilePicker は transient user activation を要するため、
// 呼び出し側は時間のかかる await（構造同期待ち・exportDocument）より前に openDocumentFileTarget を呼ぶこと。
// 書込み（writeDocumentFileTarget）は後でよい。
// 戻り値: { kind:'handle', handle, name, confirmed:true } = 実際に保存される名前（ブラウザが「(1)」等を付けた名前を含む）／
//   { kind:'download', name, confirmed:false } = 非対応ブラウザ（実名は取得不能なので要求名。表示は「(?)」付き）／
//   null = ユーザーが取消。
export async function openDocumentFileTarget(fileName = defaultDocumentFileName()) {
  const requested = fileName.endsWith('.stq') ? fileName : `${fileName}.stq`;
  if (supportsSaveFilePicker()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: requested,
        types: [{ description: 'strad 文書', accept: { 'application/json': ['.stq'] } }],
      });
      return { kind: 'handle', handle, name: handle.name, confirmed: true };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // SecurityError（user activation 切れ・iframe 内）等はダウンロードへ切り替えず失敗として伝える
      // （ユーザー裁定2026-10-07 案A。呼び出し順は同期で activation は切れないはずで、切れたらバグ。
      // 退避で隠さず「保存に失敗」で気づけるようにする）。
      throw e;
    }
  }
  return { kind: 'download', name: requested, confirmed: false };
}

// openDocumentFileTarget で得た保存先へ json を書き込む。書込み途中の失敗（ディスク満杯・権限取消等）は
// ストリームを abort（一時ファイルを残さない）してから例外を伝える。呼び出し側はその場合ファイル名を更新しないこと。
export async function writeDocumentFileTarget(target, json) {
  if (target.kind === 'handle') {
    const w = await target.handle.createWritable();
    try {
      await w.write(json);
      await w.close();
    } catch (e) {
      await w.abort?.();
      throw e;
    }
    return;
  }
  downloadDocumentFile(json, target.name);
}

// 「ファイルを開く」で読み込んだバイト列（JSON=旧形式 or FlatBuffers=新形式）を
// restoreGraph に渡せる形へパースする。不正な内容は例外を投げる。
export function parseOpenedFileBytes(bytes) {
  return bytes[0] === 0x7B // '{' = JSON
    ? JSON.parse(new TextDecoder().decode(bytes))
    : bytes;
}
