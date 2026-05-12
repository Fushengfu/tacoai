import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';

/// 项目侧边弹窗 — 从左侧滑出显示项目列表（单会话模式）
///
/// 功能：
/// - 扁平化展示桌面端所有项目
/// - 点击项目直接切换到该项目（单会话，无会话展开）
/// - 下拉刷新
class ProjectDrawer extends StatefulWidget {
  final BridgeClient client;

  const ProjectDrawer({super.key, required this.client});

  @override
  State<ProjectDrawer> createState() => _ProjectDrawerState();
}

class _ProjectDrawerState extends State<ProjectDrawer> {
  List<BridgeProjectInfo> _projects = [];
  List<String> _customOrder = []; // 用户自定义的项目 ID 排序
  String? _activeThreadId;
  bool _loading = false;
  String? _error;
  BridgeConnectionStatus _connectionStatus = BridgeConnectionStatus.disconnected;
  String? _currentWorkspace; // 当前工作区路径（用于匹配当前项目）

  @override
  void initState() {
    super.initState();
    widget.client.onStatusChange(_onStatusChange);
    widget.client.onMessage(_onMessage);
    _connectionStatus = widget.client.status.status;
    _loadCustomOrder();

    if (_connectionStatus == BridgeConnectionStatus.connected) {
      _loadProjects();
    }
  }

