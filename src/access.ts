// UI capability only. The public tunnel independently blocks all mutations.
export function isPublicHostname(hostname: string): boolean {
  return !["localhost", "127.0.0.1"].includes(hostname.toLowerCase());
}
