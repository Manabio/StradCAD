import { useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { CommonInfoTab } from './CommonInfoTab.jsx';
import { MemberListTab } from './MemberListTab.jsx';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';

const TABS = [
  { id: 'common',  label: '共通' },
  { id: 'members', label: '構造リスト' },
];

// 構造モード突入時に自動表示される入力パネル。
// 横長＝右端パネル（ModePanel）／縦長＝ボトムシート（BottomSheet）。
// 「共通」タブ＝旧・構造パレット（CommonInfoTab）、「構造リスト」タブ＝分類別の部材一覧（MemberListTab）。
// focusRequest（描画エリアの部材タグクリック由来）が来たら構造リストタブへ強制切替する。
export const StructuralPanel = observer(function StructuralPanel({ project, graph, composition, onClose, isLandscape, focusRequest, onStructureChanged }) {
  const [activeTab, setActiveTab] = useState('common');

  useEffect(() => {
    if (focusRequest) setActiveTab('members');
  }, [focusRequest]);

  const inner = (
    <>
      <div style={{
        display: 'flex',
        borderBottom: '1px solid #e2e8f0',
        background: '#f8fafc',
        flexShrink: 0,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: activeTab === tab.id ? 700 : 400,
              color: activeTab === tab.id ? '#2563eb' : '#64748b',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #2563eb' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'common'
        ? <CommonInfoTab project={project} graph={graph} onStructureChanged={onStructureChanged} />
        : <MemberListTab composition={composition} project={project} focusRequest={focusRequest} />}
    </>
  );

  // 横長＝構造モードの入退場に追従して自動開閉するため、手動クローズ（×）は出さない。
  // 縦長＝ボトムシートは描画エリアを覆うため、従来どおり手動クローズを残す。
  return isLandscape
    ? <ModePanel title="構造">{inner}</ModePanel>
    : <BottomSheet title="構造" onClose={onClose} initialSnap={0.5} raiseSignal={focusRequest}>{inner}</BottomSheet>;
});
