import { useState } from 'react';
import { api } from '../../online/api';
import { useOnline } from '../../online/OnlineProvider';
import type { ReportReason } from '../../online/types';
import { Sheet, useAction } from './common';

const REASONS: Array<[ReportReason, string]> = [
  ['abuse', '暴言・不適切な発言'],
  ['harassment', '嫌がらせ・つきまとい'],
  ['spam', '迷惑行為・スパム'],
  ['cheat', '不正プレイ'],
  ['other', 'その他'],
];

interface Props {
  target: { id: string; name: string };
  messageId?: number;
  matchId?: string;
  onClose: () => void;
}

/** 通報フォーム。通報はサーバーに記録され、運営(データベース管理者)が確認する */
export function ReportSheet({ target, messageId, matchId, onClose }: Props) {
  const { toast } = useOnline();
  const [reason, setReason] = useState<ReportReason>('abuse');
  const [detail, setDetail] = useState('');
  const action = useAction();

  const submit = () =>
    action.run(async () => {
      await api.report(target.id, reason, detail.trim() || undefined, messageId, matchId);
      toast('success', '通報を受け付けました。ご協力ありがとうございます');
      onClose();
    });

  return (
    <Sheet title={`${target.name} さんを通報`} onClose={onClose}>
      <fieldset className="radio-group">
        <legend>理由</legend>
        {REASONS.map(([value, label]) => (
          <label key={value} className="radio">
            <input type="radio" name="report-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>詳しい内容 (任意・300文字まで)</span>
        <textarea value={detail} maxLength={300} rows={3} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => void submit()} data-testid="report-submit">
        通報する
      </button>
    </Sheet>
  );
}
