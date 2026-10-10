import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { providerOptions } from '../shared/providers';
import type { ProviderKind, ProviderSettings } from '../shared/types';
import { api } from './api';

export function ProviderSettingsPanel({ onSaved }: { onSaved: (settings: ProviderSettings) => void }) {
  const query = useQuery({
    queryKey: ['provider-settings'],
    queryFn: () => api<ProviderSettings>('/settings/provider'),
    refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (query.isFetching) return <div role="status" className="py-6 text-center"><span className="loading loading-spinner loading-sm" aria-label="正在读取供应商设置" /></div>;
  if (query.isError) return <div className="space-y-3"><p role="alert" className="text-sm">{query.error.message}</p><button className="btn btn-sm" onClick={() => void query.refetch()}>重新读取</button></div>;
  if (!query.data) return null;
  return <ProviderForm initial={query.data} onSaved={onSaved} />;
}

function ProviderForm({ initial, onSaved }: { initial: ProviderSettings; onSaved: (settings: ProviderSettings) => void }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initial);
  const [config, setConfig] = useState(initial);
  const [apiKey, setApiKey] = useState('');
  const mutation = useMutation({
    mutationFn: () => api<ProviderSettings>('/settings/provider', 'PUT', {
      provider: config.provider, baseUrl: config.baseUrl, model: config.model,
      systemPrompt: config.systemPrompt, maxOutputTokens: config.maxOutputTokens,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }),
    onSuccess: (settings) => {
      setSaved(settings); setConfig(settings); setApiKey('');
      queryClient.setQueryData(['provider-settings'], settings);
      onSaved(settings);
    },
  });
  const option = providerOptions.find((item) => item.value === config.provider)!;
  const real = config.provider !== 'demo';
  const keepKey = saved.hasApiKey && config.provider === saved.provider && config.baseUrl.trim().replace(/\/+$/, '') === saved.baseUrl.replace(/\/+$/, '');
  const change = (patch: Partial<ProviderSettings>) => { mutation.reset(); setConfig((current) => ({ ...current, ...patch })); };
  const choose = (provider: ProviderKind) => {
    const next = providerOptions.find((item) => item.value === provider)!;
    setApiKey('');
    change({ provider, baseUrl: next.baseUrl, model: provider === saved.provider ? saved.model : provider === 'demo' ? '演示模型' : '' });
  };
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(); };
  return <form onSubmit={submit} className="mt-5 border-t border-base-content/50 pt-4">
    <fieldset className="fieldset gap-4" disabled={mutation.isPending}>
      <legend className="fieldset-legend text-sm">AI 供应商</legend>
      <div className="space-y-2">
        <label htmlFor="provider-protocol" className="block text-sm font-medium">接口协议</label>
        <select id="provider-protocol" className="select w-full border-base-content/50" value={config.provider} onChange={(event) => choose(event.target.value as ProviderKind)}>
          {providerOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      {real && <>
        <div className="space-y-2">
          <label htmlFor="provider-url" className="block text-sm font-medium">API 基础地址</label>
          <input id="provider-url" type="url" required maxLength={2048} className="input w-full border-base-content/50" value={config.baseUrl} placeholder={option.baseUrl} onChange={(event) => change({ baseUrl: event.target.value })} aria-describedby="provider-url-help" />
          <p id="provider-url-help" className="text-xs text-base-content/70">包含版本路径（/v1 或 /v1beta），不包含具体接口路径。</p>
        </div>
        <div className="space-y-2">
          <label htmlFor="provider-model" className="block text-sm font-medium">模型 ID</label>
          <input id="provider-model" required maxLength={200} className="input w-full border-base-content/50" value={config.model} placeholder={option.modelPlaceholder} onChange={(event) => change({ model: event.target.value })} />
        </div>
        <div className="space-y-2">
          <label htmlFor="provider-key" className="block text-sm font-medium">API 密钥</label>
          <input id="provider-key" type="password" autoComplete="off" required={!keepKey} maxLength={4096} className="input w-full border-base-content/50" value={apiKey} placeholder={keepKey ? '已配置 · 留空保留' : '输入 API 密钥'} onChange={(event) => { mutation.reset(); setApiKey(event.target.value); }} aria-describedby="provider-key-help" />
          <p id="provider-key-help" className="text-xs text-base-content/70">密钥仅保存在服务端。</p>
        </div>
        <div className="space-y-2">
          <label htmlFor="provider-prompt" className="block text-sm font-medium">系统提示词</label>
          <textarea id="provider-prompt" rows={3} maxLength={20000} className="textarea w-full border-base-content/50" value={config.systemPrompt} onChange={(event) => change({ systemPrompt: event.target.value })} />
        </div>
        <div className="space-y-2">
          <label htmlFor="provider-tokens" className="block text-sm font-medium">输出上限（Tokens）</label>
          <input id="provider-tokens" type="number" min={1} max={100000} step={1} required className="input w-full border-base-content/50" value={config.maxOutputTokens || ''} onChange={(event) => change({ maxOutputTokens: Number(event.target.value) })} />
        </div>
      </>}
      {mutation.isError && <p role="alert" className="text-sm">{mutation.error.message}</p>}
      {mutation.isSuccess && <p role="status" className="text-sm">已保存</p>}
      <div className="flex justify-end"><button className="btn" type="submit" disabled={mutation.isPending}>{mutation.isPending && <span className="loading loading-spinner loading-xs" />}保存供应商设置</button></div>
    </fieldset>
  </form>;
}
