import type { Env } from '../../../worker/http/env';
export type MeasurementEnv = Env & { LOCAL_RESOURCE_METRICS?: string; LOCAL_TOOL_WORKLOAD?: string; LOCAL_MEASUREMENT_RUN?: string };
