/**
 * 工具执行器 - 视觉模型图片分析（analyze_image 工具）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentServices } from '../services'
import type { ProviderKey } from '../llm/client'
import type { ChatMessage, ProviderOverrides } from '../llm/client'
import { uploadDataUrlToStorage, requestChatCompletionStream } from '../llm/client'
import type { ExecResult, ToolRuntimeContext } from './exec-utils'

/* ------------------------------------------------------------------ */
/*  截图上传到云存储                                                    */
/* ------------------------------------------------------------------ */

export async function uploadScreenshotToCloud(dataUrl: string, services: AgentServices): Promise<string | null> {
  try {
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      services.logger('SCREENSHOT_UPLOAD_SKIP', { reason: 'invalid_data_url' })
      return null
    }
    const cloudUrl = await uploadDataUrlToStorage(null as any, dataUrl, undefined, services.getToken?.())
    services.logger('SCREENSHOT_UPLOADED', { cloudUrl })
    return cloudUrl
  } catch (err) {
    services.logger('SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  视觉模型分析                                                        */
/* ------------------------------------------------------------------ */

const VISION_ANALYSIS_SYSTEM_PROMPT = `你是一个截图分析助手。根据用户的截图目的来分析截图内容。

请遵循以下规则：
- 只描述截图中实际存在的内容，不要猜测或编造
- 重点关注与截图目的直接相关的元素（按钮、文本、输入框、状态提示等）
- 如果目的是确认某个元素是否存在，明确指出该元素是否可见及其大致位置
- 如果目的是了解页面/桌面状态，描述当前的整体布局和关键内容
- 输出简洁、结构化，优先回应截图目的，不要在无目的时冗长描述所有细节
- 使用中文回复`

export async function execAnalyzeImage(
  args: Record<string, unknown>,
  workspace: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const image = typeof args.image === 'string' ? args.image.trim() : ''
  const goal = typeof args.goal === 'string' ? args.goal : undefined

  if (!image) {
    return { content: 'Error: image parameter is required (file path or data: URL)', success: false }
  }
  if (!goal) {
    return { content: 'Error: goal parameter is required', success: false }
  }

  // 解析图片为 data: URL
  let dataUrl: string
  if (image.startsWith('data:')) {
    dataUrl = image
  } else if (image.startsWith('http://') || image.startsWith('https://')) {
    dataUrl = image
  } else {
    try {
      const resolvedPath = path.isAbsolute(image) ? image : path.resolve(workspace, image)
      const buffer = await fs.readFile(resolvedPath)
      const ext = path.extname(resolvedPath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
      }
      const mime = mimeTypes[ext] || 'image/png'
      dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
    } catch (err) {
      return { content: `Error: failed to read image file: ${err instanceof Error ? err.message : String(err)}`, success: false }
    }
  }

  const services = runtimeContext?.services
  const overrides = runtimeContext?.overrides
  let selectedProvider: ProviderKey | null = null
  let effectiveOverrides: ProviderOverrides | undefined = overrides as ProviderOverrides | undefined

  if (overrides) {
    for (const [key, cfg] of Object.entries(overrides as Record<string, any>)) {
      if (cfg.supportsVision === true && cfg.apiKey && cfg.model) {
        selectedProvider = key as ProviderKey
        break
      }
    }
  }

  if (!selectedProvider && services) {
    try {
      const providersState = services.database.getAppProviders()
      if (providersState?.data) {
        for (const cfg of providersState.data.modelConfigs) {
          if (cfg.supportsVision && cfg.apiKey && cfg.model) {
            const p = String(cfg.provider ?? '') as ProviderKey
            selectedProvider = p
            const parsedTemp = cfg.temperature ? Number(cfg.temperature) : undefined
            effectiveOverrides = {
              [p]: {
                baseUrl: (cfg.baseUrl as string) || undefined,
                apiKey: cfg.apiKey as string,
                model: cfg.model as string,
                temperature: parsedTemp !== undefined && Number.isFinite(parsedTemp) && parsedTemp >= 0 && parsedTemp <= 2 ? parsedTemp : undefined,
                supportsVision: true,
                supportsReasoning: cfg.supportsReasoning as boolean | undefined,
              },
            } as ProviderOverrides
            services.logger('ANALYZE_IMAGE_VISION_FALLBACK_DB', { provider: p, model: cfg.model })
            break
          }
        }
      }
    } catch (dbErr) {
      services?.logger('ANALYZE_IMAGE_DB_LOAD_FAIL', { error: dbErr instanceof Error ? dbErr.message : String(dbErr) })
    }
  }

  if (!selectedProvider && services?.gatewayModelCache) {
    const gwModels = services.gatewayModelCache.get()
    if (gwModels && gwModels.length > 0) {
      for (const m of gwModels) {
        if (m.supportsVision && m.apiKey && m.model) {
          const p = String(m.provider ?? '') as ProviderKey
          selectedProvider = p
          const parsedTemp = m.temperature ? Number(m.temperature) : undefined
          effectiveOverrides = {
            [p]: {
              baseUrl: (m.baseUrl as string) || undefined,
              apiKey: m.apiKey as string,
              model: m.model as string,
              temperature: parsedTemp !== undefined && Number.isFinite(parsedTemp) && parsedTemp >= 0 && parsedTemp <= 2 ? parsedTemp : undefined,
              supportsVision: true,
              supportsReasoning: m.supportsReasoning as boolean | undefined,
            },
          } as ProviderOverrides
          services.logger('ANALYZE_IMAGE_VISION_FALLBACK_GATEWAY', { provider: p, model: m.model })
          break
        }
      }
    } else {
      services?.logger('ANALYZE_IMAGE_GATEWAY_CACHE_EMPTY', {})
    }
  }

  if (!selectedProvider) {
    return { content: 'Error: no vision-capable model available. Please configure a vision model in settings.', success: false }
  }

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: VISION_ANALYSIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: `截图目的：${goal}` },
        ],
      } as ChatMessage,
    ]

    const stream = requestChatCompletionStream(selectedProvider, messages, effectiveOverrides)
    let accumulated = ''
    for await (const chunk of stream) {
      accumulated += chunk
    }
    if (accumulated.trim()) {
      services?.logger('ANALYZE_IMAGE_SUCCESS', { provider: selectedProvider, contentLength: accumulated.length })
      return { content: accumulated.trim(), success: true }
    }
    return { content: 'Error: vision model returned empty response', success: false }
  } catch (err) {
    services?.logger('ANALYZE_IMAGE_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return { content: `Error: vision analysis failed: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}
