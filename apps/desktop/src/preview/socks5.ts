import { isLoopbackHost } from "@t3tools/shared/preview";
import { isPreviewLoopbackAliasHost } from "@t3tools/shared/previewLoopbackForward";
import * as NodeNet from "node:net";

export const SOCKS5_VERSION = 0x05;
export const SOCKS5_NO_AUTH = 0x00;
export const SOCKS5_CMD_CONNECT = 0x01;
export const SOCKS5_ATYP_IPV4 = 0x01;
export const SOCKS5_ATYP_DOMAIN = 0x03;
export const SOCKS5_ATYP_IPV6 = 0x04;

export const SOCKS5_REP = {
  succeeded: 0x00,
  generalFailure: 0x01,
  notAllowed: 0x02,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const;

export type Socks5ConnectTarget = {
  readonly host: string;
  readonly port: number;
  readonly leftover: Buffer;
};

export const socks5Reply = (reply: number): Buffer =>
  Buffer.from([SOCKS5_VERSION, reply, 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0]);

export const isSocks5LoopbackHost = (host: string): boolean => {
  if (isLoopbackHost(host) || isPreviewLoopbackAliasHost(host)) return true;
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("::ffff:")) {
    return isLoopbackHost(lower.slice("::ffff:".length));
  }
  return false;
};

export const formatSocks5Ipv6 = (address: Buffer): string => {
  const mapped =
    address.subarray(0, 10).equals(Buffer.alloc(10)) &&
    address[10] === 0xff &&
    address[11] === 0xff;
  if (mapped) {
    return `${String(address[12])}.${String(address[13])}.${String(address[14])}.${String(address[15])}`;
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(address.readUInt16BE(index).toString(16));
  }
  return groups.join(":");
};

export type Socks5GreetingParse =
  | { readonly kind: "incomplete" }
  | { readonly kind: "ok"; readonly bytesConsumed: number }
  | { readonly kind: "error" };

export const parseSocks5Greeting = (buffer: Buffer): Socks5GreetingParse => {
  if (buffer.length < 2) return { kind: "incomplete" };
  const methodCount = buffer[1] ?? 0;
  if (buffer[0] !== SOCKS5_VERSION) return { kind: "error" };
  if (buffer.length < 2 + methodCount) return { kind: "incomplete" };
  return { kind: "ok", bytesConsumed: 2 + methodCount };
};

export type Socks5RequestParse =
  | { readonly kind: "incomplete" }
  | {
      readonly kind: "connect";
      readonly host: string;
      readonly port: number;
      readonly bytesConsumed: number;
    }
  | { readonly kind: "error"; readonly reply: number };

export const parseSocks5ConnectRequest = (buffer: Buffer): Socks5RequestParse => {
  if (buffer.length < 4) return { kind: "incomplete" };
  if (buffer[0] !== SOCKS5_VERSION) {
    return { kind: "error", reply: SOCKS5_REP.generalFailure };
  }
  if (buffer[1] !== SOCKS5_CMD_CONNECT) {
    return { kind: "error", reply: SOCKS5_REP.commandNotSupported };
  }
  const addressType = buffer[3] ?? 0;
  if (addressType === SOCKS5_ATYP_IPV4) {
    if (buffer.length < 10) return { kind: "incomplete" };
    const host = `${String(buffer[4])}.${String(buffer[5])}.${String(buffer[6])}.${String(buffer[7])}`;
    return {
      kind: "connect",
      host,
      port: buffer.readUInt16BE(8),
      bytesConsumed: 10,
    };
  }
  if (addressType === SOCKS5_ATYP_DOMAIN) {
    if (buffer.length < 5) return { kind: "incomplete" };
    const length = buffer[4] ?? 0;
    if (buffer.length < 7 + length) return { kind: "incomplete" };
    return {
      kind: "connect",
      host: buffer.subarray(5, 5 + length).toString("utf8"),
      port: buffer.readUInt16BE(5 + length),
      bytesConsumed: 7 + length,
    };
  }
  if (addressType === SOCKS5_ATYP_IPV6) {
    if (buffer.length < 22) return { kind: "incomplete" };
    return {
      kind: "connect",
      host: formatSocks5Ipv6(buffer.subarray(4, 20)),
      port: buffer.readUInt16BE(20),
      bytesConsumed: 22,
    };
  }
  return { kind: "error", reply: SOCKS5_REP.addressTypeNotSupported };
};

const readUntil = <T extends { readonly kind: string }>(
  socket: NodeNet.Socket,
  buffer: { current: Buffer },
  parse: (input: Buffer) => T,
  isComplete: (result: T) => boolean,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const finish = (result: T) => {
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buffer.current = Buffer.concat([buffer.current, chunk]);
      const result = parse(buffer.current);
      if (isComplete(result)) finish(result);
    };
    const onError = (cause: Error) => {
      socket.off("data", onData);
      reject(cause);
    };
    const initial = parse(buffer.current);
    if (isComplete(initial)) {
      resolve(initial);
      return;
    }
    socket.on("data", onData);
    socket.once("error", onError);
  });

export const acceptSocks5Connect = async (
  socket: NodeNet.Socket,
  initial: Buffer = Buffer.alloc(0),
): Promise<Socks5ConnectTarget> => {
  const buffer = { current: initial };
  const greeting = await readUntil(
    socket,
    buffer,
    parseSocks5Greeting,
    (result) => result.kind !== "incomplete",
  );
  if (greeting.kind !== "ok") {
    socket.end();
    throw new Error("SOCKS5 greeting was not version 5.");
  }
  buffer.current = buffer.current.subarray(greeting.bytesConsumed);
  socket.write(Buffer.from([SOCKS5_VERSION, SOCKS5_NO_AUTH]));
  const request = await readUntil(
    socket,
    buffer,
    parseSocks5ConnectRequest,
    (result) => result.kind !== "incomplete",
  );
  if (request.kind !== "connect") {
    socket.end(socks5Reply(request.kind === "error" ? request.reply : SOCKS5_REP.generalFailure));
    throw new Error("SOCKS5 request was not a supported CONNECT.");
  }
  return {
    host: request.host,
    port: request.port,
    leftover: buffer.current.subarray(request.bytesConsumed),
  };
};
