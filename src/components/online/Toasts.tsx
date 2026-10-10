import { useOnline } from '../../online/OnlineProvider';

/** 画面右上(スマホは上部)の通知。スクリーンリーダーにも読み上げられる */
export function Toasts() {
  const { toasts, dismissToast } = useOnline();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}
