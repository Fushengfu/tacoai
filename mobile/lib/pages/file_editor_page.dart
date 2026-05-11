import 'package:flutter/material.dart';
import 'dart:convert';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';

/// 文件编辑器/查看器页面
///
/// 功能：
/// - 加载远程文件内容
/// - 文本文件支持编辑并保存回桌面端
/// - 图片文件显示预览（base64 dataUrl）
/// - 二进制文件显示提示信息
/// - 保存后自动回到上一页
class FileEditorPage extends StatefulWidget {
  final BridgeClient client;
  final String filePath;
  final String? workspace;

  const FileEditorPage({
    super.key,
    required this.client,
    required this.filePath,
    this.workspace,
  });

  @override
  State<FileEditorPage> createState() => _FileEditorPageState();
}

class _FileEditorPageState extends State<FileEditorPage> {
  final TextEditingController _contentController = TextEditingController();

  BridgeFileContentResponse? _fileData;
  bool _loading = true;
  bool _saving = false;
  bool _isEditing = false;
  String? _error;
  String? _dataUrl;
  String? _originalContent; // 保存原始内容用于对比

  @override
  void initState() {
    super.initState();
    _loadFile();
  }

  @override
  void dispose() {
    _contentController.dispose();
    super.dispose();
  }

  Future<void> _loadFile() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final result = await widget.client.readFile(widget.filePath);
      if (!mounted) return;

      String? displayDataUrl = result.dataUrl;
      // 如果是二进制文件且有 dataUrl（十六进制预览），需要解码
      if (result.isBinary && result.dataUrl != null) {
        try {
          final uri = Uri.parse(result.dataUrl!);
          final mimeType = uri.data!.mimeType;
          if (mimeType == 'text/plain') {
            displayDataUrl = utf8.decode(uri.data!.contentAsBytes());
          }
        } catch (_) {
          // 解码失败则保持原样
        }
      }

      setState(() {
        _fileData = result;
        _loading = false;
        _dataUrl = displayDataUrl;
        _originalContent = result.content;

        if (!result.isBinary && result.content != null) {
          _contentController.text = result.content!;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '加载文件失败: $e';
        _loading = false;
      });
    }
  }

  Future<void> _saveFile() async {
    if (_fileData == null || _fileData!.isBinary) return;

    final content = _contentController.text;
    
    // 检查内容是否有变化
    if (content == _originalContent) {
      _showToast('内容未修改，无需保存');
      return;
    }

    setState(() => _saving = true);

    try {
      final result = await widget.client.writeFile(widget.filePath, content);
      if (!mounted) return;

      setState(() {
        _saving = false;
        _isEditing = false;
        _originalContent = content; // 更新原始内容
      });

      if (result.success) {
        _showToast('文件已保存');
        Navigator.pop(context);
      } else {
        _showToast('保存失败: ${result.error ?? "未知错误"}');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      _showToast('保存异常: $e');
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

  String _formatSize(int bytes) {
    if (bytes >= 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '$bytes B';
  }

  @override
  Widget build(BuildContext context) {
    // 从完整路径提取文件名
    final fileName = widget.filePath.split('/').last;
    final truncated = _fileData?.truncated ?? false;

    return Scaffold(
      appBar: AppBar(
        title: Text(fileName, style: const TextStyle(fontSize: 15)),
        titleSpacing: 4,
        actions: [
          // 编辑/保存按钮（仅文本文件）
          if (_fileData != null && !_fileData!.isBinary && _fileData!.content != null) ...[
            if (_isEditing) ...[
              TextButton(
                onPressed: _saving ? null : _saveFile,
                child: _saving
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('保存'),
              ),
              TextButton(
                onPressed: () {
                  setState(() {
                    _isEditing = false;
                    _contentController.text = _fileData!.content ?? '';
                  });
                },
                child: const Text('取消'),
              ),
            ] else ...[
              IconButton(
                icon: const Icon(Icons.edit),
                tooltip: '编辑',
                onPressed: () => setState(() => _isEditing = true),
              ),
            ],
          ],
        ],
      ),
      body: _buildBody(fileName, truncated),
    );
  }

  Widget _buildBody(String fileName, bool truncated) {
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
            FilledButton(onPressed: _loadFile, child: const Text('重试')),
          ],
        ),
      );
    }

    if (_fileData == null) {
      return const Center(child: Text('无法加载文件'));
    }

    // 图片预览
    if (_dataUrl != null && _dataUrl!.isNotEmpty) {
      return SingleChildScrollView(
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              width: double.infinity,
              child: Text(
                '${fileName}  (${_formatSize(_fileData!.size)})',
                style: const TextStyle(fontSize: 12),
              ),
            ),
            InteractiveViewer(
              child: Image.memory(
                base64Decode(_dataUrl!.split(',').last),
                fit: BoxFit.contain,
                errorBuilder: (context, error, stackTrace) => const Icon(Icons.broken_image, size: 64),
              ),
            ),
          ],
        ),
      );
    }

    // 二进制文件（含十六进制预览）
    if (_fileData!.isBinary && _dataUrl == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.insert_drive_file, size: 64, color: Colors.grey),
            const SizedBox(height: 12),
            Text(
              '二进制文件',
              style: TextStyle(fontSize: 16, color: Theme.of(context).colorScheme.onSurface),
            ),
            const SizedBox(height: 4),
            Text(
              '大小: ${_formatSize(_fileData!.size)}',
              style: const TextStyle(fontSize: 13, color: Colors.grey),
            ),
          ],
        ),
      );
    }

    // 二进制文件十六进制预览
    if (_fileData!.isBinary && _dataUrl != null) {
      return Column(
        children: [
          // 文件信息条
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            width: double.infinity,
            child: Row(
              children: [
                const Icon(Icons.hexagon, size: 16, color: Colors.orange),
                const SizedBox(width: 8),
                Text(
                  '二进制文件 (${_formatSize(_fileData!.size)})',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
                ),
                const Spacer(),
                const Text('仅预览前 8KB', style: TextStyle(fontSize: 11, color: Colors.grey)),
              ],
            ),
          ),
          // 十六进制内容区
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(12),
              child: SelectableText(
                _dataUrl!,
                style: const TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  height: 1.4,
                ),
              ),
            ),
          ),
        ],
      );
    }

    // 文本内容
    final content = _fileData!.content ?? '';

    return Column(
      children: [
        // 文件信息条
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          width: double.infinity,
          child: Row(
            children: [
              Text(
                '${_formatSize(_fileData!.size)}',
                style: const TextStyle(fontSize: 11),
              ),
              if (truncated) ...[
                const SizedBox(width: 8),
                const Text('(仅预览尾部)', style: TextStyle(fontSize: 11, color: Colors.orange)),
              ],
              const Spacer(),
              if (_isEditing)
                const Text('编辑中', style: TextStyle(fontSize: 11, color: Colors.blue)),
            ],
          ),
        ),
        // 内容区：编辑模式 vs 只读模式
        Expanded(
          child: _isEditing
              ? TextField(
                  controller: _contentController,
                  maxLines: null,
                  expands: true,
                  style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    contentPadding: EdgeInsets.all(12),
                  ),
                  textAlignVertical: TextAlignVertical.top,
                )
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(12),
                  child: SelectableText(
                    content,
                    style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                  ),
                ),
        ),
      ],
    );
  }
}
