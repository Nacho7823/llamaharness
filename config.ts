export const SERVER_NAME = 'llamaharness';
export const SERVER_VERSION = '0.1.0';

export function log(msg: string): void {
  console.error(`[${SERVER_NAME}] ${msg}`);
}
