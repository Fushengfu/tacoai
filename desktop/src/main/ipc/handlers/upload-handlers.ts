/**
 * Upload IPC Handlers
 *
 * 包含图片上传到云存储和上传配置保存相关 IPC handler。
 */

import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import * as fsSync from 'node:fs'
import * as nodePath from 'node:path'
import { IpcChannel } from '../../../shared/ipc'
import type { IpcUploadConfig } from '../../../shared/ipc'
import { uploadDataUrlToStorage } from '../../ai/llm'
import { loadUploadConfigFromDb, saveUploadConfigToDb } from '../../data/memory-db'
import { log } from '../../system/logger'

/* ------------------------------------------------------------------ */
/*  Image upload to cloud storage                                      */
/* ------------------------------------------------------------------ */

export async function handleImageUpload(
  _event: IpcMainInvokeEvent,
  payload: { dataUrl: string; fileName: string },
): Promise<{ publicUrl: string }> {
  const { dataUrl, fileName } = payload
  let uploadConfig: IpcUploadConfig | null = null

  try {
    const dbConfig = loadUploadConfigFromDb()

    if (dbConfig && dbConfig.provider !== 'none') {
      log('UPLOAD_CONFIG_LOADED_FROM_DB', {
        provider: dbConfig.provider,
        updatedAt: dbConfig.updatedAt,
      }, 'ipc')

      const config = dbConfig.config as any

      if (dbConfig.provider === 'aliyun_oss') {
        uploadConfig = {
          provider: 'aliyun_oss',
          accessKeyId: config.aliyunOss?.accessKeyId || '',
          accessKeySecret: config.aliyunOss?.accessKeySecret || '',
          bucket: config.aliyunOss?.bucket || '',
          endpoint: config.aliyunOss?.endpoint || '',
          objectPrefix: config.aliyunOss?.objectPrefix || '',
          publicBaseUrl: config.aliyunOss?.publicBaseUrl || '',
        }
      } else if (dbConfig.provider === 'qiniu') {
        uploadConfig = {
          provider: 'qiniu',
          accessKey: config.qiniu?.accessKey || '',
          secretKey: config.qiniu?.secretKey || '',
          bucket: config.qiniu?.bucket || '',
          uploadUrl: config.qiniu?.uploadUrl || '',
          publicBaseUrl: config.qiniu?.publicBaseUrl || '',
          objectPrefix: config.qiniu?.objectPrefix || '',
          expiresSeconds: config.qiniu?.expiresSeconds ? Number(config.qiniu.expiresSeconds) : undefined,
        }
      }
    } else {
      log('UPLOAD_CONFIG_DB_EMPTY', {}, 'ipc')
      const configPath = nodePath.join(app.getPath('userData'), 'upload-config.json')

      if (fsSync.existsSync(configPath)) {
        const raw = fsSync.readFileSync(configPath, 'utf-8')
        const parsed = JSON.parse(raw)
        log('UPLOAD_CONFIG_LOADED_FROM_FILE', { path: configPath, provider: parsed.provider }, 'ipc')
        saveUploadConfigToDb(parsed.provider, parsed)
        log('UPLOAD_CONFIG_MIGRATED_TO_DB', { provider: parsed.provider }, 'ipc')

        const migratedConfig = loadUploadConfigFromDb()
        if (migratedConfig && migratedConfig.provider === 'aliyun_oss') {
          const migratedAny = migratedConfig.config as any
          uploadConfig = {
            provider: 'aliyun_oss',
            accessKeyId: migratedAny.aliyunOss?.accessKeyId || '',
            accessKeySecret: migratedAny.aliyunOss?.accessKeySecret || '',
            bucket: migratedAny.aliyunOss?.bucket || '',
            endpoint: migratedAny.aliyunOss?.endpoint || '',
            objectPrefix: migratedAny.aliyunOss?.objectPrefix || '',
            publicBaseUrl: migratedAny.aliyunOss?.publicBaseUrl || '',
          }
        } else if (migratedConfig && migratedConfig.provider === 'qiniu') {
          const migratedAny = migratedConfig.config as any
          uploadConfig = {
            provider: 'qiniu',
            accessKey: migratedAny.qiniu?.accessKey || '',
            secretKey: migratedAny.qiniu?.secretKey || '',
            bucket: migratedAny.qiniu?.bucket || '',
            uploadUrl: migratedAny.qiniu?.uploadUrl || '',
            publicBaseUrl: migratedAny.qiniu?.publicBaseUrl || '',
            objectPrefix: migratedAny.qiniu?.objectPrefix || '',
            expiresSeconds: migratedAny.qiniu?.expiresSeconds ? Number(migratedAny.qiniu.expiresSeconds) : undefined,
          }
        }
      }
    }
  } catch (err) {
    log('UPLOAD_CONFIG_READ_FAIL', { error: err instanceof Error ? err.message : String(err) }, 'ipc')
  }

  if (!uploadConfig) {
    throw new Error('未配置云存储,请在设置中配置阿里云OSS或七牛云')
  }

  const publicUrl = await uploadDataUrlToStorage(uploadConfig as any, dataUrl)
  log('IMAGE_UPLOADED_FROM_RENDERER', { fileName, publicUrl }, 'ipc')
  return { publicUrl }
}

/* ------------------------------------------------------------------ */
/*  Save upload config to database                                     */
/* ------------------------------------------------------------------ */

export async function handleUploadConfigSave(
  _event: IpcMainInvokeEvent,
  config: unknown,
): Promise<void> {
  try {
    const configAny = config as any
    const provider = configAny?.provider || 'none'
    saveUploadConfigToDb(provider, configAny)
    log('UPLOAD_CONFIG_SAVED_TO_DB', { provider }, 'ipc')
  } catch (err) {
    log('UPLOAD_CONFIG_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) }, 'ipc')
    throw err
  }
}
