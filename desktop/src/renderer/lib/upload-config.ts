import type { IpcUploadConfig } from '../../shared/ipc'

export const UPLOAD_CONFIG_STORAGE_KEY = 'taco.uploadConfig'

export type UploadProviderType = 'none' | 'aliyun_oss' | 'qiniu'

export type UploadSettingsState = {
  provider: UploadProviderType
  aliyunOss: {
    accessKeyId: string
    accessKeySecret: string
    bucket: string
    endpoint: string
    objectPrefix: string
    publicBaseUrl: string
  }
  qiniu: {
    accessKey: string
    secretKey: string
    bucket: string
    uploadUrl: string
    publicBaseUrl: string
    objectPrefix: string
    expiresSeconds: string
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asProvider(value: unknown): UploadProviderType {
  const text = asText(value)
  if (text === 'aliyun_oss' || text === 'qiniu' || text === 'none') return text
  return 'none'
}

export function defaultUploadSettingsState(): UploadSettingsState {
  return {
    provider: 'none',
    aliyunOss: {
      accessKeyId: '',
      accessKeySecret: '',
      bucket: '',
      endpoint: '',
      objectPrefix: '',
      publicBaseUrl: '',
    },
    qiniu: {
      accessKey: '',
      secretKey: '',
      bucket: '',
      uploadUrl: '',
      publicBaseUrl: '',
      objectPrefix: '',
      expiresSeconds: '3600',
    },
  }
}

export function normalizeUploadSettingsState(raw: unknown): UploadSettingsState {
  const base = defaultUploadSettingsState()
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const aliyunRaw = obj.aliyunOss && typeof obj.aliyunOss === 'object' ? obj.aliyunOss as Record<string, unknown> : {}
  const qiniuRaw = obj.qiniu && typeof obj.qiniu === 'object' ? obj.qiniu as Record<string, unknown> : {}
  return {
    provider: asProvider(obj.provider),
    aliyunOss: {
      accessKeyId: asText(aliyunRaw.accessKeyId),
      accessKeySecret: asText(aliyunRaw.accessKeySecret),
      bucket: asText(aliyunRaw.bucket),
      endpoint: asText(aliyunRaw.endpoint),
      objectPrefix: asText(aliyunRaw.objectPrefix),
      publicBaseUrl: asText(aliyunRaw.publicBaseUrl),
    },
    qiniu: {
      accessKey: asText(qiniuRaw.accessKey),
      secretKey: asText(qiniuRaw.secretKey),
      bucket: asText(qiniuRaw.bucket),
      uploadUrl: asText(qiniuRaw.uploadUrl),
      publicBaseUrl: asText(qiniuRaw.publicBaseUrl),
      objectPrefix: asText(qiniuRaw.objectPrefix),
      expiresSeconds: asText(qiniuRaw.expiresSeconds) || '3600',
    },
  }
}

export function loadUploadSettings(): UploadSettingsState {
  try {
    const raw = localStorage.getItem(UPLOAD_CONFIG_STORAGE_KEY)
    if (!raw) return defaultUploadSettingsState()
    return normalizeUploadSettingsState(JSON.parse(raw))
  } catch {
    return defaultUploadSettingsState()
  }
}

export function saveUploadSettings(state: UploadSettingsState): void {
  const normalized = normalizeUploadSettingsState(state)
  // 保存到localStorage (渲染进程)
  localStorage.setItem(UPLOAD_CONFIG_STORAGE_KEY, JSON.stringify(normalized))
  
  // 只保存当前配置的服务商数据到数据库
  const dbConfig: any = {
    provider: normalized.provider
  }
  
  if (normalized.provider === 'aliyun_oss') {
    dbConfig.aliyunOss = normalized.aliyunOss
  } else if (normalized.provider === 'qiniu') {
    dbConfig.qiniu = normalized.qiniu
  }
  
  // 同时保存到数据库 (主进程)
  if (window.taco?.app?.saveUploadConfig) {
    window.taco.app.saveUploadConfig(dbConfig).catch(err => {
      console.error('保存上传配置到数据库失败:', err)
    })
  }
}

export function toIpcUploadConfig(state: UploadSettingsState): IpcUploadConfig | undefined {
  const normalized = normalizeUploadSettingsState(state)
  if (normalized.provider === 'aliyun_oss') {
    return {
      provider: 'aliyun_oss',
      accessKeyId: normalized.aliyunOss.accessKeyId,
      accessKeySecret: normalized.aliyunOss.accessKeySecret,
      bucket: normalized.aliyunOss.bucket,
      endpoint: normalized.aliyunOss.endpoint,
      objectPrefix: normalized.aliyunOss.objectPrefix,
      publicBaseUrl: normalized.aliyunOss.publicBaseUrl,
    }
  }
  if (normalized.provider === 'qiniu') {
    return {
      provider: 'qiniu',
      accessKey: normalized.qiniu.accessKey,
      secretKey: normalized.qiniu.secretKey,
      bucket: normalized.qiniu.bucket,
      uploadUrl: normalized.qiniu.uploadUrl,
      publicBaseUrl: normalized.qiniu.publicBaseUrl,
      objectPrefix: normalized.qiniu.objectPrefix,
      expiresSeconds: normalized.qiniu.expiresSeconds ? Number(normalized.qiniu.expiresSeconds) : undefined,
    }
  }
  return undefined
}
