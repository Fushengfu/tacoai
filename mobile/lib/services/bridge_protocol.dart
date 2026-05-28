///  Taco 跨端桥接协议定义（移动端）
///
///  Mobile (Client) 扫码获取配对码，使用会员 token 连接 Relay 与 Host 配对。

/* ------------------------------------------------------------------ */
/*  Relay → Host/Client 消息                                           */
/* ------------------------------------------------------------------ */

/// 连接成功（Client 收到）
class BridgeConnected {
  final String type = 'connected';
  final String message;
  final int timestamp;

  BridgeConnected({required this.message, required this.timestamp});

  factory BridgeConnected.fromJson(Map<String, dynamic> json) {
    return BridgeConnected(
      message: json['message'] as String? ?? '',
      timestamp: json['timestamp'] as int? ?? 0,
    );
  }
}

/// 配对码（Host 连接成功后收到，Client 不需要）
class BridgePairingCode {
  final String type = 'pairing_code';
  final String code;
  final int timestamp;

  BridgePairingCode({required this.code, required this.timestamp});

  factory BridgePairingCode.fromJson(Map<String, dynamic> json) {
    return BridgePairingCode(
      code: json['code'] as String? ?? '',
      timestamp: json['timestamp'] as int? ?? 0,
    );
  }
}

/// Client 连接通知
class BridgeClientConnected {
  final String type = 'client_connected';
  final String message;
  final int timestamp;

  BridgeClientConnected({required this.message, required this.timestamp});

  factory BridgeClientConnected.fromJson(Map<String, dynamic> json) {
    return BridgeClientConnected(
      message: json['message'] as String? ?? '',
      timestamp: json['timestamp'] as int? ?? 0,
    );
  }
}

/// Client 断开通知
class BridgeClientDisconnected {
  final String type = 'client_disconnected';
  final String message;
  final int timestamp;

  BridgeClientDisconnected({required this.message, required this.timestamp});

  factory BridgeClientDisconnected.fromJson(Map<String, dynamic> json) {
    return BridgeClientDisconnected(
      message: json['message'] as String? ?? '',
      timestamp: json['timestamp'] as int? ?? 0,
    );
  }
}

/// Host 断开通知（Client 收到）
class BridgeHostDisconnected {
  final String type = 'host_disconnected';
  final int timestamp;

  BridgeHostDisconnected({required this.timestamp});

  factory BridgeHostDisconnected.fromJson(Map<String, dynamic> json) {
    return BridgeHostDisconnected(
      timestamp: json['timestamp'] as int? ?? 0,
    );
  }
}

/// 错误消息
class BridgeError {
  final String type = 'error';
  final String message;

  BridgeError({required this.message});

  factory BridgeError.fromJson(Map<String, dynamic> json) {
    return BridgeError(message: json['message'] as String? ?? '');
  }
}

/// Ping（心跳）
class BridgePing {
  final String type = 'ping';
  final int timestamp;

  BridgePing({required this.timestamp});

  factory BridgePing.fromJson(Map<String, dynamic> json) {
    return BridgePing(timestamp: json['timestamp'] as int? ?? 0);
  }
}

/* ------------------------------------------------------------------ */
/*  Host → Client 桥接消息（通过 Relay 转发）                           */
/* ------------------------------------------------------------------ */

/// Token 使用统计
class BridgeTokenUsage {
  final int? promptTokens;
  final int? completionTokens;
  final int? totalTokens;
  final int? cachedTokens;

  BridgeTokenUsage({
    this.promptTokens,
    this.completionTokens,
    this.totalTokens,
    this.cachedTokens,
  });

  factory BridgeTokenUsage.fromJson(Map<String, dynamic> json) {
    return BridgeTokenUsage(
      promptTokens: json['promptTokens'] as int?,
      completionTokens: json['completionTokens'] as int?,
      totalTokens: json['totalTokens'] as int?,
      cachedTokens: json['cachedTokens'] as int?,
    );
  }
}

/// 完整会话状态快照
class BridgeState {
  final String type = 'bridge:state';
  final List<BridgeChatMessage> messages;
  final String? threadId;
  final String? activeAgentRequestId;
  final String? workspace;
  final String? modelLabel;
  final String? modelConfigId;
  final String? threadTitle;
  final String? projectTitle;
  final BridgeTokenUsage? tokenUsage;

