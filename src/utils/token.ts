import { timingSafeEqual } from "node:crypto";

/** Constant-time Bearer token validation. Returns false if token is absent or does not match. */
export function isValidToken(token: string | undefined, expected: string): boolean {
  // An empty expected key means auth is disabled — never consider any token valid
  if (!expected || expected.length === 0) return false;
  if (!token) return false;
  // Pad both to expected.length so timingSafeEqual always runs on equal-length buffers,
  // preventing timing-based token-length enumeration even when lengths differ.
  const a = Buffer.from(token.padEnd(expected.length, "\0").slice(0, expected.length));
  const b = Buffer.from(expected);
  return token.length === expected.length && timingSafeEqual(a, b);
}
