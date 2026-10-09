import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useOnline } from '../../online/OnlineProvider';
import type { FriendStatus } from '../../online/types';

/** ボタンから呼ぶ非同期処理。二重実行を防ぎ、失敗はトーストで知らせる */
export function useAction() {
  const { fail } = useOnline();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      setBusy(true);
      try {
        return await task();
      } catch (error) {
        fail(error);
        return undefined;
      } finally {
        busyRef.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [fail],
  );
  return { busy, run };
}

export function StatusDot({ status }: { status: FriendStatus | 'self' }) {
  const label = { offline: 'オフライン', online: 'オンライン', queue: 'マッチ待機中', in_match: '対戦中', self: 'あなた' }[status];
  return (
    <span className={`dot dot-${status}`} role="img" aria-label={label} title={label}>
      <span className="dot-label">{label}</span>
    </span>
  );
}

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="badge" aria-label={`${count}件`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** 画面下から出るシート。Esc / 背景タップで閉じる */
export function Sheet({ title, onClose, children }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay sheet-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="panel sheet" ref={ref} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <h2 className="sheet-title">{title}</h2>
        <div className="sheet-body">{children}</div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          とじる
        </button>
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet title={title} onClose={onCancel}>
      <p className="sheet-text">{text}</p>
      <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
        {confirmLabel}
      </button>
    </Sheet>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${Math.floor(diff / 86400)}日前`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
