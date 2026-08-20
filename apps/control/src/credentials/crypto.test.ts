import { describe, expect, it } from 'vitest'
import {
  CredentialSecretMissing,
  credentialKeyFromEnv,
  decrypt,
  encrypt,
  last4,
  mask,
  sameKey,
} from './crypto.js'

const KEY = credentialKeyFromEnv({ CREDENTIAL_SECRET: 'test-secret' } as NodeJS.ProcessEnv)
const SAMPLE = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd'

describe('凭据加密', () => {
  it('往返一致', () => {
    expect(decrypt(encrypt(SAMPLE, KEY), KEY)).toBe(SAMPLE)
  })

  /** 同一明文两次加密必须不同，否则密文本身就泄露「这两条是同一把 key」 */
  it('每次加密的密文都不同（随机 IV）', () => {
    const a = encrypt(SAMPLE, KEY)
    const b = encrypt(SAMPLE, KEY)
    expect(a).not.toBe(b)
    expect(decrypt(a, KEY)).toBe(decrypt(b, KEY))
  })

  it('密文里不含明文的任何一段', () => {
    const packed = encrypt(SAMPLE, KEY)
    expect(packed).not.toContain('sk-or')
    expect(Buffer.from(packed, 'base64').toString('utf8')).not.toContain('sk-or')
  })

  /**
   * GCM 的认证标签就是为这条存在的：密文被改过要**抛**，
   * 而不是解出一段垃圾再被当成 API key 发出去。
   */
  it('密文被篡改会抛，不会静默解出垃圾', () => {
    const buf = Buffer.from(encrypt(SAMPLE, KEY), 'base64')
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff
    expect(() => decrypt(buf.toString('base64'), KEY)).toThrow()
  })

  it('换一把 secret 解不开', () => {
    const other = credentialKeyFromEnv({ CREDENTIAL_SECRET: '另一个' } as NodeJS.ProcessEnv)
    expect(() => decrypt(encrypt(SAMPLE, KEY), other)).toThrow()
  })

  it('截断的密文不会越界读，直接报损坏', () => {
    expect(() => decrypt(Buffer.from([1, 2, 3]).toString('base64'), KEY)).toThrow(/损坏/)
  })

  /**
   * 「配置缺失就静默降级成明文」是这类功能最常见的坏结局：功能看起来能用，
   * 安全性已经没了，而没有任何一处会告诉你。
   */
  it('没配 CREDENTIAL_SECRET 就抛，且报错里说清怎么补', () => {
    for (const env of [{}, { CREDENTIAL_SECRET: '' }, { CREDENTIAL_SECRET: '   ' }]) {
      expect(() => credentialKeyFromEnv(env as NodeJS.ProcessEnv)).toThrow(CredentialSecretMissing)
    }
    try {
      credentialKeyFromEnv({} as NodeJS.ProcessEnv)
    } catch (e) {
      expect((e as Error).message).toMatch(/CREDENTIAL_SECRET/)
      expect((e as Error).message, '要说清去哪儿加、怎么生成').toMatch(/\.env/)
      expect((e as Error).message).toMatch(/openssl rand/)
    }
  })
})

describe('掩码', () => {
  it('保留前缀与末四位，中间抹掉', () => {
    const m = mask(SAMPLE)
    expect(m.startsWith('sk-or-v1-')).toBe(true)
    expect(m.endsWith('abcd')).toBe(true)
    expect(m, '掩码里不该出现原文中段').not.toContain('0123456789abcdef0123')
    expect(m.length, '掩码不该泄露原文长度').toBeLessThan(SAMPLE.length)
  })

  it('短串整个抹掉，不给猜的余地', () => {
    expect(mask('abc')).toBe('****')
    expect(mask('12345678')).toBe('****')
  })

  it('last4 就是末四位', () => {
    expect(last4(SAMPLE)).toBe('abcd')
  })
})

describe('常量时间比较', () => {
  it('同串为真，不同串为假，长度不同也不抛', () => {
    expect(sameKey('abc', 'abc')).toBe(true)
    expect(sameKey('abc', 'abd')).toBe(false)
    expect(sameKey('abc', 'abcd')).toBe(false)
    expect(sameKey('', '')).toBe(true)
  })
})
