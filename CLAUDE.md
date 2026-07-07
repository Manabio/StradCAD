# strad — 建築CADアプリ

> `問題.md` はユーザーが書き溜める一時課題メモ。毎セッション削除される一時ファイル。明示的に読めと指示された場合のみ開く。本ドキュメント・`.claude/`配下・コードコメントから参照・依存しない。

ファイル全体を出力せず、差分（Diff）のみを出力
実装の詳細や例外処理の長文な説明は不要
検索や探索を行う際は Haiku などの軽量・安価なモデルを使用

## 言語設定
会話・コメント・ドキュメントはすべて日本語で書く。

## 技術スタック
React19+Vite / react-konva(Konva.js) / MobX6 / ngraph.graph(マルチグラフ) / FlatBuffers(シリアライズ) / IndexedDB(永続化) / rbush(空間index)。単位mm、y軸下向き正。

## ファイル構成（分類のみ。各ファイルの役割・APIはソースを参照）
```
app/src/
├── core.js, store.js, App.jsx                     ドメインモデル・MobXストア・メイン
├── viewport.js, snap.js, undoManager.js, graphSnapshot.js, error.js
├── modes/        モード状態（MobX、切替時に動的ロード・破棄）
├── schema/       FlatBuffers encode/decode
├── storage/      IndexedDB永続化
├── renderer/     Konva描画レイヤー
├── interaction/  ポインタ操作フック・メニュー定義
├── transform/    空間インデックス・変形・随伴探査
├── openings/     建具・窓カタログ
├── floorNumber.js, calibration.js
├── ui/           ダイアログ・パネル
├── finish/       仕上げモード（部屋・材・境界）
└── structural/   構造モード（部材・採番・自動補完）
```

## 用語集
`.claude/glossary.md`

## ドキュメント索引
| 領域 | 参照先 |
|---|---|
| データモデルの設計意図 | `.claude/data-model.md` |
| 構造モードの設計意図 | `.claude/structural-model.md` |
| 図面合成（複数階×複数カテゴリ）の設計意図 | `.claude/figure.md` |
| モード切替アーキテクチャ | `.claude/mode-system.md` |
| 階・Plane設計 | `.claude/floor-design.md` |
| 階段モデルの設計意図 | `.claude/stair-model.md` |
| IndexedDB永続化 | `.claude/persistence-idb.md` |
| FlatBuffersシリアライズ | `.claude/serialization-fbs.md` |
| 実装方針（全体ルール） | `.claude/implementation-policy.md` |
| 本番デプロイ | `.claude/deployment.md` |
| **mdファイル自体を修正するときのルール** | `.claude/doc-policy.md` |

@.claude/active-team.md
