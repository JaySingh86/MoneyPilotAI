export interface WebEnv {
  NEXT_PUBLIC_API_URL?: string | undefined;
  NEXT_PUBLIC_COGNITO_USER_POOL_ID?: string | undefined;
  NEXT_PUBLIC_COGNITO_CLIENT_ID?: string | undefined;
  NEXT_PUBLIC_COGNITO_REGION?: string | undefined;
  NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN?: string | undefined;
}

export function originOf(url: string | undefined): string | null;
export function cognitoOrigins(env: WebEnv): string[];
export function buildCsp(options: { nonce: string; dev: boolean; env: WebEnv }): string;
export const INVITE_HEADERS: ReadonlyArray<{ key: string; value: string }>;
export const STATIC_HEADERS: ReadonlyArray<{ key: string; value: string }>;
export function productionEnvProblems(env: WebEnv): string[];
