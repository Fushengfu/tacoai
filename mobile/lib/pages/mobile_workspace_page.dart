import 'dart:async';

import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../services/bridge_client.dart';

class MobileWorkspacePage extends StatefulWidget {
  const MobileWorkspacePage({
    super.key,
    required this.config,
    required this.threadId,
    this.sessionId,
    this.threadTitle,
  });

  final BridgeConfig config;
  final String threadId;
  final String? sessionId;
  final String? threadTitle;

  @override
  State<MobileWorkspacePage> createState() => _MobileWorkspacePageState();
}

class _MobileWorkspacePageState extends State<MobileWorkspacePage> {
  late final BridgeClient _client;
  final TextEditingController _editorController = TextEditingController();

  List<BridgeWorkspaceEntry> _entries = const <BridgeWorkspaceEntry>[];
  String _workspace = '';
  String _status = '正在读取目录...';
  String? _selectedPath;
  bool _loadingTree = false;
  bool _loadingFile = false;
  bool _saving = false;
  bool _dirty = false;
  bool _isBinary = false;
  bool _silentApplyingText = false;
  Timer? _syncTimer;

  @override
  void initState() {
    super.initState();
    _client = BridgeClient(config: widget.config);
    _editorController.addListener(() {
      if (_silentApplyingText) return;
      if (!_dirty) setState(() => _dirty = true);
    });
    unawaited(_reloadTree());
    _syncTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (_selectedPath == null || _dirty || _loadingFile || _saving) return;
      unawaited(_reloadSelectedFile(silent: true));
    });
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    _editorController.dispose();
    super.dispose();
  }

  void _showNotice(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _reloadTree() async {
    if (_loadingTree) return;
    setState(() => _loadingTree = true);
    try {
      final resp = await _client.workspaceTree(
        threadId: widget.threadId,
        sessionId: widget.sessionId,
      );
      if (!mounted) return;
      setState(() {
        _workspace = resp.workspace;
        _entries = resp.entries;
        _status = resp.entries.isEmpty ? '当前工作区没有可显示的文件' : '目录已同步';
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _status = '读取目录失败: $err';
      });
    } finally {
      if (mounted) setState(() => _loadingTree = false);
    }
  }

  Future<void> _openFile(String relativePath) async {
    if (_dirty && relativePath != _selectedPath) {
      _showNotice('当前文件有未保存修改，请先保存');
      return;
    }
    setState(() {
      _selectedPath = relativePath;
    });
    await _reloadSelectedFile(silent: false);
  }

  Future<void> _reloadSelectedFile({required bool silent}) async {
    final targetPath = _selectedPath;
    if (targetPath == null || targetPath.isEmpty || _loadingFile) return;
    setState(() => _loadingFile = true);
    try {
      final file = await _client.readWorkspaceFile(
        path: targetPath,
        threadId: widget.threadId,
        sessionId: widget.sessionId,
      );
      if (!mounted || _selectedPath != targetPath) return;
      final nextText = file.content ?? '';
      if (_editorController.text != nextText) {
        _silentApplyingText = true;
        _editorController.text = nextText;
        _silentApplyingText = false;
      }
      setState(() {
        _isBinary = file.isBinary;
        _dirty = false;
      });
    } catch (err) {
      if (!silent) _showNotice('读取文件失败: $err');
    } finally {
      if (mounted) setState(() => _loadingFile = false);
    }
  }

  Future<void> _saveFile() async {
    final targetPath = _selectedPath;
    if (targetPath == null || targetPath.isEmpty || _isBinary) return;
    if (_saving) return;
    setState(() => _saving = true);
    try {
      final resp = await _client.writeWorkspaceFile(
        path: targetPath,
        content: _editorController.text,
        threadId: widget.threadId,
        sessionId: widget.sessionId,
      );
      if (resp.statusCode == 200) {
        if (!mounted) return;
        setState(() => _dirty = false);
        _showNotice('已保存: $targetPath');
      } else {
        _showNotice('保存失败: ${resp.statusCode}');
      }
    } catch (err) {
      _showNotice('保存异常: $err');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _buildTreePane() {
    if (_loadingTree && _entries.isEmpty) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_entries.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Text(
            _status,
            style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _reloadTree,
      child: ListView(
        children: _entries
            .map((entry) => _WorkspaceNode(
                  entry: entry,
                  depth: 0,
                  selectedPath: _selectedPath,
                  onSelectFile: _openFile,
                ))
            .toList(),
      ),
    );
  }

  Widget _buildEditorPane() {
    if (_selectedPath == null) {
      return Center(
        child: Text(
          '从上方目录选择文件开始编辑',
          style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      );
    }
    if (_isBinary) {
      return Center(
        child: Text(
          '该文件为二进制或过大文件，暂不支持编辑',
          style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
          textAlign: TextAlign.center,
        ),
      );
    }
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _selectedPath!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ),
              IconButton(
                tooltip: '刷新',
                onPressed: _loadingFile ? null : () => unawaited(_reloadSelectedFile(silent: false)),
                icon: const Icon(Icons.refresh, size: 18),
              ),
              FilledButton.tonal(
                onPressed: (_dirty && !_saving) ? () => unawaited(_saveFile()) : null,
                child: Text(_saving ? '保存中...' : '保存'),
              ),
            ],
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: TextField(
              controller: _editorController,
              readOnly: _loadingFile || _saving,
              expands: true,
              minLines: null,
              maxLines: null,
              style: const TextStyle(
                fontFamily: 'SF Mono',
                fontSize: 13,
                height: 1.35,
              ),
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                hintText: '在这里编辑代码...',
                alignLabelWithHint: true,
              ),
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.threadTitle?.trim().isNotEmpty == true
        ? '代码工作区 · ${widget.threadTitle}'
        : '代码工作区';
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          IconButton(
            tooltip: '刷新目录',
            onPressed: _loadingTree ? null : () => unawaited(_reloadTree()),
            icon: const Icon(Icons.sync),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              color: Theme.of(context).colorScheme.surfaceContainer,
              child: Text(
                _workspace.isEmpty ? _status : '工作区: $_workspace',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              ),
            ),
            SizedBox(
              height: 220,
              child: _buildTreePane(),
            ),
            Divider(height: 1, color: Theme.of(context).colorScheme.outlineVariant),
            Expanded(child: _buildEditorPane()),
          ],
        ),
      ),
    );
  }
}

