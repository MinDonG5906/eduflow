import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { GenerationError } from "../generation-contract";
import {
  privateDirectory, readConnectionState, updateConnectionState, type ChatGPTCredential, type ConnectionState,
} from "./connection-store";

// Sign in with ChatGPT, plan usage for locally hosted apps:
// https://developers.openai.com/siwc/token-sharing-open-source
export const CHATGPT_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
const UNUSABLE_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused"]);

export type ChatGPTDeps = { fetch?: typeof fetch; jwks?: JWTVerifyGetKey; directory?: string; now?: () => number };
let remoteJwks: JWTVerifyGetKey | undefined;
const deps = (options: ChatGPTDeps) => ({
  fetch: options.fetch ?? fetch,
  jwks: options.jwks ?? (remoteJwks ??= createRemoteJWKSet(new URL(JWKS_URL))),
  directory: options.directory ?? privateDirectory(),
  now: options.now ?? Date.now,
});

const random = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The registered callback is the app itself on 127.0.0.1; only the port may change. */
export function chatgptRedirectUri(request: Request) {
  const host = new URL(`http://${request.headers.get("host") ?? new URL(request.url).host}`);
  if (host.hostname !== "127.0.0.1" || !host.port) throw new GenerationError("AI_ACCESS_DENIED");
  return `http://127.0.0.1:${host.port}/auth/callback`;
}

