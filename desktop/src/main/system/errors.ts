/**
 * 统一错误处理和错误映射
 * 
 * 将底层错误转换为用户友好的错误信息
 */

/** 应用错误类型 */
export enum AppErrorCode {
  // 网络错误
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',
  
  // 认证错误
  AUTH_FAILED = 'AUTH_FAILED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  
  // 模型错误
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  INVALID_MODEL_CONFIG = 'INVALID_MODEL_CONFIG',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  
  // 文件错误
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  
  // Git 错误
  GIT_NOT_INITIALIZED = 'GIT_NOT_INITIALIZED',
  GIT_CONFLICT = 'GIT_CONFLICT',
  GIT_COMMIT_FAILED = 'GIT_COMMIT_FAILED',
  
  // 工具执行错误
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  COMMAND_NOT_FOUND = 'COMMAND_NOT_FOUND',
  
  // Agent 错误
  AGENT_LOOP_TIMEOUT = 'AGENT_LOOP_TIMEOUT',
  AGENT_MAX_RETRIES = 'AGENT_MAX_RETRIES',
  
  // 通用错误
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** 应用错误 */
export class AppError extends Error {
  public readonly code: AppErrorCode
  public readonly originalError?: Error
  public readonly context?: Record<string, unknown>

  constructor(
    code: AppErrorCode,
    message: string,
    options?: {
      originalError?: Error
      context?: Record<string, unknown>
    }
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.originalError = options?.originalError
    this.context = options?.context

    // 保持错误堆栈
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError)
    }
  }
}

/** 错误消息映射 */
const ERROR_MESSAGE_MAP: Partial<Record<AppErrorCode, string>> = {
  [AppErrorCode.NETWORK_ERROR]: '网络连接失败,请检查网络设置',
  [AppErrorCode.TIMEOUT_ERROR]: '请求超时,请稍后重试',
  [AppErrorCode.CONNECTION_REFUSED]: '无法连接到服务器',
  [AppErrorCode.AUTH_FAILED]: '认证失败,请重新登录',
  [AppErrorCode.INVALID_API_KEY]: 'API Key 无效,请检查配置',
  [AppErrorCode.TOKEN_EXPIRED]: '登录已过期,请重新登录',
  [AppErrorCode.MODEL_NOT_FOUND]: '模型不存在,请检查模型配置',
  [AppErrorCode.INVALID_MODEL_CONFIG]: '模型配置无效',
  [AppErrorCode.RATE_LIMIT_EXCEEDED]: '请求过于频繁,请稍后重试',
  [AppErrorCode.FILE_NOT_FOUND]: '文件不存在',
  [AppErrorCode.FILE_READ_ERROR]: '文件读取失败',
  [AppErrorCode.FILE_WRITE_ERROR]: '文件写入失败',
  [AppErrorCode.FILE_TOO_LARGE]: '文件过大',
  [AppErrorCode.GIT_NOT_INITIALIZED]: 'Git 未初始化',
  [AppErrorCode.GIT_CONFLICT]: 'Git 冲突',
  [AppErrorCode.GIT_COMMIT_FAILED]: 'Git 提交失败',
  [AppErrorCode.TOOL_EXECUTION_FAILED]: '工具执行失败',
  [AppErrorCode.COMMAND_NOT_FOUND]: '命令不存在',
  [AppErrorCode.AGENT_LOOP_TIMEOUT]: 'Agent 执行超时',
  [AppErrorCode.AGENT_MAX_RETRIES]: 'Agent 重试次数过多',
  [AppErrorCode.UNKNOWN_ERROR]: '未知错误',
  [AppErrorCode.INTERNAL_ERROR]: '内部错误',
}

/**
 * 将原始错误映射为 AppError
 */
export function mapToAppError(error: unknown, fallbackMessage = '操作失败'): AppError {
  // 已经是 AppError,直接返回
  if (error instanceof AppError) {
    return error
  }

  // Error 实例
  if (error instanceof Error) {
    const code = mapErrorToCode(error)
    const message = ERROR_MESSAGE_MAP[code] || error.message || fallbackMessage
    
    return new AppError(code, message, {
      originalError: error,
    })
  }

  // 字符串错误
  if (typeof error === 'string') {
    return new AppError(AppErrorCode.UNKNOWN_ERROR, error || fallbackMessage)
  }

  // 其他类型
  return new AppError(AppErrorCode.UNKNOWN_ERROR, fallbackMessage, {
    context: { rawError: error },
  })
}

