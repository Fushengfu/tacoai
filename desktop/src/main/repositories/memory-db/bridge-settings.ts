import type { BridgeSettingKey, BridgeSettingValue, UploadConfigDbEntry } from './schema'
import { getDb } from './schema'

/* ------------------------------------------------------------------ */
/*  Bridge Settings                                                    */
/* ------------------------------------------------------------------ */

export function getBridgeSetting(key: BridgeSettingKey): BridgeSettingValue | null {
  const database = getDb()
  const row = database.prepare(
    `SELECT setting_value FROM bridge_settings WHERE setting_key = ?`
  ).get(key) as Record<string, unknown> | undefined
  const val = row?.setting_value as string | undefined
  if (!val) return null
  return val as BridgeSettingValue
}

export function setBridgeSetting(key: BridgeSettingKey, value: BridgeSettingValue): void {
  const database = getDb()
  const now = new Date().toISOString()
  database.prepare(`
    INSERT INTO bridge_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value=excluded.setting_value,
      updated_at=excluded.updated_at
  `).run(key, value, now)
}

/* ------------------------------------------------------------------ */
/*  Upload Config                                                      */
/* ------------------------------------------------------------------ */

export function loadUploadConfigFromDb(): UploadConfigDbEntry | null {
  const database = getDb()
  const row = database.prepare(
    `SELECT provider, config_json, updated_at FROM upload_config ORDER BY id DESC LIMIT 1`
  ).get() as Record<string, unknown> | undefined
  
  if (!row || !row.provider) return null
  
  try {
    const config = typeof row.config_json === 'string' 
      ? JSON.parse(row.config_json) 
      : {}
    return {
      provider: String(row.provider),
      config,
      updatedAt: String(row.updated_at || ''),
    }
  } catch {
    return null
  }
}

export function saveUploadConfigToDb(provider: string, config: Record<string, unknown>): void {
  const database = getDb()
  const now = new Date().toISOString()
  const configJson = JSON.stringify(config)
  
  // 先检查是否有记录
  const count = database.prepare(`SELECT COUNT(1) as count FROM upload_config`).get() as Record<string, unknown>
  
  if (Number(count?.count || 0) > 0) {
    // 有记录则更新
    database.prepare(`
      UPDATE upload_config 
      SET provider = ?, config_json = ?, updated_at = ?
      WHERE id = (SELECT id FROM upload_config ORDER BY id DESC LIMIT 1)
    `).run(provider, configJson, now)
  } else {
    // 没有记录则插入
    database.prepare(`
      INSERT INTO upload_config (provider, config_json, updated_at)
      VALUES (?, ?, ?)
    `).run(provider, configJson, now)
  }
}
