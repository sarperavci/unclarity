import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { Agent } from "undici";
import { SocksClient, type SocksProxy } from "socks";

export interface ParsedSocks {
  proxy: SocksProxy;
}

// Parse a socks4:// or socks5:// URL into a socks proxy config.
export function parseSocks(url: string): ParsedSocks {
  const u = new URL(url);
  const type = u.protocol.startsWith("socks4") ? 4 : 5;
  const proxy: SocksProxy = {
    host: u.hostname,
    port: Number(u.port) || 1080,
    type,
    ...(u.username ? { userId: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
  };
  return { proxy };
}

// An undici Dispatcher that tunnels every request through a SOCKS4/5 proxy (undici has no native
// SOCKS support). Establishes the SOCKS connection, then upgrades to TLS for https targets.
export function socksDispatcher(url: string): Agent {
  const { proxy } = parseSocks(url);
  return new Agent({
    connect: (opts, callback) => {
      const host = (opts.hostname || opts.host || "").replace(/^\[|\]$/g, "");
      const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
      SocksClient.createConnection({ proxy, command: "connect", destination: { host, port } })
        .then(({ socket }) => {
          if (opts.protocol === "https:") {
            const tlsSock: TLSSocket = tlsConnect({
              socket: socket as Socket,
              servername: opts.servername || host,
            });
            tlsSock.once("secureConnect", () => callback(null, tlsSock));
            tlsSock.once("error", (err) => callback(err, null));
          } else {
            callback(null, socket as Socket);
          }
        })
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null));
    },
  });
}
