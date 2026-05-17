import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as ws_status;
import 'bridge_protocol.dart';
import 'bridge_ack_manager.dart';
import 'bridge_message_queue.dart';
import 'message_cache.dart';

const String _kCachedRelayUrlKey = 'bridge_cached_relay_url';
const String _kCachedTokenKey = 'bridge_cached_token';

/// BridgeClient — 移动端 WebSocket 客户端（新版：基于 UserID 自动桥接）
///
/// 流程：
/// 1. 扫码获取 Token（或手动登录）
/// 2. 使用会员 token 连接 Relay，自动匹配同 UserID 的桌面端
/// 3. 接收 Host 转发的桥接消息
/// 4. 发送指令到 Host（发消息、确认、终止）
class BridgeClient {
  final String? _relayUrlOverride;

  WebSocketChannel? _channel;
  BridgeConnectionStatus _status = BridgeConnectionStatus.disconnected;
  String? _token;
  String? _resolvedRelayUrl;
  int _reconnectAttempts = 0;
  bool _userDisconnected = false;
  Timer? _heartbeatTimer;
  Timer? _heartbeatCheckTimer;
  Timer? _reconnectTimer;
  DateTime? _lastHeartbeatReceived;

  // Token 自动刷新
  int _tokenExpiresAt = 0; // Unix 毫秒时间戳
  Timer? _tokenRefreshTimer;
  static const int _kTokenRefreshBeforeMs = 5 * 60 * 1000; // 到期前 5 分钟刷新
  static const int _kDefaultTokenLifetimeMs = 24 * 60 * 60 * 1000; // 默认 24 小时

  final List<BridgeChatMessage> _messages = [];
  final List<Function(BridgeStatus)> _statusListeners = [];
  final List<Function(dynamic)> _messageListeners = [];
  String? _error;
  String? _activeAgentRequestId;
  String? _activeOriginalRequestId; // 原始 requestId，用于 abort（桌面端 agentAbortControllers 的 key）
  String? _activeModelConfigId;
  String? _currentProjectId;
  final Map<String, String> _projectActiveTasks = {}; // projectId -> activeAgentRequestId

  // 项目列表缓存（避免侧边栏每次打开都重新请求）
  List<BridgeProjectInfo>? _cachedProjects;
  String? _cachedActiveThreadId;
  DateTime? _projectsCacheTime;
  static const Duration _kProjectsCacheTtl = Duration(seconds: 5); // 缓存 5 秒（减少延迟）

  /// 当前活跃项目 ID（来自 bridge:project-states 推送或 bridge:state 推送）
  String? get cachedActiveThreadId => _cachedActiveThreadId;
  /// 当前连接的项目 ID（来自 bridge:state 的 threadId）
  String? get currentProjectId => _currentProjectId;
  /// 获取缓存的项目列表（用于显示项目名称）
  List<BridgeProjectInfo>? get cachedProjects => _cachedProjects;

  // 待确认列表（授权确认 + 执行计划确认）
  final List<BridgePendingConfirm> _pendingConfirms = [];
  final List<Function(List<BridgePendingConfirm>)> _confirmListeners = [];

  // 节流机制：将高频通知合并为批量通知
  Timer? _notifyThrottleTimer;
  bool _pendingNotify = false;
  static const Duration _kNotifyThrottleMs = Duration(milliseconds: 16); // ~60fps，与屏幕刷新率对齐

  // Agent 事件立即通知（不节流），保证思考过程和工具调用的实时性
  Timer? _agentNotifyTimer;
  bool _pendingAgentNotify = false;

  // 请求/响应模式：requestId → Completer
  final Map<String, Completer<Map<String, dynamic>>> _pendingRequests = {};
  int _requestCounter = 0;
  
  // ACK 管理器
  BridgeAckManager? _ackManager;
  
  // 消息队列管理器
  final BridgeMessageQueue _messageQueue = BridgeMessageQueue();
  
  // 本地消息缓存
  MessageCache? _messageCache;
  
  // 超时保护：防止任务状态永久残留
  // 每个项目任务设置超时时间，超过后自动清理
  final Map<String, DateTime> _projectTaskTimeouts = {};
  Timer? _taskTimeoutChecker;
  static const Duration _kTaskTimeout = Duration(minutes: 15); // 任务超时15分钟，避免误杀复杂Agent任务
  
  BridgeClient({String? relayUrl}) : _relayUrlOverride = relayUrl {
    _initMessageCache();
  }

  Future<void> _initMessageCache() async {
    try {
      _messageCache = await MessageCache.getInstance();
    } catch (e) {
      print('[BridgeClient] Failed to init message cache: $e');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /// 移除状态监听器
  void removeStatusListener(Function(BridgeStatus) callback) {
    _statusListeners.remove(callback);
  }

  /// 移除消息监听器
  void removeMessageListener(Function(dynamic) callback) {
    _messageListeners.remove(callback);
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /// 连接 Relay
  void connect({required String token}) {
    _token = token;
    _reconnectAttempts = 0;
    _userDisconnected = false;
    // 解析 JWT 过期时间
    _tokenExpiresAt = _parseJwtExpiry(token) ??
        (DateTime.now().millisecondsSinceEpoch + _kDefaultTokenLifetimeMs);
    _connect();
  }

  /// 刷新 Token（用于 Token 过期时自动续期）
  void refreshToken(String newToken) {
    print('[BridgeClient] Token refresh requested');
    _token = newToken;
    _stopTimers();
    _channel?.sink.close(ws_status.normalClosure);
    _channel = null;
    _reconnectAttempts = 0;
    _connect();
  }

  /// 手动重连（保留凭证，重置重连计数）
  void reconnect() {
    _reconnectAttempts = 0;
    _userDisconnected = false;
    _stopTimers();
    _channel?.sink.close(ws_status.normalClosure);
    _channel = null;
    _connect();
  }

  /// 断开连接（用户主动操作）
  /// [clearCache] 为 true 时清除缓存的连接凭证
  Future<void> disconnect({bool clearCache = false}) async {
    _userDisconnected = true;
    _stopTimers();
    _channel?.sink.close(ws_status.normalClosure);
    _channel = null;
    if (clearCache) {
      await _clearConnectionInfo();
    }
    _setStatus(BridgeConnectionStatus.disconnected);
  }

  /// 获取当前状态
  BridgeStatus get status => BridgeStatus(
        status: _status,
        error: _error,
      );

  /// 获取当前消息列表
  List<BridgeChatMessage> get messages => List.unmodifiable(_messages);

  /// 监听状态变更
  void onStatusChange(Function(BridgeStatus) callback) {
    _statusListeners.add(callback);
  }

  /// 监听消息
  void onMessage(Function(dynamic) callback) {
    _messageListeners.add(callback);
  }

  /// 发送用户消息
  void sendChatMessage(String content) {
    // 乐观更新：立即将用户消息添加到本地消息列表
    final userMsgId = 'msg-${DateTime.now().millisecondsSinceEpoch}';
    _messages.add(BridgeChatMessage(
      id: userMsgId,
      role: 'user',
      content: content,
    ));
    _notifyListeners({
      'type': 'bridge:chat-send',
      'content': content,
      'messageId': userMsgId,
      'threadId': _currentProjectId,
    });

    _send(BridgeChatSend(content: content));
  }

  /// 获取待确认列表
  List<BridgePendingConfirm> get pendingConfirms => List.unmodifiable(_pendingConfirms);

  /// 监听待确认列表变化
  void onConfirmChange(Function(List<BridgePendingConfirm>) callback) {
    _confirmListeners.add(callback);
  }

  /// 移除待确认监听器
  void removeConfirmListener(Function(List<BridgePendingConfirm>) callback) {
    _confirmListeners.remove(callback);
  }

  /// 发送 Agent 确认（带项目隔离验证）
  void sendAgentConfirm(String confirmId, bool approved) {
    // 查找确认项，验证项目隔离
    final confirm = _pendingConfirms.firstWhere(
      (c) => c.confirmId == confirmId,
      orElse: () => throw Exception('Confirm not found: $confirmId'),
    );
    
    // 项目隔离验证：只有当前项目的确认才能发送
    if (confirm.projectId != null && confirm.projectId != _currentProjectId) {
      print('[BridgeClient] Confirm project mismatch: ${confirm.projectId} vs $_currentProjectId');
      return; // 静默忽略，不发送非当前项目的确认
    }
    
    _send(BridgeAgentConfirm(confirmId: confirmId, approved: approved));
    // 从待确认列表中移除
    _pendingConfirms.removeWhere((c) => c.confirmId == confirmId);
    _notifyConfirmListeners();
  }

  /// 终止 Agent
  void sendAgentAbort(String requestId) {
    _send(BridgeAgentAbort(requestId: requestId));
  }

  /// 发送心跳
  void sendHeartbeat() {
    if (_channel != null) {
      _sendRaw({'type': 'heartbeat', 'timestamp': DateTime.now().millisecondsSinceEpoch});
    }
  }

  /// 请求项目列表（带内存缓存 + 本地持久化）
  Future<BridgeProjectsResponse> requestProjects({bool forceRefresh = false}) async {
    // 1. 优先返回有效缓存
    if (!forceRefresh && _cachedProjects != null && _projectsCacheTime != null) {
      final age = DateTime.now().difference(_projectsCacheTime!);
      if (age < _kProjectsCacheTtl) {
        print('[BridgeClient] requestProjects: returning cached (${_cachedProjects!.length} projects, age=${age.inMilliseconds}ms)');
        return BridgeProjectsResponse(
          projects: _cachedProjects!,
          activeThreadId: _cachedActiveThreadId,
        );
      }
    }

    // 2. 缓存过期或强制刷新，发起网络请求
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeGetProjects(requestId: requestId));

    try {
      final response = await completer.future.timeout(const Duration(seconds: 10));
      final result = BridgeProjectsResponse.fromJson(response);

      // 3. 更新内存缓存
      _cachedProjects = result.projects;
      _cachedActiveThreadId = result.activeThreadId;
      _projectsCacheTime = DateTime.now();

      // 4. 持久化到本地（异步，不阻塞返回）
      _saveProjectsToDisk(result);

      print('[BridgeClient] requestProjects: fetched from network (${result.projects.length} projects)');
      return result;
    } catch (e) {
      // 5. 网络请求失败时，降级返回本地缓存（即使已过期）
      if (_cachedProjects != null) {
        print('[BridgeClient] requestProjects: network failed, returning stale cache');
        return BridgeProjectsResponse(
          projects: _cachedProjects!,
          activeThreadId: _cachedActiveThreadId,
        );
      }
      rethrow;
    }
  }

  /// 将项目列表持久化到本地存储
  Future<void> _saveProjectsToDisk(BridgeProjectsResponse result) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final projectsJson = jsonEncode(result.projects.map((p) => p.toJson()).toList());
      await prefs.setString('bridge_projects_cache', projectsJson);
      await prefs.setString('bridge_active_thread_id', result.activeThreadId ?? '');
      await prefs.setInt('bridge_projects_cache_time', DateTime.now().millisecondsSinceEpoch);
    } catch (e) {
      print('[BridgeClient] Failed to save projects to disk: $e');
    }
  }

