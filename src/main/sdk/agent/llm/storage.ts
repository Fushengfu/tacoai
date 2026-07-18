/**
 * LLM 客户端 - 文件上传到云存储
 * 
 * 支持阿里云 OSS / 七牛云 / 网关后台 API 三种上传方式。
 */

import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { registerFileToGateway } from '../shared/storage-register'
import type { ProviderConfig } from './types'
import {
  readResponseTextSafe,
  buildStorageObjectKey,
  buildPublicUrl,
  toUrlSafeBase64,
  resolveQiniuRegionUploadUrl,
  normalizeObjectPrefix,
} from './utils'
import { llmLog } from './providers'

/* ------------------------------------------------------------------ */
/*  类型                                                               */
/* ------------------------------------------------------------------ */

export type ResolvedAliyunOssUploadConfig = {
  provider: 'aliyun_oss'
  accessKeyId: string
  accessKeySecret: string
  bucket: string
  endpoint: string
  objectPrefix: string
  publicBaseUrl: string
}

export type ResolvedQiniuUploadConfig = {
  provider: 'qiniu'
  accessKey: string
  secretKey: string
  bucket: string
  uploadUrl: string
  objectPrefix: string
  publicBaseUrl: string
  expiresSeconds: number
}

export type ResolvedUploadConfig = ResolvedAliyunOssUploadConfig | ResolvedQiniuUploadConfig

const GATEWAY_UPLOAD_BASE = 'https://agent.bjctykj.com'

/* ------------------------------------------------------------------ */
/*  配置解析                                                            */
/* ------------------------------------------------------------------ */

export function resolveUploadConfig(_config: ProviderConfig): ResolvedUploadConfig | null {
  // 统一走网关 API，不再使用本地配置
  return null
}

/* ------------------------------------------------------------------ */
/*  阿里云 OSS 上传                                                      */
/* ------------------------------------------------------------------ */

async function uploadLocalFileToAliyunOss(
  config: ResolvedAliyunOssUploadConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readFile(filePath)
  const fileName = basename(filePath)
  const key = buildStorageObjectKey(filePath, config.objectPrefix)
  const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const policyText = JSON.stringify({
    expiration,
    conditions: [
      ['starts-with', '$key', normalizeObjectPrefix(config.objectPrefix)],
      ['content-length-range', 0, 1024 * 1024 * 200],
    ],
  })
  const policy = Buffer.from(policyText).toString('base64')
  const signature = createHmac('sha1', config.accessKeySecret).update(policy).digest('base64')
  const formData = new FormData()
  formData.append('key', key)
  formData.append('policy', policy)
  formData.append('OSSAccessKeyId', config.accessKeyId)
  formData.append('Signature', signature)
  formData.append('success_action_status', '200')
  formData.append('file', new Blob([bytes]), fileName)
  const response = await fetch(config.endpoint, {
    method: 'POST',
    body: formData,
    signal,
  })
  if (!response.ok) {
    const rawText = await readResponseTextSafe(response)
    throw new Error(`Aliyun OSS upload failed: ${response.status} ${response.statusText} ${rawText}`)
  }
  return buildPublicUrl(config.publicBaseUrl, key)
}

/* ------------------------------------------------------------------ */
/*  七牛云上传                                                          */
/* ------------------------------------------------------------------ */

async function uploadLocalFileToQiniu(
  config: ResolvedQiniuUploadConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readFile(filePath)
  const fileName = basename(filePath)
  const key = buildStorageObjectKey(filePath, config.objectPrefix)
  const deadline = Math.floor(Date.now() / 1000) + config.expiresSeconds
  const putPolicy = JSON.stringify({
    scope: `${config.bucket}:${key}`,
    deadline,
  })
  const encodedPutPolicy = toUrlSafeBase64(putPolicy)
  const signed = createHmac('sha1', config.secretKey).update(encodedPutPolicy).digest()
  const encodedSign = toUrlSafeBase64(signed)
  const uploadToken = `${config.accessKey}:${encodedSign}:${encodedPutPolicy}`
  const buildFormData = () => {
    const formData = new FormData()
    formData.append('token', uploadToken)
    formData.append('key', key)
    formData.append('file', new Blob([bytes]), fileName)
    return formData
  }
  let uploadUrl = config.uploadUrl
  let response = await fetch(uploadUrl, {
    method: 'POST',
    body: buildFormData(),
    signal,
  })
  if (!response.ok) {
    const rawText = await readResponseTextSafe(response)
    if (response.status === 400) {
      const regionUploadUrl = resolveQiniuRegionUploadUrl(rawText, uploadUrl)
      if (regionUploadUrl) {
        uploadUrl = regionUploadUrl
        response = await fetch(uploadUrl, {
          method: 'POST',
          body: buildFormData(),
          signal,
        })
      }
    }
    if (!response.ok) {
      const retryRaw = await readResponseTextSafe(response)
      throw new Error(`Qiniu upload failed: ${response.status} ${response.statusText} ${retryRaw}`)
    }
  }
  return buildPublicUrl(config.publicBaseUrl, key)
}

