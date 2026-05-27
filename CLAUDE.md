# strad — 建築CADアプリ 仕様要約

## 技術スタック

| 役割 | ライブラリ |
|------|-----------|
| UI フレームワーク | React 19 + Vite |
| Canvas レンダリング | react-konva (Konva.js) |
| 状態管理 | MobX 6（`observer` / `reaction` / `computed`） |
| グラフ構造 | ngraph.graph（マルチグラフ） |
| 単位 | **mm**（ワールド座標）。`scale = px/mm`、初期値 1 → 表示上 1:100 相当 |
| 座標系 | **y 軸は下向き正**（画面上方向 = y 小、画面下方向 = y 大）。「上」= y が小さい方向、「下」= y が大きい方向 |

---

## ファイル構成

```
app/src/
├── core.js              ドメインモデル全体（クラス定義）
├── store.js             MobXストア・プロジェクト初期化
├── App.jsx              メインコンポーネント・全イベント処理
├── viewport.js          座標変換・ズーム・パン
├── snap.js              スナップ計算ユーティリティ
├── undoManager.js       Undo/Redo スタック
├── graphSnapshot.js     グラフのシリアライズ / リストア
├── error.js             ユーザー向けエラー・通知メッセージ定数
├── renderer/
│   ├── AxisRulerLayer.jsx     通り芯表示エリア背景
│   ├── CenterLinesLayer.jsx   中心線・交点・ガターラベル・ガター丸
│   ├── ShapesLayer.jsx        一般図形描画
│   ├── DrawPreview.jsx        描画中プレビュー
│   ├── CLAddPreview.jsx       通り芯追加プレビュー
│   ├── CLMoveInput.jsx        通り芯移動中の数値表示
│   ├── SnapIndicator.jsx      スナップ点インジケータ
│   ├── LongPressIndicator.jsx 長押しリング
│   └── WallRefIndicator.jsx   壁の参照元CL表示インジケータ
├── interaction/
│   ├── useDrawMode.js    描画モード管理
│   ├── useCLMove.js      通り芯移動モード管理
│   ├── useLongPress.js   長押し検出フック
│   └── menuItems.js      ラジアルメニュー項目定義
└── ui/
    ├── AddCLDialog.jsx      通り芯追加ダイアログ
    ├── CalibrationDialog.jsx 画面校正ダイアログ
    ├── NumPad.jsx           数値入力パッド
    ├── RadialMenu.jsx       ラジアルメニュー
    └── WallDialog.jsx       壁追加ダイアログ
```

---

## データモデル（core.js）

### クラス階層

```
Project
└── Plane（平面 = 1フロア）
    └── PlanGraph（ngraph ラッパ）
        ├── CenterLine[]  （shapeMap 内 — グリッドの源泉）
        ├── Intersection[] （CL交点 — CL.value から computed）
        ├── Point[]        （自由位置ノード — Arc/Circle 中心用）
        └── Shape[]        （一般図形 — ngraph エッジ）
```

### Discipline（分野）

| 値 | 意味 |
|----|------|
| `arch` | 意匠（デフォルト） |
| `struct` | 構造（通り芯ラベル表示対象） |
| `fuse` | 伏図 |
| `mep` | 設備 |
| `elec` | 電気 |

### CenterLine（通り芯）

- `centerLineType`: `X`（垂直線、value = x座標）／`Y`（水平線、value = y座標）／`R`（放射）
- `labeled: true` → グリッド軸。直交 labeled CL との Intersection を自動生成。ラベル自動命名（X1, X2 … / Y1, Y2 …）。
- `labeled: false` → 補助線。グリッド未登録・ラベルなし・Intersection なし。
- `trim: false` → 両端を直交CL最外端＋オーバーハングまで延伸。`true` → 最外端でカット。
- `demoteToAuxiliary()` / `promoteToGrid()` で labeled 状態を切り替え可能。

#### 追加ダイアログの種別（AddCLDialog.jsx）

