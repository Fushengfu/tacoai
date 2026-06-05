/**
 * 数据表格组件
 */

import { formatTokens, formatCost, calculateCost } from './types'
import type { TokenReportEntry } from './types'
import { CalendarIcon } from './Icons'

type DataTableProps = {
  entries: TokenReportEntry[]
  viewMode: 'daily' | 'model' | 'task' | 'daily-model'
}

/** 按日期表格 */
function DailyTable({ entries }: { entries: TokenReportEntry[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
      <thead>
        <tr style={{ background: 'rgba(255, 255, 255, 0.05)', borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: 600 }}>日期</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输入</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输出</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>缓存</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>总计</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>轮次</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, idx) => (
          <tr 
            key={idx} 
            style={{ 
              borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
              background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
            }}
          >
            <td style={{ padding: '12px' }}>
              <div style={{ fontWeight: 500 }}>{entry.date}</div>
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#10b981' }}>
              {formatTokens(entry.inputTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#f59e0b' }}>
              {formatTokens(entry.outputTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#8b5cf6' }}>
              {formatTokens(entry.hitTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
              {formatTokens(entry.totalTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', color: '#ec4899' }}>
              {entry.turns}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 按模型表格 */
function ModelTable({ entries }: { entries: TokenReportEntry[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
      <thead>
        <tr style={{ background: 'rgba(255, 255, 255, 0.05)', borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: 600 }}>模型</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输入</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输出</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>缓存</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>总计</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>轮次</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, idx) => (
          <tr 
            key={idx} 
            style={{ 
              borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
              background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
            }}
          >
            <td style={{ padding: '12px' }}>
              <div style={{ fontWeight: 500 }}>{entry.model}</div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{entry.provider}</div>
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#10b981' }}>
              {formatTokens(entry.inputTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#f59e0b' }}>
              {formatTokens(entry.outputTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#8b5cf6' }}>
              {formatTokens(entry.hitTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
              {formatTokens(entry.totalTokens)}
            </td>
            <td style={{ padding: '12px', textAlign: 'right', color: '#ec4899' }}>
              {entry.turns}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 按任务表格(表头固定+内容滚动) */
function TaskTable({ entries }: { entries: TokenReportEntry[] }) {
  return (
    <div style={{ 
      display: 'flex',
      flexDirection: 'column',
      maxHeight: '500px',
    }}>
      {/* 固定表头 */}
      <div style={{ flexShrink: 0, borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 600 }}>任务</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输入</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输出</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>缓存</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>总计</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>轮次</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>费用</th>
            </tr>
          </thead>
        </table>
      </div>
      {/* 可滚动表体 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            {entries.map((entry, idx) => {
              const cost = calculateCost(entry.model, entry.inputTokens, entry.outputTokens)
              return (
                <tr 
                  key={idx} 
                  style={{ 
                    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
                  }}
                >
                  <td style={{ padding: '12px' }}>
                    <div style={{ fontWeight: 500 }}>{entry.threadTitle}</div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{entry.model}</div>
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#10b981' }}>
                    {formatTokens(entry.inputTokens)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#f59e0b' }}>
                    {formatTokens(entry.outputTokens)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', color: '#8b5cf6' }}>
                    {formatTokens(entry.hitTokens)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                    {formatTokens(entry.totalTokens)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: '#ec4899' }}>
                    {entry.turns}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: '#ef4444', fontWeight: 500 }}>
                    {formatCost(cost)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 按日期+模型混合表格 */
function DailyModelTable({ entries }: { entries: TokenReportEntry[] }) {
  // 按日期分组
  const groupedByDate = entries.reduce((acc, entry) => {
    if (!acc[entry.date]) acc[entry.date] = []
    acc[entry.date].push(entry)
    return acc
  }, {} as Record<string, TokenReportEntry[]>)

  const dates = Object.keys(groupedByDate).sort()

  return (
    <div style={{ 
      display: 'flex',
      flexDirection: 'column',
      maxHeight: '600px',
    }}>
      {/* 固定表头 */}
      <div style={{ flexShrink: 0, borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 600 }}>日期</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 600 }}>模型</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输入</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>输出</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>缓存</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>总计</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>轮次</th>
              <th style={{ padding: '12px', textAlign: 'right', fontWeight: 600 }}>费用</th>
            </tr>
          </thead>
        </table>
      </div>
      {/* 可滚动表体 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            {dates.map((date) => {
              const dayEntries = groupedByDate[date]
              const dayTotal = dayEntries.reduce((acc, e) => ({
                inputTokens: acc.inputTokens + e.inputTokens,
                outputTokens: acc.outputTokens + e.outputTokens,
                hitTokens: acc.hitTokens + e.hitTokens,
                totalTokens: acc.totalTokens + e.totalTokens,
                turns: acc.turns + e.turns,
              }), { inputTokens: 0, outputTokens: 0, hitTokens: 0, totalTokens: 0, turns: 0 })

              return (
                <>
                  {/* 日期分组行 */}
                  <tr 
                    key={`header-${date}`}
                    style={{ 
                      background: 'rgba(59, 130, 246, 0.1)',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <td colSpan={2} style={{ padding: '10px 12px', fontWeight: 600, color: '#3b82f6', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <CalendarIcon /> {date}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#10b981', fontWeight: 500 }}>
                      {formatTokens(dayTotal.inputTokens)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#f59e0b', fontWeight: 500 }}>
                      {formatTokens(dayTotal.outputTokens)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#8b5cf6', fontWeight: 500 }}>
                      {formatTokens(dayTotal.hitTokens)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#3b82f6' }}>
                      {formatTokens(dayTotal.totalTokens)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#ec4899', fontWeight: 500 }}>
                      {dayTotal.turns}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#ef4444', fontWeight: 500 }}>
                      {formatCost(dayEntries.reduce((sum, e) => sum + calculateCost(e.model, e.inputTokens, e.outputTokens), 0))}
                    </td>
                  </tr>
                  {/* 该日期下的各模型数据 */}
                  {dayEntries.map((entry, idx) => {
                    const cost = calculateCost(entry.model, entry.inputTokens, entry.outputTokens)
                    return (
                      <tr 
                        key={`${date}-${idx}`}
                        style={{ 
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                          background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
                        }}
                      >
                        <td style={{ padding: '10px 12px', paddingLeft: '24px', color: 'var(--muted)' }}>↳</td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ fontWeight: 500 }}>{entry.model}</div>
                          <div style={{ fontSize: '11px', color: 'var(--muted)' }}>{entry.provider}</div>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#10b981' }}>
                          {formatTokens(entry.inputTokens)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#f59e0b' }}>
                          {formatTokens(entry.outputTokens)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#8b5cf6' }}>
                          {formatTokens(entry.hitTokens)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 500 }}>
                          {formatTokens(entry.totalTokens)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#ec4899' }}>
                          {entry.turns}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#ef4444', fontWeight: 500 }}>
                          {formatCost(cost)}
                        </td>
                      </tr>
                    )
                  })}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function DataTable({ entries, viewMode }: DataTableProps) {
  switch (viewMode) {
    case 'daily':
      return <DailyTable entries={entries} />
    case 'model':
      return <ModelTable entries={entries} />
    case 'task':
      return <TaskTable entries={entries} />
    case 'daily-model':
      return <DailyModelTable entries={entries} />
    default:
      return null
  }
}
