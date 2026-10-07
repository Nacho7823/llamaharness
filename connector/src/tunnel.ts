import managementSdk from '@microsoft/dev-tunnels-management';
import connectionsSdk from '@microsoft/dev-tunnels-connections';
import contracts from '@microsoft/dev-tunnels-contracts';
import type { Tunnel, TunnelAccessControl } from '@microsoft/dev-tunnels-contracts';
import type { TunnelManagementClient } from '@microsoft/dev-tunnels-management';
import type { TunnelReference } from './state.js';
import { errorStatus } from './errors.js';

const { TunnelAccessScopes, TunnelAccessControlEntryType, TunnelEndpoint } = contracts;
const OPTIONS = { includePorts: true, tokenScopes: [TunnelAccessScopes.Host, TunnelAccessScopes.Connect] };

export function createManagement(getToken: () => Promise<string>) {
  return new managementSdk.TunnelManagementHttpClient(
    { name: 'llamaharness-connector', version: '0.1.0' },
    managementSdk.ManagementApiVersions.Version20230927preview,
    async () => `github ${await getToken()}`,
  );
}

export async function prepareTunnel(client: Pick<TunnelManagementClient, 'getTunnel' | 'createTunnel' | 'updateTunnel' | 'updateTunnelPort'>, reference: TunnelReference | undefined, port: number, save: (reference: TunnelReference) => Promise<void>, cancellation?: Parameters<TunnelManagementClient['getTunnel']>[2]): Promise<Tunnel> {
  let tunnel;
  if (reference) {
    try {
      tunnel = await client.getTunnel(reference, OPTIONS, cancellation);
    } catch (error) {
      if (errorStatus(error) === 404) tunnel = null;
      else throw error;
    }
    if (!tunnel) throw new Error('El túnel guardado ya no existe. Quitá solo tunnel de connector/data.json para crear otro.');
    if (tunnel.ports?.length !== 1 || tunnel.ports[0].portNumber !== port) {
      throw new Error('El túnel guardado debe tener únicamente el puerto configurado. Revisá config.json y el túnel.');
    }
    // Los visitantes solo reciben permiso de conexión; OAuth protege el MCP.
    // updateTunnel rechaza una lista de puertos, incluso si no cambió.
    // Los puertos se actualizan mediante updateTunnelPort.
    tunnel = await client.updateTunnel({ ...reference, accessControl: publicAccess() }, OPTIONS, cancellation);
    await client.updateTunnelPort(tunnel, { portNumber: port, protocol: 'http', accessControl: publicAccess() }, undefined, cancellation);
    tunnel = await client.getTunnel(reference, OPTIONS, cancellation);
  } else {
    tunnel = await client.createTunnel({
      description: 'llamaharness OAuth proxy',
      ports: [{ portNumber: port, protocol: 'http', accessControl: publicAccess() }],
      accessControl: publicAccess(),
    }, OPTIONS, cancellation);
  }
  if (!tunnel?.tunnelId || !tunnel.clusterId) throw new Error('Dev Tunnels no devolvió el identificador del túnel.');
  await save({ tunnelId: tunnel.tunnelId, clusterId: tunnel.clusterId });
  return tunnel;
}

function publicAccess(): TunnelAccessControl {
  return { entries: [{ type: TunnelAccessControlEntryType.Anonymous, subjects: [], scopes: [TunnelAccessScopes.Connect] }] };
}

export function publicOrigin(tunnel: Tunnel | null, port: number): string {
  if (!tunnel) throw new Error('El túnel no está disponible.');
  const urls = [
    ...(tunnel.ports?.find(p => p.portNumber === port)?.portForwardingUris || []),
    ...(tunnel.endpoints || []).map(endpoint => TunnelEndpoint.getPortUri(endpoint, port)).filter((uri): uri is string => typeof uri === 'string'),
  ];
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
  }
  throw new Error('El túnel no anunció una dirección HTTPS para el proxy.');
}

export function createHost(client: TunnelManagementClient) {
  return new connectionsSdk.TunnelRelayTunnelHost(client);
}

// El SDK utiliza CancellationToken de VS Code; adaptamos la señal de Node.
export function cancellationToken(signal: AbortSignal): NonNullable<Parameters<TunnelManagementClient['getTunnel']>[2]> {
  return {
    get isCancellationRequested() { return signal.aborted; },
    onCancellationRequested(listener: (event: unknown) => void, thisArg?: unknown) {
      const callback = () => listener.call(thisArg, undefined);
      signal.addEventListener('abort', callback, { once: true });
      if (signal.aborted) queueMicrotask(callback);
      return { dispose() { signal.removeEventListener('abort', callback); } };
    },
  };
}
