/**
 * 云存储文件注册工具
 *
 * 上传到云存储后统一调用网关后台注册文件记录。
 * 注册是非关键路径，失败静默吞掉只记日志。
 */

export interface RegisterFileParams {
  /** 网关后台地址，如 https://agent.bjctykj.com */
  gatewayBase: string
  /** 认证 token */
  token: string
  /** 存储提供商 */
  provider: string
  /** 存储 object key */
  objectKey: string
  /** 公网访问 URL */
  publicUrl: string
  /** MIME 类型 */
  mimeType: string
  /** 原始文件名 */
  originName: string
  /** 文件 hash */
  hash: string
  /** 日志函数 */
  logFn: (tag: string, meta: Record<string, unknown>, scope?: string) => void
  /** 日志标签 */
  logTag: string
  /** 日志 scope */
  logScope: string
}

/**
 * 向网关后台注册文件记录（非关键路径，失败静默吞掉）
 */
export async function registerFileToGateway(params: RegisterFileParams): Promise<void> {
  try {
    const regResp = await fetch(`${params.gatewayBase}/api/member/storage/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        provider: params.provider,
        object_key: params.objectKey,
        public_url: params.publicUrl,
        mime_type: params.mimeType,
        origin_name: params.originName,
        hash: params.hash,
      }),
    })
    if (!regResp.ok) {
      const respText = await regResp.text().catch(() => '')
      params.logFn(params.logTag, { status: regResp.status, body: respText.slice(0, 500) }, params.logScope)
    }
  } catch (regErr) {
    params.logFn(params.logTag, { error: regErr instanceof Error ? regErr.message : String(regErr) }, params.logScope)
  }
}
