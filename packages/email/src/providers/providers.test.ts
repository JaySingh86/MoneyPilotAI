// The real Gmail and Graph clients against a stubbed fetch (no network), and the fakes' own contract: the
// fake enforces PKCE and single-use codes, so the connector tests that rely on it mean something.
import { describe, expect, it } from "vitest";
import { createFakeGmail, createFakeGraph } from "../../testing/fake-provider";
import { GmailProvider, gmailBackfillQuery } from "./gmail";
import { GraphProvider, assertGraphUrl } from "./graph";
import { generatePkce } from "./pkce";
import { ProviderError } from "./types";

type Handler = (
  url: URL,
  init: RequestInit,
) => { status?: number; body?: unknown; headers?: Record<string, string> };

function stub(handler: Handler) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    requests.push({ url, init });
    const out = handler(url, init);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json", ...out.headers },
    });
  };
  return { fetchImpl, requests };
}

const gmailConfig = {
  clientId: "cid",
  clientSecret: "secret-value",
  redirectUri: "https://api.example.test/v1/email-connections/gmail/callback",
  pubsubTopic: "projects/p/topics/t",
};
const graphConfig = {
  clientId: "cid",
  clientSecret: "secret-value",
  redirectUri: "https://api.example.test/v1/email-connections/outlook/callback",
  notificationUrl: "https://api.example.test/webhooks/graph",
};

