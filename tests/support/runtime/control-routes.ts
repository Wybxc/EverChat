import { authenticateAccess, type Authenticator } from '../../../worker/http/auth';
import { createWorker } from '../../../worker/http/worker';
import type { Env } from '../../../worker/http/env';
import { toolWorkflowId } from '../../../worker/web-tools/workflow';
import type { Conversation } from './conversation';
import type { MeasurementEnv } from './env';
import type { ActivityControl, AttachmentControl, Library } from './library';
import { type ToolJournalControl } from './tool-task-journal';

export function createTestWorker(
  authenticate: Authenticator = authenticateAccess,
  localLogin?: string,
) {
  const production = createWorker(authenticate, localLogin);
  const authenticated = async (request: Request, env: Env) => {
    try {
      await authenticate(request, env);
      return true;
    } catch {
      return false;
    }
  };
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const url = new URL(request.url);
      const measurement = /^\/api\/__test\/resources\/(library|[0-9a-f-]{36})$/.exec(url.pathname);
      if (measurement) {
        if ((env as MeasurementEnv).LOCAL_RESOURCE_METRICS !== '1')
          return new Response('Not found', { status: 404 });
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'X-EverChat-Measurement-Run': (env as MeasurementEnv).LOCAL_MEASUREMENT_RUN ?? '',
            },
          });
        const input = (await request.json()) as { windowId?: string; taskId?: string };
        if (input.windowId !== undefined && !/^[0-9a-f-]{36}$/.test(input.windowId))
          return new Response('Invalid window', { status: 400 });
        if (input.taskId !== undefined && !/^[0-9a-f-]{36}$/.test(input.taskId))
          return new Response('Invalid task', { status: 400 });
        const object =
          measurement[1] === 'library'
            ? (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName('personal')
            : (env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>).getByName(
                measurement[1],
              );
        const report = await object.fixtureResourceControl(input.windowId);
        const workflow =
          input.taskId && measurement[1] !== 'library'
            ? await env.WEB_TOOLS.get(toolWorkflowId(measurement[1], input.taskId))
                .then((instance) => instance.status())
                .catch(() => null)
            : null;
        return Response.json({ ...report, workflow }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/__test/library/web-tools/reset') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        try {
          await (env.LIBRARY as unknown as DurableObjectNamespace<Library>)
            .getByName('personal')
            .fixtureResetWebTools();
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes('Intentional Library reset during web tools')
          )
            return Response.json({ restarted: true }, { status: 503 });
          throw error;
        }
      }
      if (url.pathname === '/api/__test/library/attachments') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        const input = (await request.json()) as AttachmentControl;
        try {
          return Response.json(
            await (env.LIBRARY as unknown as DurableObjectNamespace<Library>)
              .getByName('personal')
              .fixtureAttachments(input),
          );
        } catch (error) {
          if (
            typeof input.noBucket === 'boolean' &&
            error instanceof Error &&
            error.message.includes('Intentional Library restart with changed R2 binding')
          ) {
            return Response.json({ restarted: true }, { status: 503 });
          }
          throw error;
        }
      }
      if (url.pathname === '/api/__test/library/activity') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        return Response.json(
          await (env.LIBRARY as unknown as DurableObjectNamespace<Library>)
            .getByName('personal')
            .fixtureActivity((await request.json()) as ActivityControl),
        );
      }
      if (url.pathname === '/api/__test/library/capacity') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        const { seed } = (await request.json()) as { seed: boolean };
        return Response.json(
          await (env.LIBRARY as unknown as DurableObjectNamespace<Library>)
            .getByName('personal')
            .fixtureCapacity(seed),
        );
      }
      if (url.pathname === '/api/__test/library/deletion-history') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        const { count } = (await request.json()) as { count: number };
        await (env.LIBRARY as unknown as DurableObjectNamespace<Library>)
          .getByName('personal')
          .fixtureDeletionHistory(count);
        return Response.json({ ok: true });
      }
      if (url.pathname === '/api/__test/library/deletion') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        const { id, begin } = (await request.json()) as { id: string; begin?: boolean };
        const library = (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName(
          'personal',
        );
        if (begin) return Response.json(await library.beginDelete(id));
        return Response.json({
          deletedAt: await library.deletedAt(id),
          calls: await library.fixtureSupplierCalls(id),
        });
      }
      if (url.pathname === '/api/__test/library/search') {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        if (!(await authenticated(request, env)))
          return new Response('Unauthorized', { status: 401 });
        const { id, fail, rebuild } = (await request.json()) as {
          id?: string;
          fail?: boolean;
          rebuild?: boolean;
        };
        return Response.json(
          await (env.LIBRARY as unknown as DurableObjectNamespace<Library>)
            .getByName('personal')
            .fixtureSearchControl(id, fail, rebuild),
        );
      }
      const match =
        /^\/api\/__test\/conversations\/([0-9a-f-]{36})\/(state|context|parent|alarm|abort|abort-stop|history|search-history|indexed-history|search-state|search-reset|search-retry|fill|resources|storage-error|delete-failure|delete-reset|deletion-state|late-submit|tool-journal|tool-runtime|activity)$/.exec(
          url.pathname,
        );
      if (!match) return production.fetch(request, env, ctx);
      if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin)
        return new Response('Forbidden', { status: 403 });
      if (!(await authenticated(request, env)))
        return new Response('Unauthorized', { status: 401 });
      const conversation = (
        env.CONVERSATIONS as unknown as DurableObjectNamespace<Conversation>
      ).getByName(match[1]);
      if (match[2] === 'tool-journal') {
        const input = (await request.json()) as ToolJournalControl;
        try {
          return Response.json(await conversation.fixtureToolJournal(input));
        } catch (error) {
          if (
            input.action === 'reset' &&
            error instanceof Error &&
            error.message.includes('Intentional tool journal reset')
          )
            return Response.json({ reset: true }, { status: 503 });
          return Response.json(
            { error: error instanceof Error ? error.message : 'Tool journal fixture failed' },
            { status: 400 },
          );
        }
      }
      const { runId, pairs, target, count, messageId, parentId, taskId, fault, expire } =
        (await request.json()) as {
          runId: string;
          pairs: number;
          target: number;
          count: number;
          messageId: string;
          parentId: string;
          taskId: string;
          fault?: string;
          expire?: boolean;
        };
      switch (match[2]) {
        case 'activity':
          return Response.json(await conversation.fixtureActivity(Boolean(expire)));
        case 'tool-runtime':
          return Response.json(await conversation.fixtureToolRuntime(taskId, fault, expire));
        case 'search-history':
          return Response.json(await conversation.fixtureSearchHistory());
        case 'indexed-history':
          await conversation.fixtureIndexedHistory(count);
          break;
        case 'search-state':
          return Response.json(await conversation.fixtureSearchState(false));
        case 'search-retry':
          await conversation.fixtureRetrySearch();
          break;
        case 'search-reset':
          try {
            await conversation.fixtureSearchState(true);
          } catch {
            return Response.json({ reset: true }, { status: 503 });
          }
          break;
        case 'late-submit': {
          const result = await conversation.submit(
            match[1],
            { requestId: runId, content: '迟到的 RPC' },
            await env.LIBRARY.getByName('personal').providerConfig(),
          );
          return Response.json(result, { status: 'error' in result ? result.status : 202 });
        }
        case 'delete-failure':
          await conversation.fixtureDeleteFailure(false);
          break;
        case 'delete-reset':
          await conversation.fixtureDeleteFailure(true);
          break;
        case 'deletion-state':
          return Response.json(await conversation.fixtureDeletionState());
        case 'fill':
          return Response.json(await conversation.fixtureFillDatabase(target));
        case 'resources':
          return Response.json(await conversation.fixtureResources());
        case 'storage-error':
          await conversation.fixtureStorageError();
          break;
        case 'history':
          return Response.json(await conversation.fixtureHistory(pairs));
        case 'state':
          return Response.json(await conversation.fixtureState(runId));
        case 'context':
          return Response.json(await conversation.fixtureContext(runId));
        case 'parent':
          await conversation.fixtureParent(messageId, parentId);
          break;
        case 'alarm':
          await conversation.fixtureReenterAlarm();
          break;
        case 'abort':
        case 'abort-stop':
          try {
            await conversation.fixtureAbort(runId, match[2] === 'abort-stop');
          } catch {
            return Response.json({ reset: true }, { status: 503 });
          }
          break;
      }
      return Response.json({ ok: true });
    },
  } satisfies ExportedHandler<Env>;
}
