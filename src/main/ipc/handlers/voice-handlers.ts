/**
 * 语音识别 IPC Handler
 *
 * 路由层，委托给 ASR Provider 工厂执行实际识别。
 * 所有 ASR 请求统一走网关代理（/api/v1/audio/asr），
 * 鉴权使用 Bridge JWT（与手机端一致，网关 APIKeyOrJWT 中间件校验）。
 *
 * 同时包含系统 TTS 朗读 Handler（降级方案）。
 */

import { ChildProcess, spawn } from 'child_process'
import { AsrProviderFactory } from '../../sdk/agent/asr/factory'
import { getBridgeManager } from '../../bridge/bridge-manager'

/** 当前正在进行的系统 TTS 进程（用于停止） */
let activeTtsProcess: ChildProcess | null = null

/**
 * 系统 TTS 朗读 Handler。
 * 跨平台：macOS → say、Linux → espeak → spd-say、Windows → PowerShell SAPI
 */
export function handleVoiceSpeak(text: string): void {
  // 先停掉正在进行的朗读
  handleVoiceStop()

  const platform = process.platform

  if (platform === 'darwin') {
    activeTtsProcess = spawn('say', [text], { stdio: 'ignore' })
  } else if (platform === 'linux') {
    // 优先 espeak，不可用时 spd-say
    activeTtsProcess = spawn('espeak', [text], { stdio: 'ignore' })
    activeTtsProcess.on('error', () => {
      activeTtsProcess = spawn('spd-say', [text], { stdio: 'ignore' })
    })
  } else if (platform === 'win32') {
    // 通过 PowerShell 调用 .NET SpeechSynthesizer
    const escaped = text.replace(/"/g, '\\"')
    activeTtsProcess = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak("${escaped}")`,
    ], { stdio: 'ignore' })
  }

  if (activeTtsProcess) {
    activeTtsProcess.on('close', () => {
      activeTtsProcess = null
    })
  }
}

/** 停止系统 TTS 朗读 */
export function handleVoiceStop(): void {
  if (activeTtsProcess) {
    try {
      activeTtsProcess.kill('SIGTERM')
    } catch {
      // 进程可能已退出
    }
    activeTtsProcess = null
  }
}

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