  BridgeState({
    required this.messages,
    this.threadId,
    this.activeAgentRequestId,
    this.workspace,
    this.modelLabel,
    this.modelConfigId,
    this.threadTitle,
    this.projectTitle,
    this.tokenUsage,
  });

  factory BridgeState.fromJson(Map<String, dynamic> json) {
    final msgs = (json['messages'] as List<dynamic>?)
            ?.map((m) => BridgeChatMessage.fromJson(m as Map<String, dynamic>))
            .toList() ??
        [];
    final tokenUsageJson = json['tokenUsage'] as Map<String, dynamic>?;
    return BridgeState(
      messages: msgs,
      threadId: json['threadId'] as String?,
      activeAgentRequestId: json['activeAgentRequestId'] as String?,
      workspace: json['workspace'] as String?,
      modelLabel: json['modelLabel'] as String?,
      modelConfigId: json['modelConfigId'] as String?,
      threadTitle: json['threadTitle'] as String?,
      projectTitle: json['projectTitle'] as String?,
      tokenUsage: tokenUsageJson != null ? BridgeTokenUsage.fromJson(tokenUsageJson) : null,
    );
  }
}

/// Agent 步骤信息
class BridgeAgentStep {
  final int round;
  final String? systemTitle;
  final String? systemDetail;
  final String thinking;
  final List<BridgeToolCallInfo> toolCalls;
  final List<BridgeToolResultInfo> toolResults;
  final String status; // 'calling' | 'running' | 'confirm' | 'done'
  final List<BridgeRiskInfo>? risks;
  final String? confirmId;

  BridgeAgentStep({
    required this.round,
    this.systemTitle,
    this.systemDetail,
    this.thinking = '',
    this.toolCalls = const [],
    this.toolResults = const [],
    this.status = 'done',
    this.risks,
    this.confirmId,
  });

  factory BridgeAgentStep.fromJson(Map<String, dynamic> json) {
    return BridgeAgentStep(
      round: json['round'] as int? ?? 0,
      systemTitle: json['systemTitle'] as String?,
      systemDetail: json['systemDetail'] as String?,
      thinking: json['thinking'] as String? ?? '',
      toolCalls: (json['toolCalls'] as List<dynamic>?)
              ?.map((t) => BridgeToolCallInfo.fromJson(t as Map<String, dynamic>))
              .toList() ??
          [],
      toolResults: (json['toolResults'] as List<dynamic>?)
              ?.map((r) => BridgeToolResultInfo.fromJson(r as Map<String, dynamic>))
              .toList() ??
          [],
      status: json['status'] as String? ?? 'done',
      risks: (json['risks'] as List<dynamic>?)
              ?.map((r) => BridgeRiskInfo.fromJson(r as Map<String, dynamic>))
              .toList(),
      confirmId: json['confirmId'] as String?,
    );
  }
}

/// 工具调用信息（与桌面端 ToolCallInfo 一致）
class BridgeToolCallInfo {
  final String id;
  final String name;
  final String arguments;

  BridgeToolCallInfo({
    required this.id,
    required this.name,
    required this.arguments,
  });

  factory BridgeToolCallInfo.fromJson(Map<String, dynamic> json) {
    // 桌面端 IpcToolCall 格式: { id, type: 'function', function: { name, arguments } }
    // 兼容扁平格式: { id, name, arguments }
    final func = json['function'] as Map<String, dynamic>?;
    return BridgeToolCallInfo(
      id: json['id'] as String? ?? '',
      name: func?['name'] as String? ?? json['name'] as String? ?? '',
      arguments: func?['arguments'] as String? ?? json['arguments'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'arguments': arguments,
    };
  }
}

/// 工具执行结果（与桌面端 ToolResultInfo 一致）
/// 文件变更信息（write_file / edit_file / delete_file 时携带）
class BridgeFileChange {
  final String filePath;
  final String? oldContent; // null 表示新建文件
  final String? newContent; // null 表示文件被删除

  BridgeFileChange({
    required this.filePath,
    this.oldContent,
    this.newContent,
  });

  factory BridgeFileChange.fromJson(Map<String, dynamic> json) {
    return BridgeFileChange(
      filePath: json['filePath'] as String? ?? '',
      oldContent: json['oldContent'] as String?,
      newContent: json['newContent'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'filePath': filePath,
      if (oldContent != null) 'oldContent': oldContent,
      if (newContent != null) 'newContent': newContent,
    };
  }
}

class BridgeToolResultInfo {
  final String toolCallId;  // 注意：桌面端使用 tool_call_id，但JSON反序列化时会映射
  final String name;
  final String content;
  final bool success;
  final BridgeFileChange? fileChange;

