import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { WebToolWorkflow as ProductionWorkflow, type ToolWorkflowParams } from '../../worker/tool-workflow';

// Instrument the real Workflow, including callback retries. Results contain only
// names and byte counts; production entrypoints do not import this subclass.
export class WebToolWorkflow extends ProductionWorkflow {
  override async run(event: WorkflowEvent<ToolWorkflowParams>, step: WorkflowStep) {
    if ((this.env as { LOCAL_RESOURCE_METRICS?: string }).LOCAL_RESOURCE_METRICS !== '1') return super.run(event, step);
    const steps: { name: string; attempts: number; failures: number; resultBytes: number }[] = [];
    const waits: { name: string; resultBytes: number }[] = [];
    const encoder = new TextEncoder();
    const measured = new Proxy(step, { get(target, property) {
      if (property === 'do') return async (name: string, options: unknown, callback: (...args: unknown[]) => unknown) => {
        const entry = { name, attempts: 0, failures: 0, resultBytes: 0 }; steps.push(entry);
        const result = await Reflect.apply(target.do, target, [name, options, async (...args: unknown[]) => {
          entry.attempts++;
          try { return await callback(...args); } catch (error) { entry.failures++; throw error; }
        }]);
        entry.resultBytes = encoder.encode(JSON.stringify(result) ?? '').byteLength; return result;
      };
      if (property === 'waitForEvent') return async (name: string, options: unknown) => {
        const result = await Reflect.apply(target.waitForEvent, target, [name, options]);
        waits.push({ name, resultBytes: encoder.encode(JSON.stringify(result) ?? '').byteLength }); return result;
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await super.run(event, measured);
    return { ...result, localMeasurement: { steps, waits } };
  }
}
