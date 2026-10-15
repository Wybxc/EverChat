import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { MAX_TOOL_EXCHANGES } from '../shared/web-tools';
import type { ToolTaskState } from './tool-task-journal';

export interface ToolWorkflowParams { conversationId: string; taskId: string }
export const toolWorkflowId = (conversationId: string, taskId: string) => `${conversationId}-${taskId}`;
const retry = { retries: { limit: 2, delay: '1 second' as const, backoff: 'exponential' as const }, timeout: '30 seconds' as const };
const reference = (state: ToolTaskState) => ({ status: state.status, phase: state.phase, round: state.round, calls: [...state.calls] });

// Step results contain only small durable references/status, never model bodies, keys or tool outputs.
export class WebToolWorkflow extends WorkflowEntrypoint<Env, ToolWorkflowParams> {
  async run(event: WorkflowEvent<ToolWorkflowParams>, step: WorkflowStep) {
    const { conversationId, taskId } = event.payload;
    // A DO reset breaks the old stub, including its future RPCs. Recreate it on
    // every step attempt so Workflow retries can read the recovered journal.
    const conversation = () => this.env.CONVERSATIONS.getByName(conversationId);
    try {
      for (let round = 0; round <= MAX_TOOL_EXCHANGES; round++) {
        const scheduled = await step.do(`schedule-model-${round}`, retry, async () => reference(await conversation().scheduleToolModel(taskId, round)));
        if (scheduled.status !== 'active') return { status: scheduled.status };
        if (scheduled.phase === 'queued' || scheduled.phase === 'running') {
          await step.waitForEvent(`model-finished-${round}`, { type: `model-${round}`, timeout: '11 minutes' });
        }
        const state = await step.do(`read-model-${round}`, retry, async () => reference(await conversation().toolTaskState(taskId)));
        if (state.status !== 'active') return { status: state.status };
        if (state.round !== round || state.phase !== 'tools') throw new Error('Unexpected tool round');
        for (const [index, callId] of state.calls.entries()) {
          const result = await step.do(`tool-${round}-${index}`, retry, async () => reference(await conversation().runWebTool(taskId, callId)));
          if (result.status !== 'active') return { status: result.status };
        }
      }
      throw new Error('Tool round limit exceeded');
    } catch {
      return step.do('stop-interrupted-task', retry, async () => {
        const state = await conversation().failToolTask(taskId);
        return { status: state.status };
      });
    }
  }
}
