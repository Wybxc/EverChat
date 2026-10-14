import { useEffect, useRef, useState } from 'react';
import { MAX_MODEL_TOKENS, metadataSourceLabels, reasoningEfforts, resolveModelMetadata } from '../shared/model-metadata';
import { effortLabels } from '../shared/models';
import type { ModelMetadata, ModelMetadataOverrides, ProviderApiKind, ProviderModel } from '../shared/types';

function TokenLimitInput({ label, value, automatic, change }: { label: string; value?: number; automatic: number; change: (value: number | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (document.activeElement !== input.current && (value === undefined || Number.isFinite(value))) setText(value === undefined ? '' : String(value));
  }, [value]);
  return <input ref={input} aria-label={label} type="number" min={1} max={MAX_MODEL_TOKENS} step={1} className="input input-sm w-full border-base-content/50" value={text} placeholder={String(automatic)} onChange={(event) => {
    setText(event.currentTarget.value);
    change(event.currentTarget.validity.badInput ? Number.NaN : event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber);
  }} />;
}

export function ModelMetadataFields({ provider, model, index, onChange }: {
  provider: ProviderApiKind; model: ProviderModel; index: number; onChange: (patch: Partial<ProviderModel>) => void;
}) {
  const metadata = resolveModelMetadata(provider, model);
  const automatic = resolveModelMetadata(provider, { ...model, metadataOverrides: undefined, reasoningSupport: 'auto' });
  const overrides = model.metadataOverrides ?? {};
  const change = (patch: ModelMetadataOverrides) => onChange({ metadataOverrides: { ...overrides, ...patch } });
  const source = (field: keyof ModelMetadata) => metadataSourceLabels[metadata.sources[field]];
  const capability = (field: 'imageInput' | 'toolCalls' | 'structuredOutput' | 'reasoning') => automatic.sources[field] === 'fallback' ? '未识别' : automatic[field] ? '支持' : '不支持';
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">模型能力</span><button type="button" className="btn btn-xs" onClick={() => onChange({ metadataOverrides: undefined, reasoningSupport: 'auto' })}>恢复自动</button></div>
    <div className="grid gap-3 sm:grid-cols-2">
      {([['contextWindow', '上下文窗口'], ['maxOutputTokens', '最大输出']] as const).map(([field, label]) => <label key={field} className="block min-w-0 space-y-1">
        <span className="flex flex-wrap justify-between gap-1 text-sm"><span>{label}（Tokens）</span><span className="text-xs text-base-content/70">{source(field)}</span></span>
        <TokenLimitInput label={`${label}（Tokens） ${index + 1}`} value={overrides[field]} automatic={automatic[field]} change={(value) => change({ [field]: value })} />
      </label>)}
      <label className="block min-w-0 space-y-1"><span className="flex flex-wrap justify-between gap-1 text-sm"><span>窗口范围</span><span className="text-xs text-base-content/70">{source('contextScope')}</span></span><select aria-label={`窗口范围 ${index + 1}`} className="select select-sm w-full border-base-content/50" value={overrides.contextScope ?? 'auto'} onChange={(event) => change({ contextScope: event.target.value === 'auto' ? undefined : event.target.value as ModelMetadata['contextScope'] })}>
        <option value="auto">自动（{automatic.contextScope === 'input' ? '仅输入' : '输入＋输出'}）</option><option value="combined">输入＋输出</option><option value="input">仅输入</option>
      </select></label>
      <label className="block min-w-0 space-y-1"><span className="flex flex-wrap justify-between gap-1 text-sm"><span>思考能力</span><span className="text-xs text-base-content/70">{source('reasoning')}</span></span><select aria-label={`思考能力 ${index + 1}`} className="select select-sm w-full border-base-content/50" value={model.reasoningSupport ?? 'auto'} onChange={(event) => onChange({ reasoningSupport: event.target.value as ProviderModel['reasoningSupport'] })}>
        <option value="auto">自动（{capability('reasoning')}）</option><option value="supported">支持</option><option value="unsupported">不支持</option>
      </select></label>
      {([['imageInput', '图片输入'], ['toolCalls', '工具调用'], ['structuredOutput', '结构化输出']] as const).map(([field, label]) => <label key={field} className="block min-w-0 space-y-1">
        <span className="flex flex-wrap justify-between gap-1 text-sm"><span>{label}</span><span className="text-xs text-base-content/70">{source(field)}</span></span><select aria-label={`${label} ${index + 1}`} className="select select-sm w-full border-base-content/50" value={overrides[field] === undefined ? 'auto' : overrides[field] ? 'supported' : 'unsupported'} onChange={(event) => change({ [field]: event.target.value === 'auto' ? undefined : event.target.value === 'supported' })}>
          <option value="auto">自动（{capability(field)}）</option><option value="supported">支持</option><option value="unsupported">不支持</option>
        </select>
      </label>)}
    </div>
    <p className="text-xs text-base-content/70">留空自动；模型最大输出不改变请求输出上限。</p>
    {metadata.reasoning && <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="checkbox checkbox-sm" aria-label={`自定义思维强度 ${index + 1}`} checked={overrides.reasoningEfforts !== undefined} onChange={(event) => change({ reasoningEfforts: event.target.checked ? [...metadata.reasoningEfforts] : undefined })} />自定义可选思维强度<span className="text-xs text-base-content/70">{source('reasoningEfforts')}</span></label>
      {overrides.reasoningEfforts !== undefined && <div role="group" aria-label={`可选思维强度 ${index + 1}`} className="flex flex-wrap gap-x-4 gap-y-2">{reasoningEfforts.map((effort) => <label key={effort} className="flex items-center gap-2 text-sm"><input type="checkbox" className="checkbox checkbox-sm" aria-label={`思维强度 ${effortLabels[effort]} ${index + 1}`} checked={overrides.reasoningEfforts!.includes(effort)} onChange={(event) => change({ reasoningEfforts: reasoningEfforts.filter((value) => value === effort ? event.target.checked : overrides.reasoningEfforts!.includes(value)) })} />{effortLabels[effort]}</label>)}</div>}
    </div>}
  </div>;
}
