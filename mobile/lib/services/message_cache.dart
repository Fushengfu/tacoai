import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart' as p;
import 'bridge_protocol.dart';

/// 本地消息缓存数据库
///
/// 职责：
/// - 缓存从桌面端接收到的完整消息（bridge:state 快照 + bridge:agent-event done）
/// - 优先从本地加载消息，减少 WebSocket 传输延迟
/// - 切换项目时秒开，无需等待桌面端响应
///
/// 安全措施：
/// - Android CursorWindow 默认 2MB，超大行会报 "Row too big to fit into CursorWindow"
/// - 存储时截断图片 base64 和过长的 content/agent_steps
/// - 加载时容错处理，逐条回退
class MessageCache {
  static MessageCache? _instance;
  Database? _db;
  /// LRU 内存缓存：最多保留最近 _maxCacheSize 个项目的内存缓存
  final Map<String, List<BridgeChatMessage>> _memoryCache = {};
  /// 记录项目访问顺序（用于 LRU 淘汰）
  final List<String> _accessOrder = [];
  static const int _maxCacheSize = 3; // 最多缓存 3 个项目的消息

  // 单字段最大存储长度（防止 CursorWindow 溢出）
  // Android CursorWindow 默认 2MB，4 个大字段各控制在 256KB 以内
  static const int _maxFieldLength = 256 * 1024; // 256KB

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
      version: 2,
      singleInstance: true,
      onConfigure: (db) async {
        // 启用 WAL 模式提升并发性能
        await db.rawQuery('PRAGMA journal_mode=WAL');
      },
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
      onUpgrade: (db, oldVersion, newVersion) async {
        // version 1 -> 2: 无 schema 变更，仅升级 CursorWindow 大小
      },
    );
  }

  /// 更新 LRU 访问顺序
  void _touchCache(String sessionId) {
    _accessOrder.remove(sessionId);
    _accessOrder.add(sessionId);
    // 如果超过缓存限制，移除最久未使用的项目
    while (_accessOrder.length > _maxCacheSize) {
      final oldest = _accessOrder.removeAt(0);
      _memoryCache.remove(oldest);
    }
  }

  /// 截断超长字段，防止 CursorWindow 溢出
  String? _truncateField(String? value, {int maxLength = _maxFieldLength}) {
    if (value == null) return null;
    if (value.length <= maxLength) return value;
    // 保留前 maxLength 字符，标记截断
    debugPrint('[MessageCache] Truncating field: ${value.length} -> $maxLength chars');
    return '${value.substring(0, maxLength)}...[truncated]';
  }

  /// 清理消息中的图片 base64 数据（缓存不需要存储图片二进制）
  ///
  /// 策略：
  /// - 有 cloudUrl → 去掉 dataUrl（用网络 URL 显示，优先）
  /// - 无 cloudUrl 且 dataUrl <= 200KB → 保留 dataUrl（唯一显示方式）
  /// - 无 cloudUrl 且 dataUrl > 200KB → 去掉 dataUrl（防止 CursorWindow 溢出）
  static const int _maxDataUrlSize = 200 * 1024; // 200KB
  List<BridgeAttachedImage>? _stripImageData(List<BridgeAttachedImage>? images) {
    if (images == null || images.isEmpty) return images;
    return images.map((img) {
      if (img.dataUrl.length <= 1024) {
        // 小图片（< 1KB）：保留，不值得清理
        return img;
      }
      if (img.cloudUrl.isNotEmpty) {
        // 有云端 URL：去掉 base64，用网络 URL 显示
        return BridgeAttachedImage(
          id: img.id,
          dataUrl: '',
          cloudUrl: img.cloudUrl,
          name: img.name,
          uploadStatus: img.uploadStatus,
          uploadProgress: img.uploadProgress,
        );
      }
      // 无云端 URL：base64 是唯一的显示方式
      if (img.dataUrl.length > _maxDataUrlSize) {
        // 过大的 base64 无法存入 SQLite CursorWindow（2MB），只能去掉
        debugPrint('[MessageCache] Image has no cloudUrl and dataUrl too large (${img.dataUrl.length} chars), stripping to avoid CursorWindow overflow');
        return BridgeAttachedImage(
          id: img.id,
          dataUrl: '',
          cloudUrl: '',
          name: img.name,
          uploadStatus: img.uploadStatus,
          uploadProgress: img.uploadProgress,
        );
      }
      // 保留中等大小的 base64
      return img;
    }).toList();
  }

  /// 将消息序列化为数据库行（带截断保护）
  Map<String, dynamic> _messageToRow(String sessionId, BridgeChatMessage msg, int seq) {
    final now = DateTime.now().millisecondsSinceEpoch;
    return {
      'id': msg.id,
      'session_id': sessionId,
      'role': msg.role,
      'content': _truncateField(msg.content) ?? '',
      // 图片：去掉 base64 数据，只保留元数据
      'images': msg.images != null
          ? _truncateField(jsonEncode(_stripImageData(msg.images)!.map((i) => i.toJson()).toList()))
          : null,
      'attachments': msg.attachments != null
          ? _truncateField(jsonEncode(msg.attachments!.map((a) => a.toJson()).toList()))
          : null,
      // agent_steps 可能非常大（工具结果含长文本），需要截断
      'agent_steps': msg.agentSteps != null
          ? _truncateField(jsonEncode(msg.agentSteps!.map((s) => _stepToJson(s)).toList()))
          : null,
      'active_plan': msg.activePlan != null
          ? _truncateField(jsonEncode(_activePlanToJson(msg.activePlan!)))
          : null,
      'task_timing': msg.taskTiming != null
          ? jsonEncode(_taskTimingToJson(msg.taskTiming!))
          : null,
      'git_commit_hash': msg.gitCommitHash,
      'seq': seq,
      'created_at': now,
      'updated_at': now,
    };
  }

  /// 保存单条消息（upsert）
  Future<void> saveMessage(String sessionId, BridgeChatMessage msg, {int seq = 0}) async {
    final db = _db;
    if (db == null) return;

    try {
      await db.insert(
        'messages',
        _messageToRow(sessionId, msg, seq),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    } catch (e) {
      debugPrint('[MessageCache] saveMessage failed for ${msg.id}: $e');
      // 如果仍然溢出，尝试只保存基本信息（去掉所有大字段）
      try {
        final now = DateTime.now().millisecondsSinceEpoch;
        await db.insert(
          'messages',
          {
            'id': msg.id,
            'session_id': sessionId,
            'role': msg.role,
            'content': _truncateField(msg.content, maxLength: 32 * 1024) ?? '',
            'images': null,
            'attachments': null,
            'agent_steps': null,
            'active_plan': null,
            'task_timing': null,
            'git_commit_hash': msg.gitCommitHash,
            'seq': seq,
            'created_at': now,
            'updated_at': now,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      } catch (e2) {
        debugPrint('[MessageCache] saveMessage minimal fallback also failed: $e2');
      }
    }

    // 更新内存缓存（内存中保留完整数据）
    _memoryCache[sessionId]?.removeWhere((m) => m.id == msg.id);
    _memoryCache[sessionId]?.add(msg);
    _touchCache(sessionId);
  }

  /// 批量保存消息（用于全量快照）
  /// 使用显式事务确保原子性：delete + insert 在同一个事务中，断电时不会丢失数据
  Future<void> saveMessages(String sessionId, List<BridgeChatMessage> messages) async {
    final db = _db;
    if (db == null) return;

    try {
      // 使用显式事务确保原子性：delete + insert 要么全部成功，要么全部回滚
      await db.transaction((txn) async {
        // 先删除该 session 的旧消息
        await txn.delete('messages', where: 'session_id = ?', whereArgs: [sessionId]);

        for (int i = 0; i < messages.length; i++) {
          await txn.insert(
            'messages',
            _messageToRow(sessionId, messages[i], i),
          );
        }
      });
    } catch (e) {
      debugPrint('[MessageCache] saveMessages transaction failed, trying individual inserts: $e');
      // 事务失败时逐条保存，跳过溢出行
      await clearSession(sessionId);
      for (int i = 0; i < messages.length; i++) {
        try {
          await saveMessage(sessionId, messages[i], seq: i);
        } catch (e2) {
          debugPrint('[MessageCache] saveMessages skip message ${messages[i].id}: $e2');
        }
      }
    }

    // 更新内存缓存（内存中保留完整数据）
    _memoryCache[sessionId] = List.from(messages);
    _touchCache(sessionId);
  }

  /// 加载指定 session 的消息
  Future<List<BridgeChatMessage>> loadMessages(String sessionId, {int limit = 50}) async {
    // 优先返回内存缓存
    if (_memoryCache.containsKey(sessionId)) {
      _touchCache(sessionId); // 更新 LRU 访问顺序
      return _memoryCache[sessionId]!;
    }

    final db = _db;
    if (db == null) return [];

    try {
      final rows = await db.query(
        'messages',
        where: 'session_id = ?',
        whereArgs: [sessionId],
        orderBy: 'seq ASC',
        limit: limit,
      );

      final messages = rows.map((row) => _rowToMessage(row)).toList();
      _memoryCache[sessionId] = messages;
      _touchCache(sessionId);
      return messages;
    } on DatabaseException catch (e) {
      // "Row too big to fit into CursorWindow" 错误处理
      debugPrint('[MessageCache] loadMessages batch query failed: $e');
      return _loadMessagesIndividually(db, sessionId, limit);
    }
  }

  /// 逐条加载消息（容错回退方案）
  /// 当批量查询因 CursorWindow 溢出失败时，逐条加载并跳过问题行
  Future<List<BridgeChatMessage>> _loadMessagesIndividually(
    Database db,
    String sessionId,
    int limit,
  ) async {
    debugPrint('[MessageCache] Falling back to individual message loading...');

    // 先获取所有消息的 ID 列表（这个查询不会溢出，因为只返回 id 和 seq）
    final idRows = await db.query(
      'messages',
      columns: ['id', 'seq'],
      where: 'session_id = ?',
      whereArgs: [sessionId],
      orderBy: 'seq ASC',
      limit: limit,
    );

    final messages = <BridgeChatMessage>[];
    for (final idRow in idRows) {
      final msgId = idRow['id'] as String;
      try {
        final rows = await db.query(
          'messages',
          where: 'session_id = ? AND id = ?',
          whereArgs: [sessionId, msgId],
          limit: 1,
        );
        if (rows.isNotEmpty) {
          messages.add(_rowToMessage(rows.first));
        }
      } catch (e) {
        // 单条消息仍然溢出，尝试只加载基础字段
        debugPrint('[MessageCache] Individual load failed for $msgId, trying minimal: $e');
        try {
          final rows = await db.query(
            'messages',
            columns: ['id', 'role', 'content', 'seq', 'created_at', 'updated_at', 'git_commit_hash'],
            where: 'session_id = ? AND id = ?',
            whereArgs: [sessionId, msgId],
            limit: 1,
          );
          if (rows.isNotEmpty) {
            messages.add(_rowToMessage(rows.first));
          }
        } catch (e2) {
          debugPrint('[MessageCache] Minimal load also failed for $msgId, skipping: $e2');
        }
      }
    }

    _memoryCache[sessionId] = messages;
    _touchCache(sessionId);
    debugPrint('[MessageCache] Loaded ${messages.length}/${idRows.length} messages individually');
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
      'systemDetail': _truncateField(step.systemDetail, maxLength: 16 * 1024),
      'thinking': _truncateField(step.thinking, maxLength: 16 * 1024),
      'toolCalls': step.toolCalls.map((t) => _toolCallToJson(t)).toList(),
      'toolResults': step.toolResults.map((t) => _toolResultToJson(t)).toList(),
      'status': step.status,
      'risks': step.risks?.map((r) => _riskToJson(r)).toList(),
      'confirmId': step.confirmId,
    };
  }

  Map<String, dynamic> _toolCallToJson(BridgeToolCallInfo t) {
    return {
      'id': t.id,
      'name': t.name,
      // arguments 可能很长（如 read_file 的 path），截断保护
      'arguments': _truncateField(t.arguments, maxLength: 8 * 1024),
    };
  }

  Map<String, dynamic> _toolResultToJson(BridgeToolResultInfo t) {
    return {
      'tool_call_id': t.toolCallId,
      'name': t.name,
      // tool result 可能非常长（如 run_command 的输出），截断保护
      'content': _truncateField(t.content, maxLength: 32 * 1024),
      'success': t.success,
      if (t.fileChange != null) 'fileChange': {
        'filePath': t.fileChange!.filePath,
        if (t.fileChange!.oldContent != null) 'oldContent': _truncateField(t.fileChange!.oldContent, maxLength: 8 * 1024),
        if (t.fileChange!.newContent != null) 'newContent': _truncateField(t.fileChange!.newContent, maxLength: 8 * 1024),
      },
    };
  }

  Map<String, dynamic> _riskToJson(BridgeRiskInfo r) {
    return {
      'toolCallId': r.toolCallId,
      'toolName': r.toolName,
      'level': r.level,
      'reason': r.reason,
      'detail': _truncateField(r.detail, maxLength: 4 * 1024),
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
