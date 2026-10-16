import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { NativeSelect } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { useEffect, useRef, useState } from 'react';
import {
  MAX_MODEL_TOKENS,
  metadataSourceLabels,
  reasoningEfforts,
  resolveModelMetadata,
} from '../../../shared/models/metadata';
import { effortLabels } from '../../../shared/models/selection';
import type {
  ModelMetadata,
  ModelMetadataOverrides,
  ProviderModel,
} from '../../../shared/models/types';
import type { ProviderApiKind } from '../../../shared/providers/types';
import * as v from 'valibot';
import { modelSchema } from '../../../shared/providers/settings';
import { Disclosure } from '../../components/Disclosure';
import {
  probeCapabilityLabels,
  probeReasonLabels,
  type ModelProbeResult,
} from '../../../shared/models/probe';

function TokenLimitInput({
  label,
  value,
  automatic,
  change,
}: {
  label: string;
  value?: number;
  automatic: number;
  change: (value: number | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (document.activeElement !== input.current && (value === undefined || Number.isFinite(value)))
      setText(value === undefined ? '' : String(value));
  }, [value]);
  const invalid =
    value !== undefined && (!Number.isInteger(value) || value < 1 || value > MAX_MODEL_TOKENS);
  return (
    <Input
      ref={input}
      aria-label={label}
      aria-invalid={invalid || undefined}
      type="number"
      min={1}
      max={MAX_MODEL_TOKENS}
      step={1}
      className="w-full border-input"
      value={text}
      placeholder={String(automatic)}
      onChange={(event) => {
        setText(event.currentTarget.value);
        change(
          event.currentTarget.validity.badInput
            ? Number.NaN
            : event.currentTarget.value === ''
              ? undefined
              : event.currentTarget.valueAsNumber,
        );
      }}
    />
  );
}