/* ------------------------------------------------------------------ */
/*  网关后台 API 上传（降级方案）                                          */
/* ------------------------------------------------------------------ */

/** 走网关后台 API 上传（无本地云存储配置时的降级方案，含 hash 去重） */
export async function uploadDataUrlViaGateway(
  dataUrl: string,
  signal?: AbortSignal,
  token?: string | null,
): Promise<string> {
  const { createHash } = await import('node:crypto')

  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) throw new Error('Invalid data URL format')
  const mimeHeader = dataUrl.slice(0, commaIndex)
  const base64Data = dataUrl.slice(commaIndex + 1)
  const bytes = Buffer.from(base64Data, 'base64')

  const mimeMatch = mimeHeader.match(/data:([^;]+)/i)
  const mimeType = mimeMatch?.[1] ?? 'image/png'

  // 计算 SHA-256 hash（去重用）
  const hash = createHash('sha256').update(bytes).digest('hex')

  const ext = mimeType.split('/')[1] || 'png'
  const fileName = `upload_${Date.now()}.${ext}`

  // 调网关获取上传凭证
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const tokenResp = await fetch(`${GATEWAY_UPLOAD_BASE}/api/member/storage/upload-token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_name: fileName, mime_type: mimeType, hash }),
    signal,
  })

  if (!tokenResp.ok) {
    throw new Error(`网关返回错误 (${tokenResp.status}): ${await tokenResp.text().catch(() => '')}`)
  }

  const tokenJson = await tokenResp.json() as any
  if (tokenJson.code !== 0 || !tokenJson.data) {
    throw new Error(`网关返回异常: ${tokenJson.message || '未知错误'}`)
  }

  const uploadData = tokenJson.data

  let publicUrl: string

  // hash 去重命中
  if (uploadData.reused === true && uploadData.public_url) {
    publicUrl = uploadData.public_url
  } else {
    // 直传云存储
    const formData = new FormData()
    formData.append('token', uploadData.token)
    formData.append('key', uploadData.key)
    formData.append('file', new Blob([bytes]), fileName)

    let uploadUrl = uploadData.upload_url || 'https://up.qiniup.com'
    let uploadResp = await fetch(uploadUrl, { method: 'POST', body: formData, signal })

    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '')
      // 七牛云跨区域重试（400 或 405）
      if (uploadResp.status === 400 || uploadResp.status === 405) {
        const retryHost = errText.match(/up-[a-z0-9]+\.qiniup\.com/)?.[0]
        if (retryHost) {
          uploadUrl = `https://${retryHost}`
          uploadResp = await fetch(uploadUrl, { method: 'POST', body: formData, signal })
        }
      }
      if (!uploadResp.ok) {
        throw new Error(`云存储上传失败 (${uploadResp.status}): ${errText}`)
      }
    }

    const publicBaseUrl = String(uploadData.public_base_url || '').replace(/\/+$/, '')
    publicUrl = `${publicBaseUrl}/${uploadData.key}`
  }

  // 注册文件记录到网关后台（非关键路径，失败静默吞掉）
  if (token) {
    await registerFileToGateway({
      gatewayBase: GATEWAY_UPLOAD_BASE,
      token,
      provider: (uploadData as any).provider || 'qiniu',
      objectKey: uploadData.key,
      publicUrl,
      mimeType,
      originName: fileName,
      hash,
      logFn: llmLog,
      logTag: 'AGENT_UPLOAD_REGISTER_FAIL',
      logScope: 'agent',
    })
  }

  return publicUrl
}

/* ------------------------------------------------------------------ */
/*  统一上传入口                                                        */
/* ------------------------------------------------------------------ */

