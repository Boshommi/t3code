import { describe, expect, it } from "vite-plus/test";

import {
  formatSocks5Ipv6,
  isSocks5LoopbackHost,
  parseSocks5ConnectRequest,
  parseSocks5Greeting,
  SOCKS5_REP,
} from "./socks5.ts";

describe("socks5", () => {
  it("parses a no-auth greeting", () => {
    expect(parseSocks5Greeting(Buffer.from([0x05, 0x01, 0x00]))).toEqual({
      kind: "ok",
      bytesConsumed: 3,
    });
  });

  it("waits for the full greeting", () => {
    expect(parseSocks5Greeting(Buffer.from([0x05, 0x01]))).toEqual({ kind: "incomplete" });
  });

  it("parses IPv4, domain, and IPv6 CONNECT requests", () => {
    expect(
      parseSocks5ConnectRequest(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x0b, 0xb8])),
    ).toEqual({
      kind: "connect",
      host: "127.0.0.1",
      port: 3000,
      bytesConsumed: 10,
    });
    const domain = Buffer.from("localhost", "utf8");
    const domainRequest = Buffer.alloc(7 + domain.length);
    domainRequest[0] = 0x05;
    domainRequest[1] = 0x01;
    domainRequest[3] = 0x03;
    domainRequest[4] = domain.length;
    domain.copy(domainRequest, 5);
    domainRequest.writeUInt16BE(5173, 5 + domain.length);
    expect(parseSocks5ConnectRequest(domainRequest)).toEqual({
      kind: "connect",
      host: "localhost",
      port: 5173,
      bytesConsumed: 7 + domain.length,
    });
    const ipv6 = Buffer.alloc(22);
    ipv6[0] = 0x05;
    ipv6[1] = 0x01;
    ipv6[3] = 0x04;
    ipv6[19] = 0x01;
    ipv6.writeUInt16BE(80, 20);
    expect(parseSocks5ConnectRequest(ipv6)).toMatchObject({
      kind: "connect",
      host: "0:0:0:0:0:0:0:1",
      port: 80,
    });
  });

  it("rejects UDP associate", () => {
    expect(
      parseSocks5ConnectRequest(Buffer.from([0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, 0, 80])),
    ).toEqual({
      kind: "error",
      reply: SOCKS5_REP.commandNotSupported,
    });
  });

  it("treats IPv4-mapped and compressed loopback as loopback", () => {
    expect(isSocks5LoopbackHost("localhost")).toBe(true);
    expect(isSocks5LoopbackHost("127.0.0.1")).toBe(true);
    expect(isSocks5LoopbackHost("::1")).toBe(true);
    expect(isSocks5LoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isSocks5LoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isSocks5LoopbackHost("t3-loopback.localtest.me")).toBe(true);
    expect(isSocks5LoopbackHost("accounts.google.com")).toBe(false);
    const mapped = Buffer.alloc(16);
    mapped[10] = 0xff;
    mapped[11] = 0xff;
    mapped[12] = 127;
    mapped[15] = 1;
    expect(formatSocks5Ipv6(mapped)).toBe("127.0.0.1");
    expect(isSocks5LoopbackHost(formatSocks5Ipv6(mapped))).toBe(true);
  });
});
