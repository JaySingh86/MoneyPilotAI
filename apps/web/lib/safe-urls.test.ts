import { describe, expect, it } from "vitest";
import { UnsafeUrlError, providerUrl, uploadUrl } from "./safe-urls";

describe("provider URLs", () => {
  it("accepts https on the Google and Microsoft consent hosts", () => {
    expect(providerUrl("https://accounts.google.com/o/oauth2/v2/auth?state=x")).toContain(
      "accounts.google.com",
    );
    expect(providerUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")).toContain(
      "microsoft",
    );
  });

  it("refuses http, other hosts, look-alikes and junk", () => {
    for (const bad of [
      "http://accounts.google.com/",
      "https://evil.example/",
      "https://accounts.google.com.evil.example/",
      "https://evil.example/accounts.google.com",
      "javascript:alert(1)",
      "//evil.example",
      "not a url",
    ])
      expect(() => providerUrl(bad), bad).toThrow(UnsafeUrlError);
  });

  it("allows the app's own origin in mock mode only, and no other origin", () => {
    expect(providerUrl("http://localhost:3100/setup?connected=gmail", "http://localhost:3100")).toContain(
      "setup",
    );
    expect(() => providerUrl("http://localhost:9999/x", "http://localhost:3100")).toThrow(UnsafeUrlError);
  });
});

describe("upload URLs", () => {
  it("is https (http is allowed only in mock mode, which the tests run in)", () => {
    expect(uploadUrl("https://bucket.s3.amazonaws.com/key?sig=1")).toContain("s3");
    expect(uploadUrl("http://localhost:3100/mock-upload/1")).toContain("mock-upload");
    expect(() => uploadUrl("ftp://x/y")).toThrow(UnsafeUrlError);
    expect(() => uploadUrl("javascript:1")).toThrow(UnsafeUrlError);
  });
});
