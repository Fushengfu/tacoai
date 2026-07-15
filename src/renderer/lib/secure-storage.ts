/**
 * 安全存储工具
 * 
 * 使用 Electron safeStorage 加密敏感数据(如 Token、API Key)
 * 通过 IPC 与主进程通信
 */

/** 存储的键名 */
export enum SecureStorageKey {
  MEMBER_TOKEN = 'memberToken',
  API_KEY_OPENAI = 'apiKey.openai',
  API_KEY_DASHSCOPE = 'apiKey.dashscope',
  API_KEY_DEEPSEEK = 'apiKey.deepseek',
  API_KEY_ZHIPU = 'apiKey.zhipu',
  API_KEY_MOONSHOT = 'apiKey.moonshot',
  API_KEY_MINIMAX = 'apiKey.minimax',
}

/**
 * 安全存储服务
 * 
 * 注意: 由于 safeStorage 只能在主进程使用,
 * 这个工具通过 localStorage 作为降级方案,
 * 并在生产环境中建议使用主进程的 IPC 接口
 */
class SecureStorageService {
  private useEncryption = false
  
  constructor() {
    // 检测是否在主进程中(可以访问 safeStorage)
    this.useEncryption = typeof process !== 'undefined' && 
                         process.type === 'browser'
  }

  /**
   * 安全地设置值
   */
  async set(key: SecureStorageKey, value: string): Promise<void> {
    if (!value || !value.trim()) {
      throw new Error('Value cannot be empty')
    }

    if (this.useEncryption) {
      // 在主进程中,使用 safeStorage 加密
      // 这部分需要通过 IPC 调用
      await this.setEncrypted(key, value)
    } else {
      // 在渲染进程中,使用 localStorage 但进行 base64 编码
      // 注意: 这只是混淆,不是真正的加密
      // 生产环境应该通过 IPC 调用主进程的 safeStorage
      this.setFallback(key, value)
    }
  }

  /**
   * 安全地获取值
   */
  async get(key: SecureStorageKey): Promise<string | null> {
    if (this.useEncryption) {
      return await this.getEncrypted(key)
    } else {
      return this.getFallback(key)
    }
  }

  /**
   * 删除值
   */
  async delete(key: SecureStorageKey): Promise<void> {
    if (this.useEncryption) {
      await this.deleteEncrypted(key)
    } else {
      this.deleteFallback(key)
    }
  }

  /**
   * 加密存储(需要主进程支持)
   */
  private async setEncrypted(key: SecureStorageKey, value: string): Promise<void> {
    // TODO: 实现 IPC 调用主进程的 safeStorage.encryptString
    // 暂时使用降级方案
    this.setFallback(key, value)
  }

  /**
   * 加密读取(需要主进程支持)
   */
  private async getEncrypted(key: SecureStorageKey): Promise<string | null> {
    // TODO: 实现 IPC 调用主进程的 safeStorage.decryptString
    // 暂时使用降级方案
    return this.getFallback(key)
  }

  /**
   * 加密删除(需要主进程支持)
   */
  private async deleteEncrypted(key: SecureStorageKey): Promise<void> {
    // TODO: 实现 IPC 调用
    this.deleteFallback(key)
  }

  /**
   * 降级方案: 使用 localStorage + base64 编码
   * 注意: 这只是为了避免明文存储,不是真正的加密
   */
  private setFallback(key: SecureStorageKey, value: string): void {
    try {
      // 添加时间戳和简单的混淆
      const payload = {
        v: value,
        t: Date.now(),
      }
      const encoded = btoa(JSON.stringify(payload))
      localStorage.setItem(`taco.secure.${key}`, encoded)
    } catch (error) {
      console.error('[SecureStorage] Failed to set value:', error)
    }
  }

  /**
   * 降级方案: 读取 localStorage
   */
  private getFallback(key: SecureStorageKey): string | null {
    try {
      const encoded = localStorage.getItem(`taco.secure.${key}`)
      if (!encoded) return null

      const payload = JSON.parse(atob(encoded))
      
      // 检查是否过期(可选,默认30天)
      const age = Date.now() - payload.t
      const maxAge = 30 * 24 * 60 * 60 * 1000 // 30 days
      if (age > maxAge) {
        this.deleteFallback(key)
        return null
      }

      return payload.v
    } catch (error) {
      console.error('[SecureStorage] Failed to get value:', error)
      return null
    }
  }

  /**
   * 降级方案: 删除 localStorage
   */
  private deleteFallback(key: SecureStorageKey): void {
    localStorage.removeItem(`taco.secure.${key}`)
  }
}

// 导出单例
export const secureStorage = new SecureStorageService()

/**
 * 便捷函数: 存储 Token
 */
export async function storeToken(token: string): Promise<void> {
  await secureStorage.set(SecureStorageKey.MEMBER_TOKEN, token)
}

/**
 * 便捷函数: 读取 Token
 */
export async function loadToken(): Promise<string | null> {
  return await secureStorage.get(SecureStorageKey.MEMBER_TOKEN)
}

/**
 * 便捷函数: 删除 Token
 */
export async function removeToken(): Promise<void> {
  await secureStorage.delete(SecureStorageKey.MEMBER_TOKEN)
}
