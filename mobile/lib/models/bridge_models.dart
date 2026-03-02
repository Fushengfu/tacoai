class BridgeConfig {
  const BridgeConfig({
    required this.host,
    required this.port,
    required this.token,
  });

  final String host;
  final int port;
  final String token;

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is BridgeConfig &&
        other.host == host &&
        other.port == port &&
        other.token == token;
  }

  @override
  int get hashCode => Object.hash(host, port, token);
}

class BridgeHttpResponse {
  const BridgeHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

class QueuedMobileCommand {
  const QueuedMobileCommand({
    required this.id,
    required this.text,
    required this.createdAt,
    this.threadId,
    this.sessionId,
    this.provider,
    this.mode,
  });

  final String id;
  final String text;
  final int createdAt;
  final String? threadId;
  final String? sessionId;
  final String? provider;
  final String? mode;
}

class DesktopBridgeContext {
  const DesktopBridgeContext({
    required this.updatedAt,
    required this.activeThreadId,
    required this.activeSessionId,
    required this.activeProvider,
    required this.providers,
    required this.threads,
  });

  final int updatedAt;
  final String? activeThreadId;
  final String? activeSessionId;
  final String? activeProvider;
  final List<DesktopBridgeProvider> providers;
  final List<DesktopBridgeThread> threads;

