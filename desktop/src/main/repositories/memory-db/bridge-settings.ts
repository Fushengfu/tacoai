import type { BridgeSettingKey, BridgeSettingValue } from './schema'
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
