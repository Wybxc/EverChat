import type {
  RemoteMcpCatalog,
  RemoteMcpConnection,
  RemoteMcpConnectionInput,
  RemoteMcpSelection,
  RemoteMcpTool,
  ResolvedRemoteMcp,
  RemoteMcpCall,
} from '../../shared/tools/remote-mcp';
import { AppError, problem } from '../../shared/errors/descriptor';
import { listRemoteMcpTools } from './client';

type Saved = Omit<RemoteMcpConnection, 'hasToken'> & { token?: string };
const profiles = 'remote-mcp-connections-v1';
const catalogKey = (id: string) => `remote-mcp-catalog-v1:${id}`;
const publicConnection = ({ token, ...record }: Saved): RemoteMcpConnection => ({
  ...record,
  hasToken: Boolean(token),
});
const stale = () => new AppError(problem('TOOL_INVALID'), '远程 MCP 连接已变化，请重新选择工具。');

export class RemoteMcpStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private async connection(id: string) {
    return ((await this.storage.get<Saved[]>(profiles)) ?? []).find((profile) => profile.id === id);
  }

  async list() {
    return ((await this.storage.get<Saved[]>(profiles)) ?? []).map(publicConnection);
  }

  async save(id: string, input: RemoteMcpConnectionInput) {
    return this.storage.transaction(async (tx) => {
      const all = (await tx.get<Saved[]>(profiles)) ?? [];
      const previous = all.find((profile) => profile.id === id);
      if (!previous && all.length >= 12)
        throw new AppError(problem('TOOL_INVALID'), '最多可保存 12 个远程 MCP 连接。');
      const endpoint = new URL(input.endpoint).href;
      const token =
        input.token === undefined && previous?.endpoint === endpoint
          ? previous.token
          : (input.token ?? undefined);
      const revision =
        previous && endpoint === previous.endpoint && token === previous.token
          ? previous.revision
          : crypto.randomUUID();
      const entry = { id, endpoint, revision, name: input.name, ...(token ? { token } : {}) };
      await tx.put(profiles, [...all.filter((profile) => profile.id !== id), entry]);
      if (previous?.revision !== revision) await tx.delete(catalogKey(id));
      return publicConnection(entry);
    });
  }

  async remove(id: string) {
    await this.storage.transaction(async (tx) => {
      await tx.put(
        profiles,
        ((await tx.get<Saved[]>(profiles)) ?? []).filter((item) => item.id !== id),
      );
      await tx.delete(catalogKey(id));
    });
  }

  async catalog(id: string, refresh = false): Promise<RemoteMcpCatalog> {
    const connection = await this.connection(id);
    if (!connection) throw stale();
    const cached = await this.storage.get<{
      revision: string;
      savedAt: number;
      tools: RemoteMcpTool[];
    }>(catalogKey(id));
    if (
      !refresh &&
      cached &&
      cached.revision === connection.revision &&
      Date.now() - cached.savedAt < 600_000
    )
      return { connection: publicConnection(connection), tools: cached.tools };
    const tools = await listRemoteMcpTools(connection);
    return this.storage.transaction(async (tx) => {
      const current = ((await tx.get<Saved[]>(profiles)) ?? []).find(
        (profile) => profile.id === id,
      );
      if (current?.revision !== connection.revision) throw stale();
      await tx.put(catalogKey(id), { revision: connection.revision, savedAt: Date.now(), tools });
      return { connection: publicConnection(current), tools };
    });
  }

  async resolve(selections: RemoteMcpSelection[]): Promise<ResolvedRemoteMcp[]> {
    return Promise.all(
      selections.map(async (selection) => {
        const { connection, tools } = await this.catalog(selection.id);
        if (connection.revision !== selection.revision) throw stale();
        const selected = tools.filter(({ name }) => selection.tools.includes(name));
        if (selected.length !== selection.tools.length) throw stale();
        const { hasToken: _, ...identity } = connection;
        return {
          ...identity,
          tools: selected,
          ...(selection.executor ? { executor: selection.executor } : {}),
        };
      }),
    );
  }

  async credential(
    connection: ResolvedRemoteMcp,
    call: Pick<RemoteMcpCall, 'connection' | 'tool'>,
  ) {
    const saved = await this.connection(connection.id);
    if (
      saved?.revision !== connection.revision ||
      saved?.endpoint !== connection.endpoint ||
      connection.id !== call.connection ||
      !connection.tools.some(({ name }) => name === call.tool)
    )
      throw stale();
    return { endpoint: saved.endpoint, token: saved.token };
  }
}
