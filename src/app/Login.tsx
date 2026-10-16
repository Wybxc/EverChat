import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { type SessionInfo } from '../../shared/providers/types';
import { api } from '../platform/api';
import { Brand } from './Brand';
import { ThemeControl } from './ThemeControl';

export function Login({
  session,
  onLogin,
}: {
  session: SessionInfo;
  onLogin: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/login', 'POST', { password });
      await onLogin();
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-dvh flex-col bg-muted">
      <header className="flex items-start justify-between px-7 py-7 sm:px-12">
        <Brand />
        <ThemeControl />
      </header>
      <section className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-7 pb-20">
        <span className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-background">
          <LockKeyhole strokeWidth={1.5} className="h-[1.5rem] w-[1.5rem]" />
        </span>
        <h1 className="text-3xl font-semibold leading-snug tracking-tight">登录</h1>
        <form onSubmit={submit} className="mt-7">
          <label htmlFor="password" className="mb-2 block text-xs font-medium">
            访问密码
          </label>
          <Input
            id="password"
            autoFocus={matchMedia('(min-width: 48rem) and (pointer: fine)').matches}
            required
            type="password"
            autoComplete="current-password"
            className="h-12 w-full border-input bg-background"
            placeholder="输入你的私人空间密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={!session.configured}
          />
          <Button
            variant="default"
            className="mt-4 h-12 w-full justify-between px-5"
            disabled={busy || !session.configured || !password.trim()}
          >
            {busy ? '正在进入…' : '进入我的空间'}
            {busy ? <Spinner /> : <ArrowRight className="h-[1.0625rem] w-[1.0625rem]" />}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-4 text-sm font-medium text-foreground">
            {error}
          </p>
        )}
        {!session.configured && (
          <p role="alert" className="mt-4 text-sm font-medium leading-6 text-foreground">
            服务尚未设置访问密码。请按照 README 配置服务端 Secrets 后重试。
          </p>
        )}
        {local && (
          <p className="mt-4 text-xs text-muted-foreground">
            本地密码：<code>everchat-local</code>
          </p>
        )}
      </section>
      <footer className="pb-6 text-center text-xs text-muted-foreground">EverChat</footer>
    </main>
  );
}
