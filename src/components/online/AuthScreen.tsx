import { useState, type FormEvent } from 'react';
import { describeError } from '../../online/errors';
import { useOnline } from '../../online/OnlineProvider';

type Mode = 'login' | 'signup';

export function AuthScreen() {
  const { login, signup } = useOnline();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim() || !password) {
      setError('表示名とパスワードを入力してください');
      return;
    }
    if (mode === 'signup' && password !== confirm) {
      setError('確認用のパスワードが一致しません');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await (mode === 'login' ? login(name, password) : signup(name, password));
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-tabs" role="tablist" aria-label="ログインと新規登録">
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => switchMode('login')}>
          ログイン
        </button>
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-active' : ''} onClick={() => switchMode('signup')} data-testid="tab-signup">
          新規登録
        </button>
      </div>

      <form className="auth-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="auth-lead">{mode === 'signup' ? '表示名とパスワードを決めるだけ。メールアドレスは要りません。' : '表示名とパスワードでログインします。'}</p>

        <label className="field">
          <span>表示名</span>
          <input
            data-testid="auth-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={32}
            placeholder="例: てるき_01"
            required
          />
          {mode === 'signup' && <small>2〜16文字。英数字・_・-・ひらがな・カタカナ・漢字が使えます。</small>}
        </label>

        <label className="field">
          <span>パスワード</span>
          <span className="field-row">
            <input
              data-testid="auth-password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              maxLength={72}
              required
            />
            <button type="button" className="btn btn-pill btn-small" onClick={() => setShow((v) => !v)} aria-pressed={show}>
              {show ? '隠す' : '表示'}
            </button>
          </span>
          {mode === 'signup' && <small>8文字以上。推測されにくいものにしてください。</small>}
        </label>

        {mode === 'signup' && (
          <label className="field">
            <span>パスワード (確認)</span>
            <input
              data-testid="auth-confirm"
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              maxLength={72}
              required
            />
          </label>
        )}

        {error && (
          <p className="form-error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="auth-submit">
          {busy ? '通信中…' : mode === 'login' ? 'ログイン' : '登録して始める'}
        </button>

        <p className="notice">
          ⚠ このゲームにはメールアドレスの登録がないため、<b>パスワードを忘れると復旧できません</b> (初期バージョンにはパスワードリセットがありません)。
          大切にメモしておいてください。
        </p>
      </form>
    </div>
  );
}
