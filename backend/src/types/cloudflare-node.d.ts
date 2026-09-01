/**
 * `cloudflare:node` is provided by the Workers runtime, not by npm, so
 * TypeScript cannot find it when this project is compiled for Node. Only the
 * one function worker.ts uses is declared — wrangler resolves the real module
 * when it bundles, and the shape below is what it hands back.
 */
declare module 'cloudflare:node' {
  export function httpServerHandler(options: { port: number }): {
    fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
  };
}
