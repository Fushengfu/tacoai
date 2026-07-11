/**
 * 简单柱状图组件
 */

import { formatTokens } from './types'

export function SimpleBarChart({ 
  data, 
  height = 200,
  color = '#3b82f6',
  label 
}: { 
  data: Array<{ label: string; value: number }>
  height?: number
  color?: string
  label: string
}) {
  const maxValue = Math.max(...data.map(d => d.value), 1)
  
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)' }}>
        {label}
      </div>
      <div style={{ 
        display: 'flex', 
        alignItems: 'flex-end', 
        gap: '8px', 
        height: `${height}px`,
        padding: '0 8px',
      }}>
        {data.map((item, idx) => {
          const barHeight = (item.value / maxValue) * (height - 30)
          return (
            <div 
              key={idx}
              style={{ 
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <div style={{ 
                fontSize: '11px',
                color: 'var(--muted)',
                marginBottom: '2px',
              }}>
                {formatTokens(item.value)}
              </div>
              <div style={{ 
                width: '100%',
                maxWidth: '60px',
                height: `${Math.max(barHeight, 4)}px`,
                background: `linear-gradient(to top, ${color}, ${color}dd)`,
                borderRadius: '4px 4px 0 0',
                transition: 'all 0.3s ease',
              }}
              title={`${item.label}: ${formatTokens(item.value)}`}
              />
              <div style={{ 
                fontSize: '10px', 
                color: 'var(--muted)',
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '60px',
              }}>
                {item.label}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
