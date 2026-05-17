import 'dart:async';
import 'dart:collection';

/// 消息类型枚举
enum BridgeMessageType {
  /// 聊天相关消息（delta、user message、chat snapshot）
  chat,
  
  /// Agent 事件（tool_calls、thinking、progress、plan）
  agent,
  
  /// 项目状态（project-states、project switch）
  project,
  
  /// 确认请求（confirm、resolved）
  confirm,
  
  /// 文件变更
  files,
  
  /// 系统消息（status、error）
  system,
}

/// 消息队列项
class _QueuedMessage {
  final BridgeMessageType type;
  final Map<String, dynamic> data;
  final VoidCallback handler;
  final DateTime enqueuedAt;

  _QueuedMessage({
    required this.type,
    required this.data,
    required this.handler,
  }) : enqueuedAt = DateTime.now();
}

typedef VoidCallback = void Function();

/// 消息队列管理器
/// 
/// 设计原则：
/// 1. 相同类型的消息按顺序处理（FIFO 队列），保证状态一致性
/// 2. 不同类型的消息异步并发处理，互不阻塞
/// 3. 每个消息类型有独立的处理队列和处理器
class BridgeMessageQueue {
  // 每种消息类型的独立队列
  final Map<BridgeMessageType, Queue<_QueuedMessage>> _queues = {
    for (final type in BridgeMessageType.values) type: Queue<_QueuedMessage>(),
  };
  
  // 每种消息类型是否正在处理
  final Map<BridgeMessageType, bool> _processing = {
    for (final type in BridgeMessageType.values) type: false,
  };
  
  // 是否已销毁
  bool _disposed = false;

  /// 入队消息
  void enqueue({
    required BridgeMessageType type,
    required Map<String, dynamic> data,
    required VoidCallback handler,
  }) {
    if (_disposed) return;

    final message = _QueuedMessage(
      type: type,
      data: data,
      handler: handler,
    );

    // 加入对应类型的队列
    _queues[type]!.add(message);

    // 尝试处理该类型的队列
    _processQueue(type);
  }

  /// 处理指定类型的队列
  void _processQueue(BridgeMessageType type) {
    // 如果已经销毁，停止处理
    if (_disposed) return;

    // 如果该类型正在处理，等待下一次调用
    if (_processing[type] == true) return;

    // 如果队列为空，停止处理
    if (_queues[type]!.isEmpty) return;

    // 标记为正在处理
    _processing[type] = true;

    // 异步处理，不阻塞其他类型
    Future.microtask(() {
      try {
        // 循环处理队列中的所有消息
        while (_queues[type]!.isNotEmpty && !_disposed) {
          final message = _queues[type]!.removeFirst();
          
          try {
            // 执行消息处理
            message.handler();
          } catch (e) {
            print('[BridgeMessageQueue] Handler error for ${type.name}: $e');
          }
        }
      } finally {
        // 标记处理完成
        _processing[type] = false;

        // 如果队列还有新消息，继续处理
        if (_queues[type]!.isNotEmpty) {
          _processQueue(type);
        }
      }
    });
  }

  /// 获取队列长度（调试用）
  int getQueueLength(BridgeMessageType type) {
    return _queues[type]?.length ?? 0;
  }

  /// 获取所有队列的总长度
  int get totalQueueLength {
    return _queues.values.fold(0, (sum, queue) => sum + queue.length);
  }

  /// 清空所有队列
  void clear() {
    for (final queue in _queues.values) {
      queue.clear();
    }
    for (final type in _processing.keys) {
      _processing[type] = false;
    }
  }

  /// 销毁队列管理器
  void dispose() {
    _disposed = true;
    clear();
  }
}
