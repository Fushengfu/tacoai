/**
 * Upload IPC Handlers
 *
 * 包含图片上传到云存储相关 IPC handler（统一走网关后台 API）。
 */

import type { IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { getBridgeManager } from '../../bridge/bridge-manager'
import { log } from '../../infrastructure/logger'
import { loadAuthFromFile } from '../../infrastructure/auth-store'

const GATEWAY_BASE = 'https://agent.bjctykj.com'

/* ------------------------------------------------------------------ */
/*  Image upload to cloud storage (via gateway API)                    */
/* ------------------------------------------------------------------ */

export async function handleImageUpload(
  _event: IpcMainInvokeEvent,
  payload: { dataUrl: string; fileName: string },
): Promise<{ publicUrl: string }> {
  const { dataUrl, fileName } = payload

  // 1. 解析 dataUrl
  const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!base64Match) {
    throw new Error('无效的 dataUrl 格式')
  }
  const mimeType = base64Match[1]
  const base64Data = base64Match[2]

  // 2. 计算 SHA-256 hash（去重用）
  const hash = createHash('sha256').update(Buffer.from(base64Data, 'base64')).digest('hex')

  // 3. 获取 JWT token（优先 BridgeManager，降级 auth-store 文件）
  let token = getBridgeManager().getToken()
  if (!token) {
    const authData = await loadAuthFromFile()
    token = authData?.token ?? null
  }
  if (!token) {
    throw new Error('未登录，无法获取上传凭证')
  }

  // 4. 调用网关 API 获取上传凭证
  const tokenResp = await fetch(`${GATEWAY_BASE}/api/member/storage/upload-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ file_name: fileName, mime_type: mimeType, hash }),
  })

  if (!tokenResp.ok) {
    const errText = await tokenResp.text().catch(() => '')
    throw new Error(`网关返回错误 (${tokenResp.status}): ${errText}`)
  }

  const tokenJson = await tokenResp.json() as any
  if (tokenJson.code !== 0 || !tokenJson.data) {
    throw new Error(`网关返回异常: ${tokenJson.message || '未知错误'}`)
  }

  const uploadData = tokenJson.data

  // 5. hash 去重命中：直接返回已有链接
  if (uploadData.reused === true && uploadData.public_url) {
    log('IMAGE_UPLOAD_REUSED', { fileName, publicUrl: uploadData.public_url }, 'ipc')
    return { publicUrl: uploadData.public_url }
  }

  // 6. 直传云存储
  const formData = new FormData()
  formData.append('token', uploadData.token)
  formData.append('key', uploadData.key)
  const blob = new Blob([Buffer.from(base64Data, 'base64')], { type: mimeType })
  formData.append('file', blob, fileName)

  const uploadResp = await fetch(uploadData.upload_url, {
    method: 'POST',
    body: formData,
  })

  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => '')
    // 尝试解析七牛云错误信息，提取正确的上传区域
    let retryUrl: string | null = null
    if (uploadResp.status === 400 || uploadResp.status === 405) {
      try {
        const errJson = JSON.parse(errText)
        const retryHost = errJson?.error?.match?.(/up-[a-z0-9]+\.qiniup\.com/)?.[0]
        if (retryHost) {
          retryUrl = `https://${retryHost}`
        }
      } catch { /* ignore parse error */ }
    }
    if (retryUrl) {
      const retryResp = await fetch(retryUrl, { method: 'POST', body: formData })
      if (retryResp.ok) {
        // 与正常流程一致的安全校验
        const rawBase = String(uploadData.public_base_url || '')
        let publicBaseUrl = rawBase.replace(/\/+$/, '')
        if (!/^https?:\/\/[^\/]+/.test(publicBaseUrl)) {
          throw new Error(
            `网关返回的 public_base_url 格式无效: "${rawBase}"，请在管理后台配置七牛云 Domain（公网访问域名）`
          )
        }
        const publicUrl = `${publicBaseUrl}/${uploadData.key}`
        log('IMAGE_UPLOADED_VIA_GATEWAY_RETRY', { fileName, publicUrl, retryUrl }, 'ipc')
        return { publicUrl }
      }
    }
    throw new Error(`云存储上传失败 (${uploadResp.status}): ${errText}`)
  }

  // 7. 构造公网 URL（加安全校验：public_base_url 必须有有效 hostname）
  const rawBase = String(uploadData.public_base_url || '')
  // 去掉末尾多余斜杠，但保留 scheme://host 结构
  let publicBaseUrl = rawBase.replace(/\/+$/, '')
  // 校验：必须是完整的 http(s)://hostname 格式，不允许出现 "https:" 这种只有 scheme 没有 host 的无效值
  if (!/^https?:\/\/[^\/]+/.test(publicBaseUrl)) {
    throw new Error(
      `网关返回的 public_base_url 格式无效: "${rawBase}"，请在管理后台配置七牛云 Domain（公网访问域名）`
    )
  }
  const publicUrl = `${publicBaseUrl}/${uploadData.key}`

  // 8. 注册文件记录（非关键路径，失败不影响返回）
  try {
    await fetch(`${GATEWAY_BASE}/api/member/storage/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: uploadData.provider || 'qiniu',
        object_key: uploadData.key,
        public_url: publicUrl,
        mime_type: mimeType,
        origin_name: fileName,
        hash,
      }),
    })
  } catch (regErr) {
    log('IMAGE_UPLOAD_REGISTER_FAIL', { error: regErr instanceof Error ? regErr.message : String(regErr) }, 'ipc')
  }

  log('IMAGE_UPLOADED_VIA_GATEWAY', { fileName, publicUrl }, 'ipc')
  return { publicUrl }
}