| 種別ID | ラベル | `discipline` | `labeled` | `lineType` | 意味 |
|--------|--------|-------------|-----------|-----------|------|
| `center` | 中心 | `arch`（デフォルト） | `false` | `solid` | ラベルなし中心線 |
| `struct` | 構造芯 | `struct` | `true` | `solid` | **ガターラベルあり**（交点自動生成対象） |
| `aux` | 補助線 | `arch` | `false` | `dashed` | ラベルなし破線補助線 |

> **仕様**: ガター（通り芯表示エリア）へのラベル表示・ガター丸の表示は `discipline === 'struct'` かつ `labeled === true` の CL のみ。

### Intersection（交点）

- 垂直CL × 水平CL の交点。`x` / `y` は参照先CLの `value` から MobX `computed` で導出。
- ID形式: `"${clV.id}:${clH.id}"`
- CLの `value` が変わると自動的に全依存図形が追従する。

### Shape 種別

| 型 | 主プロパティ | ノード構成 |
|----|------------|-----------|
| `VerticalLine` | clVertical, clHStart, clHEnd | Intersection ↔ Intersection |
| `HorizontalLine` | clHorizontal, clVStart, clVEnd | Intersection ↔ Intersection |
| `DiagonalLine` | nodeA, nodeB | 任意ノード ↔ 任意ノード |
| `Arc` | center, radius, startAngle, includedAngle | center(自ループ) |
| `Circle` | center, radius | center(自ループ) |
| `Wall` | axisCL, axisOffset, isVertical, clStart/End, start/endOffset | shapeMap のみ（ngraphエッジなし） |

### Wall（壁）の特徴

- 軸CLからの**オフセット**で位置を持つ（CLに直接乗らない）。
- `chamferWalls()` が自動実行され、垂直壁と水平壁の端点を交点位置に面取りスナップ（tolerance = 150mm）。
- `reaction` で axisValue / clStart.value / clEnd.value を監視 → 自動面取り。

---

## 画面レイアウト

```
┌──────────────────────────────────────────────┐ ← ガター上（48px）
│  [X1]  [X2]  [X3]  [X4] ← 縦通り芯ラベル+丸  │
├────┬─────────────────────────────────────┬───┤
│[Y1]│                                     │   │
│    │    ＜ 描画エリア（クリップ内） ＞    │   │
│[Y2]│                                     │   │
│    │  通り芯・交点・図形・スナップ表示    │   │
│[Y3]│                                     │   │
├────┴─────────────────────────────────────┴───┤ ← ガター下（48px）
└──────────────────────────────────────────────┘
← ガター左（48px）                 ガター右（48px） →
```

- **ガター幅**: `GUTTER = 48px`（4辺）
- 描画エリアはガター内側にクリップ（world `Group` を `clipX/Y=GUTTER` で囲む）
- ガター内のスナップ・カーソル追跡は無効

---

## Konva レイヤー構成

| Layer | 内容 |
|-------|------|
| `"world"` | クリップGroupで内側に限定。中心線・図形・交点マーカー・描画プレビュー。ワールド座標系（viewport Groupでスケール適用）。 |
| `"overlay"` | スクリーン座標系。AxisRulerLayer（ガター背景）、GutterCLMarkers（ガター丸）、CenterLineLabels（ラベル）、SnapIndicator。 |
| `"ui"` | 現在未使用。UI要素用予約。 |

---

## Viewport（座標変換）

- `worldToScreen(wx, wy)` = `(wx * scale + offsetX, wy * scale + offsetY)`
- `screenToWorld(sx, sy)` = `((sx - offsetX) / scale, (sy - offsetY) / scale)`
- 初期 `offsetX = GUTTER + 100`、`offsetY = height - GUTTER - 100`（原点＝左下付近）
- ホイールズーム: `zoomAt(sx, sy, factor)` — スクリーン上の固定点を軸にズーム
- スケール範囲: 0.02 〜 20（px/mm）
- `scaleDenominator = Math.round(100 / scale)` → 右下に「1/100」等で表示

---

## スナップ（snap.js）

