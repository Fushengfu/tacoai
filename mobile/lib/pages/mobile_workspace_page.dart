import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../services/bridge_client.dart';

const Color _kWorkspacePaneBg = Color(0xFF0A1220);
const Color _kWorkspaceEditorBg = Color(0xFF020817);
const Color _kWorkspacePaneText = Color(0xFFE2E8F0);
const Color _kWorkspacePaneTextMuted = Color(0xFF94A3B8);

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
  bool _isImageFile = false;
  String? _imageDataUrl;
  bool _silentApplyingText = false;
  Timer? _syncTimer;
  double _treePaneHeight = 260;

  @override
  void initState() {
    super.initState();
    _client = BridgeClient(config: widget.config);
    _editorController.addListener(() {
      if (_silentApplyingText) return;
      if (!_dirty) setState(() => _dirty = true);
    });
    unawaited(_reloadTree());
    // 轻量轮询同步：仅在未编辑、未保存、未手动加载时生效，避免输入闪烁。
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
      ..showSnackBar(
        SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
      );
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
      _isBinary = false;
      _isImageFile = _isImagePath(relativePath);
      _imageDataUrl = null;
    });
    await _reloadSelectedFile(silent: false);
  }

  Future<void> _reloadSelectedFile({required bool silent}) async {
    final targetPath = _selectedPath;
    if (targetPath == null || targetPath.isEmpty) return;
    if (_loadingFile && !silent) return;
    if (!silent) setState(() => _loadingFile = true);
    try {
      final file = await _client.readWorkspaceFile(
        path: targetPath,
        threadId: widget.threadId,
        sessionId: widget.sessionId,
      );
      if (!mounted || _selectedPath != targetPath) return;
      final nextText = file.content ?? '';
      final nextImageDataUrl = file.dataUrl;
      final hasChanged = _editorController.text != nextText;
      if (hasChanged) {
        _silentApplyingText = true;
        _editorController.value = TextEditingValue(
          text: nextText,
          selection: TextSelection.collapsed(offset: nextText.length),
        );
        _silentApplyingText = false;
      }
      if (!silent || hasChanged || _isBinary != file.isBinary || _dirty) {
        setState(() {
          _isBinary = file.isBinary;
          _isImageFile = _isImagePath(targetPath);
          _imageDataUrl = nextImageDataUrl;
          if (hasChanged || !silent) _dirty = false;
        });
      }
    } catch (err) {
      if (!silent) _showNotice('读取文件失败: $err');
    } finally {
      if (!silent && mounted) setState(() => _loadingFile = false);
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
            style: const TextStyle(color: _kWorkspacePaneTextMuted),
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _reloadTree,
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 4),
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
    final scheme = Theme.of(context).colorScheme;
    if (_selectedPath == null) {
      return Center(
        child: Text(
          '从上方目录选择文件开始编辑',
          style: TextStyle(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_isBinary) {
      if (_isImageFile && _imageDataUrl != null && _imageDataUrl!.isNotEmpty) {
        return Container(
          color: _kWorkspaceEditorBg,
          alignment: Alignment.center,
          child: InteractiveViewer(
            minScale: 0.5,
            maxScale: 4,
            child: Image.memory(
              _decodeDataUrl(_imageDataUrl!),
              fit: BoxFit.contain,
              errorBuilder: (context, error, stackTrace) => Text(
                '图片加载失败',
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
            ),
          ),
        );
      }
      return Center(
        child: Text(
          '该文件为二进制或过大文件，暂不支持编辑',
          style: TextStyle(color: scheme.onSurfaceVariant),
          textAlign: TextAlign.center,
        ),
      );
    }
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: _kWorkspacePaneBg,
            border: Border(
              bottom: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
            ),
          ),
          child: Row(
            children: [
              const Icon(Icons.description_outlined, size: 14, color: Color(0xFF60A5FA)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  _selectedPath!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _kWorkspacePaneText,
                  ),
                ),
              ),
              IconButton(
                tooltip: '刷新',
                onPressed: _loadingFile || _saving
                    ? null
                    : () {
                        if (_dirty) {
                          _showNotice('文件有未保存修改，不能覆盖刷新');
                          return;
                        }
                        unawaited(_reloadSelectedFile(silent: false));
                      },
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
          child: Container(
            color: _kWorkspaceEditorBg,
            padding: const EdgeInsets.all(8),
            child: TextField(
              controller: _editorController,
              readOnly: _saving || _loadingFile,
              expands: true,
              minLines: null,
              maxLines: null,
              cursorColor: const Color(0xFF60A5FA),
              style: const TextStyle(
                fontFamily: 'SF Mono',
                fontSize: 13,
                height: 1.45,
                color: _kWorkspacePaneText,
              ),
              decoration: InputDecoration(
                isDense: true,
                filled: true,
                fillColor: _kWorkspacePaneBg,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.5)),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Color(0xFF3B82F6)),
                ),
                hintText: '在这里编辑代码...',
                hintStyle: const TextStyle(color: _kWorkspacePaneTextMuted),
                alignLabelWithHint: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDragDivider(double minTreeHeight, double maxTreeHeight) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onVerticalDragUpdate: (details) {
        setState(() {
          _treePaneHeight = (_treePaneHeight + details.delta.dy)
              .clamp(minTreeHeight, maxTreeHeight);
        });
      },
      child: Container(
        height: 16,
        alignment: Alignment.center,
        child: Container(
          width: 54,
          height: 6,
          decoration: BoxDecoration(
            color: scheme.outlineVariant.withValues(alpha: 0.9),
            borderRadius: BorderRadius.circular(999),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.threadTitle?.trim().isNotEmpty == true
        ? '代码工作区 · ${widget.threadTitle}'
        : '代码工作区';
    final scheme = Theme.of(context).colorScheme;

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
              color: scheme.surfaceContainer,
              child: Text(
                _workspace.isEmpty ? _status : '工作区: $_workspace',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              ),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final minTreeHeight = 140.0;
                  final maxTreeHeight = (constraints.maxHeight - 180).clamp(minTreeHeight, constraints.maxHeight);
                  final treeHeight = _treePaneHeight.clamp(minTreeHeight, maxTreeHeight);

                  return Column(
                    children: [
                      SizedBox(
                        height: treeHeight,
                        child: Container(
                          margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                          decoration: BoxDecoration(
                            color: _kWorkspacePaneBg,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.55)),
                          ),
                          child: Column(
                            children: [
                              Container(
                                width: double.infinity,
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                decoration: BoxDecoration(
                                  border: Border(
                                    bottom: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
                                  ),
                                ),
                                child: const Text(
                                  '文件目录',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w700,
                                    color: _kWorkspacePaneText,
                                  ),
                                ),
                              ),
                              Expanded(child: _buildTreePane()),
                            ],
                          ),
                        ),
                      ),
                      _buildDragDivider(minTreeHeight, maxTreeHeight),
                      Expanded(
                        child: Container(
                          margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                          decoration: BoxDecoration(
                            color: _kWorkspacePaneBg,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.55)),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: _buildEditorPane(),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

bool _isImagePath(String path) {
  final lower = path.toLowerCase();
  return lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.bmp') ||
      lower.endsWith('.ico') ||
      lower.endsWith('.svg');
}

Uint8List _decodeDataUrl(String dataUrl) {
  final idx = dataUrl.indexOf(',');
  final body = idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl;
  return base64Decode(body);
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
          iconColor: _kWorkspacePaneTextMuted,
          collapsedIconColor: _kWorkspacePaneTextMuted,
          textColor: _kWorkspacePaneText,
          collapsedTextColor: _kWorkspacePaneText,
          tilePadding: EdgeInsets.only(left: 8 + depth * 12, right: 8),
          minTileHeight: 34,
          leading: const Icon(Icons.folder_outlined, size: 16, color: Color(0xFFFBBF24)),
          title: Text(
            entry.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: _kWorkspacePaneText),
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

    final icon = _fileIcon(entry.name);
    final selected = selectedPath == entry.path;
    return ListTile(
      dense: true,
      selected: selected,
      selectedTileColor: const Color(0xFF1E293B),
      minTileHeight: 32,
      contentPadding: EdgeInsets.only(left: 14 + depth * 12, right: 10),
      leading: Icon(icon.icon, size: 15, color: icon.color),
      title: Text(
        entry.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 12,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
          color: selected ? Colors.white : _kWorkspacePaneText,
        ),
      ),
      onTap: () => onSelectFile(entry.path),
    );
  }
}

class _FileIconSpec {
  const _FileIconSpec(this.icon, this.color);

  final IconData icon;
  final Color color;
}

_FileIconSpec _fileIcon(String filename) {
  final parts = filename.toLowerCase().split('.');
  final ext = parts.length > 1 ? parts.last : '';

  switch (ext) {
    case 'ts':
    case 'tsx':
      return const _FileIconSpec(Icons.javascript, Color(0xFF38BDF8));
    case 'js':
    case 'jsx':
      return const _FileIconSpec(Icons.javascript, Color(0xFFFACC15));
    case 'json':
      return const _FileIconSpec(Icons.data_object, Color(0xFFFB923C));
    case 'md':
      return const _FileIconSpec(Icons.description_outlined, Color(0xFFA78BFA));
    case 'css':
    case 'scss':
    case 'less':
      return const _FileIconSpec(Icons.style, Color(0xFF60A5FA));
    case 'html':
      return const _FileIconSpec(Icons.language, Color(0xFFF97316));
    case 'go':
      return const _FileIconSpec(Icons.code, Color(0xFF22D3EE));
    case 'yml':
    case 'yaml':
      return const _FileIconSpec(Icons.settings_suggest, Color(0xFF10B981));
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
      return const _FileIconSpec(Icons.image_outlined, Color(0xFFF472B6));
    default:
      return const _FileIconSpec(Icons.description_outlined, Color(0xFF94A3B8));
  }
}
