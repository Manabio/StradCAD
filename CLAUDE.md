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
├── core.js, core/, store.js, App.jsx              ドメインモデル・MobXストア・メイン
├── viewport.js, appViewport.js, snap.js, snapGeometry.js, undoManager.js, graphSnapshot.js, graphReadScope.js, floorOps.js, error.js
├── modes/        モード状態（MobX、切替時に動的ロード・破棄）
├── schema/       FlatBuffers encode/decode
├── storage/      IndexedDB永続化
├── renderer/     Konva描画レイヤー
├── interaction/  ポインタ操作フック・メニュー定義
├── transform/    空間インデックス・変形・随伴探査
├── openings/     建具モード（カタログ・記号別採番・編集・姿図・パネル）
├── figure/, site/  図面合成（複数階×複数カテゴリ）・敷地モード
├── floorNumber.js, calibration.js
├── ui/           ダイアログ・パネル
├── finish/       仕上げモード（部屋・材・境界・昇降機）
├── structural/   構造モード（部材・採番・自動補完）
├── ceiling/      天伏モード（天井伏図。専用パネル・純モジュール）
└── elevation/    展開モード（室内展開図。純モジュール）
```

## 用語集
`.claude/glossary.md`

## ドキュメント索引
| 領域 | 参照先 |
|---|---|
| データモデルの設計意図。CL種別間の関係（種別ポリシー）の節を含む | `.claude/data-model.md` |
| 構造モードの設計意図 | `.claude/structural-model.md` |
| 建具モードの設計意図 | `.claude/opening-model.md` |
| 図面合成（複数階×複数カテゴリ）の設計意図 | `.claude/figure.md` |
| モード切替アーキテクチャ | `.claude/mode-system.md` |
| 階・Plane設計。入力の関門（uiBusy）の節を含む | `.claude/floor-design.md` |
| 平面の断面解決（立体＋水平切断）。切断高の階属性。見上げ（天伏）の節を含む | `.claude/plan-section.md` |
| 天伏モード（見上げの天井伏図）の設計意図。独立 State・天井の実体は今後 | `.claude/ceiling-model.md` |
| 階段モデルの設計意図 | `.claude/stair-model.md` |
| IndexedDB永続化 | `.claude/persistence-idb.md` |
| Undo/Redo（またぎ・スナップショット方式） | `.claude/undo-redo.md` |
| FlatBuffersシリアライズ | `.claude/serialization-fbs.md` |
| 実装方針（全体ルール） | `.claude/implementation-policy.md` |
| 材料等カタログ（材料・内装/境界マスター・断面・建具種別・建具記号）の同梱・照合・本体編集の設計意図 | `.claude/catalog-model.md` |
| 昇降機（器具・昇降路・全階連動・階追加時の複製）の設計意図 | `.claude/equipment-model.md` |
| 展開モード（室内展開図）の設計意図。線分の角の取り合い（L字の外角閉じ。展開図・敷地・階段・柱包み共通）の節を含む | `.claude/elevation-model.md` |
| 屋根（下屋・主屋根）の項目（RoofSpec・形状の自動・初期値・材料コードの照合・最上階の主屋根）の設計意図。壁・境界の扱いは data-model.md の屋根の節 | `.claude/roof-model.md` |
| 平面の壁取り合い（領域方式への移行） | `.claude/plan-wall-region.md` |
| 通り芯/中心線の昇格・降格・移動の既知の限界と受容方針（削除はD案＝境界化、他階同座標チェックは線id一意化＋移籍一本化で解消） | `.claude/cl-conversion-limits.md` |
| 本番デプロイ | `.claude/deployment.md` |
| **mdファイル自体を修正するときのルール** | `.claude/doc-policy.md` |

@.claude/active-team.md