| 関数 | 閾値 | 用途 |
|------|------|------|
| `findNearestIntersection` | `SNAP_THRESHOLD_PX = 20` | カーソル近傍の Intersection にスナップ |
| `findNearestCenterLine` | `CL_THRESHOLD_PX = 8` | 近傍の中心線を検出（ラジアルメニュー対象判定） |
| `findCLMoveSnap` | `SNAP_THRESHOLD_PX = 20` | CL移動中、他CLの座標にスナップ |
| `findBracketingCLs` | — | 指定座標を挟む直交CL2本を取得（壁配置用） |
| `snapAngle` | ±30° | 斜線描画の角度スナップ（水平・垂直・斜め） |

---

## インタラクション

### ポインタイベントの状態遷移

```
[通常] ──長押し(500ms)──▶ [ラジアルメニュー]
  │                              │
  │                         メニュー選択
  │                              │
  ├─ ガター内CL丸長押し ──▶ [CL移動モード] ──Up/確定──▶ [通常]
  │   (gutterLongPress)           │
  │                          ESC/cancelMove
  │                              │
  ├─ 描画モード開始 ──────────────▶ [描画モード] ──タップ──▶ [通常]
  │   (startDraw)                 │
  │                          ESC/cancelDraw
  │
  └─ ドラッグ ──────────────────▶ [パン中] ──Up──▶ [通常]
```

### ラジアルメニューのコンテキスト

| コンテキスト | 検出条件 | メニュー項目 |
|------------|---------|------------|
| `intersection` | スナップ点あり | 斜線、円弧、削除 |
| `centerLine` | 近傍CL（8px以内） | 削除（移動はガター丸から） |
| `empty` | 何もない | 垂直線・水平線・壁追加、Undo/Redo |

### 通り芯の移動操作

- **ガター丸（長押し）** → `startMove(cl)` + `moveDownRef` セット → カーソルに追従 → Up で確定・Undo登録
- 移動中は他CLへのスナップあり（`findCLMoveSnap`）
- `commitMove()` で状態クリア、`cancelMove()` で元の `value` に戻す
- Undo: `cl.value` の新旧値を push / pop

### 描画操作（`useDrawMode`）

- **斜線** (`diag`): 交点タップ → 始点記録 → 別交点タップ → `addDiagonalLine`
- **通り芯追加** (`cl-v`, `cl-h`): ラジアルメニューから即時追加。ダイアログで種別・値・trim を指定
- **壁追加** (`wall`): 近傍CLと距離をダイアログで指定 → `addWall` + 自動面取り

---

## Undo / Redo（undoManager.js）

- `undoManager.push(undoFn, redoFn)` でペアを登録
- `Ctrl+Z` / `Ctrl+Y` にバインド
- CL追加・削除・移動・図形追加・削除はすべて Undo 対象
- CL削除の Undo/Redo は `serializeGraph` / `restoreGraph` でグラフ全体スナップショットを使用

---

## 中心線描画の延伸ロジック（CenterLinesLayer.jsx）

```
trim=false: [直交CL最小値 - オーバーハング] 〜 [直交CL最大値 + オーバーハング]
trim=true:  [直交CL最小値] 〜 [直交CL最大値]
オーバーハング = Math.round(100 / viewport.scale) * 20  (mm)
直交CLがない場合: ビューポート外縁 ± 50,000mm にフォールバック
```

---

## 重要な設計判断

- **CL が座標の源泉**: Intersection.x/y は CL.value の computed プロパティ。CLを動かすと連鎖的に全図形が追従する。
- **Wall は ngraph エッジを持たない**: 壁はグラフノードに直接紐づかないため、別途 `shapeMap` のみで管理。
- **ガター操作とキャンバス操作を完全分離**: ガター内の `pointerDown` は通常の `longPress` を呼ばず `gutterLongPress` を使用。ガター内ではスナップも無効。
- **MobX reaction で自動命名・自動面取り**: ラベル再計算（X1, X2...）と chamferWalls は reaction で自動発火。手動呼び出し不要。
- **シリアライズは ID 参照で解決**: `restoreGraph` は CL ID → Shape 解決 → Intersection 再生成の順で復元する。
