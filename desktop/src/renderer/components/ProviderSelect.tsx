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
}

export function ProviderSelect({ value, options, onChange, disabled, placeholder }: ProviderSelectProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<'bottom' | 'top'>('bottom')
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const customOptions = options.filter(item => item.source !== 'system')
  const systemOptions = options.filter(item => item.source === 'system')
  const hasBoth = customOptions.length > 0 && systemOptions.length > 0

  const selected = options.find(o => o.id === value)

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

  return (
    <div className="provider-select-wrapper" ref={ref}>
      <button
        type="button"
        className="provider-select-trigger"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        ref={triggerRef}
      >
        <span className="provider-select-label">{selected?.label || placeholder || 'Select'}</span>
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
                <svg className="brain-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2C9.24 2 7 4.24 7 7c0 1.1.36 2.12.97 2.95C6.84 10.62 6 11.96 6 13.5 6 15.98 8.02 18 10.5 18h3c2.48 0 4.5-2.02 4.5-4.5 0-1.54-.84-2.88-1.97-3.55A4.97 4.97 0 0 0 17 7c0-2.76-2.24-5-5-5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 2v20" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.25" />
                  <path d="M9.5 10c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  <path d="M9 14h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
