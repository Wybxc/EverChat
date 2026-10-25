import { documentKey, type DocumentPart } from '../attachments/documents';
import type { ChatInput } from '../providers/types';
import type { Message } from './types';
import { branchPath } from './branch-path';
import { messageFiles } from './content';
import { ContextBudgetError } from './context-budget';

export function materialContext(
  messages: Message[],
  parentId: string | null,
  current: DocumentPart[] = [],
  sourceId?: string,
) {
  const path = parentId ? branchPath(messages, parentId) : [],
    active = new Map<string, Map<string, { file: DocumentPart; sourceId?: string }>>();
  const occurrences: { file: DocumentPart; sourceId: string }[] = [];
  const apply = (file: DocumentPart, sourceId?: string) => {
    const binding = file.material;
    if (!binding) return;
    const versions =
      active.get(binding.documentId) ??
      new Map<string, { file: DocumentPart; sourceId?: string }>();
    if (binding.mode === 'reuse' && versions.size && !versions.has(binding.versionId))
      throw new ContextBudgetError('该资料已有其他活动版本，请明确选择替换或同时包含。');
    if (binding.mode === 'replace') versions.clear();
    versions.set(binding.versionId, { file, sourceId });
    active.set(binding.documentId, versions);
  };
  for (const message of path) {
    if (message.role !== 'user' || message.status !== 'completed' || message.deletedAt) continue;
    for (const file of messageFiles(message))
      if (file.material) {
        apply(file, message.id);
        occurrences.push({ file, sourceId: message.id });
      }
  }
  const perDocument = new Map<string, DocumentPart[]>();
  for (const file of current)
    if (file.material) {
      const entries = perDocument.get(file.material.documentId) ?? [];
      entries.push(file);
      perDocument.set(file.material.documentId, entries);
    }
  for (const entries of perDocument.values())
    if (entries.length > 1 && entries.some((f) => f.material!.mode === 'replace'))
      throw new ContextBudgetError(
        '一次请求中的同一资料不能同时替换并选择多个版本，请使用同时包含。',
      );
  for (const file of current) apply(file, sourceId);
  const retained = [...active.values()].flatMap((versions) => [...versions.values()]);
  const versions = retained.map(({ file }) => ({
    documentId: file.material!.documentId,
    versionId: file.material!.versionId,
    textSha256: file.textSha256,
  }));
  const currentVersion = (file: DocumentPart) =>
    active.get(file.material!.documentId)?.get(file.material!.versionId)?.file;
  const excluded = occurrences.filter(
    ({ file }) =>
      documentKey(currentVersion(file) ?? file) !== documentKey(file) || !currentVersion(file),
  );
  const excludedSources = new Set(excluded.map((s) => s.sourceId));
  const invalidatedSummaries: string[] = [];
  const sanitized = messages.map((message) => {
    let invalid = false;
    if (
      message.summary &&
      message.summary.sourceIds.length <= path.length &&
      message.summary.sourceIds.every((id, i) => path[i].id === id)
    ) {
      const provenance = message.summary.materials;
      invalid = provenance
        ? provenance.some(
            (v) =>
              !versions.some(
                (a) =>
                  a.documentId === v.documentId &&
                  a.versionId === v.versionId &&
                  a.textSha256 === v.textSha256,
              ),
          )
        : message.summary.sourceIds.some((id) => excludedSources.has(id));
    }
    if (invalid) invalidatedSummaries.push(message.id);
    return {
      ...message,
      ...(invalid ? { status: 'failed' as const } : {}),
      parts: message.parts.filter((p) => p.type !== 'file' || !p.material),
    };
  });
  const pinned: ChatInput[] = retained.map(({ file, sourceId }) => ({
    role: 'user',
    content: `附带资料版本：${file.name}（${file.material!.versionId}）`,
    source: { kind: 'generated', messageId: sourceId },
    files: [file],
  }));
  return {
    messages: sanitized,
    pinned,
    versions,
    current: current.filter((file) => !file.material),
    excluded,
    invalidatedSummaries,
  };
}
