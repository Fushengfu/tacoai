import 'dart:async';
import 'dart:convert';
import 'bridge_protocol.dart';

/// BridgeAckManager - 移动端ACK确认管理器
/// 
/// 负责：
/// 1. 接收桌面端消息后发送ACK确认
/// 2. 检测未确认消息并请求重传
/// 3. 管理消息接收缓存和去重
class BridgeAckManager {
  final Sink _sink;
  
  // 已接收消息ID集合（去重用）
  final Set<String> _receivedMessageIds = {};
  
  // 最大缓存数量
  static const int _maxCacheSize = 1000;
  
  // 待确认的消息（需要发送ACK的）
  final Map<String, Map<String, dynamic>> _pendingAcks = {};
  
  // ACK发送定时器（批量发送ACK）
  Timer? _ackBatchTimer;
  final List<Map<String, dynamic>> _ackBatch = [];
  
  // 统计信息
  int _totalReceived = 0;
  int _totalAcked = 0;
  int _totalDuplicates = 0;
  int _totalRetransmits = 0;

  BridgeAckManager(this._sink);

  /// 处理接收到的消息
  void handleMessage(Map<String, dynamic> json) {
    final type = json['type'] as String?;
    final messageId = json['messageId'] as String?;
    
    if (messageId == null || messageId.isEmpty) {
      // 没有messageId的消息不需要ACK
      return;
    }

    // 1. 去重检查
    if (_receivedMessageIds.contains(messageId)) {
      _totalDuplicates++;
      print('[BridgeAck] Duplicate message dropped: $messageId');
      return;
    }

    // 2. 记录已接收
    _receivedMessageIds.add(messageId);
    _totalReceived++;
    _limitCacheSize();

    // 3. 判断是否需要发送ACK（critical和high优先级需要）
    final priority = json['priority'] as String?;
    if (priority == 'critical' || priority == 'high') {
      _pendingAcks[messageId] = json;
      _queueAck(messageId, type!);
    }
  }

  /// 将ACK加入批量发送队列
  void _queueAck(String messageId, String originalType) {
    _ackBatch.add({
      'type': 'bridge:ack',
      'messageId': messageId,
      'originalType': originalType,
      'receivedAt': DateTime.now().millisecondsSinceEpoch,
    });

    // 启动批量发送定时器（50ms内合并发送）
    if (_ackBatchTimer == null) {
      _ackBatchTimer = Timer(Duration(milliseconds: 50), _flushAckBatch);
    }
  }

  /// 批量发送ACK
  void _flushAckBatch() {
    if (_ackBatch.isEmpty) {
      _ackBatchTimer = null;
      return;
    }

    // 发送所有待发送的ACK
    for (final ack in _ackBatch) {
      _sink.add(jsonEncode(ack));
      _totalAcked++;
    }

    print('[BridgeAck] Flushed ${_ackBatch.length} ACKs');
    _ackBatch.clear();
    _ackBatchTimer = null;
  }

  /// 限制缓存大小
  void _limitCacheSize() {
    if (_receivedMessageIds.length > _maxCacheSize) {
      // 删除最早的10%缓存
      final toRemove = (_maxCacheSize * 0.1).round();
      final iterator = _receivedMessageIds.iterator;
      for (int i = 0; i < toRemove; i++) {
        if (iterator.moveNext()) {
          _receivedMessageIds.remove(iterator.current);
        } else {
          break;
        }
      }
    }
  }

  /// 请求重传指定消息
  void requestRetransmit(String messageId) {
    _sink.add(jsonEncode({
      'type': 'bridge:retransmit-request',
      'messageId': messageId,
    }));
    _totalRetransmits++;
    print('[BridgeAck] Retransmit requested: $messageId');
  }

  /// 获取统计信息
  Map<String, int> getStats() {
    return {
      'totalReceived': _totalReceived,
      'totalAcked': _totalAcked,
      'totalDuplicates': _totalDuplicates,
      'totalRetransmits': _totalRetransmits,
      'pendingAcks': _pendingAcks.length,
    };
  }

  /// 清理资源
  void dispose() {
    _ackBatchTimer?.cancel();
    _ackBatchTimer = null;
    _ackBatch.clear();
    _pendingAcks.clear();
    _receivedMessageIds.clear();
  }
}
