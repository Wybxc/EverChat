import { useTranslation } from 'react-i18next';
import './locales';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { NativeSelect } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { useEffect, useRef, useState } from 'react';
import {
  MAX_MODEL_TOKENS,
  reasoningEfforts,
  resolveModelMetadata,
} from '../../../shared/models/metadata';
import {
  metadataSourceLabel,
  effortLabel,
  probeCapabilityLabel,
  probeReasonLabel,
} from './model-labels';
import type {
  ModelMetadata,
  ModelMetadataOverrides,
  ProviderModel,
} from '../../../shared/models/types';
import type { ProviderApiKind } from '../../../shared/providers/types';
import * as v from 'valibot';
import { modelSchema } from '../../../shared/providers/settings';
import { Disclosure } from '../../components/Disclosure';
import { type ModelProbeResult } from '../../../shared/models/probe';
import { ProviderFailureView } from './ProviderFailureView';

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
  useTranslation('providers', { useSuspense: false });

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
  const { t } = useTranslation('providers', { useSuspense: false });

  const metadata = resolveModelMetadata(provider, model);
  const automatic = resolveModelMetadata(provider, {
    ...model,
    metadataOverrides: undefined,
    reasoningSupport: 'auto',
  });
  const overrides = model.metadataOverrides ?? {};
  const change = (patch: ModelMetadataOverrides) =>
    onChange({ metadataOverrides: { ...overrides, ...patch } });
  const source = (field: keyof ModelMetadata) => metadataSourceLabel(metadata.sources[field]);
  const capability = (field: 'imageInput' | 'toolCalls' | 'structuredOutput' | 'reasoning') => {
    if (automatic.sources[field] === 'fallback')
      return field === 'imageInput' || field === 'toolCalls'
        ? t(($) => $.unknownCanTry)
        : t(($) => $.unknown);
    if (
      automatic.sources[field] === 'inferred' &&
      !automatic[field] &&
      (field === 'imageInput' || field === 'toolCalls')
    )
      return t(($) => $.inferredUnsupported);
    return automatic[field] ? t(($) => $.supported) : t(($) => $.unsupported);
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
          {t(($) => $.modelCapabilities)}{' '}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {custom
              ? t(($) => $.customCount, { count: custom })
              : automatic.sources.contextWindow === 'fallback'
                ? t(($) => $.unknown)
                : t(($) => $.automatic)}
          </span>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="secondary"
            type="button"
            title={t(($) => $.probeCostHint)}
            disabled={testing}
            onClick={onTest}
          >
            {testing && <Spinner />}
            {testing ? t(($) => $.testing) : t(($) => $.testCapabilities)}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onChange({ metadataOverrides: undefined, reasoningSupport: 'auto' })}
          >
            {t(($) => $.restoreAutomatic)}
          </Button>
        </div>
        {(testing || results.length > 0) && (
          <div
            role="status"
            aria-live="polite"
            aria-label={t(($) => $.probeResults)}
            className="space-y-1 text-xs"
          >
            {results.map((result) => (
              <div key={result.capability}>
                <p>
                  {probeCapabilityLabel(result.capability)}：{probeReasonLabel(result.reason)}
                </p>
                {result.failure && (
                  <ProviderFailureView
                    summary={t(($) => $.probeFailureSummary, {
                      capability: probeCapabilityLabel(result.capability),
                    })}
                    failure={result.failure}
                    stateKey={`probe:${result.capability}:${result.testedAt}`}
                    showSummary={false}
                  />
                )}
              </div>
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
              ['contextWindow', t(($) => $.contextWindow)],
              ['maxOutputTokens', t(($) => $.maxOutput)],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block min-w-0 space-y-1">
              <span className="flex flex-wrap justify-between gap-1 text-sm">
                <span>{t(($) => $.tokenField, { label })}</span>
                <span className="text-xs text-muted-foreground">{source(field)}</span>
              </span>
              <TokenLimitInput
                label={t(($) => $.indexedField, {
                  label: t(($) => $.tokenField, { label }),
                  index: index + 1,
                })}
                value={overrides[field]}
                automatic={automatic[field]}
                change={(value) => change({ [field]: value })}
              />
            </label>
          ))}
          <label className="block min-w-0 space-y-1">
            <span className="flex flex-wrap justify-between gap-1 text-sm">
              <span>{t(($) => $.contextScope)}</span>
              <span className="text-xs text-muted-foreground">{source('contextScope')}</span>
            </span>
            <NativeSelect
              aria-label={t(($) => $.contextScopeField, { index: index + 1 })}
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
                {t(($) => $.automaticValue, {
                  value:
                    automatic.contextScope === 'input'
                      ? t(($) => $.inputOnly)
                      : t(($) => $.combined),
                })}
              </option>
              <option value="combined">{t(($) => $.combined)}</option>
              <option value="input">{t(($) => $.inputOnly)}</option>
            </NativeSelect>
          </label>
          <label className="block min-w-0 space-y-1">
            <span className="flex flex-wrap justify-between gap-1 text-sm">
              <span>{t(($) => $.reasoningSupport)}</span>
              <span className="text-xs text-muted-foreground">{source('reasoning')}</span>
            </span>
            <NativeSelect
              aria-label={t(($) => $.reasoningSupportField, { index: index + 1 })}
              className="w-full border-input"
              value={model.reasoningSupport ?? 'auto'}
              onChange={(event) =>
                onChange({
                  reasoningSupport: event.target.value as ProviderModel['reasoningSupport'],
                })
              }
            >
              <option value="auto">
                {t(($) => $.automaticValue, { value: capability('reasoning') })}
              </option>
              <option value="supported">{t(($) => $.supported)}</option>
              <option value="unsupported">{t(($) => $.unsupported)}</option>
            </NativeSelect>
          </label>
          {(
            [
              ['imageInput', t(($) => $.imageInput)],
              ['toolCalls', t(($) => $.toolCalls)],
              ['structuredOutput', t(($) => $.structuredOutput)],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block min-w-0 space-y-1">
              <span className="flex flex-wrap justify-between gap-1 text-sm">
                <span>{label}</span>
                <span className="text-xs text-muted-foreground">{source(field)}</span>
              </span>
              <NativeSelect
                aria-label={t(($) => $.indexedField, { label, index: index + 1 })}
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
                <option value="auto">
                  {t(($) => $.automaticValue, { value: capability(field) })}
                </option>
                <option value="supported">{t(($) => $.supported)}</option>
                <option value="unsupported">{t(($) => $.unsupported)}</option>
              </NativeSelect>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t(($) => $.limitsHint)}</p>
        {metadata.reasoning && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label={t(($) => $.customEffortsField, { index: index + 1 })}
                checked={overrides.reasoningEfforts !== undefined}
                onCheckedChange={(checked) =>
                  change({
                    reasoningEfforts: checked === true ? [...metadata.reasoningEfforts] : undefined,
                  })
                }
              />
              {t(($) => $.customEfforts)}
              <span className="text-xs text-muted-foreground">{source('reasoningEfforts')}</span>
            </label>
            {overrides.reasoningEfforts !== undefined && (
              <div
                role="group"
                aria-label={t(($) => $.availableEffortsField, { index: index + 1 })}
                className="flex flex-wrap gap-x-4 gap-y-2"
              >
                {reasoningEfforts.map((effort) => (
                  <label key={effort} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={t(($) => $.effortField, {
                        effort: effortLabel(effort),
                        index: index + 1,
                      })}
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
                    {effortLabel(effort)}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {invalid && (
          <p role="alert" className="text-xs">
            {t(($) => $.invalidCapabilities)}
          </p>
        )}
      </div>
    </Disclosure>
  );
}
