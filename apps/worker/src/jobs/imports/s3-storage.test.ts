// The worker's S3 file store against a stub that behaves badly (no Docker): a server that ignores the Range header
// must not make the worker download an object of any size into memory.
import { describe, expect, it, vi } from "vitest";
import { createS3ImportFileStore, type S3Like } from "./s3-storage";

const config = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  accessKeyId: "a",
  secretAccessKey: "b",
  bucket: "imports",
};

function stubClient(response: { ContentLength?: number; ContentRange?: string; bytes?: Uint8Array }) {
  const destroy = vi.fn();
  const transformToByteArray = vi.fn(async () => response.bytes ?? new Uint8Array());
  const client: S3Like = {
    send: async () => ({
      ContentLength: response.ContentLength,
      ContentRange: response.ContentRange,
      Body: { transformToByteArray, destroy },
    }),
  } as unknown as S3Like;
  return { client, destroy, transformToByteArray };
}

describe("a store that ignores the Range header", () => {
  it("is cut off without reading the body, and reported as over the limit", async () => {
    const { client, destroy, transformToByteArray } = stubClient({ ContentLength: 50_000_000 });
    const store = createS3ImportFileStore(config, 100, client);
    const got = await store.get("imports/h/huge.csv");
    expect(got?.byteLength).toBe(101); // one past the limit: the job's own size check rejects it
    expect(destroy).toHaveBeenCalled();
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("an unknown length counts as over the limit too", async () => {
    const { client, destroy, transformToByteArray } = stubClient({});
    const got = await createS3ImportFileStore(config, 100, client).get("k");
    expect(got?.byteLength).toBe(101);
    expect(destroy).toHaveBeenCalled();
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("a small object answered in full (200, no Content-Range) is still read", async () => {
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const { client, transformToByteArray } = stubClient({ ContentLength: bytes.byteLength, bytes });
    const got = await createS3ImportFileStore(config, 100, client).get("k");
    expect(got).toEqual(bytes);
    expect(transformToByteArray).toHaveBeenCalled();
  });

  it("an honoured range (one byte past the limit) is read and left for the job's size check", async () => {
    const bytes = new Uint8Array(101);
    const { client } = stubClient({ ContentLength: 101, ContentRange: "bytes 0-100/5000", bytes });
    expect((await createS3ImportFileStore(config, 100, client).get("k"))?.byteLength).toBe(101);
  });
});
