import { isLoopbackHost } from "@t3tools/shared/preview";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

export type HttpHead = {
  readonly header: string;
  readonly rest: Buffer;
};

export type PreviewProxyDestination = {
  readonly host: string;
  readonly port: number;
};

const HOP_BY_HOP_HEADER =
  /^(proxy-connection|proxy-authorization|te|trailer|transfer-encoding|upgrade|keep-alive)$/iu;

export const readHeaderValue = (header: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\r\\n)${name}\\s*:\\s*([^\\r\\n]+)`, "iu").exec(header);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};

export const contentLengthOf = (header: string): number => {
  const raw = readHeaderValue(header, "content-length");
  if (raw === undefined) return 0;
  const length = Number.parseInt(raw, 10);
  return Number.isInteger(length) && length > 0 ? length : 0;
};

export const headerIndicatesClose = (header: string): boolean =>
  /(?:^|\r\n)connection\s*:\s*close(?:\r\n|$)/iu.test(header);

export const isHttpConnect = (firstLine: string): boolean =>
  firstLine.toUpperCase().startsWith("CONNECT ");

export const isTlsHandshake = (buffer: Buffer): boolean => buffer.length > 0 && buffer[0] === 0x16;

export const parsePreviewProxyDestination = (
  firstLine: string,
  hostHeader?: string,
): PreviewProxyDestination | null => {
  const connect = /^CONNECT\s+(\S+)\s+HTTP\//iu.exec(firstLine);
  if (connect?.[1] !== undefined) {
    return parseHostPort(connect[1]);
  }
  const absolute = /^[A-Z]+\s+(https?:\/\/\S+)\s+HTTP\//iu.exec(firstLine);
  if (absolute?.[1] !== undefined) {
    try {
      const url = new URL(absolute[1]);
      const port =
        url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
      return { host: url.hostname, port };
    } catch {
      return null;
    }
  }
  const originForm = /^[A-Z]+\s+(\/[^ ]*)\s+HTTP\//iu.exec(firstLine);
  if (originForm !== null && hostHeader !== undefined && hostHeader.length > 0) {
    return parseHostPort(hostHeader) ?? parseHostPort(`${hostHeader}:80`);
  }
  return null;
};

const parseHostPort = (value: string): PreviewProxyDestination | null => {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end <= 1) return null;
    const host = value.slice(1, end);
    const portPart = value.slice(end + 1);
    if (!portPart.startsWith(":")) return null;
    const port = Number.parseInt(portPart.slice(1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { host, port };
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const port = Number.parseInt(value.slice(separator + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: value.slice(0, separator), port };
};

/** Keep %XX encoding. `URL.pathname` decodes and Next.js then 3xx-loops. */
export const absoluteProxyUrlToOriginPath = (absoluteUrl: string): string | null => {
  const stripped = absoluteUrl.replace(/^https?:\/\//iu, "");
  if (stripped === absoluteUrl) return null;
  const pathStart = stripped.indexOf("/");
  if (pathStart === -1) {
    const queryStart = stripped.indexOf("?");
    return queryStart === -1 ? "/" : `/${stripped.slice(queryStart)}`;
  }
  return stripped.slice(pathStart);
};

export const rewriteHttpProxyRequest = (header: string): string => {
  const lines = header.split("\r\n");
  const requestLine = lines[0];
  if (requestLine === undefined) return header;
  const match = /^([A-Z]+)\s+(https?:\/\/\S+)\s+(HTTP\/\d(?:\.\d)?)$/iu.exec(requestLine);
  if (match !== null) {
    const originPath = absoluteProxyUrlToOriginPath(match[2] ?? "");
    if (originPath !== null) {
      lines[0] = `${match[1]} ${originPath} ${match[3]}`;
    }
  }
  const forwarded = lines.filter(
    (line, index) =>
      index === 0 ||
      line.length === 0 ||
      !HOP_BY_HOP_HEADER.test((line.split(":", 1)[0] ?? "").trim()),
  );
  return forwarded.filter((line) => line.length > 0).join("\r\n");
};

export const isPreviewLoopbackDestination = (host: string): boolean => {
  if (isLoopbackHost(host)) return true;
  const lower = host.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1" || lower.startsWith("::ffff:127.");
};

type ByteSource = NodeNet.Socket | NodeStream.Duplex;

class ByteReader {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<() => void> = [];
  private failed: Error | undefined;

  constructor(
    private readonly source: ByteSource,
    initial?: Buffer,
  ) {
    if (initial !== undefined && initial.byteLength > 0) {
      this.buffer = initial;
    }
    this.source.on("data", this.onData);
    this.source.on("error", this.onError);
    this.source.once("end", this.onEnd);
    this.source.once("close", this.onEnd);
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.flush();
  };

  private readonly onError = (cause: Error) => {
    this.failed = cause;
    this.flush();
  };

  private readonly onEnd = () => {
    this.failed ??= new Error("Connection closed.");
    this.flush();
  };

  private flush() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  detach(): Buffer {
    this.source.off("data", this.onData);
    this.source.off("error", this.onError);
    this.source.off("end", this.onEnd);
    this.source.off("close", this.onEnd);
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    return leftover;
  }

  unread(chunk: Buffer) {
    this.buffer = Buffer.concat([chunk, this.buffer]);
  }

  private wait(): Promise<void> {
    if (this.failed !== undefined) {
      return Promise.reject(this.failed);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push(() => {
        if (this.failed !== undefined) reject(this.failed);
        else resolve();
      });
    });
  }

  async readExact(count: number): Promise<Buffer> {
    while (this.buffer.length < count) {
      await this.wait();
    }
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  async readHttpHead(): Promise<HttpHead> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end !== -1) {
        const header = this.buffer.subarray(0, end).toString("utf8");
        const rest = this.buffer.subarray(end + 4);
        this.buffer = Buffer.alloc(0);
        return { header, rest };
      }
      if (this.buffer.length > 65_536) {
        throw new Error("HTTP headers too large.");
      }
      await this.wait();
    }
  }

  async readLine(): Promise<Buffer> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end !== -1) {
        const line = this.buffer.subarray(0, end + 2);
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.wait();
    }
  }
}

const requestMethodOf = (header: string): string =>
  (header.split("\r\n")[0] ?? "").split(" ")[0]?.toUpperCase() ?? "GET";

const responseStatusOf = (header: string): number => {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/u.exec(header.split("\r\n")[0] ?? "");
  return match ? Number(match[1]) : 0;
};

const responseHasBody = (requestMethod: string, status: number): boolean => {
  if (requestMethod === "HEAD") return false;
  if (status === 204 || status === 304) return false;
  if (status >= 100 && status < 200) return false;
  return true;
};

const writeAll = (dest: ByteSource, chunk: Buffer) => {
  if (chunk.byteLength > 0) dest.write(chunk);
};

const forwardChunked = async (reader: ByteReader, client: ByteSource): Promise<void> => {
  for (;;) {
    const line = await reader.readLine();
    writeAll(client, line);
    const size = Number.parseInt(line.toString("utf8").trim().split(";", 1)[0] ?? "0", 16);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error("Invalid chunk size.");
    }
    if (size === 0) {
      for (;;) {
        const trailer = await reader.readLine();
        writeAll(client, trailer);
        if (trailer.equals(Buffer.from("\r\n"))) return;
      }
    }
    writeAll(client, await reader.readExact(size + 2));
  }
};

export const forwardHttpResponse = async (
  dest: ByteSource,
  client: ByteSource,
  requestMethod: string,
  initial = Buffer.alloc(0),
): Promise<{ readonly upgraded: boolean; readonly close: boolean; readonly leftover: Buffer }> => {
  const reader = new ByteReader(dest, initial);
  try {
    const { header, rest } = await reader.readHttpHead();
    writeAll(client, Buffer.from(`${header}\r\n\r\n`));
    const status = responseStatusOf(header);
    if (status === 101) {
      writeAll(client, rest);
      writeAll(client, reader.detach());
      return { upgraded: true, close: true, leftover: Buffer.alloc(0) };
    }
    if (!responseHasBody(requestMethod, status)) {
      reader.unread(rest);
      return { upgraded: false, close: headerIndicatesClose(header), leftover: reader.detach() };
    }
    reader.unread(rest);
    if (/transfer-encoding:\s*chunked/iu.test(header)) {
      await forwardChunked(reader, client);
    } else {
      const length = contentLengthOf(header);
      if (length > 0) {
        writeAll(client, await reader.readExact(length));
      }
    }
    return { upgraded: false, close: headerIndicatesClose(header), leftover: reader.detach() };
  } catch (error) {
    reader.detach();
    throw error;
  }
};

const readRequestBody = async (
  reader: ByteReader,
  header: string,
  rest: Buffer,
): Promise<Buffer> => {
  reader.unread(rest);
  const length = contentLengthOf(header);
  if (length === 0) {
    return Buffer.alloc(0);
  }
  return reader.readExact(length);
};

export type ConnectPreviewDestination = (host: string, port: number) => Promise<ByteSource>;

export const runHttpForwardSession = async (
  client: NodeNet.Socket,
  initial: Buffer,
  connectDest: ConnectPreviewDestination,
): Promise<void> => {
  const clientReader = new ByteReader(client, initial);
  let dest: ByteSource | undefined;
  let destHost = "";
  let destPort = 0;
  let destLeftover = Buffer.alloc(0);
  try {
    for (;;) {
      const { header, rest } = await clientReader.readHttpHead();
      const firstLine = header.split("\r\n")[0] ?? "";
      const destination = parsePreviewProxyDestination(firstLine, readHeaderValue(header, "host"));
      if (destination === null) {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (isHttpConnect(firstLine)) {
        const tunnel = await connectDest(destination.host, destination.port);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const leftover = Buffer.concat([rest, clientReader.detach()]);
        if (leftover.byteLength > 0) tunnel.write(leftover);
        client.pipe(tunnel);
        tunnel.pipe(client);
        dest = undefined;
        return;
      }
      if (dest === undefined || destHost !== destination.host || destPort !== destination.port) {
        dest?.destroy();
        dest = await connectDest(destination.host, destination.port);
        destHost = destination.host;
        destPort = destination.port;
        destLeftover = Buffer.alloc(0);
      }
      const body = await readRequestBody(clientReader, header, rest);
      dest.write(Buffer.concat([Buffer.from(`${rewriteHttpProxyRequest(header)}\r\n\r\n`), body]));
      const forwarded = await forwardHttpResponse(
        dest,
        client,
        requestMethodOf(header),
        destLeftover,
      );
      destLeftover = forwarded.leftover;
      if (forwarded.upgraded) {
        const leftover = clientReader.detach();
        if (leftover.byteLength > 0) dest.write(leftover);
        client.pipe(dest);
        dest.pipe(client);
        dest = undefined;
        return;
      }
      if (forwarded.close || headerIndicatesClose(header)) {
        client.end();
        dest.end();
        dest = undefined;
        return;
      }
    }
  } finally {
    dest?.destroy();
  }
};

export const pipeByteSources = (left: ByteSource, right: ByteSource, initial?: Buffer) => {
  if (initial !== undefined && initial.byteLength > 0) {
    right.write(initial);
  }
  left.pipe(right);
  right.pipe(left);
};
