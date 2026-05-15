/**
 * 统计卡片组件
 */

import { formatTokens, formatCost } from './types'
import type { TokenReportEntry } from './types'

export function StatsCards({ 
  entries, 
  viewMode 
}: { 
  entries: TokenReportEntry[]
  viewMode: string
}) {
  const totalStats = entries.reduce((acc, entry) => ({
    inputTokens: acc.inputTokens + entry.inputTokens,
    outputTokens: acc.outputTokens + entry.outputTokens,
    hitTokens: acc.hitTokens + entry.hitTokens,
    missTokens: acc.missTokens + entry.missTokens,
    totalTokens: acc.totalTokens + entry.totalTokens,
    turns: acc.turns + entry.turns,
  }), { inputTokens: 0, outputTokens: 0, hitTokens: 0, missTokens: 0, totalTokens: 0, turns: 0 })

  const totalCost = entries.reduce((sum, entry) => 
    sum + ((entry.inputTokens / 1_000_000) * 1.0 + (entry.outputTokens / 1_000_000) * 3.0), 0)

  return (
    <div style={{ 
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: '12px',
      marginBottom: '20px',
    }}>
      {[
        { label: '总Token', value: formatTokens(totalStats.totalTokens), color: '#3b82f6' },
        { label: '输入Token', value: formatTokens(totalStats.inputTokens), color: '#10b981' },
        { label: '输出Token', value: formatTokens(totalStats.outputTokens), color: '#f59e0b' },
        { label: '缓存命中', value: formatTokens(totalStats.hitTokens), color: '#8b5cf6' },
        { label: '对话轮次', value: totalStats.turns.toString(), color: '#ec4899' },
        ...(viewMode === 'task' || viewMode === 'daily-model' ? 
          [{ label: '预估费用', value: formatCost(totalCost), color: '#ef4444' }] : []),
      ].map(({ label, value, color }) => (
        <div key={label} style={{ 
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: '12px',
          padding: '14px',
        }}>
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
            {label}
          </div>
          <div style={{ fontSize: '22px', fontWeight: 600, color }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  )
}