/**
 * 将错误映射为错误码
 */
function mapErrorToCode(error: Error): AppErrorCode {
  const message = error.message.toLowerCase()

  // 网络错误
  if (message.includes('network') || message.includes('fetch failed')) {
    return AppErrorCode.NETWORK_ERROR
  }
  if (message.includes('timeout') || message.includes('etimedout')) {
    return AppErrorCode.TIMEOUT_ERROR
  }
  if (message.includes('econnrefused') || message.includes('connection refused')) {
    return AppErrorCode.CONNECTION_REFUSED
  }

  // 认证错误
  if (message.includes('unauthorized') || message.includes('401')) {
    return AppErrorCode.AUTH_FAILED
  }
  if (message.includes('api key') || message.includes('apikey')) {
    return AppErrorCode.INVALID_API_KEY
  }
  if (message.includes('token expired') || message.includes('token 过期')) {
    return AppErrorCode.TOKEN_EXPIRED
  }

  // 模型错误
  if (message.includes('model not found') || message.includes('404')) {
    return AppErrorCode.MODEL_NOT_FOUND
  }
  if (message.includes('rate limit') || message.includes('429')) {
    return AppErrorCode.RATE_LIMIT_EXCEEDED
  }

  // 文件错误
  if (message.includes('enoent') || message.includes('file not found')) {
    return AppErrorCode.FILE_NOT_FOUND
  }
  if (message.includes('eacces') || message.includes('permission denied')) {
    return AppErrorCode.FILE_READ_ERROR
  }
  if (message.includes('file too large') || message.includes('文件大小')) {
    return AppErrorCode.FILE_TOO_LARGE
  }

  // Git 错误
  if (message.includes('not a git repository')) {
    return AppErrorCode.GIT_NOT_INITIALIZED
  }
  if (message.includes('conflict')) {
    return AppErrorCode.GIT_CONFLICT
  }

  // Agent 错误
  if (message.includes('timeout') && message.includes('agent')) {
    return AppErrorCode.AGENT_LOOP_TIMEOUT
  }
  if (message.includes('max retries') || message.includes('重试')) {
    return AppErrorCode.AGENT_MAX_RETRIES
  }

  // 默认
  return AppErrorCode.UNKNOWN_ERROR
}

/**
 * 获取用户友好的错误消息
 */
export function getUserFriendlyMessage(error: unknown, fallbackMessage = '操作失败'): string {
  const appError = mapToAppError(error, fallbackMessage)
  return appError.message
}

/**
 * 判断错误是否可重试
 */
export function isRetryableAppError(error: unknown): boolean {
  const appError = mapToAppError(error)
  
  const retryableCodes = new Set<AppErrorCode>([
    AppErrorCode.NETWORK_ERROR,
    AppErrorCode.TIMEOUT_ERROR,
    AppErrorCode.CONNECTION_REFUSED,
    AppErrorCode.RATE_LIMIT_EXCEEDED,
    AppErrorCode.TOOL_EXECUTION_FAILED,
  ])

  return retryableCodes.has(appError.code)
}

/**
 * 创建特定类型的错误的快捷函数
 */
export function createNetworkError(originalError?: Error): AppError {
  return new AppError(
    AppErrorCode.NETWORK_ERROR,
    ERROR_MESSAGE_MAP[AppErrorCode.NETWORK_ERROR]!,
    { originalError }
  )
}

export function createAuthError(message = '认证失败'): AppError {
  return new AppError(AppErrorCode.AUTH_FAILED, message)
}

export function createValidationError(message: string): AppError {
  return new AppError(AppErrorCode.INVALID_MODEL_CONFIG, message)
}

export function createFileNotFoundError(filePath: string): AppError {
  return new AppError(
    AppErrorCode.FILE_NOT_FOUND,
    `文件不存在: ${filePath}`
  )
}

export function createTimeoutError(timeoutMs?: number): AppError {
  const message = timeoutMs 
    ? `操作超时 (${timeoutMs}ms)`
    : ERROR_MESSAGE_MAP[AppErrorCode.TIMEOUT_ERROR]!
  return new AppError(AppErrorCode.TIMEOUT_ERROR, message)
}
