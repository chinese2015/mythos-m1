import { apply as nativeSearch, resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';
export { Config, inject } from '@deepseek-ai/dsh-tool-fs-search';
export const name = 'argon-container-search';
export async function apply(ctx, config) {
  const hostBinary = await resolveRgPath();
  const upstream = ctx.subprocess;
  // Native search resolves the host npm binary. SSH spawn needs the image's binary.
  // Keep the native argv construction, caps, no-config protection and result parser.
  const facade = { tools: ctx.tools, systemPrompt: ctx.systemPrompt, logger: ctx.logger,
    on: ctx.on.bind(ctx), get: ctx.get.bind(ctx), subprocess: { spawn(request) {
      if (request.argv[0] !== hostBinary) throw new Error('Unexpected native search executable');
      return upstream.spawn({ ...request, argv: ['/usr/bin/rg', ...request.argv.slice(1)] });
    } } };
  return nativeSearch(facade, config);
}
