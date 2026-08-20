import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { credentialKeyFromEnv, decrypt, encrypt, last4 } from './crypto.js'

/**
 * provider 凭据的读写。
 *
 * **明文只在这个模块里出现。** 对外只给 `resolve()`（拿去发请求）与
 * `list()`（拿去展示，只有掩码信息）。路由层永远拿不到密钥字符串——
 * `guardWrites` 只守非 GET，`GET /api/keys` 是不设防的，一次疏忽就是泄露。
 */

export type ProviderId = 'openrouter'

export interface CredentialRow {
  readonly provider: string
  readonly label: string | null
  readonly last4: string
  readonly verifiedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export async function listCredentials(db: Db): Promise<CredentialRow[]> {
  return db
    .select({
      provider: s.providerCredentials.provider,
      label: s.providerCredentials.label,
      last4: s.providerCredentials.last4,
      verifiedAt: s.providerCredentials.verifiedAt,
      createdAt: s.providerCredentials.createdAt,
      updatedAt: s.providerCredentials.updatedAt,
    })
    .from(s.providerCredentials)
}

export async function upsertCredential(
  db: Db,
  input: { provider: string; key: string; label?: string | null; verified: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialRow> {
  const mk = credentialKeyFromEnv(env)
  const row = {
    provider: input.provider,
    ciphertext: encrypt(input.key.trim(), mk),
    last4: last4(input.key),
    label: input.label ?? null,
    verifiedAt: input.verified ? new Date() : null,
    updatedAt: new Date(),
  }
  const [out] = await db
    .insert(s.providerCredentials)
    .values(row)
    // 一个 provider 一行：换一把就是覆盖，不留历史
    .onConflictDoUpdate({ target: s.providerCredentials.provider, set: row })
    .returning({
      provider: s.providerCredentials.provider,
      label: s.providerCredentials.label,
      last4: s.providerCredentials.last4,
      verifiedAt: s.providerCredentials.verifiedAt,
      createdAt: s.providerCredentials.createdAt,
      updatedAt: s.providerCredentials.updatedAt,
    })
  return out!
}

export async function deleteCredential(db: Db, provider: string): Promise<boolean> {
  const rows = await db
    .delete(s.providerCredentials)
    .where(eq(s.providerCredentials.provider, provider))
    .returning({ provider: s.providerCredentials.provider })
  return rows.length > 0
}

/**
 * 取出可用的密钥明文。**库优先于 env。**
 *
 * 顺序这么定是因为面板里改完的那把才是人最后一次表达的意图；env 退化成
 * 「还没用过面板时的初始值」。两处都没有就返回 null，由调用方给出可行动的报错。
 *
 * 解密失败（`CREDENTIAL_SECRET` 换过了、密文损坏）不吞：那说明库里的东西已经
 * 不可用，静默回落到 env 会让人以为面板里存的那把在生效。
 */
export async function resolveKey(
  db: Db,
  provider: ProviderId,
  /**
   * **回落来源**，不是解密密钥的来源。
   *
   * 这两件事分开：`CREDENTIAL_SECRET` 是进程级的基础设施配置（部署给的），
   * 永远取 `process.env`；而「`.env` 里有没有 `OPENROUTER_API_KEY`」是可以被
   * 调用方替换的输入。第一版把两者绑在同一个参数上，结果传一个只含
   * `OPENROUTER_API_KEY` 的对象进来就会因为「没有 CREDENTIAL_SECRET」而抛。
   */
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const [row] = await db
    .select({ ciphertext: s.providerCredentials.ciphertext })
    .from(s.providerCredentials)
    .where(eq(s.providerCredentials.provider, provider))
  if (row) return decrypt(row.ciphertext, credentialKeyFromEnv())
  return fallbackEnv[ENV_VAR[provider]] ?? null
}

/** 各家在 `.env` 里的变量名。面板存的东西优先，这里是回落 */
export const ENV_VAR: Record<ProviderId, string> = {
  openrouter: 'OPENROUTER_API_KEY',
}
