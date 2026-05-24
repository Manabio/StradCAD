import { useEffect, useState } from 'react';
import './RadialMenu.css';

const RADIUS = 80; // px — 中心からアイテムまでの距離

/**
 * ラジアルメニュー
 *
 * @param {{ x, y } | null} pos      スクリーン座標 (null = 非表示)
 * @param {Array}           items    getMenuItems() の戻り値
 * @param {(item) => void}  onSelect アイテム選択コールバック
 * @param {() => void}      onClose  外側タップ / キャンセル
 */
export function RadialMenu({ pos, items, onSelect, onClose }) {
  const [open, setOpen] = useState(false);

  // pos が変わったら開閉アニメーション
  useEffect(() => {
    if (pos) {
      // 次フレームで open=true にすることで CSS transition が効く
      const id = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(id);
    } else {
      setOpen(false);
    }
  }, [pos]);

  if (!pos || items.length === 0) return null;

  const n = items.length;

  // アイテムを均等に円周上に配置 (上から時計回り)
  const angleStep = 360 / n;

  return (
    <>
      {/* 外側タップでメニューを閉じる */}
      <div className="radial-backdrop" onPointerDown={onClose} />

      <div className="radial-menu" style={{ left: pos.x, top: pos.y }}>
        {/* 中心ドット */}
        <div className="radial-center-dot" />

        {items.map((item, i) => {
          const angleDeg = -90 + angleStep * i; // 上 (-90°) から時計回り
          const angleRad = (angleDeg * Math.PI) / 180;
          const tx = open ? Math.round(RADIUS * Math.cos(angleRad)) : 0;
          const ty = open ? Math.round(RADIUS * Math.sin(angleRad)) : 0;

          return (
            <div
              key={item.id}
              className="radial-item-wrap"
              style={{
                transform: `translate(${tx}px, ${ty}px)`,
                opacity:   open ? 1 : 0,
                transitionDelay: open ? `${i * 25}ms` : '0ms',
              }}
            >
              <button
                className="radial-item"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(item);
                  onClose();
                }}
              >
                <span className="radial-item-icon">{item.icon}</span>
                <span className="radial-item-label">{item.label}</span>
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
