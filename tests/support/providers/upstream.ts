import { env as runtimeEnv } from 'cloudflare:workers';
import { SUMMARY_SYSTEM_PROMPT } from '../../../shared/conversation/summaries';
import type { ProviderKind } from '../../../shared/providers/types';
import type { MeasurementEnv } from '../runtime/env';
import { providerStreams } from './streams';
import { toolFinalStream, toolStream } from './tool-streams';

export function installMockUpstream() {
  const upstreamFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'provider.test') return upstreamFetch(input, init);
    if (
      request.headers.get('Authorization') !== 'Bearer integration-test-key' &&
      request.headers.get('x-api-key') !== 'integration-test-key' &&
      request.headers.get('x-goog-api-key') !== 'integration-test-key'
    ) {
      return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
    }
    if (url.pathname === '/large/models')
      return Response.json({
        data: Array.from({ length: 350 }, (_, i) => ({ id: `catalog-${i}` })),
      });
    if (url.pathname === '/v1/models') {
      if (request.headers.has('x-api-key'))
        return Response.json({
          data: [
            {
              id: 'test-model',
              display_name: 'Discovered Claude',
              max_input_tokens: 200000,
              max_tokens: 64000,
              capabilities: {
                image_input: { supported: true },
                structured_outputs: { supported: false },
                thinking: { supported: true },
                effort: { supported: true, low: { supported: true }, high: { supported: true } },
              },
            },
            {
              id: 'test-model-2',
              display_name: 'Second Claude',
              max_input_tokens: 100000,
              max_tokens: 32000,
            },
          ],
        });
      if (request.headers.has('x-goog-api-key'))
        return Response.json({
          models: [
            {
              name: 'models/test-model',
              displayName: 'Discovered Gemini',
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              thinking: true,
              supportedGenerationMethods: ['generateContent'],
            },
            { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] },
          ],
        });
      return Response.json({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] });
    }
    if (
      !['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname) &&
      !url.pathname.includes(':streamGenerateContent')
    )
      return new Response('Not found', { status: 404 });
    const requestBody = (await request.clone().json()) as {
      model: string;
      thinking?: { type: string };
      reasoning_effort?: string;
      reasoning?: { effort?: string };
      tools?: {
        name?: string;
        function?: { name: string };
        functionDeclarations?: { name: string }[];
      }[];
    };
    const encoder = new TextEncoder();
    if (requestBody.model === 'usage-partial-cancel') {
      let cancelled = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '已报告部分用量' }, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`,
              ),
            );
          },
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (!cancelled)
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"index":0,"delta":{"content":"。"},"finish_reason":null}]}\n\n',
                ),
              );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const modelId = requestBody.model ?? /\/models\/([^/:]+):/.exec(url.pathname)?.[1];
    if (modelId === 'alarm-free-tier-large') {
      let step = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (step++ < 160) {
              controller.enqueue(encoder.encode(`: ${'keepalive '.repeat(3277)}\n\n`));
            } else {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思'.repeat(110_000), content: '答'.repeat(110_000) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (modelId?.startsWith('title-fixture-')) {
      const data = requestBody as typeof requestBody & {
        max_tokens?: number;
        max_completion_tokens?: number;
      };
      if (
        (data.max_tokens ?? data.max_completion_tokens) !== 128 ||
        !JSON.stringify(data).includes('只输出一行普通文本')
      )
        return Response.json(
          { error: { message: 'Missing title budget or instructions' } },
          { status: 400 },
        );
      if (modelId === 'title-fixture-error')
        return Response.json({ error: { message: 'Fixture title failure' } }, { status: 503 });
      const text = modelId === 'title-fixture-second' ? '第二个模型的标题' : '# “独立生成的标题”';
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                modelId === 'title-fixture-parallel'
                  ? 8000
                  : modelId === 'title-fixture-slow'
                    ? 4000
                    : 100,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (modelId === 'diagnostic-http')
      return Response.json(
        {
          error: {
            code: 'invalid_api_key',
            type: 'authentication_error',
            message: 'Invalid integration-test-key. request: {"messages":["private question"]}',
          },
          detail: 'Authentication failed at the upstream gateway',
          markup: '<script>window.providerBodyExecuted = true</script>',
        },
        {
          status: 401,
          headers: { 'x-request-id': 'req-diagnostic-http' },
        },
      );
    if (modelId === 'diagnostic-stream' || modelId === 'diagnostic-disconnect') {
      const protocol: ProviderKind = url.pathname.endsWith('/responses')
        ? 'openai-responses'
        : url.pathname.endsWith('/messages')
          ? 'anthropic'
          : url.pathname.includes(':streamGenerateContent')
            ? 'gemini'
            : 'openai-chat';
      if (modelId === 'diagnostic-disconnect') {
        let cancelled = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(providerStreams[protocol].partial));
            },
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              if (!cancelled) controller.error(new Error('Fixture supplier disconnected'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return new Response(
        providerStreams[protocol].partial +
          `data: ${JSON.stringify({
            type: 'error',
            error: {
              code: 'overloaded_error',
              message: 'Temporarily overloaded integration-test-key private question',
            },
          })}\n\n` +
          providerStreams[protocol].finish,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (modelId?.startsWith('probe-') && !(requestBody as { stream?: boolean }).stream) {
      const serialized = JSON.stringify(requestBody),
        challenge = /[A-F0-9]{6}/.exec(serialized)?.[0] ?? 'missing';
      if (modelId === 'probe-failed')
        return new Response('integration-test-key private diagnostics', { status: 401 });
      const tool = requestBody.tools?.[0]?.function?.name;
      const text =
        serialized.includes('data:image/png') || modelId === 'probe-mismatch'
          ? 'UNCONFIRMED'
          : challenge;
      return Response.json({
        id: 'probe',
        model: modelId,
        choices: [
          {
            finish_reason: tool ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: tool ? null : text,
              ...(tool
                ? {
                    tool_calls: [
                      {
                        id: 'probe-call',
                        type: 'function',
                        function: { name: tool, arguments: JSON.stringify({ challenge }) },
                      },
                    ],
                  }
                : {}),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    }
    const toolModel =
      /^tools-(?:(loop|multi|pause|service|flow)-)?(?:(large|sustained)-)?(openai-chat|openai-responses|anthropic|gemini)$/.exec(
        modelId ?? '',
      );
    const toolKind = toolModel?.[3] as ProviderKind | undefined;
    if (toolKind && providerStreams[toolKind]) {
      const serialized = JSON.stringify(requestBody),
        continued =
          serialized.includes('本地工具结果') ||
          /"role":"tool"|"type":"tool_result"|"type":"function_call_output"|"functionResponse":/.test(
            serialized,
          );
      const names =
        requestBody.tools?.flatMap(
          (tool) =>
            tool.functionDeclarations?.map((item) => item.name) ?? [
              tool.function?.name ?? tool.name,
            ],
        ) ?? [];
      if (!names.length && modelId?.startsWith('tools-service-'))
        return new Response(providerStreams[toolKind].partial + providerStreams[toolKind].finish, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      if (!names.some((name) => name === 'web_search' || name === 'read_webpage'))
        return Response.json({ error: 'Missing tools' }, { status: 400 });
      if (
        continued &&
        ((toolKind === 'anthropic' && !serialized.includes('fixture-signature')) ||
          (toolKind === 'openai-responses' && !serialized.includes('encrypted-fixture')) ||
          (toolKind === 'gemini' && !serialized.includes('fixture-signature')))
      )
        return Response.json({ error: 'Missing continuation metadata' }, { status: 400 });
      const loop = modelId?.startsWith('tools-loop-'),
        multi = modelId?.startsWith('tools-multi-'),
        flow = modelId?.startsWith('tools-flow-');
      const round = flow
        ? Math.max(
            -1,
            ...[...serialized.matchAll(/call_flow_(\d+)_/g)].map((match) => Number(match[1])),
          ) + 1
        : loop || multi
          ? Math.max(
              -1,
              ...[...serialized.matchAll(/call_(\d+)_/g)].map((match) => Number(match[1])),
            ) + 1
          : 0;
      // The mock workload is independent of diagnostic counters so a later CPU
      // validation can use the same input with all instrumentation switched off.
      const encodedWorkload = (runtimeEnv as MeasurementEnv).LOCAL_TOOL_WORKLOAD;
      const workload =
        toolModel?.[2] === 'large'
          ? { chunks: 120, size: 750, interval: 25 }
          : toolModel?.[2] === 'sustained'
            ? { chunks: 120, size: 200, interval: 500 }
            : encodedWorkload
              ? (JSON.parse(encodedWorkload) as { chunks: number; size: number; interval: number })
              : undefined;
      let wire =
        continued && !loop && (!flow || round >= 2) && (!multi || round >= 5)
          ? toolFinalStream(toolKind, workload, flow ? '**整合结果🙂**\n\n继续分析。' : undefined)
          : toolStream(toolKind, {
              count: 2,
              ...(flow
                ? {
                    reasoning:
                      round === 0
                        ? '**搜索之前🙂**\n第一行\n第二行。'
                        : '**搜索之后🙂**\n\n核对网页。',
                    calls: [
                      {
                        name: round === 0 ? 'web_search' : 'read_webpage',
                        input:
                          round === 0
                            ? JSON.stringify({ query: 'Cloudflare 文档🙂' })
                            : JSON.stringify({ url: 'https://developers.cloudflare.com/' }),
                      },
                    ],
                  }
                : {}),
              ...(modelId?.startsWith('tools-service-')
                ? {
                    calls: [
                      { name: 'web_search', input: JSON.stringify({ query: 'Cloudflare 文档🙂' }) },
                      {
                        name: 'read_webpage',
                        input: JSON.stringify({ url: 'https://developers.cloudflare.com/' }),
                      },
                    ].filter((call) => names.includes(call.name)),
                  }
                : {}),
            })
              .replaceAll('call_0', flow ? `call_flow_${round}_0` : `call_${round}_0`)
              .replaceAll('call_1', flow ? `call_flow_${round}_1` : `call_${round}_1`);
      if (!continued && toolKind === 'openai-chat')
        wire = wire.replace(
          '"reasoning_content":"检索资料🙂"',
          '"reasoning_content":"检索资料🙂","content":"先查阅资料。\\n"',
        );
      if (workload) {
        const frames = wire.match(/[^]*?\n\n/g) ?? [];
        let index = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, workload.interval));
              request.signal.throwIfAborted();
              if (index < frames.length) controller.enqueue(encoder.encode(frames[index++]));
              else controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                sent ? (requestBody.model?.startsWith('tools-pause-') ? 5000 : 1800) : 250,
              ),
            );
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode(wire));
            } else controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (requestBody.model?.startsWith('benchmark-summary-')) {
      const serialized = JSON.stringify(requestBody);
      if (!serialized.includes(SUMMARY_SYSTEM_PROMPT))
        return Response.json(
          { error: { message: 'Summary instructions missing' } },
          { status: 400 },
        );
      const kind = requestBody.model.slice('benchmark-summary-'.length);
      const text =
        kind === 'empty'
          ? ''
          : `# 历史摘要\n\n${serialized.includes('__SUMMARY_FACT_42__') ? '- 预算 **42 元**，标识 __SUMMARY_FACT_42__。\n' : '- 没有旧预算资料。\n'}- 保留原始约束，继续处理后续问题。`;
      const chunks = text.match(/.{1,12}/gs) ?? [];
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, kind === 'slow' ? 400 : 180));
            const done = index >= chunks.length;
            const chunk = {
              id: 'summary',
              choices: [
                {
                  index: 0,
                  delta: done ? {} : { content: chunks[index++] },
                  finish_reason:
                    done && kind !== 'error' ? (kind === 'length' ? 'length' : 'stop') : null,
                },
              ],
              ...(done
                ? { usage: { prompt_tokens: 55, completion_tokens: 19, total_tokens: 74 } }
                : {}),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            if (done) {
              if (kind !== 'error') controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (requestBody.model === 'benchmark-answer-fact') {
      const text = JSON.stringify(requestBody).includes('__SUMMARY_FACT_42__')
        ? '记得预算 42 元。'
        : '未收到旧预算。';
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const documentKind = requestBody.model?.startsWith('documents-')
      ? (requestBody.model.slice(10) as ProviderKind)
      : url.pathname.includes('/models/documents-gemini:')
        ? 'gemini'
        : undefined;
    const visionKind =
      documentKind ??
      (requestBody.model?.startsWith('vision-')
        ? (requestBody.model.slice(7) as ProviderKind)
        : url.pathname.includes('/models/vision-gemini:')
          ? 'gemini'
          : undefined);
    if (visionKind && providerStreams[visionKind]) {
      const body = requestBody as unknown as {
        messages?: {
          content: {
            type: string;
            image_url?: { url: string };
            source?: { type: string; media_type: string; data: string };
          }[];
        }[];
        input?: { content: { type: string; image_url?: string }[] }[];
        contents?: { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
      };
      const encoded =
        visionKind === 'openai-chat'
          ? body.messages?.flatMap((message) =>
              Array.isArray(message.content)
                ? message.content
                    .filter((part) => part.type === 'image_url')
                    .map((part) => part.image_url?.url)
                : [],
            )
          : visionKind === 'openai-responses'
            ? body.input?.flatMap((message) =>
                Array.isArray(message.content)
                  ? message.content
                      .filter((part) => part.type === 'input_image')
                      .map((part) => part.image_url)
                  : [],
              )
            : visionKind === 'anthropic'
              ? body.messages?.flatMap((message) =>
                  Array.isArray(message.content)
                    ? message.content
                        .filter((part) => part.type === 'image')
                        .map((part) =>
                          part.source?.type === 'base64'
                            ? `data:${part.source.media_type};base64,${part.source.data}`
                            : undefined,
                        )
                    : [],
                )
              : body.contents?.flatMap((message) =>
                  message.parts
                    .filter((part) => part.inlineData)
                    .map(
                      (part) => `data:${part.inlineData!.mimeType};base64,${part.inlineData!.data}`,
                    ),
                );
      const expected = Number(
        /expect-images:(\d+)/.exec(JSON.stringify(body))?.[1] ?? (documentKind ? 0 : 1),
      );
      if (documentKind) {
        const bodyText = JSON.stringify(body);
        const expectedFiles = Number(/expect-files:(\d+)/.exec(bodyText)?.[1] ?? 1);
        const actualFiles = (bodyText.match(/以下是用户附带的文件资料/g) ?? []).length;
        if (actualFiles !== expectedFiles || bodyText.includes('/api/conversations/'))
          return Response.json(
            { error: { message: 'Missing native private document text' } },
            { status: 400 },
          );
      }
      if (
        encoded?.length !== expected ||
        encoded.some(
          (data) => !data || !/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(data),
        )
      )
        return Response.json(
          { error: { message: 'Missing native private image bytes' } },
          { status: 400 },
        );
      const { partial, finish } = providerStreams[visionKind];
      let step = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, step ? 1600 : 300));
            controller.enqueue(encoder.encode(step++ ? finish : partial));
            if (step === 2) controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const rawKind = requestBody.model?.startsWith('raw-')
      ? (requestBody.model.slice(4) as ProviderKind)
      : url.pathname.includes('/models/raw-gemini:')
        ? 'gemini'
        : undefined;
    if (rawKind && providerStreams[rawKind]) {
      const { partial, finish } = providerStreams[rawKind];
      const bytes = encoder.encode(partial + finish);
      // Split a supplementary Unicode character and hold the incomplete frame through a commit.
      const marker = encoder.encode(partial).indexOf(0xf0) + 2;
      let step = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const current = step++;
            if (current === 0) controller.enqueue(bytes.slice(0, marker));
            else if (current === 1) {
              await new Promise((resolve) => setTimeout(resolve, 1900));
              controller.enqueue(bytes.slice(marker, encoder.encode(partial).length));
            } else {
              await new Promise((resolve) => setTimeout(resolve, 1900));
              controller.enqueue(bytes.slice(encoder.encode(partial).length));
              controller.close();
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }

    if (requestBody.model?.startsWith('metadata-')) {
      const noOutput = requestBody.model === 'metadata-no-output',
        noUsage = requestBody.model === 'metadata-no-usage';
      const events = [
        { delay: 80, value: { choices: [{ delta: { role: 'assistant', content: '' } }] } },
        ...(!noOutput
          ? [
              { delay: 200, value: { choices: [{ delta: { reasoning_content: '思考先到' } }] } },
              { delay: 1500, value: { choices: [{ delta: { content: '正文后到' } }] } },
            ]
          : []),
        {
          delay: 100,
          value: {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            ...(!noUsage
              ? {
                  usage: {
                    prompt_tokens: noOutput ? 0 : 10,
                    completion_tokens: noOutput ? 0 : 5,
                    total_tokens: noOutput ? 0 : 15,
                    prompt_cache_hit_tokens: noOutput ? 0 : 4,
                    completion_tokens_details: { reasoning_tokens: noOutput ? 0 : 2 },
                  },
                }
              : {}),
          },
        },
      ];
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { delay, value } = events[index++];
            await new Promise((resolve) => setTimeout(resolve, delay));
            controller.enqueue(encoder.encode(`: heartbeat\n\ndata: ${JSON.stringify(value)}\n\n`));
            if (index === events.length) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }

    if (requestBody.model === 'alarm-stall' || requestBody.model === 'alarm-stall-cr') {
      let stop: (() => void) | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stop = () => controller.error(new Error('Upstream aborted'));
            if (request.signal.aborted) {
              stop();
              return;
            }
            request.signal.addEventListener('abort', stop, { once: true });
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'idle',
                  choices: [
                    {
                      index: 0,
                      delta: { content: '等待上游的正文', reasoning_content: '等待上游的思考' },
                      finish_reason: null,
                    },
                  ],
                })}${requestBody.model === 'alarm-stall-cr' ? '\r\r' : '\n\n'}`,
              ),
            );
          },
          cancel() {
            if (stop) request.signal.removeEventListener('abort', stop);
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (requestBody.model === 'benchmark-math') {
      const content = [
        '行内：$',
        'x^',
        '2',
        '$。',
        '\n\n块级：\n\n\\',
        '[\n\\frac{',
        '1}{',
        '2}',
        '\n\\',
        ']\n\n',
        ...Array<string>(8).fill('继续输出。'),
      ];
      const reasoning = ['思考：\\', '(', '\\alpha', ' + \\beta', '\\', ')。'];
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            const done = index >= content.length;
            const delta = done
              ? {}
              : {
                  content: content[index],
                  ...(reasoning[index] ? { reasoning_content: reasoning[index] } : {}),
                };
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: done ? 'stop' : null }] })}\n\n`,
              ),
            );
            index++;
            if (done) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const benchmark = /^benchmark-(text|reasoning|long|error)-(\d+)-(\d+)-(\d+)$/.exec(
      requestBody.model,
    );
    if (benchmark) {
      const [, kind, count, delay, size] = benchmark;
      const chunks = Math.min(Number(count), 1000);
      const interval = Math.min(Number(delay), 500);
      const characters = Math.min(Number(size), Math.floor(90_000 / Math.max(1, chunks)));
      let index = 0;
      const text = '正文🙂'.repeat(Math.ceil(characters / 4)).slice(0, characters);
      const reasoning = '思考🙂'.repeat(Math.ceil(characters / 4)).slice(0, characters);
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, interval));
            const done = index++ >= chunks;
            const chunk = {
              id: 'benchmark',
              choices: [
                {
                  index: 0,
                  delta: done
                    ? {}
                    : {
                        content: text,
                        ...(kind === 'reasoning' || kind === 'error'
                          ? { reasoning_content: reasoning }
                          : {}),
                      },
                  finish_reason: done && kind !== 'error' ? 'stop' : null,
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            if (done) {
              if (kind !== 'error') controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    if (url.pathname === '/v1/responses') {
      const events = [
        ...(requestBody.reasoning?.effort !== 'none'
          ? [
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'reasoning', id: 'thought', summary: [], content: [] },
              },
              {
                type: 'response.content_part.added',
                item_id: 'thought',
                output_index: 0,
                content_index: 0,
                part: { type: 'reasoning_text', text: '' },
              },
              {
                type: 'response.reasoning_text.delta',
                item_id: 'thought',
                output_index: 0,
                content_index: 0,
                delta: '**集成',
              },
              {
                type: 'response.reasoning_text.delta',
                item_id: 'thought',
                output_index: 0,
                content_index: 0,
                delta: '思考。**',
              },
              {
                type: 'response.reasoning_text.done',
                item_id: 'thought',
                output_index: 0,
                content_index: 0,
                text: '**集成思考。**',
              },
              {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  type: 'reasoning',
                  id: 'thought',
                  summary: [],
                  content: [{ type: 'reasoning_text', text: '**集成思考。**' }],
                },
              },
            ]
          : []),
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'answer', content: [] },
        },
        ...[
          '**集成测试回答。**\n\n',
          ...Array<string>(8).fill('持续输出，'),
          '服务端生成完成。',
        ].map((delta) => ({
          type: 'response.output_text.delta',
          item_id: 'answer',
          output_index: 1,
          content_index: 0,
          delta,
        })),
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'message', id: 'answer', content: [] },
        },
        { type: 'response.completed', response: { incomplete_details: null } },
      ];
      let eventIndex = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[eventIndex++])}\n\n`));
            if (eventIndex === events.length) controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const scrollTest = ['scroll-test', 'scroll-test-error'].includes(requestBody.model);
    const tokens = scrollTest
      ? Array.from({ length: 60 }, (_, i) => `段落 ${i + 1}：持续生成的内容。\n\n`)
      : ['**集成测试回答。**\n\n', ...Array<string>(28).fill('持续输出，'), '服务端生成完成。'];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const content = tokens[index++];
        if (!content && requestBody.model === 'scroll-test-error') {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'error',
                error: { code: 'overloaded_error', message: 'Fixture failed after streaming' },
              })}\n\n`,
            ),
          );
          controller.close();
          return;
        }
        const delta = content
          ? {
              ...(scrollTest
                ? { reasoning_content: `思考 ${index}：持续生成的思考内容。\n\n` }
                : index === 1 &&
                    (requestBody.model.startsWith('alarm-') ||
                      requestBody.thinking?.type === 'enabled' ||
                      requestBody.reasoning_effort)
                  ? { reasoning_content: '**集成思考。**' }
                  : {}),
              content: `${index === 1 && requestBody.model === 'test-model-2' ? '第二模型：\n\n' : ''}${content}`,
            }
          : {};
        const chunk = {
          id: 'integration',
          choices: [{ index: 0, delta, finish_reason: content ? null : 'stop' }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (!content) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };
}
