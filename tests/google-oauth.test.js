// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GOOGLE_OAUTH_SCOPES,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleRedirectUri,
  hasRequiredGoogleScopes,
  refreshGoogleAccessToken,
} from "../backend/lib/google-oauth.js";
import { UpstreamError } from "../backend/lib/errors.js";

const STATE = "6f1c1b4e-6d0b-4a2e-9d1c-0b1c2d3e4f50";

/** @param {number} status @param {unknown} body */
const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.LOG_LEVEL = "error";
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_PUBLIC_URL = "https://updates.rajatg.in/";
  process.env.PUBLIC_URL = "https://library-pulse.vercel.app";
});
afterEach(() => vi.unstubAllGlobals());

describe("the authorize URL", () => {
  it("names the client, the registered redirect URI, every scope, offline access and the state", () => {
    const url = new URL(buildGoogleAuthorizeUrl(STATE));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://updates.rajatg.in/api/gchat/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_OAUTH_SCOPES);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("state")).toBe(STATE);
  });

  it("asks for exactly the two Chat scopes plus identity, nothing sensitive beyond them", () => {
    expect(GOOGLE_OAUTH_SCOPES).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.memberships.app",
    ]);
  });

  it("uses the Google-facing origin, falling back to PUBLIC_URL", () => {
    expect(googleRedirectUri()).toBe("https://updates.rajatg.in/api/gchat/callback");
    delete process.env.GOOGLE_PUBLIC_URL;
    expect(googleRedirectUri()).toBe("https://library-pulse.vercel.app/api/gchat/callback");
  });

  it("refuses to build without the client id", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => buildGoogleAuthorizeUrl(STATE)).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe("token exchange", () => {
  it("posts the code with the secret and the same redirect URI, and returns the tokens", async () => {
    const fetchMock = vi.fn(async () =>
      reply(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3599,
        scope: GOOGLE_OAUTH_SCOPES.join(" "),
        id_token: "idt",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await exchangeGoogleCode("the-code");
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3599,
      scope: GOOGLE_OAUTH_SCOPES.join(" "),
      idToken: "idt",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe("https://updates.rajatg.in/api/gchat/callback");
  });

  it("fails loudly when Google rejects the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(400, { error: "invalid_grant" })),
    );
    await expect(exchangeGoogleCode("bad")).rejects.toThrow(UpstreamError);
  });
});

describe("token refresh", () => {
  it("returns a fresh access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { access_token: "at2", expires_in: 3600 })),
    );
    expect(await refreshGoogleAccessToken("rt")).toEqual({ accessToken: "at2", expiresIn: 3600 });
  });

  it("reports a revoked grant distinctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(400, { error: "invalid_grant" })),
    );
    await expect(refreshGoogleAccessToken("rt")).rejects.toThrow(/google_revoked/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(500, { error: "server_error" })),
    );
    await expect(refreshGoogleAccessToken("rt")).rejects.toThrow(/google_refresh_failed/);
  });
});

describe("granted scopes", () => {
  it("needs both Chat scopes, in any order, and ignores identity scopes", () => {
    expect(hasRequiredGoogleScopes(GOOGLE_OAUTH_SCOPES.join(" "))).toBe(true);
    expect(
      hasRequiredGoogleScopes(
        "https://www.googleapis.com/auth/chat.memberships.app https://www.googleapis.com/auth/chat.spaces.readonly",
      ),
    ).toBe(true);
    expect(
      hasRequiredGoogleScopes("openid email https://www.googleapis.com/auth/chat.spaces.readonly"),
    ).toBe(false);
    expect(hasRequiredGoogleScopes("")).toBe(false);
  });
});
