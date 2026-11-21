import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { Message } from '../../../shared/conversation/types';
import { REMOTE_MCP_TOOL } from '../../../shared/tools/remote-mcp';
import type { WebToolCall } from '../../../shared/tools/tasks';
import { api } from '../../platform/api';
import './locales';

type Call = Extract<WebToolCall, { name: typeof REMOTE_MCP_TOOL }>;
function Approval({ call, path }: { call: Call; path: string }) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const [status, setStatus] = useState<'pending' | 'saving' | 'saved' | 'failed'>('pending');
  const decide = async (approve: boolean) => {
    setStatus('saving');
    try {
      await api(path, 'POST', { callId: call.id, decision: { approve } });
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };
  return (
    <section
      className="space-y-2 rounded-md border border-primary/30 p-3 text-sm"
      aria-label={t(($) => $.remoteMcpConfirm)}
    >
      <h3 className="font-medium">{t(($) => $.remoteMcpConfirm)}</h3>
      <p className="break-all">
        {call.approval?.title} · {call.input.tool}
      </p>
      <p className="break-all text-xs text-muted-foreground">{call.approval?.endpoint}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
        {JSON.stringify(call.input.arguments, null, 2)}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={status === 'saving' || status === 'saved'}
          onClick={() => void decide(true)}
        >
          {t(($) => $.remoteMcpApprove)}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={status === 'saving' || status === 'saved'}
          onClick={() => void decide(false)}
        >
          {t(($) => $.remoteMcpDeny)}
        </Button>
      </div>
      {status === 'failed' && (
        <p role="alert" className="text-xs text-destructive">
          {t(($) => $.remoteMcpDecisionFailed)}
        </p>
      )}
    </section>
  );
}

export function RemoteMcpApprovals({
  message,
  conversationId,
}: {
  message: Message;
  conversationId: string;
}) {
  if (message.tools?.status !== 'active') return null;
  const path = `/conversations/${conversationId}/messages/${message.id}/tool-approval`;
  return message.tools.calls.map(({ call, state }) =>
    !call.invalid && call.name === REMOTE_MCP_TOOL && call.approval && state === 'approval' ? (
      <Approval key={call.id} call={call} path={path} />
    ) : null,
  );
}
