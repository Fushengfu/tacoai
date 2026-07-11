/**
 * OnboardingOverlay — 首次使用分步引导
 *
 * 在全屏半透明蒙层上，按步骤用聚光灯（box-shadow 镂空）高亮目标元素，
 * 并在旁边显示引导卡片。完成全部步骤后写 localStorage 标记，不再显示。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/* ------------------------------------------------------------------ */
/*  引导步骤定义                                                        */
/* ------------------------------------------------------------------ */

interface OnboardingStep {
  /** 步骤标题 */
  title: string
  /** 步骤描述 */
  description: string
  /** 用于查找目标元素的 CSS 选择器 */
  targetSelector: string
  /** 卡片相对于目标元素的位置 */
  placement: 'below' | 'above' | 'right'
  /** 卡片偏移（px），正值表示远离目标 */
  tooltipOffset: number
}

const STEPS: OnboardingStep[] = [
  {
    title: '配置模型',
    description: '点击 Settings 进入设置页面，添加至少一个模型的 API Key。这是使用 AI 功能的前提。',
    targetSelector: '.sidebar-settings-btn',
    placement: 'right',
    tooltipOffset: 20,
  },
  {
    title: '选择工作空间',
    description: '为 AI 指定一个安全的工作目录，AI 将在此目录内读写文件。点击下方"选择工作空间"即可。',
    targetSelector: '.workspace-item, .workspace-select-btn',
    placement: 'above',
    tooltipOffset: 16,
  },
  {
    title: '开始对话',
    description: '一切就绪！在输入框中输入你的需求，按 Enter 发送。AI 将帮你写代码、管理文件、执行任务。',
    targetSelector: '.composer-input',
    placement: 'above',
    tooltipOffset: 16,
  },
]

const ONBOARDING_STORAGE_KEY = 'taco.onboarding_completed'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

/** 查询目标元素，支持多选择器（逗号分隔），返回第一个匹配的 */
function queryTarget(selector: string): Element | null {
  const parts = selector.split(',').map((s) => s.trim())
  for (const part of parts) {
    const el = document.querySelector(part)
    if (el) return el
  }
  return null
}

/** 获取元素相对于 viewport 的 rect，若元素不可见则返回 null */
function getVisibleRect(el: Element | null): DOMRect | null {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  // 检查是否在可视区域内（至少部分可见）
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return null
  return rect
}

/* ------------------------------------------------------------------ */
/*  OnboardingOverlay 组件                                              */
/* ------------------------------------------------------------------ */

export interface OnboardingOverlayProps {
  /** 当前步骤索引（0-based） */
  step: number
  /** 进入下一步 */
  onNext: () => void
  /** 回到上一步 */
  onPrev: () => void
  /** 跳过引导 */
  onSkip: () => void
  /** 引导完成 */
  onComplete: () => void
  /** 是否已配置至少一个模型 */
  hasProviders: boolean
  /** 是否已选择工作空间 */
  hasWorkspace: boolean
}

