import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Testcontainers needs extra settings when Docker runs inside Colima (no Docker Desktop).
 * Applied only to this test process, and only when the caller has not configured Docker already,
 * so CI (plain Docker on Linux) is unaffected.
 */
export function configureDockerForTestcontainers(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DOCKER_HOST) return;
  const colimaSocket = join(homedir(), ".colima", "default", "docker.sock");
  if (!existsSync(colimaSocket)) return;
  env.DOCKER_HOST = `unix://${colimaSocket}`;
  env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
  env.TESTCONTAINERS_HOST_OVERRIDE ??= "127.0.0.1";
}
