export interface WebEnv {
  NEXT_PUBLIC_API_URL?: string | undefined;
  NEXT_PUBLIC_STORAGE_URL?: string | undefined;
}

export function originOf(url: string | undefined): string | null;
export function buildCsp(options: { nonce: string; dev: boolean; env: WebEnv }): string;
export const INVITE_HEADERS: ReadonlyArray<{ key: string; value: string }>;
export const STATIC_HEADERS: ReadonlyArray<{ key: string; value: string }>;
export function productionEnvProblems(env: WebEnv): string[];
