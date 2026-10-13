// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) against the team's signing keys.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

interface Jwk extends JsonWebKey {
  kid?: string;
}

const CERTS_TTL_MS = 10 * 60_000;

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

/** One verifier per Worker instance; it caches the team's keys for a few minutes. */
export function accessVerifier(teamDomain: string, aud: string) {
  let cached: { at: number; keys: Jwk[] } | undefined;

  async function keys(): Promise<Jwk[]> {
    if (cached && Date.now() - cached.at < CERTS_TTL_MS) return cached.keys;
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`access certs ${res.status}`);
    cached = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
    return cached.keys;
  }

  /** True only for a well-formed, correctly signed, unexpired token for this application. */
  return async function verify(token: string | null): Promise<boolean> {
    if (!token) return false;
    try {
      const [head, body, sig] = token.split(".");
      if (!head || !body || !sig) return false;
      const header = json(head);
      if (header.alg !== "RS256") return false;
      const jwk = (await keys()).find((k) => k.kid === header.kid);
      if (!jwk) return false;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(sig), new TextEncoder().encode(`${head}.${body}`));
      if (!ok) return false;
      const claims = json(body);
      const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      return auds.includes(aud) && claims.iss === `https://${teamDomain}` && typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  };
}
