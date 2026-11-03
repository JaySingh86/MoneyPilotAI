import { describe, expect, it } from "vitest";
import {
  isFreeMailDomain,
  isSameOrSubdomain,
  normalizeDomain,
  orgDomain,
  sameOrganisation,
} from "./domain.js";
import { redact } from "../redact/redact.js";

describe("domain helpers", () => {
  it("normalizes and rejects junk", () => {
    expect(normalizeDomain(" Billing.Example.COM. ")).toBe("billing.example.com");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("a b.com")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });
  it("finds the organisational domain", () => {
    expect(orgDomain("billing.lakeside-auto.example")).toBe("lakeside-auto.example");
    expect(orgDomain("mail.foo.co.uk")).toBe("foo.co.uk");
    expect(orgDomain("foo.example")).toBe("foo.example");
  });
  it("suffix checks respect the dot boundary", () => {
    expect(isSameOrSubdomain("a.lakeside-auto.example", "lakeside-auto.example")).toBe(true);
    expect(isSameOrSubdomain("lakeside-auto.example", "lakeside-auto.example")).toBe(true);
    expect(isSameOrSubdomain("evillakeside-auto.example", "lakeside-auto.example")).toBe(false);
    expect(isSameOrSubdomain("lakeside-auto.example.evil.test", "lakeside-auto.example")).toBe(false);
    expect(isSameOrSubdomain("lakeside-auto.example", "billing.lakeside-auto.example")).toBe(false);
  });
  it("same organisation ignores subdomains on either side", () => {
    expect(sameOrganisation("help.x-corp.example", "billing.x-corp.example")).toBe(true);
    expect(sameOrganisation("x-corp.example", "y-corp.example")).toBe(false);
  });
  it("knows consumer webmail", () => {
    expect(isFreeMailDomain("mail.gmail.com")).toBe(true);
    expect(isFreeMailDomain("lakeside-auto.example")).toBe(false);
  });
});

describe("redact with a subdomain sender and webmail senders", () => {
  it("keeps parent-domain addresses when the sender is a subdomain", () => {
    const out = redact("help@lakeside-auto.example", { senderDomain: "billing.lakeside-auto.example" }).text;
    expect(out).toBe("help@lakeside-auto.example");
  });
  it("masks every address when a member forwards from webmail", () => {
    const out = redact("pat@gmail.com and sam@gmail.com", { senderDomain: "gmail.com" }).text;
    expect(out).toBe("[email] and [email]");
  });
});
