// WP-21 contract check: what the web's mock API answers for `GET /households/:hid/email-connections` must parse with
// the real `EmailConnectionList` (`{ data, nextCursor }`, BACKEND_PLAN §8.1), so the mock cannot drift from the API
// the connect screens will meet. Test only; no web code is changed.
import { describe, expect, it } from "vitest";
import { EmailConnection, EmailConnectionList } from "@mp/contracts";
import { API_BASE_URL } from "../lib/config";
import { HOUSEHOLD_ID } from "../mocks/identity";

describe("web mock vs the email connections contract", () => {
  it("every connection the mock returns is an EmailConnection", async () => {
    const res = await fetch(`${API_BASE_URL}/v1/households/${HOUSEHOLD_ID}/email-connections`);
    const body = (await res.json()) as { data: unknown[]; nextCursor?: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    for (const c of body.data) expect(EmailConnection.safeParse(c).success, JSON.stringify(c)).toBe(true);
  });

  it("the wrapper parses with EmailConnectionList (the mock leaves nextCursor out; the API sends null)", async () => {
    const res = await fetch(`${API_BASE_URL}/v1/households/${HOUSEHOLD_ID}/email-connections`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(EmailConnectionList.safeParse({ nextCursor: null, ...body }).success).toBe(true);
    expect(Object.keys(body)).toContain("data");
  });
});
