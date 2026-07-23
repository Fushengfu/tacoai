import { useState, useRef, useEffect, useCallback } from 'react'

export interface ProviderOption {
  id: string
  label: string
  source?: 'custom' | 'system'
}

interface ProviderSelectProps {
  value: string
  options: readonly ProviderOption[]
  onChange: (id: string) => void
  disabled?: boolean
  placeholder?: string
  onAddCustomModel?: () => void
}

/** 大脑 SVG 图标（系统内置模型标识） */
function BrainIcon() {
  return (
    <svg className="brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </svg>
  )
}

export function ProviderSelect({ value, options, onChange, disabled, placeholder, onAddCustomModel }: ProviderSelectProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<'bottom' | 'top'>('bottom')
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const customOptions = options.filter(item => item.source !== 'system')
  const systemOptions = options.filter(item => item.source === 'system')
  const hasBoth = customOptions.length > 0 && systemOptions.length > 0

  const selected = options.find(o => o.id === value)
  const isSystem = selected?.source === 'system'

  // 计算展开方向
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    // 下拉框预估高度约 320px，如果下方空间不足且上方空间更充裕，则向上展开
    setPosition(spaceBelow < 300 && spaceAbove > spaceBelow ? 'top' : 'bottom')
  }, [open])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSelect = useCallback((id: string) => {
    onChange(id)
    setOpen(false)
  }, [onChange])

  // 当 disabled 且提供 onAddCustomModel 时，下拉框内容为空但允许点击跳转配置页
  const isEmpty = options.length === 0

  return (
    <div className="provider-select-wrapper" ref={ref}>
      <button
        type="button"
        className={`provider-select-trigger${disabled ? ' provider-select-trigger--empty' : ''}`}
        disabled={disabled && !onAddCustomModel}
        onClick={() => {
          if (disabled && onAddCustomModel) {
            onAddCustomModel()
          } else {
            setOpen(!open)
          }
        }}
        aria-expanded={open}
        ref={triggerRef}
      >
        <span className="provider-select-label">{selected?.label || (isEmpty && onAddCustomModel ? '+ 添加自定义模型' : placeholder || 'Select')}</span>
        {isSystem && (
          <span className="trigger-brain-icon">
            <BrainIcon />
          </span>
        )}
        <svg className="provider-select-arrow" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={`provider-select-dropdown provider-select-dropdown--${position}`}>
          {customOptions.map(item => (
            <div
              key={item.id}
              className={`provider-select-option ${item.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(item.id)}
            >
              <span>{item.label}</span>
            </div>
          ))}

          {hasBoth && <div className="provider-select-divider" />}

          {systemOptions.map(item => (
            <div
              key={item.id}
              className={`provider-select-option system-option ${item.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(item.id)}
            >
              <span>{item.label}</span>
              <span className="system-badge">
                <BrainIcon />
              </span>
            </div>
          ))}

          {onAddCustomModel && (
            <>
              <div className="provider-select-divider" />
              <button
                type="button"
                className="provider-select-add-btn"
                onClick={() => { setOpen(false); onAddCustomModel() }}
              >
                <svg className="provider-select-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="16" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
                <span>添加自定义模型</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
