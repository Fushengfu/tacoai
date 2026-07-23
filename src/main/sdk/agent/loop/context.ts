/**
 * Agent 循环 - 上下文构建管线
 *
 * 负责：
 *   1. 背景记忆回放（任务记忆重组、笔记注入）
 *   2. 系统提示注入（Skills 目录、工作空间目录树、工具设计清单）
 *   3. Runtime tool prompt 构建与同步
 */

import { createHash } from 'node:crypto'
import type { ChatMessage, ProviderOverrides } from '../llm/client'
import type { ProviderKey } from '../llm/client'
import { extractTextFromContent } from '../llm/adapter'
import { getWorkspaceTree, getToolDesignPromptBlock, buildAllowedToolNamesForRequest } from '../tools'
import { refreshSkills, buildActiveSkillsCatalogBlock, getActiveSkillEnv, applySkillEnvironment } from '../skills/service'
import { buildBackgroundContextConversationMessages } from '../memory/'
import type { RecallMeta } from '../memory/memory-recall'
import {
  extractUserQueryText,
  extractUserAssetsBlock,
} from '../shared/user-assets'

/* ------------------------------------------------------------------ */
/*  Runtime Tool Prompt 构建                                           */
/* ------------------------------------------------------------------ */

const TOOL_PROMPT_SENTINEL_START = '<!--TACO_RUNTIME_TOOL_PROMPT_START-->'
const TOOL_PROMPT_SENTINEL_END = '<!--TACO_RUNTIME_TOOL_PROMPT_END-->'
const TOOL_PROMPT_LEGACY_BLOCK_REGEX = /\[RUNTIME_TOOL_PROMPT\][\s\S]*?\[\/RUNTIME_TOOL_PROMPT\]/g
const TOOL_PROMPT_SENTINEL_BLOCK_REGEX = /<!--TACO_RUNTIME_TOOL_PROMPT_START-->[\s\S]*?<!--TACO_RUNTIME_TOOL_PROMPT_END-->/g

export function buildRuntimeToolPrompt(allowedToolNames: Iterable<string>): string {
  return `${TOOL_PROMPT_SENTINEL_START}\n[RUNTIME_TOOL_PROMPT]\n${getToolDesignPromptBlock(allowedToolNames)}\n[/RUNTIME_TOOL_PROMPT]\n${TOOL_PROMPT_SENTINEL_END}`
}

