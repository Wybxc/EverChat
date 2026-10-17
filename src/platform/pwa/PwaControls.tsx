import { useState, useSyncExternalStore } from 'react';
import { Download, RefreshCw, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Modal, ModalTitle } from '../../components/Modal';
import {
  applyPwaChange,
  checkPwaUpdate,
  dismissPwaError,
  installPwa,
  pwaSnapshot,
  subscribePwa,
} from './controller';

export function PwaSettings() {
  const state = useSyncExternalStore(subscribePwa, pwaSnapshot);
  const [repair, setRepair] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  return (
    <section aria-label="应用" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">EverChat</span>
        <span className="break-all text-xs text-muted-foreground" data-testid="app-version">
          {state.version}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {!state.installed && state.canInstall && (
          <Button variant="secondary" type="button" onClick={() => void installPwa()}>
            <Download className="size-4" />
            安装应用
          </Button>
        )}
        {state.supported && (
          <>
            <Button
              variant="secondary"
              type="button"
              disabled={state.pending || state.installing || state.preparing || state.repairing}
              onClick={() => void checkPwaUpdate()}
            >
              {state.checking || state.installing ? <Spinner /> : <RefreshCw className="size-4" />}
              {state.installing
                ? '准备更新资源'
                : state.checking
                  ? '检查中'
                  : state.pending
                    ? '浏览器仍在检查'
                    : '检查更新'}
            </Button>
            {state.available && (
              <Button
                type="button"
                disabled={state.preparing || state.repairing}
                onClick={() => void applyPwaChange('update')}
              >
                更新应用
              </Button>
            )}
            <Button
              variant="ghost"
              type="button"
              disabled={state.preparing || state.pending || state.repairing}
              onClick={() => setRepair(true)}
            >
              <Wrench className="size-4" />
              {state.repairing ? '准备修复资源' : '修复应用缓存'}
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {state.installed
          ? '已安装'
          : !state.canInstall
            ? '可从浏览器菜单安装应用或添加到主屏幕。'
            : null}
        {state.supported
          ? state.available
            ? ' 有新版本'
            : state.ready
              ? ' 离线资源已就绪'
              : ' 离线资源尚未就绪'
          : null}
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.diagnostic && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">更新诊断</summary>
          <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all select-text">
            {JSON.stringify(state.diagnostic, null, 2)}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(state.diagnostic, null, 2)).then(
                () => setCopyStatus('已复制'),
                () => setCopyStatus('复制失败，请重试'),
              );
            }}
          >
            复制诊断
          </Button>
          <span role="status">{copyStatus}</span>
        </details>
      )}
      <Modal alert open={repair} onOpenChange={setRepair}>
        <div className="w-full max-w-sm space-y-4 p-5">
          <ModalTitle>修复应用缓存</ModalTitle>
          <p className="text-sm">
            重新加载已打开的 EverChat 页面，保留本地对话、草稿和待发送请求。需要联网。
          </p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setRepair(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setRepair(false);
                void applyPwaChange('repair');
              }}
            >
              修复并重新加载
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
export function PwaNotice() {
  const state = useSyncExternalStore(subscribePwa, pwaSnapshot);
  const [dismissed, setDismissed] = useState(false);
  if (state.preparing)
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center gap-2 bg-background/95"
        role="status"
      >
        <Spinner />
        正在更新应用…
      </div>
    );
  const error = state.noticeError ? state.error : '';
  if (!error && (!state.available || dismissed)) return null;
  return (
    <div
      className="fixed right-3 bottom-3 left-3 z-[90] mx-auto flex max-w-lg flex-wrap items-center gap-2 rounded-xl border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
      role={error ? 'alert' : 'status'}
      data-testid="pwa-notice"
    >
      <span className="min-w-0 flex-1">{error || '新版本已就绪'}</span>
      {state.resourceError ? (
        <Button
          size="sm"
          disabled={state.repairing || state.pending}
          onClick={() => void applyPwaChange('repair')}
        >
          修复缓存
        </Button>
      ) : (
        state.available && (
          <Button
            size="sm"
            disabled={state.repairing}
            onClick={() => void applyPwaChange('update')}
          >
            更新
          </Button>
        )
      )}
      <Button
        size="sm"
        aria-label={error ? '关闭应用提示' : undefined}
        variant="ghost"
        onClick={() => {
          setDismissed(true);
          dismissPwaError();
        }}
      >
        {error ? <X className="size-4" aria-hidden="true" /> : '稍后'}
      </Button>
    </div>
  );
}
