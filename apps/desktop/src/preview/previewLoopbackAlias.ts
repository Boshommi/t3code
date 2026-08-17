import { PREVIEW_LOOPBACK_ALIAS_HOST } from "@t3tools/shared/previewLoopbackForward";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

type ByteSource = NodeNet.Socket | NodeStream.Duplex;

const ALIAS = PREVIEW_LOOPBACK_ALIAS_HOST;
const ALIAS_RE = new RegExp(ALIAS.replaceAll(".", "\\."), "giu");

export const rewriteAliasRequestHeaders = (header: string): string =>
  header
    .replace(new RegExp(`^(Host:\\s*)${ALIAS_RE.source}`, "imu"), `$1localhost`)
    .replace(new RegExp(`^(Origin:\\s*https?://)${ALIAS_RE.source}`, "imu"), `$1localhost`)
    .replace(new RegExp(`^(Referer:\\s*https?://)${ALIAS_RE.source}`, "imu"), `$1localhost`);

export const rewriteAliasResponseHeaders = (header: string): string =>
  header
    .replace(
      new RegExp(
        `^((?:Location|Content-Location|Origin|Referer|Access-Control-Allow-Origin):\\s*https?://)localhost`,
        "imu",
      ),
      `$1${ALIAS}`,
    )
    .replace(new RegExp(`^(Set-Cookie:.*Domain=)\\.?localhost`, "imu"), `$1${ALIAS}`);

const attachHeaderRewriter = (
  from: ByteSource,
  to: ByteSource,
  rewrite: (header: string) => string,
  initial?: Buffer,
) => {
  let mode: "headers" | "body" | "raw" = "headers";
  let buffer = initial === undefined ? Buffer.alloc(0) : initial;
  let bodyRemaining = 0;

  const pump = () => {
    while (buffer.length > 0) {
      if (mode === "raw") {
        to.write(buffer);
        buffer = Buffer.alloc(0);
        return;
      }
      if (mode === "headers") {
        const split = buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = buffer.subarray(0, split).toString("utf8");
        const rest = buffer.subarray(split + 4);
        to.write(Buffer.from(`${rewrite(header)}\r\n\r\n`));
        if (/upgrade:\s*websocket/iu.test(header)) {
          mode = "raw";
          buffer = rest;
          continue;
        }
        const lengthMatch = /content-length:\s*(\d+)/iu.exec(header);
        const length = lengthMatch ? Number(lengthMatch[1]) : 0;
        if (/transfer-encoding:\s*chunked/iu.test(header) || length === 0) {
          buffer = rest;
          if (length === 0 && !/transfer-encoding:\s*chunked/iu.test(header)) {
            continue;
          }
          mode = "raw";
          continue;
        }
        mode = "body";
        bodyRemaining = length;
        buffer = rest;
        continue;
      }
      const take = buffer.subarray(0, bodyRemaining);
      to.write(take);
      bodyRemaining -= take.byteLength;
      buffer = buffer.subarray(take.byteLength);
      if (bodyRemaining === 0) {
        mode = "headers";
      } else {
        return;
      }
    }
  };

  if (buffer.length > 0) {
    pump();
  }
  from.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  from.on("end", () => to.end());
  from.on("close", () => to.destroy());
  from.on("error", () => to.destroy());
};

export const pipeWithPreviewLoopbackAliasRewrite = (
  client: ByteSource,
  dest: ByteSource,
  initial?: Buffer,
) => {
  attachHeaderRewriter(client, dest, rewriteAliasRequestHeaders, initial);
  attachHeaderRewriter(dest, client, rewriteAliasResponseHeaders);
};
