import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ProviderUsageResult } from "@bb/provider-bridge-protocol";

const ORIGIN = "https://platform.deepseek.com";
const MAX_BYTES = 65_536;
const grantSchema = z.object({
  records: z.record(z.string(), z.unknown()),
});
const accountSchema = z.object({
  kind: z.literal("grant"),
  payload: z.object({
    version: z.literal(1),
    token: z.string().regex(/^[\x21-\x7e]+$/),
    issuer: z.literal(ORIGIN),
  }),
});
const amountSchema = z
  .string()
  .max(128)
  .regex(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i);
const walletSchema = z.object({
  currency: z.enum(["USD", "CNY"]),
  balance: amountSchema,
});
const responseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    biz_code: z.literal(0),
    biz_data: z.object({
      normal_wallets: z.array(walletSchema).max(50),
      bonus_wallets: z.array(walletSchema).max(50),
    }),
  }),
});

async function accountGrant(file: string): Promise<string | null> {
  try {
    if ((await stat(file)).size > MAX_BYTES) throw new Error("oversized");
    const parsed = grantSchema.parse(
      parse(await readFile(file, "utf8"), { maxAliasCount: 0 }),
    );
    const record = parsed.records["deepseek-account-platform/default"];
    if (record === undefined) return null;
    return accountSchema.parse(record).payload.token;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error("DeepSeek Harness credentials could not be read.");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error("oversized response");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function readDeepSeekAccountUsage(
  env: NodeJS.ProcessEnv,
): Promise<ProviderUsageResult> {
  const file = path.join(
    env.DSH_HOME || path.join(os.homedir(), ".dsh"),
    ".credentials.yaml",
  );
  try {
    const token = await accountGrant(file);
    if (!token)
      return { supported: true, usage: { status: "unauthenticated" } };
    const response = await fetch(`${ORIGIN}/api/v0/users/get_user_summary`, {
      headers: {
        "x-dsh-auth-token": token,
        "x-client-platform":
          process.platform === "darwin"
            ? "desktop-mac"
            : process.platform === "win32"
              ? "desktop-win"
              : "web",
        "x-client-locale": "en_US",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      if ((await accountGrant(file)) !== token)
        throw new Error("credential changed");
      return { supported: true, usage: { status: "expired" } };
    }
    if (!response.ok) throw new Error("request failed");
    const raw = await boundedJson(response);
    if (z.object({ code: z.literal(40003) }).safeParse(raw).success) {
      if ((await accountGrant(file)) !== token)
        throw new Error("credential changed");
      return { supported: true, usage: { status: "expired" } };
    }
    const summary = responseSchema.parse(raw).data.biz_data;
    if ((await accountGrant(file)) !== token)
      throw new Error("credential changed");
    return {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: "Harness account",
        windows: [],
        balances: [
          ...summary.normal_wallets.map((wallet) => ({
            label: "Recharge balance",
            currency: wallet.currency,
            amount: wallet.balance,
          })),
          ...summary.bonus_wallets.map((wallet) => ({
            label: "Bonus balance",
            currency: wallet.currency,
            amount: wallet.balance,
          })),
        ],
      },
    };
  } catch {
    return {
      supported: true,
      usage: {
        status: "error",
        message: "DeepSeek Harness balance could not be loaded.",
        accountEmail: null,
        planLabel: null,
      },
    };
  }
}
