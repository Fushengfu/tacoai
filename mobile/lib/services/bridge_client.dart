import 'dart:async';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as ws_status;
import 'bridge_protocol.dart';

const String _kCachedRelayUrlKey = 'bridge_cached_relay_url';

/// BridgeClient — 移动端 WebSocket 客户端（新版：扫码配对）
///
/// 流程：
/// 1. 扫码获取配对码
/// 2. 使用会员 token + 配对码连接 Relay
/// 3. 接收 Host 转发的桥接消息
/// 4. 发送指令到 Host（发消息、确认、终止）
class BridgeClient {
  final String? _relayUrlOverride;

  WebSocketChannel? _channel;
  BridgeConnectionStatus _status = BridgeConnectionStatus.disconnected;
  String? _token;
  String? _pairingCode;
  String? _resolvedRelayUrl;
  int _reconnectAttempts = 0;
  Timer? _heartbeatTimer;
  Timer? _heartbeatCheckTimer;
  Timer? _reconnectTimer;
  DateTime? _lastHeartbeatReceived;

  final List<BridgeChatMessage> _messages = [];
  final List<Function(BridgeStatus)> _statusListeners = [];
  final List<Function(dynamic)> _messageListeners = [];
  String? _error;

  /// 请求/响应模式：requestId → Completer
  final Map<String, Completer<Map<String, dynamic>>> _pendingRequests = {};
  int _requestCounter = 0;

  BridgeClient({String? relayUrl}) : _relayUrlOverride = relayUrl;

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
  void connect({required String token, required String pairingCode}) {
    _token = token;
    _pairingCode = pairingCode;
    _reconnectAttempts = 0;
    _connect();
  }

  /// 断开连接
  void disconnect() {
    _stopTimers();
    _channel?.sink.close(ws_status.normalClosure);
    _channel = null;
    _token = null;
    _pairingCode = null;
    _reconnectAttempts = 0;
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
    _send(BridgeChatSend(content: content));
  }

  /// 发送 Agent 确认
  void sendAgentConfirm(String confirmId, bool approved) {
    _send(BridgeAgentConfirm(confirmId: confirmId, approved: approved));
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

  /// 请求项目列表
  Future<List<BridgeProjectInfo>> requestProjects() async {
    final requestId = 'req-${++_requestCounter}-${DateTime.now().millisecondsSinceEpoch}';
    final completer = Completer<Map<String, dynamic>>();
    _pendingRequests[requestId] = completer;

    _send(BridgeGetProjects(requestId: requestId));

    final response = await completer.future;
    final projectsResponse = BridgeProjectsResponse.fromJson(response);
    return projectsResponse.projects;
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

  /// 发送原始消息（用于请求/响应模式）
  void _sendRequest(Map<String, dynamic> data) {
    _sendRaw(data);
  }

  /* ------------------------------------------------------------------ */
  /*  Private: connection                                                */
  /* ------------------------------------------------------------------ */

  Future<void> _connect() async {
    if (_token == null || _pairingCode == null) {
      _error = '缺少 token 或配对码';
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

    final uriString = '$scheme://${baseUri.host}$portPart$path?token=${Uri.encodeQueryComponent(_token!)}&role=client&code=${Uri.encodeQueryComponent(_pairingCode!)}';
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

      switch (type) {
        case 'connected':
          _reconnectAttempts = 0;
          _setStatus(BridgeConnectionStatus.connected);
          _startHeartbeat();
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
          final state = BridgeState.fromJson(json);
          _messages.clear();
          _messages.addAll(state.messages);
          _notifyListeners(json);
          break;

        case 'bridge:chat-delta':
          final delta = BridgeChatDelta.fromJson(json);
          _applyDelta(delta);
          _notifyListeners(json);
          break;

        case 'bridge:agent-event':
        case 'bridge:files-changed':
          _notifyListeners(json);
          break;

        // 数据查询响应
        case 'bridge:projects':
        case 'bridge:workspace-tree':
        case 'bridge:file-content':
        case 'bridge:file-written':
        case 'bridge:project-switched':
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

        default:
          _notifyListeners(json);
          break;
      }
    } catch (e) {
      print('[BridgeClient] Failed to parse message: $e');
    }
  }

  void _applyDelta(BridgeChatDelta delta) {
    final idx = _messages.indexWhere((m) => m.id == delta.messageId);
    if (idx >= 0) {
      final old = _messages[idx];
      _messages[idx] = BridgeChatMessage(
        id: old.id,
        role: old.role,
        content: old.content + delta.delta,
        hasImages: old.hasImages,
        streaming: !delta.done,
      );
    } else {
      _messages.add(BridgeChatMessage(
        id: delta.messageId,
        role: 'assistant',
        content: delta.delta,
        streaming: !delta.done,
      ));
    }
  }

  void _onError(error) {
    print('[BridgeClient] WebSocket error: $error');
  }

  void _onDone() {
    print('[BridgeClient] WebSocket closed');
    _stopTimers();
    _channel = null;
    if (_status != BridgeConnectionStatus.disconnected) {
      _setStatus(BridgeConnectionStatus.disconnected);
      _attemptReconnect();
    }
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
  }

  /* ------------------------------------------------------------------ */
  /*  Private: reconnect                                                 */
  /* ------------------------------------------------------------------ */

  void _attemptReconnect() {
    if (_reconnectAttempts >= maxReconnectAttempts) {
      _error = '重连次数已达上限';
      _setStatus(BridgeConnectionStatus.disconnected);
      return;
    }

    _reconnectAttempts++;
    _setStatus(BridgeConnectionStatus.reconnecting);

    final delay = reconnectBaseDelay * _reconnectAttempts;
    print('[BridgeClient] Reconnecting in ${delay.inSeconds}s (attempt $_reconnectAttempts/$maxReconnectAttempts)');

    _reconnectTimer = Timer(delay, () {
      _connect();
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Private: utils                                                     */
  /* ------------------------------------------------------------------ */

  void _send(dynamic message) {
    if (_channel != null) {
      _sendRaw(message is Map<String, dynamic> ? message : _messageToJson(message));
    }
  }

  void _sendRaw(Map<String, dynamic> data) {
    _channel?.sink.add(jsonEncode(data));
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
    for (final cb in _statusListeners) {
      try {
        cb(snap);
      } catch (e) {
        print('[BridgeClient] Status callback error: $e');
      }
    }
  }

  void _notifyListeners(dynamic data) {
    for (final cb in _messageListeners) {
      try {
        cb(data);
      } catch (e) {
        print('[BridgeClient] Message callback error: $e');
      }
    }
  }
}
