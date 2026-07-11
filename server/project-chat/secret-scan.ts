const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bwhsec_[A-Za-z0-9]{16,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAWS_SECRET_ACCESS_KEY\s*[=:]\s*["']?[A-Za-z0-9/+=]{32,}/i,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{12,}\b/i,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:Cookie|Set-Cookie)\s*:\s*\S+/i,
  /\b(?:session|sessionid|auth_token|access_token|refresh_token)\s*[=:]\s*["']?[^\s"']{8,}/i,
  /\b(?:password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/i,
  /(?:^|[^A-Za-z0-9])(?:api[_-]?key|client[_-]?secret|private[_-]?key|secret[_-]?key|service[_-]?account[_-]?token)\s*[=:]\s*["']?[^\s"']{12,}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/:]+:[^\s/@]+@/i
];

export interface ProjectChatSecretScanResult {
  safe: boolean;
}

/**
 * Deliberately returns no match detail so callers cannot accidentally log a
 * secret category alongside message content.
 */
export function scanProjectChatText(value: string): ProjectChatSecretScanResult {
  return { safe: !SECRET_PATTERNS.some((pattern) => pattern.test(value)) };
}