  BridgeToolResultInfo({
    required this.toolCallId,
    required this.name,
    required this.content,
    required this.success,
    this.fileChange,
  });

  factory BridgeToolResultInfo.fromJson(Map<String, dynamic> json) {
    return BridgeToolResultInfo(
      toolCallId: json['tool_call_id'] as String? ?? json['toolCallId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      content: json['content'] as String? ?? '',
      success: json['success'] as bool? ?? false,
      fileChange: json['fileChange'] != null
          ? BridgeFileChange.fromJson(json['fileChange'] as Map<String, dynamic>)
          : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'tool_call_id': toolCallId,
      'name': name,
      'content': content,
      'success': success,
      if (fileChange != null) 'fileChange': fileChange!.toJson(),
    };
  }
}

/// 风险信息
class BridgeRiskInfo {
  final String toolCallId;
  final String toolName;
  final String level; // 'safe' | 'warning' | 'danger'
  final String reason;
  final String detail;

  BridgeRiskInfo({
    required this.toolCallId,
    required this.toolName,
    required this.level,
    required this.reason,
    required this.detail,
  });

  factory BridgeRiskInfo.fromJson(Map<String, dynamic> json) {
    return BridgeRiskInfo(
      toolCallId: json['toolCallId'] as String? ?? '',
      toolName: json['toolName'] as String? ?? '',
      level: json['level'] as String? ?? 'safe',
      reason: json['reason'] as String? ?? '',
      detail: json['detail'] as String? ?? '',
    );
  }
}

/// 计划步骤信息
class BridgePlanStepInfo {
  final int index;
  final String title;
  final String content;
  final String status; // 'pending' | 'in_progress' | 'done' | 'failed'
  final String? note;

  BridgePlanStepInfo({
    this.index = 0,
    this.title = '',
    this.content = '',
    required this.status,
    this.note,
  });

  factory BridgePlanStepInfo.fromJson(Map<String, dynamic> json) {
    // 兼容旧格式 { text, status } 和新格式 { index, title, content, status }
    final text = json['text'] as String? ?? '';
    return BridgePlanStepInfo(
      index: json['index'] as int? ?? 0,
      title: json['title'] as String? ?? text,
      content: json['content'] as String? ?? text,
      status: json['status'] as String? ?? 'pending',
      note: json['note'] as String?,
    );
  }
}

/// 活跃的执行计划
class BridgeActivePlan {
  final String summary;
  final String? reasoning;
  final List<BridgePlanStepInfo> steps;
  final int? startedAt;
  final int? endedAt;

  BridgeActivePlan({
    required this.summary,
    this.reasoning,
    required this.steps,
    this.startedAt,
    this.endedAt,
  });

  factory BridgeActivePlan.fromJson(Map<String, dynamic> json) {
    return BridgeActivePlan(
      summary: json['summary'] as String? ?? '',
      reasoning: json['reasoning'] as String?,
      steps: (json['steps'] as List<dynamic>?)
              ?.map((s) => BridgePlanStepInfo.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
      startedAt: json['startedAt'] as int?,
      endedAt: json['endedAt'] as int?,
    );
  }
}

/// 单轮任务耗时
class BridgeTaskTiming {
  final int startedAt;
  final int? endedAt;
  final int? durationMs;

  BridgeTaskTiming({
    required this.startedAt,
    this.endedAt,
    this.durationMs,
  });

  factory BridgeTaskTiming.fromJson(Map<String, dynamic> json) {
    return BridgeTaskTiming(
      startedAt: json['startedAt'] as int? ?? 0,
      endedAt: json['endedAt'] as int?,
      durationMs: json['durationMs'] as int?,
    );
  }
}

/// 图片附件（与桌面端 AttachedImage 一致）
class BridgeAttachedImage {
  final String id;
  final String dataUrl;
  final String cloudUrl;
  final String name;
  final String uploadStatus;  // 'pending' | 'uploading' | 'done' | 'error'
  final int? uploadProgress;  // 可选字段，与桌面端一致

  BridgeAttachedImage({
    required this.id,
    required this.dataUrl,
    required this.cloudUrl,
    required this.name,
    this.uploadStatus = 'done',
    this.uploadProgress,
  });

