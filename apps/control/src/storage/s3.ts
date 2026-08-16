import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'

/**
 * 存储层（10-media-storage.md、ADR-0004）。
 *
 * **代码里永远只有 S3 SDK，没有 fs.writeFile。** 本地 MinIO 提供 S3 API，
 * 将来换云存储是改一个 endpoint 的事，而不是重写整个媒体层。
 *
 * 两个 endpoint 必须分开：控制面自用走 internal，签给 worker / 浏览器的
 * URL 走 public——远程 GPU 场景下签出 localhost 是最常见的集成失败
 * （09-python-worker.md §5.1）。
 */

export interface StorageConfig {
  readonly bucket: string
  readonly internalEndpoint: string
  readonly publicEndpoint: string
  readonly accessKey: string
  readonly secretKey: string
  readonly forcePathStyle: boolean
}

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const need = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`${k} 未设置`)
    return v
  }
  return {
    bucket: need('S3_BUCKET'),
    internalEndpoint: need('S3_INTERNAL_ENDPOINT'),
    publicEndpoint: env['S3_PUBLIC_ENDPOINT'] ?? need('S3_INTERNAL_ENDPOINT'),
    accessKey: need('S3_ACCESS_KEY'),
    secretKey: need('S3_SECRET_KEY'),
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
  }
}

function client(cfg: StorageConfig, endpoint: string): S3Client {
  return new S3Client({
    region: 'us-east-1', // MinIO 不关心，但 SDK 必填
    endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  })
}

export class Storage {
  private readonly internal: S3Client
  private readonly external: S3Client

  constructor(private readonly cfg: StorageConfig) {
    this.internal = client(cfg, cfg.internalEndpoint)
    this.external = client(cfg, cfg.publicEndpoint)
  }

  /**
   * 上传并返回内容哈希。sha256 边传边算，不把整个文件读进内存——
   * 单条 take 只有几 MB，但母版是几十 MB，习惯要从一开始就对。
   */
  async putFile(key: string, filePath: string, mime: string): Promise<{ sha256: string; bytes: number }> {
    const { size } = await stat(filePath)

    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
    const sha256 = hash.digest('hex')

    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: mime,
        ContentLength: size,
      }),
    )
    return { sha256, bytes: size }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.internal.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      return true
    } catch {
      return false
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    const r = await this.internal.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
    const chunks: Buffer[] = []
    for await (const c of r.Body as Readable) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  /**
   * 签给外部（浏览器 / worker / provider）的 URL 必须用 public endpoint。
   * 控制面绝不代理媒体字节流——它只签 URL、只搬元数据（10 §1.2）。
   */
  presignGet(key: string, ttlSec = 900): Promise<string> {
    return getSignedUrl(this.external, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: ttlSec,
    })
  }

  presignPut(key: string, ttlSec = 3600): Promise<string> {
    return getSignedUrl(this.external, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: ttlSec,
    })
  }
}

/** S3 key 命名规范（02-data-model.md §5）：可读、可批量清理、天然分片 */
export const s3Key = {
  ref: (projectId: string, characterId: string, assetId: string) =>
    `projects/${projectId}/refs/${characterId}/${assetId}.png`,
  take: (projectId: string, shotId: string, jobId: string) =>
    `projects/${projectId}/takes/${shotId}/${jobId}.mp4`,
  audio: (projectId: string, shotId: string, assetId: string) =>
    `projects/${projectId}/audio/${shotId}/${assetId}.wav`,
  normalized: (projectId: string, episodeId: string, takeId: string) =>
    `projects/${projectId}/renders/${episodeId}/normalized/${takeId}.mp4`,
  master: (projectId: string, episodeId: string, v: number) =>
    `projects/${projectId}/renders/${episodeId}/v${v}/master.mp4`,
}
