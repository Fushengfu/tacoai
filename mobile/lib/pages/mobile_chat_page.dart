import 'dart:async';
import 'package:flutter/material.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import '../widgets/message_bubble.dart';
import '../widgets/confirm_banner.dart';

/// 移动端聊天主页面
///
/// 功能：
/// - 顶部显示项目状态（workspace、model、threadTitle）
/// - 中部消息列表（支持流式更新、Markdown 渲染、Agent 步骤展示）
/// - 底部输入框（发送消息、Agent确认/终止）
/// - 滚动到顶部按钮
///
/// 注意：当 showAppBar 为 false 时，由父组件（HubPage）提供 AppBar
class MobileChatPage extends StatefulWidget {
  final BridgeClient client;
  final bool showAppBar;

  const MobileChatPage({
    super.key,
    required this.client,
    this.showAppBar = true,
  });

  @override
  State<MobileChatPage> createState() => _MobileChatPageState();
}

class _MobileChatPageState extends State<MobileChatPage> {
  final ScrollController _scrollController = ScrollController();
  final TextEditingController _textController = TextEditingController();

  // 使用 ValueNotifier 分离消息列表状态，减少 setState 范围
  late ValueNotifier<List<BridgeChatMessage>> _messagesNotifier;
  BridgeConnectionStatus _status = BridgeConnectionStatus.disconnected;

  // 项目状态
  String? _workspace;
  String? _modelLabel;
  String? _modelConfigId;
  String? _threadTitle;
  String? _projectTitle;
  String? _threadId;
  BridgeTokenUsage? _tokenUsage;

  // 可用模型列表
  List<BridgeModelConfig> _availableModels = [];

  // 待确认列表（顶部弹窗）
  List<BridgePendingConfirm> _pendingConfirms = [];

  // Agent 确认已整合到消息气泡内的 AgentStepWidget 中

  // 滚动到顶部按钮可见性
  bool _showScrollToTop = false;
  // 用户是否在底部（距离底部 < 100px 视为在底部）
  bool _isAtBottom = true;
  // 用户是否正在手动滚动（手动滚动期间禁止自动跟随）
  bool _userIsScrolling = false;
  // 是否正在加载更早的消息
  bool _isLoadingOlder = false;
  // 当前已加载消息的起始 seq（用于分页加载更早消息）
  int? _oldestSeq;
  // 消息总数（用于判断是否还有更早的消息）
  int? _totalMessageCount;

  // Delta 更新合并机制
  bool _pendingDeltaUpdate = false;
  Timer? _deltaUpdateTimer;

  // 切换项目加载状态
  bool _isSwitchingProject = false;