export function syncRuntimeToolPrompt(workingMessages: ChatMessage[], nextBlock: string) {
  if (!workingMessages.length || workingMessages[0].role !== 'system') return
  const current = typeof workingMessages[0].content === 'string'
    ? workingMessages[0].content
    : extractTextFromContent(workingMessages[0].content)
  const cleanedBase = current
    .replace(TOOL_PROMPT_SENTINEL_BLOCK_REGEX, '\n')
    .replace(TOOL_PROMPT_LEGACY_BLOCK_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  workingMessages[0] = {
    ...workingMessages[0],
    content: cleanedBase ? `${cleanedBase}\n\n${nextBlock}` : nextBlock,
  }
}

/* ------------------------------------------------------------------ */
/*  背景记忆注入：任务记忆回放 + 笔记                                  */
/* ------------------------------------------------------------------ */

export interface BackgroundContextResult {
  currentTaskStartIndex: number
  latestRecallMeta: Pick<RecallMeta, 'intentSource' | 'intentType' | 'intentSummary' | 'intentGoal'> | null
}

export async function injectBackgroundContext(
  workingMessages: ChatMessage[],
  workspace: string,
  projectId: string | undefined,
  contextLength: number | undefined,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  log: (...args: any[]) => void,
  recallDebug: boolean,
): Promise<BackgroundContextResult> {
  let currentTaskStartIndex = Math.max(1, workingMessages.map((m) => m.role).lastIndexOf('user'))
  let latestRecallMeta: BackgroundContextResult['latestRecallMeta'] = null

  try {
    let lastUserIdx = -1
    for (let i = workingMessages.length - 1; i >= 0; i--) {
      if (workingMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx >= 0) {
      const userMessage = workingMessages[lastUserIdx]
      const userContent: unknown = userMessage.content
      let rawUserQuery = ''

      if (typeof userContent === 'string') {
        rawUserQuery = userContent
      } else if (Array.isArray(userContent)) {
        rawUserQuery = (userContent as Array<{ type?: string; text?: string }>)
          .filter((part) => part.type === 'text')
          .map((part) => part.text || '')
          .join('\n')

        const imageParts = (userContent as Array<{ type?: string; image_url?: { url?: string } }>)
          .filter((part) => part.type === 'image_url')
          .map((part) => part.image_url?.url)
          .filter(Boolean)

        if (imageParts.length > 0) {
          const assetsBlock = `[USER_ASSETS]\n${imageParts.map((url) => `- type: image\n  path: ${url}`).join('\n')}\n[/USER_ASSETS]`
          rawUserQuery = rawUserQuery ? `${rawUserQuery}\n\n${assetsBlock}` : assetsBlock
        }
      } else {
        rawUserQuery = String(userContent ?? '')
      }

      const messageImages = (userMessage as any).images
      if (messageImages && messageImages.length > 0) {
        const assetsBlock = `[USER_ASSETS]\n${messageImages.map((url: string) => `- type: image\n  path: ${url}`).join('\n')}\n[/USER_ASSETS]`
        rawUserQuery = rawUserQuery ? `${rawUserQuery}\n\n${assetsBlock}` : assetsBlock
      }

      if (rawUserQuery.includes('[USER_QUERY]')) {
        const match = rawUserQuery.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
        if (match && match[1]) {
          rawUserQuery = match[1].trim()
        }
      }

      const injected = await buildBackgroundContextConversationMessages(
        workspace,
        userContent,
        projectId,
        {
          contextLength,
          reason: 'initial',
          replayMode: 'full',
          provider,
          overrides,
          signal,
          logScope,
        },
      )

      if (injected.noteMessages.length > 0) {
        const insertIdx = workingMessages.length > 0 && workingMessages[0].role === 'system' ? 1 : 0
        workingMessages.splice(insertIdx, 0, ...injected.noteMessages)
      }

      const systemMsgCount = workingMessages.filter(m => m.role === 'system').length
      const historyStartIdx = systemMsgCount > 0 ? systemMsgCount : 0
      workingMessages.splice(historyStartIdx, workingMessages.length - historyStartIdx, ...injected.messages)
      currentTaskStartIndex = historyStartIdx + injected.messages.length - 1

      latestRecallMeta = {
        intentSource: injected.recallMeta.intentSource,
        intentType: injected.recallMeta.intentType,
        intentSummary: injected.recallMeta.intentSummary,
        intentGoal: injected.recallMeta.intentGoal,
      }
      log('BACKGROUND_CONTEXT_REPLAY_INJECTED', {
        lastUserIndex: lastUserIdx,
        replayedTurns: injected.replayedTaskMemories.length,
        droppedReplayCount: injected.droppedReplayCount,
        droppedReplayByLimitCount: injected.droppedReplayByLimitCount,
        notesCount: injected.notes.length,
        noteMessagesCount: injected.noteMessages.length,
        recalledCount: injected.recalled.length,
        recallMeta: injected.recallMeta,
        rawUserQuery,
        recalledNotes: injected.notes,
        recalledItems: injected.recalled,
        ...(recallDebug ? { recallDebug: injected.recallDebug } : {}),
      }, logScope)
    }
  } catch (err) {
    log('NOTES_USER_CONTEXT_INJECT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  return { currentTaskStartIndex, latestRecallMeta }
}

/* ------------------------------------------------------------------ */
/*  系统提示注入：Skills + 目录树 + 工具清单                           */
/* ------------------------------------------------------------------ */

export async function injectSystemPrompts(
  workingMessages: ChatMessage[],
  workspace: string,
  skillsCatalogBlock: string,
  log: (...args: any[]) => void,
  logScope: string | undefined,
): Promise<void> {
  if (workingMessages.length === 0 || workingMessages[0].role !== 'system') return

  let extraPrompt = ''

  if (skillsCatalogBlock.trim()) {
    extraPrompt += `\n\n${skillsCatalogBlock}`
  }

  try {
    const tree = await getWorkspaceTree(workspace, { maxDepth: 5, maxLines: Infinity, maxEntries: 50000 })
    if (tree && tree.text) {
      extraPrompt += '\n\n# 当前工作空间目录结构\n以下是项目目录树（自动生成，无需再次调用 list_dir 查看根目录结构）：\n```\n' + tree.text + '\n```\n注意：此目录树在对话开始时生成。如果你在执行过程中创建了新文件，目录树不会实时更新，可按需调用 list_dir 查看最新状态。如果目录树未能展示完整的项目结构（如深度不足或条目被截断），可使用 run_command 执行 `find . -maxdepth 6 -not -path "*/node_modules/*" -not -path "*/.git/*"` 或 `tree -L 5 -I "node_modules|.git|dist"` 等命令获取更完整的目录信息。'
    }
  } catch (err) {
    log('WORKSPACE_TREE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  try {
    extraPrompt += `\n\n${buildRuntimeToolPrompt(buildAllowedToolNamesForRequest())}`
  } catch (err) {
    log('TOOL_DESIGN_PROMPT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  if (extraPrompt) {
    const currentContent = typeof workingMessages[0].content === 'string'
      ? workingMessages[0].content
      : extractTextFromContent(workingMessages[0].content)
    workingMessages[0] = { ...workingMessages[0], content: currentContent + extraPrompt }
  }
}

/* ------------------------------------------------------------------ */
/*  Skills 刷新与环境变量                                              */
/* ------------------------------------------------------------------ */

export async function refreshSkillsWithEnv(
  workspace: string,
  log: (...args: any[]) => void,
  logScope: string | undefined,
): Promise<{ catalogBlock: string; restoreEnv: () => void }> {
  try {
    await refreshSkills(workspace)
  } catch (err) {
    log('SKILLS_REFRESH_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  const restoreSkillEnv = applySkillEnvironment(getActiveSkillEnv())
  const skillsCatalogBlock = buildActiveSkillsCatalogBlock()
  return { catalogBlock: skillsCatalogBlock, restoreEnv: restoreSkillEnv }
}

/* ------------------------------------------------------------------ */
/*  userId 构建                                                        */
/* ------------------------------------------------------------------ */

export function buildUserId(
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  projectId: string | undefined,
  workspace: string,
): string {
  const resolvedApiKey = (overrides?.[provider] as any)?.apiKey ?? ''
  const userIdSource = `${resolvedApiKey}:${projectId ?? workspace}`
  return createHash('sha256').update(userIdSource).digest('hex').slice(0, 32)
}
