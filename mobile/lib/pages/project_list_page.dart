import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';

/// 项目列表页面 — 展示桌面端所有项目（单会话模式）
///
/// 功能：
/// - 列表展示桌面端所有项目（名称、工作区路径）
/// - 点击项目直接切换到该项目（单会话，无会话展开）
/// - 下拉刷新重新获取项目列表
class ProjectListPage extends StatefulWidget {
  final BridgeClient client;

  const ProjectListPage({super.key, required this.client});

  @override
  State<ProjectListPage> createState() => _ProjectListPageState();
}

class _ProjectListPageState extends State<ProjectListPage> {
  List<BridgeProjectInfo> _projects = [];
  List<String> _customOrder = []; // 用户自定义的项目 ID 排序
  String? _activeThreadId;
  bool _loading = false;
  String? _error;
  BridgeConnectionStatus _connectionStatus = BridgeConnectionStatus.disconnected;

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

    // 收到 agent 事件时，更新项目列表中的任务状态
    if (type == 'bridge:agent-event') {
      final event = json['event'] as Map<String, dynamic>?;
      final eventType = event?['type'] as String?;
      final requestId = json['requestId'] as String?;

      if (requestId != null && eventType != null) {
        // 从 requestId 中提取 sessionId（格式：agent-{sessionId}）
        final sessionId = requestId.replaceFirst('agent-', '');

        setState(() {
          if (eventType == 'tool_calls' || eventType == 'thinking' || eventType == 'reasoning') {
            // 标记该项目为处理中
            _activeTaskSessionIds.add(sessionId);
          } else if (eventType == 'done' || eventType == 'error') {
            // 移除完成的任务
            _activeTaskSessionIds.remove(sessionId);
          }
        });
      }
    }

    // 收到状态同步时，刷新项目列表（增量更新，不阻塞 UI）
    if (type == 'bridge:state') {
      _refreshProjectsInBackground();
    }