  factory BridgeAttachedImage.fromJson(Map<String, dynamic> json) {
    return BridgeAttachedImage(
      id: json['id'] as String? ?? '',
      dataUrl: json['dataUrl'] as String? ?? '',
      cloudUrl: json['cloudUrl'] as String? ?? '',
      name: json['name'] as String? ?? '',
      uploadStatus: json['uploadStatus'] as String? ?? 'done',
      uploadProgress: json['uploadProgress'] as int?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'dataUrl': dataUrl,
      'cloudUrl': cloudUrl,
      'name': name,
      'uploadStatus': uploadStatus,
      if (uploadProgress != null) 'uploadProgress': uploadProgress,
    };
  }
}

/// 文件附件（与桌面端 AttachedAsset 一致）
class BridgeAttachedAsset {
  final String id;
  final String path;
  final String name;

  BridgeAttachedAsset({
    required this.id,
    required this.path,
    required this.name,
  });

  factory BridgeAttachedAsset.fromJson(Map<String, dynamic> json) {
    return BridgeAttachedAsset(
      id: json['id'] as String? ?? '',
      path: json['path'] as String? ?? '',
      name: json['name'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'path': path,
      'name': name,
    };
  }
}

/// 对话消息（与桌面端 ChatMsg 完全一致）
class BridgeChatMessage {
  final String id;
  final String role; // 'user' | 'assistant' | 'system'
  final String content;
  final List<BridgeAttachedImage>? images;  // 完整的图片数组
  final List<BridgeAttachedAsset>? attachments;  // 完整的文件附件数组
  final List<BridgeAgentStep>? agentSteps;
  final String? gitCommitHash;
  final BridgeActivePlan? activePlan;
  final BridgeTaskTiming? taskTiming;
  final List<BridgeToolCallInfo>? toolCalls;  // 兼容旧数据
  final List<BridgeToolResultInfo>? toolResults;  // 兼容旧数据

  BridgeChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.images,
    this.attachments,
    this.agentSteps,
    this.gitCommitHash,
    this.activePlan,
    this.taskTiming,
    this.toolCalls,
    this.toolResults,
  });

  factory BridgeChatMessage.fromJson(Map<String, dynamic> json) {
    return BridgeChatMessage(
      id: json['id'] as String? ?? '',
      role: json['role'] as String? ?? 'assistant',
      content: json['content'] as String? ?? '',
      images: (json['images'] as List<dynamic>?)
          ?.map((img) => BridgeAttachedImage.fromJson(img as Map<String, dynamic>))
          .toList(),
      attachments: (json['attachments'] as List<dynamic>?)
          ?.map((asset) => BridgeAttachedAsset.fromJson(asset as Map<String, dynamic>))
          .toList(),
      agentSteps: (json['agentSteps'] as List<dynamic>?)
          ?.map((s) => BridgeAgentStep.fromJson(s as Map<String, dynamic>))
          .toList(),
      gitCommitHash: json['gitCommitHash'] as String?,
      activePlan: json['activePlan'] != null
          ? BridgeActivePlan.fromJson(json['activePlan'] as Map<String, dynamic>)
          : null,
      taskTiming: json['taskTiming'] != null
          ? BridgeTaskTiming.fromJson(json['taskTiming'] as Map<String, dynamic>)
          : null,
      toolCalls: (json['toolCalls'] as List<dynamic>?)
          ?.map((tc) => BridgeToolCallInfo.fromJson(tc as Map<String, dynamic>))
          .toList(),
      toolResults: (json['toolResults'] as List<dynamic>?)
          ?.map((tr) => BridgeToolResultInfo.fromJson(tr as Map<String, dynamic>))
          .toList(),
    );
  }

  /// 创建副本并替换指定字段（用于原地更新，减少对象重建开销）
  BridgeChatMessage copyWith({
    String? id,
    String? role,
    String? content,
    List<BridgeAttachedImage>? images,
    List<BridgeAttachedAsset>? attachments,
    List<BridgeAgentStep>? agentSteps,
    String? gitCommitHash,
    BridgeActivePlan? activePlan,
    BridgeTaskTiming? taskTiming,
    List<BridgeToolCallInfo>? toolCalls,
    List<BridgeToolResultInfo>? toolResults,
  }) {
    return BridgeChatMessage(
      id: id ?? this.id,
      role: role ?? this.role,
      content: content ?? this.content,
      images: images ?? this.images,
      attachments: attachments ?? this.attachments,
      agentSteps: agentSteps ?? this.agentSteps,
      gitCommitHash: gitCommitHash ?? this.gitCommitHash,
      activePlan: activePlan ?? this.activePlan,
      taskTiming: taskTiming ?? this.taskTiming,
      toolCalls: toolCalls ?? this.toolCalls,
      toolResults: toolResults ?? this.toolResults,
    );
  }
}

/// 流式文本增量
class BridgeChatDelta {
  final String type = 'bridge:chat-delta';
  final String messageId;
  final String delta;
  final bool done;
  final String? threadId;

