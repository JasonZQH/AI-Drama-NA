import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * provider 凭据的对称加密（AES-256-GCM）。
 *
 * ## 为什么加密而不是明文存库
 *
 * 明文落库意味着**任何一份 `pg_dump` 就是一次泄露**——备份、`.data/pg` 目录、
 * 误提交的 dump 文件、将来接的托管数据库快照，每一处都变成密钥副本。加密之后
 * 泄露面缩到「能读 `CREDENTIAL_SECRET` 的人」，而那个人本来就已经能读 `.env`
 * 里的 key 了，所以这不是把问题搬家，是把面积改小。
 *
 * ## 为什么是 GCM 而不是 CBC
 *
 * GCM 自带认证标签：密文被改过，`decrypt` 会抛，而不是解出一段垃圾再被当成
 * API key 发出去。CBC 需要另外自己拼 HMAC，拼错了就是静默失效。
 *
 * ## 没配 `CREDENTIAL_SECRET` 时**拒绝存**，不降级成明文
 *
 * 「配置缺失就静默降级」是这类功能最常见的坏结局：功能看起来能用，安全性
 * 却已经没了，而没有任何一处会告诉你。所以缺就报错，报错里直说怎么补。
 */

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // GCM 的标准长度，96 位
const TAG_BYTES = 16

/**
 * 密钥派生。`CREDENTIAL_SECRET` 是人手写的字符串，长度和熵都不受控，
 * 不能直接当 32 字节密钥用。scrypt 把它拉成定长，并让暴力枚举变贵。
 *
 * salt 固定：这里只有一个密钥、不存在「同一口令派生多个不同密钥」的需求，
 * 而随机 salt 要额外存一份、多一处能弄丢的东西。scrypt 的成本参数才是这里
 * 真正起作用的部分。
 */
function keyFrom(secret: string): Buffer {
  return scryptSync(secret, 'ai-drama-credentials-v1', 32)
}

export class CredentialSecretMissing extends Error {
  constructor() {
    super(
      '没有配 CREDENTIAL_SECRET，凭据无法加密存储。在仓库根的 .env 里加上一行随机串（例如 `openssl rand -hex 32` 的输出）再重启控制面。不配就不存——明文落库等于每一份数据库备份都是一次泄露。',
    )
    this.name = 'CredentialSecretMissing'
  }
}

export function credentialKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env['CREDENTIAL_SECRET']
  if (!secret || secret.trim() === '') throw new CredentialSecretMissing()
  return keyFrom(secret)
}

/** 密文格式：`base64(iv | tag | ciphertext)`。三段定长在前，解析不需要分隔符 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

export function decrypt(packed: string, key: Buffer): string {
  const buf = Buffer.from(packed, 'base64')
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('密文长度不足，数据已损坏')
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ct = buf.subarray(IV_BYTES + TAG_BYTES)
  const d = createDecipheriv(ALGO, key, iv)
  d.setAuthTag(tag)
  // 认证失败时 final() 抛 —— 密文被改过就到不了这一行
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

/**
 * 展示用掩码。**明文一个字符都不出库**——`guardWrites` 只守非 GET，
 * 所以 `GET /api/keys` 是不设防的，任何能碰到 :4000 的东西都读得到它。
 *
 * 保留前缀是为了让人认出这是哪一家的 key（`sk-or-v1-` 是 OpenRouter 的），
 * 保留末四位是为了和你手上那张纸/密码管理器里的记录对得上。
 */
export function mask(key: string): string {
  const t = key.trim()
  if (t.length <= 8) return '****'
  const head = t.slice(0, Math.min(12, t.length - 4))
  return `${head}${'*'.repeat(4)}${t.slice(-4)}`
}

export const last4 = (key: string): string => key.trim().slice(-4)

/** 常量时间比较。用在「这次提交的 key 和库里那把是不是同一把」上 */
export function sameKey(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
