import type { Plugin } from 'vite';

/** Follow static imports only: optional renderers and their fonts stay out of installation. */
export function startupCache() {
  // VitePWA adds the manifest and includeAssets separately after this filter.
  const assets = new Set(['index.html']);
  const plugin: Plugin = {
    name: 'everchat-startup-cache',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (this.environment.name !== 'client') return;
        const visit = (name: string) => {
          if (assets.has(name)) return;
          const chunk = bundle[name];
          if (chunk?.type !== 'chunk') return;
          assets.add(name);
          for (const css of chunk.viteMetadata?.importedCss ?? []) assets.add(css);
          for (const dependency of chunk.imports) visit(dependency);
        };
        for (const chunk of Object.values(bundle))
          if (
            chunk.type === 'chunk' &&
            (chunk.isEntry || chunk.facadeModuleId?.endsWith('/src/private-bootstrap.tsx'))
          )
            visit(chunk.fileName);
        if (![...assets].some((name) => name.endsWith('.js')))
          this.error('The startup precache must include the client entry script');
      },
    },
  };
  return { plugin, includes: (url: string) => assets.has(url) };
}
