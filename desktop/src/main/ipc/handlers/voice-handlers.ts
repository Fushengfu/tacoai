/**
 * 语音识别 IPC Handler
 *
 * 路由层，委托给 StepFun ASR 服务执行实际识别。
 */

import { recognizeStepFun } from '../../sdk/agent/asr/stepfun-asr'

export async function handleVoiceRecognize(
  _event: Electron.IpcMainInvokeEvent,
  payload: { audioBase64: string; apiKey?: string },
): Promise<{ text: string; error?: string }> {
  try {
    const text = await recognizeStepFun({ pcmBase64: payload.audioBase64, apiKey: payload.apiKey })
    console.log(`[VoiceRecognize] StepFun ASR 识别成功: "${text.slice(0, 100)}"`)
    return { text }
  } catch (err: any) {
    if (err?.code === 'NO_API_KEY') {
      return { text: '', error: 'NO_API_KEY' }
    }
    console.error('[VoiceRecognize] StepFun ASR 失败:', err)
    return { text: '' }
  }
}
