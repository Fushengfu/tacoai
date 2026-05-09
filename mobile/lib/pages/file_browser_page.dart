import 'package:flutter/material.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import 'file_editor_page.dart';

/// 文件浏览器页面 — 浏览项目目录结构与查看文件
///
/// 功能：
/// - 顶部选择项目工作区路径（或手动输入）
/// - 树形展示目录结构
/// - 点击目录展开/收起子节点
/// - 点击文件进入编辑器/查看器
class FileBrowserPage extends StatefulWidget {
  final BridgeClient client;

  const FileBrowserPage({super.key, required this.client});

  @override
  State<FileBrowserPage> createState() => _FileBrowserPageState();
}

class _FileBrowserPageState extends State<FileBrowserPage> {
  List<BridgeFileTreeEntry> _tree = [];
  List<BridgeProjectInfo> _projects = [];
  BridgeProjectInfo? _selectedProject;
  String? _workspace;
  bool _loadingProjects = false;
  bool _loadingTree = false;
  String? _error;
  final Set<String> _expandedPaths = {};
  final TextEditingController _pathController = TextEditingController();
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
    _pathController.dispose();
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
    setState(() => _loadingProjects = true);
    try {
      final projects = await widget.client.requestProjects();
      if (!mounted) return;
      setState(() {
        _projects = projects;
        _loadingProjects = false;
        // 自动选择第一个有 workspace 的项目
        if (_selectedProject == null && projects.isNotEmpty) {
          final firstWithWs = projects.where((p) => p.workspace != null && p.workspace!.isNotEmpty).firstOrNull;
          if (firstWithWs != null) {
            _selectProject(firstWithWs);
          }
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载项目失败: $e';
        _loadingProjects = false;
      });
    }
  }

  void _selectProject(BridgeProjectInfo project) {
    setState(() {
      _selectedProject = project;
      _workspace = project.workspace;
      _tree = [];
      _expandedPaths.clear();
      _pathController.text = project.workspace ?? '';
    });
    if (_workspace != null) {
      _loadTree(_workspace!);
    }
  }

  Future<void> _loadTree(String path) async {
    setState(() {
      _loadingTree = true;
      _error = null;
    });
    try {
      final tree = await widget.client.requestWorkspaceTree(path);
      if (!mounted) return;
      setState(() {
        _tree = tree;
        _loadingTree = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载目录失败: $e';
        _loadingTree = false;
      });
    }
  }

  void _openFile(String filePath) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => FileEditorPage(
          client: widget.client,
          filePath: filePath,
          workspace: _workspace,
        ),
      ),
    );
  }

  void _toggleExpand(String dirPath) {
    setState(() {
      if (_expandedPaths.contains(dirPath)) {
        _expandedPaths.remove(dirPath);
      } else {
        _expandedPaths.add(dirPath);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('文件浏览'),
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
            onPressed: (_loadingTree || _connectionStatus != BridgeConnectionStatus.connected) ? null : () {
              if (_workspace != null) _loadTree(_workspace!);
            },
          ),
        ],
      ),
      body: Column(
        children: [
          // 项目选择器
          _buildProjectSelector(),
          // 目录树
          Expanded(child: _buildTreeContent()),
        ],
      ),
    );
  }

  Widget _buildProjectSelector() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        border: Border(
          bottom: BorderSide(color: Theme.of(context).dividerColor),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('工作区: ', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              Expanded(
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<BridgeProjectInfo>(
                    value: _selectedProject,
                    isExpanded: true,
                    hint: const Text('选择项目', style: TextStyle(fontSize: 13)),
                    items: _projects.map((p) {
                      return DropdownMenuItem(
                        value: p,
                        child: Text(
                          p.title,
                          style: const TextStyle(fontSize: 13),
                          overflow: TextOverflow.ellipsis,
                        ),
                      );
                    }).toList(),
                    onChanged: (project) {
                      if (project != null) _selectProject(project);
                    },
                  ),
                ),
              ),
              if (_loadingProjects)
                const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
            ],
          ),
          if (_workspace != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _workspace!,
                style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTreeContent() {
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

    if (_loadingTree && _tree.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null && _tree.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () {
                if (_workspace != null) _loadTree(_workspace!);
              },
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    if (_tree.isEmpty && _workspace == null) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.folder_open, size: 64, color: Colors.grey),
            SizedBox(height: 16),
            Text(
              '请先选择一个项目',
              style: TextStyle(fontSize: 16, color: Colors.grey),
            ),
          ],
        ),
      );
    }

    if (_tree.isEmpty && !_loadingTree) {
      return const Center(
        child: Text('目录为空', style: TextStyle(color: Colors.grey)),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      itemCount: _tree.length,
      itemBuilder: (context, index) => _buildTreeEntry(_tree[index], 0),
    );
  }

  Widget _buildTreeEntry(BridgeFileTreeEntry entry, int depth) {
    final isExpanded = _expandedPaths.contains(entry.path);
    final isDir = entry.isDirectory;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () {
            if (isDir) {
              _toggleExpand(entry.path);
            } else {
              _openFile(entry.path);
            }
          },
          child: Padding(
            padding: EdgeInsets.only(left: depth * 16.0, right: 8, top: 2, bottom: 2),
            child: Row(
              children: [
                Icon(
                  isDir
                      ? (isExpanded ? Icons.folder_open : Icons.folder)
                      : Icons.description,
                  size: 18,
                  color: isDir ? Colors.amber : Colors.grey,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    entry.name,
                    style: const TextStyle(fontSize: 13),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (isDir && entry.children.isNotEmpty)
                  Icon(
                    isExpanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                  ),
              ],
            ),
          ),
        ),
        // 展开子节点
        if (isDir && isExpanded)
          ...entry.children.map((child) => _buildTreeEntry(child, depth + 1)),
      ],
    );
  }
}
