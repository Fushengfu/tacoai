/**
 * 路径处理工具函数
 * 
 * 从 App.tsx 提取的路径规范化、工作区相对路径计算等工具函数
 */

/** 规范化路径分隔符，统一为 forward slash */
export function normalizeSlashPath(input: string): string {
  return String(input ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+/g, '/')
}

/** 将文件路径转换为相对于工作区的相对路径 */
export function normalizeWorkspaceRelativePath(filePath: string, workspace?: string | null): string {
  const normalizedFilePath = normalizeSlashPath(filePath).replace(/^\.\//, '')
  if (!normalizedFilePath) return normalizedFilePath
  if (!workspace) return normalizedFilePath

  const normalizedWorkspace = normalizeSlashPath(workspace).replace(/\/+$/, '')
  if (!normalizedWorkspace) return normalizedFilePath

  const lowerFilePath = normalizedFilePath.toLowerCase()
  const lowerWorkspace = normalizedWorkspace.toLowerCase()
  if (lowerFilePath === lowerWorkspace) return ''
  if (lowerFilePath.startsWith(`${lowerWorkspace}/`)) {
    return normalizedFilePath.slice(normalizedWorkspace.length + 1)
  }
  return normalizedFilePath
}

/** 判断是否为私有 IPv4 地址 */
export function isPrivateIpv4(hostname: string): boolean {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** 将相对路径解析为绝对路径 */
export function resolveFilePath(filePath: string, currentWorkspace: string): string {
  // 如果已经是绝对路径则直接返回
  if (filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')) {
    return filePath
  }
  // 否则拼接工作空间路径
  if (currentWorkspace) {
    const base = currentWorkspace.replace(/[\\/]+$/, '')
    const rel = normalizeSlashPath(filePath).replace(/^\.\//, '')
    const isWindowsWorkspace = /[a-zA-Z]:[\\/]/.test(base) || base.includes('\\')
    if (isWindowsWorkspace) return `${base}\\${rel.replace(/\//g, '\\')}`
    return `${base}/${rel}`
  }
  return filePath
}
