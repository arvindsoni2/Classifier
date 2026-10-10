/**
 * `organiser review`: starts the authenticated loopback review server.
 * The same application service backs every verb; no bypass is possible.
 */
import type { CliOptions } from './main.js';
import type { Organiser } from '../application/organiser.js';
import { buildServer as createServer, type OrganiserServer } from '../http/server.js';

export async function serveReview(
  options: CliOptions,
  organiserFor: (options: CliOptions) => Organiser,
  port = Number.parseInt(options.env.ORGANISER_PORT ?? '4317', 10),
): Promise<OrganiserServer> {
  const organiser = organiserFor(options);
  const server: OrganiserServer = createServer(organiser, { port, host: '127.0.0.1' });
  await server.listen();
  const address = server.addresses()[0];
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  // The one-time token is printed to the terminal for the login form only.
  console.error(`review server listening on http://127.0.0.1:${bound}`);
  console.error('enter this one-time token in the login form (never in a URL):');
  console.error(server.bootstrapToken);
  return server;
}
