import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { readDeepSeekAccountUsage } from "./deepseek-usage.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function home(issuer = "https://platform.deepseek.com") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bb-deepseek-test-"));
  dirs.push(dir);
  await writeFile(
    path.join(dir, ".credentials.yaml"),
    stringify({
      records: {
        "deepseek-account-platform/default": {
          kind: "grant",
          payload: { version: 1, token: "test-token", issuer },
        },
      },
    }),
  );
  return dir;
}
const envelope = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      normal_wallets: [{ currency: "USD", balance: "5.0000000000000000" }],
      bonus_wallets: [{ currency: "CNY", balance: "0E-16" }],
    },
  },
};

describe("DeepSeek Harness account usage", () => {
  it("collects recharge and bonus wallets while keeping the grant on the host", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json(envelope),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await readDeepSeekAccountUsage({ DSH_HOME: await home() });
    expect(result).toEqual({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: "Harness account",
        windows: [],
        balances: [
          {
            label: "Recharge balance",
            currency: "USD",
            amount: "5.0000000000000000",
          },
          { label: "Bonus balance", currency: "CNY", amount: "0E-16" },
        ],
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://platform.deepseek.com/api/v0/users/get_user_summary",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-dsh-auth-token": "test-token" },
      redirect: "error",
    });
    expect(JSON.stringify(result)).not.toContain("test-token");
  });
  it("rejects unknown issuers before sending credentials", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await readDeepSeekAccountUsage({
        DSH_HOME: await home("https://other.example"),
      }),
    ).toMatchObject({ usage: { status: "error" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not attribute an old 401 to a replacement grant", async () => {
    const dir = await home();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await writeFile(
          path.join(dir, ".credentials.yaml"),
          stringify({
            records: {
              "deepseek-account-platform/default": {
                kind: "grant",
                payload: {
                  version: 1,
                  token: "replacement-token",
                  issuer: "https://platform.deepseek.com",
                },
              },
            },
          }),
        );
        return new Response(null, { status: 401 });
      }),
    );
    expect(await readDeepSeekAccountUsage({ DSH_HOME: dir })).toMatchObject({
      usage: { status: "error" },
    });
  });
  it("distinguishes absent and expired credentials and malformed responses", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "bb-deepseek-test-"));
    dirs.push(empty);
    expect(await readDeepSeekAccountUsage({ DSH_HOME: empty })).toEqual({
      supported: true,
      usage: { status: "unauthenticated" },
    });
    const dir = await home();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    expect(await readDeepSeekAccountUsage({ DSH_HOME: dir })).toEqual({
      supported: true,
      usage: { status: "expired" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...envelope,
          data: {
            ...envelope.data,
            biz_data: {
              normal_wallets: [{ currency: "USD", balance: "NaN" }],
              bonus_wallets: [],
            },
          },
        }),
      ),
    );
    expect(await readDeepSeekAccountUsage({ DSH_HOME: dir })).toMatchObject({
      usage: { status: "error" },
    });
  });
});
