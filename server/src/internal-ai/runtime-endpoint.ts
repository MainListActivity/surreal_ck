/** 运行时观测与供应商价目认证是两件事。HTTP 仅对本机网关披露，不放宽 tariffFor。 */
export function runtimeEndpoint(value: string | undefined): { endpoint: string; host: string; port: string; path: string; protocol: string; source: 'runtime-config' } | null {
  try {
    const url = new URL(value ?? '');
    if (url.username || url.password || url.search || url.hash) return null;
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return { endpoint: url.href.replace(/\/$/, ''), host: url.hostname, port: url.port, path: url.pathname, protocol: url.protocol.slice(0, -1), source: 'runtime-config' };
  } catch { return null; }
}
