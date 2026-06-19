import type { DOMWindow } from "jsdom";
import { request, type Dispatcher } from "undici";
import { force } from "./util.js";

export interface UploadRecord {
  via: "xhr" | "beacon";
  status: number;
  bytes: number;
  ms: number;
  gzip: boolean;
  error?: string;
}

export interface TransportOptions {
  headers: Record<string, string>;
  // Optional undici dispatcher for proxy egress (ProxyAgent for http(s); socks via a custom Agent).
  dispatcher?: Dispatcher;
}

// Replaces XMLHttpRequest + navigator.sendBeacon with undici-backed implementations, faithful to
// data/upload.ts (XHR for non-final, sendBeacon for final). Forwards clarity's own headers, adds the
// device-profile identity headers + per-session cookie, and serializes uploads in arrival order.
export function installTransport(window: DOMWindow, opts: TransportOptions): { log: UploadRecord[]; settled: () => Promise<void> } {
  const log: UploadRecord[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const p = chain.then(fn, fn);
    chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p as Promise<void>;
  };

  const cookie = (): string => {
    try {
      return window.document.cookie || "";
    } catch {
      return "";
    }
  };
  const baseHeaders = (extra: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { ...opts.headers, ...extra };
    const c = cookie();
    if (c) h.cookie = c;
    return h;
  };

  class UnclarityXHR {
    readyState = 0;
    status = 0;
    responseText = "";
    withCredentials = false;
    timeout = 0;
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    ontimeout: (() => void) | null = null;
    private method = "POST";
    private url = "";
    private hdr: Record<string, string> = {};

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }
    setRequestHeader(k: string, v: string): void {
      this.hdr[k.toLowerCase()] = v;
    }
    send(body: string | Uint8Array): void {
      enqueue(async () => {
        const headers = baseHeaders(this.hdr);
        if (typeof body === "string" && !headers["content-type"]) headers["content-type"] = "text/plain;charset=UTF-8";
        const t0 = performance.now();
        try {
          const res = await request(this.url, {
            method: this.method as Dispatcher.HttpMethod,
            headers,
            body,
            ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
            headersTimeout: 15000,
            bodyTimeout: 15000,
          });
          this.status = res.statusCode;
          this.responseText = await res.body.text();
          this.readyState = 4;
          log.push({ via: "xhr", status: res.statusCode, bytes: typeof body === "string" ? body.length : body.byteLength, ms: Math.round(performance.now() - t0), gzip: typeof body !== "string" });
        } catch (err) {
          this.status = 0;
          this.readyState = 4;
          log.push({ via: "xhr", status: 0, bytes: 0, ms: Math.round(performance.now() - t0), gzip: false, error: err instanceof Error ? err.message : String(err) });
        }
        this.onreadystatechange?.();
        this.onload?.();
      });
    }
  }

  force(window, "XMLHttpRequest", UnclarityXHR);

  force(window.navigator, "sendBeacon", (url: string, payload: string): boolean => {
    enqueue(async () => {
      const headers = baseHeaders({ "content-type": "text/plain;charset=UTF-8" });
      const t0 = performance.now();
      try {
        const res = await request(url, { method: "POST", headers, body: payload, ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}) });
        await res.body.text();
        log.push({ via: "beacon", status: res.statusCode, bytes: payload.length, ms: Math.round(performance.now() - t0), gzip: false });
      } catch (err) {
        log.push({ via: "beacon", status: 0, bytes: payload.length, ms: Math.round(performance.now() - t0), gzip: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  });

  return { log, settled: () => chain.then(() => undefined) };
}
