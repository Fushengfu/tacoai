import 'package:flutter/material.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import '../widgets/message_bubble.dart';

/// 桥接视图页面 - 显示桌面端桥接过来的对话和 Agent 事件
class BridgeViewPage extends StatefulWidget {
  final BridgeClient client;

  const BridgeViewPage({super.key, required this.client});

  @override
  State<BridgeViewPage> createState() => _BridgeViewPageState();
}

class _BridgeViewPageState extends State<BridgeViewPage> {
  final ScrollController _scrollController = ScrollController();
  List<BridgeChatMessage> _messages = [];
  BridgeConnectionStatus _status = BridgeConnectionStatus.disconnected;
  int _clientCount = 0;

  @override
  void initState() {
    super.initState();
    widget.client.onStatusChange(_onStatusChange);
    widget.client.onMessage(_onMessage);
    _messages = widget.client.messages;
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _onStatusChange(BridgeStatus status) {
    if (!mounted) return;
    setState(() {
      _status = status.status;
    });

    if (status.status == BridgeConnectionStatus.disconnected && status.error != null) {
      _showToast(status.error!);
    }
  }

  void _showToast(String message) {
    if (!mounted) return;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) {
        Future.delayed(const Duration(seconds: 1), () {
          if (Navigator.canPop(ctx)) Navigator.pop(ctx);
        });
        return Material(
          color: Colors.transparent,
          child: Center(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
              decoration: BoxDecoration(
                color: Colors.black87,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                message,
                style: const TextStyle(color: Colors.white, fontSize: 14),
                textAlign: TextAlign.center,
              ),
            ),
          ),
        );
      },
    );
  }

  void _onMessage(dynamic data) {
    if (!mounted) return;
    setState(() {
      _messages = List.unmodifiable(widget.client.messages);
    });
    _scrollToBottom();
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('桥接视图'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: Text(
                _statusText(),
                style: TextStyle(
                  fontSize: 12,
                  color: _status == BridgeConnectionStatus.connected
                      ? Colors.green
                      : Colors.grey,
                ),
              ),
            ),
          ),
        ],
      ),
      body: _messages.isEmpty
          ? const Center(child: Text('等待桥接数据...'))
          : ListView.builder(
              controller: _scrollController,
              padding: const EdgeInsets.all(12),
              itemCount: _messages.length,
              itemBuilder: (context, index) {
                final msg = _messages[index];
                return MessageBubble(message: msg);
              },
            ),
    );
  }
}
