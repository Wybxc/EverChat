import { AppError, problem } from '../errors/descriptor';
import {
  validReasoningBreaks,
  type PublicToolCall,
  type PublicToolTask,
  type ReasoningBreak,
} from './tasks';

/** Preserve semantic positions when the execution journal refreshes public call states. */
export function updateToolTask(
  previous: PublicToolTask,
  current: PublicToolTask,
  reasoning: string,
  boundary?: ReasoningBreak,
): PublicToolTask {
  // A task started before ordering was recorded remains historical for its whole lifetime.
  if (previous.reasoningBreaks === undefined) return current;
  const breaks = [...previous.reasoningBreaks];
  if (boundary) {
    const existing = breaks.find((item) => item.round === boundary.round);
    if (existing && existing.reasoningEnd !== boundary.reasoningEnd)
      throw new AppError(problem('TOOL_INVALID'), '工具思考位置已确定，不能覆盖。');
    if (!existing) breaks.push(boundary);
  }
  const task = { ...current, reasoningBreaks: breaks };
  if (!validReasoningBreaks(task, reasoning))
    throw new AppError(problem('TOOL_INVALID'), '工具思考位置与已保存内容不一致。');
  return task;
}

export type ReasoningBlock =
  | { type: 'reasoning'; round: number; text: string; complete: boolean }
  | { type: 'tools'; round: number; calls: PublicToolCall[] };

export function reasoningBlocks(reasoning: string, task?: PublicToolTask): ReasoningBlock[] {
  if (task && !validReasoningBreaks(task, reasoning))
    throw new AppError(problem('TOOL_INVALID'), '工具思考位置无效。');
  const blocks: ReasoningBlock[] = [];
  let start = 0;
  if (task?.reasoningBreaks) {
    for (const boundary of task.reasoningBreaks) {
      // Retain empty slots so a streaming fragment keeps its identity when the tool is registered.
      blocks.push({
        type: 'reasoning',
        round: boundary.round,
        text: reasoning.slice(start, boundary.reasoningEnd),
        complete: true,
      });
      blocks.push({
        type: 'tools',
        round: boundary.round,
        calls: task.calls.filter((item) => item.round === boundary.round),
      });
      start = boundary.reasoningEnd;
    }
  }
  blocks.push({
    type: 'reasoning',
    round: (task?.reasoningBreaks?.at(-1)?.round ?? -1) + 1,
    text: reasoning.slice(start),
    complete: false,
  });
  if (task && task.reasoningBreaks === undefined) {
    for (const round of [...new Set(task.calls.map((item) => item.round))].sort((a, b) => a - b))
      blocks.push({
        type: 'tools',
        round,
        calls: task.calls.filter((item) => item.round === round),
      });
  }
  return blocks;
}
