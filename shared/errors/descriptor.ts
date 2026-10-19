import * as v from 'valibot';
import { errorFallbacks } from './fallbacks';
export type ErrorCode = keyof typeof errorFallbacks;
const parameters = {
  CONTEXT_BUDGET_EXCEEDED: ['estimatedTokens', 'budgetTokens'],
  OUTPUT_BUDGET_EXCEEDED: ['limit'],
  TEMPERATURE_EXCEEDED: ['limit'],
  TOP_P_BELOW_MINIMUM: ['limit'],
  MODEL_LIST_LIMIT: ['limit'],
  PROVIDER_HTTP_ERROR: ['status'],
  PDF_SELECTION_RANGE: ['limit'],
} as const;
export interface ErrorIssue {
  code: ErrorCode;
  params?: Record<string, number>;
}
const codes = Object.keys(errorFallbacks) as [ErrorCode, ...ErrorCode[]];
export const errorIssueSchema = v.pipe(
  v.strictObject({
    code: v.picklist(codes),
    params: v.optional(
      v.record(
        v.string(),
        v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
      ),
    ),
  }),
  v.check((issue) => {
    const allowed: readonly string[] = parameters[issue.code as keyof typeof parameters] ?? [];
    const actual = Object.keys(issue.params ?? {});
    return actual.length === allowed.length && allowed.every((key) => actual.includes(key));
  }),
);
/** The only values allowed across the error boundary are named, bounded numbers. */
export function readErrorIssue(value: unknown): ErrorIssue | undefined {
  const parsed = v.safeParse(errorIssueSchema, value);
  return parsed.success ? parsed.output : undefined;
}
type Params<C extends ErrorCode> = C extends keyof typeof parameters
  ? [params: Record<(typeof parameters)[C][number], number>]
  : [];
export function problem<C extends ErrorCode>(code: C, ...args: Params<C>): ErrorIssue {
  const value = { code, ...(args[0] ? { params: args[0] } : {}) };
  const parsed = readErrorIssue(value);
  if (!parsed) throw new Error('Invalid first-party error descriptor');
  return parsed;
}
export function issueText(issue: ErrorIssue): string {
  return errorFallbacks[issue.code].replace(/{{(\w+)}}/g, (_, key: string) =>
    String(issue.params?.[key] ?? ''),
  );
}
export class AppError extends Error {
  constructor(
    readonly issue: ErrorIssue,
    diagnostic?: string,
  ) {
    super(diagnostic ?? issueText(issue));
    this.name = 'AppError';
  }
}
export function issueOf(
  error: unknown,
  fallback: Exclude<ErrorCode, keyof typeof parameters> = 'REQUEST_FAILED',
): ErrorIssue {
  if (error instanceof AppError) return error.issue;
  return problem(fallback);
}
