export class ApiError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly retryAfter?: number;

  constructor(code: string, detail?: string, retryAfter?: number) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

const MESSAGES: Record<string, string> = {
  network: '通信できません。ネットワークを確認してください',
  server_error: 'サーバーでエラーが起きました。少し待ってからもう一度お試しください',
  unauthenticated: 'ログインの有効期限が切れました。もう一度ログインしてください',
  no_player: 'アカウント情報が見つかりません。もう一度ログインしてください',
  rate_limited: '操作が多すぎます。少し待ってからもう一度お試しください',
  not_found: '見つかりませんでした',
  forbidden: 'この操作はできません',
  invalid_input: '入力内容が正しくありません',
  invalid_target: 'この相手には実行できません',
  already_friends: 'すでにフレンドです',
  already_requested: 'すでに申請済みです',
  already_handled: 'この申請はすでに処理されています',
  you_blocked: 'ブロック中の相手です。先にブロックを解除してください',
  not_friends: 'フレンドではありません',
  offline: '相手はオフラインです。オンラインのときに招待してください',
  busy: '対戦中は招待できません',
  busy_target: '相手は対戦中です',
  already_invited: 'すでに招待しています。返事を待ってください',
  empty: 'メッセージを入力してください',
  too_long: '長すぎます (200文字まで)',
  too_fast: '送信が早すぎます。少し待ってください',
  duplicate: '同じメッセージは続けて送れません',
  name_taken: 'その表示名はすでに使われています',
  bad_credentials: '表示名またはパスワードが違います',
  match_not_active: 'この対戦はもう終了しています',
  invalid_log: '対戦結果を確認できませんでした',
  bad_request: 'リクエストが正しくありません',
};

const NAME_DETAIL: Record<string, string> = {
  length: '表示名は2〜16文字にしてください',
  chars: '表示名には英数字・_・-・ひらがな・カタカナ・漢字だけ使えます (空白や記号は不可)',
  reserved: 'その表示名は使えません',
  type: '表示名を入力してください',
};
const PASSWORD_DETAIL: Record<string, string> = {
  length: 'パスワードは8文字以上72バイト以下にしてください',
  weak: '推測されやすいパスワードです。別のものにしてください',
  chars: 'パスワードに使えない文字が含まれています',
  type: 'パスワードを入力してください',
};

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return MESSAGES.server_error!;
  if (error.code === 'invalid_name') return NAME_DETAIL[error.detail ?? ''] ?? MESSAGES.invalid_input!;
  if (error.code === 'invalid_password') return PASSWORD_DETAIL[error.detail ?? ''] ?? MESSAGES.invalid_input!;
  if (error.code === 'rate_limited' && error.retryAfter) {
    const minutes = Math.ceil(error.retryAfter / 60);
    return `試行回数が多すぎます。${minutes}分ほど待ってからもう一度お試しください`;
  }
  return MESSAGES[error.code] ?? MESSAGES.server_error!;
}
