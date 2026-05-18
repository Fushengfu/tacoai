import 'dart:convert';
import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart' as p;
import 'bridge_protocol.dart';

/// 本地消息缓存数据库
///
/// 职责：
/// - 缓存从桌面端接收到的完整消息（bridge:state 快照 + bridge:agent-event done）
/// - 优先从本地加载消息，减少 WebSocket 传输延迟
/// - 切换项目时秒开，无需等待桌面端响应
class MessageCache {
  static MessageCache? _instance;
  Database? _db;
  final Map<String, List<BridgeChatMessage>> _memoryCache = {};

  MessageCache._();

  static Future<MessageCache> getInstance() async {
    if (_instance == null) {
      _instance = MessageCache._();
      await _instance!._init();
    }
    return _instance!;
  }

  Future<void> _init() async {
    final dbPath = await getDatabasesPath();
    final path = p.join(dbPath, 'bridge_messages.db');
    _db = await openDatabase(
      path,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE messages (
            id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            images TEXT,
            attachments TEXT,
            agent_steps TEXT,
            active_plan TEXT,
            task_timing TEXT,
            git_commit_hash TEXT,
            seq INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (id, session_id)
          )
        ''');
        await db.execute('CREATE INDEX idx_messages_session ON messages(session_id, seq DESC)');
      },
    );
  }

  /// 保存单条消息（upsert）
  Future<void> saveMessage(String sessionId, BridgeChatMessage msg, {int seq = 0}) async {
    final db = _db;
    if (db == null) return;

    final now = DateTime.now().millisecondsSinceEpoch;
    await db.insert(
      'messages',
      {
        'id': msg.id,
        'session_id': sessionId,
        'role': msg.role,
        'content': msg.content,
        'images': msg.images != null ? jsonEncode(msg.images!.map((i) => i.toJson()).toList()) : null,
        'attachments': msg.attachments != null ? jsonEncode(msg.attachments!.map((a) => a.toJson()).toList()) : null,
        'agent_steps': msg.agentSteps != null ? jsonEncode(msg.agentSteps!.map((s) => _stepToJson(s)).toList()) : null,
        'active_plan': msg.activePlan != null ? jsonEncode(_activePlanToJson(msg.activePlan!)) : null,
        'task_timing': msg.taskTiming != null ? jsonEncode(_taskTimingToJson(msg.taskTiming!)) : null,
        'git_commit_hash': msg.gitCommitHash,
        'seq': seq,
        'created_at': now,
        'updated_at': now,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );

    // 更新内存缓存
    _memoryCache[sessionId]?.removeWhere((m) => m.id == msg.id);
    _memoryCache[sessionId]?.add(msg);
  }

  /// 批量保存消息（用于全量快照）
  Future<void> saveMessages(String sessionId, List<BridgeChatMessage> messages) async {
    final db = _db;
    if (db == null) return;

    final batch = db.batch();
    final now = DateTime.now().millisecondsSinceEpoch;

    // 先删除该 session 的旧消息
    batch.delete('messages', where: 'session_id = ?', whereArgs: [sessionId]);

    for (int i = 0; i < messages.length; i++) {
      final msg = messages[i];
      batch.insert(
        'messages',
        {
          'id': msg.id,
          'session_id': sessionId,
          'role': msg.role,
          'content': msg.content,
          'images': msg.images != null ? jsonEncode(msg.images!.map((i) => i.toJson()).toList()) : null,
          'attachments': msg.attachments != null ? jsonEncode(msg.attachments!.map((a) => a.toJson()).toList()) : null,
          'agent_steps': msg.agentSteps != null ? jsonEncode(msg.agentSteps!.map((s) => _stepToJson(s)).toList()) : null,
          'active_plan': msg.activePlan != null ? jsonEncode(_activePlanToJson(msg.activePlan!)) : null,
          'task_timing': msg.taskTiming != null ? jsonEncode(_taskTimingToJson(msg.taskTiming!)) : null,
          'git_commit_hash': msg.gitCommitHash,
          'seq': i,
          'created_at': now,
          'updated_at': now,
        },
      );
    }

    await batch.commit(noResult: true);

    // 更新内存缓存
    _memoryCache[sessionId] = List.from(messages);
  }

  /// 加载指定 session 的消息
  Future<List<BridgeChatMessage>> loadMessages(String sessionId, {int limit = 50}) async {
    // 优先返回内存缓存
    if (_memoryCache.containsKey(sessionId)) {
      return _memoryCache[sessionId]!;
    }

    final db = _db;
    if (db == null) return [];

    final rows = await db.query(
      'messages',
      where: 'session_id = ?',
      whereArgs: [sessionId],
      orderBy: 'seq ASC',
      limit: limit,
    );

    final messages = rows.map((row) => _rowToMessage(row)).toList();
    _memoryCache[sessionId] = messages;
    return messages;
  }

  /// 清除指定 session 的缓存
  Future<void> clearSession(String sessionId) async {
    final db = _db;
    if (db == null) return;
    await db.delete('messages', where: 'session_id = ?', whereArgs: [sessionId]);
    _memoryCache.remove(sessionId);
  }

  /// 清除所有缓存
  Future<void> clearAll() async {
    final db = _db;
    if (db == null) return;
    await db.delete('messages');
    _memoryCache.clear();
  }

  /* ------------------------------------------------------------------ */
  /*  序列化辅助函数                                                       */
  /* ------------------------------------------------------------------ */

  Map<String, dynamic> _stepToJson(BridgeAgentStep step) {
    return {
      'round': step.round,
      'systemTitle': step.systemTitle,
      'systemDetail': step.systemDetail,
      'thinking': step.thinking,
      'toolCalls': step.toolCalls?.map((t) => t.toJson()).toList(),
      'toolResults': step.toolResults?.map((t) => t.toJson()).toList(),
      'status': step.status,
      'risks': step.risks?.map((r) => _riskToJson(r)).toList(),
      'confirmId': step.confirmId,
    };
  }

  Map<String, dynamic> _riskToJson(BridgeRiskInfo r) {
    return {
      'toolCallId': r.toolCallId,
      'toolName': r.toolName,
      'level': r.level,
      'reason': r.reason,
      'detail': r.detail,
    };
  }

  Map<String, dynamic> _planStepToJson(BridgePlanStepInfo s) {
    return {
      'index': s.index,
      'title': s.title,
      'content': s.content,
      'status': s.status,
      'note': s.note,
    };
  }

  Map<String, dynamic> _activePlanToJson(BridgeActivePlan plan) {
    return {
      'summary': plan.summary,
      'reasoning': plan.reasoning,
      'steps': plan.steps.map((s) => _planStepToJson(s)).toList(),
      'startedAt': plan.startedAt,
      'endedAt': plan.endedAt,
    };
  }

  Map<String, dynamic> _taskTimingToJson(BridgeTaskTiming timing) {
    return {
      'startedAt': timing.startedAt,
      'endedAt': timing.endedAt,
      'durationMs': timing.durationMs,
    };
  }

  BridgeChatMessage _rowToMessage(Map<String, dynamic> row) {
    return BridgeChatMessage(
      id: row['id'] as String,
      role: row['role'] as String,
      content: row['content'] as String? ?? '',
      images: _decodeList(row['images'] as String?, (j) => BridgeAttachedImage.fromJson(j)),
      attachments: _decodeList(row['attachments'] as String?, (j) => BridgeAttachedAsset.fromJson(j)),
      agentSteps: _decodeList(row['agent_steps'] as String?, (j) => BridgeAgentStep.fromJson(j)),
      activePlan: _decodeOne(row['active_plan'] as String?, (j) => BridgeActivePlan.fromJson(j)),
      taskTiming: _decodeOne(row['task_timing'] as String?, (j) => BridgeTaskTiming.fromJson(j)),
      gitCommitHash: row['git_commit_hash'] as String?,
    );
  }

  List<T>? _decodeList<T>(String? json, T Function(Map<String, dynamic>) fromJson) {
    if (json == null || json.isEmpty) return null;
    try {
      final list = jsonDecode(json) as List<dynamic>;
      return list.map((item) => fromJson(item as Map<String, dynamic>)).toList();
    } catch (_) {
      return null;
    }
  }

  T? _decodeOne<T>(String? json, T Function(Map<String, dynamic>) fromJson) {
    if (json == null || json.isEmpty) return null;
    try {
      return fromJson(jsonDecode(json) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }
}
