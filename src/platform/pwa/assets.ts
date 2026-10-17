/** Vite's immutable, hashed application resources; never user or API data. */
export function isBundledAsset(url: URL, origin: string) {
  return (
    url.origin === origin &&
    /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|mjs|css|woff2?|ttf|pfb|bcmap|wasm)$/.test(url.pathname) &&
    !url.search
  );
}