  /// 加载用户自定义的项目排序
  Future<void> _loadCustomOrder() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _customOrder = prefs.getStringList('project_order') ?? [];
    });
  }

  /// 保存用户自定义的项目排序
  Future<void> _saveCustomOrder() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList('project_order', _customOrder);
  }

  /// 应用自定义排序到项目列表
  void _applyCustomOrder() {
    if (_customOrder.isEmpty) return;

    // 按自定义顺序排列项目
    _projects.sort((a, b) {
      final indexA = _customOrder.indexOf(a.id);
      final indexB = _customOrder.indexOf(b.id);

      // 如果两个项目都在自定义排序中，按自定义顺序排
      if (indexA != -1 && indexB != -1) {
        return indexA.compareTo(indexB);
      }
      // 如果只有 a 在自定义排序中，a 排前面
      if (indexA != -1) return -1;
      // 如果只有 b 在自定义排序中，b 排前面
      if (indexB != -1) return 1;
      // 都不在自定义排序中，保持原顺序
      return 0;
    });
  }

  @override
  void dispose() {
    widget.client.removeStatusListener(_onStatusChange);
    widget.client.removeMessageListener(_onMessage);
    super.dispose();
  }

  void _onMessage(dynamic data) {
    if (!mounted) return;
    final json = data as Map<String, dynamic>;
    final type = json['type'] as String?;

    if (type == 'bridge:state') {
      final state = BridgeState.fromJson(json);
      if (state.workspace != null && state.workspace != _currentWorkspace) {
        setState(() => _currentWorkspace = state.workspace);
      }
      // bridge:state 包含 threadId（当前活跃项目），直接更新激活状态
      if (state.threadId != null && state.threadId!.isNotEmpty) {
        setState(() => _activeThreadId = state.threadId);
      }
      // 后台刷新项目列表，不阻塞 UI
      _refreshProjectsInBackground();
    } else if (type == 'bridge:agent-event') {
      // 只处理当前项目相关的 Agent 事件，避免不必要的 setState
      final threadId = json['threadId'] as String?;
      if (threadId == null || threadId.isEmpty || threadId == _currentWorkspace) {
        // 仅更新活跃任务状态，不触发全量重建
        final event = json['event'] as Map<String, dynamic>?;
        final eventType = event?['type'] as String?;
        if (eventType == 'done' || eventType == 'error') {
          // 任务完成时刷新项目列表状态
          _refreshProjectsInBackground();
        }
      }
    } else if (type == 'bridge:chat-delta') {
      // 聊天流事件不需要更新项目列表，忽略
    } else if (type == 'bridge:project-states') {
      // 桌面端主动推送的项目状态变更 — 直接从推送数据更新，不发起网络请求
      _applyProjectStatesPush(json);
    }
  }

  /// 从桌面端推送的 project-states 数据直接更新 UI，不发起网络请求
  void _applyProjectStatesPush(Map<String, dynamic> json) {
    if (!mounted) return;
    try {
      // 更新活跃项目 ID（来自推送的 activeThreadId）
      final newActiveThreadId = json['activeThreadId'] as String?;
      // 始终调用 setState 以触发重建，确保活跃任务状态（_hasActiveTask）被重新计算
      setState(() {
        if (newActiveThreadId != null && newActiveThreadId.isNotEmpty) {
          _activeThreadId = newActiveThreadId;
        }
      });
    } catch (e) {
      print('[ProjectDrawer] _applyProjectStatesPush error: $e');
    }
  }

  void _onStatusChange(BridgeStatus status) {
    if (!mounted) return;
    setState(() {
      _connectionStatus = status.status;
    });

    if (status.status == BridgeConnectionStatus.connected && _projects.isEmpty) {
      _loadProjects();
    }
  }

  /// 从本地缓存加载项目列表（秒开）
  Future<void> _loadProjectsFromCache() async {
    final cached = await widget.client.loadProjectsFromDisk();
    if (cached != null && mounted) {
      setState(() {
        _projects = cached.projects;
        _applyCustomOrder();
        _activeThreadId = cached.activeThreadId;
      });
    }
  }

  /// 后台刷新项目列表（不显示 loading）
  Future<void> _refreshProjectsInBackground() async {
    try {
      final result = await widget.client.requestProjects();
      if (!mounted) return;
      setState(() {
        _projects = result.projects;
        _applyCustomOrder();
        _activeThreadId = result.activeThreadId;
      });
    } catch (e) {
      print('[ProjectDrawer] Background refresh failed: $e');
    }
  }

  Future<void> _loadProjects() async {
    if (_connectionStatus != BridgeConnectionStatus.connected) {
      setState(() => _error = '未连接到桌面端');
      return;
    }

    // 1. 先从本地缓存加载（秒开）
    await _loadProjectsFromCache();

    // 2. 再从网络刷新（带内存缓存，30s 内直接返回缓存）
    setState(() {
      _loading = _projects.isEmpty; // 只有缓存为空时才显示 loading
      _error = null;
    });

    try {
      final result = await widget.client.requestProjects();
      if (!mounted) return;
      setState(() {
        _projects = result.projects;
        _applyCustomOrder(); // 应用自定义排序
        _activeThreadId = result.activeThreadId;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载失败: $e';
        _loading = false;
      });
    }
  }

  Future<void> _switchProject(String projectId) async {
    try {
      // 立即清空消息列表并设置加载状态，避免显示旧项目数据
      widget.client.clearMessages();
      widget.client.setCurrentProject(projectId);
      
      // 立即更新本地激活状态，确保 UI 只有一个项目被选中
      setState(() {
        _activeThreadId = projectId;
      });
      
      // 发送切换请求到桌面端（异步，不阻塞）
      widget.client.switchProject(projectId).catchError((e) {
        print('[ProjectDrawer] Switch project error: $e');
        return BridgeProjectSwitchedResponse(requestId: '', success: false);
      });
      if (!mounted) return;
      
      // 立即关闭抽屉，不等桌面端响应
      Navigator.of(context).pop();
      
      final project = _projects.firstWhere(
        (p) => p.id == projectId,
        orElse: () => BridgeProjectInfo(id: '', title: 'Unknown', sessions: [], activeSessionId: null),
      );
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已切换: ${project.title}'),
          duration: const Duration(milliseconds: 800),
          behavior: SnackBarBehavior.fixed,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('切换失败: $e'), behavior: SnackBarBehavior.fixed),
      );
    }
  }

  /// 判断项目是否有活跃任务（Agent 正在执行）
  bool _hasActiveTask(BridgeProjectInfo project) {
    // 使用 project.id 作为项目唯一标识（与 bridge_client 的 _projectActiveTasks 存储键一致）
    final activeId = widget.client.getActiveTaskForProject(project.id);
    return activeId != null && activeId.isNotEmpty;
  }

  /// 判断项目是否为当前选中的项目
  bool _isCurrentProject(BridgeProjectInfo project) {
    // 优先通过 activeThreadId 精确匹配（来自 bridge:project-states 实时推送或 requestProjects）
    // 当 activeThreadId 存在时，只使用它进行判断，避免与 currentProjectId 冲突
    if (_activeThreadId != null && _activeThreadId!.isNotEmpty) {
      return project.id == _activeThreadId;
    }
    // 其次通过 bridge_client 的 currentProjectId（来自 bridge:state 的 threadId）
    final clientId = widget.client.currentProjectId;
    if (clientId != null && clientId.isNotEmpty && project.id == clientId) {
      return true;
    }
    // 最后通过 workspace 路径匹配
    if (_currentWorkspace != null && project.workspace != null) {
      return _currentWorkspace == project.workspace;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Drawer(
      child: SafeArea(
        child: Column(
          children: [
            // 抽屉头部 - 简洁版
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              color: colorScheme.surfaceContainerHighest,
              child: Row(
                children: [
                  Icon(Icons.folder, size: 20, color: colorScheme.primary),
                  const SizedBox(width: 8),
                  Text(
                    '项目列表',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: colorScheme.onSurface,
                    ),
                  ),
                  const Spacer(),
                  // 连接状态指示器
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: _connectionStatus == BridgeConnectionStatus.connected
                          ? Colors.green
                          : Colors.red,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    icon: const Icon(Icons.refresh, size: 18),
                    onPressed: (_loading || _connectionStatus != BridgeConnectionStatus.connected)
                        ? null
                        : _loadProjects,
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(),
                  ),
                ],
              ),
            ),
            // 项目列表
            Expanded(child: _buildBody()),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);

    if (_connectionStatus != BridgeConnectionStatus.connected) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: Colors.grey),
            SizedBox(height: 12),
            Text('请先连接桌面端', style: TextStyle(color: Colors.grey)),
          ],
        ),
      );
    }

    // 优化：始终显示缓存内容，loading 时只在顶部显示小转圈，不遮挡列表
    if (_projects.isEmpty) {
      if (_loading) {
        return const Center(child: CircularProgressIndicator());
      }
      if (_error != null) {
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48, color: Colors.red),
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
              const SizedBox(height: 16),
              FilledButton(onPressed: _loadProjects, child: const Text('重试')),
            ],
          ),
        );
      }
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_open, size: 48, color: Colors.grey),
            SizedBox(height: 12),
            Text('暂无项目', style: TextStyle(color: Colors.grey)),
          ],
        ),
      );
    }

    return Stack(
      children: [
        ListView.builder(
          padding: const EdgeInsets.symmetric(vertical: 4),
          itemCount: _projects.length,
          itemBuilder: (context, index) {
            final project = _projects[index];
            final hasActiveTask = _hasActiveTask(project);
            final isCurrent = _isCurrentProject(project);
            final theme = Theme.of(context);
            final colorScheme = theme.colorScheme;

            return Column(
              key: ValueKey('project-${project.id}'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 项目行 - 点击直接切换
                ListTile(
                  leading: Icon(
                    isCurrent ? Icons.folder_special : Icons.folder_outlined,
                    color: isCurrent
                        ? colorScheme.primary
                        : (hasActiveTask ? Colors.orange : colorScheme.onSurfaceVariant),
                    size: 22,
                  ),
                  title: Text(
                    project.title,
                    style: TextStyle(
                      fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w500,
                      fontSize: 14,
                      color: isCurrent ? colorScheme.primary : null,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: project.workspace != null
                      ? Text(
                          project.workspace!,
                          style: const TextStyle(fontSize: 11, color: Colors.grey),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        )
                      : null,
                  trailing: hasActiveTask
                      ? Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.orange.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text(
                            '处理中',
                            style: TextStyle(fontSize: 10, color: Colors.orange, fontWeight: FontWeight.w500),
                          ),
                        )
                      : (isCurrent
                          ? Icon(Icons.check_circle, size: 18, color: colorScheme.primary)
                          : const SizedBox(width: 18)),
                  onTap: () => _switchProject(project.id),
                  dense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 0),
                ),
                // 分隔线
                if (index < _projects.length - 1)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Divider(height: 1, color: Colors.grey.shade200),
                  ),
              ],
            );
          },
        ),
        // 后台刷新指示器（不遮挡内容）
        if (_loading)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: LinearProgressIndicator(
              minHeight: 2,
              backgroundColor: Colors.transparent,
              valueColor: AlwaysStoppedAnimation<Color>(theme.colorScheme.primary.withValues(alpha: 0.5)),
            ),
          ),
      ],
    );
  }
}
