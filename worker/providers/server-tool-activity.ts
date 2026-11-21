import * as v from 'valibot';
import type { ProviderConfig } from '../../shared/providers/types';
import { inputHash } from './input-receipt';
import type { ServerToolReplay } from './server-tool-replay';
import { serverToolUnitRate, type ServerToolUsage } from '../../shared/usage/server-tools';
import {
  serverToolSourceSchema,
  type ServerToolActivity,
  type ServerToolKind,
} from '../../shared/tools/server-tools';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const array = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(object) : []);
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const state = (status: unknown): ServerToolActivity['status'] =>
  status === 'completed'
    ? 'completed'
    : ['failed', 'incomplete'].includes(string(status))
      ? 'failed'
      : 'running';

const responsesTools: Record<string, ServerToolKind> = {
  web_search_call: 'web-search',
  file_search_call: 'file-search',
  code_interpreter_call: 'code-execution',
  image_generation_call: 'image-generation',
  shell_call: 'shell',
  shell_call_output: 'shell',
};

export class ServerToolTrace {
  private readonly activities = new Map<string, ServerToolActivity>();
  private readonly dirty = new Set<ServerToolActivity>();
  private readonly queries = new Set<string>();
  private readonly reported = new Map<string, ServerToolUsage>();
  private meterChanged = false;
  private readonly vendor;
  private readonly enabled;

  constructor(
    private readonly config: ProviderConfig,
    private readonly secrets: readonly string[],
    replays?: readonly ServerToolReplay[],
  ) {
    this.vendor = config.serverTools?.[0]?.vendor;
    this.enabled = new Set(config.serverTools?.map(({ tool }) => tool));
    for (const replay of replays ?? []) {
      if (replay.type !== 'anthropic') continue;
      for (const block of replay.blocks) this.anthropicBlock(block);
      for (const [id, activity] of this.activities)
        if (activity.status !== 'running') this.activities.delete(id);
      this.dirty.clear();
    }
  }

  private update(
    key: string,
    tool: ServerToolKind,
    status: ServerToolActivity['status'],
    count?: number,
  ) {
    if (!this.vendor || !this.enabled.has(tool) || !key || key.length > 256) return;
    const existing = this.activities.get(key);
    if (existing) {
      if (existing.status === 'running' && status !== 'running') {
        existing.status = status;
        this.dirty.add(existing);
      }
      if (count !== undefined && count !== existing.count) {
        existing.count = count;
        this.dirty.add(existing);
      }
      return existing;
    }
    if (this.activities.size >= 32) return;
    const entry: ServerToolActivity = {
      id:
        key.startsWith('google:') || key.startsWith('annotation:') || key.startsWith('count:')
          ? crypto.randomUUID()
          : inputHash(JSON.stringify([this.vendor, key])),
      vendor: this.vendor,
      tool,
      status,
      sources: [],
      count,
    };
    this.activities.set(key, entry);
    this.dirty.add(entry);
    return entry;
  }

  private source(entry: ServerToolActivity | undefined, title: unknown, url?: unknown) {
    if (!entry || entry.sources.length >= 8) return;
    const link = string(url);
    const name = (string(title).trim() || link).slice(0, 240);
    if (
      !name ||
      this.secrets.some((secret) => secret && (name.includes(secret) || link.includes(secret)))
    )
      return;
    const parsed = v.safeParse(serverToolSourceSchema, {
      title: name,
      ...(link ? { url: link } : {}),
    });
    if (!parsed.success) return;
    const existing = entry.sources.find((item) => (link ? item.url === link : item.title === name));
    if (existing) {
      if (existing.title === link && name !== link) {
        existing.title = name;
        this.dirty.add(entry);
      }
      return;
    }
    entry.sources.push(parsed.output);
    this.dirty.add(entry);
  }

  private latest(tool: ServerToolKind) {
    return [...this.activities.values()].filter((entry) => entry.tool === tool).at(-1);
  }

