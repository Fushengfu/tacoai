/**
 * 语音识别 IPC Handler
 *
 * 路由层，委托给 ASR Provider 工厂执行实际识别。
 * 所有 ASR 请求统一走网关代理（/api/v1/audio/asr），
 * 鉴权使用 Bridge JWT（与手机端一致，网关 APIKeyOrJWT 中间件校验）。
 */

import { AsrProviderFactory } from '../../sdk/agent/asr/factory'
import { getBridgeManager } from '../../bridge/bridge-manager'

/**
 * 语音识别 Handler。
 * 使用 Bridge JWT 鉴权，网关 APIKeyOrJWT 中间件校验。
 */
export async function handleVoiceRecognize(
  _event: Electron.IpcMainInvokeEvent,
  payload: { audioBase64: string; apiKey?: string },
): Promise<{ text: string; error?: string }> {
  try {
    const token = payload.apiKey || getBridgeManager().getToken()

    if (!token) {
      return { text: '', error: 'NO_TOKEN' }
    }

    const provider = AsrProviderFactory.getProvider({
      provider: 'gateway',
      apiKey: token,
    })

    const text = await provider.recognize(
      { pcmBase64: payload.audioBase64 },
      { provider: 'gateway', apiKey: token },
    )

    console.log(`[VoiceRecognize] ASR 识别成功: "${text.slice(0, 100)}"`)
    return { text }
  } catch (err: any) {
    if (err?.code === 'NO_API_KEY') {
      return { text: '', error: 'NO_TOKEN' }
    }
    console.error('[VoiceRecognize] ASR 失败:', err)
    return { text: '' }
  }
}
