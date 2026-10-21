import { matchSorter } from 'match-sorter';
import type { ChatModel } from '../../../shared/models/types';

export function searchModels(models: ChatModel[], query: string): ChatModel[] {
  return query.trim()
    ? matchSorter(models, query.trim(), {
        keys: ['name', 'model', 'providerName'],
        baseSort: (left, right) => left.index - right.index,
      })
    : models;
}

export function groupModels(models: ChatModel[]) {
  const groups = new Map<string, { providerId: string; items: ChatModel[] }>();
  for (const model of models) {
    let group = groups.get(model.providerId);
    if (!group) {
      group = { providerId: model.providerId, items: [] };
      groups.set(model.providerId, group);
    }
    group.items.push(model);
  }
  return [...groups.values()];
}