  /// 从本地存储加载项目列表（用于冷启动秒开）
  Future<BridgeProjectsResponse?> loadProjectsFromDisk() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final projectsJson = prefs.getString('bridge_projects_cache');
      if (projectsJson == null || projectsJson.isEmpty) return null;

      final List<dynamic> jsonList = jsonDecode(projectsJson);
      final projects = jsonList.map((j) => BridgeProjectInfo.fromJson(j as Map<String, dynamic>)).toList();
      final activeThreadId = prefs.getString('bridge_active_thread_id');

      _cachedProjects = projects;
      _cachedActiveThreadId = activeThreadId?.isNotEmpty == true ? activeThreadId : null;
      _projectsCacheTime = DateTime.fromMillisecondsSinceEpoch(
        prefs.getInt('bridge_projects_cache_time') ?? 0,
      );

      print('[BridgeClient] loadProjectsFromDisk: loaded ${projects.length} projects from disk');
      return BridgeProjectsResponse(projects: projects, activeThreadId: _cachedActiveThreadId);
    } catch (e) {
      print('[BridgeClient] Failed to load projects from disk: $e');
      return null;
    }
  }

  /// 请求工作区目录树
  Future<List<BridgeFileTreeEntry>> requestWorkspaceTree(String path) async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeGetWorkspaceTree(requestId: requestId, path: path));

    final response = await completer.future;
    final treeResponse = BridgeWorkspaceTreeResponse.fromJson(response);
    return treeResponse.tree;
  }

  /// 读取文件内容
  Future<BridgeFileContentResponse> readFile(String filePath) async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeFileRead(requestId: requestId, path: filePath));

    final response = await completer.future;
    return BridgeFileContentResponse.fromJson(response);
  }

  /// 写入文件
  Future<BridgeFileWrittenResponse> writeFile(String filePath, String content) async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeFileWrite(requestId: requestId, path: filePath, content: content));

    final response = await completer.future;
    return BridgeFileWrittenResponse.fromJson(response);
  }

  /// 切换活跃项目
  Future<BridgeProjectSwitchedResponse> switchProject(String projectId, {String? sessionId}) async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeSwitchProject(requestId: requestId, projectId: projectId, sessionId: sessionId));

    final response = await completer.future;
    return BridgeProjectSwitchedResponse.fromJson(response);
  }

  /// 连接成功后主动同步数据：项目列表、模型列表、当前项目状态、消息差异
  Future<void> _syncOnConnect() async {
    print('[BridgeClient] Starting sync on connect...');
    
    // 1. 同步项目列表
    try {
      final projectsResp = await requestProjects(forceRefresh: true);
      print('[BridgeClient] Synced ${projectsResp.projects.length} projects');
    } catch (e) {
      print('[BridgeClient] Failed to sync projects: $e');
    }
    
    // 2. 同步模型列表
    try {
      final models = await requestModels();
      print('[BridgeClient] Synced ${models.models.length} models');
    } catch (e) {
      print('[BridgeClient] Failed to sync models: $e');
    }
    
    // 3. 同步当前项目状态和消息差异
    final sessionId = _currentProjectId;
    if (sessionId == null || sessionId.isEmpty) return;
    
    // 3a. 优先从本地缓存加载消息
    final cachedMessages = await _messageCache?.loadMessages(sessionId, limit: 50) ?? [];
    if (cachedMessages.isNotEmpty) {
      print('[BridgeClient] Loaded ${cachedMessages.length} messages from local cache');
      _messages.clear();
      _messages.addAll(cachedMessages);
      _notifyListenersImmediately({'type': 'bridge:cache-loaded', 'threadId': sessionId, 'count': cachedMessages.length});
    }
    
    // 3b. 请求桌面端快照，用于增量更新
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    print('[BridgeClient] Requesting state snapshot from desktop (requestId: $requestId)');
    _send(BridgeRequestState(requestId: requestId));
    
    // 4. 启动定时任务状态轮询（每2秒）
    _startTaskStatusPolling();
  }
  
  /// 定时轮询当前项目的任务处理状态（每2秒）
  Timer? _taskStatusPollingTimer;
  static const Duration _kTaskStatusPollingInterval = Duration(seconds: 2);
  
  void _startTaskStatusPolling() {
    _taskStatusPollingTimer?.cancel();
    _taskStatusPollingTimer = Timer.periodic(_kTaskStatusPollingInterval, (_) {
      _pollTaskStatus();
    });
  }
  
  void _stopTaskStatusPolling() {
    _taskStatusPollingTimer?.cancel();
    _taskStatusPollingTimer = null;
  }
  
  /// 轮询当前项目的任务处理状态
  Future<void> _pollTaskStatus() async {
    final projectId = _currentProjectId;
    if (projectId == null || projectId.isEmpty) return;
    
    final requestId = 'req-poll-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;
    
    _sendRaw({
      'type': 'bridge:poll-task-status',
      'requestId': requestId,
      'projectId': projectId,
    });
    
    try {
      final response = await completer.future.timeout(const Duration(seconds: 5));
      final isProcessing = response['isProcessing'] as bool? ?? false;
      final activeTaskId = response['activeTaskId'] as String?;
      
      // 更新项目活跃任务状态
      if (isProcessing && activeTaskId != null && activeTaskId.isNotEmpty) {
        _projectActiveTasks[projectId] = activeTaskId;
        if (projectId == _currentProjectId) {
          _activeAgentRequestId = activeTaskId;
        }
        _projectTaskTimeouts[projectId] = DateTime.now().add(_kTaskTimeout);
        _startTimeoutChecker();
      } else {
        _projectActiveTasks.remove(projectId);
        if (projectId == _currentProjectId) {
          _activeAgentRequestId = null;
          _activeOriginalRequestId = null;
        }
        _projectTaskTimeouts.remove(projectId);
      }
      
      // 通知 UI 更新
      _notifyListenersImmediately({
        'type': 'bridge:task-status-polled',
        'projectId': projectId,
        'isProcessing': isProcessing,
        'activeTaskId': activeTaskId,
      });
    } catch (e) {
      // 轮询超时或失败，静默忽略
      print('[BridgeClient] Task status polling failed: $e');
    }
  }

  /// 主动请求当前状态快照（连接/重连后使用）
  /// 优先从本地缓存加载，缓存未命中时再请求桌面端
  Future<void> _requestState() async {
    final sessionId = _currentProjectId;
    if (sessionId == null || sessionId.isEmpty) return;

    // 1. 优先从本地缓存加载消息
    final cachedMessages = await _messageCache?.loadMessages(sessionId, limit: 50) ?? [];
    if (cachedMessages.isNotEmpty) {
      print('[BridgeClient] Loaded ${cachedMessages.length} messages from local cache');
      _messages.clear();
      _messages.addAll(cachedMessages);
      _notifyListenersImmediately({'type': 'bridge:cache-loaded', 'threadId': sessionId, 'count': cachedMessages.length});
    }

    // 2. 再请求桌面端快照（用于增量更新）
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    print('[BridgeClient] Requesting state snapshot from desktop (requestId: $requestId)');
    _send(BridgeRequestState(requestId: requestId));
  }

  /// 请求可用模型列表
  Future<BridgeModelsList> requestModels() async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _sendRaw({
      'type': 'bridge:get-models',
      'requestId': requestId,
    });

    final response = await completer.future;
    return BridgeModelsList.fromJson(response);
  }

  /// 切换模型
  Future<BridgeModelSwitchedResponse> switchModel(String modelConfigId) async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _sendRaw({
      'type': 'bridge:switch-model',
      'requestId': requestId,
      'modelConfigId': modelConfigId,
    });

    final response = await completer.future;
    return BridgeModelSwitchedResponse.fromJson(response);
  }

  /// 请求更早的消息（分页加载）
  Future<BridgeOlderMessagesResponse> requestOlderMessages({required int beforeSeq, int limit = 50}) async {
    final sessionId = _currentProjectId ?? '';
    if (sessionId.isEmpty) {
      return BridgeOlderMessagesResponse(requestId: '', messages: [], totalCount: 0);
    }
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeLoadOlderMessages(
      requestId: requestId,
      sessionId: sessionId,
      beforeSeq: beforeSeq,
      limit: limit,
    ));

    final response = await completer.future;
    return BridgeOlderMessagesResponse.fromJson(response);
  }

  /// 获取当前活跃的 Agent 请求 ID（用于判断是否有任务在执行）
  String? get activeAgentRequestId => _activeAgentRequestId;

  /// 获取当前活跃的原始请求 ID（用于 abort，对应桌面端 agentAbortControllers 的 key）
  String? get activeOriginalRequestId => _activeOriginalRequestId;

  /// 获取指定项目的活跃任务 ID
  String? getActiveTaskForProject(String projectId) {
    return _projectActiveTasks[projectId];
  }

  /// 设置当前项目 ID
  void setCurrentProject(String? projectId) {
    // 切换项目时，清空旧项目的残留状态
    final oldProjectId = _currentProjectId;
    if (oldProjectId != null && oldProjectId != projectId) {
      // 清理旧项目的活跃任务
      _projectActiveTasks.remove(oldProjectId);
      // 清理待确认列表（属于旧项目的确认）
      _pendingConfirms.clear();
      _notifyConfirmListeners();
      // 清空消息列表，避免显示旧项目数据
      _messages.clear();
      _notifyListenersImmediately({'type': 'bridge:project-cleared', 'threadId': projectId});
    }

    _currentProjectId = projectId;
    // 切换项目时，更新活跃任务状态
    _activeAgentRequestId = _projectActiveTasks[projectId];
    _activeOriginalRequestId = null;

    // 切换项目时，优先从本地缓存加载新项目的消息
    if (projectId != null && projectId.isNotEmpty) {
      _loadMessagesFromCache(projectId);
    }
  }

  /// 从本地缓存加载消息（异步，不阻塞 UI）
  Future<void> _loadMessagesFromCache(String sessionId) async {
    try {
      final cachedMessages = await _messageCache?.loadMessages(sessionId, limit: 50) ?? [];
      if (cachedMessages.isNotEmpty) {
        print('[BridgeClient] Loaded ${cachedMessages.length} messages from local cache for project $sessionId');
        _messages.clear();
        _messages.addAll(cachedMessages);
        _notifyListenersImmediately({'type': 'bridge:cache-loaded', 'threadId': sessionId, 'count': cachedMessages.length});
      }
    } catch (e) {
      print('[BridgeClient] Failed to load messages from cache: $e');
    }
  }

  /// 清空消息列表（用于切换项目时立即清空 UI）
  void clearMessages() {
    _messages.clear();
    _notifyListenersImmediately({'type': 'bridge:messages-cleared'});
  }

  /// 立即通知（不节流），用于切换项目等需要即时反馈的场景
  void _notifyListenersImmediately(dynamic data) {
    // 创建副本避免并发修改错误
    final listeners = List.from(_messageListeners);
    for (final cb in listeners) {
      try {
        cb(data);
      } catch (e) {
        print('[BridgeClient] Message callback error: $e');
      }
    }
  }

  /// 发送原始消息（用于请求/响应模式）
  void _sendRequest(Map<String, dynamic> data) {
    _sendRaw(data);
  }

  /* ------------------------------------------------------------------ */
  /*  Private: connection                                                */
  /* ------------------------------------------------------------------ */

  Future<void> _connect() async {
    if (_token == null || _token!.isEmpty) {
      _error = '缺少 token';
      _setStatus(BridgeConnectionStatus.disconnected);
      return;
    }

    // 解析 relayUrl：优先使用传入的，其次读取缓存，最后用默认值
    if (_relayUrlOverride != null && _relayUrlOverride!.isNotEmpty) {
      _resolvedRelayUrl = _relayUrlOverride;
    } else {
      try {
        final prefs = await SharedPreferences.getInstance();
        _resolvedRelayUrl = prefs.getString(_kCachedRelayUrlKey);
      } catch (_) {
        _resolvedRelayUrl = null;
      }
      if (_resolvedRelayUrl == null || _resolvedRelayUrl!.isEmpty) {
        _resolvedRelayUrl = defaultRelayUrl;
      }
    }

    _setStatus(BridgeConnectionStatus.connecting);

    // 解析 relayUrl 并构建正确的 WebSocket URI
    final baseUri = Uri.parse(_resolvedRelayUrl!);

    // 将 http/https 转换为 ws/wss
    String scheme = baseUri.scheme;
    if (scheme == 'http') scheme = 'ws';
    if (scheme == 'https') scheme = 'wss';

    // 只保留非标准端口（跳过 0、80/ws、443/wss）
    String portPart = '';
    if (baseUri.hasPort && baseUri.port > 0) {
      final isStandardPort = (scheme == 'ws' && baseUri.port == 80) ||
                             (scheme == 'wss' && baseUri.port == 443);
      if (!isStandardPort) {
        portPart = ':${baseUri.port}';
      }
    }

    // 确保有路径
    String path = baseUri.path;
    if (path.isEmpty) path = '/ws';

    final uriString = '$scheme://${baseUri.host}$portPart$path?token=${Uri.encodeQueryComponent(_token!)}&role=client';
    final uri = Uri.parse(uriString);

    try {
      _channel = WebSocketChannel.connect(uri);
      _channel!.stream.listen(
        _onMessage,
        onError: _onError,
        onDone: _onDone,
        cancelOnError: false,
      );
    } catch (e) {
      _error = '连接失败: $e';
      _setStatus(BridgeConnectionStatus.disconnected);
      _attemptReconnect();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: message handling                                          */
  /* ------------------------------------------------------------------ */

  void _onMessage(dynamic data) {
    try {
      final json = jsonDecode(data as String) as Map<String, dynamic>;
      final type = json['type'] as String?;

      // ACK 管理器处理（去重、发送ACK）
      _ackManager?.handleMessage(json);

      switch (type) {
        case 'connected':
          _reconnectAttempts = 0;
          _setStatus(BridgeConnectionStatus.connected);
          _startHeartbeat();
          // 启动 Token 自动刷新定时器
          _startTokenRefreshTimer();
          // 保存连接信息到缓存
          if (_token != null) {
            _saveConnectionInfo(_token!);
          }
          // 初始化 ACK 管理器
          if (_ackManager == null && _channel != null) {
            _ackManager = BridgeAckManager(_channel!.sink);
          }
          // 连接成功后主动同步数据（延迟 500ms 确保连接稳定）
          Future.delayed(const Duration(milliseconds: 500), () {
            _syncOnConnect();
          });
          break;

        case 'host_connected':
          // Host 上线通知（来自 pending→reconnect 流程）
          // 重置重连计数，同步最新数据
          _reconnectAttempts = 0;
          print('[BridgeClient] Host is now online, syncing data...');
          // Host 上线后主动同步数据（延迟 500ms 确保连接稳定）
          Future.delayed(const Duration(milliseconds: 500), () {
            _syncOnConnect();
          });
          break;

        case 'error':
          _error = json['message'] as String?;
          _setStatus(BridgeConnectionStatus.disconnected);
          break;

        case 'host_disconnected':
          _error = 'Host 已断开连接';
          _setStatus(BridgeConnectionStatus.disconnected);
          break;

        case 'ping':
          _lastHeartbeatReceived = DateTime.now();
          break;

        case 'bridge:state':
          _messageQueue.enqueue(
            type: BridgeMessageType.chat,
            data: json,
            handler: () {
              final state = BridgeState.fromJson(json);
              // 增量更新消息列表，避免全量替换导致的 UI 闪烁
              _mergeMessages(state.messages);
              // 关键修复：bridge:state 不再更新 _currentProjectId
              // _currentProjectId 只由 setCurrentProject() 设置（用户主动切换）
              // bridge:state 只更新 _activeAgentRequestId（用于 abort 等全局状态）
              if (state.activeAgentRequestId != null && state.activeAgentRequestId!.isNotEmpty) {
                _activeAgentRequestId = state.activeAgentRequestId;
              } else {
                _activeAgentRequestId = null;
              }
              // 保存快照到本地缓存
              if (_currentProjectId != null && _messages.isNotEmpty) {
                _messageCache?.saveMessages(_currentProjectId!, _messages);
              }
              _notifyListeners(json);
            },
          );
          // 同时完成 pending request（如果是请求-响应模式）
          {
            final rid = json['requestId'] as String?;
            if (rid != null) {
              final completer = _pendingRequests.remove(rid);
              if (completer != null && !completer.isCompleted) {
                completer.complete(json);
              }
            }
          }
          break;

        case 'bridge:chat-delta':
          _messageQueue.enqueue(
            type: BridgeMessageType.chat,
            data: json,
            handler: () {
              final delta = BridgeChatDelta.fromJson(json);
              _applyDelta(delta);
              _notifyListeners(json);
            },
          );
          break;

        case 'bridge:chat-user-message':
          _messageQueue.enqueue(
            type: BridgeMessageType.chat,
            data: json,
            handler: () {
              _applyUserMessage(json);
              _notifyListeners(json);
            },
          );
          break;

        case 'bridge:agent-event':
          {
            _messageQueue.enqueue(
              type: BridgeMessageType.agent,
              data: json,
              handler: () {
                final agentEvent = BridgeAgentEvent.fromJson(json);
                _applyAgentEvent(agentEvent);
                // Agent 事件立即通知（不节流），保证思考过程和工具调用的实时性
                _notifyAgentListeners(json);
              },
            );
          }
          break;

        case 'bridge:agent-confirm-resolved':
          {
            _messageQueue.enqueue(
              type: BridgeMessageType.confirm,
              data: json,
              handler: () {
                // 桌面端已处理确认，通知移动端清除对应的待确认弹窗
                final resolved = BridgeAgentConfirmResolved.fromJson(json);
                final beforeCount = _pendingConfirms.length;
                _pendingConfirms.removeWhere((c) => c.confirmId == resolved.confirmId);
                if (_pendingConfirms.length < beforeCount) {
                  _notifyConfirmListeners();
                  // 同时更新消息中对应 step 的确认状态
                  _updateStepConfirmStatus(resolved.confirmId, resolved.approved);
                }
              },
            );
          }
          break;

        case 'bridge:files-changed':
          _messageQueue.enqueue(
            type: BridgeMessageType.files,
            data: json,
            handler: () {
              _notifyListeners(json);
            },
          );
          break;

        // 项目状态推送（桌面端主动推送，无需请求）
        case 'bridge:project-states':
          {
            _messageQueue.enqueue(
              type: BridgeMessageType.project,
              data: json,
              handler: () {
                try {
                  final statesJson = json['states'] as List<dynamic>?;
                  // 提取活跃项目 ID（桌面端切换项目时实时推送）
                  final newActiveThreadId = json['activeThreadId'] as String?;
                  if (newActiveThreadId != null && newActiveThreadId.isNotEmpty) {
                    _cachedActiveThreadId = newActiveThreadId;
                    // 关键修复: 不再覆盖 _currentProjectId
                    // _currentProjectId 只由 setCurrentProject() 设置（用户主动切换）
                    // 异步持久化到本地（不阻塞）
                    SharedPreferences.getInstance().then((prefs) {
                      prefs.setString('bridge_active_thread_id', newActiveThreadId);
                    });
                  }
                  if (statesJson != null) {
                    // 按照桌面端推送的顺序更新项目列表
                    if (_cachedProjects != null) {
                      // 创建新的项目列表，按照桌面端推送的顺序排列
                      final List<BridgeProjectInfo> reorderedProjects = [];
                      for (final stateJson in statesJson) {
                        final state = stateJson as Map<String, dynamic>;
                        final projectId = state['id'] as String?;
                        if (projectId != null) {
                          // 查找现有项目
                          final existingProject = _cachedProjects!.firstWhere(
                            (p) => p.id == projectId,
                            orElse: () => BridgeProjectInfo(
                              id: projectId,
                              title: state['title'] as String? ?? '',
                              workspace: state['workspace'] as String?,
                              sessions: [],
                            ),
                          );
                          reorderedProjects.add(existingProject);
                          
                          // 更新活跃任务状态
                          final isProcessing = state['isProcessing'] as bool? ?? false;
                          final activeTaskId = state['activeTaskId'] as String?;
                          if (isProcessing && activeTaskId != null && activeTaskId.isNotEmpty) {
                            _projectActiveTasks[projectId] = activeTaskId;
                          } else {
                            _projectActiveTasks.remove(projectId);
                          }
                        }
                      }
                      // 更新缓存中的项目列表（保持桌面端推送的顺序）
                      _cachedProjects = reorderedProjects;
                      _projectsCacheTime = DateTime.now();
                    }
                    print('[BridgeClient] Received project-states push (${statesJson?.length ?? 0} states, activeThread: $newActiveThreadId)');
                  }
                  
                  // 关键修复：同步当前项目的活跃任务状态
                  // 确保 _activeAgentRequestId 与桌面端的 activeTaskId 保持一致
                  if (_currentProjectId != null) {
                    final activeTaskId = _projectActiveTasks[_currentProjectId];
                    if (activeTaskId != null && activeTaskId.isNotEmpty) {
                      _activeAgentRequestId = activeTaskId;
                      // 设置超时保护
                      _projectTaskTimeouts[_currentProjectId!] = DateTime.now().add(_kTaskTimeout);
                      _startTimeoutChecker();
                    } else {
                      // 清除当前项目的活跃任务
                      _activeAgentRequestId = null;
                      _projectTaskTimeouts.remove(_currentProjectId);
                    }
                  }
                  
                  // 通知 UI 项目状态已更新（包括活跃项目变更）
                  _notifyListeners(json);
                } catch (e) {
                  print('[BridgeClient] Failed to handle project-states push: $e');
                }
              },
            );
          }
          break;

        // 数据查询响应
        case 'bridge:projects':
          {
            final rid = json['requestId'] as String?;
            // 更新内存缓存（后台推送的项目列表变更）
            try {
              final projectsJson = json['projects'] as List<dynamic>?;
              if (projectsJson != null) {
                _cachedProjects = projectsJson
                    .map((j) => BridgeProjectInfo.fromJson(j as Map<String, dynamic>))
                    .toList();
                _cachedActiveThreadId = json['activeThreadId'] as String?;
                _projectsCacheTime = DateTime.now();
              }
            } catch (e) {
              print('[BridgeClient] Failed to cache projects from push: $e');
            }
            if (rid != null) {
              final completer = _pendingRequests.remove(rid);
              if (completer != null && !completer.isCompleted) {
                completer.complete(json);
              }
            }
          }
          break;

        case 'bridge:task-status':
          {
            final rid = json['requestId'] as String?;
            if (rid != null) {
              final completer = _pendingRequests.remove(rid);
              if (completer != null && !completer.isCompleted) {
                completer.complete(json);
              }
            }
          }
          break;

        case 'bridge:workspace-tree':
        case 'bridge:file-content':
        case 'bridge:file-written':
        case 'bridge:model-switched':
        case 'bridge:models':
        case 'bridge:older-messages':
          {
            final rid = json['requestId'] as String?;
            if (rid != null) {
              final completer = _pendingRequests.remove(rid);
              if (completer != null && !completer.isCompleted) {
                completer.complete(json);
              }
            }
          }
          break;

        case 'bridge:project-switched':
          {
            final rid = json['requestId'] as String?;
            if (rid != null) {
              final completer = _pendingRequests.remove(rid);
              if (completer != null && !completer.isCompleted) {
                completer.complete(json);
              }
            }
            // 关键修复：通知 UI 层切换项目完成，清除 _isSwitchingProject
            _notifyListeners(json);
          }
          break;

        default:
          _notifyListeners(json);
          break;
      }
    } catch (e) {
      print('[BridgeClient] Failed to parse message: $e');
    }
  }

  void _applyUserMessage(Map<String, dynamic> json) {
    try {
      final messageId = json['messageId'] as String?;
      final content = json['content'] as String?;
      final threadId = json['threadId'] as String?;
      final imagesJson = json['images'] as List<dynamic>?;
      
      if (messageId == null || content == null) return;
      
      // 只处理当前项目的用户消息
      final projectId = (threadId != null && threadId.isNotEmpty) ? threadId : (_currentProjectId ?? '');
      if (projectId != _currentProjectId) return;
      
      // 检查消息是否已存在
      final existingIdx = _messages.indexWhere((m) => m.id == messageId);
      if (existingIdx >= 0) return; // 已存在则跳过
      
      // 解析图片数组（与桌面端 AttachedImage 一致）
      List<BridgeAttachedImage>? images;
      if (imagesJson != null && imagesJson.isNotEmpty) {
        images = imagesJson
            .map((img) => BridgeAttachedImage.fromJson(img as Map<String, dynamic>))
            .toList();
      }
      
      // 添加用户消息到消息列表（保存完整的图片数据）
      _messages.add(BridgeChatMessage(
        id: messageId,
        role: 'user',
        content: content,
        images: images,
      ));
    } catch (e) {
      print('[BridgeClient] Failed to apply user message: $e');
    }
  }

  /// 判断消息是否正在处理中（根据 activePlan 和 agentSteps 状态）
  bool _isMessageProcessing(BridgeChatMessage msg) {
    // 如果有 taskTiming 且已结束，说明任务已完成
    if (msg.taskTiming != null && msg.taskTiming!.endedAt != null) {
      return false;
    }

    // 如果有 activePlan，说明正在执行
    if (msg.activePlan != null) return true;

    // 如果 agentSteps 中有 running/calling/confirm 状态的步骤，说明正在执行
    if (msg.agentSteps != null && msg.agentSteps!.isNotEmpty) {
      for (final step in msg.agentSteps!) {
        if (step.status == 'calling' || step.status == 'running' || step.status == 'confirm') {
          return true;
        }
      }
    }

    return false;
  }

  void _applyDelta(BridgeChatDelta delta) {
    // 使用 threadId 作为项目唯一标识
    final projectId = (delta.threadId != null && delta.threadId!.isNotEmpty)
        ? delta.threadId!
        : (_currentProjectId ?? '');

    // 关键修复：只处理当前项目的 delta，避免其他项目的流式输出污染当前消息列表
    if (projectId != _currentProjectId) {
      return;
    }

    // 竞态保护：如果收到 done=true 但本地该消息已完成，说明已被快照同步，跳过
    final existingIdx = _messages.indexWhere((m) => m.id == delta.messageId);
    if (delta.done && existingIdx >= 0 && !_isMessageProcessing(_messages[existingIdx])) {
      return; // 已完成的消息不再重复处理
    }

    if (!delta.done) {
      // 聊天流开始/进行中：标记项目为处理中
      // 关键修复：_projectActiveTasks 只由 bridge:project-states 更新（权威来源）
      // delta 只更新 _activeAgentRequestId（用于 abort）
      if (delta.messageId != null) {
        _activeAgentRequestId = delta.messageId;
        // 设置超时保护：防止任务状态永久残留
        _projectTaskTimeouts[projectId] = DateTime.now().add(_kTaskTimeout);
        _startTimeoutChecker();
      }
    } else {
      // 聊天流完成：清理项目处理中状态
      // 关键修复：_projectActiveTasks 只由 bridge:project-states 清理
      // delta 只清理 _activeAgentRequestId
      if (projectId == _currentProjectId) {
        _activeAgentRequestId = null;
      }
      // 清除超时记录
      _projectTaskTimeouts.remove(projectId);
    }

    if (existingIdx >= 0) {
      final old = _messages[existingIdx];
      // 关键修复：done=true 时必须更新，不能跳过！
      // 只有当 delta 为空且不是完成信号时才跳过
      if (delta.delta.isEmpty && !delta.done) {
        return;
      }
      BridgeTaskTiming? timing = old.taskTiming;
      if (delta.done && timing == null) {
        final now = DateTime.now().millisecondsSinceEpoch;
        timing = BridgeTaskTiming(startedAt: now, endedAt: now, durationMs: 0);
      }
      // 原地更新：使用可变字段减少对象重建
      _messages[existingIdx] = old.copyWith(
        content: old.content + delta.delta,
        taskTiming: timing,
      );
    } else {
      // 只有当 delta 有内容时才创建新消息，避免创建空的 AI 消息气泡
      if (delta.delta.isEmpty && delta.done) {
        // 如果是完成信号但没有内容，直接返回
        return;
      }
      
      BridgeTaskTiming? timing;
      if (delta.done) {
        final now = DateTime.now().millisecondsSinceEpoch;
        timing = BridgeTaskTiming(startedAt: now, endedAt: now, durationMs: 0);
      }
      _messages.add(BridgeChatMessage(
        id: delta.messageId,
        role: 'assistant',
        content: delta.delta,
        taskTiming: timing,
      ));
    }
  }

  /// 合并消息列表（用于 bridge:state 全量快照）
  /// 简化策略：快照只用于初始化，不用于更新。本地缓存优先，快照补充缺失的消息。
  void _mergeMessages(List<BridgeChatMessage> incoming) {
    if (incoming.isEmpty) return;

    final sessionId = _currentProjectId;
    if (sessionId == null || sessionId.isEmpty) return;

    // 构建现有消息的 ID 索引
    final existingIds = <String>{};
    for (final msg in _messages) {
      existingIds.add(msg.id);
    }

    for (final msg in incoming) {
      if (!existingIds.contains(msg.id) && (msg.content.isNotEmpty || msg.role == 'user')) {
        // 本地缓存没有的消息，追加
        _messages.add(msg);
      } else if (existingIds.contains(msg.id)) {
        // 消息已存在，检查是否需要更新
        final existingIdx = _messages.indexWhere((m) => m.id == msg.id);
        if (existingIdx >= 0) {
          final existing = _messages[existingIdx];
          // 关键修复：如果本地消息正在处理中，保护本地内容不被快照覆盖
          // 快照可能不包含最新的流式输出
          if (_isMessageProcessing(existing)) {
            // 只更新 agentSteps 和 activePlan（如果快照有更新）
            // 但不覆盖 content
            if (msg.agentSteps != null && msg.agentSteps!.isNotEmpty) {
              _messages[existingIdx] = existing.copyWith(
                agentSteps: msg.agentSteps,
                activePlan: msg.activePlan ?? existing.activePlan,
                taskTiming: msg.taskTiming ?? existing.taskTiming,
              );
            }
            continue;
          }
          // 非处理中的消息：如果快照内容更长或 agentSteps 有更新，则更新
          if (msg.content.length > existing.content.length ||
              (msg.agentSteps != null && msg.agentSteps!.isNotEmpty && existing.agentSteps != msg.agentSteps)) {
            _messages[existingIdx] = msg;
          }
        }
      }
    }

    // 保存到本地缓存
    _messageCache?.saveMessages(sessionId, _messages);
  }

  /// 更新消息中对应 step 的确认状态（桌面端确认/拒绝后同步到移动端 UI）
  void _updateStepConfirmStatus(String confirmId, bool approved) {
    for (int i = 0; i < _messages.length; i++) {
      final msg = _messages[i];
      if (msg.agentSteps == null || msg.agentSteps!.isEmpty) continue;
      bool updated = false;
      final updatedSteps = <BridgeAgentStep>[];
      for (final step in msg.agentSteps!) {
        if (step.confirmId == confirmId && step.status == 'confirm') {
          updated = true;
          updatedSteps.add(BridgeAgentStep(
            round: step.round,
            systemTitle: step.systemTitle,
            systemDetail: step.systemDetail,
            thinking: step.thinking,
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
            status: approved ? 'done' : 'done',
            risks: step.risks,
            confirmId: step.confirmId,
          ));
        } else {
          updatedSteps.add(step);
        }
      }
      if (updated) {
        _messages[i] = msg.copyWith(agentSteps: updatedSteps);
      }
    }
  }

  void _applyAgentEvent(BridgeAgentEvent agentEvent) {
    final requestId = agentEvent.requestId;
    final event = agentEvent.event;
    final eventType = event['type'] as String?;

    // 使用 threadId 作为项目唯一标识（优先），其次使用 _currentProjectId
    final projectId = (agentEvent.threadId != null && agentEvent.threadId!.isNotEmpty)
        ? agentEvent.threadId!
        : _currentProjectId;

    // 更新指定项目的活跃任务状态，实现真正的项目隔离
    // 关键修复：_projectActiveTasks 只由 bridge:project-states 更新（权威来源）
    // agent-event 只更新 _activeAgentRequestId（用于 abort）
    if (projectId != null) {
      if (eventType == 'tool_calls' || eventType == 'thinking' || eventType == 'reasoning' || eventType == 'text') {
        // 只有当前项目的事件才更新全局 activeAgentRequestId
        if (projectId == _currentProjectId) {
          _activeAgentRequestId = requestId;
          // 保存 originalRequestId 用于 abort（桌面端 agentAbortControllers 的 key）
          _activeOriginalRequestId = agentEvent.originalRequestId ?? requestId;
        }
        // 设置超时保护：防止任务状态永久残留
        _projectTaskTimeouts[projectId] = DateTime.now().add(_kTaskTimeout);
        _startTimeoutChecker();
      } else if (eventType == 'done' || eventType == 'error') {
        if (projectId == _currentProjectId) {
          // 关键修复：无论 _activeAgentRequestId 是否等于 requestId，都清除活跃任务状态
          // 因为 _activeAgentRequestId 可能来自 bridge:state（格式为 agent-{sessionId}），
          // 而 requestId 来自 bridge:agent-event（格式为 req-{timestamp}-{threadId}），
          // 两者格式不同但代表同一任务
          _activeAgentRequestId = null;
          _activeOriginalRequestId = null;
        }
        // 清除超时记录
        _projectTaskTimeouts.remove(projectId);
      }
    }

    // 项目隔离：只处理当前项目的事件内容，其他项目的事件仅更新 _projectActiveTasks（供侧边栏显示）
    if (projectId != null && projectId != _currentProjectId) {
      return;
    }

    // 竞态保护：如果消息已完成且事件是 done/error，跳过
    final existingIdx = _messages.indexWhere((m) => m.id == requestId);
    if ((eventType == 'done' || eventType == 'error') && existingIdx >= 0 && !_isMessageProcessing(_messages[existingIdx])) {
      return; // 已完成的消息不再重复处理
    }

    // 找到对应的消息
    int idx = existingIdx;
    if (idx < 0) {
      // 如果找不到对应消息，创建一个
      _messages.add(BridgeChatMessage(
        id: requestId,
        role: 'assistant',
        content: '',
        agentSteps: [],
      ));
      idx = _messages.length - 1;
    }

    final old = _messages[idx];
    final steps = old.agentSteps != null ? List<BridgeAgentStep>.from(old.agentSteps!) : <BridgeAgentStep>[];

    switch (eventType) {
      case 'text':
        // 流式文本：追加到消息正文（Agent 模式下的实时文本输出）
        final content = event['content'] as String? ?? '';
        if (content.isNotEmpty) {
          _messages[idx] = old.copyWith(
            content: old.content + content,
          );
          return;
        }
        break;

      case 'reasoning':
      case 'thinking':
        // 思考过程：追加到最后一个 step 或创建新 step
        final content = event['content'] as String? ?? '';
        if (steps.isEmpty || steps.last.status == 'done') {
          steps.add(BridgeAgentStep(
            round: steps.length + 1,
            thinking: content,
            status: 'running',
          ));
        } else {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: last.systemTitle,
            systemDetail: last.systemDetail,
            thinking: last.thinking + content,
            toolCalls: last.toolCalls,
            toolResults: last.toolResults,
            status: last.status,
            risks: last.risks,
            confirmId: last.confirmId,
          );
        }
        break;

      case 'tool_calls':
        // 工具调用
        final toolCallsJson = event['toolCalls'] as List<dynamic>? ?? [];
        final thinking = event['thinking'] as String? ?? '';
        final toolCalls = toolCallsJson
            .map((t) => BridgeToolCallInfo.fromJson(t as Map<String, dynamic>))
            .toList();

        if (steps.isEmpty || steps.last.status == 'done') {
          steps.add(BridgeAgentStep(
            round: steps.length + 1,
            thinking: thinking,
            toolCalls: toolCalls,
            status: 'calling',
          ));
        } else {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: last.systemTitle,
            systemDetail: last.systemDetail,
            thinking: thinking.isNotEmpty ? thinking : last.thinking,
            toolCalls: toolCalls.isNotEmpty ? toolCalls : last.toolCalls,
            toolResults: last.toolResults,
            status: 'calling',
            risks: last.risks,
            confirmId: last.confirmId,
          );
        }
        break;

      case 'confirm':
        // 需要用户确认
        final confirmId = event['confirmId'] as String? ?? '';
        final toolCallsJson = event['toolCalls'] as List<dynamic>? ?? [];
        final risksJson = event['risks'] as List<dynamic>? ?? [];
        final toolCalls = toolCallsJson
            .map((t) => BridgeToolCallInfo.fromJson(t as Map<String, dynamic>))
            .toList();
        final risks = risksJson
            .map((r) => BridgeRiskInfo.fromJson(r as Map<String, dynamic>))
            .toList();

        // 添加到待确认列表（带项目隔离）
        final isPlanConfirm = risks.any((r) => r.toolName == 'propose_plan');
        String summary = '';
        if (isPlanConfirm && risks.isNotEmpty) {
          summary = risks[0].detail; // 计划详情作为摘要
        } else {
          summary = toolCalls.map((t) => t.name).join(', ');
        }
        _pendingConfirms.add(BridgePendingConfirm(
          confirmId: confirmId,
          projectId: projectId,  // 新增：记录项目 ID
          isPlanConfirm: isPlanConfirm,
          summary: summary,
          risks: risks,
          toolCalls: toolCalls,
          thinking: steps.isNotEmpty ? steps.last.thinking : '',
        ));
        _notifyConfirmListeners();

        if (steps.isNotEmpty) {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: last.systemTitle,
            systemDetail: last.systemDetail,
            thinking: last.thinking,
            toolCalls: toolCalls.isNotEmpty ? toolCalls : last.toolCalls,
            toolResults: last.toolResults,
            status: 'confirm',
            risks: risks,
            confirmId: confirmId,
          );
        }
        break;

      case 'tool_results':
        // 工具执行结果
        final resultsJson = event['results'] as List<dynamic>? ?? [];
        final results = resultsJson
            .map((r) => BridgeToolResultInfo.fromJson(r as Map<String, dynamic>))
            .toList();

        if (steps.isNotEmpty) {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: last.systemTitle,
            systemDetail: last.systemDetail,
            thinking: last.thinking,
            toolCalls: last.toolCalls,
            toolResults: results.isNotEmpty ? results : last.toolResults,
            status: 'done',
            risks: last.risks,
            confirmId: last.confirmId,
          );
        }
        break;

      case 'system_notice':
        // 系统通知
        final title = event['title'] as String? ?? '';
        final message = event['message'] as String? ?? '';
        if (steps.isEmpty || steps.last.status == 'done') {
          steps.add(BridgeAgentStep(
            round: steps.length + 1,
            systemTitle: title,
            systemDetail: message,
            status: 'done',
          ));
        } else {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: title.isNotEmpty ? title : last.systemTitle,
            systemDetail: message.isNotEmpty ? message : last.systemDetail,
            thinking: last.thinking,
            toolCalls: last.toolCalls,
            toolResults: last.toolResults,
            status: last.status,
            risks: last.risks,
            confirmId: last.confirmId,
          );
        }
        break;

      case 'plan_init':
        // 计划初始化
        final summary = event['summary'] as String? ?? '';
        final reasoning = event['reasoning'] as String?;
        final stepsList = event['steps'] as List<dynamic>? ?? [];
        final planSteps = stepsList
            .map((s) => BridgePlanStepInfo(
                  text: s as String,
                  status: 'pending',
                ))
            .toList();
        final activePlan = BridgeActivePlan(
          summary: summary,
          reasoning: reasoning,
          steps: planSteps,
          startedAt: DateTime.now().millisecondsSinceEpoch,
        );
        _messages[idx] = BridgeChatMessage(
          id: old.id,
          role: old.role,
          content: old.content,
          images: old.images,
          attachments: old.attachments,
          agentSteps: steps,
          activePlan: activePlan,
          taskTiming: old.taskTiming,
        );
        return;

      case 'plan_progress':
        // 计划进度
        final stepIndex = event['stepIndex'] as int? ?? 0;
        final status = event['status'] as String? ?? 'pending';
        final note = event['note'] as String?;
        if (old.activePlan != null) {
          final plan = old.activePlan!;
          final updatedSteps = List<BridgePlanStepInfo>.from(plan.steps);
          if (stepIndex < updatedSteps.length) {
            updatedSteps[stepIndex] = BridgePlanStepInfo(
              text: updatedSteps[stepIndex].text,
              status: status,
              note: note ?? updatedSteps[stepIndex].note,
            );
          }
          _messages[idx] = BridgeChatMessage(
            id: old.id,
            role: old.role,
            content: old.content,
            images: old.images,
            attachments: old.attachments,
            agentSteps: steps,
            activePlan: BridgeActivePlan(
              summary: plan.summary,
              reasoning: plan.reasoning,
              steps: updatedSteps,
              startedAt: plan.startedAt,
              endedAt: plan.endedAt,
            ),
            taskTiming: old.taskTiming,
          );
          return;
        }
        break;

      case 'usage':
        // Token 使用统计
        final usageJson = event['usage'] as Map<String, dynamic>?;
        if (usageJson != null) {
          final tokenUsage = BridgeTokenUsage.fromJson(usageJson);
          _messages[idx] = BridgeChatMessage(
            id: old.id,
            role: old.role,
            content: old.content,
            images: old.images,
            attachments: old.attachments,
            agentSteps: steps,
            activePlan: old.activePlan,
            taskTiming: old.taskTiming,
          );
          // 注意：tokenUsage 不在消息中，而是在 BridgeState 中
        }
        break;

      case 'done':
        // 完成
        if (steps.isNotEmpty) {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: last.systemTitle,
            systemDetail: last.systemDetail,
            thinking: last.thinking,
            toolCalls: last.toolCalls,
            toolResults: last.toolResults,
            status: 'done',
            risks: last.risks,
            confirmId: last.confirmId,
          );
        }
        // 记录 taskTiming（如果尚未记录）
        BridgeTaskTiming? timing = old.taskTiming;
        if (timing == null) {
          final now = DateTime.now().millisecondsSinceEpoch;
          timing = BridgeTaskTiming(startedAt: now, endedAt: now, durationMs: 0);
        }
        _messages[idx] = BridgeChatMessage(
          id: old.id,
          role: old.role,
          content: old.content,
          images: old.images,
          attachments: old.attachments,
          agentSteps: steps,
          activePlan: null,  // 任务完成，清除 activePlan
          taskTiming: timing,
        );
        return;

      case 'error':
        // 错误
        final message = event['message'] as String? ?? '';
        if (steps.isNotEmpty) {
          final last = steps.last;
          steps[steps.length - 1] = BridgeAgentStep(
            round: last.round,
            systemTitle: 'Error',
            systemDetail: message,
            thinking: last.thinking,
            toolCalls: last.toolCalls,
            toolResults: last.toolResults,
            status: 'done',
            risks: last.risks,
            confirmId: last.confirmId,
          );
        }
        _messages[idx] = BridgeChatMessage(
          id: old.id,
          role: old.role,
          content: old.content,
          images: old.images,
          attachments: old.attachments,
          agentSteps: steps,
          activePlan: null,  // 任务出错，清除 activePlan
          taskTiming: old.taskTiming,
        );
        return;
    }

    // 更新消息
    _messages[idx] = BridgeChatMessage(
      id: old.id,
      role: old.role,
      content: old.content,
      images: old.images,
      attachments: old.attachments,
      agentSteps: steps,
      activePlan: old.activePlan,
      taskTiming: old.taskTiming,
    );
  }

  void _onError(error) {
    print('[BridgeClient] WebSocket error: $error');
  }

  void _onDone() {
    print('[BridgeClient] WebSocket closed');
    _stopTimers();
    _channel = null;
    // 总是尝试重连，_attemptReconnect 内部会检查 _userDisconnected
    if (_status != BridgeConnectionStatus.disconnected) {
      _setStatus(BridgeConnectionStatus.disconnected);
    }
    _attemptReconnect();
  }

  /* ------------------------------------------------------------------ */
  /*  Private: heartbeat                                                 */
  /* ------------------------------------------------------------------ */

  void _startHeartbeat() {
    _stopTimers();
    _lastHeartbeatReceived = DateTime.now();

    _heartbeatTimer = Timer.periodic(heartbeatInterval, (_) {
      sendHeartbeat();
    });

    _heartbeatCheckTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_lastHeartbeatReceived != null &&
          DateTime.now().difference(_lastHeartbeatReceived!) > heartbeatTimeout) {
        print('[BridgeClient] Heartbeat timeout, reconnecting...');
        _channel?.sink.close(ws_status.normalClosure);
      }
    });
  }

  void _stopTimers() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _heartbeatCheckTimer?.cancel();
    _heartbeatCheckTimer = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _tokenRefreshTimer?.cancel();
    _tokenRefreshTimer = null;
    _taskTimeoutChecker?.cancel();
    _taskTimeoutChecker = null;
    _stopTaskStatusPolling();
  }

  /// 启动任务超时检查器
  /// 定期检查是否有任务超过超时时间，如果有则自动清理
  void _startTimeoutChecker() {
    if (_taskTimeoutChecker != null) return; // 已经启动
    
    _taskTimeoutChecker = Timer.periodic(Duration(seconds: 30), (_) {
      final now = DateTime.now();
      final expiredProjects = <String>[];
      
      // 查找超时的任务
      _projectTaskTimeouts.forEach((projectId, timeout) {
        if (now.isAfter(timeout)) {
          expiredProjects.add(projectId);
        }
      });
      
      // 清理超时的任务
      for (final projectId in expiredProjects) {
        print('[BridgeClient] Task timeout exceeded for project $projectId, auto-cleaning');
        _projectActiveTasks.remove(projectId);
        _projectTaskTimeouts.remove(projectId);
        
        // 如果是当前项目，也清理全局状态
        if (projectId == _currentProjectId) {
          _activeAgentRequestId = null;
          _activeOriginalRequestId = null;
        }
      }
      
      if (expiredProjects.isNotEmpty) {
        // 通知UI更新
        _notifyListeners({'type': 'bridge:task-timeout-cleaned', 'projects': expiredProjects});
      }
      
      // 如果没有待检查的任务，停止检查器
      if (_projectTaskTimeouts.isEmpty) {
        _taskTimeoutChecker?.cancel();
        _taskTimeoutChecker = null;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Private: reconnect                                                 */
  /* ------------------------------------------------------------------ */

  void _attemptReconnect() {
    if (_userDisconnected) {
      _error = '用户已主动断开';
      _setStatus(BridgeConnectionStatus.disconnected);
      return;
    }

    // 无限制重试：指数退避，最大 60 秒
    _reconnectAttempts++;
    _setStatus(BridgeConnectionStatus.reconnecting);

    final delay = Duration(
      seconds: (_reconnectAttempts <= 1)
          ? 3
          : (_reconnectAttempts <= 10
              ? (reconnectBaseDelay.inSeconds * _reconnectAttempts)
              : 60),
    );
    print('[BridgeClient] Reconnecting in ${delay.inSeconds}s (attempt $_reconnectAttempts, unlimited)');

    _reconnectTimer = Timer(delay, () {
      _connect();
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Private: token refresh                                             */
  /* ------------------------------------------------------------------ */

  void _startTokenRefreshTimer() {
    _tokenRefreshTimer?.cancel();
    _tokenRefreshTimer = null;

    if (_tokenExpiresAt <= 0) return;

    final now = DateTime.now().millisecondsSinceEpoch;
    final refreshAt = _tokenExpiresAt - _kTokenRefreshBeforeMs;
    final delayMs = (refreshAt - now).clamp(0, 2147483647);

    print('[BridgeClient] Token refresh scheduled in ${(delayMs / 1000).round()}s');

    _tokenRefreshTimer = Timer(Duration(milliseconds: delayMs), () {
      _doTokenRefresh();
    });
  }

  Future<void> _doTokenRefresh() async {
    if (_token == null || _token!.isEmpty) {
      print('[BridgeClient] Token refresh skipped: no token');
      return;
    }

    // 将 ws/wss URL 转换为 http/https，移除 /ws 后缀
    String baseUrl = (_resolvedRelayUrl ?? defaultRelayUrl)
        .replaceFirst('ws://', 'http://')
        .replaceFirst('wss://', 'https://');
    if (baseUrl.endsWith('/ws')) {
      baseUrl = baseUrl.substring(0, baseUrl.length - 3);
    }
    final refreshUrl = '$baseUrl/api/bridge/refresh_token';

    print('[BridgeClient] Refreshing token via $refreshUrl');

    try {
      final response = await http.post(
        Uri.parse(refreshUrl),
        headers: {
          'Authorization': 'Bearer $_token',
          'Content-Type': 'application/json',
        },
      );

      if (response.statusCode != 200) {
        print('[BridgeClient] Token refresh failed: HTTP ${response.statusCode}');
        // 如果 Token 已过期（401），停止刷新
        if (response.statusCode == 401) {
          _handleTokenExpired();
          return;
        }
        // 其他错误，30 分钟后重试
        _scheduleRetryRefresh(30 * 60 * 1000);
        return;
      }

      final data = jsonDecode(response.body) as Map<String, dynamic>;
      final newToken = data['token'] as String?;
      if (newToken == null || newToken.isEmpty) {
        print('[BridgeClient] Token refresh: no token in response');
        _scheduleRetryRefresh(30 * 60 * 1000);
        return;
      }

      // 更新过期时间
      if (data['expires_at'] != null) {
        _tokenExpiresAt = (data['expires_at'] as int) * 1000;
      } else if (data['expires_in'] != null) {
        _tokenExpiresAt = DateTime.now().millisecondsSinceEpoch + (data['expires_in'] as int) * 1000;
      } else {
        _tokenExpiresAt = DateTime.now().millisecondsSinceEpoch + _kDefaultTokenLifetimeMs;
      }

      print('[BridgeClient] Token refreshed successfully, new expiry: ${DateTime.fromMillisecondsSinceEpoch(_tokenExpiresAt).toIso8601String()}');

      // 使用新 Token 重连
      refreshToken(newToken);
    } catch (e) {
      print('[BridgeClient] Token refresh error: $e');
      _scheduleRetryRefresh(30 * 60 * 1000);
    }
  }

  /// Token 刷新失败后的重试调度
  void _scheduleRetryRefresh(int delayMs) {
    _tokenRefreshTimer?.cancel();
    _tokenRefreshTimer = Timer(Duration(milliseconds: delayMs), () {
      _doTokenRefresh();
    });
  }

  /// 处理 Token 过期：停止自动重连
  void _handleTokenExpired() {
    print('[BridgeClient] Token expired, stopping auto-reconnect');
    _token = null;
    _tokenExpiresAt = 0;
    _userDisconnected = true; // 阻止自动重连
    _setStatus(BridgeConnectionStatus.disconnected);
  }

  /// 从 JWT Token 中解析过期时间（不验证签名）
  int? _parseJwtExpiry(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return null;
      final payload = utf8.decode(base64Url.decode(parts[1]));
      final json = jsonDecode(payload) as Map<String, dynamic>;
      if (json['exp'] != null && json['exp'] is int) {
        return (json['exp'] as int) * 1000; // JWT exp 是秒，转为毫秒
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 保存连接信息到缓存
  Future<void> _saveConnectionInfo(String token) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (_resolvedRelayUrl != null && _resolvedRelayUrl!.isNotEmpty) {
        await prefs.setString(_kCachedRelayUrlKey, _resolvedRelayUrl!);
      }
      await prefs.setString(_kCachedTokenKey, token);
    } catch (_) {}
  }

  /// 清除缓存的连接信息
  Future<void> _clearConnectionInfo() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_kCachedRelayUrlKey);
      await prefs.remove(_kCachedTokenKey);
    } catch (_) {}
  }

  /// 尝试恢复缓存的连接信息
  static Future<({String relayUrl, String token})?> tryRestoreConnection() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString(_kCachedTokenKey);
      if (token == null || token.isEmpty) return null;
      final relayUrl = prefs.getString(_kCachedRelayUrlKey) ?? defaultRelayUrl;
      return (relayUrl: relayUrl, token: token);
    } catch (_) {
      return null;
    }
  }

  void _sendRaw(Map<String, dynamic> data) {
    _channel?.sink.add(jsonEncode(data));
  }

  /// 发送消息到 Relay
  void _send(dynamic message) {
    _sendRaw(_messageToJson(message));
  }

  Map<String, dynamic> _messageToJson(dynamic message) {
    if (message is BridgeChatSend) return message.toJson();
    if (message is BridgeAgentConfirm) return message.toJson();
    if (message is BridgeAgentAbort) return message.toJson();
    if (message is BridgeGetProjects) return message.toJson();
    if (message is BridgeGetWorkspaceTree) return message.toJson();
    if (message is BridgeFileRead) return message.toJson();
    if (message is BridgeFileWrite) return message.toJson();
    if (message is BridgeSwitchProject) return message.toJson();
    if (message is BridgeRequestState) return message.toJson();
    return {'type': 'unknown'};
  }

  void _setStatus(BridgeConnectionStatus newStatus) {
    _status = newStatus;
    if (newStatus != BridgeConnectionStatus.reconnecting) {
      _error = null;
    }
    _notifyStatus();
  }

  void _notifyStatus() {
    final snap = status;
    // 创建副本避免并发修改错误
    final listeners = List.from(_statusListeners);
    for (final cb in listeners) {
      try {
        cb(snap);
      } catch (e) {
        print('[BridgeClient] Status callback error: $e');
      }
    }
  }

  void _notifyListeners(dynamic data) {
    _pendingNotify = true;
    _notifyThrottleTimer?.cancel();
    _notifyThrottleTimer = Timer(_kNotifyThrottleMs, () {
      if (_pendingNotify) {
        _pendingNotify = false;
        // 使用 Future.microtask 确保通知在下一帧执行，避免阻塞 WebSocket 消息处理
        Future.microtask(() {
          // 创建副本避免并发修改错误
          final listeners = List.from(_messageListeners);
          for (final cb in listeners) {
            try {
              cb(data);
            } catch (e) {
              print('[BridgeClient] Message callback error: $e');
            }
          }
        });
      }
    });
  }

  /// Agent 事件立即通知（不节流），保证思考过程和工具调用的实时性
  void _notifyAgentListeners(dynamic data) {
    _pendingAgentNotify = true;
    _agentNotifyTimer?.cancel();
    _agentNotifyTimer = Timer(Duration.zero, () {
      if (_pendingAgentNotify) {
        _pendingAgentNotify = false;
        Future.microtask(() {
          // 创建副本避免并发修改错误
          final listeners = List.from(_messageListeners);
          for (final cb in listeners) {
            try {
              cb(data);
            } catch (e) {
              print('[BridgeClient] Agent notify callback error: $e');
            }
          }
        });
      }
    });
  }

  void _notifyConfirmListeners() {
    final snapshot = List<BridgePendingConfirm>.from(_pendingConfirms);
    // 创建副本避免并发修改错误
    final listeners = List.from(_confirmListeners);
    for (final cb in listeners) {
      try {
        cb(snapshot);
      } catch (e) {
        print('[BridgeClient] Confirm callback error: $e');
      }
    }
  }
}
