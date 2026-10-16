import { useMemo } from 'react';
import * as v from 'valibot';
import { type DocumentPart } from '../../../shared/attachments/documents';
import { type ImagePart } from '../../../shared/attachments/images';
import { buildContext,contextSource } from '../../../shared/conversation/context-budget';
import { applyConversationSettings,conversationSettingsSchema } from '../../../shared/conversation/settings';
import { prepareChatContext,summaryContext,summaryGeneration,summaryPrefix } from '../../../shared/conversation/summaries';
import { type ConversationSettings,type Message } from '../../../shared/conversation/types';
import { modelSelectionKey } from '../../../shared/models/selection';
import type { ChatModel } from '../../../shared/models/types';
import { type ReasoningEffort } from '../../../shared/models/types';
import { type SessionInfo } from '../../../shared/providers/types';


export function useContextPreview({ messages, parentId, draft, revisionOf, draftImages, draftFiles, conversationSettings, selectedModel, models, reasoningEffort, session }: {
 messages: Message[]; parentId: string | null; draft: string; revisionOf?: string; draftImages: ImagePart[]; draftFiles: DocumentPart[]; conversationSettings: ConversationSettings; selectedModel?: ChatModel; models: ChatModel[]; reasoningEffort: ReasoningEffort | ''; session: SessionInfo | null;
}) {
  const previewSource = contextSource(messages, { content: draft, revisionOf, parentId: parentId });
  const previewHistory = useMemo(() => {
    try { return summaryContext(messages, previewSource.parentId, conversationSettings.useSummaries); } catch { return null; }
  }, [messages, previewSource.parentId, conversationSettings.useSummaries]);
  const contextPreview = useMemo(() => {
    if (!selectedModel || !previewHistory) return null;
    const settings = v.safeParse(conversationSettingsSchema, conversationSettings);
    if (!settings.success) return null;
    let estimate;
    try {
      const config = applyConversationSettings({ ...selectedModel, systemPrompt: selectedModel.systemPrompt ?? session?.systemPrompt ?? '',
        maxOutputTokens: session?.maxOutputTokens ?? null, modelMetadata: selectedModel.metadata, reasoningEnabled: selectedModel.reasoningSupported,
        reasoningEffort: reasoningEffort || undefined, showReasoning: session?.showReasoning }, settings.output);
      estimate = buildContext(previewHistory.history, draft.trim(), config, settings.output, previewHistory.summary ? summaryPrefix(previewHistory.summary) : undefined, draftImages, draftFiles).estimate;
      const prepared = prepareChatContext(messages, previewSource.parentId, draft.trim(), config, settings.output, draftImages, draftFiles);
      if (prepared.automatic) {
        const selection = settings.output.autoCompression.model;
        const model = selection ? models.find((item) => modelSelectionKey(item) === modelSelectionKey(selection)) : selectedModel;
        if (!model) throw new Error('自动压缩模型不可用，请启用所选模型或关闭自动压缩。');
        summaryGeneration(messages, prepared.automatic.throughId, { ...model, systemPrompt: '', maxOutputTokens: null, modelMetadata: model.metadata });
      }
      return { estimate: prepared.automatic?.demand ?? prepared.estimate, compressing: Boolean(prepared.automatic), error: '' };
    } catch (error) { return { estimate, error: error instanceof Error ? error.message : '无法预览上下文。' }; }
  }, [selectedModel, models, messages, previewSource.parentId, previewHistory, conversationSettings, draft, draftImages, draftFiles, reasoningEffort, session?.systemPrompt, session?.maxOutputTokens, session?.showReasoning]);
  return { previewHistory, contextPreview };
}