export function startChatGPTSignIn(request: Request, options: ChatGPTDeps = {}) {
  const { directory, now } = deps(options);
  const redirectUri = chatgptRedirectUri(request);
  const pending = { state: random(), nonce: random(), verifier: random(), redirectUri, createdAt: now() };
  const saved = updateConnectionState((current) => ({
    ...current,
    chatgptHostId: current.chatgptHostId ?? `urn:uuid:${crypto.randomUUID()}`,
    chatgptPending: { ...pending, ...(current.chatgptClientId ? { clientId: current.chatgptClientId } : {}) },
  }), directory);
  const url = new URL(AUTHORIZE_URL);
  const params: Record<string, string> = {
    client_id: saved.chatgptClientId ?? DYNAMIC_CLIENT,
    ...(saved.chatgptClientId ? {} : { agent_name_hint: "EduFlow" }),
    ext_agent_host_id: saved.chatgptHostId!,
    response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: CHATGPT_RESOURCE,
    state: pending.state, nonce: pending.nonce,
    code_challenge_method: "S256", code_challenge: pkceChallenge(pending.verifier),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function sameSecret(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function tokenRequest(fetcher: typeof fetch, body: Record<string, string>) {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new GenerationError("PROVIDER_UNAVAILABLE"); }
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, json: json ?? {} };
}

function credentialFrom(json: Record<string, unknown>, base: Pick<ChatGPTCredential, "subject" | "email" | "clientId">, now: number,
  previous?: ChatGPTCredential): ChatGPTCredential {
  const { access_token, refresh_token, id_token, expires_in, scope } = json;
  if (typeof access_token !== "string" || typeof expires_in !== "number") throw new GenerationError("AI_SIGN_IN_REQUIRED");
  const refresh = typeof refresh_token === "string" ? refresh_token : previous?.refreshToken;
  const idToken = typeof id_token === "string" ? id_token : previous?.idToken;
  if (!refresh || !idToken) throw new GenerationError("AI_SIGN_IN_REQUIRED");
  return {
    issuer: CHATGPT_ISSUER, ...base, idToken, accessToken: access_token, refreshToken: refresh,
    expiresAt: now + expires_in * 1000,
    scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : previous?.scopes ?? [],
    savedAt: new Date(now).toISOString(),
  };
}

export type SignInResult = { ok: true; planUsage: boolean } | { ok: false; reason: "denied" | "expired" | "invalid" };

export async function completeChatGPTSignIn(callback: URL, options: ChatGPTDeps = {}): Promise<SignInResult> {
  const { fetch: fetcher, jwks, directory, now } = deps(options);
  const state = readConnectionState(directory);
  const pending = state.chatgptPending;
  const returnedState = callback.searchParams.get("state") ?? "";
  if (!pending || !sameSecret(returnedState, pending.state)) return { ok: false, reason: "invalid" };
  // Each attempt is single use, whatever its outcome.
  updateConnectionState((current) => ({ ...current, chatgptPending: undefined }), directory);
  if (now() - pending.createdAt > PENDING_TTL_MS) return { ok: false, reason: "expired" };
  if (callback.searchParams.get("error")) return { ok: false, reason: "denied" };
  const code = callback.searchParams.get("code");
  const returnedClient = callback.searchParams.get("client_id");
  const clientId = pending.clientId ?? returnedClient;
  if (!code || !clientId || clientId === DYNAMIC_CLIENT || (pending.clientId && returnedClient && returnedClient !== pending.clientId))
    return { ok: false, reason: "invalid" };
  const exchanged = await tokenRequest(fetcher, {
    grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri, resource: CHATGPT_RESOURCE,
  });
  if (!exchanged.ok || typeof exchanged.json.id_token !== "string") return { ok: false, reason: "invalid" };
  let identity: { sub?: string; email?: unknown; nonce?: unknown };
  try {
    ({ payload: identity } = await jwtVerify(exchanged.json.id_token, jwks, { issuer: CHATGPT_ISSUER, audience: clientId, clockTolerance: 60 }));
  } catch { return { ok: false, reason: "invalid" }; }
  if (!identity.sub || typeof identity.nonce !== "string" || !sameSecret(identity.nonce, pending.nonce))
    return { ok: false, reason: "invalid" };
  // A reauthorization must come back as the same account before replacing its tokens.
  if (pending.clientId && state.chatgptSubject && state.chatgptSubject !== identity.sub) return { ok: false, reason: "invalid" };
  const credential = credentialFrom(exchanged.json, {
    subject: identity.sub, clientId, ...(typeof identity.email === "string" ? { email: identity.email } : {}),
  }, now());
  const planUsage = credential.scopes.includes(PLAN_SCOPE);
  updateConnectionState((current) => ({
    ...current, chatgptClientId: clientId, chatgptSubject: identity.sub, chatgpt: credential,
    ...(planUsage ? { provider: "chatgpt" as const } : {}),
  }), directory);
  return { ok: true, planUsage };
}

const refreshing = new Map<string, Promise<string>>();

/** Returns a valid access token, refreshing (once per process) near expiry. */
export async function chatgptAccessToken(options: ChatGPTDeps = {}): Promise<string> {
  const { fetch: fetcher, directory, now } = deps(options);
  const credential = readConnectionState(directory).chatgpt;
  if (!credential || !credential.scopes.includes(PLAN_SCOPE)) throw new GenerationError("AI_SIGN_IN_REQUIRED");
  if (credential.expiresAt - now() > REFRESH_MARGIN_MS) return credential.accessToken;
  const key = `${directory}:${credential.clientId}`;
  const running = refreshing.get(key);
  if (running) return running;
  const refresh = (async () => {
    const result = await tokenRequest(fetcher, {
      grant_type: "refresh_token", client_id: credential.clientId, refresh_token: credential.refreshToken, resource: CHATGPT_RESOURCE,
    });
    if (!result.ok) {
      const code = typeof result.json.error === "string" ? result.json.error : "";
      if (UNUSABLE_REFRESH.has(code)) {
        updateConnectionState((current) => ({ ...current, chatgpt: undefined }), directory);
        throw new GenerationError("AI_SIGN_IN_REQUIRED");
      }
      // Temporary failures keep the stored tokens for a later retry.
      throw new GenerationError(result.status >= 500 ? "PROVIDER_UNAVAILABLE" : "AI_SIGN_IN_REQUIRED");
    }
    const next = credentialFrom(result.json, credential, now(), credential);
    // Access token, expiry, scopes and the rotated refresh token are replaced together.
    updateConnectionState((current) => ({ ...current, chatgpt: next }), directory);
    return next.accessToken;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, refresh);
  return refresh;
}

export async function signOutChatGPT(options: ChatGPTDeps = {}) {
  const { fetch: fetcher, directory } = deps(options);
  const credential = readConnectionState(directory).chatgpt;
  let revoked = !credential;
  if (credential) {
    try {
      const response = await fetcher(REVOKE_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: "refresh_token", client_id: credential.clientId }),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = response.ok;
    } catch { revoked = false; }
  }
  // The client ID, account mapping and host ID stay for the next sign-in.
  updateConnectionState((current: ConnectionState) => ({
    ...current, chatgpt: undefined, chatgptPending: undefined, provider: current.provider === "chatgpt" ? "demo" : current.provider,
  }), directory);
  return { revoked };
}

export async function listChatGPTModels(options: ChatGPTDeps = {}) {
  const token = await chatgptAccessToken(options);
  let response: Response;
  try {
    response = await deps(options).fetch(`${CHATGPT_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new GenerationError("PROVIDER_UNAVAILABLE"); }
  if (response.status === 401) throw new GenerationError("AI_SIGN_IN_REQUIRED");
  if (!response.ok) throw new GenerationError("PROVIDER_UNAVAILABLE");
  const body = await response.json().catch(() => null) as { models?: unknown } | null;
  if (!body || !Array.isArray(body.models)) throw new GenerationError("PROVIDER_UNAVAILABLE");
  return body.models.flatMap((model) => {
    const { slug, display_name, visibility } = (model ?? {}) as Record<string, unknown>;
    return typeof slug === "string" && slug.length <= 100 && visibility === "list"
      ? [{ slug, name: typeof display_name === "string" ? display_name.slice(0, 100) : slug }] : [];
  }).slice(0, 50);
}
