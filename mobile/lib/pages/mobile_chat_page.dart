import 'dart:async';
import 'package:flutter/material.dart';
import 'package:audioplayers/audioplayers.dart';
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
  final FocusNode _focusNode = FocusNode();

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

  // 待重试确认列表（网络超时/空响应等可恢复错误）
  List<BridgePendingRetry> _pendingRetries = [];

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
  // 切换项目超时保护（防止响应丢失导致永久加载）
  Timer? _switchProjectTimeout;
  // 最近一次切换的项目 ID（用于快速连续切换时只响应最新一次）
  String? _pendingSwitchProjectId;

  // 处理状态追踪（用于检测发送按钮是否需要更新）
  bool _wasProcessing = false;

  // 任务完成提示音播放器
  final AudioPlayer _taskCompletePlayer = AudioPlayer();
  bool _soundInitialized = false;

  @override
  void initState() {
    super.initState();
    final currentStatus = widget.client.status;
    _status = currentStatus.status;
    // 直接使用 bridge_client 的 messagesNotifier，避免 List.from 拷贝
    _messagesNotifier = widget.client.messagesNotifier;

    widget.client.onStatusChange(_onStatusChange);
    widget.client.onMessage(_onMessage);
    widget.client.onConfirmChange(_onConfirmChange);
    widget.client.onRetryChange(_onRetryChange);

    // 初始化处理状态追踪
    _wasProcessing = _isCurrentProjectSending();

    // 初始化提示音播放器
    _initializeSound();

    // 初始化时立即从缓存解析项目标题和模型信息（不等 bridge:state）
    // 使用 addPostFrameCallback 确保 build 完成后再调用 setState
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _resolveProjectHeaderInfo(widget.client.currentProjectId);
        // 初始化时同步确认/重试列表（按当前项目过滤）
        _syncPendingItems();
      }
    });

    // 监听滚动位置，控制"滚动到顶部"按钮显示
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _textController.dispose();
    _focusNode.dispose();
    // 不 dispose _messagesNotifier，因为它是 bridge_client 的属性
    _deltaUpdateTimer?.cancel();
    _switchProjectTimeout?.cancel();
    _taskCompletePlayer.dispose();
    widget.client.removeRetryListener(_onRetryChange);
    super.dispose();
  }

  /// 初始化提示音播放器
  Future<void> _initializeSound() async {
    try {
      await _taskCompletePlayer.setSource(AssetSource('task_complete.wav'));
      await _taskCompletePlayer.setVolume(0.5); // 设置音量为 50%
      _soundInitialized = true;
    } catch (e) {
      print('[MobileChatPage] 提示音初始化失败: $e');
    }
  }

  /// 播放任务完成提示音
  void _playTaskCompleteSound() {
    if (_soundInitialized && mounted) {
      try {
        _taskCompletePlayer.resume();
      } catch (e) {
        print('[MobileChatPage] 播放提示音失败: $e');
      }
    }
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final offset = _scrollController.offset;
    final maxOffset = _scrollController.position.maxScrollExtent;
    final show = offset > 300 && maxOffset > 0;
    if (show != _showScrollToTop) {
      setState(() => _showScrollToTop = show);
    }
    // 实时更新 _isAtBottom 状态
    final distanceToBottom = maxOffset - offset;
    _isAtBottom = distanceToBottom < 200; // 距离底部 200px 以内视为在底部
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
    _syncPendingItems();
  }

  void _onRetryChange(List<BridgePendingRetry> retries) {
    if (!mounted) return;
    _syncPendingItems();
  }

  /// 同步确认/重试列表（按当前项目过滤）
  void _syncPendingItems() {
    if (!mounted) return;
    final currentProjectId = widget.client.currentProjectId;
    setState(() {
      _pendingConfirms = widget.client.pendingConfirms
          .where((c) => c.projectId == currentProjectId)
          .toList();
      _pendingRetries = widget.client.pendingRetries
          .where((r) => r.projectId == currentProjectId)
          .toList();
    });
  }

  void _onMessage(dynamic data) {
    if (!mounted) return;

    final json = data as Map<String, dynamic>;
    final type = json['type'] as String?;

    // 判断是否是切换项目导致的全量状态同步
    final isFullStateSync = type == 'bridge:state';

    // 关键：在更新消息列表之前记录用户是否在底部
    // 因为更新消息列表后 maxScrollExtent 会变化，导致 _isAtBottom 可能变为 false
    final wasAtBottom = _isAtBottom;

    // 增量更新：只更新变化的部分，避免全量替换
    if (type == 'bridge:state') {
      final state = BridgeState.fromJson(json);
      // 只更新变化的字段，减少 setState 范围
      bool needUpdate = false;
      if (_workspace != state.workspace) { _workspace = state.workspace; needUpdate = true; }
      if (_modelLabel != state.modelLabel) { _modelLabel = state.modelLabel; needUpdate = true; }
      if (_modelConfigId != state.modelConfigId) { _modelConfigId = state.modelConfigId; needUpdate = true; }
      if (_threadTitle != state.threadTitle) { _threadTitle = state.threadTitle; needUpdate = true; }
      if (_projectTitle != state.projectTitle) { _projectTitle = state.projectTitle; needUpdate = true; }
      if (_threadId != state.threadId) { _threadId = state.threadId; needUpdate = true; }
      if (_tokenUsage != state.tokenUsage) { _tokenUsage = state.tokenUsage; needUpdate = true; }
      
      // 如果 modelLabel 为空但有 modelConfigId，从缓存的模型列表中查找显示名称
      if ((_modelLabel == null || _modelLabel!.isEmpty) && _modelConfigId != null && _modelConfigId!.isNotEmpty) {
        _modelLabel = _resolveModelDisplayName(_modelConfigId!);
        if (_modelLabel != null && _modelLabel!.isNotEmpty) needUpdate = true;
      }

      // 消息列表由 bridge_client 的 _updateMessagesNotifier 负责更新
      
      // 同步处理状态（bridge:state 可能携带 activeAgentRequestId）
      final isNowProcessing = _isCurrentProjectSending();
      if (isNowProcessing != _wasProcessing) {
        // 任务完成时播放提示音（从处理中变为空闲）
        if (_wasProcessing && !isNowProcessing) {
          _playTaskCompleteSound();
        }
        _wasProcessing = isNowProcessing;
        needUpdate = true;
      }
      
      if (needUpdate) {
        setState(() {});
      }
      // 首次连接或切换项目后自动加载模型列表
      if (_availableModels.isEmpty) {
        _loadModels();
      }
      // bridge:state 到达且有消息时，清除切换项目加载状态
      if (_isSwitchingProject && widget.client.messages.isNotEmpty) {
        _switchProjectTimeout?.cancel();
        setState(() {
          _isSwitchingProject = false;
        });
      }
    } else if (type == 'bridge:agent-event') {
      // Agent 事件：消息列表由 bridge_client 的 _updateMessagesNotifier 负责更新
      // 检查处理状态是否变化，如果变化则触发 setState 更新发送按钮
      final isNowProcessing = _isCurrentProjectSending();
      if (isNowProcessing != _wasProcessing) {
        // 任务完成时播放提示音（从处理中变为空闲）
        if (_wasProcessing && !isNowProcessing) {
          _playTaskCompleteSound();
        }
        _wasProcessing = isNowProcessing;
        setState(() {});
      }
    } else if (type == 'bridge:chat-delta') {
      // 聊天流增量：使用 Future.delayed(0) 合并同一帧内的多次 delta 更新
      // 避免高频 delta 导致 UI 过度重建
      _pendingDeltaUpdate = true;
      _deltaUpdateTimer?.cancel();
      _deltaUpdateTimer = Timer(Duration.zero, () {
        if (_pendingDeltaUpdate && mounted) {
          _pendingDeltaUpdate = false;
          // 消息列表由 bridge_client 的 _updateMessagesNotifier 负责更新
          // 检查处理状态是否变化（delta done=true 时清除处理状态）
          final isNowProcessing = _isCurrentProjectSending();
          if (isNowProcessing != _wasProcessing) {
            // 任务完成时播放提示音（从处理中变为空闲）
            if (_wasProcessing && !isNowProcessing) {
              _playTaskCompleteSound();
            }
            _wasProcessing = isNowProcessing;
            setState(() {});
          }
        }
      });
    } else if (type == 'bridge:chat-user-message') {
      // 用户消息：消息列表由 bridge_client 的 _updateMessagesNotifier 负责更新
    } else if (type == 'bridge:project-cleared' || type == 'bridge:messages-cleared') {
      // 切换项目时清空消息列表，显示加载状态
      // 不清除待确认弹窗，保留所有项目的确认请求
      if (!_isSwitchingProject) {
        setState(() {
          _isSwitchingProject = true;
        });
      }
      // 记录待切换的项目 ID（用于快速连续切换时只响应最新一次）
      _pendingSwitchProjectId = json['threadId'] as String? ?? _pendingSwitchProjectId;

      // 切换项目时收起键盘，避免自动弹出
      _focusNode.unfocus();

      // 立即从缓存查找项目名称和模型信息（不等 bridge:state 到达）
      _resolveProjectHeaderInfo(_pendingSwitchProjectId ?? widget.client.currentProjectId);

      // 启动超时保护（5秒后自动清除加载状态，避免永久卡住）
      _switchProjectTimeout?.cancel();
      _switchProjectTimeout = Timer(const Duration(seconds: 5), () {
        if (_isSwitchingProject && mounted) {
          setState(() {
            _isSwitchingProject = false;
          });
        }
      });
    } else if (type == 'bridge:project-switched') {
      // 切换项目完成，隐藏加载指示器
      _switchProjectTimeout?.cancel();
      _pendingSwitchProjectId = null;
      if (_isSwitchingProject) {
        setState(() => _isSwitchingProject = false);
      }

      // 切换项目完成时收起键盘
      _focusNode.unfocus();

      // 立即更新项目标题和模型信息（bridge:project-switched 比 bridge:state 先到达）
      _resolveProjectHeaderInfo(widget.client.currentProjectId);

      // 重新过滤确认和重试请求（显示当前项目的）
      _syncPendingItems();
      // 切换项目完成后自动滚动到底部
      if (!_userIsScrolling) {
        _isAtBottom = true;
        _scrollToBottom();
      }
    } else if (type == 'bridge:cache-loaded') {
      // 缓存加载完成，如果有消息则隐藏加载指示器
      final count = json['count'] as int? ?? 0;
      if (count > 0 && _isSwitchingProject) {
        _switchProjectTimeout?.cancel();
        setState(() => _isSwitchingProject = false);
      }
      // 缓存加载完成后自动滚动到底部
      if (count > 0 && !_userIsScrolling) {
        _isAtBottom = true;
        _scrollToBottom();
      }
    } else {
      // 其他消息类型（包括 bridge:project-states、bridge:task-status-polled 等）
      // 如果有消息到达且正在切换项目，说明数据已同步完成
      if (_isSwitchingProject && widget.client.messages.isNotEmpty) {
        _switchProjectTimeout?.cancel();
        setState(() => _isSwitchingProject = false);
      }
      // 检查处理状态是否变化（bridge:project-states / bridge:task-status-polled 可能改变处理状态）
      final isNowProcessing = _isCurrentProjectSending();
      if (isNowProcessing != _wasProcessing) {
        // 任务完成时播放提示音（从处理中变为空闲）
        if (_wasProcessing && !isNowProcessing) {
          _playTaskCompleteSound();
        }
        _wasProcessing = isNowProcessing;
        setState(() {});
      }
      // 如果模型名称为空，尝试从缓存解析（bridge:project-states 可能已更新 modelConfigId）
      if (_modelLabel == null || _modelLabel!.isEmpty) {
        _resolveProjectHeaderInfo(widget.client.currentProjectId);
      }
    }

    // 全量状态同步（切换项目/首次连接）时始终滚动到底部
    if (isFullStateSync) {
      if (!_userIsScrolling) {
        _isAtBottom = true;
        _scrollToBottom();
      }
    } else if (wasAtBottom && !_userIsScrolling) {
      // 关键修复：使用更新前的 wasAtBottom 状态判断
      // 因为消息列表更新后 maxScrollExtent 增大，_isAtBottom 可能已变为 false
      // 但用户之前在底部，新内容到达时应该自动跟随
      _isAtBottom = true;
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

  /// 滚动到底部标志（防止高频消息时重复调度滚动任务）
  bool _pendingScrollJob = false;

  void _scrollToBottom() {
    // 使用标志位防止重复调度：如果已有待执行的滚动任务，跳过
    if (_pendingScrollJob) return;
    _pendingScrollJob = true;

    // 单次 addPostFrameCallback + 标志位，确保在下一帧布局完成后执行
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _pendingScrollJob = false;
      if (!mounted) return;
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

  /// 立即从缓存查找项目名称和模型信息（用于切换项目时即时显示，不等 bridge:state）
  void _resolveProjectHeaderInfo(String? projectId) {
    if (projectId == null || projectId.isEmpty) return;

    String? newProjectTitle;
    String? newModelConfigId;

    // 从缓存的项目列表中查找项目信息
    final projects = widget.client.cachedProjects;
    if (projects != null) {
      try {
        final project = projects.firstWhere((p) => p.id == projectId);
        newProjectTitle = project.title.isNotEmpty ? project.title : null;
        newModelConfigId = project.modelConfigId;
      } catch (_) {}
    }

    // 从缓存的模型列表中查找模型显示名称
    String? newModelLabel;
    if (newModelConfigId != null && newModelConfigId.isNotEmpty) {
      newModelLabel = _resolveModelDisplayName(newModelConfigId);
    }

    // 仅在有变化时更新 UI
    if (_projectTitle != newProjectTitle || _modelLabel != newModelLabel || _modelConfigId != newModelConfigId) {
      setState(() {
        if (newProjectTitle != null) _projectTitle = newProjectTitle;
        if (newModelLabel != null && newModelLabel.isNotEmpty) _modelLabel = newModelLabel;
        if (newModelConfigId != null && newModelConfigId.isNotEmpty) _modelConfigId = newModelConfigId;
      });
    }
  }

  /// 从缓存的模型列表中查找指定模型的显示名称
  String? _resolveModelDisplayName(String modelConfigId) {
    if (_availableModels.isNotEmpty) {
      try {
        final model = _availableModels.firstWhere((m) => m.id == modelConfigId);
        return model.displayLabel;
      } catch (_) {}
    }
    return null;
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
        // 模型列表加载完成后，尝试解析当前模型的显示名称
        // 解决系统内置模型在本地 modelConfigs 中找不到导致 modelLabel 为空的问题
        if ((_modelLabel == null || _modelLabel!.isEmpty) && _modelConfigId != null && _modelConfigId!.isNotEmpty) {
          _modelLabel = _resolveModelDisplayName(_modelConfigId!);
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

            // 顶部重试确认弹窗
            _RetryBanner(
              retries: _pendingRetries,
              onRetry: (retryId, shouldRetry) {
                widget.client.sendRetryResponse(retryId, shouldRetry);
              },
              getProjectTitle: (projectId) {
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
                      _isAtBottom = (maxScroll - currentScroll) < 200;
                    }
                  } else if (notification is ScrollUpdateNotification) {
                    // 滚动过程中实时更新状态
                    if (_scrollController.hasClients) {
                      final maxScroll = _scrollController.position.maxScrollExtent;
                      final currentScroll = _scrollController.position.pixels;
                      _isAtBottom = (maxScroll - currentScroll) < 200;
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
                        focusNode: _focusNode,
                        autofocus: false,
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

/// 重试确认弹窗组件
/// 用于展示网络超时/空响应等可恢复错误的重试确认
class _RetryBanner extends StatefulWidget {
  final List<BridgePendingRetry> retries;
  final void Function(String retryId, bool shouldRetry) onRetry;
  final String? Function(String? projectId)? getProjectTitle;

  const _RetryBanner({
    required this.retries,
    required this.onRetry,
    this.getProjectTitle,
  });

  @override
  State<_RetryBanner> createState() => _RetryBannerState();
}

class _RetryBannerState extends State<_RetryBanner>
    with SingleTickerProviderStateMixin {
  late AnimationController _animationController;
  late Animation<Offset> _slideAnimation;

  @override
  void initState() {
    super.initState();
    _animationController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    _slideAnimation = Tween<Offset>(
      begin: const Offset(0, -1),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeOutCubic,
    ));

    if (widget.retries.isNotEmpty) {
      _animationController.forward();
    }
  }

  @override
  void didUpdateWidget(_RetryBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.retries.isEmpty && widget.retries.isNotEmpty) {
      _animationController.forward(from: 0);
    } else if (oldWidget.retries.isNotEmpty && widget.retries.isEmpty) {
      _animationController.reverse();
    }
  }

  @override
  void dispose() {
    _animationController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.retries.isEmpty) return const SizedBox.shrink();

    final colorScheme = Theme.of(context).colorScheme;

    return SlideTransition(
      position: _slideAnimation,
      child: Material(
        elevation: 8,
        color: colorScheme.surface,
        child: SafeArea(
          bottom: false,
          child: Container(
            constraints: const BoxConstraints(maxHeight: 250),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // 标题栏
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  decoration: BoxDecoration(
                    color: Colors.orange.withValues(alpha: 0.15),
                    border: Border(
                      bottom: BorderSide(
                        color: colorScheme.outline.withValues(alpha: 0.2),
                      ),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.refresh,
                        size: 20,
                        color: Colors.orange.shade700,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '异常重试',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: colorScheme.onSurface,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        '${widget.retries.length} 个待确认',
                        style: TextStyle(
                          fontSize: 12,
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                // 重试列表
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: widget.retries.length,
                    itemBuilder: (context, index) {
                      final retry = widget.retries[index];
                      return _RetryCard(
                        retry: retry,
                        colorScheme: colorScheme,
                        onRetry: widget.onRetry,
                        projectTitle: widget.getProjectTitle?.call(retry.projectId),
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 单个重试卡片
class _RetryCard extends StatelessWidget {
  final BridgePendingRetry retry;
  final ColorScheme colorScheme;
  final void Function(String retryId, bool shouldRetry) onRetry;
  final String? projectTitle;

  const _RetryCard({
    required this.retry,
    required this.colorScheme,
    required this.onRetry,
    this.projectTitle,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Colors.orange.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: Colors.orange.withValues(alpha: 0.3),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 标题行
            Row(
              children: [
                Icon(
                  Icons.error_outline,
                  size: 20,
                  color: Colors.orange.shade700,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            retry.errorTypeLabel,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              color: colorScheme.onSurface,
                            ),
                          ),
                          if (projectTitle != null) ...[
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: colorScheme.primary.withValues(alpha: 0.1),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                projectTitle!,
                                style: TextStyle(
                                  fontSize: 11,
                                  color: colorScheme.primary,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      if (retry.errorMessage.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            retry.errorMessage.length > 80
                                ? '${retry.errorMessage.substring(0, 80)}...'
                                : retry.errorMessage,
                            style: TextStyle(
                              fontSize: 12,
                              color: colorScheme.onSurfaceVariant,
                            ),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            // 操作按钮
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => onRetry(retry.retryId, true),
                    icon: const Icon(Icons.refresh, size: 18),
                    label: const Text('重试'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.orange,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => onRetry(retry.retryId, false),
                    icon: const Icon(Icons.close, size: 18),
                    label: const Text('取消'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.grey,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
