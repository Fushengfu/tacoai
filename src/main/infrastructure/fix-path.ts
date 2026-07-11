/**
 * fix-path — 修复打包后 PATH 不完整的问题（macOS / Linux / Windows）
 *
 * macOS: 从 Finder 启动 .app 时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
 * Windows: 从桌面快捷方式启动时可能缺少用户级 PATH（nvm-windows, volta, scoop 等）
 * Linux: 从桌面环境启动时可能缺少 ~/.local/bin 等
 *
 * 原理：
 * - macOS/Linux：启动用户登录 shell 提取完整 PATH
 * - Windows：从注册表读取系统 + 用户 PATH 合并
 */

import { execSync } from 'node:child_process'
import path from 'node:path'

/** macOS/Linux 常见的额外路径（兜底） */
const UNIX_FALLBACK_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
]

/** Windows 常见的额外路径（兜底） */
function getWindowsFallbackPaths(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const appData = process.env.APPDATA || ''
  const localAppData = process.env.LOCALAPPDATA || ''
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

  return [
    // Node.js / npm / nvm-windows
    path.join(appData, 'npm'),
    path.join(appData, 'nvm'),
    path.join(programFiles, 'nodejs'),
    // volta
    path.join(localAppData, 'Volta', 'bin'),
    path.join(home, '.volta', 'bin'),
    // scoop
    path.join(home, 'scoop', 'shims'),
    // pnpm
    path.join(localAppData, 'pnpm'),
    // yarn
    path.join(localAppData, 'Yarn', 'bin'),
    // Git
    path.join(programFiles, 'Git', 'cmd'),
    path.join(programFilesX86, 'Git', 'cmd'),
    // Python
    path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts'),
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
  ].filter(Boolean)
}

/**
 * 修复 PATH，确保子进程能找到 npm、node、git 等命令。
 * 同步执行（仅在启动时调一次）。
 */
export function fixPath(): void {
  if (process.platform === 'win32') {
    fixPathWindows()
  } else {
    fixPathUnix()
  }
}

/* ------------------------------------------------------------------ */
/*  macOS / Linux                                                       */
/* ------------------------------------------------------------------ */

function fixPathUnix(): void {
  const currentPath = process.env.PATH || ''

  try {
    const shell = process.env.SHELL || '/bin/zsh'

    // 使用登录交互 shell 提取 PATH
    const result = execSync(
      `${shell} -ilc 'echo "___PATH_START___$PATH___PATH_END___"'`,
      {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    const match = result.match(/___PATH_START___(.+?)___PATH_END___/)
    if (match?.[1]) {
      process.env.PATH = mergePathStr(match[1], currentPath, ':')
      return
    }
  } catch {
    // 方法一失败，尝试非交互登录 shell
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      const result = execSync(`${shell} -lc 'echo $PATH'`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const shellPath = result.trim()
      if (shellPath && shellPath.includes('/')) {
        process.env.PATH = mergePathStr(shellPath, currentPath, ':')
        return
      }
    } catch {
      // 两次都失败
    }
  }

  // 兜底：确保常见路径存在
  ensurePaths(UNIX_FALLBACK_PATHS, ':')
}

/* ------------------------------------------------------------------ */
/*  Windows                                                             */
/* ------------------------------------------------------------------ */

function fixPathWindows(): void {
  const currentPath = process.env.PATH || process.env.Path || ''

  // 方法一：从注册表读取完整的系统 + 用户 PATH
  try {
    // 读取系统级 PATH
    const systemPath = readRegistryPath(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      'Path'
    )
    // 读取用户级 PATH
    const userPath = readRegistryPath('HKCU\\Environment', 'Path')

    if (systemPath || userPath) {
      const registryPath = [systemPath, userPath].filter(Boolean).join(';')
      const merged = mergePathStr(registryPath, currentPath, ';')
      process.env.PATH = merged
      // 同步设置 Path（某些 Windows 程序使用 Path 而非 PATH）
      process.env.Path = merged
      return
    }
  } catch {
    // 注册表方法失败
  }

  // 方法二：通过 PowerShell 获取
  try {
    const result = execSync(
      'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\', \'Machine\') + \';\' + [Environment]::GetEnvironmentVariable(\'Path\', \'User\')"',
      {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    const psPath = result.trim()
    if (psPath && psPath.length > 10) {
      const merged = mergePathStr(psPath, currentPath, ';')
      process.env.PATH = merged
      process.env.Path = merged
      return
    }
  } catch {
    // PowerShell 方法也失败
  }

  // 兜底：确保常见 Windows 路径存在
  ensurePaths(getWindowsFallbackPaths(), ';')
}

/** 从 Windows 注册表读取 PATH 值 */
function readRegistryPath(key: string, valueName: string): string {
  try {
    const result = execSync(`reg query "${key}" /v ${valueName}`, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // 输出格式：  Path  REG_EXPAND_SZ  C:\Windows\system32;...
    const match = result.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i)
    return match?.[1]?.trim() || ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/*  共用工具函数                                                        */
/* ------------------------------------------------------------------ */

/** 合并两个 PATH 字符串，保持顺序，去除重复 */
function mergePathStr(primary: string, secondary: string, sep: string): string {
  const seen = new Set<string>()
  const parts: string[] = []

  // Windows 下 PATH 比较不区分大小写
  const normalize = sep === ';'
    ? (p: string) => p.toLowerCase().replace(/[/\\]+$/, '')
    : (p: string) => p

  for (const raw of primary.split(sep)) {
    const p = raw.trim()
    const key = normalize(p)
    if (p && !seen.has(key)) {
      seen.add(key)
      parts.push(p)
    }
  }
  for (const raw of secondary.split(sep)) {
    const p = raw.trim()
    const key = normalize(p)
    if (p && !seen.has(key)) {
      seen.add(key)
      parts.push(p)
    }
  }

  return parts.join(sep)
}

/** 确保 fallback 路径存在于 PATH 中 */
function ensurePaths(fallbacks: string[], sep: string): void {
  const currentPath = process.env.PATH || process.env.Path || ''
  const pathSet = new Set(
    currentPath.split(sep).map((p) =>
      sep === ';' ? p.toLowerCase().replace(/[/\\]+$/, '') : p
    )
  )
  const missing = fallbacks.filter((p) => {
    const key = sep === ';' ? p.toLowerCase().replace(/[/\\]+$/, '') : p
    return !pathSet.has(key)
  })
  if (missing.length > 0) {
    const merged = [...missing, currentPath].join(sep)
    process.env.PATH = merged
    if (sep === ';') process.env.Path = merged
  }
}
