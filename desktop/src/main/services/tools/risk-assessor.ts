/**
 * 风险评估模块
 *
 * 包含工具调用风险评估、风险分类、自动授权管理。
 */

import path from 'node:path'
import type { ToolCall } from './definitions'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'safe' | 'warning' | 'danger'

export type RiskInfo = {
  toolCallId: string
  toolName: string
  level: RiskLevel
  reason: string
  /** 触发风险的关键信息（如命令内容） */
  detail: string
}

/** 风险分类 ID */
export type RiskCategory =
  | 'package_install'  // 安装依赖
  | 'privilege_cmd'    // 权限提升
  | 'destructive_cmd'  // 文件系统危险操作
  | 'system_modify'    // 系统修改
  | 'git_force'        // Git 强制操作
  | 'network_script'   // 网络脚本
  | 'git_ops'          // Git 常规操作
  | 'docker_ops'       // Docker 操作
  | 'browser_ops'      // 浏览器操作
  | 'desktop_ops'      // 桌面操作

/** 风险分类信息（供 UI 展示用） */
export const RISK_CATEGORY_INFO: { id: RiskCategory; label: string; description: string; level: 'danger' | 'warning' }[] = [
  { id: 'package_install', label: '安装依赖', description: 'npm install, pip install 等包管理器操作', level: 'danger' },
  { id: 'privilege_cmd', label: '权限提升', description: 'sudo, su 等需要 root 权限的命令', level: 'danger' },
  { id: 'destructive_cmd', label: '删除/权限操作', description: 'rm -rf, chmod, chown 等破坏性命令', level: 'danger' },
  { id: 'system_modify', label: '系统修改', description: 'mkfs, dd 等磁盘级操作', level: 'danger' },
  { id: 'git_force', label: 'Git 强制操作', description: 'git push --force, git reset --hard', level: 'danger' },
  { id: 'network_script', label: '网络脚本', description: 'curl | sh 等下载并执行的命令', level: 'danger' },
  { id: 'git_ops', label: 'Git 操作', description: 'git push, git merge, git rebase 等', level: 'warning' },
  { id: 'docker_ops', label: 'Docker 操作', description: 'docker run, docker build 等容器操作', level: 'warning' },
  { id: 'browser_ops', label: '浏览器操作', description: 'AI 操控浏览器执行自动化', level: 'warning' },
  { id: 'desktop_ops', label: '桌面操作', description: 'AI 操控鼠标/键盘/输入等桌面自动化', level: 'warning' },
]

/** 危险命令关键词匹配表：[正则, 描述, 分类] */
const DANGER_PATTERNS: [RegExp, string, RiskCategory][] = [
  // 包安装
  [/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/i, '安装 npm 包', 'package_install'],
  [/\bpip3?\s+install\b/i, '安装 Python 包', 'package_install'],
  [/\b(brew|apt|apt-get|yum|dnf|pacman|apk)\s+install\b/i, '安装系统软件', 'package_install'],
  [/\bcargo\s+(install|add)\b/i, '安装 Rust 包', 'package_install'],
  [/\bgo\s+(install|get)\b/i, '安装 Go 包', 'package_install'],
  [/\bgem\s+install\b/i, '安装 Ruby Gem', 'package_install'],
  // 权限提升
  [/\bsudo\b/i, '使用 sudo 提权', 'privilege_cmd'],
  [/\bsu\s/i, '切换用户', 'privilege_cmd'],
  // 破坏性操作
  [/\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)/i, '递归/强制删除文件', 'destructive_cmd'],
  [/\brm\s+-rf\b/i, '递归强制删除', 'destructive_cmd'],
  [/\brmdir\b/i, '删除目录', 'destructive_cmd'],
  // 系统修改
  [/\bchmod\b/i, '修改文件权限', 'system_modify'],
  [/\bchown\b/i, '修改文件所有者', 'system_modify'],
  [/\bmkfs\b/i, '格式化磁盘', 'system_modify'],
  [/\bdd\s+if=/i, '磁盘级写入', 'system_modify'],
  // Git 危险操作
  [/\bgit\s+(push\s+(-[a-zA-Z]*f|--force)|reset\s+--hard)/i, 'Git 强制操作', 'git_force'],
  // 网络相关
  [/\bcurl\b.*\|\s*(sh|bash)\b/i, '下载并执行脚本', 'network_script'],
  [/\bwget\b.*\|\s*(sh|bash)\b/i, '下载并执行脚本', 'network_script'],
]

/** 警告级别的命令模式：[正则, 描述, 分类] */
const WARNING_PATTERNS: [RegExp, string, RiskCategory][] = [
  [/\bgit\s+push\b/i, 'Git push', 'git_ops'],
  [/\bgit\s+checkout\s+(-b|--orphan)/i, 'Git 创建分支', 'git_ops'],
  [/\bgit\s+merge\b/i, 'Git merge', 'git_ops'],
  [/\bgit\s+rebase\b/i, 'Git rebase', 'git_ops'],
  [/\bdocker\s+(run|build|pull|push)\b/i, 'Docker 操作', 'docker_ops'],
]

