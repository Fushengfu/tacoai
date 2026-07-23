/**
 * 工具执行器 - 技能（run_skill_script / search_skills / install_skill / uninstall_skill）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { AgentServices } from '../services'
import type { BrowserActionType } from '../types'
import {
  execFileAsync,
  getRunCommandEnv,
  isAbortError,
  type ExecResult,
  type ToolRuntimeContext,
} from './exec-utils'
import {
  searchSkills,
  previewSkill,
  installSkill,
  uninstallSkill,
  isClawHubSlug,
  buildClawHubDownloadUrl,
  downloadAndExtractZip,
} from '../skills/service'
import { execDesktopScreenshot, execDesktopAction, execDesktopOcr } from './exec-desktop'
import { execBrowserAction, execBrowserGetConsoleLogs, execBrowserGetNetworkRequests, execBrowserGetCookies, execBrowserSetCookie, execBrowserClearCookies, execBrowserOcr, scopedBrowserAppId } from './exec-browser'

/* ------------------------------------------------------------------ */
/*  浏览器动作映射表                                                    */
/* ------------------------------------------------------------------ */

const BROWSER_SCRIPT_TO_ACTION: Record<string, BrowserActionType> = {
  navigate: 'navigate',
  screenshot: 'screenshot',
  click: 'click',
  type: 'type',
  scroll: 'scroll',
  hover: 'hover',
  keypress: 'keypress',
  drag: 'drag',
  select: 'select',
  get_content: 'get_content',
  wait: 'wait',
  evaluate: 'evaluate',
  get_info: 'get_info',
}

/* ------------------------------------------------------------------ */
/*  run_skill_script                                                   */
/* ------------------------------------------------------------------ */

