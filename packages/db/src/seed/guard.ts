// The fixture seed creates users, households and money rows with made-up identities. It must never run
// against anything but a local development database (G1 L-5).

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
  "db",
  "host.docker.internal",
]);

export class SeedTargetError extends Error {
  override readonly name = "SeedTargetError";
}

/** Throws unless NODE_ENV is not production and every given database URL points at a local host. */
export function assertLocalSeedTarget(env: { NODE_ENV?: string | undefined }, urls: readonly string[]): void {
  if (env.NODE_ENV === "production") {
    throw new SeedTargetError("Refusing to seed: NODE_ENV is production.");
  }
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new SeedTargetError("Refusing to seed: the database URL is not valid.");
    }
    if (!LOCAL_HOSTS.has(host)) {
      throw new SeedTargetError(`Refusing to seed: ${host} is not a local database host.`);
    }
  }
}
