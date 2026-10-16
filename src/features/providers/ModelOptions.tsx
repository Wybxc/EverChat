import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type ModelProbeResult } from '../../../shared/models/probe';
import type { ProviderModel } from '../../../shared/models/types';
import type { ProviderApiKind } from '../../../shared/providers/types';
import { ModelMetadataFields } from './ModelMetadataFields';

type ProbeControls = {
  onTest: () => void;
  testing: boolean;
  results: ModelProbeResult[];
  testError: string;
};
export function ModelOptions({
  model,
  index,
  provider,
  globalPrompt,
  onChange,
  stateKey,
  ...probe
}: {
  model: ProviderModel;
  index: number;
  provider: ProviderApiKind;
  globalPrompt: string;
  onChange: (patch: Partial<ProviderModel>) => void;
  stateKey: string;
} & ProbeControls) {
  return (
    <div className="space-y-3 pt-2">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1">
          <span className="text-xs">ID</span>
          <Input
            aria-label={`模型 ID ${index + 1}`}
            required
            maxLength={200}
            className="w-full border-input"
            value={model.id}
            onChange={(event) => onChange({ id: event.target.value })}
          />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-xs">显示名</span>
          <Input
            aria-label={`模型显示名 ${index + 1}`}
            maxLength={200}
            className="w-full border-input"
            value={model.name}
            placeholder={model.id}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          aria-label={`继承统一提示词 ${index + 1}`}
          checked={model.useGlobalSystemPrompt !== false}
          onCheckedChange={(checked) =>
            onChange({
              useGlobalSystemPrompt: checked === true,
              systemPrompt: model.systemPrompt ?? globalPrompt,
            })
          }
        />
        使用统一系统提示词
      </label>
      {model.useGlobalSystemPrompt === false && (
        <label className="block space-y-2">
          <span className="text-sm">模型专属提示词</span>
          <Textarea
            aria-label={`模型专属提示词 ${index + 1}`}
            rows={4}
            maxLength={20000}
            className="w-full border-input"
            value={model.systemPrompt ?? ''}
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
        </label>
      )}
      <ModelMetadataFields
        provider={provider}
        model={model}
        index={index}
        onChange={onChange}
        stateKey={stateKey}
        {...probe}
      />
    </div>
  );
}