  private annotation(raw: RecordValue) {
    if (
      raw.type === 'url_citation' ||
      raw.type === 'web_search_result_location' ||
      raw.type === 'web_fetch_result_location'
    ) {
      const citation = raw.url_citation ? object(raw.url_citation) : raw;
      const tool =
        raw.type === 'web_fetch_result_location' || !this.enabled.has('web-search')
          ? 'web-fetch'
          : 'web-search';
      const call = this.latest(tool) ?? this.update(`annotation:${tool}`, tool, 'completed');
      this.source(call, citation.title, citation.url);
    } else if (raw.type === 'file_citation') {
      this.source(
        this.latest('file-search') ?? this.update('annotation:file', 'file-search', 'completed'),
        raw.filename,
      );
    }
  }

  observe(raw: RecordValue) {
    switch (this.config.provider) {
      case 'openai-responses':
        if (raw.type === 'response.output_item.added' || raw.type === 'response.output_item.done')
          this.responseItem(object(raw.item), raw.type.endsWith('.done'));
        else if (raw.type === 'response.output_text.annotation.added')
          this.annotation(object(raw.annotation));
        else if (raw.type === 'response.completed' || raw.type === 'response.incomplete')
          for (const item of array(object(raw.response).output)) this.responseItem(item, true);
        break;
      case 'anthropic':
        if (raw.type === 'content_block_start') this.anthropicBlock(object(raw.content_block));
        else if (raw.type === 'content_block_delta')
          this.annotation(object(object(raw.delta).citation));
        break;
      case 'gemini':
        for (const candidate of array(raw.candidates)) {
          if (candidate.index !== undefined && candidate.index !== 0) continue;
          this.googleCandidate(candidate);
        }
        break;
      case 'openai-chat':
        for (const choice of array(raw.choices)) {
          if (choice.index !== undefined && choice.index !== 0) continue;
          const delta = object(choice.delta);
          this.deepseekChatCall(object(object(choice.server_tool_event).call));
          for (const step of array(delta.server_tool_calls))
            for (const item of array(step.calls)) this.deepseekChatCall(item);
          for (const annotation of array(delta.annotations)) this.annotation(annotation);
        }
    }
    const usage = object(raw.usage ?? object(raw.response ?? raw.message).usage);
    const counts = object(usage.server_tool_use);
    if (this.vendor === 'anthropic' || this.vendor === 'openrouter') {
      this.report('web-search', 'call', counts.web_search_requests);
      this.report('web-fetch', 'call', counts.web_fetch_requests);
    }
    if (this.vendor === 'deepseek') {
      this.report('web-search', 'call', counts.tool_search);
      this.report('web-fetch', 'call', counts.tool_fetch);
      this.report('web-search', 'image-query', counts.tool_image_search);
    }
    if (this.vendor === 'openrouter') {
      this.aggregate('web-search', counts.web_search_requests);
      this.aggregate('web-fetch', counts.web_fetch_requests);
    }
  }

  private report(tool: ServerToolKind, unit: ServerToolUsage['unit'], count: unknown) {
    if (
      !this.vendor ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 100_000
    )
      return;
    const key = `${tool}:${unit}`;
    if (this.reported.get(key)?.count === count) return;
    this.reported.set(key, {
      tool,
      unit,
      count,
      source: 'reported',
      usdPerUnit: serverToolUnitRate(this.vendor, tool),
    });
    this.meterChanged = true;
  }