  factory DesktopBridgeContext.fromJson(Map<String, dynamic> json) {
    final rawThreads = json['threads'];
    final rawProviders = json['providers'];
    final list = rawThreads is List ? rawThreads : <dynamic>[];
    final providerList = rawProviders is List ? rawProviders : <dynamic>[];
    return DesktopBridgeContext(
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      activeThreadId: json['activeThreadId']?.toString(),
      activeSessionId: json['activeSessionId']?.toString(),
      activeProvider: json['activeProvider']?.toString(),
      providers: providerList
          .whereType<Map>()
          .map((item) => DesktopBridgeProvider.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      threads: list
          .whereType<Map>()
          .map((item) => DesktopBridgeThread.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
    );
  }
}

class DesktopBridgeProvider {
  const DesktopBridgeProvider({required this.id, required this.label});

  final String id;
  final String label;

  factory DesktopBridgeProvider.fromJson(Map<String, dynamic> json) {
    final id = json['id']?.toString() ?? '';
    final label = json['label']?.toString() ?? id;
    return DesktopBridgeProvider(id: id, label: label);
  }
}

class DesktopBridgeThread {
  const DesktopBridgeThread({
    required this.threadId,
    required this.title,
    required this.updatedAt,
    required this.mode,
    required this.provider,
    required this.workspace,
    required this.activeSessionId,
    required this.sessions,
  });

  final String threadId;
  final String title;
  final int updatedAt;
  final String mode;
  final String provider;
  final String workspace;
  final String activeSessionId;
  final List<DesktopBridgeSession> sessions;

  factory DesktopBridgeThread.fromJson(Map<String, dynamic> json) {
    final rawSessions = json['sessions'];
    final list = rawSessions is List ? rawSessions : <dynamic>[];
    return DesktopBridgeThread(
      threadId: json['threadId']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      mode: json['mode']?.toString() ?? '',
      provider: json['provider']?.toString() ?? '',
      workspace: json['workspace']?.toString() ?? '',
      activeSessionId: json['activeSessionId']?.toString() ?? '',
      sessions: list
          .whereType<Map>()
          .map((item) => DesktopBridgeSession.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
    );
  }
}

class DesktopBridgeSession {
  const DesktopBridgeSession({
    required this.sessionId,
    required this.title,
    required this.messageCount,
    required this.messages,
    required this.sending,
    required this.queue,
    required this.streamingContent,
  });

  final String sessionId;
  final String title;
  final int messageCount;
  final List<DesktopBridgeMessage> messages;
  final bool sending;
  final List<String> queue;
  final String streamingContent;

  factory DesktopBridgeSession.fromJson(Map<String, dynamic> json) {
    final rawMessages = json['messages'];
    final rawQueue = json['queue'];
    final messageList = rawMessages is List ? rawMessages : <dynamic>[];
    final queueList = rawQueue is List ? rawQueue : <dynamic>[];
    return DesktopBridgeSession(
      sessionId: json['sessionId']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
      messages: messageList
          .whereType<Map>()
          .map((item) => DesktopBridgeMessage.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      sending: json['sending'] == true,
      queue: queueList.map((item) => item.toString()).toList(),
      streamingContent: json['streamingContent']?.toString() ?? '',
    );
  }
}

class DesktopBridgeMessage {
  const DesktopBridgeMessage({
    required this.id,
    required this.role,
    required this.content,
    required this.screenshotPaths,
    required this.agentSteps,
    this.activePlan,
  });

  final String id;
  final String role;
  final String content;
  final List<String> screenshotPaths;
  final List<DesktopBridgeAgentStep> agentSteps;
  final DesktopBridgeActivePlan? activePlan;

  factory DesktopBridgeMessage.fromJson(Map<String, dynamic> json) {
    final rawSteps = json['agentSteps'];
    final stepList = rawSteps is List ? rawSteps : <dynamic>[];
    final rawScreenshots = json['screenshotPaths'];
    final screenshotList = rawScreenshots is List ? rawScreenshots : <dynamic>[];
    final rawPlan = json['activePlan'];
    return DesktopBridgeMessage(
      id: json['id']?.toString() ?? '',
      role: json['role']?.toString() ?? 'assistant',
      content: json['content']?.toString() ?? '',
      screenshotPaths: screenshotList.map((item) => item.toString()).where((v) => v.isNotEmpty).toList(),
      agentSteps: stepList
          .whereType<Map>()
          .map((item) => DesktopBridgeAgentStep.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      activePlan: rawPlan is Map
          ? DesktopBridgeActivePlan.fromJson(Map<String, dynamic>.from(rawPlan))
          : null,
    );
  }
}

class DesktopBridgeAgentStep {
  const DesktopBridgeAgentStep({
    required this.round,
    required this.thinking,
    required this.status,
    required this.toolCalls,
    required this.toolResults,
    this.confirmId,
    this.risks = const <DesktopBridgeRiskInfo>[],
  });

  final int round;
  final String thinking;
  final String status;
  final List<DesktopBridgeToolCall> toolCalls;
  final List<DesktopBridgeToolResult> toolResults;
  final String? confirmId;
  final List<DesktopBridgeRiskInfo> risks;

  factory DesktopBridgeAgentStep.fromJson(Map<String, dynamic> json) {
    final rawToolCalls = json['toolCalls'];
    final rawToolResults = json['toolResults'];
    final rawRisks = json['risks'];
    final toolCallList = rawToolCalls is List ? rawToolCalls : <dynamic>[];
    final toolResultList = rawToolResults is List ? rawToolResults : <dynamic>[];
    final riskList = rawRisks is List ? rawRisks : <dynamic>[];
    return DesktopBridgeAgentStep(
      round: (json['round'] as num?)?.toInt() ?? 0,
      thinking: json['thinking']?.toString() ?? '',
      status: json['status']?.toString() ?? 'done',
      toolCalls: toolCallList
          .whereType<Map>()
          .map((item) => DesktopBridgeToolCall.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      toolResults: toolResultList
          .whereType<Map>()
          .map((item) => DesktopBridgeToolResult.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
      confirmId: json['confirmId']?.toString(),
      risks: riskList
          .whereType<Map>()
          .map((item) => DesktopBridgeRiskInfo.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
    );
  }
}

class DesktopBridgeToolCall {
  const DesktopBridgeToolCall({
    required this.id,
    required this.name,
    required this.arguments,
  });

  final String id;
  final String name;
  final String arguments;

  factory DesktopBridgeToolCall.fromJson(Map<String, dynamic> json) {
    return DesktopBridgeToolCall(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      arguments: json['arguments']?.toString() ?? '',
    );
  }
}

class DesktopBridgeToolResult {
  const DesktopBridgeToolResult({
    required this.toolCallId,
    required this.name,
    required this.content,
    required this.success,
    this.fileChange,
  });

  final String toolCallId;
  final String name;
  final String content;
  final bool success;
  final DesktopBridgeFileChange? fileChange;

  factory DesktopBridgeToolResult.fromJson(Map<String, dynamic> json) {
    return DesktopBridgeToolResult(
      toolCallId: json['tool_call_id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      success: json['success'] == true,
      fileChange: json['fileChange'] is Map
          ? DesktopBridgeFileChange.fromJson(Map<String, dynamic>.from(json['fileChange'] as Map))
          : null,
    );
  }
}

class DesktopBridgeFileChange {
  const DesktopBridgeFileChange({
    required this.filePath,
    this.oldContent,
    this.newContent,
  });

  final String filePath;
  final String? oldContent;
  final String? newContent;

  factory DesktopBridgeFileChange.fromJson(Map<String, dynamic> json) {
    return DesktopBridgeFileChange(
      filePath: json['filePath']?.toString() ?? '',
      oldContent: json['oldContent']?.toString(),
      newContent: json['newContent']?.toString(),
    );
  }
}

class DesktopBridgeRiskInfo {
  const DesktopBridgeRiskInfo({
    required this.toolName,
    required this.reason,
    required this.detail,
    required this.level,
  });

  final String toolName;
  final String reason;
  final String detail;
  final String level;

  factory DesktopBridgeRiskInfo.fromJson(Map<String, dynamic> json) {
    return DesktopBridgeRiskInfo(
      toolName: json['toolName']?.toString() ?? '',
      reason: json['reason']?.toString() ?? '',
      detail: json['detail']?.toString() ?? '',
      level: json['level']?.toString() ?? 'warning',
    );
  }
}

class DesktopBridgeActivePlan {
  const DesktopBridgeActivePlan({
    required this.summary,
    required this.reasoning,
    required this.steps,
  });

  final String summary;
  final String reasoning;
  final List<DesktopBridgePlanStep> steps;

  factory DesktopBridgeActivePlan.fromJson(Map<String, dynamic> json) {
    final rawSteps = json['steps'];
    final stepList = rawSteps is List ? rawSteps : <dynamic>[];
    return DesktopBridgeActivePlan(
      summary: json['summary']?.toString() ?? '',
      reasoning: json['reasoning']?.toString() ?? '',
      steps: stepList
          .whereType<Map>()
          .map((item) => DesktopBridgePlanStep.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
    );
  }
}

class DesktopBridgePlanStep {
  const DesktopBridgePlanStep({
    required this.text,
    required this.status,
    required this.note,
  });

  final String text;
  final String status;
  final String note;

  factory DesktopBridgePlanStep.fromJson(Map<String, dynamic> json) {
    return DesktopBridgePlanStep(
      text: json['text']?.toString() ?? '',
      status: json['status']?.toString() ?? 'pending',
      note: json['note']?.toString() ?? '',
    );
  }
}

class BridgeWorkspaceTreeResponse {
  const BridgeWorkspaceTreeResponse({
    required this.workspace,
    required this.entries,
  });

  final String workspace;
  final List<BridgeWorkspaceEntry> entries;

  factory BridgeWorkspaceTreeResponse.fromJson(Map<String, dynamic> json) {
    final rawEntries = json['entries'];
    final list = rawEntries is List ? rawEntries : <dynamic>[];
    return BridgeWorkspaceTreeResponse(
      workspace: json['workspace']?.toString() ?? '',
      entries: list
          .whereType<Map>()
          .map((item) =>
              BridgeWorkspaceEntry.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
    );
  }
}

class BridgeWorkspaceEntry {
  const BridgeWorkspaceEntry({
    required this.name,
    required this.path,
    required this.isDirectory,
    required this.children,
  });

  final String name;
  final String path;
  final bool isDirectory;
  final List<BridgeWorkspaceEntry> children;

  factory BridgeWorkspaceEntry.fromJson(Map<String, dynamic> json) {
    final rawChildren = json['children'];
    final list = rawChildren is List ? rawChildren : <dynamic>[];
    return BridgeWorkspaceEntry(
      name: json['name']?.toString() ?? '',
      path: json['path']?.toString() ?? '',
      isDirectory: json['isDirectory'] == true,
      children: list
          .whereType<Map>()
          .map((item) =>
              BridgeWorkspaceEntry.fromJson(Map<String, dynamic>.from(item)))
          .toList(),
    );
  }
}

class BridgeWorkspaceFileContent {
  const BridgeWorkspaceFileContent({
    required this.path,
    required this.content,
    required this.size,
    required this.isBinary,
    this.dataUrl,
  });

  final String path;
  final String? content;
  final int size;
  final bool isBinary;
  final String? dataUrl;

  factory BridgeWorkspaceFileContent.fromJson(Map<String, dynamic> json) {
    return BridgeWorkspaceFileContent(
      path: json['path']?.toString() ?? '',
      content: json['content']?.toString(),
      size: (json['size'] as num?)?.toInt() ?? 0,
      isBinary: json['isBinary'] == true,
      dataUrl: json['dataUrl']?.toString(),
    );
  }
}