  BridgeChatDelta({
    required this.messageId,
    required this.delta,
    this.done = false,
    this.threadId,
  });

  factory BridgeChatDelta.fromJson(Map<String, dynamic> json) {
    return BridgeChatDelta(
      messageId: json['messageId'] as String? ?? '',
      delta: json['delta'] as String? ?? '',
      done: json['done'] as bool? ?? false,
      threadId: json['threadId'] as String?,
    );
  }
}

/// Agent 执行事件
class BridgeAgentEvent {
  final String type = 'bridge:agent-event';
  final String requestId;
  final String? originalRequestId;
  final String? threadId;
  final Map<String, dynamic> event;

  BridgeAgentEvent({required this.requestId, this.originalRequestId, this.threadId, required this.event});

  factory BridgeAgentEvent.fromJson(Map<String, dynamic> json) {
    return BridgeAgentEvent(
      requestId: json['requestId'] as String? ?? '',
      originalRequestId: json['originalRequestId'] as String?,
      threadId: json['threadId'] as String?,
      event: json['event'] as Map<String, dynamic>? ?? {},
    );
  }
}

/// 文件变更通知
class BridgeFilesChanged {
  final String type = 'bridge:files-changed';
  final List<String> files;
  final int timestamp;

  BridgeFilesChanged({required this.files, required this.timestamp});

  factory BridgeFilesChanged.fromJson(Map<String, dynamic> json) {
    return BridgeFilesChanged(
      files: (json['files'] as List<dynamic>?)
              ?.map((f) => f as String)
              .toList() ??
          [],
      timestamp: json['timestamp'] as int? ?? 0,
    );
  }
}

/// 确认已处理通知（Host → Client，桌面端确认/拒绝后通知移动端清除弹窗）
class BridgeAgentConfirmResolved {
  final String type = 'bridge:agent-confirm-resolved';
  final String confirmId;
  final bool approved;

  BridgeAgentConfirmResolved({required this.confirmId, required this.approved});

  factory BridgeAgentConfirmResolved.fromJson(Map<String, dynamic> json) {
    return BridgeAgentConfirmResolved(
      confirmId: json['confirmId'] as String? ?? '',
      approved: json['approved'] as bool? ?? false,
    );
  }
}

/// 心跳
class BridgeHeartbeat {
  final String type = 'heartbeat';
  final int timestamp;

  BridgeHeartbeat({required this.timestamp});

  factory BridgeHeartbeat.fromJson(Map<String, dynamic> json) {
    return BridgeHeartbeat(timestamp: json['timestamp'] as int? ?? 0);
  }
}

/* ------------------------------------------------------------------ */
/*  Client → Host 指令（通过 Relay 转发）                               */
/* ------------------------------------------------------------------ */

/// 发送用户消息
class BridgeChatSend {
  final String type = 'bridge:chat-send';
  final String content;
  final List<String>? images;

  BridgeChatSend({required this.content, this.images});

  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'content': content,
      if (images != null) 'images': images,
    };
  }
}

/// 待确认项（用于顶部弹窗确认）
class BridgePendingConfirm {
  final String confirmId;
  final String? projectId;  // 新增：项目 ID，用于项目隔离
  final bool isPlanConfirm; // true=执行计划确认，false=授权确认
  final String summary; // 确认摘要
  final List<BridgeRiskInfo> risks;
  final List<BridgeToolCallInfo> toolCalls;
  final String? thinking; // 确认前的思考内容

  BridgePendingConfirm({
    required this.confirmId,
    this.projectId,  // 可选，但建议传入
    required this.isPlanConfirm,
    required this.summary,
    required this.risks,
    required this.toolCalls,
    this.thinking,
  });
}

/// Agent 确认/拒绝响应
class BridgeAgentConfirm {
  final String type = 'bridge:agent-confirm';
  final String confirmId;
  final bool approved;

