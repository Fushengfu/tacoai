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

/// 完整会话状态快照
class BridgeState {
  final String type = 'bridge:state';
  final List<BridgeChatMessage> messages;
  final String? activeAgentRequestId;
  final String? workspace;
  final String? modelLabel;
  final String? threadTitle;

  BridgeState({
    required this.messages,
    this.activeAgentRequestId,
    this.workspace,
    this.modelLabel,
    this.threadTitle,
  });

  factory BridgeState.fromJson(Map<String, dynamic> json) {
    final msgs = (json['messages'] as List<dynamic>?)
            ?.map((m) => BridgeChatMessage.fromJson(m as Map<String, dynamic>))
            .toList() ??
        [];
    return BridgeState(
      messages: msgs,
      activeAgentRequestId: json['activeAgentRequestId'] as String?,
      workspace: json['workspace'] as String?,
      modelLabel: json['modelLabel'] as String?,
      threadTitle: json['threadTitle'] as String?,
    );
  }
}

/// 对话消息
class BridgeChatMessage {
  final String id;
  final String role; // 'user' | 'assistant' | 'system'
  final String content;
  final bool hasImages;
  final bool streaming;

  BridgeChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.hasImages = false,
    this.streaming = false,
  });

  factory BridgeChatMessage.fromJson(Map<String, dynamic> json) {
    return BridgeChatMessage(
      id: json['id'] as String? ?? '',
      role: json['role'] as String? ?? 'assistant',
      content: json['content'] as String? ?? '',
      hasImages: json['hasImages'] as bool? ?? false,
      streaming: json['streaming'] as bool? ?? false,
    );
  }
}

/// 流式文本增量
class BridgeChatDelta {
  final String type = 'bridge:chat-delta';
  final String messageId;
  final String delta;
  final bool done;

  BridgeChatDelta({
    required this.messageId,
    required this.delta,
    this.done = false,
  });

  factory BridgeChatDelta.fromJson(Map<String, dynamic> json) {
    return BridgeChatDelta(
      messageId: json['messageId'] as String? ?? '',
      delta: json['delta'] as String? ?? '',
      done: json['done'] as bool? ?? false,
    );
  }
}

/// Agent 执行事件
class BridgeAgentEvent {
  final String type = 'bridge:agent-event';
  final String requestId;
  final Map<String, dynamic> event;

  BridgeAgentEvent({required this.requestId, required this.event});

  factory BridgeAgentEvent.fromJson(Map<String, dynamic> json) {
    return BridgeAgentEvent(
      requestId: json['requestId'] as String? ?? '',
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
}

/// 项目列表响应
class BridgeProjectsResponse {
  final String requestId;
  final List<BridgeProjectInfo> projects;

  BridgeProjectsResponse({required this.requestId, required this.projects});

  factory BridgeProjectsResponse.fromJson(Map<String, dynamic> json) {
    return BridgeProjectsResponse(
      requestId: json['requestId'] as String? ?? '',
      projects: (json['projects'] as List<dynamic>?)
              ?.map((p) => BridgeProjectInfo.fromJson(p as Map<String, dynamic>))
              .toList() ??
          [],
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
