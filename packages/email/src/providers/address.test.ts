import { describe, expect, it } from "vitest";
import { addressHash, graphClientState, verifyGraphClientState } from "./address";
import { generatePkce, generateState, hashState, pkceChallenge } from "./pkce";

describe("addressHash", () => {
  const key = Buffer.alloc(32, 7);
  it("is a keyed 32-byte hash that ignores case and surrounding space", () => {
    expect(addressHash(key, " Sam@Gmail.com ")).toEqual(addressHash(key, "sam@gmail.com"));
    expect(addressHash(key, "sam@gmail.com")).toHaveLength(32);
    expect(addressHash(key, "sam@gmail.com")).not.toEqual(addressHash(Buffer.alloc(32, 8), "sam@gmail.com"));
  });
});

describe("Graph clientState", () => {
  const secret = Buffer.alloc(32, 3);
  const id = "11111111-1111-4111-8111-111111111111";

  it("round-trips the connection id", () => {
    expect(verifyGraphClientState(secret, graphClientState(secret, id))).toBe(id);
  });

  it("rejects a forged, truncated or wrong-secret value", () => {
    const good = graphClientState(secret, id);
    expect(verifyGraphClientState(secret, `${id}.${"0".repeat(43)}`)).toBeNull();
    expect(verifyGraphClientState(secret, good.slice(0, -2))).toBeNull();
    expect(verifyGraphClientState(Buffer.alloc(32, 4), good)).toBeNull();
    expect(verifyGraphClientState(secret, "x")).toBeNull();
    expect(verifyGraphClientState(secret, `not-a-uuid.${good.split(".")[1]}`)).toBeNull();
  });

  it("fits Graph's 128 character limit", () => {
    expect(graphClientState(secret, id).length).toBeLessThanOrEqual(128);
  });
});

describe("PKCE and state", () => {
  it("the verifier is 43 URL-safe characters and the challenge is its S256 hash", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
  });

  it("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("states are unique and 256 bits; the stored hash is not the state", () => {
    const a = generateState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateState()).not.toBe(a);
    expect(hashState(a)).toHaveLength(32);
    expect(hashState(a).toString("base64url")).not.toBe(a);
  });
});