export async function execRunSkillScript(
  args: Record<string, unknown>,
  workspace: string,
  projectId?: string,
  signal?: AbortSignal,
  logScope?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  const scriptName = String(args.script_name ?? '').trim()
  const params = (args.params ?? {}) as Record<string, unknown>

  if (!skillId) return { content: 'Error: skill_id is required', success: false }
  if (!scriptName) return { content: 'Error: script_name is required', success: false }

  const services = runtimeContext?.services

  if (skillId === 'browser-use') {
    if (scriptName === 'get_console_logs') {
      return await execBrowserGetConsoleLogs(params, projectId, services)
    }
    if (scriptName === 'get_network_requests') {
      return await execBrowserGetNetworkRequests(params, projectId, services)
    }
    if (scriptName === 'get_cookies') {
      return await execBrowserGetCookies(params, projectId, services)
    }
    if (scriptName === 'set_cookie') {
      return await execBrowserSetCookie(params, projectId, services)
    }
    if (scriptName === 'clear_cookies') {
      return await execBrowserClearCookies(params, projectId, services)
    }
    if (scriptName === 'list') {
      if (!services?.browser) return { content: 'Error: browser service not available', success: false }
      const instances = services.browser.listInstances()
      // 按当前项目过滤，只返回本项目的窗口
      const projectKey = scopedBrowserAppId(projectId) // "project-{safe}"
      const prefix = projectKey ? projectKey + '::' : ''
      const filtered = instances
        .filter((inst: any) => {
          if (!projectKey) return true
          return inst.appId === projectKey || inst.appId.startsWith(prefix)
        })
        .map((inst: any) => {
          let shortAppId: string
          if (inst.appId === projectKey) {
            shortAppId = 'default' // 项目默认窗口
          } else if (prefix && inst.appId.startsWith(prefix)) {
            shortAppId = inst.appId.slice(prefix.length)
          } else {
            shortAppId = inst.appId
          }
          return { ...inst, appId: shortAppId }
        })
      return { content: JSON.stringify(filtered, null, 2), success: true }
    }
    if (scriptName === 'close') {
      if (!services?.browser) return { content: 'Error: browser service not available', success: false }
      if (!params.appId) return { content: 'Error: appId is required. Use list to get all browser window IDs, then close them one by one.', success: false }
      const shortAppId = String(params.appId)
      // 'default' 或空 → 项目默认窗口；其余 → project::appId
      const fullAppId = scopedBrowserAppId(projectId, (shortAppId === 'default' || !shortAppId) ? undefined : shortAppId) ?? 'default'
      services.browser.closeInstance(fullAppId)
      return { content: `浏览器窗口 [${shortAppId}] 已关闭`, success: true }
    }
    if (scriptName === 'ocr') {
      return await execBrowserOcr(params, projectId, services, runtimeContext)
    }
    const action = BROWSER_SCRIPT_TO_ACTION[scriptName]
    if (!action) {
      return {
        content: `浏览器技能不支持此脚本: ${scriptName}。可用脚本: ${Object.keys(BROWSER_SCRIPT_TO_ACTION).join(', ')}, get_console_logs, get_network_requests, get_cookies, set_cookie, clear_cookies, ocr, list, close`,
        success: false,
      }
    }
    return await execBrowserAction(action, params, projectId, services, runtimeContext, workspace)
  }

  if (skillId === 'computer-use') {
    if (scriptName === 'screenshot') {
      return await execDesktopScreenshot(params, logScope, services, runtimeContext, workspace)
    }
    if (scriptName === 'action') {
      return await execDesktopAction(params, signal, logScope, services)
    }
    if (scriptName === 'ocr') {
      return await execDesktopOcr(params, services)
    }
    return {
      content: `电脑使用技能不支持此脚本: ${scriptName}。可用脚本: screenshot, action, ocr`,
      success: false,
    }
  }

  // ---- 外部技能：子进程执行脚本 ----
  const { getSkillRootDir } = await import('../skills/service')
  const rootDir = getSkillRootDir(skillId)
  if (!rootDir) {
    return { content: `技能 "${skillId}" 未找到或未激活`, success: false }
  }

  // 白名单校验：scriptName 只允许安全字符
  if (!/^[a-zA-Z0-9._-]+$/.test(scriptName)) {
    return { content: `Error: 非法的 script_name，只允许字母、数字、点、下划线和连字符`, success: false }
  }

  const scriptPath = path.join(rootDir, 'scripts', scriptName)
  const MAX_OUTPUT_CHARS = 12000
  const TIMEOUT_MS = 120_000

  try {
    const env = await getRunCommandEnv()
    const { stdout, stderr } = await execFileAsync(scriptPath, [], {
      cwd: path.dirname(scriptPath),
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env,
    })

    const combined = (stdout ? `stdout:\n${stdout}` : '') +
      (stderr ? `\nstderr:\n${stderr}` : '')

    if (combined.length > MAX_OUTPUT_CHARS) {
      return {
        content: combined.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[输出已截断，共 ${combined.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS} 字符]`,
        success: true,
      }
    }

    return { content: combined || '(命令执行成功，无输出)', success: true }
  } catch (err) {
    if (isAbortError(err)) throw err
    const execErr = err as Error & { stdout?: string; stderr?: string; code?: string | number }
    const stdout = execErr.stdout ?? ''
    const stderr = execErr.stderr ?? ''
    const combined = (stdout ? `stdout:\n${stdout}` : '') + (stderr ? `\nstderr:\n${stderr}` : '')

    let reason = execErr.message
    if (execErr.code === 'ENOENT') reason = `脚本未找到: ${scriptPath}`
    else if (execErr.code === 'EACCES') reason = `脚本无执行权限: ${scriptPath}`

    const output = combined.length > MAX_OUTPUT_CHARS
      ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n\n[输出已截断]`
      : combined

    return {
      content: `Error: ${reason}${output ? '\n\n' + output : ''}`,
      success: false,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  search_skills                                                      */
/* ------------------------------------------------------------------ */

export async function execSearchSkills(
  args: Record<string, unknown>,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const query = String(args.query ?? '').trim()
  if (!query) return { content: 'Error: query is required', success: false }

  const source = (String(args.source ?? 'all').trim() || 'all') as 'clawhub' | 'skillhub' | 'all'
  const services = runtimeContext?.services

  try {
    const results = await searchSkills(query, source)

    if (results.length === 0) {
      const sourceLabel = source === 'clawhub' ? 'ClawHub' : source === 'skillhub' ? '腾讯 SkillHub' : 'ClawHub 和腾讯 SkillHub'
      return { content: `在${sourceLabel}技能市场中未找到与"${query}"相关的技能。请尝试换一些关键词。`, success: true }
    }

    const items = results.map((item) => ({
      name: item.displayName,
      slug: item.slug,
      description: item.summary || '无描述',
      author: item.authorName || '未知',
      downloads: item.downloads ?? 0,
      version: item.version || '—',
      source: item.source,
      installSlug: item.slug,
    }))

    const sourceLabel = source === 'clawhub' ? 'ClawHub 技能市场（clawhub.ai）' : source === 'skillhub' ? '腾讯 SkillHub（skillhub.cloud.tencent.com）' : 'ClawHub + 腾讯 SkillHub（双源合并）'

    return {
      content: JSON.stringify({
        source: sourceLabel,
        total: results.length,
        results: items,
        hint: '使用 install_skill 工具安装你感兴趣的技能。传入 source 参数为搜索结果中的 slug 字段。',
      }, null, 2),
      success: true,
    }
  } catch (err) {
    services?.logger('SEARCH_SKILLS_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return { content: `Error: 搜索技能失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  install_skill                                                      */
/* ------------------------------------------------------------------ */

function buildSecurityPreview(preview: { name: string; description: string; author: string; security?: { riskLevel: string; warnings: string[] } }): string {
  const sec = preview.security
  if (!sec || sec.warnings.length === 0) {
    return `✅ 技能"${preview.name}"安全检查通过，无风险。`
  }

  const levelLabel: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '致命',
  }
  const label = levelLabel[sec.riskLevel] ?? sec.riskLevel

  let report = `🔍 技能"${preview.name}"安全检查报告：\n`
  report += `- 作者: ${preview.author}\n`
  report += `- 描述: ${preview.description}\n`
  report += `- 风险等级: ${label}\n`
  report += `- 风险项:\n`
  for (const w of sec.warnings) {
    report += `  ⚠ ${w}\n`
  }
  return report
}

export async function execInstallSkill(
  args: Record<string, unknown>,
  workspace: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const source = String(args.source ?? '').trim()
  if (!source) return { content: 'Error: source is required', success: false }

  const force = args.force === true || args.force === 'true'
  const services = runtimeContext?.services

  try {
    // slug 安装（ClawHub / SkillHub 自动回退）
    if (isClawHubSlug(source)) {
      services?.logger('INSTALL_SKILL_SLUG_START', { slug: source, force })

      let slugTmpDir = ''
      let slugSourceLabel = 'ClawHub'

      try {
        slugTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taco-skill-'))
        await downloadAndExtractZip(buildClawHubDownloadUrl(source), slugTmpDir, services?.logger)
        services?.logger('INSTALL_SKILL_SOURCE', { slug: source, sourceType: 'clawhub' })
      } catch (clawhubErr) {
        services?.logger('INSTALL_SKILL_CLAWHUB_FAILED', { slug: source, error: String(clawhubErr) })
        try { await fs.rm(slugTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        try {
          slugTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taco-skill-'))
          const skillHubDownloadUrl = `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(source.replace(/^@/, '').split('/').pop() ?? source)}`
          await downloadAndExtractZip(skillHubDownloadUrl, slugTmpDir, services?.logger)
          slugSourceLabel = '腾讯 SkillHub'
          services?.logger('INSTALL_SKILL_SOURCE', { slug: source, sourceType: 'skillhub' })
        } catch (skillhubErr) {
          await fs.rm(slugTmpDir, { recursive: true, force: true }).catch(() => {})
          return { content: `Error: 安装失败，ClawHub 和 SkillHub 均未找到技能"${source}"。`, success: false }
        }
      }

      const findSkillMdDir = async (dir: string): Promise<string> => {
        try {
          await fs.access(path.join(dir, 'SKILL.md'))
          return dir
        } catch {
          const entries = await fs.readdir(dir)
          for (const entry of entries) {
            const subDir = path.join(dir, entry)
            try {
              const stat = await fs.stat(subDir)
              if (stat.isDirectory()) {
                const result = await findSkillMdDir(subDir)
                if (result) return result
              }
            } catch { /* ignore */ }
          }
        }
        return ''
      }

      const skillDir = await findSkillMdDir(slugTmpDir)
      if (!skillDir) {
        await fs.rm(slugTmpDir, { recursive: true, force: true })
        return { content: 'Error: 下载的技能包中未找到 SKILL.md 文件', success: false }
      }

      services?.logger('INSTALL_SKILL_EXTRACTED', { skillDir, sourceType: slugSourceLabel })

      if (!force) {
        const preview = await previewSkill(skillDir)
        const securityPreview = buildSecurityPreview(preview)

        if (preview.security?.riskLevel === 'critical') {
          await fs.rm(slugTmpDir, { recursive: true, force: true })
          return { content: securityPreview, success: false }
        }

        if (preview.security?.riskLevel === 'high') {
          await fs.rm(slugTmpDir, { recursive: true, force: true })
          return {
            content: securityPreview + `\n\n⚠️ 该技能风险等级为"高"，不会自动安装。如果你确认信任此技能并希望安装，请回复"安装"或"继续"，我将使用 force=true 强制安装。`,
            success: false,
          }
        }
      }

      const skill = await installSkill(skillDir, true, source)
      await fs.rm(slugTmpDir, { recursive: true, force: true })
      services?.logger('INSTALL_SKILL_DONE', { id: skill.id, name: skill.name, source: slugSourceLabel })

      return {
        content: JSON.stringify({
          message: `技能"${skill.name}"（${skill.id}）从 ${slugSourceLabel} 安装成功，已立即可用。`,
          skill: { id: skill.id, name: skill.name, description: skill.description, version: skill.version, author: skill.author },
        }),
        success: true,
      }
    }

    // GitHub URL / Raw URL / 本地路径
    services?.logger('INSTALL_SKILL_START', { source, force })

    if (!force) {
      const preview = await previewSkill(source)
      const securityPreview = buildSecurityPreview(preview)

      if (preview.security?.riskLevel === 'critical') {
        return { content: securityPreview, success: false }
      }

      if (preview.security?.riskLevel === 'high') {
        return {
          content: securityPreview + `\n\n⚠️ 该技能风险等级为"高"，不会自动安装。如果你确认信任此技能并希望安装，请回复"安装"或"继续"，我将使用 force=true 强制安装。`,
          success: false,
        }
      }
    }

    const skill = await installSkill(source, true)
    services?.logger('INSTALL_SKILL_DONE', { id: skill.id, name: skill.name })

    return {
      content: JSON.stringify({
        message: `技能"${skill.name}"（${skill.id}）安装成功，已立即可用。`,
        skill: { id: skill.id, name: skill.name, description: skill.description, version: skill.version, author: skill.author },
      }),
      success: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    services?.logger('INSTALL_SKILL_FAIL', { error: msg, source })
    return { content: `Error: 安装技能失败: ${msg}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  uninstall_skill                                                    */
/* ------------------------------------------------------------------ */

export async function execUninstallSkill(
  args: Record<string, unknown>,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const id = String(args.skill_id ?? '').trim()
  if (!id) return { content: 'Error: skill_id is required（要卸载的技能 ID）', success: false }

  const services = runtimeContext?.services

  try {
    await uninstallSkill(id)
    services?.logger('UNINSTALL_SKILL_DONE', { id })

    return {
      content: `<uninstall_skill_result>技能"${id}"已成功卸载并移除。</uninstall_skill_result>`,
      success: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    services?.logger('UNINSTALL_SKILL_FAIL', { error: msg, id })

    if (msg.includes('not found')) {
      return { content: `Error: 未找到技能"${id}"，请确认技能 ID 是否正确。`, success: false }
    }
    if (msg.includes('builtin')) {
      return { content: `Error: 不能卸载内置技能"${id}"，只能卸载从 ClawHub 或外部安装的技能。`, success: false }
    }

    return { content: `Error: 卸载技能失败: ${msg}`, success: false }
  }
}
