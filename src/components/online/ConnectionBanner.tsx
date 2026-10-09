import { useOnline } from '../../online/OnlineProvider';

/** 通信の状態を常に見えるようにする (サインイン中のみ。画面の流れの中に出し、操作は妨げない) */
export function ConnectionBanner() {
  const { phase, net, refresh } = useOnline();
  if (phase !== 'signed_in' || net === 'ok') return null;
  if (net === 'degraded') {
    return (
      <div className="conn-banner conn-degraded" role="status" data-testid="conn-degraded">
        <span>ℹ リアルタイム通信が使えないため、数秒ごとの自動更新で動いています</span>
      </div>
    );
  }
  return (
    <div className="conn-banner conn-offline" role="alert" data-testid="conn-offline">
      <span>⚠ サーバーと通信できません</span>
      <button type="button" className="btn btn-pill btn-small" onClick={() => void refresh()}>
        再接続
      </button>
    </div>
  );
}