  BridgeAgentConfirm({required this.confirmId, required this.approved});

  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'confirmId': confirmId,
      'approved': approved,
    };
  }
}

/// 终止 Agent
class BridgeAgentAbort {
  final String type = 'bridge:agent-abort';
  final String requestId;

  BridgeAgentAbort({required this.requestId});

  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'requestId': requestId,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Client → Host 数据查询指令（请求/响应模式）                          */
/* ------------------------------------------------------------------ */

/// 请求项目列表
class BridgeGetProjects {
  final String type = 'bridge:get-projects';
  final String requestId;

  BridgeGetProjects({required this.requestId});

  Map<String, dynamic> toJson() => {'type': type, 'requestId': requestId};
}

/// 项目信息
class BridgeProjectInfo {
  final String id;
  final String title;
  final String? workspace;
  final List<BridgeSessionInfo> sessions;
  final String? activeSessionId;
  final String? modelConfigId;

  BridgeProjectInfo({
    required this.id,
    required this.title,
    this.workspace,
    required this.sessions,
    this.activeSessionId,
    this.modelConfigId,
  });

  factory BridgeProjectInfo.fromJson(Map<String, dynamic> json) {
    return BridgeProjectInfo(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      workspace: json['workspace'] as String?,
      sessions: (json['sessions'] as List<dynamic>?)
              ?.map((s) => BridgeSessionInfo.fromJson(s as Map<String, dynamic>))
              .toList() ??
          [],
      activeSessionId: json['activeSessionId'] as String?,
      modelConfigId: json['modelConfigId'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'workspace': workspace,
      'sessions': sessions.map((s) => s.toJson()).toList(),
      'activeSessionId': activeSessionId,
      'modelConfigId': modelConfigId,
    };
  }
}

/// 会话信息
class BridgeSessionInfo {
  final String id;
  final String title;
  final int createdAt;

  BridgeSessionInfo({
    required this.id,
    required this.title,
    required this.createdAt,
  });

  factory BridgeSessionInfo.fromJson(Map<String, dynamic> json) {
    return BridgeSessionInfo(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      createdAt: json['createdAt'] as int? ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'createdAt': createdAt,
    };
  }
}

/// 项目列表响应
class BridgeProjectsResponse {
  final String requestId;
  final List<BridgeProjectInfo> projects;
  final String? activeThreadId;

  BridgeProjectsResponse({this.requestId = '', required this.projects, this.activeThreadId});

  factory BridgeProjectsResponse.fromJson(Map<String, dynamic> json) {
    return BridgeProjectsResponse(
      requestId: json['requestId'] as String? ?? '',
      projects: (json['projects'] as List<dynamic>?)
              ?.map((p) => BridgeProjectInfo.fromJson(p as Map<String, dynamic>))
              .toList() ??
          [],
      activeThreadId: json['activeThreadId'] as String?,
    );
  }
}

/// 请求目录树
class BridgeGetWorkspaceTree {
  final String type = 'bridge:get-workspace-tree';
  final String requestId;
  final String path;

  BridgeGetWorkspaceTree({required this.requestId, required this.path});

  Map<String, dynamic> toJson() => {'type': type, 'requestId': requestId, 'path': path};
}

/// 文件树条目
class BridgeFileTreeEntry {
  final String name;
  final String path;
  final bool isDirectory;
  final List<BridgeFileTreeEntry> children;

  BridgeFileTreeEntry({
    required this.name,
    required this.path,
    required this.isDirectory,
    this.children = const [],
  });

