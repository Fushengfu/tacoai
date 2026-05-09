import 'package:flutter/material.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';

/// 项目列表页面 — 展示桌面端所有项目及其会话
///
/// 功能：
/// - 列表展示桌面端所有项目（名称、工作区路径）
/// - 点击展开/收起项目下的会话列表
/// - 点击会话切换到该会话（通知桌面端同步切换）
/// - 下拉刷新重新获取项目列表
class ProjectListPage extends StatefulWidget {
  final BridgeClient client;

  const ProjectListPage({super.key, required this.client});

  @override
  State<ProjectListPage> createState() => _ProjectListPageState();
}

class _ProjectListPageState extends State<ProjectListPage> {
  List<BridgeProjectInfo> _projects = [];
  bool _loading = false;
  String? _error;
  String? _expandedProjectId;
  BridgeConnectionStatus _connectionStatus = BridgeConnectionStatus.disconnected;

  @override
  void initState() {
    super.initState();
    // 监听连接状态变化
    widget.client.onStatusChange(_onStatusChange);
    _connectionStatus = widget.client.status.status;
    
    // 如果已连接，立即加载项目列表
    if (_connectionStatus == BridgeConnectionStatus.connected) {
      _loadProjects();
    }
  }

  @override
  void dispose() {
    widget.client.removeStatusListener(_onStatusChange);
    super.dispose();
  }

  void _onStatusChange(BridgeStatus status) {
    if (!mounted) return;
    setState(() {
      _connectionStatus = status.status;
    });
    
    // 连接成功时自动加载项目列表
    if (status.status == BridgeConnectionStatus.connected && _projects.isEmpty) {
      _loadProjects();
    }
  }

  Future<void> _loadProjects() async {
    if (_connectionStatus != BridgeConnectionStatus.connected) {
      setState(() {
        _error = '未连接到桌面端';
      });
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final projects = await widget.client.requestProjects();
      if (!mounted) return;
      setState(() {
        _projects = projects;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载项目失败: $e';
        _loading = false;
      });
    }
  }

  Future<void> _switchToSession(String projectId, String? sessionId) async {
    try {
      await widget.client.switchProject(projectId, sessionId: sessionId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已切换项目/会话')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('切换失败: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('项目列表'),
        actions: [
          // 连接状态指示器
          Padding(
            padding: const EdgeInsets.only(right: 8),
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
                const SizedBox(width: 4),
                Text(
                  _connectionStatus == BridgeConnectionStatus.connected ? '已连接' : '未连接',
                  style: const TextStyle(fontSize: 12),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: (_loading || _connectionStatus != BridgeConnectionStatus.connected) ? null : _loadProjects,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_connectionStatus != BridgeConnectionStatus.connected) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 64, color: Colors.grey),
            SizedBox(height: 16),
            Text(
              '请先连接桌面端',
              style: TextStyle(fontSize: 16, color: Colors.grey),
            ),
          ],
        ),
      );
    }

    if (_loading && _projects.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null && _projects.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _loadProjects,
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    if (_projects.isEmpty) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_open, size: 64, color: Colors.grey),
            SizedBox(height: 16),
            Text(
              '暂无项目',
              style: TextStyle(fontSize: 16, color: Colors.grey),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadProjects,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _projects.length,
        itemBuilder: (context, index) {
          final project = _projects[index];
          final isExpanded = _expandedProjectId == project.id;

          return Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: Column(
              children: [
                // 项目头部
                ListTile(
                  leading: const Icon(Icons.folder, color: Colors.blue),
                  title: Text(
                    project.title,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  subtitle: project.workspace != null
                      ? Text(
                          project.workspace!,
                          style: const TextStyle(fontSize: 12),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        )
                      : null,
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '${project.sessions.length} 会话',
                        style: const TextStyle(fontSize: 12, color: Colors.grey),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        isExpanded ? Icons.expand_less : Icons.expand_more,
                      ),
                    ],
                  ),
                  onTap: () {
                    setState(() {
                      _expandedProjectId = isExpanded ? null : project.id;
                    });
                  },
                ),
                // 会话列表（展开时显示）
                if (isExpanded) ...[
                  const Divider(height: 1),
                  ...project.sessions.map((session) {
                    final isActive = session.id == project.activeSessionId;
                    return ListTile(
                      leading: Icon(
                        isActive ? Icons.chat_bubble : Icons.chat_bubble_outline,
                        color: isActive ? Colors.green : Colors.grey,
                        size: 20,
                      ),
                      title: Text(
                        session.title,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
                        ),
                      ),
                      trailing: isActive
                          ? const Text(
                              '活跃',
                              style: TextStyle(fontSize: 11, color: Colors.green),
                            )
                          : null,
                      onTap: () => _switchToSession(project.id, session.id),
                      dense: true,
                    );
                  }),
                  // 直接切换项目（不指定会话）
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: TextButton.icon(
                      icon: const Icon(Icons.swap_horiz, size: 16),
                      label: const Text('切换到此项目', style: TextStyle(fontSize: 13)),
                      onPressed: () => _switchToSession(project.id, null),
                    ),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}