describe("GmailProvider", () => {
  it("asks for read-only, offline access with PKCE S256 and the given state", () => {
    const { fetchImpl } = stub(() => ({}));
    const p = new GmailProvider(gmailConfig, fetchImpl);
    const url = new URL(p.authorizationUrl({ state: "st", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("client_secret")).toBeNull();
  });

  it("exchanges the code with the PKCE verifier and reads the mailbox address", async () => {
    const { fetchImpl, requests } = stub((url) =>
      url.pathname === "/token"
        ? {
            body: {
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3599,
              scope: "https://www.googleapis.com/auth/gmail.readonly",
            },
          }
        : { body: { emailAddress: "sam@gmail.com", historyId: "1" } },
    );
    const grant = await new GmailProvider(gmailConfig, fetchImpl).exchangeCode({
      code: "c",
      codeVerifier: "v",
    });
    expect(grant).toMatchObject({ refreshToken: "rt", address: "sam@gmail.com" });
    const sent = new URLSearchParams(String(requests[0]?.init.body));
    expect(sent.get("code_verifier")).toBe("v");
    expect(sent.get("grant_type")).toBe("authorization_code");
  });

  it("refuses a grant without a refresh token or without the mail scope", async () => {
    for (const body of [
      { access_token: "at", scope: "https://www.googleapis.com/auth/gmail.readonly" },
      { access_token: "at", refresh_token: "rt", scope: "openid" },
    ]) {
      const { fetchImpl } = stub(() => ({ body }));
      await expect(
        new GmailProvider(gmailConfig, fetchImpl).exchangeCode({ code: "c", codeVerifier: "v" }),
      ).rejects.toMatchObject({
        kind: "permanent",
      });
    }
  });

  it("maps provider failures to typed errors whose message never carries the response", async () => {
    const cases: [number, string][] = [
      [400, "auth_revoked"],
      [429, "rate_limited"],
      [503, "transient"],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = stub(() => ({
        status,
        body: { error: "invalid_grant", error_description: "sam@gmail.com secret-value" },
      }));
      const err = await new GmailProvider(gmailConfig, fetchImpl).refresh("rt").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(status === 400 ? "auth_revoked" : kind);
      expect(String(err)).not.toContain("sam@gmail.com");
      expect(String(err)).not.toContain("secret-value");
    }
  });

  it("a refresh 400 is auth_revoked only for invalid_grant; other 400s are permanent (no token deletion)", async () => {
    for (const [code, kind] of [
      ["invalid_grant", "auth_revoked"],
      ["invalid_client", "permanent"],
      ["invalid_request", "permanent"],
      [undefined, "permanent"],
    ] as const) {
      const { fetchImpl } = stub(() => ({ status: 400, body: code ? { error: code } : "not json" }));
      await expect(new GmailProvider(gmailConfig, fetchImpl).refresh("rt")).rejects.toMatchObject({ kind });
    }
  });

  it("revoke treats only 400 invalid_token as already revoked; any other refusal throws", async () => {
    const ok = stub(() => ({ status: 400, body: { error: "invalid_token" } }));
    await expect(new GmailProvider(gmailConfig, ok.fetchImpl).revoke("rt")).resolves.toBe(true);
    const bad = stub(() => ({ status: 400, body: { error: "invalid_client" } }));
    await expect(new GmailProvider(gmailConfig, bad.fetchImpl).revoke("rt")).rejects.toMatchObject({
      kind: "permanent",
    });
    const gone = stub(() => ({ status: 404, body: {} }));
    await expect(new GmailProvider(gmailConfig, gone.fetchImpl).revoke("rt")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("a 403 for permission or scope fails fast; only a quota 403 is waited out", async () => {
    const kinds: [unknown, string][] = [
      [
        { error: { code: 403, errors: [{ reason: "insufficientPermissions" }], message: "sam@gmail.com" } },
        "permanent",
      ],
      [{ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, "permanent"],
      [{ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, "rate_limited"],
      [{ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, "rate_limited"],
    ];
    for (const [body, kind] of kinds) {
      const { fetchImpl } = stub(() => ({ status: 403, body }));
      const err = await new GmailProvider(gmailConfig, fetchImpl)
        .listChanges("at", "1")
        .catch((e: unknown) => e);
      expect((err as ProviderError).kind).toBe(kind);
      expect(String(err)).not.toContain("sam@gmail.com");
    }
  });

  it("a history cursor that is too old is reported as cursor_expired", async () => {
    const { fetchImpl } = stub(() => ({ status: 404, body: {} }));
    await expect(new GmailProvider(gmailConfig, fetchImpl).listChanges("at", "123")).rejects.toMatchObject({
      kind: "cursor_expired",
    });
  });

  it("lists new mail through history and fetches metadata only", async () => {
    const { fetchImpl, requests } = stub((url) => {
      if (url.pathname.endsWith("/history")) {
        return {
          body: {
            historyId: "200",
            history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m1" } }] }],
          },
        };
      }
      return {
        body: {
          id: "m1",
          internalDate: String(Date.parse("2026-11-01T10:00:00Z")),
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "a@b.example" },
              { name: "Subject", value: "Statement" },
            ],
          },
        },
      };
    });
    const page = await new GmailProvider(gmailConfig, fetchImpl).listChanges("at", "100");
    expect(page.cursor).toBe("200");
    expect(page.messages).toEqual([
      expect.objectContaining({
        providerMessageId: "m1",
        receivedAt: "2026-11-01T10:00:00.000Z",
        from: "a@b.example",
      }),
    ]);
    const message = requests.find((r) => r.url.pathname.endsWith("/messages/m1"));
    expect(message?.url.searchParams.get("format")).toBe("metadata");
    expect(
      requests.some(
        (r) => r.url.searchParams.get("format") === "full" || r.url.searchParams.get("format") === "raw",
      ),
    ).toBe(false);
  });

  it("the backfill query follows BACKEND_PLAN §7.8.1 and only accepts plain domains", () => {
    const q = gmailBackfillQuery(395, ["northgate-insurance.example", 'evil" OR in:anywhere']);
    expect(q).toContain("newer_than:395d");
    expect(q).toContain("-category:promotions -category:social");
    expect(q).toContain('"payment due"');
    expect(q).toContain("from:northgate-insurance.example");
    expect(q).not.toContain("anywhere");
  });
});

describe("GmailProvider without Pub/Sub (local development)", () => {
  it("creates no watch: it takes the history position and the polling sync finds new mail", async () => {
    const { fetchImpl, requests } = stub(() => ({ body: { emailAddress: "a@b.example", historyId: "77" } }));
    const { pubsubTopic: _unused, ...local } = gmailConfig;
    const p = new GmailProvider(local, fetchImpl, () => Date.parse("2026-11-09T00:00:00Z"));
    const w = await p.startWatch("at");
    expect(w).toEqual({ ref: null, expiresAt: "2026-11-16T00:00:00.000Z", cursor: "77" });
    expect(requests.map((r) => r.url.pathname)).toEqual(["/gmail/v1/users/me/profile"]);
  });
});

describe("GraphProvider", () => {
  it("follows nextLink on Graph's host only", () => {
    expect(assertGraphUrl("https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=x")).toContain(
      "skiptoken",
    );
    for (const bad of [
      "https://evil.example/steal",
      "http://graph.microsoft.com/v1.0",
      "https://graph.microsoft.com.evil.example/x",
      "nope",
    ]) {
      expect(() => assertGraphUrl(bad)).toThrow(ProviderError);
    }
  });

  it("creates the subscription with our clientState and the inbox resource", async () => {
    const { fetchImpl, requests } = stub(() => ({
      status: 201,
      body: { id: "sub-1", expirationDateTime: "2026-11-12T00:00:00.0000000Z" },
    }));
    const p = new GraphProvider(graphConfig, fetchImpl, () => Date.parse("2026-11-09T00:00:00Z"));
    const watch = await p.startWatch("at", { clientState: "cs" });
    expect(watch.ref).toBe("sub-1");
    const sent = JSON.parse(String(requests[0]?.init.body)) as Record<string, string>;
    expect(sent).toMatchObject({
      changeType: "created",
      clientState: "cs",
      resource: "me/mailFolders('inbox')/messages",
    });
    expect(Date.parse(sent["expirationDateTime"]!) - Date.parse("2026-11-09T00:00:00Z")).toBeLessThanOrEqual(
      4230 * 60_000,
    );
  });

  it("a delta cursor (deltaLink) that is gone is cursor_expired; a tampered one is refused before any request", async () => {
    const { fetchImpl, requests } = stub(() => ({ status: 410, body: {} }));
    const p = new GraphProvider(graphConfig, fetchImpl);
    await expect(
      p.listChanges("at", "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=old"),
    ).rejects.toMatchObject({
      kind: "cursor_expired",
    });
    requests.length = 0;
    await expect(p.listChanges("at", "https://evil.example/delta")).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(0);
  });

  it("backfill returns one page, a resume link, then the deltaLink as the cursor", async () => {
    let call = 0;
    const { fetchImpl } = stub(() => {
      call++;
      return call === 1
        ? {
            body: {
              value: [
                {
                  id: "a",
                  receivedDateTime: "2026-11-01T00:00:00Z",
                  from: { emailAddress: { address: "x@y.example" } },
                  subject: "s",
                },
              ],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=2",
            },
          }
        : {
            body: {
              value: [{ id: "b", "@removed": { reason: "deleted" } }],
              "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=z",
            },
          };
    });
    const p = new GraphProvider(graphConfig, fetchImpl);
    const first = await p.backfillPage("at", {
      sinceIso: "2025-10-01T00:00:00Z",
      lookbackDays: 395,
      pageToken: null,
      watchedDomains: [],
    });
    expect(first.messages).toHaveLength(1);
    expect(first.cursor).toBeNull();
    const second = await p.backfillPage("at", {
      sinceIso: "",
      lookbackDays: 395,
      pageToken: first.nextPageToken,
      watchedDomains: [],
    });
    expect(second.messages).toHaveLength(0);
    expect(second.nextPageToken).toBeNull();
    expect(second.cursor).toContain("deltatoken=z");
  });

  it("reports that Microsoft tokens cannot be revoked remotely", async () => {
    expect(await new GraphProvider(graphConfig, stub(() => ({})).fetchImpl).revoke()).toBe(false);
  });
});

describe("the fake providers", () => {
  it("verify PKCE and accept an authorisation code once", async () => {
    const fake = createFakeGmail();
    const pkce = generatePkce();
    const { code } = fake.consent(
      fake.authorizationUrl({ state: "s", codeChallenge: pkce.challenge }),
      "sam@gmail.com",
    );
    await expect(fake.exchangeCode({ code, codeVerifier: generatePkce().verifier })).rejects.toBeInstanceOf(
      ProviderError,
    );
    // The failed attempt used the code up.
    await expect(fake.exchangeCode({ code, codeVerifier: pkce.verifier })).rejects.toBeInstanceOf(
      ProviderError,
    );
    const again = fake.consent(
      fake.authorizationUrl({ state: "s", codeChallenge: pkce.challenge }),
      "sam@gmail.com",
    );
    expect((await fake.exchangeCode({ code: again.code, codeVerifier: pkce.verifier })).address).toBe(
      "sam@gmail.com",
    );
  });

  it("Graph rotates the refresh token and Gmail does not", async () => {
    for (const [fake, rotates] of [
      [createFakeGmail(), false],
      [createFakeGraph(), true],
    ] as const) {
      const pkce = generatePkce();
      const { code } = fake.consent(
        fake.authorizationUrl({ state: "s", codeChallenge: pkce.challenge }),
        "a@b.example",
      );
      const grant = await fake.exchangeCode({ code, codeVerifier: pkce.verifier });
      const refreshed = await fake.refresh(grant.refreshToken);
      expect(refreshed.refreshToken !== null).toBe(rotates);
      if (rotates)
        await expect(fake.refresh(grant.refreshToken)).rejects.toMatchObject({ kind: "auth_revoked" });
    }
  });

  it("a revoked grant stops working everywhere", async () => {
    const fake = createFakeGmail();
    const pkce = generatePkce();
    const { code } = fake.consent(
      fake.authorizationUrl({ state: "s", codeChallenge: pkce.challenge }),
      "a@b.example",
    );
    const grant = await fake.exchangeCode({ code, codeVerifier: pkce.verifier });
    expect(await fake.revoke(grant.refreshToken)).toBe(true);
    await expect(fake.refresh(grant.refreshToken)).rejects.toMatchObject({ kind: "auth_revoked" });
    await expect(fake.listChanges(grant.accessToken, "0")).rejects.toMatchObject({ kind: "auth_revoked" });
  });
});
