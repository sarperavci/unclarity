import { describe, expect, it } from "vitest";
import { parseSocks, socksDispatcher } from "../src/index.js";

describe("SOCKS proxy", () => {
  it("parses socks5 url with auth", () => {
    const { proxy } = parseSocks("socks5://user:p%40ss@10.0.0.1:1080");
    expect(proxy.type).toBe(5);
    expect(proxy.host).toBe("10.0.0.1");
    expect(proxy.port).toBe(1080);
    expect(proxy.userId).toBe("user");
    expect(proxy.password).toBe("p@ss");
  });

  it("parses socks4 and defaults the port", () => {
    const { proxy } = parseSocks("socks4://10.0.0.2");
    expect(proxy.type).toBe(4);
    expect(proxy.port).toBe(1080);
    expect(proxy.userId).toBeUndefined();
  });

  it("builds a dispatcher without throwing", () => {
    const d = socksDispatcher("socks5://10.0.0.1:1080");
    expect(d).toBeTruthy();
    void d.close();
  });
});
