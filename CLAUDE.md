# 通り芯移動時の図形同期問題

## プロジェクト概要
- **種別**: React CAD アプリケーション（建築図面編集）
- **スタック**: React 19.2.6, Vite, MobX 6.15.3, react-konva 19.2.4, Konva 10.3.0
- **アーキテクチャ**:
  - DOM reconciler (App.jsx) + Konva custom reconciler (react-konva)
  - World Group: `scaleX={viewport.scaleX}`, `scaleY={viewport.scaleY}` (mm座標)
  - Overlay Layer: ガター（通り芯表示エリア）、ラベル、交点マーカー（スクリーン座標）
  - Graph: MobX observable (CenterLine.value), computed shapes (Intersection.x, Wall.axisValue等)

## 問題
**CL (CenterLine) をドラッグして移動させても、参照する図形（壁、交点マーカー等）が画面上で追従しない**

例：X2 を右にドラッグ → X2 の値は正常に変わる → 参照するマーカーが動かない

## デバッグログ結果（key findings）

### ✓ 正常に動作している部分
- `updateMove()` が複数回呼び出されている（ドラッグ入力 OK）
- CL の value が正常に更新（5121 → 5139 → 5157 ...）
- CenterLinesLayer が再レンダー（ログ出力）
- IntersectionMarkers が再レンダー（ログ出力）
- Konva Stage が認識されている（stages: 1）
- `Konva.autoDrawEnabled === true`（自動描画が有効）
- Overlay layer に Circle ノードが4個存在

### ✗ 破損している部分
**Circle ノードの座標が更新されていない**
```
overlay circles: 4 (148,24) (24,809) (470,24) (874,24)
```
これらの値がドラッグ中に全く変わらない。一方、IntersectionMarkers の座標計算は正しい（ログ参照）。

## 根本原因の仮説
**react-konva の reconciler が Circle props の変更を Konva ノードに反映していない**

Konva にはデバッグログが出たが、実際の Circle ノード（`node.x()`, `node.y()`）は更新されていない可能性：

1. `applyNodeProps()` が props の差分を検出しない
2. または検出しても `setAttrs()` → Konva内部で値が変わらない（early return）
3. または `_requestDraw()` が呼ばれない
4. または `batchDraw()` が canvas を再描画しない

## 次のステップ
1. Circle ノードの属性を直接ダンプして、Konva 側で実際に値が更新されているか確認
2. react-konva の `commitUpdate` が実際に呼ばれているか確認
3. react-konva + MobX + React 19 concurrent mode の相互作用の問題の可能性を調査

## 参考資料
- Konva: `autoDrawEnabled=true` → `_requestDraw()` が `layer.batchDraw()` を呼ぶはず
- react-konva: `autoDrawEnabled=true` の場合、`updatePicture()` は何もしない（Konva が自動で描画すると仮定）
- MobX observer: IntersectionMarkers は `n.x` 変更を追跡 → 正常に再レンダー
