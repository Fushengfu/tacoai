/**
 * 意图类型推断
 *
 * 统一 inferIntentTypeFromQuery 函数，
 * 消除 agent/index.ts、ipc/index.ts 中的重复定义。
 */

/** 根据用户查询文本推断意图类型 */
export function inferIntentTypeFromQuery(query: string): string {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return 'other'
  if (/(报错|错误|异常|排查|调试|debug|error|bug|trace|崩溃)/.test(text)) return 'debug'
  if (/(实现|新增|开发|编写|添加|implement|create|build|功能)/.test(text)) return 'implement'
  if (/(重构|优化|整理|抽离|refactor|optimize|cleanup)/.test(text)) return 'refactor'
  if (/(删除|重命名|移动|部署|发布|配置|运行|执行|remove|delete|rm |mv |deploy)/.test(text)) return 'ops'
  if (/(是什么|为什么|怎么|如何|请解释|是否|吗|\?|？|what|why|how|can you)/.test(text)) return 'qa'
  return 'other'
}
