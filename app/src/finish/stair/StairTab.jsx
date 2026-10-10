import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { STAIR_TYPE_LABEL as TYPE_LABEL } from './stairTypeLabel.js';
import { StairEditor } from './StairPanel.jsx';
import { stairChainTitle, stairFloorName, chainArrivalPlane } from './stairFloorLabel.js';
import { isChainOpen } from './stairChains.js';

const rowStyle   = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const labelStyle = { fontSize: 12, color: '#475569', width: 64, flexShrink: 0 };
const valueStyle = { fontSize: 13, color: '#0f172a' };

// 仕上げパレットの「階段」タブ — 上下に連なる階段を1グループにまとめた一覧＋選択中の階段パラメータ編集。
// グループの三角で各階の行を展開する。自階の行は編集でき、他階の行は読み取り専用（編集は設置階の仕上げモードで行う）。
export const StairTab = observer(({ graph, mode, project, onDeleteStair }) => {
  const chains = mode.stairChains;
  // 採用フロアだけ引く（検討案の平面がアクティブのときは引けず、グループ名は括弧なし・行の階表記は空）
  const planeById = new Map((project?.planes ?? []).map(p => [p.id, p]));
  const activeId = project?.activePlane?.id;
  const selectedId = mode.selectedStairId;
  const selectedSelf = selectedId ? graph.stairMap.get(selectedId) : null;
  const selectedOther = !selectedSelf && selectedId
    ? chains.flatMap(c => c.members)
      .filter(m => m.planeId !== activeId)
      .map(m => mode.stairOfMember(m))
      .find(s => s?.id === selectedId) ?? null
    : null;

  // 開閉はユーザーの操作だけ持つ（保存しない）。選択中の階段を含むグループは既定で開く（isChainOpen）。
  const [overrides, setOverrides] = useState(() => new Map());
  // 選択が変わったら（キャンバスでの見下げ選択を含む）、その階段を含むグループの閉じた操作を捨てて開く。
  useEffect(() => {
    if (!selectedId) return;
    setOverrides(prev => {
      const hit = mode.stairChains.filter(c => c.members.some(m => m.stairId === selectedId) && prev.has(c.key));
      if (hit.length === 0) return prev;
      const next = new Map(prev);
      for (const c of hit) next.delete(c.key);
      return next;
    });
  }, [selectedId, mode]); // 連鎖は effect の中で mode から読む（依存は選択と mode だけ。連鎖の変化では走らせない）

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {chains.length === 0 ? (
        <div style={{ padding: 16, fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
          階段はありません。エリアをドラッグし、部屋名ダイアログで「階段」を選ぶと作成できます。
        </div>
      ) : (
        <div style={{ padding: 8, borderBottom: '1px solid #e2e8f0' }}>
          {chains.map((chain, ci) => {
            const open = isChainOpen(chain, selectedId, overrides);
            return (
              <div key={chain.key} style={{ marginBottom: 4 }}>
                <button
                  aria-expanded={open}
                  onClick={() => setOverrides(prev => new Map(prev).set(chain.key, !open))}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                    border: '1px solid #e2e8f0', background: '#fff',
                  }}
                >
                  {open ? '▼' : '▶'} {stairChainTitle(ci, planeById.get(chain.fromPlaneId), chainArrivalPlane(project?.planes, chain.toPlaneId))}
                </button>
                {open && chain.members.map(member => {
                  const s = mode.stairOfMember(member);
                  if (!s) return null;                  const isSelf = member.planeId === activeId;
                  return (
                    <button
                      key={member.stairId}
                      onClick={() => mode.selectStair(s.id)}
                      style={{
                        display: 'block', width: 'calc(100% - 16px)', textAlign: 'left', marginLeft: 16,
                        padding: '6px 10px', marginTop: 4, borderRadius: 6, cursor: 'pointer', fontSize: 13,
                        border: s.id === selectedId ? '1px solid #2563eb' : '1px solid #e2e8f0',
                        background: s.id === selectedId ? '#eff6ff' : (isSelf ? '#fff' : '#f8fafc'),
                        color: isSelf ? '#0f172a' : '#64748b',
                      }}
                    >
                      {[stairFloorName(planeById.get(member.planeId)), TYPE_LABEL[s.type] ?? s.type, `${s.totalSteps}段`].filter(Boolean).join(' ')}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {selectedSelf && (
        <StairEditor
          stair={selectedSelf} graph={graph} project={project} upperGraph={mode.upperFloorGraph}
          onDelete={onDeleteStair}
        />
      )}
      {selectedOther && (
        // 他階に設置された階段の読み取り専用表示（編集は設置階の仕上げモードで行う）。
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
            他階に設置された階段です。編集は設置階の仕上げモードで行ってください。
          </div>
          <div style={rowStyle}><span style={labelStyle}>タイプ</span><span style={valueStyle}>{TYPE_LABEL[selectedOther.type] ?? selectedOther.type}</span></div>
          <div style={rowStyle}><span style={labelStyle}>段数</span><span style={valueStyle}>{selectedOther.totalSteps}</span></div>
          <div style={rowStyle}><span style={labelStyle}>蹴上(mm)</span><span style={valueStyle}>{selectedOther.riser != null ? Math.round(selectedOther.riser) : '自動'}</span></div>
          <div style={rowStyle}><span style={labelStyle}>蹴込(mm)</span><span style={valueStyle}>{selectedOther.nosing}</span></div>
          <div style={rowStyle}><span style={labelStyle}>幅(mm)</span><span style={valueStyle}>{selectedOther.width}</span></div>
        </div>
      )}
    </div>
  );
});
