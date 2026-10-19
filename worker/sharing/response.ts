import type { PublicShare } from '../../shared/sharing/types';
import { json } from '../http/response';

/** One HTTP/RPC response, with backpressure instead of a full server-side JSON buffer. */
export function snapshotResponse(share: PublicShare, payloads: Generator<string>) {
  const encoder = new TextEncoder();
  let started = false,
    count = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (!started) {
            started = true;
            controller.enqueue(
              encoder.encode(`{"share":${JSON.stringify(share)},"page":{"blocks":[`),
            );
            return;
          }
          const next = payloads.next();
          if (next.done) {
            controller.enqueue(encoder.encode('],"cursor":null}}'));
            controller.close();
          } else controller.enqueue(encoder.encode(`${count++ ? ',' : ''}${next.value}`));
        } catch (error) {
          payloads.return(undefined);
          controller.error(error);
        }
      },
      cancel() {
        payloads.return(undefined);
      },
    }),
    { headers: json(null).headers },
  );
}
