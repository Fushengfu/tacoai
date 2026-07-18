/**
 * 项目规则加载 Hook
 * 职责：从工作空间 .taco/rules/rules.md 加载规则，兼容旧路径 .taco/rules.md 并自动迁移
 */
import { useEffect, useState } from 'react'

export function useProjectRules(currentWorkspace: string): string {
  const [projectRulesFromFile, setProjectRulesFromFile] = useState('')

  useEffect(() => {
    const ws = currentWorkspace
    if (!ws) {
      setProjectRulesFromFile('')
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        let result = await window.taco.file.read(`${ws}/.taco/rules/rules.md`)
        // 新路径不存在时，尝试从旧路径读取并迁移
        if (result?.size === 0) {
          const oldResult = await window.taco.file.read(`${ws}/.taco/rules.md`)
          if (oldResult && typeof oldResult.content === 'string' && oldResult.content.length > 0) {
            // 旧路径有内容 → 迁移到新路径
            await window.taco.file.write(`${ws}/.taco/rules/rules.md`, oldResult.content)
            result = oldResult
          }
        }
        if (!cancelled) {
          if (result && typeof result.content === 'string') {
            setProjectRulesFromFile(result.content)
            // 文件不存在时自动创建空的规则文件
            if (result.size === 0) {
              window.taco.file.write(`${ws}/.taco/rules/rules.md`, '').catch(() => {})
            }
          }
        }
      } catch {
        // 新路径不存在 → 尝试旧路径兼容
        try {
          const oldResult = await window.taco.file.read(`${ws}/.taco/rules.md`)
          if (!cancelled && oldResult && typeof oldResult.content === 'string') {
            setProjectRulesFromFile(oldResult.content)
            // 迁移到新路径
            if (oldResult.content.length > 0) {
              window.taco.file.write(`${ws}/.taco/rules/rules.md`, oldResult.content).catch(() => {})
            }
          } else if (!cancelled) {
            setProjectRulesFromFile('')
          }
        } catch {
          if (!cancelled) setProjectRulesFromFile('')
        }
      }
    })()
    return () => { cancelled = true }
  }, [currentWorkspace])

  return projectRulesFromFile
}
