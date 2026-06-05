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
 <svg className="brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
 {/* 左半球轮廓 */}
 <path d="M12 2C9.5 2 7.5 3 6.5 4.5C5 4.5 3.5 6 3.5 8C3.5 9.5 4 10.5 5 11.5C4 12.5 3.5 14 4 15.5C4.5 17 6 18 7.5 18C8 19.5 9.5 21 12 21"/>
 {/* 右半球轮廓 */}
 <path d="M12 2C14.5 2 16.5 3 17.5 4.5C19 4.5 20.5 6 20.5 8C20.5 9.5 20 10.5 19 11.5C20 12.5 20.5 14 20 15.5C19.5 17 18 18 16.5 18C16 19.5 14.5 21 12 21"/>
 {/* 中央纵裂 */}
 <line x1="12" y1="2" x2="12" y2="21"/>
 {/* 左脑沟回 */}
 <path d="M7 8C8.5 8 10 9 12 9"/>
 <path d="M6 13C8 12.5 10 13 12 14"/>
 {/* 右脑沟回 */}
 <path d="M17 8C15.5 8 14 9 12 9"/>
 <path d="M18 13C16 12.5 14 13 12 14"/>
 </svg>
 </span>
 </div>
 ))}
 </div>
 )}
 </div>
 )
}
