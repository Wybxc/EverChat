import type { MetadataSource, ReasoningEffort } from '../../../shared/models/types';
import type { ModelProbeResult, ProbeCapability } from '../../../shared/models/probe';
import { t } from './locales';

const sources = {
  manual: 'sourceManual',
  provider: 'sourceProvider',
  tested: 'sourceTested',
  catalog: 'sourceCatalog',
  directory: 'sourceDirectory',
  inferred: 'sourceInferred',
  fallback: 'sourceFallback',
} as const;
const efforts = {
  none: 'effortNone',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
  max: 'effortMax',
} as const;
const capabilities = {
  text: 'probeText',
  imageInput: 'probeImage',
  toolCalls: 'probeTool',
} as const;
const reasons = {
  matched: 'probeMatched',
  mismatch: 'probeMismatch',
  'request-failed': 'probeRequestFailed',
  timeout: 'probeTimeout',
  'response-too-large': 'probeTooLarge',
} as const;

export const metadataSourceLabel = (source: MetadataSource) => t(($) => $[sources[source]]);
export const effortLabel = (effort: ReasoningEffort) => t(($) => $[efforts[effort]]);
export const probeCapabilityLabel = (capability: ProbeCapability) =>
  t(($) => $[capabilities[capability]]);
export const probeReasonLabel = (reason: ModelProbeResult['reason']) =>
  t(($) => $[reasons[reason]]);
