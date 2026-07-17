import { useState, useEffect, useCallback } from 'react'
import type { SkillInfo, SkillPreview, SkillUpdateInfo, SkillSearchResult } from '../../../shared/ipc'
import { SkillsSettingsPanel } from './SkillsSettingsPanel'

/* ------------------------------------------------------------------ */
/*  分类定义                                                             */
/* ------------------------------------------------------------------ */

type SkillCategory = {
  id: string
  label: string
  keywords: string[]
}

/** 基于腾讯 SkillHub 12 大类的分类定义 */
const SKILL_CATEGORIES: SkillCategory[] = [
  { id: 'all',       label: '全部',     keywords: [] },
  { id: 'office',    label: '办公效率',  keywords: ['office', 'productivity', 'calendar', 'email', 'task', 'todo', 'note', 'meeting', 'workflow', '文档', '效率', '办公', '日程', '邮件', '任务', '备忘'] },
  { id: 'content',   label: '内容创作',  keywords: ['content', 'writing', 'blog', 'article', 'copy', 'marketing', 'seo', 'social', 'media', 'video', 'image', 'creative', '创作', '文案', '写作', '博客', '营销', '社交媒体', '短视频'] },
  { id: 'dev',       label: '开发编程',  keywords: ['dev', 'code', 'programming', 'github', 'git', 'api', 'cli', 'sdk', 'framework', 'testing', 'debug', 'docker', 'ci', 'cd', '编程', '开发', '代码', '测试', '调试', '部署', '容器'] },
  { id: 'data',      label: '数据分析',  keywords: ['data', 'analytics', 'sql', 'database', 'json', 'csv', 'excel', 'chart', 'report', 'statistics', 'etl', 'visualization', '数据', '分析', '报表', '图表', '统计'] },
  { id: 'design',    label: '设计多媒体', keywords: ['design', 'ui', 'ux', 'figma', 'sketch', 'photo', 'video', 'audio', 'multimedia', 'animation', '设计', '视频', '音频', '多媒体', '动画', '图像', '图片'] },
  { id: 'ai-agent',  label: 'AI Agent',  keywords: ['ai', 'llm', 'model', 'ml', 'agent', 'chatbot', 'prompt', 'rag', 'embedding', 'nlp', 'vision', '智能', '模型', '对话', '搜索'] },
  { id: 'knowledge', label: '知识管理',  keywords: ['knowledge', 'wiki', 'doc', 'document', 'note', 'memo', 'readme', 'learning', 'tutorial', 'guide', '知识', '文档', '笔记', '教程', '指南'] },
  { id: 'business',  label: '商业运营',  keywords: ['business', 'finance', 'sales', 'crm', 'erp', 'marketing', 'strategy', 'management', '商业', '金融', '销售', '运营', '管理', '策略'] },
  { id: 'edu',       label: '教育学习',  keywords: ['education', 'learning', 'course', 'quiz', 'exam', 'study', 'tutorial', 'textbook', 'training', '教育', '学习', '课程', '考试', '培训'] },
  { id: 'pro',       label: '行业专业',  keywords: ['legal', 'medical', 'healthcare', 'accounting', 'hr', 'real-estate', 'logistics', '法律', '医疗', '会计', '人力资源', '房地产', '物流'] },
  { id: 'itops',     label: 'IT 运维与安全', keywords: ['ops', 'security', 'monitor', 'devops', 'cloud', 'server', 'network', 'firewall', 'backup', 'auth', 'ssl', '运维', '安全', '监控', '网络', '防火墙', '备份'] },
  { id: 'life',      label: '生活服务',  keywords: ['life', 'travel', 'food', 'health', 'fitness', 'weather', 'shopping', 'calendar', 'reminder', '生活', '旅行', '美食', '健康', '健身', '天气', '购物'] },
]

/** 搜索源选项 */
const SEARCH_SOURCES = [
  { id: 'all',      label: '全部 (ClawHub + SkillHub)' },
  { id: 'clawhub',  label: 'ClawHub (69K+)' },
  { id: 'skillhub', label: '腾讯 SkillHub (78K+)' },
]



type SkillsSettingsOverlayProps = {
  onClose: () => void
  workspace?: string | null
}

