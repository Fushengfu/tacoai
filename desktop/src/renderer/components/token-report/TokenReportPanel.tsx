/**
 * Token报表主面板组件
 */

import { useState, useMemo } from 'react'
import type { ProjectTokenStats } from '../../hooks/useChat'
import { SimpleBarChart } from './BarChart'
import { StatsCards } from './StatsCards'
import { DataTable } from './DataTable'
import { 
  formatDate, 
  type TokenReportEntry,
  type ViewMode 
} from './types'
import { CalendarIcon, ModelIcon, ChartIcon, TaskIcon, StatsIcon } from './Icons'

export default function TokenReportPanel({ 
  projectTokenStats,
  threadTitles,
  threadModels,
}: {
  projectTokenStats: Record<string, ProjectTokenStats>
  threadTitles: Record<string, string>
  threadModels: Record<string, { model: string; provider: string }>
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('daily')
  const [selectedDate, setSelectedDate] = useState<string>('all')

  // 将统计数据转换为报表条目
  const reportEntries = useMemo<TokenReportEntry[]>(() => {
    const entries: TokenReportEntry[] = []
    
    for (const [threadId, stats] of Object.entries(projectTokenStats)) {
      const threadInfo = threadModels[threadId] || { model: 'unknown', provider: 'unknown' }
      const title = threadTitles[threadId] || `任务 ${threadId.slice(0, 8)}`
      const date = formatDate(stats.updatedAt)
      
      entries.push({
        date,
        threadId,
        threadTitle: title,
        model: threadInfo.model,
        provider: threadInfo.provider,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        hitTokens: stats.hitTokens,
        missTokens: stats.missTokens,
        totalTokens: stats.totalTokens,
        turns: stats.turns,
        timestamp: stats.updatedAt,
      })
    }
    
    return entries.sort((a, b) => b.timestamp - a.timestamp)
  }, [projectTokenStats, threadTitles, threadModels])

  // 按日期聚合
  const dailyStats = useMemo(() => {
    const map = new Map<string, TokenReportEntry>()
    
    for (const entry of reportEntries) {
      const existing = map.get(entry.date)
      if (!existing) {
        map.set(entry.date, { ...entry })
      } else {
        existing.inputTokens += entry.inputTokens
        existing.outputTokens += entry.outputTokens
        existing.hitTokens += entry.hitTokens
        existing.missTokens += entry.missTokens
        existing.totalTokens += entry.totalTokens
        existing.turns += entry.turns
      }
    }
    
    return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp)
  }, [reportEntries])

  // 按模型聚合
  const modelStats = useMemo(() => {
    const map = new Map<string, TokenReportEntry>()
    
    for (const entry of reportEntries) {
      const key = `${entry.provider}/${entry.model}`
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { ...entry })
      } else {
        existing.inputTokens += entry.inputTokens
        existing.outputTokens += entry.outputTokens
        existing.hitTokens += entry.hitTokens
        existing.missTokens += entry.missTokens
        existing.totalTokens += entry.totalTokens
        existing.turns += entry.turns
      }
    }
    
    return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  }, [reportEntries])

  // 按日期+模型聚合(新视图)
  const dailyModelStats = useMemo(() => {
    const map = new Map<string, TokenReportEntry>()
    
    for (const entry of reportEntries) {
      const key = `${entry.date}::${entry.provider}/${entry.model}`
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { ...entry })
      } else {
        existing.inputTokens += entry.inputTokens
        existing.outputTokens += entry.outputTokens
        existing.hitTokens += entry.hitTokens
        existing.missTokens += entry.missTokens
        existing.totalTokens += entry.totalTokens
        existing.turns += entry.turns
      }
    }
    
    return Array.from(map.values()).sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date)
      return b.totalTokens - a.totalTokens
    })
  }, [reportEntries])

  // 过滤数据
  const filteredEntries = useMemo(() => {
    if (selectedDate === 'all') return reportEntries
    return reportEntries.filter(e => e.date === selectedDate)
  }, [reportEntries, selectedDate])

  // 可用日期列表
  const availableDates = useMemo(() => {
    const dates = new Set(reportEntries.map(e => e.date))
    return Array.from(dates).sort().reverse()
  }, [reportEntries])

  // 图表数据
  const chartData = useMemo(() => {
    if (viewMode === 'daily') {
      return dailyStats.slice(0, 7).reverse().map(entry => ({
        label: entry.date.slice(5),
        value: entry.totalTokens,
      }))
    } else if (viewMode === 'model') {
      return modelStats.slice(0, 6).map(entry => ({
        label: entry.model,
        value: entry.totalTokens,
      }))
    } else if (viewMode === 'daily-model') {
      return dailyModelStats.slice(0, 8).map(entry => ({
        label: `${entry.date.slice(5)} ${entry.model}`,
        value: entry.totalTokens,
      }))
    }
    return []
  }, [viewMode, dailyStats, modelStats, dailyModelStats])

  // 当前视图的数据
  const displayEntries = useMemo(() => {
    switch (viewMode) {
      case 'daily':
        return dailyStats
      case 'model':
        return modelStats
      case 'task':
        return filteredEntries
      case 'daily-model':
        return dailyModelStats
      default:
        return []
    }
  }, [viewMode, dailyStats, modelStats, filteredEntries, dailyModelStats])

  if (reportEntries.length === 0) {
    return (
      <div style={{ 
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        color: 'var(--muted)',
        fontSize: '14px',
      }}>
        <div style={{ marginBottom: '16px', color: '#3b82f6' }}>
          <StatsIcon />
        </div>
        <div>暂无Token使用数据</div>
        <div style={{ fontSize: '12px', marginTop: '8px' }}>开始对话后将自动统计</div>
      </div>
    )
  }

  return (
    <div style={{ 
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      background: 'linear-gradient(120deg, var(--main-bg-start) 0%, var(--main-bg-end) 100%)',
    }}>
      {/* 控制面板 - 固定顶部 */}
      <div style={{ 
        padding: '16px 20px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        flexShrink: 0,
      }}>
        {/* 视图切换 */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
          {([
            { mode: 'daily' as const, Icon: CalendarIcon, label: '按日期' },
            { mode: 'model' as const, Icon: ModelIcon, label: '按模型' },
            { mode: 'daily-model' as const, Icon: ChartIcon, label: '日期+模型' },
            { mode: 'task' as const, Icon: TaskIcon, label: '按任务' },
          ] as const).map(({ mode, Icon, label }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                border: 'none',
                background: viewMode === mode ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                color: viewMode === mode ? '#3b82f6' : 'var(--muted)',
                cursor: 'pointer',
                fontWeight: viewMode === mode ? 600 : 400,
                fontSize: '13px',
                transition: 'all 0.15s ease',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Icon /> {label}
            </button>
          ))}
        </div>

        {/* 日期筛选 */}
        {viewMode === 'task' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '13px', color: 'var(--muted)' }}>筛选日期:</label>
            <select
              aria-label="筛选日期"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                background: 'rgba(255, 255, 255, 0.05)',
                color: 'var(--text)',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              <option value="all">全部</option>
              {availableDates.map(date => (
                <option key={date} value={date}>{date}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* 可滚动内容区域 */}
      <div style={{ 
        flex: 1,
        overflow: 'auto',
        padding: '20px',
      }}>
        {/* 统计卡片 */}
        <StatsCards entries={displayEntries} viewMode={viewMode} />

        {/* 图表区域 */}
        {chartData.length > 0 && (
          <div style={{ 
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '20px',
          }}>
            <SimpleBarChart 
              data={chartData} 
              height={180}
              color="#3b82f6"
              label={
                viewMode === 'daily' ? '近7日Token消耗趋势' : 
                viewMode === 'model' ? '模型Token消耗分布' :
                '日期+模型Token消耗分布'
              }
            />
          </div>
        )}

        {/* 详细数据表格 */}
        <div style={{ 
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: '12px',
          overflow: 'hidden',
          padding: viewMode === 'task' || viewMode === 'daily-model' ? '0' : '0',
        }}>
          <DataTable entries={displayEntries} viewMode={viewMode} />
        </div>
      </div>
    </div>
  )
}
