const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSIONS_MARKER = "/sessions/";
const IMAGES_MARKER = "/images/";

function decodePreservingEncodedSlashes(value: string): string {
  return value.replace(/%(?!2F)([0-9A-Fa-f]{2})/gi, (match, hex: string) => {
    try {
      return decodeURIComponent(`%${hex}`);
    } catch {
      return match;
    }
  });
}

function parseGrokSessionMediaPath(filePath: string): {
  readonly normalized: string;
  readonly sessionsIndex: number;
  readonly imagesIndex: number;
  readonly sessionId: string;
  readonly cwdPart: string;
} | null {
  const normalized = filePath.replaceAll("\\", "/");
  const sessionsIndex = normalized.indexOf(SESSIONS_MARKER);
  const imagesIndex = normalized.lastIndexOf(IMAGES_MARKER);
  if (sessionsIndex < 0 || imagesIndex <= sessionsIndex) {
    return null;
  }

  const afterSessions = normalized.slice(sessionsIndex + SESSIONS_MARKER.length, imagesIndex);
  const sessionSeparator = afterSessions.lastIndexOf("/");
  if (sessionSeparator <= 0) {
    return null;
  }

  const sessionId = afterSessions.slice(sessionSeparator + 1);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }

  const cwdPart = afterSessions.slice(0, sessionSeparator).replace(/^\/+/, "");
  if (cwdPart.length === 0) {
    return null;
  }

  return { normalized, sessionsIndex, imagesIndex, sessionId, cwdPart };
}

export function isGrokSessionMediaPath(filePath: string): boolean {
  return parseGrokSessionMediaPath(filePath) !== null;
}

/**
 * Grok stores the session cwd as one `%2F`-encoded path segment. Markdown and
 * tool output often decode that into nested folders (`sessions/home/proj/...`)
 * that do not exist. Rebuild the on-disk path so a remote T3 server can serve
 * the bytes.
 */
export function encodedGrokSessionMediaPath(filePath: string): string | null {
  const parsed = parseGrokSessionMediaPath(filePath);
  if (parsed === null || /%2F/i.test(parsed.cwdPart)) {
    return null;
  }

  const encodedCwd = encodeURIComponent(`/${parsed.cwdPart}`);
  const encodedPath = `${parsed.normalized.slice(0, parsed.sessionsIndex + SESSIONS_MARKER.length)}${encodedCwd}/${parsed.sessionId}${parsed.normalized.slice(parsed.imagesIndex)}`;
  return encodedPath === parsed.normalized ? null : encodedPath;
}

/** Absolute paths to try when a markdown destination might be a Grok session image. */
export function grokSessionMediaPathCandidates(filePath: string): readonly string[] {
  const normalized = filePath.replaceAll("\\", "/");
  const decoded = decodePreservingEncodedSlashes(normalized);
  const encoded = encodedGrokSessionMediaPath(decoded) ?? encodedGrokSessionMediaPath(normalized);
  const candidates: string[] = [];
  for (const candidate of [normalized, decoded, encoded]) {
    if (
      candidate !== null &&
      isGrokSessionMediaPath(candidate) &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}
