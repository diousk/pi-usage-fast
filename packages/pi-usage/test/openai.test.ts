import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { OAuthCredentialCandidateReader } from "../src/oauth-credential-source.js";
import { adapterForProvider, resolveUsageAuth } from "../src/query.js";

test.each([true, false])(
  "OpenAI usage provides the correct management destination without a quota request (ChatGPT=%s)",
  async (subscription) => {
    const model = {
      provider: "openai",
      id: "gpt-6.1-sol",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const credential = {
      type: "oauth",
      access: "active-token",
      refresh: "refresh",
      expires: Date.now() + 60_000,
      scopes: ["chatgpt.tokens.use.direct"],
    };
    const adapter = adapterForProvider("openai");
    assert.ok(adapter);
    const ctx = {
      model,
      modelRegistry: {
        getAvailable: () => [model],
        getAll: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "active-token" }),
        getProviderAuth: async () => ({ auth: { apiKey: "active-token" }, source: "stored credential" }),
      },
    };
    const auth = await resolveUsageAuth(ctx as never, adapter, undefined, () =>
      subscription ? credential : { type: "api_key", key: "active-token" },
    );
    assert.ok(auth);
    const fetch = vi.fn(() => {
      throw new Error("No usage endpoint is authorized for this token");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const report = await adapter.query(auth, new AbortController().signal, 1000);
      assert.equal(report.semantics.kind, subscription ? "consumer-subscription" : "api-key");
      assert.equal(report.buckets.length, 0);
      assert.equal(report.metrics.length, 0);
      assert.ok(
        report.notes?.some((note) =>
          note.includes(subscription ? "https://chatgpt.com/settings/usage" : "https://platform.openai.com/usage"),
        ),
      );
      assert.equal(fetch.mock.calls.length, 0);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test("OpenAI usage rejects proxy endpoints before resolving credentials", async () => {
  const adapter = adapterForProvider("openai");
  assert.ok(adapter);
  await assert.rejects(
    resolveUsageAuth({ model: { provider: "openai", baseUrl: "https://proxy.example" } } as never, adapter),
    /custom provider base URL/,
  );
});

test.each(["mismatched token", "missing scope", "discovery failure", "readiness failure"] as const)(
  "OpenAI OAuth usage fails closed on %s",
  async (failure) => {
    const model = {
      provider: "openai",
      id: "gpt-6.1-sol",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const resolveModelAuth = vi.fn(async () => ({ ok: true, apiKey: "active-token" }));
    const ctx = {
      model,
      modelRegistry: {
        getAvailable: () => [model],
        getAll: () => [model],
        getApiKeyAndHeaders: resolveModelAuth,
        getProviderAuth: async () => ({ auth: { apiKey: "active-token" }, source: "OAuth" }),
      },
    };
    const candidates = vi.fn<OAuthCredentialCandidateReader>(() =>
      failure === "discovery failure"
        ? { ok: false }
        : {
            ok: true,
            candidates: [
              {
                type: "oauth",
                access: failure === "mismatched token" ? "other-token" : "active-token",
                refresh: "refresh",
                expires: Date.now() + 60_000,
                scopes: failure === "missing scope" ? [] : ["chatgpt.tokens.use.direct"],
              },
            ],
          },
    );
    const reader: OAuthCredentialCandidateReader = candidates;
    reader.waitUntilReady = async () => failure !== "readiness failure";
    const adapter = adapterForProvider("openai");
    assert.ok(adapter);
    await assert.rejects(
      resolveUsageAuth(ctx as never, adapter, undefined, () => undefined, reader),
      failure === "discovery failure"
        ? /discovery failed closed/
        : failure === "readiness failure"
          ? /readiness failed closed/
          : /does not match an available ChatGPT plan credential/,
    );
    if (failure === "readiness failure") {
      assert.equal(resolveModelAuth.mock.calls.length, 0);
      assert.equal(candidates.mock.calls.length, 0);
    }
  },
);