    // 桌面端主动推送的项目状态变更，立即更新项目列表
    if (type == 'bridge:project-states') {
      _updateProjectsFromStates(json);
    }
  }

  /// 从 bridge:project-states 消息中立即更新项目列表（不异步刷新）
  void _updateProjectsFromStates(Map<String, dynamic> json) {
    try {
      final statesJson = json['states'] as List<dynamic>?;
      final newActiveThreadId = json['activeThreadId'] as String?;
      
      if (statesJson != null && mounted) {
        // 创建新的项目列表，按照桌面端推送的顺序排列
        final List<BridgeProjectInfo> reorderedProjects = [];
        
        // 先收集所有当前正在处理的项目 ID
        final Set<String> currentProcessingProjectIds = {};
        for (final stateJson in statesJson) {
          final state = stateJson as Map<String, dynamic>;
          final projectId = state['id'] as String?;
          final isProcessing = state['isProcessing'] as bool? ?? false;
          if (projectId != null && isProcessing) {
            currentProcessingProjectIds.add(projectId);
          }
        }
        
        // 清理 _projectToActiveSession 中不再处理中的项目
        final List<String> projectsToRemove = [];
        for (final entry in _projectToActiveSession.entries) {
          if (!currentProcessingProjectIds.contains(entry.key)) {
            projectsToRemove.add(entry.key);
            _activeTaskSessionIds.remove(entry.value);
          }
        }
        for (final projectId in projectsToRemove) {
          _projectToActiveSession.remove(projectId);
        }
        
        for (final stateJson in statesJson) {
          final state = stateJson as Map<String, dynamic>;
          final projectId = state['id'] as String?;
          if (projectId != null) {
            // 查找现有项目
            final existingProject = _projects.firstWhere(
              (p) => p.id == projectId,
              orElse: () => BridgeProjectInfo(
                id: projectId,
                title: state['title'] as String? ?? '',
                workspace: state['workspace'] as String?,
                sessions: [],
              ),
            );
            reorderedProjects.add(existingProject);
            
            // 更新活跃任务状态
            final isProcessing = state['isProcessing'] as bool? ?? false;
            final activeTaskId = state['activeTaskId'] as String?;
            if (isProcessing && activeTaskId != null && activeTaskId.isNotEmpty) {
              final sessionId = activeTaskId.replaceFirst('agent-', '');
              _activeTaskSessionIds.add(sessionId);
              _projectToActiveSession[projectId] = sessionId;
            }
          }
        }
        
        setState(() {
          _projects = reorderedProjects;
          _applyCustomOrder();
          if (newActiveThreadId != null && newActiveThreadId.isNotEmpty) {
            _activeThreadId = newActiveThreadId;
          }
        });
        
        print('[ProjectList] Updated from project-states push (${statesJson.length} states)');
      }
    } catch (e) {
      print('[ProjectList] Failed to update from project-states: $e');
    }
  }

  final Set<String> _activeTaskSessionIds = {};
  final Map<String, String> _projectToActiveSession = {}; // projectId -> sessionId

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
      print('[ProjectList] Background refresh failed: $e');
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
      
      // 发送切换请求到桌面端（异步，不阻塞）
      widget.client.switchProject(projectId).catchError((e) {
        print('[ProjectList] Switch project error: $e');
      });
      if (!mounted) return;
      
      // 立即导航到聊天页面，不等桌面端推送状态快照
      final project = _projects.firstWhere(
        (p) => p.id == projectId,
        orElse: () => BridgeProjectInfo(id: '', title: 'Unknown', sessions: [], activeSessionId: null),
      );
      
      // 通过 Navigator 返回到聊天页面（假设项目列表是从聊天页面 push 进来的）
      Navigator.of(context).popUntil((route) => route.isFirst);
      
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已切换: ${project.title}'),
          behavior: SnackBarBehavior.fixed,
          duration: const Duration(milliseconds: 800),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('切换失败: $e'),
          behavior: SnackBarBehavior.fixed,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      );
    }
  }

  /// 判断项目是否有活跃任务（Agent 正在执行）
  bool _hasActiveTask(BridgeProjectInfo project) {
    // 优先使用桌面端推送的活跃任务状态（更可靠）
    if (_projectToActiveSession.containsKey(project.id)) {
      return true;
    }
    // 兜底：检查项目的任何 session 是否在活跃任务列表中
    return project.sessions.any((s) => _activeTaskSessionIds.contains(s.id));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          '项目列表',
          style: TextStyle(fontWeight: FontWeight.w700, color: colorScheme.primary),
        ),
        elevation: 0,
        backgroundColor: colorScheme.surface,
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: _connectionStatus == BridgeConnectionStatus.connected
                    ? Colors.green.withValues(alpha: 0.1)
                    : Colors.red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
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
                  const SizedBox(width: 6),
                  Text(
                    _connectionStatus == BridgeConnectionStatus.connected ? '已连接' : '未连接',
                    style: TextStyle(
                      fontSize: 12,
                      color: _connectionStatus == BridgeConnectionStatus.connected
                          ? Colors.green.shade700
                          : Colors.red.shade700,
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            icon: Icon(Icons.refresh, color: colorScheme.onSurfaceVariant),
            onPressed: (_loading || _connectionStatus != BridgeConnectionStatus.connected)
                ? null
                : _loadProjects,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    if (_connectionStatus != BridgeConnectionStatus.connected) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 64, color: colorScheme.onSurfaceVariant.withValues(alpha: 0.3)),
            const SizedBox(height: 16),
            Text(
              '请先连接桌面端',
              style: TextStyle(fontSize: 16, color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      );
    }

    // 优化：始终显示缓存内容，loading 时只在顶部显示小转圈，不遮挡列表
    if (_projects.isEmpty) {
      if (_loading) {
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(color: colorScheme.primary),
              const SizedBox(height: 16),
              Text(
                '加载项目中...',
                style: TextStyle(color: colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        );
      }
      if (_error != null) {
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, size: 48, color: colorScheme.error),
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(color: colorScheme.error)),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _loadProjects,
                child: const Text('重试'),
              ),
            ],
          ),
        );
      }
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_open, size: 64, color: colorScheme.onSurfaceVariant.withValues(alpha: 0.3)),
            const SizedBox(height: 16),
            Text(
              '暂无项目',
              style: TextStyle(fontSize: 16, color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      );
    }

    return Stack(
      children: [
        RefreshIndicator(
          onRefresh: _loadProjects,
          color: colorScheme.primary,
          child: ListView.builder(
            padding: const EdgeInsets.all(12),
            itemCount: _projects.length,
            itemBuilder: (context, index) {
              final project = _projects[index];
              final hasActiveTask = _hasActiveTask(project);
              final isActive = project.id == _activeThreadId;

              return Container(
                key: ValueKey('project-${project.id}'),
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(
                  color: colorScheme.surface,
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.06),
                      blurRadius: 8,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                child: InkWell(
                  onTap: () => _switchProject(project.id),
                  borderRadius: BorderRadius.circular(14),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: isActive
                                ? Colors.green.withValues(alpha: 0.1)
                                : colorScheme.primaryContainer.withValues(alpha: 0.3),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Icon(
                            Icons.folder,
                            color: isActive ? Colors.green : colorScheme.onPrimaryContainer,
                            size: 22,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                project.title,
                                style: TextStyle(
                                  fontWeight: isActive ? FontWeight.w700 : FontWeight.w600,
                                  fontSize: 15,
                                  color: isActive ? Colors.green : null,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              if (project.workspace != null) ...[
                                const SizedBox(height: 2),
                                Text(
                                  project.workspace!,
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: colorScheme.onSurfaceVariant,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ],
                          ),
                        ),
                        if (hasActiveTask)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: Colors.orange.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Text(
                              '处理中',
                              style: TextStyle(fontSize: 11, color: Colors.orange, fontWeight: FontWeight.w500),
                            ),
                          )
                        else if (isActive)
                          Icon(Icons.check_circle, size: 20, color: Colors.green)
                        else
                          const SizedBox(width: 20),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
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
