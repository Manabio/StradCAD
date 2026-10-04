// 矢じり（鋭く尖った "^"）の点列の純モジュール（依存なし。StairLayer.jsx から移した。階段の矢印と下屋の傾斜矢印が共用）。
export const CHEVRON_ANGLE = Math.PI / 7; // 矢じり(^)の開き角

// 終点の矢じりを、黒三角ではなく鋭く尖った "^"（開いた山形）の2点で返す。
// pts は矢印本体の points 配列（[x1,y1,x2,y2,...]）。終点側の進行方向へ向けて尖らせる。
export function chevronPoints(pts, len) {
  const n = pts.length;
  const tip = { x: pts[n - 2], y: pts[n - 1] };
  const prev = { x: pts[n - 4], y: pts[n - 3] };
  const dx = tip.x - prev.x, dy = tip.y - prev.y;
  const d = Math.hypot(dx, dy) || 1;
  const bx = -dx / d, by = -dy / d; // 進行方向の逆（尖端から広がる向き）
  const cos = Math.cos(CHEVRON_ANGLE), sin = Math.sin(CHEVRON_ANGLE);
  const w1 = { x: bx * cos - by * sin, y: bx * sin + by * cos };
  const w2 = { x: bx * cos + by * sin, y: -bx * sin + by * cos };
  return [
    tip.x + w1.x * len, tip.y + w1.y * len,
    tip.x, tip.y,
    tip.x + w2.x * len, tip.y + w2.y * len,
  ];
}
