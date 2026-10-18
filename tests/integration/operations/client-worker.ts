export default {
  fetch(request: Request, env: { OPERATIONS: Fetcher }) {
    return env.OPERATIONS.fetch(request);
  },
};
