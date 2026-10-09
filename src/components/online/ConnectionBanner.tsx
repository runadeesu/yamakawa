import { useOnline } from '../../online/OnlineProvider';

/** 通信の状態を常に見えるようにする (サインイン中のみ) */
export function ConnectionBanner() {
  const { phase, net, refresh } = useOnline();
  if (phase !== 'signed_in' || net === 'ok') return null;
  return (
    <div className={`conn-banner conn-${net}`} role="alert">
      <span>{net === 'offline' ? '⚠ 通信が切断されています' : '↻ 再接続しています…'}</span>
      {net === 'offline' && (
        <button type="button" className="btn btn-pill btn-small" onClick={() => void refresh()}>
          再接続
        </button>
      )}
    </div>
  );
}
