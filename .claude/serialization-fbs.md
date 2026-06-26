# FlatBuffersシリアライズの境界線

正確なフィールド一覧は`schema/graphFbs.js`が単一の正（読めば分かる）。ここには変更時に必ず守るべき境界線のみ記す。

## フィールドindexは位置的な契約——既存indexの再利用・並び替え禁止
新しいフィールドは必ず末尾に追加する。既存indexを別の意味に転用したり欠番を詰めたりすると、保存済みデータ（IndexedDB・エクスポート済みファイル）の復元が壊れる。

## GraphSnapshotは1つのルートテーブルをper-floor/project-levelで共有する
フィールド集合は互いに重複しない前提（per-floor用フィールドはproject blobで常に空、逆も同様）。新しいproject全体データを追加する場合もこの使い分けを維持する。

## サブタイプ別フィールドはJSON.stringify/parseを使わずkeys[]/vals[]のペア配列で表現する
`structural/fieldPacking.js`の`packExtraFields`/`unpackExtraFields`が規約。1段ネストはドット記法キーでフラット化する。

## restoreGraphは復元順序に依存する箇所がある
CL→壁→開口→部屋→境界エッジ等の順で解決する。新しいテーブルを追加する際は`applySnapshot`の既存ステップ順と参照関係を確認すること。

## decode入力はUint8Array/ArrayBuffer/plain object（旧JSON、後方互換）の3形態を受理する
ファイル先頭バイトが`0x7B`('{')ならJSONテキストとして扱う。新規コードでJSON経路を追加しない。
