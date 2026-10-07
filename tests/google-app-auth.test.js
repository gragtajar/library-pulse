// @ts-check
/**
 * The app's own Google token: which credential source the environment
 * selects, where Vercel's OIDC token is read from, and how failures surface.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
  return {
    libraryToken: /** @type {import("vitest").Mock} */ (/** @type {unknown} */ (null)),
  };
});

vi.mock("@vercel/oidc", () => {
  h.libraryToken = vi.fn(async () => "lib.token.value");
  return { getVercelOidcToken: h.libraryToken };
});

import {
  AppAuthError,
  _resetAppAuthClient,
  appAuthMode,
  getAppAccessToken,
  rememberVercelOidcToken,
  vercelSubjectToken,
} from "../backend/lib/google-app-auth.js";

const WIF_ENV = {
  GCP_PROJECT_NUMBER: "33343489691",
  GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel",
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel",
  GCP_SERVICE_ACCOUNT_EMAIL: "library-pulse-chat@library-pulse-510320.iam.gserviceaccount.com",
};

beforeEach(() => {
  _resetAppAuthClient();
  h.libraryToken.mockClear();
  for (const k of [...Object.keys(WIF_ENV), "GOOGLE_SERVICE_ACCOUNT_KEY"]) delete process.env[k];
});

describe("vercelSubjectToken", () => {
  it("uses the token Vercel put on the request, without asking the library", async () => {
    rememberVercelOidcToken({ "x-vercel-oidc-token": "aaa.bbb.ccc" });
    expect(await vercelSubjectToken()).toBe("aaa.bbb.ccc");
    expect(h.libraryToken).not.toHaveBeenCalled();
  });

  it("keeps the newest token when requests overlap", async () => {
    rememberVercelOidcToken({ "x-vercel-oidc-token": "one.one.one" });
    rememberVercelOidcToken({ "x-vercel-oidc-token": ["two.two.two"] });
    expect(await vercelSubjectToken()).toBe("two.two.two");
  });

  it("ignores a missing or malformed header and falls back to the library", async () => {
    rememberVercelOidcToken(undefined);
    rememberVercelOidcToken({});
    rememberVercelOidcToken({ "x-vercel-oidc-token": "not a jwt" });
    rememberVercelOidcToken({ "x-vercel-oidc-token": "a.b" });
    rememberVercelOidcToken({ "x-vercel-oidc-token": `${"a".repeat(9000)}.b.c` });
    expect(await vercelSubjectToken()).toBe("lib.token.value");
    expect(h.libraryToken).toHaveBeenCalledTimes(1);
  });

  it("a malformed header never replaces a good one", async () => {
    rememberVercelOidcToken({ "x-vercel-oidc-token": "good.good.good" });
    rememberVercelOidcToken({ "x-vercel-oidc-token": "<script>" });
    expect(await vercelSubjectToken()).toBe("good.good.good");
  });
});

describe("appAuthMode", () => {
  it("prefers a key, then federation, else nothing", () => {
    expect(appAuthMode()).toBeNull();
    Object.assign(process.env, WIF_ENV);
    expect(appAuthMode()).toBe("wif");
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "{}";
    expect(appAuthMode()).toBe("key");
  });

  it("needs all four federation settings", () => {
    Object.assign(process.env, WIF_ENV);
    delete process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    expect(appAuthMode()).toBeNull();
  });
});

describe("getAppAccessToken", () => {
  it("returns the client's token", async () => {
    const client = /** @type {any} */ ({ getAccessToken: async () => ({ token: "ya29.x" }) });
    expect(await getAppAccessToken({ client })).toBe("ya29.x");
  });

  it("reports an unconfigured environment distinctly", async () => {
    await expect(getAppAccessToken()).rejects.toMatchObject({ code: "app_auth_unconfigured" });
  });

  it("wraps a failed exchange as app_auth_failed, keeping the reason", async () => {
    const client = /** @type {any} */ ({
      getAccessToken: async () => {
        throw new Error("Permission 'iam.serviceAccounts.getAccessToken' denied");
      },
    });
    const err = await getAppAccessToken({ client }).catch((e) => e);
    expect(err).toBeInstanceOf(AppAuthError);
    expect(err.code).toBe("app_auth_failed");
    expect(err.detail).toMatch(/getAccessToken/);
  });

  it("treats an empty token as a failure", async () => {
    const client = /** @type {any} */ ({ getAccessToken: async () => ({ token: null }) });
    await expect(getAppAccessToken({ client })).rejects.toMatchObject({ code: "empty_token" });
  });

  it("builds a federation client that reads the subject token from the request", async () => {
    Object.assign(process.env, WIF_ENV);
    rememberVercelOidcToken({ "x-vercel-oidc-token": "req.uest.token" });
    // No network: the client is stubbed; check what it was built with, and
    // that its subject-token supplier returns the request's token.
    const { ExternalAccountClient } = await import("google-auth-library");
    const spy = vi
      .spyOn(ExternalAccountClient, "fromJSON")
      .mockImplementation(
        () => /** @type {any} */ ({ getAccessToken: async () => ({ token: "ya29.fake" }) }),
      );
    expect(await getAppAccessToken()).toBe("ya29.fake");
    const options = /** @type {any} */ (spy.mock.calls[0][0]);
    expect(options.audience).toBe(
      "//iam.googleapis.com/projects/33343489691/locations/global/workloadIdentityPools/vercel/providers/vercel",
    );
    expect(options.service_account_impersonation_url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/library-pulse-chat@library-pulse-510320.iam.gserviceaccount.com:generateAccessToken",
    );
    expect(await options.subject_token_supplier.getSubjectToken()).toBe("req.uest.token");
    spy.mockRestore();
  });
});