  factory BridgeFileTreeEntry.fromJson(Map<String, dynamic> json) {
    return BridgeFileTreeEntry(
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      isDirectory: json['isDirectory'] as bool? ?? false,
      children: (json['children'] as List<dynamic>?)
              ?.map((c) => BridgeFileTreeEntry.fromJson(c as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}

/// 目录树响应
class BridgeWorkspaceTreeResponse {
  final String requestId;
  final List<BridgeFileTreeEntry> tree;

  BridgeWorkspaceTreeResponse({required this.requestId, required this.tree});

  factory BridgeWorkspaceTreeResponse.fromJson(Map<String, dynamic> json) {
    return BridgeWorkspaceTreeResponse(
      requestId: json['requestId'] as String? ?? '',
      tree: (json['tree'] as List<dynamic>?)
              ?.map((t) => BridgeFileTreeEntry.fromJson(t as Map<String, dynamic>))
              .toList() ??
          [],
    );
  }
}

/// 请求读取文件
class BridgeFileRead {
  final String type = 'bridge:file-read';
  final String requestId;
  final String path;

  BridgeFileRead({required this.requestId, required this.path});

  Map<String, dynamic> toJson() => {'type': type, 'requestId': requestId, 'path': path};
}

/// 文件内容响应
class BridgeFileContentResponse {
  final String requestId;
  final String? content;
  final int size;
  final bool isBinary;
  final String? dataUrl;
  final bool truncated;

  BridgeFileContentResponse({
    required this.requestId,
    this.content,
    required this.size,
    required this.isBinary,
    this.dataUrl,
    this.truncated = false,
  });

  factory BridgeFileContentResponse.fromJson(Map<String, dynamic> json) {
    return BridgeFileContentResponse(
      requestId: json['requestId'] as String? ?? '',
      content: json['content'] as String?,
      size: json['size'] as int? ?? 0,
      isBinary: json['isBinary'] as bool? ?? false,
      dataUrl: json['dataUrl'] as String?,
      truncated: json['truncated'] as bool? ?? false,
    );
  }
}

/// 请求写入文件
class BridgeFileWrite {
  final String type = 'bridge:file-write';
  final String requestId;
  final String path;
  final String content;

  BridgeFileWrite({required this.requestId, required this.path, required this.content});

  Map<String, dynamic> toJson() => {
    'type': type,
    'requestId': requestId,
    'path': path,
    'content': content,
  };
}

/// 文件写入结果
class BridgeFileWrittenResponse {
  final String requestId;
  final bool success;
  final String? error;

  BridgeFileWrittenResponse({required this.requestId, required this.success, this.error});

  factory BridgeFileWrittenResponse.fromJson(Map<String, dynamic> json) {
    return BridgeFileWrittenResponse(
      requestId: json['requestId'] as String? ?? '',
      success: json['success'] as bool? ?? false,
      error: json['error'] as String?,
    );
  }
}

/// 请求切换项目
class BridgeSwitchProject {
  final String type = 'bridge:switch-project';
  final String requestId;
  final String projectId;
  final String? sessionId;

  BridgeSwitchProject({required this.requestId, required this.projectId, this.sessionId});

  Map<String, dynamic> toJson() => {
    'type': type,
    'requestId': requestId,
    'projectId': projectId,
    if (sessionId != null) 'sessionId': sessionId,
  };
}

/// 请求当前状态快照（连接/重连后使用）
class BridgeRequestState {
  final String type = 'bridge:request-state';
  final String requestId;
  final String? threadId;

  BridgeRequestState({required this.requestId, this.threadId});

  Map<String, dynamic> toJson() => {
    'type': type,
    'requestId': requestId,
    if (threadId != null && threadId!.isNotEmpty) 'threadId': threadId,
  };
}

/// 项目切换结果
class BridgeProjectSwitchedResponse {
  final String requestId;
  final bool success;
  final String? error;

  BridgeProjectSwitchedResponse({required this.requestId, required this.success, this.error});

  factory BridgeProjectSwitchedResponse.fromJson(Map<String, dynamic> json) {
    return BridgeProjectSwitchedResponse(
      requestId: json['requestId'] as String? ?? '',
      success: json['success'] as bool? ?? false,
      error: json['error'] as String?,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  模型切换                                                           */
/* ------------------------------------------------------------------ */

/// 模型配置（从桌面端获取）
class BridgeModelConfig {
  final String id;
  final String provider;
  final String name;
  final String displayName;
  final String model;
  final bool supportsVision;

  BridgeModelConfig({
    required this.id,
    required this.provider,
    required this.name,
    this.displayName = '',
    required this.model,
    this.supportsVision = false,
  });

  /// 显示标签：优先使用 displayName，其次 model，最后 name
  String get displayLabel {
    if (displayName.isNotEmpty) return displayName;
    return model.isNotEmpty ? model : name;
  }

  factory BridgeModelConfig.fromJson(Map<String, dynamic> json) {
    return BridgeModelConfig(
      id: json['id'] as String? ?? '',
      provider: json['provider'] as String? ?? '',
      name: json['name'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      model: json['model'] as String? ?? '',
      supportsVision: json['supportsVision'] as bool? ?? false,
    );
  }
}

/// bridge:models 响应
class BridgeModelsList {
  final String type = 'bridge:models';
  final String requestId;
  final List<BridgeModelConfig> models;
  final String? activeModelConfigId;

  BridgeModelsList({
    required this.requestId,
    required this.models,
    this.activeModelConfigId,
  });

  factory BridgeModelsList.fromJson(Map<String, dynamic> json) {
    return BridgeModelsList(
      requestId: json['requestId'] as String? ?? '',
      models: (json['models'] as List<dynamic>?)
              ?.map((m) => BridgeModelConfig.fromJson(m as Map<String, dynamic>))
              .toList() ??
          [],
      activeModelConfigId: json['activeModelConfigId'] as String?,
    );
  }
}

/// bridge:model-switched 响应
class BridgeModelSwitchedResponse {
  final String type = 'bridge:model-switched';
  final String requestId;
  final bool success;
  final String? error;

  BridgeModelSwitchedResponse({
    required this.requestId,
    required this.success,
    this.error,
  });

  factory BridgeModelSwitchedResponse.fromJson(Map<String, dynamic> json) {
    return BridgeModelSwitchedResponse(
      requestId: json['requestId'] as String? ?? '',
      success: json['success'] as bool? ?? false,
      error: json['error'] as String?,
    );
  }
}

/// 请求更早的消息（分页加载）
class BridgeLoadOlderMessages {
  final String type = 'bridge:load-older-messages';
  final String requestId;
  final String sessionId;
  final int beforeSeq;
  final int limit;

  BridgeLoadOlderMessages({
    required this.requestId,
    required this.sessionId,
    required this.beforeSeq,
    this.limit = 50,
  });

  Map<String, dynamic> toJson() => {
    'type': type,
    'requestId': requestId,
    'sessionId': sessionId,
    'beforeSeq': beforeSeq,
    'limit': limit,
  };
}

/// 更早的消息响应
class BridgeOlderMessagesResponse {
  final String requestId;
  final List<BridgeChatMessage> messages;
  final int totalCount;
  final int? startSeq;
  final int? endSeq;

  BridgeOlderMessagesResponse({
    required this.requestId,
    required this.messages,
    required this.totalCount,
    this.startSeq,
    this.endSeq,
  });

  factory BridgeOlderMessagesResponse.fromJson(Map<String, dynamic> json) {
    return BridgeOlderMessagesResponse(
      requestId: json['requestId'] as String? ?? '',
      messages: (json['messages'] as List<dynamic>?)
              ?.map((m) => BridgeChatMessage.fromJson(m as Map<String, dynamic>))
              .toList() ??
          [],
      totalCount: json['totalCount'] as int? ?? 0,
      startSeq: json['startSeq'] as int?,
      endSeq: json['endSeq'] as int?,
    );
  }
}

/// 任务状态轮询响应
class BridgeTaskStatusResponse {
  final String requestId;
  final bool isProcessing;
  final String? activeTaskId;
  final String? error;

  BridgeTaskStatusResponse({
    required this.requestId,
    required this.isProcessing,
    this.activeTaskId,
    this.error,
  });

  factory BridgeTaskStatusResponse.fromJson(Map<String, dynamic> json) {
    return BridgeTaskStatusResponse(
      requestId: json['requestId'] as String? ?? '',
      isProcessing: json['isProcessing'] as bool? ?? false,
      activeTaskId: json['activeTaskId'] as String?,
      error: json['error'] as String?,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  连接状态                                                           */
/* ------------------------------------------------------------------ */

enum BridgeConnectionStatus {
  disconnected,
  connecting,
  connected,
  reconnecting,
}

class BridgeStatus {
  final BridgeConnectionStatus status;
  final int serverCount; // 服务端连接的设备数（由 Host 转发）
  final String? error;

  BridgeStatus({
    required this.status,
    this.serverCount = 0,
    this.error,
  });
}

/* ------------------------------------------------------------------ */
/*  Relay Server 配置                                                  */
/* ------------------------------------------------------------------ */

/// 默认 Relay 地址（仅当扫码未提供且无缓存时使用）
const String defaultRelayUrl = 'wss://aisocket.bjctykj.com/ws';

const Duration heartbeatInterval = Duration(seconds: 30);
const Duration heartbeatTimeout = Duration(seconds: 90);
const Duration reconnectBaseDelay = Duration(seconds: 3);
const int maxReconnectAttempts = 10;
