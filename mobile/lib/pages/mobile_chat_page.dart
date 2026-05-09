import 'package:flutter/material.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import '../widgets/message_bubble.dart';

/// 移动端聊天主页面
/// 
/// 功能：
/// - 顶部显示项目状态（workspace、model、threadTitle）
/// - 中部消息列表（支持流式更新）
/// - 底部输入框（发送消息、Agent确认/终止）
class MobileChatPage extends StatefulWidget {
  final BridgeClient client;

  const MobileChatPage({super.key, required this.client});

  @override
  State<MobileChatPage> createState() => _MobileChatPageState();
}

class _MobileChatPageState extends State<MobileChatPage> {
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _textController = TextEditingController();

  List<BridgeChatMessage> _messages = [];
  BridgeConnectionStatus _status = BridgeConnectionStatus.disconnected;
  
  // 项目状态
  String? _workspace;
  String? _modelLabel;
  String? _threadTitle;
  String? _activeAgentRequestId;
  
  // Agent 确认请求
  String? _pendingConfirmId;
  String? _pendingConfirmMessage;

  @override
  void initState() {
    super.initState();
    // 主动读取客户端当前状态，避免页面初始化时显示错误的断开状态
    final currentStatus = widget.client.status;
    _status = currentStatus.status;

    widget.client.onStatusChange(_onStatusChange);
    widget.client.onMessage(_onMessage);
    _messages = List.from(widget.client.messages);
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _textController.dispose();
    super.dispose();
  }

  void _onStatusChange(BridgeStatus status) {
    if (!mounted) return;
    setState(() {
      _status = status.status;
    });

    if (status.status == BridgeConnectionStatus.disconnected && status.error != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('连接断开: ${status.error}')),
      );
    }
  }

  void _onMessage(dynamic data) {
    if (!mounted) return;
    
    final json = data as Map<String, dynamic>;
    final type = json['type'] as String?;

    setState(() {
      // 更新消息列表
      _messages = List.from(widget.client.messages);

      // 处理状态同步
      if (type == 'bridge:state') {
        final state = BridgeState.fromJson(json);
        _workspace = state.workspace;
        _modelLabel = state.modelLabel;
        _threadTitle = state.threadTitle;
        _activeAgentRequestId = state.activeAgentRequestId;
      }

      // 处理 Agent 事件
      if (type == 'bridge:agent-event') {
        final event = BridgeAgentEvent.fromJson(json);
        _handleAgentEvent(event);
      }
    });

    _scrollToBottom();
  }

  void _handleAgentEvent(BridgeAgentEvent event) {
    final eventData = event.event;
    final eventType = eventData['type'] as String?;

    // 检查是否有确认请求
    if (eventType == 'confirm' || eventData['requiresConfirmation'] == true) {
      setState(() {
        _pendingConfirmId = event.requestId;
        _pendingConfirmMessage = eventData['message'] as String? ?? 'Agent 请求执行操作，是否允许？';
      });
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _handleSend() {
    final text = _textController.text.trim();
    if (text.isEmpty) return;

    widget.client.sendChatMessage(text);
    _textController.clear();
  }

  void _handleConfirm(bool approved) {
    if (_pendingConfirmId != null) {
      widget.client.sendAgentConfirm(_pendingConfirmId!, approved);
      setState(() {
        _pendingConfirmId = null;
        _pendingConfirmMessage = null;
      });
    }
  }

  void _handleAbort() {
    if (_activeAgentRequestId != null) {
      widget.client.sendAgentAbort(_activeAgentRequestId!);
    }
  }

  String _statusText() {
    switch (_status) {
      case BridgeConnectionStatus.disconnected:
        return '已断开';
      case BridgeConnectionStatus.connecting:
        return '连接中...';
      case BridgeConnectionStatus.connected:
        return '已连接';
      case BridgeConnectionStatus.reconnecting:
        return '重连中...';
    }
  }

  Color _statusColor() {
    switch (_status) {
      case BridgeConnectionStatus.connected:
        return Colors.green;
      case BridgeConnectionStatus.connecting:
      case BridgeConnectionStatus.reconnecting:
        return Colors.orange;
      case BridgeConnectionStatus.disconnected:
        return Colors.red;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_threadTitle ?? '聊天'),
            if (_workspace != null)
              Text(
                _workspace!,
                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.normal),
              ),
          ],
        ),
        actions: [
          // Agent 终止按钮
          if (_activeAgentRequestId != null)
            IconButton(
              icon: const Icon(Icons.stop_circle, color: Colors.red),
              onPressed: _handleAbort,
              tooltip: '终止 Agent',
            ),
          // 状态指示器
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _statusColor(),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  _statusText(),
                  style: const TextStyle(fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          // 项目状态栏
          if (_modelLabel != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              child: Row(
                children: [
                  const Icon(Icons.smart_toy, size: 16),
                  const SizedBox(width: 8),
                  Text(
                    '模型: $_modelLabel',
                    style: const TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
          
          // Agent 确认弹窗
          if (_pendingConfirmId != null)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.all(8),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.amber.withValues(alpha: 0.1),
                border: Border.all(color: Colors.amber),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.warning_amber, color: Colors.amber, size: 20),
                      const SizedBox(width: 8),
                      const Text(
                        'Agent 请求确认',
                        style: TextStyle(fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(_pendingConfirmMessage ?? ''),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      TextButton(
                        onPressed: () => _handleConfirm(false),
                        child: const Text('拒绝'),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: () => _handleConfirm(true),
                        child: const Text('允许'),
                      ),
                    ],
                  ),
                ],
              ),
            ),

          // 消息列表
          Expanded(
            child: _messages.isEmpty
                ? const Center(child: Text('等待消息...'))
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(12),
                    itemCount: _messages.length,
                    itemBuilder: (context, index) {
                      final msg = _messages[index];
                      return MessageBubble(message: msg);
                    },
                  ),
          ),

          // 底部输入框
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.05),
                  blurRadius: 4,
                  offset: const Offset(0, -2),
                ),
              ],
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _textController,
                    decoration: const InputDecoration(
                      hintText: '输入消息...',
                      border: OutlineInputBorder(),
                      contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    ),
                    maxLines: null,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _handleSend(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _status == BridgeConnectionStatus.connected ? _handleSend : null,
                  child: const Icon(Icons.send),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