export async function uploadDataUrlToStorage(
  config: ResolvedUploadConfig | null,
  dataUrl: string,
  signal?: AbortSignal,
  token?: string | null,
): Promise<string> {
  // 未配置本地云存储 → 走网关后台 API
  if (!config) {
    return uploadDataUrlViaGateway(dataUrl, signal, token)
  }
  // 解析 dataUrl: data:image/png;base64,xxxxx
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) throw new Error('Invalid data URL format')
  const mimeHeader = dataUrl.slice(0, commaIndex)
  const base64Data = dataUrl.slice(commaIndex + 1)
  const bytes = Buffer.from(base64Data, 'base64')

  // 从 MIME 类型推断文件扩展名
  const mimeMatch = mimeHeader.match(/data:([^;]+)/i)
  const mimeType = mimeMatch?.[1] ?? 'application/octet-stream'
  const extMap: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/ico': '.ico',
    'image/tiff': '.tif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/avif': '.avif',
    'application/vnd.android.package-archive': '.apk',
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'application/x-gzip': '.tar.gz',
    'application/x-tar': '.tar',
    'application/x-apple-diskimage': '.dmg',
    'application/vnd.microsoft.portable-executable': '.exe',
    'application/x-msi': '.msi',
    'application/vnd.debian.binary-package': '.deb',
    'application/x-rpm': '.rpm',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/html': '.html',
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/typescript': '.ts',
  }
  const ext = extMap[mimeType.toLowerCase()] || ''
  const fakePath = `upload${ext}`

  if (config.provider === 'aliyun_oss') {
    const fileName = basename(fakePath)
    const key = buildStorageObjectKey(fakePath, config.objectPrefix)
    const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const policyText = JSON.stringify({
      expiration,
      conditions: [
        ['starts-with', '$key', normalizeObjectPrefix(config.objectPrefix)],
        ['content-length-range', 0, 1024 * 1024 * 200],
      ],
    })
    const policy = Buffer.from(policyText).toString('base64')
    const signature = createHmac('sha1', config.accessKeySecret).update(policy).digest('base64')
    const formData = new FormData()
    formData.append('key', key)
    formData.append('policy', policy)
    formData.append('OSSAccessKeyId', config.accessKeyId)
    formData.append('Signature', signature)
    formData.append('success_action_status', '200')
    formData.append('file', new Blob([bytes]), fileName)
    const response = await fetch(config.endpoint, {
      method: 'POST',
      body: formData,
      signal,
    })
    if (!response.ok) {
      const rawText = await readResponseTextSafe(response)
      throw new Error(`Aliyun OSS upload failed: ${response.status} ${response.statusText} ${rawText}`)
    }
    return buildPublicUrl(config.publicBaseUrl, key)
  }

  // qiniu
  const fileName = basename(fakePath)
  const key = buildStorageObjectKey(fakePath, config.objectPrefix)
  const deadline = Math.floor(Date.now() / 1000) + (config as ResolvedQiniuUploadConfig).expiresSeconds
  const putPolicy = JSON.stringify({
    scope: `${(config as ResolvedQiniuUploadConfig).bucket}:${key}`,
    deadline,
  })
  const encodedPutPolicy = toUrlSafeBase64(putPolicy)
  const signed = createHmac('sha1', (config as ResolvedQiniuUploadConfig).secretKey).update(encodedPutPolicy).digest()
  const encodedSign = toUrlSafeBase64(signed)
  const uploadToken = `${(config as ResolvedQiniuUploadConfig).accessKey}:${encodedSign}:${encodedPutPolicy}`
  const buildFormData = () => {
    const formData = new FormData()
    formData.append('token', uploadToken)
    formData.append('key', key)
    formData.append('file', new Blob([bytes]), fileName)
    return formData
  }
  let uploadUrl = (config as ResolvedQiniuUploadConfig).uploadUrl
  
  // 如果没有配置 uploadUrl，使用七牛云默认上传地址
  if (!uploadUrl || uploadUrl.trim() === '') {
    uploadUrl = 'https://up.qiniup.com'
  }
  
  let response = await fetch(uploadUrl, {
    method: 'POST',
    body: buildFormData(),
    signal,
  })
  if (!response.ok) {
    const rawText = await readResponseTextSafe(response)
    if (response.status === 400) {
      const regionUploadUrl = resolveQiniuRegionUploadUrl(rawText, uploadUrl)
      if (regionUploadUrl) {
        uploadUrl = regionUploadUrl
        response = await fetch(uploadUrl, {
          method: 'POST',
          body: buildFormData(),
          signal,
        })
      }
    }
    if (!response.ok) {
      const retryRaw = await readResponseTextSafe(response)
      throw new Error(`Qiniu upload failed: ${response.status} ${response.statusText} ${retryRaw}`)
    }
  }
  return buildPublicUrl(config.publicBaseUrl, key)
}
