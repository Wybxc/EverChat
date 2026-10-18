import { useSyncExternalStore } from 'react';
import { Bell, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import type { NotificationMode } from '../../../shared/notifications/protocol';
import {
  enableNotifications,
  notificationSnapshot,
  setNotificationMode,
  subscribeNotifications,
  testNotification,
} from '../../platform/notifications/controller';

export function NotificationSettings() {
  const state = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  return (
    <section aria-label="回答通知" className="space-y-2">
      <label className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
        <span>回答完成通知</span>
        <NativeSelect
          aria-label="回答完成通知"
          value={state.mode}
          className="w-full sm:w-64"
          onChange={(event) => void setNotificationMode(event.target.value as NotificationMode)}
        >
          <option value="always">始终发送</option>
          <option value="never">不发送</option>
          <option value="unfocused">仅在无焦点或后台时发送</option>
        </NativeSelect>
      </label>
      <p role="status" className="text-xs text-muted-foreground">
        {state.mode === 'never'
          ? state.pending
            ? '停用待同步'
            : '已停用'
          : state.permission === 'unsupported'
            ? '当前环境不支持；iPhone／iPad 需添加到主屏幕。'
            : state.permission === 'denied'
              ? '通知被拒绝，请在浏览器或系统设置中允许。'
              : !state.enabled
                ? '未启用'
                : state.pending
                  ? '设置待同步'
                  : state.ready === 'push'
                    ? '后台推送已就绪'
                    : state.ready === 'local'
                      ? '页面通知可用'
                      : '通知尚未就绪'}
      </p>
      {state.mode !== 'never' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            type="button"
            disabled={
              state.busy || state.permission === 'denied' || state.permission === 'unsupported'
            }
            onClick={() => void enableNotifications()}
          >
            <Bell className="size-4" />
            {state.ready === 'push' ? '重新检查' : '启用系统通知'}
          </Button>
          {state.enabled && state.permission === 'granted' && (
            <Button
              variant="ghost"
              type="button"
              disabled={state.busy}
              onClick={() => void testNotification()}
            >
              <Send className="size-4" />
              发送测试通知
            </Button>
          )}
        </div>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </section>
  );
}