class _WorkspaceNode extends StatelessWidget {
  const _WorkspaceNode({
    required this.entry,
    required this.depth,
    required this.selectedPath,
    required this.onSelectFile,
  });

  final BridgeWorkspaceEntry entry;
  final int depth;
  final String? selectedPath;
  final ValueChanged<String> onSelectFile;

  @override
  Widget build(BuildContext context) {
    if (entry.isDirectory) {
      return Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          key: PageStorageKey<String>('dir-${entry.path}'),
          initiallyExpanded: depth < 1,
          tilePadding: EdgeInsets.only(left: 8 + depth * 12, right: 8),
          minTileHeight: 34,
          leading: const Icon(Icons.folder_outlined, size: 16),
          title: Text(
            entry.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
          children: entry.children
              .map((child) => _WorkspaceNode(
                    entry: child,
                    depth: depth + 1,
                    selectedPath: selectedPath,
                    onSelectFile: onSelectFile,
                  ))
              .toList(),
        ),
      );
    }

    return ListTile(
      dense: true,
      selected: selectedPath == entry.path,
      minTileHeight: 32,
      contentPadding: EdgeInsets.only(left: 14 + depth * 12, right: 10),
      leading: const Icon(Icons.description_outlined, size: 15),
      title: Text(
        entry.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 12),
      ),
      onTap: () => onSelectFile(entry.path),
    );
  }
}
