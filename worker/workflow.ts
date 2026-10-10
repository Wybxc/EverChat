import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import type { GenerationParams } from '../shared/types';
import { generate, GenerationCancelled, ProviderError } from './provider';

export class GenerationWorkflow extends WorkflowEntrypoint<Env, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep) {
    const { conversationId, runId } = event.payload;
    const conversation = this.env.CONVERSATIONS.getByName(conversationId);
    try {
      await step.do('generate-and-persist', { retries: { limit: 0, delay: '1 second' }, timeout: '15 minutes' }, async () => {
        const claim = await conversation.claim(runId);
        if (!claim?.claimed) {
          if (claim?.status === 'running') await conversation.finish(runId, 'failed', '后台执行被中断。为避免重复计费，请主动重新生成。');
          return;
        }
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 14 * 60_000);
        let content = '', chunkSeq = 0, lastFlush = 0;
        const flush = async () => {
          if (!await conversation.checkpoint(runId, content, ++chunkSeq)) throw new GenerationCancelled();
          lastFlush = Date.now();
        };
        try {
          const config = await this.env.LIBRARY.getByName('personal').providerConfig();
          await generate(config, claim.context, async (delta) => {
            content += delta;
            if (content.length > 100_000) throw new ProviderError('回答已达到 100,000 字的原型限制。');
            if (Date.now() - lastFlush >= 500) await flush();
          }, abort.signal);
          await flush();
          await conversation.finish(runId, 'completed');
        } catch (error) {
          if (!(error instanceof GenerationCancelled)) {
            // Flush buffered text on an upstream error before marking the run failed.
            await conversation.checkpoint(runId, content.slice(0, 100_000), ++chunkSeq);
            await conversation.finish(runId, 'failed', error instanceof ProviderError ? error.message : '生成中断或超时。已保存部分内容，请主动重新生成。');
          }
        } finally { clearTimeout(timer); abort.abort(); }
      });
    } catch {
      // This idempotent step may retry persistence; it never invokes the provider.
      await step.do('record-interruption', async () => {
        await conversation.finish(runId, 'failed', '后台任务被中断。已保存部分内容，请主动重新生成。');
      });
    }
  }
}
