import { describe, expect, it, vi } from "vitest";
import { fetchConfirm } from "./index";

describe("fetchConfirm", () => {
  it("checks the status and never reads the body", async () => {
    let read = false;
    const res = new Response("secret body", { status: 200 });
    const spy = (name: "text" | "json" | "arrayBuffer") =>
      vi.spyOn(res, name).mockImplementation(() => {
        read = true;
        return Promise.resolve(undefined as never);
      });
    spy("text");
    spy("json");
    spy("arrayBuffer");
    await fetchConfirm("https://sns.us-east-1.amazonaws.com/x", (async () => res) as unknown as typeof fetch);
    expect(read).toBe(false);
  });
  it("throws on a non-2xx status", async () => {
    const fake = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchConfirm("https://sns.us-east-1.amazonaws.com/x", fake)).rejects.toThrow();
  });
});