export function OnboardingOverlay({
  step,
  onNext,
  onPrev,
  onSkip,
  onComplete,
  hasProviders,
  hasWorkspace,
}: OnboardingOverlayProps) {
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const [visible, setVisible] = useState(false)
  const rafRef = useRef<number>(0)

  /* ---- 持续追踪目标元素位置 ---- */
  const trackTarget = useCallback(() => {
    const stepDef = STEPS[step]
    if (!stepDef) return
    const el = queryTarget(stepDef.targetSelector)
    const rect = getVisibleRect(el)
    setTargetRect(rect)
    rafRef.current = requestAnimationFrame(trackTarget)
  }, [step])

  useEffect(() => {
    // 入场动画：延迟一帧后显示
    const showTimer = setTimeout(() => setVisible(true), 100)
    // 启动位置追踪
    rafRef.current = requestAnimationFrame(trackTarget)
    return () => {
      clearTimeout(showTimer)
      cancelAnimationFrame(rafRef.current)
    }
  }, [trackTarget])

  /* ---- 自动检测步骤完成 ---- */
  const prevHasProviders = useRef(hasProviders)
  const prevHasWorkspace = useRef(hasWorkspace)

  useEffect(() => {
    // Step 0：模型配置完成 → 自动进入下一步
    if (step === 0 && prevHasProviders.current === false && hasProviders === true) {
      onNext()
    }
    prevHasProviders.current = hasProviders
  }, [hasProviders, step, onNext])

  useEffect(() => {
    // Step 1：工作空间选择完成 → 自动进入下一步
    if (step === 1 && prevHasWorkspace.current === false && hasWorkspace === true) {
      onNext()
    }
    prevHasWorkspace.current = hasWorkspace
  }, [hasWorkspace, step, onNext])

  /* ---- 计算卡片位置 ---- */
  const stepDef = STEPS[step]
  const tooltipStyle = calcTooltipStyle(targetRect, stepDef?.placement ?? 'below', stepDef?.tooltipOffset ?? 16)

  /* ---- 计算聚光灯镂空位置 ---- */
  const spotlightStyle = targetRect
    ? {
        left: targetRect.left - 8,
        top: targetRect.top - 8,
        width: targetRect.width + 16,
        height: targetRect.height + 16,
      }
    : { left: 0, top: 0, width: 0, height: 0 }

  if (!stepDef) return null

  return (
    <div className={`onboarding-overlay ${visible ? 'onboarding-visible' : ''}`}>
      {/* 聚光灯镂空 */}
      <div
        className={`onboarding-spotlight ${targetRect ? 'onboarding-spotlight-ready' : ''}`}
        style={spotlightStyle}
      />

      {/* 引导卡片 */}
      {targetRect && (
        <div className={`onboarding-tooltip onboarding-tooltip-${stepDef.placement}`} style={tooltipStyle}>
          <div className="onboarding-tooltip-step">
            {step + 1} / {STEPS.length}
          </div>
          <h3 className="onboarding-tooltip-title">{stepDef.title}</h3>
          <p className="onboarding-tooltip-desc">{stepDef.description}</p>

          {/* 步骤指示器 */}
          <div className="onboarding-dots">
            {STEPS.map((_, i) => (
              <div key={i} className={`onboarding-dot ${i === step ? 'active' : i < step ? 'done' : ''}`} />
            ))}
          </div>

          {/* 操作按钮 */}
          <div className="onboarding-tooltip-actions">
            {step > 0 && (
              <button type="button" className="onboarding-btn onboarding-btn-prev" onClick={onPrev}>
                ← 上一步
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button type="button" className="onboarding-btn onboarding-btn-primary" onClick={onNext}>
                {step === 0 ? '已完成配置 →' : step === 1 ? '已选择目录 →' : '下一步'}
              </button>
            ) : (
              <button type="button" className="onboarding-btn onboarding-btn-primary" onClick={onComplete}>
                开始使用
              </button>
            )}
            <button type="button" className="onboarding-btn onboarding-btn-skip" onClick={onSkip}>
              跳过引导
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  工具卡片位置计算                                                    */
/* ------------------------------------------------------------------ */

function calcTooltipStyle(
  rect: DOMRect | null,
  placement: 'below' | 'above' | 'right',
  offset: number,
): React.CSSProperties {
  if (!rect) return { display: 'none' }

  const cardW = 320
  const cardH = 220 // 估算高度

  switch (placement) {
    case 'right':
      return {
        left: Math.min(rect.right + offset, window.innerWidth - cardW - 24),
        top: Math.max(24, Math.min(rect.top + rect.height / 2 - cardH / 2, window.innerHeight - cardH - 24)),
      }
    case 'above':
      return {
        left: Math.max(24, Math.min(rect.left + rect.width / 2 - cardW / 2, window.innerWidth - cardW - 24)),
        top: Math.max(24, rect.top - cardH - offset),
      }
    case 'below':
    default:
      return {
        left: Math.max(24, Math.min(rect.left + rect.width / 2 - cardW / 2, window.innerWidth - cardW - 24)),
        top: Math.min(rect.bottom + offset, window.innerHeight - cardH - 24),
      }
  }
}

/* ------------------------------------------------------------------ */
/*  公开工具函数                                                       */
/* ------------------------------------------------------------------ */

/** 检查是否已完成引导 */
export function isOnboardingCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 标记引导已完成 */
export function markOnboardingCompleted(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
  } catch {
    // ignore
  }
}