/** 浏览器操作工具名前缀 */
const BROWSER_TOOL_PREFIX = 'browser_'
/** 桌面操作工具名前缀 */
const DESKTOP_TOOL_PREFIX = 'desktop_'

/** 是否已在本次会话中确认过浏览器接管 */
let browserAutoApproved = false
/** 是否已在本次会话中确认过桌面接管 */
let desktopAutoApproved = false

/** 外部可调用：设置浏览器全局接管（从设置页面调用） */
export function setBrowserAutoApproved(approved: boolean) {
  browserAutoApproved = approved
}

/** 获取浏览器接管状态 */
export function isBrowserAutoApproved() {
  return browserAutoApproved
}

export function setDesktopAutoApproved(approved: boolean) {
  desktopAutoApproved = approved
}

export function isDesktopAutoApproved() {
  return desktopAutoApproved
}

/** 已自动授权的风险分类集合 */
const autoApproveCategories = new Set<RiskCategory>()

/** 设置自动授权分类列表（从设置页面调用） */
export function setAutoApproveCategories(categories: RiskCategory[]) {
  autoApproveCategories.clear()
  for (const cat of categories) autoApproveCategories.add(cat)
  // browser_ops 同步到 browserAutoApproved
  if (autoApproveCategories.has('browser_ops')) {
    browserAutoApproved = true
  }
  // desktop_ops 同步到 desktopAutoApproved
  if (autoApproveCategories.has('desktop_ops')) {
    desktopAutoApproved = true
  }
}

/** 获取当前自动授权分类列表 */
export function getAutoApproveCategories(): RiskCategory[] {
  return [...autoApproveCategories]
}

function isPathWithinWorkspace(workspace: string, targetPath: string): boolean {
  const normalizedWs = path.normalize(workspace)
  const normalizedTarget = path.normalize(targetPath)
  return normalizedTarget === normalizedWs || normalizedTarget.startsWith(`${normalizedWs}${path.sep}`)
}

/** 评估一批工具调用的风险等级 */
export function assessToolCallsRisk(toolCalls: ToolCall[], workspace?: string): RiskInfo[] {
  const risks: RiskInfo[] = []

  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(tc.function.arguments) } catch { continue }

    const toolName = tc.function.name

    // 浏览器工具：首次需要确认，确认后本次会话自动放行
    if (toolName.startsWith(BROWSER_TOOL_PREFIX) && !browserAutoApproved && !autoApproveCategories.has('browser_ops')) {
      const url = String(args.url ?? args.selector ?? args.expression ?? '')
      risks.push({
        toolCallId: tc.id,
        toolName,
        level: 'warning',
        reason: `浏览器操作: ${toolName.replace(BROWSER_TOOL_PREFIX, '')}`,
        detail: url || '(无参数)',
      })
      continue
    }

    if (toolName.startsWith(DESKTOP_TOOL_PREFIX) && !desktopAutoApproved && !autoApproveCategories.has('desktop_ops')) {
      const info = String(args.action ?? args.key ?? args.text ?? '')
      risks.push({
        toolCallId: tc.id,
        toolName,
        level: 'warning',
        reason: `桌面操作: ${toolName.replace(DESKTOP_TOOL_PREFIX, '')}`,
        detail: info || '(无参数)',
      })
      continue
    }

    if (toolName === 'read_file') {
      const targetPath = String(args.path ?? '').trim()
      const ws = String(workspace ?? '').trim()
      if (targetPath && ws) {
        const cleaned = targetPath.replace(/^\/+/, '').replace(/\/+$/, '') || '.'
        const candidate = path.isAbsolute(targetPath)
          ? path.normalize(targetPath)
          : path.normalize(path.resolve(ws, cleaned))
        if (!isPathWithinWorkspace(ws, candidate)) {
          risks.push({
            toolCallId: tc.id,
            toolName,
            level: 'danger',
            reason: '读取工作空间外文件',
            detail: candidate,
          })
          continue
        }
      }
      if (targetPath && !ws) {
        risks.push({
          toolCallId: tc.id,
          toolName,
          level: 'danger',
          reason: '读取工作空间外文件',
          detail: targetPath,
        })
        continue
      }
    }

    if (toolName === 'run_command') {
      const command = String(args.command ?? '')
      if (!command) continue

      // 先检查危险级别
      for (const [pattern, reason, category] of DANGER_PATTERNS) {
        if (pattern.test(command)) {
          if (autoApproveCategories.has(category)) break
          risks.push({
            toolCallId: tc.id,
            toolName,
            level: 'danger',
            reason,
            detail: command,
          })
          break // 一个命令只报最高级别
        }
      }

      // 未命中 danger 则检查 warning
      if (!risks.some((r) => r.toolCallId === tc.id)) {
        for (const [pattern, reason, category] of WARNING_PATTERNS) {
          if (pattern.test(command)) {
            if (autoApproveCategories.has(category)) break
            risks.push({
              toolCallId: tc.id,
              toolName,
              level: 'warning',
              reason,
              detail: command,
            })
            break
          }
        }
      }
    }
  }

  return risks
}