  @override
  void initState() {
    super.initState();
    final currentStatus = widget.client.status;
    _status = currentStatus.status;
    _messagesNotifier = ValueNotifier<List<BridgeChatMessage>>(List.from(widget.client.messages));

    widget.client.onStatusChange(_onStatusChange);
    widget.client.onMessage(_onMessage);
    widget.client.onConfirmChange(_onConfirmChange);

    // 监听滚动位置，控制"滚动到顶部"按钮显示
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _textController.dispose();
    _messagesNotifier.dispose();
    _deltaUpdateTimer?.cancel();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final offset = _scrollController.offset;
    final maxOffset = _scrollController.position.maxScrollExtent;
    final show = offset > 300 && maxOffset > 0;
    if (show != _showScrollToTop) {
      setState(() => _showScrollToTop = show);
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

  void _onStatusChange(BridgeStatus status) {
    if (!mounted) return;
    setState(() {
      _status = status.status;
    });

    if (status.status == BridgeConnectionStatus.disconnected && status.error != null) {
      _showToast('连接断开: ${status.error}');
    }
  }

  void _onConfirmChange(List<BridgePendingConfirm> confirms) {
    if (!mounted) return;
    setState(() {
      // 显示所有项目的确认请求（不过滤）
      // 确认发送时会验证项目隔离，确保安全
      _pendingConfirms = confirms;
    });
  }

  void _onMessage(dynamic data) {
    if (!mounted) return;

    final json = data as Map<String, dynamic>;
    final type = json['type'] as String?;

    // 判断是否是切换项目导致的全量状态同步
    final isFullStateSync = type == 'bridge:state';

    // 增量更新：只更新变化的部分，避免全量替换
    if (type == 'bridge:state') {
      final state = BridgeState.fromJson(json);
      // 关键修复：不在 bridge:state 中清除 _isSwitchingProject
      // 只在 bridge:project-switched 中清除，避免快照先于响应到达导致提前清除
      // 只更新变化的字段，减少 setState 范围
      bool needUpdate = false;
      if (_workspace != state.workspace) { _workspace = state.workspace; needUpdate = true; }
      if (_modelLabel != state.modelLabel) { _modelLabel = state.modelLabel; needUpdate = true; }
      if (_modelConfigId != state.modelConfigId) { _modelConfigId = state.modelConfigId; needUpdate = true; }
      if (_threadTitle != state.threadTitle) { _threadTitle = state.threadTitle; needUpdate = true; }
      if (_projectTitle != state.projectTitle) { _projectTitle = state.projectTitle; needUpdate = true; }
      if (_threadId != state.threadId) { _threadId = state.threadId; needUpdate = true; }
      if (_tokenUsage != state.tokenUsage) { _tokenUsage = state.tokenUsage; needUpdate = true; }
      
      // 消息列表通过 ValueNotifier 更新，不触发 setState
      _messagesNotifier.value = List.from(widget.client.messages);
      
      if (needUpdate) {
        setState(() {});
      }
      // 首次连接或切换项目后自动加载模型列表
      if (_availableModels.isEmpty) {
        _loadModels();
      }
    } else if (type == 'bridge:agent-event') {
      // Agent 事件：立即更新消息列表（不触发 setState，仅更新 ValueNotifier）
      _messagesNotifier.value = List.from(widget.client.messages);
    } else if (type == 'bridge:chat-delta') {
      // 聊天流增量：使用 Future.delayed(0) 合并同一帧内的多次 delta 更新
      // 避免高频 delta 导致 UI 过度重建
      _pendingDeltaUpdate = true;
      _deltaUpdateTimer?.cancel();
      _deltaUpdateTimer = Timer(Duration.zero, () {
        if (_pendingDeltaUpdate && mounted) {
          _pendingDeltaUpdate = false;
          _messagesNotifier.value = List.from(widget.client.messages);
        }
      });
    } else if (type == 'bridge:chat-user-message') {
      // 用户消息：立即更新消息列表
      _messagesNotifier.value = List.from(widget.client.messages);
    } else if (type == 'bridge:project-cleared' || type == 'bridge:messages-cleared') {
      // 切换项目时清空消息列表，显示加载状态
      _messagesNotifier.value = [];
      // 不清除待确认弹窗，保留所有项目的确认请求
      setState(() {
        _isSwitchingProject = true;
      });
    } else if (type == 'bridge:project-switched') {
      // 切换项目完成，隐藏加载指示器
      if (_isSwitchingProject) {
        setState(() => _isSwitchingProject = false);
      }
      _messagesNotifier.value = List.from(widget.client.messages);
    } else {
      // 其他消息类型，更新消息列表
      _messagesNotifier.value = List.from(widget.client.messages);
    }

    // 全量状态同步（切换项目/首次连接）时始终滚动到底部
    if (isFullStateSync) {
      if (!_userIsScrolling) {
        _isAtBottom = true;
        _scrollToBottom();
      }
    } else if (_isAtBottom && !_userIsScrolling) {
      // 仅当用户在底部且未手动滚动时才自动跟随
      _scrollToBottom();
    }
  }

  /// 滚动到顶部时触发加载更早消息
  void _onScrollToTop() async {
    if (_isLoadingOlder) return;
    if (_totalMessageCount == null) return;
    if (_oldestSeq == null || _oldestSeq! <= 0) return;
    // 如果已加载的消息数 >= 总数，说明没有更早的消息了
    final currentCount = widget.client.messages.length;
    if (currentCount >= _totalMessageCount!) return;

    setState(() => _isLoadingOlder = true);
    try {
      final result = await widget.client.requestOlderMessages(beforeSeq: _oldestSeq!);
      if (!mounted) return;
      setState(() {
        _isLoadingOlder = false;
        // 将更早的消息插入到现有消息列表前面
        final olderMessages = result.messages;
        if (olderMessages.isNotEmpty) {
          final existingMessages = List<BridgeChatMessage>.from(widget.client.messages);
          // 去重：只添加不存在的消息
          final existingIds = existingMessages.map((m) => m.id).toSet();
          final newMessages = olderMessages.where((m) => !existingIds.contains(m.id)).toList();
          _messagesNotifier.value = [...newMessages, ...existingMessages];
          // 更新 oldestSeq
          if (result.startSeq != null) {
            _oldestSeq = result.startSeq;
          }
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoadingOlder = false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients && _scrollController.position.maxScrollExtent > 0) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _scrollToTop() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 400),
        curve: Curves.easeInOut,
      );
    }
  }

  void _handleSend() {
    final text = _textController.text.trim();
    if (text.isEmpty) return;

    widget.client.sendChatMessage(text);
    _textController.clear();
    // 发送消息后自动滚动到底部
    _scrollToBottom();
  }

  // _handleConfirm 已不再需要，确认操作由 AgentStepWidget 内部处理

  void _handleAbort() {
    // 优先使用 originalRequestId（对应桌面端 agentAbortControllers 的 key）
    // 如果为空则 fallback 到 activeAgentRequestId
    String? abortRequestId = widget.client.activeOriginalRequestId;
    if (abortRequestId == null || abortRequestId.isEmpty) {
      abortRequestId = widget.client.activeAgentRequestId;
    }
    if (abortRequestId != null && abortRequestId.isNotEmpty) {
      widget.client.sendAgentAbort(abortRequestId);
    }
  }

  /// 判断当前项目是否正在发送/处理中（按项目隔离）
  /// 
  /// 权威数据源：_projectActiveTasks（桌面端推送的项目级活跃任务状态）
  /// 桌面端在 Agent/Chat 开始和结束时都会推送 isProcessing/activeTaskId
  /// 手机端只信任桌面端推送的状态，不扫描本地消息列表
  bool _isCurrentProjectSending() {
    // 关键修复：使用 _currentProjectId（用户主动切换的项目）而不是 _threadId（可能滞后）
    final projectId = _threadId ?? widget.client.currentProjectId;
    
    // 优先使用桌面端推送的活跃任务状态（唯一权威来源）
    if (projectId != null && projectId.isNotEmpty) {
      final activeTask = widget.client.getActiveTaskForProject(projectId);
      // activeTask 非空 = 桌面端确认正在处理
      // activeTask 为空 = 桌面端已确认任务完成
      return activeTask != null && activeTask.isNotEmpty;
    }
    
    // 兜底：使用全局 activeAgentRequestId（仅当 projectId 为空时）
    return widget.client.activeAgentRequestId != null && widget.client.activeAgentRequestId!.isNotEmpty;
  }

  Future<void> _loadModels() async {
    try {
      final modelsList = await widget.client.requestModels();
      if (!mounted) return;
      setState(() {
        _availableModels = modelsList.models;
        // 如果当前 modelConfigId 为空，使用活跃的
        if (_modelConfigId == null || _modelConfigId!.isEmpty) {
          _modelConfigId = modelsList.activeModelConfigId;
        }
      });
    } catch (_) {
      // 加载失败不影响使用
    }
  }

  void _showModelPicker() {
    if (_availableModels.isEmpty) {
      _loadModels().then((_) {
        if (_availableModels.isNotEmpty) {
          _showModelPickerSheet();
        }
      });
      return;
    }
    _showModelPickerSheet();
  }

  void _showModelPickerSheet() {
    final colorScheme = Theme.of(context).colorScheme;
    showModalBottomSheet(
      context: context,
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Row(
                  children: [
                    Icon(Icons.smart_toy, size: 20, color: colorScheme.primary),
                    const SizedBox(width: 8),
                    Text(
                      '选择模型',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: colorScheme.onSurface,
                      ),
                    ),
                    const Spacer(),
                    IconButton(
                      icon: const Icon(Icons.refresh, size: 20),
                      onPressed: () {
                        Navigator.pop(ctx);
                        _loadModels().then((_) {
                          if (_availableModels.isNotEmpty) {
                            _showModelPickerSheet();
                          }
                        });
                      },
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: _availableModels.length,
                  itemBuilder: (context, index) {
                    final model = _availableModels[index];
                    final isActive = model.id == _modelConfigId;
                    return ListTile(
                      leading: Icon(
                        isActive ? Icons.check_circle : Icons.circle_outlined,
                        color: isActive ? colorScheme.primary : Colors.grey,
                        size: 22,
                      ),
                      title: Text(
                        model.displayLabel,
                        style: TextStyle(
                          fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
                          fontSize: 14,
                        ),
                      ),
                      subtitle: Text(
                        model.provider,
                        style: const TextStyle(fontSize: 11, color: Colors.grey),
                      ),
                      trailing: model.supportsVision
                          ? Icon(Icons.image, size: 16, color: Colors.grey.shade500)
                          : null,
                      onTap: () async {
                        Navigator.pop(ctx);
                        if (model.id == _modelConfigId) return;
                        try {
                          await widget.client.switchModel(model.id);
                          if (!mounted) return;
                          setState(() {
                            _modelConfigId = model.id;
                            _modelLabel = model.displayLabel;
                          });
                          _showToast('已切换模型: ${model.displayLabel}');
                        } catch (e) {
                          if (!mounted) return;
                          _showToast('切换失败: $e');
                        }
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
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

  String _formatTokenCount(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return '$n';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    final chatContent = Stack(
      children: [
        Column(
          children: [
            // 项目状态栏
            if (_modelLabel != null || _projectTitle != null)
              Material(
                color: colorScheme.surfaceContainerHighest,
                child: InkWell(
                  onTap: _modelLabel != null ? _showModelPicker : null,
                  child: Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Row(
                      children: [
                        if (_projectTitle != null) ...[
                          Icon(Icons.folder, size: 16, color: colorScheme.secondary),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              _projectTitle!,
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                                color: colorScheme.onSurfaceVariant,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 12),
                        ],
                        if (_modelLabel != null) ...[
                          Icon(Icons.smart_toy, size: 16, color: colorScheme.primary),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              '模型: $_modelLabel',
                              style: TextStyle(
                                fontSize: 12,
                                color: colorScheme.onSurfaceVariant,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          Icon(
                            Icons.keyboard_arrow_down,
                            size: 16,
                            color: colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),

            // 顶部确认弹窗
            ConfirmBanner(
              confirms: _pendingConfirms,
              onConfirm: (confirmId, approved) {
                widget.client.sendAgentConfirm(confirmId, approved);
              },
              getProjectTitle: (projectId) {
                // 从缓存的项目列表中查找项目名称
                if (projectId == null) return null;
                try {
                  final projects = widget.client.cachedProjects;
                  if (projects != null) {
                    final project = projects.firstWhere(
                      (p) => p.id == projectId,
                      orElse: () => BridgeProjectInfo(id: projectId, title: '', workspace: null, sessions: []),
                    );
                    return project.title.isNotEmpty ? project.title : null;
                  }
                } catch (_) {}
                return null;
              },
            ),

            // 消息列表
            Expanded(
              child: NotificationListener<ScrollNotification>(
                onNotification: (notification) {
                  if (notification is ScrollStartNotification) {
                    // 用户开始手动滚动，标记并阻止自动跟随
                    _userIsScrolling = true;
                  } else if (notification is ScrollEndNotification) {
                    // 滚动结束，恢复自动跟随
                    _userIsScrolling = false;
                    if (_scrollController.hasClients) {
                      final maxScroll = _scrollController.position.maxScrollExtent;
                      final currentScroll = _scrollController.position.pixels;
                      _isAtBottom = (maxScroll - currentScroll) < 100;
                    }
                  } else if (notification is ScrollUpdateNotification) {
                    // 滚动过程中实时更新状态
                    if (_scrollController.hasClients) {
                      final maxScroll = _scrollController.position.maxScrollExtent;
                      final currentScroll = _scrollController.position.pixels;
                      _isAtBottom = (maxScroll - currentScroll) < 100;
                    }
                  } else if (notification is OverscrollNotification) {
                    // 滚动到顶部边缘时触发加载更早消息
                    if (notification.overscroll < -50 && !_isLoadingOlder && _scrollController.offset <= 0) {
                      _onScrollToTop();
                    }
                  }
                  return true;
                },
                child: ValueListenableBuilder<List<BridgeChatMessage>>(
                  valueListenable: _messagesNotifier,
                  builder: (context, messages, child) {
                    return messages.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (_isSwitchingProject) ...[
                              const SizedBox(
                                width: 36,
                                height: 36,
                                child: CircularProgressIndicator(strokeWidth: 3),
                              ),
                              const SizedBox(height: 16),
                              Text(
                                '正在同步项目数据...',
                                style: TextStyle(
                                  fontSize: 14,
                                  color: colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ] else ...[
                              Icon(
                                Icons.chat_bubble_outline,
                                size: 48,
                                color: colorScheme.onSurfaceVariant.withValues(alpha: 0.3),
                              ),
                              const SizedBox(height: 12),
                              Text(
                                '等待消息...',
                                style: TextStyle(
                                  fontSize: 14,
                                  color: colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                            // 空状态时显示当前项目信息
                            if (_projectTitle != null) ...[
                              const SizedBox(height: 16),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                                decoration: BoxDecoration(
                                  color: colorScheme.primaryContainer.withValues(alpha: 0.3),
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(
                                    color: colorScheme.primary.withValues(alpha: 0.2),
                                  ),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(
                                      Icons.folder_open,
                                      size: 16,
                                      color: colorScheme.primary,
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      _projectTitle!,
                                      style: TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.w600,
                                        color: colorScheme.primary,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ],
                        ),
                      )
                    : ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        itemCount: messages.length + (_projectTitle != null ? 1 : 0),
                        itemBuilder: (context, index) {
                          // 第一条显示项目信息卡片
                          if (_projectTitle != null && index == 0) {
                            return Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                decoration: BoxDecoration(
                                  color: colorScheme.primaryContainer.withValues(alpha: 0.2),
                                  borderRadius: BorderRadius.circular(10),
                                  border: Border.all(
                                    color: colorScheme.primary.withValues(alpha: 0.15),
                                  ),
                                ),
                                child: Row(
                                  children: [
                                    Icon(
                                      Icons.folder_open,
                                      size: 18,
                                      color: colorScheme.primary,
                                    ),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            '当前项目',
                                            style: TextStyle(
                                              fontSize: 10,
                                              color: colorScheme.onSurfaceVariant,
                                            ),
                                          ),
                                          Text(
                                            _projectTitle!,
                                            style: TextStyle(
                                              fontSize: 14,
                                              fontWeight: FontWeight.w600,
                                              color: colorScheme.primary,
                                            ),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ],
                                      ),
                                    ),
                                    if (_modelLabel != null)
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                        decoration: BoxDecoration(
                                          color: colorScheme.surfaceContainerHighest,
                                          borderRadius: BorderRadius.circular(6),
                                        ),
                                        child: Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Icon(
                                              Icons.smart_toy,
                                              size: 12,
                                              color: colorScheme.primary,
                                            ),
                                            const SizedBox(width: 4),
                                            Text(
                                              _modelLabel!,
                                              style: TextStyle(
                                                fontSize: 11,
                                                color: colorScheme.onSurfaceVariant,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            );
                          }
                          final msg = messages[_projectTitle != null ? index - 1 : index];
                          return MessageBubble(
                            message: msg,
                          );
                        },
                      );
                  },
                ),
              ),
            ),

            // 底部输入框
            Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              decoration: BoxDecoration(
                color: colorScheme.surface,
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.08),
                    blurRadius: 8,
                    offset: const Offset(0, -2),
                  ),
                ],
              ),
              child: SafeArea(
                top: false,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _textController,
                        decoration: InputDecoration(
                          hintText: '输入消息...',
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(24),
                          ),
                          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                          filled: true,
                          fillColor: colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
                        ),
                        maxLines: null,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => _handleSend(),
                      ),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      height: 44,
                      child: FilledButton(
                        onPressed: _status == BridgeConnectionStatus.connected
                            ? (_isCurrentProjectSending() ? _handleAbort : _handleSend)
                            : null,
                        style: FilledButton.styleFrom(
                          shape: const CircleBorder(),
                          padding: const EdgeInsets.all(12),
                          backgroundColor: _isCurrentProjectSending()
                              ? Colors.red.shade400
                              : null,
                        ),
                        child: _isCurrentProjectSending()
                            ? const Icon(Icons.stop, size: 20, color: Colors.white)
                            : const Icon(Icons.send, size: 20),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),

        // 滚动到顶部按钮
        if (_showScrollToTop)
          Positioned(
            right: 16,
            bottom: 80,
            child: Material(
              color: colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(20),
              elevation: 4,
              child: InkWell(
                onTap: _scrollToTop,
                borderRadius: BorderRadius.circular(20),
                child: const Padding(
                  padding: EdgeInsets.all(10),
                  child: Icon(Icons.keyboard_arrow_up, size: 24),
                ),
              ),
            ),
          ),
      ],
    );

    if (widget.showAppBar) {
      return Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Expanded(
                    child: Text(
                      _threadTitle ?? '聊天',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (_projectTitle != null) ...[
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.blue.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        _projectTitle!,
                        style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w500),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ],
              ),
              if (_tokenUsage != null)
                Text(
                  'Token: ${_formatTokenCount(_tokenUsage!.totalTokens ?? 0)} / ${_tokenUsage!.promptTokens ?? 0}P+${_tokenUsage!.completionTokens ?? 0}C',
                  style: const TextStyle(fontSize: 10, color: Colors.grey),
                ),
            ],
          ),
          actions: [
            if (_isCurrentProjectSending())
              IconButton(
                icon: const Icon(Icons.stop_circle, color: Colors.red),
                onPressed: _handleAbort,
                tooltip: '终止 Agent',
              ),
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
        body: chatContent,
      );
    }

    return Scaffold(
      body: chatContent,
    );
  }
}