  private aggregate(tool: ServerToolKind, count: unknown) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 100_000)
      return;
    const item = this.latest(tool) ?? this.update(`count:${tool}`, tool, 'completed');
    if (item && count !== item.count) {
      item.count = count;
      this.dirty.add(item);
    }
  }

  private responseItem(item: RecordValue, done: boolean) {
    if (item.type === 'message') {
      for (const content of array(item.content))
        for (const annotation of array(content.annotations)) this.annotation(annotation);
      return;
    }
    const type = string(item.type);
    const tool =
      this.vendor === 'deepseek' && type === 'web_search_call' && item.kind === 'read_link'
        ? 'web-fetch'
        : responsesTools[type];
    if (!tool) return;
    const status = type === 'shell_call_output' ? 'completed' : state(item.status);
    const activity = this.update(
      string(type === 'shell_call' || type === 'shell_call_output' ? item.call_id : item.id),
      tool,
      done && status === 'running' && type !== 'shell_call' ? 'completed' : status,
    );
    const action = object(item.action);
    for (const source of array(action.sources)) this.source(activity, source.title, source.url);
    for (const result of array(item.results)) this.source(activity, result.filename);
    const page = object(item.page);
    this.source(activity, page.title, page.url);
  }

  private anthropicBlock(block: RecordValue) {
    if (block.type === 'server_tool_use') {
      const name = string(block.name);
      const tool =
        name === 'web_search' || name === 'deepseek_web_search'
          ? 'web-search'
          : name === 'web_fetch' || name === 'deepseek_read_url'
            ? 'web-fetch'
            : name.includes('code_execution')
              ? 'code-execution'
              : undefined;
      if (tool) this.update(string(block.id), tool, 'running');
    } else if (string(block.type).endsWith('_tool_result')) {
      const id = string(block.tool_use_id);
      const call = this.activities.get(id);
      if (!call) return;
      const content = object(block.content);
      const failed =
        string(content.type).endsWith('_error') ||
        Boolean(content.error_code) ||
        (typeof content.return_code === 'number' && content.return_code !== 0);
      this.update(id, call.tool, failed ? 'failed' : 'completed');
      this.source(call, object(content.content).title ?? content.title, content.url);
      for (const source of array(block.content)) this.source(call, source.title, source.url);
    } else if (block.type === 'text') {
      for (const citation of array(block.citations)) this.annotation(citation);
    }
  }

  private googleCandidate(candidate: RecordValue) {
    const grounding = object(candidate.groundingMetadata);
    for (const query of Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries
      : []) {
      if (typeof query === 'string' && query.length <= 1024 && this.queries.size < 64)
        this.queries.add(query);
    }
    if (this.queries.size) this.update('google:web', 'web-search', 'completed', this.queries.size);
    for (const chunk of array(grounding.groundingChunks)) {
      const web = object(chunk.web);
      const retrieved = object(chunk.retrievedContext);
      if (web.uri)
        this.source(this.update('google:web', 'web-search', 'completed'), web.title, web.uri);
      if (retrieved.fileSearchStore || (retrieved.title && this.enabled.has('file-search')))
        this.source(this.update('google:file', 'file-search', 'completed'), retrieved.title);
    }
    const urls = array(object(candidate.urlContextMetadata).urlMetadata);
    for (const item of urls) {
      const url = string(item.retrievedUrl);
      const entry = this.update(
        `google:url:${url.slice(0, 224)}`,
        'web-fetch',
        item.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS' ? 'completed' : 'failed',
      );
      this.source(entry, url, url);
    }
  }

  private deepseekChatCall(call: RecordValue) {
    if (!call.id) return;
    const tool =
      call.type === 'deepseek_web_search'
        ? 'web-search'
        : call.type === 'deepseek_read_url'
          ? 'web-fetch'
          : undefined;
    if (!tool) return;
    const entry = this.update(string(call.id), tool, state(call.status));
    for (const source of array(call.sources)) this.source(entry, source.title, source.url);
    const page = object(call.page);
    this.source(entry, page.title, page.url);
  }

  sdk(toolName: string, id: string, status: ServerToolActivity['status']) {
    if (this.config.provider !== 'gemini' || toolName !== 'code_execution') return;
    this.update(id, 'code-execution', status);
  }

  finish() {
    for (const activity of this.activities.values()) {
      if (activity.status !== 'running') continue;
      activity.status = 'interrupted';
      this.dirty.add(activity);
    }
  }

  drain() {
    if (!this.dirty.size && !this.meterChanged) return;
    const activities = [...this.dirty];
    this.dirty.clear();
    this.meterChanged = false;
    const usage = new Map(this.reported);
    for (const [id, { tool, status, vendor, count }] of this.activities) {
      if (status !== 'completed') continue;
      if (id.startsWith('annotation:')) continue;
      const unit = vendor === 'google' && tool === 'web-search' ? 'query' : 'call';
      const key = `${tool}:${unit}`;
      if (this.reported.has(key)) continue;
      if (vendor === 'google' && tool === 'web-search' && count === undefined) continue;
      const total = Math.min(100_000, (usage.get(key)?.count ?? 0) + (count ?? 1));
      usage.set(key, {
        tool,
        unit,
        count: total,
        source: 'observed',
        usdPerUnit: serverToolUnitRate(vendor, tool),
      });
    }
    return {
      type: 'server-tools' as const,
      activities,
      usage: [...usage.values()].filter(({ count }) => count > 0),
    };
  }
}
