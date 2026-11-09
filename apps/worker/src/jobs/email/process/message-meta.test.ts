import { describe, expect, it } from "vitest";
import { ReviewMessage } from "@mp/contracts";
import { MAX_SUBJECT_CHARS, messageMeta, redactedSubject } from "./message-meta";

describe("message_meta", () => {
  it("runs the subject through the WP-19 redactor: policy numbers, cards, phones, SSNs and other addresses", () => {
    const m = messageMeta({
      fromDomain: "northgate-home.example",
      subject:
        "Policy 5530194821 renewal. Card 4111 1111 1111 1111, call (800) 555-0147, ssn 123-45-6789, write sam.rivera@mailbox.example",
      receivedAtIso: "2026-10-24T14:02:00Z",
    });
    const subject = m.subject ?? "";
    expect(subject).toContain("••••4821");
    for (const leaked of ["5530194821", "4111 1111", "555-0147", "123-45-6789", "sam.rivera"]) {
      expect(subject).not.toContain(leaked);
    }
  });

  it("keeps an address on the sender's own organisation, masks the rest", () => {
    expect(
      redactedSubject("Write help@northgate-home.example or me@gmail.example", "northgate-home.example"),
    ).toBe("Write help@northgate-home.example or [email]");
  });

  it("is exactly the three keys the table allows, and the review contract accepts it", () => {
    const m = messageMeta({
      fromDomain: "citypowerlight.example",
      subject: "Your October statement is ready",
      receivedAtIso: "2026-10-26T13:10:00.123Z",
    });
    expect(Object.keys(m).sort()).toEqual(["fromDomain", "receivedAt", "subject"]);
    expect(m.receivedAt).toBe("2026-10-26T13:10:00Z");
    expect(ReviewMessage.safeParse(m).success).toBe(true);
  });

  it("caps the subject at 300 characters and turns an empty one into null", () => {
    expect(redactedSubject("x".repeat(1000), null)).toHaveLength(MAX_SUBJECT_CHARS);
    expect(redactedSubject("   \n  ", null)).toBeNull();
  });
});
