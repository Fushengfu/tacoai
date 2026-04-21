import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { log } from '../system/logger'

export type GuiPlusConfig = {
  baseUrl: string
  apiKey: string
  model: string
  minPixels?: number
  maxPixels?: number
  highResolution?: boolean
  includeUsage?: boolean
}

type GuiPlusMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string }; min_pixels?: number; max_pixels?: number }> }

export const GUI_PLUS_SYSTEM_PROMPT = `你是一个GUI视觉操作代理。你会分析屏幕截图并按用户指令输出单一步骤的GUI原子操作。

输出必须是**唯一的JSON对象**，禁止任何额外文本或代码块。

JSON Schema：
{
  "thought": "<一句话描述依据>",
  "action": "CLICK|TYPE|SCROLL|KEY_PRESS|FINISH|FAIL",
  "parameters": { ... }
}

Action 与参数：
- CLICK: {"x": <integer>, "y": <integer>, "description": "<string, optional>"}
- TYPE: {"text": "<string>", "needs_enter": <boolean>}
- SCROLL: {"direction": "<up|down>", "amount": "<small|medium|large>"}
- KEY_PRESS: {"key": "<string>"}
- FINISH: {"message": "<string>"}
- FAIL: {"reason": "<string>"}

规则：
- 只能基于截图中可见元素进行操作。
- 信息不足时使用 FAIL，并在 reason 中说明需要补充的参数。
- action 必须为大写，parameters 结构必须与模板完全一致。`

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const GUI_PLUS_JSON = path.join(TACO_DIR, 'gui-plus.json')

let cachedConfig: Partial<GuiPlusConfig> | null = null

async function loadGuiPlusConfigFile(): Promise<Partial<GuiPlusConfig>> {
  if (cachedConfig) return cachedConfig
  try {
    const raw = await fs.readFile(GUI_PLUS_JSON, 'utf-8')
    cachedConfig = JSON.parse(raw) as Partial<GuiPlusConfig>
    return cachedConfig
  } catch {
    cachedConfig = {}
    return cachedConfig
  }
}

export async function getGuiPlusConfig(): Promise<GuiPlusConfig> {
  const baseUrl = process.env.GUI_PLUS_BASE_URL ?? process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const apiKey = process.env.GUI_PLUS_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? ''
  const model = process.env.GUI_PLUS_MODEL ?? process.env.DASHSCOPE_MODEL ?? 'gui-plus'
  const minPixels = process.env.GUI_PLUS_IMAGE_MIN_PIXELS ?? process.env.DASHSCOPE_IMAGE_MIN_PIXELS
  const maxPixels = process.env.GUI_PLUS_IMAGE_MAX_PIXELS ?? process.env.DASHSCOPE_IMAGE_MAX_PIXELS
  const highResolution = (process.env.GUI_PLUS_VL_HIGH_RESOLUTION_IMAGES ?? process.env.DASHSCOPE_VL_HIGH_RESOLUTION_IMAGES) === 'true'
  const includeUsage = (process.env.GUI_PLUS_STREAM_INCLUDE_USAGE ?? process.env.DASHSCOPE_STREAM_INCLUDE_USAGE) === 'true'

  const fileCfg = await loadGuiPlusConfigFile()

  return {
    baseUrl: fileCfg.baseUrl ?? baseUrl,
    apiKey: fileCfg.apiKey ?? apiKey,
    model: fileCfg.model ?? model,
    minPixels: fileCfg.minPixels ?? (minPixels ? Number(minPixels) : undefined),
    maxPixels: fileCfg.maxPixels ?? (maxPixels ? Number(maxPixels) : undefined),
    highResolution: fileCfg.highResolution ?? highResolution,
    includeUsage: fileCfg.includeUsage ?? includeUsage,
  }
}

export async function saveGuiPlusConfig(config: GuiPlusConfig): Promise<void> {
  await fs.mkdir(TACO_DIR, { recursive: true })
  const payload: GuiPlusConfig = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    minPixels: config.minPixels,
    maxPixels: config.maxPixels,
    highResolution: config.highResolution,
    includeUsage: config.includeUsage,
  }
  await fs.writeFile(GUI_PLUS_JSON, JSON.stringify(payload, null, 2), 'utf-8')
  cachedConfig = payload
}

function buildGuiPlusMessages(
  instruction: string,
  imageDataUrl: string,
  config: GuiPlusConfig,
  overrides?: { minPixels?: number; maxPixels?: number },
): GuiPlusMessage[] {
  const minPixels = overrides?.minPixels ?? config.minPixels
  const maxPixels = overrides?.maxPixels ?? config.maxPixels
  return [
    { role: 'system', content: GUI_PLUS_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: imageDataUrl },
          ...(minPixels ? { min_pixels: minPixels } : {}),
          ...(maxPixels ? { max_pixels: maxPixels } : {}),
        },
        { type: 'text', text: instruction },
      ],
    },
  ]
}

function extractFirstJsonObject(text: string): unknown | null {
  if (!text) return null
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const snippet = candidate.slice(start, end + 1)
  try {
    return JSON.parse(snippet)
  } catch {
    return null
  }
}

export type GuiPlusResult = {
  raw: string
  parsed: unknown | null
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedTokens?: number
  }
}

export async function runGuiPlus(
  config: GuiPlusConfig,
  instruction: string,
  imageDataUrl: string,
  options?: { minPixels?: number; maxPixels?: number; signal?: AbortSignal; logScope?: string },
): Promise<GuiPlusResult> {
  if (!config.apiKey || !config.model) {
    throw new Error('GUI-Plus missing API key or model')
  }

  const messages = buildGuiPlusMessages(instruction, imageDataUrl, config, options)
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.01,
    stream: false,
  }

  if (config.highResolution) {
    body.vl_high_resolution_images = true
  }

  const url = `${config.baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }
  const startTime = Date.now()

  log('REQUEST', {
    url,
    method: 'POST',
    headers,
    body,
  }, options?.logScope)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })
  } catch (err) {
    log('ERROR', {
      url,
      error: String(err),
      durationMs: Date.now() - startTime,
    }, options?.logScope)
    throw err
  }

  const rawText = await response.text()
  log('RESPONSE', {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs: Date.now() - startTime,
    body: rawText,
  }, options?.logScope)

  if (!response.ok) {
    throw new Error(`GUI-Plus request failed: ${response.status} ${response.statusText} ${rawText}`)
  }

  const data = JSON.parse(rawText)
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('GUI-Plus returned empty content')
  }

  return {
    raw: String(content),
    parsed: extractFirstJsonObject(String(content)),
    usage: (data && typeof data === 'object' && data.usage && typeof data.usage === 'object')
      ? {
        promptTokens: Number.isFinite(Number(data.usage.prompt_tokens)) ? Number(data.usage.prompt_tokens) : undefined,
        completionTokens: Number.isFinite(Number(data.usage.completion_tokens)) ? Number(data.usage.completion_tokens) : undefined,
        totalTokens: Number.isFinite(Number(data.usage.total_tokens)) ? Number(data.usage.total_tokens) : undefined,
        cachedTokens: (
          data.usage.prompt_tokens_details &&
          typeof data.usage.prompt_tokens_details === 'object' &&
          Number.isFinite(Number((data.usage.prompt_tokens_details as Record<string, unknown>).cached_tokens))
        )
          ? Number((data.usage.prompt_tokens_details as Record<string, unknown>).cached_tokens)
          : undefined,
      }
      : undefined,
  }
}

export async function fileToDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/png'
  return `data:${mime};base64,${buffer.toString('base64')}`
}