export function ModelMetadataFields({
  provider,
  model,
  index,
  onChange,
  stateKey,
  onTest,
  testing,
  results,
  testError,
}: {
  provider: ProviderApiKind;
  model: ProviderModel;
  index: number;
  onChange: (patch: Partial<ProviderModel>) => void;
  stateKey?: string;
  onTest: () => void;
  testing: boolean;
  results: ModelProbeResult[];
  testError: string;
}) {
  const metadata = resolveModelMetadata(provider, model);
  const automatic = resolveModelMetadata(provider, {
    ...model,
    metadataOverrides: undefined,
    reasoningSupport: 'auto',
  });
  const overrides = model.metadataOverrides ?? {};
  const change = (patch: ModelMetadataOverrides) =>
    onChange({ metadataOverrides: { ...overrides, ...patch } });
  const source = (field: keyof ModelMetadata) => metadataSourceLabels[metadata.sources[field]];
  const capability = (field: 'imageInput' | 'toolCalls' | 'structuredOutput' | 'reasoning') => {
    if (automatic.sources[field] === 'fallback')
      return field === 'imageInput' || field === 'toolCalls' ? '未识别，可尝试' : '未识别';
    if (
      automatic.sources[field] === 'inferred' &&
      !automatic[field] &&
      (field === 'imageInput' || field === 'toolCalls')
    )
      return '推断不支持，可尝试';
    return automatic[field] ? '支持' : '不支持';
  };
  const custom =
    Object.values(overrides).filter((value) => value !== undefined).length +
    (model.reasoningSupport && model.reasoningSupport !== 'auto' ? 1 : 0);
  const validation = v.safeParse(modelSchema, model);
  const invalid =
    !validation.success &&
    validation.issues.some((issue) =>
      ['metadataOverrides', 'reasoningSupport'].includes(String(issue.path?.[0]?.key)),
    );
  return (
    <Disclosure
      stateKey={stateKey}
      forceOpen={invalid}
      title={
        <>
          模型能力{' '}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {custom
              ? `自定义 ${custom} 项`
              : automatic.sources.contextWindow === 'fallback'
                ? '未识别'
                : '自动'}
          </span>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="secondary"
            type="button"
            title="发送最多 3 次模型请求，可能产生供应商费用"
            disabled={testing}
            onClick={onTest}
          >
            {testing && <Spinner />}
            {testing ? '测试中' : '测试能力'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onChange({ metadataOverrides: undefined, reasoningSupport: 'auto' })}
          >
            恢复自动
          </Button>
        </div>
        {(testing || results.length > 0) && (
          <div
            role="status"
            aria-live="polite"
            aria-label="能力测试结果"
            className="space-y-1 text-xs"
          >
            {results.map((result) => (
              <p key={result.capability}>
                {probeCapabilityLabels[result.capability]}：{probeReasonLabels[result.reason]}
              </p>
            ))}
          </div>
        )}
        {testError && (
          <p role="alert" className="text-xs">
            {testError}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['contextWindow', '上下文窗口'],
              ['maxOutputTokens', '最大输出'],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block min-w-0 space-y-1">
              <span className="flex flex-wrap justify-between gap-1 text-sm">
                <span>{label}（Tokens）</span>
                <span className="text-xs text-muted-foreground">{source(field)}</span>
              </span>
              <TokenLimitInput
                label={`${label}（Tokens） ${index + 1}`}
                value={overrides[field]}
                automatic={automatic[field]}
                change={(value) => change({ [field]: value })}
              />
            </label>
          ))}
          <label className="block min-w-0 space-y-1">
            <span className="flex flex-wrap justify-between gap-1 text-sm">
              <span>窗口范围</span>
              <span className="text-xs text-muted-foreground">{source('contextScope')}</span>
            </span>
            <NativeSelect
              aria-label={`窗口范围 ${index + 1}`}
              className="w-full border-input"
              value={overrides.contextScope ?? 'auto'}
              onChange={(event) =>
                change({
                  contextScope:
                    event.target.value === 'auto'
                      ? undefined
                      : (event.target.value as ModelMetadata['contextScope']),
                })
              }
            >
              <option value="auto">
                自动（{automatic.contextScope === 'input' ? '仅输入' : '输入＋输出'}）
              </option>
              <option value="combined">输入＋输出</option>
              <option value="input">仅输入</option>
            </NativeSelect>
          </label>
          <label className="block min-w-0 space-y-1">
            <span className="flex flex-wrap justify-between gap-1 text-sm">
              <span>思考能力</span>
              <span className="text-xs text-muted-foreground">{source('reasoning')}</span>
            </span>
            <NativeSelect
              aria-label={`思考能力 ${index + 1}`}
              className="w-full border-input"
              value={model.reasoningSupport ?? 'auto'}
              onChange={(event) =>
                onChange({
                  reasoningSupport: event.target.value as ProviderModel['reasoningSupport'],
                })
              }
            >
              <option value="auto">自动（{capability('reasoning')}）</option>
              <option value="supported">支持</option>
              <option value="unsupported">不支持</option>
            </NativeSelect>
          </label>
          {(
            [
              ['imageInput', '图片输入'],
              ['toolCalls', '工具调用'],
              ['structuredOutput', '结构化输出'],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block min-w-0 space-y-1">
              <span className="flex flex-wrap justify-between gap-1 text-sm">
                <span>{label}</span>
                <span className="text-xs text-muted-foreground">{source(field)}</span>
              </span>
              <NativeSelect
                aria-label={`${label} ${index + 1}`}
                className="w-full border-input"
                value={
                  overrides[field] === undefined
                    ? 'auto'
                    : overrides[field]
                      ? 'supported'
                      : 'unsupported'
                }
                onChange={(event) =>
                  change({
                    [field]:
                      event.target.value === 'auto'
                        ? undefined
                        : event.target.value === 'supported',
                  })
                }
              >
                <option value="auto">自动（{capability(field)}）</option>
                <option value="supported">支持</option>
                <option value="unsupported">不支持</option>
              </NativeSelect>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">留空自动；模型最大输出不改变请求输出上限。</p>
        {metadata.reasoning && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label={`自定义思维强度 ${index + 1}`}
                checked={overrides.reasoningEfforts !== undefined}
                onCheckedChange={(checked) =>
                  change({
                    reasoningEfforts: checked === true ? [...metadata.reasoningEfforts] : undefined,
                  })
                }
              />
              自定义可选思维强度
              <span className="text-xs text-muted-foreground">{source('reasoningEfforts')}</span>
            </label>
            {overrides.reasoningEfforts !== undefined && (
              <div
                role="group"
                aria-label={`可选思维强度 ${index + 1}`}
                className="flex flex-wrap gap-x-4 gap-y-2"
              >
                {reasoningEfforts.map((effort) => (
                  <label key={effort} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={`思维强度 ${effortLabels[effort]} ${index + 1}`}
                      checked={overrides.reasoningEfforts!.includes(effort)}
                      onCheckedChange={(checked) =>
                        change({
                          reasoningEfforts: reasoningEfforts.filter((value) =>
                            value === effort
                              ? checked === true
                              : overrides.reasoningEfforts!.includes(value),
                          ),
                        })
                      }
                    />
                    {effortLabels[effort]}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {invalid && (
          <p role="alert" className="text-xs">
            请检查模型能力参数。
          </p>
        )}
      </div>
    </Disclosure>
  );
}