export function SkillsSettingsOverlay({ onClose, workspace }: Readonly<SkillsSettingsOverlayProps>) {
  // 已安装 skills
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  // 搜索
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SkillSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchSource, setSearchSource] = useState<'clawhub' | 'skillhub' | 'all'>('all')

  // 分类
  const [selectedCategory, setSelectedCategory] = useState('all')

  // 选中的搜索结果
  const [selectedResult, setSelectedResult] = useState<SkillSearchResult | null>(null)

  // 预览
  const [previewResult, setPreviewResult] = useState<SkillPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')

  // SKILL.md 详细内容
  const [detailContent, setDetailContent] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)

  // 安装
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)

  // 更新检测
  const [checkingUpdates, setCheckingUpdates] = useState<Record<string, boolean>>({})
  const [updateInfo, setUpdateInfo] = useState<Record<string, SkillUpdateInfo | null>>({})

  // 选中已安装技能查看详情
  const [selectedInstalledSkillId, setSelectedInstalledSkillId] = useState<string | null>(null)
  const [installedSkillDetailContent, setInstalledSkillDetailContent] = useState('')
  const [installedSkillDetailLoading, setInstalledSkillDetailLoading] = useState(false)

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const list = await window.taco.skills.list(workspace ?? undefined)
      setSkills(list)
    } catch (err) {
      console.error('加载 Skills 失败:', err)
    } finally {
      setSkillsLoading(false)
    }
  }, [workspace])

  useEffect(() => { loadSkills() }, [loadSkills])

  const handleToggleSkill = async (id: string, enabled: boolean) => {
    try {
      await window.taco.skills.toggle(id, enabled)
      setSkills((prev) => prev.map((s) => s.id === id ? { ...s, enabled } : s))
    } catch (err) {
      console.error('切换 Skill 状态失败:', err)
    }
  }

  const handleUninstallSkill = async (id: string) => {
    try {
      await window.taco.skills.uninstall(id)
      setSkills((prev) => prev.filter((s) => s.id !== id))
      if (selectedInstalledSkillId === id) {
        setSelectedInstalledSkillId(null)
        setInstalledSkillDetailContent('')
      }
    } catch (err) {
      console.error('卸载 Skill 失败:', err)
    }
  }

  const handleSelectInstalledSkill = async (id: string) => {
    if (selectedInstalledSkillId === id) {
      // 取消选中
      setSelectedInstalledSkillId(null)
      setInstalledSkillDetailContent('')
      return
    }
    setSelectedInstalledSkillId(id)
    setInstalledSkillDetailContent('')
    setInstalledSkillDetailLoading(true)
    try {
      const content = await window.taco.skills.getLocalDetail(id)
      setInstalledSkillDetailContent(content)
    } catch (err) {
      console.error('获取本地 SKILL.md 失败:', err)
      setInstalledSkillDetailContent('')
    } finally {
      setInstalledSkillDetailLoading(false)
    }
  }

  const handleSearch = async (categoryId?: string) => {
    const catId = categoryId ?? selectedCategory
    if (catId !== undefined) {
      setSelectedCategory(catId)
    }

    const q = searchQuery.trim()
    if (!q && catId === 'all') return

    setSearching(true)
    setSearchError('')
    setSearchResults([])
    setSelectedResult(null)
    setPreviewResult(null)
    setPreviewError('')
    setDetailContent('')
    try {
      const results = await window.taco.skills.search(q, searchSource, catId !== 'all' ? catId : undefined)
      setSearchResults(results)
      if (results.length === 0) {
        setSearchError('未找到匹配的技能')
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const handleSelectCategory = (categoryId: string) => {
    setSelectedCategory(categoryId)
    setSelectedResult(null)
    setPreviewResult(null)
    setDetailContent('')
    
    if (categoryId === 'all') {
      // "全部" → 重新搜索（不带分类过滤）
      const q = searchQuery.trim()
      if (!q) {
        setSearchResults([])
        return
      }
      setSearching(true)
      setSearchError('')
      window.taco.skills.search(q, searchSource)
        .then((results) => {
          setSearchResults(results)
          if (results.length === 0) setSearchError('未找到匹配的技能')
        })
        .catch((err) => setSearchError(err instanceof Error ? err.message : '搜索失败'))
        .finally(() => setSearching(false))
      return
    }

    // 选具体分类 → 用分类关键词 + category 参数搜索
    const cat = SKILL_CATEGORIES.find((c) => c.id === categoryId)
    const kw = cat?.keywords?.slice(0, 3).join(' ') ?? ''
    const q = searchQuery.trim() || kw
    
    setSearching(true)
    setSearchError('')
    setSearchResults([])
    window.taco.skills.search(q, searchSource, categoryId)
      .then((results) => {
        setSearchResults(results)
        if (results.length === 0) setSearchError('未找到匹配的技能')
      })
      .catch((err) => setSearchError(err instanceof Error ? err.message : '搜索失败'))
      .finally(() => setSearching(false))
  }

  /** 清除搜索 */
  const handleClearSearch = () => {
    setSearchQuery('')
    setSearchResults([])
    setSearchError('')
    setSelectedCategory('all')
    setSelectedResult(null)
    setPreviewResult(null)
    setDetailContent('')
  }

  const handleSelectResult = async (result: SkillSearchResult) => {
    setSelectedResult(result)
    setPreviewResult(null)
    setPreviewError('')
    setDetailContent('')
    setDetailLoading(true)
    // 构造预览数据
    setPreviewing(true)
    const preview: SkillPreview = {
      id: result.slug,
      name: result.displayName,
      description: result.summary,
      version: result.version || '—',
      author: result.authorName || '未知',
      sourceUrl: result.source === 'skillhub'
        ? `https://skillhub.cloud.tencent.com/skills/${result.slug}`
        : `https://clawhub.ai/skills/${result.slug}`,
      tools: [],
      tags: [],
    }
    setPreviewResult(preview)
    setPreviewing(false)
    // 同时拉取 SKILL.md 原文
    try {
      const content = await window.taco.skills.getDetail(result.slug, result.source)
      setDetailContent(content)
    } catch (err) {
      console.error('获取 SKILL.md 失败:', err)
      setDetailContent('')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleCloseSidePanel = useCallback(() => {
    setSelectedResult(null)
    setPreviewResult(null)
    setDetailContent('')
    setSelectedInstalledSkillId(null)
    setInstalledSkillDetailContent('')
  }, [])

  const handleInstallFromSearch = async () => {
    if (!selectedResult) return
    setInstalling(true)
    setInstallError('')
    setInstallingSlug(selectedResult.slug)
    try {
      const newSkill = await window.taco.skills.install(selectedResult.slug, selectedResult.authorName !== '未知' ? selectedResult.authorName : undefined)
      setSearchResults((prev) => prev.filter((r) => r.slug !== selectedResult.slug))
      setSelectedResult(null)
      setPreviewResult(null)
      setDetailContent('')
      setSkills((prev) => {
        const exists = prev.findIndex((s) => s.id === newSkill.id)
        if (exists >= 0) {
          const next = [...prev]
          next[exists] = newSkill
          return next
        }
        return [...prev, newSkill]
      })
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
      setInstallingSlug(null)
    }
  }

  const isInstalled = useCallback((slug: string) => {
    return skills.some((s) => {
      if (s.id === slug) return true
      // 向后兼容：旧安装的技能 id 可能来自 SKILL.md 标题的 slug 化，
      // 与搜索结果的 slug 不完全一致（如 "pdf-generator-pro" vs "pdf-generator"）
      // 检查 s.name 的 slug 化结果是否匹配
      const nameSlug = s.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (nameSlug === slug) return true
      return false
    })
  }, [skills])

  const handleSkillCheckUpdate = async (skillId: string) => {
    setCheckingUpdates((prev) => ({ ...prev, [skillId]: true }))
    try {
      const result = await window.taco.skills.checkUpdate(skillId)
      setUpdateInfo((prev) => ({ ...prev, [skillId]: result }))
    } catch {
      setUpdateInfo((prev) => ({ ...prev, [skillId]: null }))
    } finally {
      setCheckingUpdates((prev) => ({ ...prev, [skillId]: false }))
    }
  }

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button className="settings-back-btn" type="button" onClick={onClose} title="返回">
          <svg className="settings-back-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.75 6.5L9.25 12L14.75 17.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 12H20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span>返回</span>
        </button>
        <div className="settings-title">Skills</div>
      </header>
      <div className="settings-body">
        <SkillsSettingsPanel
          // 搜索
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSearch={handleSearch}
          searching={searching}
          searchResults={searchResults}
          searchError={searchError}
          // 搜索源
          searchSource={searchSource}
          onSearchSourceChange={setSearchSource}
          searchSources={SEARCH_SOURCES}
          // 分类
          categories={SKILL_CATEGORIES}
          selectedCategory={selectedCategory}
          onSelectCategory={handleSelectCategory}
          // 选中 & 预览
          selectedResult={selectedResult}
          onSelectResult={handleSelectResult}
          previewResult={previewResult}
          previewing={previewing}
          previewError={previewError}
          // SKILL.md 详细内容
          detailContent={detailContent}
          detailLoading={detailLoading}
          // 安装
          installing={installing}
          installError={installError}
          installingSlug={installingSlug}
          onInstallFromSearch={handleInstallFromSearch}
          isInstalled={isInstalled}
          // 已安装
          skillsLoading={skillsLoading}
          skills={skills}
          onToggleSkill={handleToggleSkill}
          onUninstallSkill={handleUninstallSkill}
          checkingUpdates={checkingUpdates}
          updateInfo={updateInfo}
          onCheckUpdate={handleSkillCheckUpdate}
          // 已安装技能详情
          selectedInstalledSkillId={selectedInstalledSkillId}
          installedSkillDetailContent={installedSkillDetailContent}
          installedSkillDetailLoading={installedSkillDetailLoading}
          onSelectInstalledSkill={handleSelectInstalledSkill}
          onCloseSidePanel={handleCloseSidePanel}
          onClearSearch={handleClearSearch}
        />
      </div>
    </main>
  )
}
