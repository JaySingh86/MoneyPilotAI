import { describe, expect, it } from "vitest";
import { maskSubject } from "./mask";

describe("maskSubject (defensive, M1)", () => {
  it("keeps ordinary subjects and short numbers", () => {
    expect(maskSubject("Your renewal offer for policy •••4821")).toBe(
      "Your renewal offer for policy •••4821",
    );
    expect(maskSubject("Invoice 4821 is ready, due 11/03/2026")).toBe(
      "Invoice 4821 is ready, due 11/03/2026",
    );
    expect(maskSubject(null)).toBeNull();
    expect(maskSubject("")).toBe("");
  });

  it("masks digit runs of 8 or more, keeping the last 4", () => {
    expect(maskSubject("Account 123456789 statement")).toBe("Account •••6789 statement");
    expect(maskSubject("Policy 12345678")).toBe("Policy •••5678");
  });

  it("masks card-like numbers with spaces or dashes", () => {
    expect(maskSubject("Card 4111 1111 1111 1111 charged")).toBe("Card •••1111 charged");
    expect(maskSubject("Card 4111-1111-1111-1111")).toBe("Card •••1111");
  });

  it("masks every run in the subject", () => {
    expect(maskSubject("A 12345678 and B 987654321")).toBe("A •••5678 and B •••4321");
  });
});
