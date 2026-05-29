import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/bridge_protocol.dart';
import 'agent_step_widget.dart';

/// 简单的代码高亮器 — 确保代码块文本使用等宽字体和正确的样式
class _CodeHighlighter extends SyntaxHighlighter {
  final Color textColor;
  _CodeHighlighter({required this.textColor});

  @override
  TextSpan format(String code) {
    return TextSpan(
      text: code,
      style: TextStyle(
        fontFamily: 'monospace',
        fontSize: 13,
        color: textColor,
        height: 1.5,
      ),
    );
  }
}

/// 消息气泡组件 — 支持 Markdown 渲染、Agent 步骤展示、计划进度
class MessageBubble extends StatefulWidget {
  final BridgeChatMessage message;

  const MessageBubble({
    super.key,
    required this.message,
  });

  @override
  State<MessageBubble> createState() => _MessageBubbleState();
}

class _MessageBubbleState extends State<MessageBubble> {
  /// 判断消息是否有实际的工具调用步骤（排除纯 thinking 步骤）
  /// 只有包含工具调用、系统通知、确认等实际操作的步骤才显示执行步骤卡片
  bool _hasToolCallSteps(BridgeChatMessage msg) {
    if (msg.agentSteps == null || msg.agentSteps!.isEmpty) return false;
    for (final step in msg.agentSteps!) {
      // 有工具调用、系统通知、确认请求的步骤才算
      if (step.toolCalls.isNotEmpty ||
          step.systemTitle != null && step.systemTitle!.isNotEmpty ||
          step.confirmId != null) {
        return true;
      }
    }
    return false;
  }

  /// 判断消息是否正在处理中（根据 activePlan 和 agentSteps 状态）
  bool _isMessageProcessing(BridgeChatMessage msg) {
    // 如果有 taskTiming 且已结束，说明任务已完成
    if (msg.taskTiming != null && msg.taskTiming!.endedAt != null) {
      return false;
    }

    // 如果有 activePlan，说明正在执行
    if (msg.activePlan != null) return true;

    // 如果 agentSteps 中有 running/calling/confirm 状态的步骤，说明正在执行
    if (msg.agentSteps != null && msg.agentSteps!.isNotEmpty) {
      for (final step in msg.agentSteps!) {
        if (step.status == 'calling' || step.status == 'running' || step.status == 'confirm') {
          return true;
        }
      }
    }

    return false;
  }

  @override
  Widget build(BuildContext context) {
    final isUser = widget.message.role == 'user';
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: GestureDetector(
        onLongPress: () {
          final content = widget.message.content.trim();
          if (content.isNotEmpty) {
            _showCopyMenu(context, content);
          }
        },
        child: Column(
          crossAxisAlignment:
              isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            // 头像放在气泡上方
            Padding(
              padding: EdgeInsets.only(
                left: isUser ? 0 : 8,
                right: isUser ? 8 : 0,
                bottom: 4,
              ),
              child: _buildAvatar(isUser, colorScheme),
            ),
            // 气泡 — 用户消息按内容宽度自适应，assistant 消息全宽
            Align(
              alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
              child: isUser
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth: MediaQuery.of(context).size.width * 0.8,
                          ),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                            decoration: BoxDecoration(
                              color: colorScheme.primary,
                              borderRadius: const BorderRadius.only(
                                topLeft: Radius.circular(12),
                                bottomLeft: Radius.circular(12),
                                bottomRight: Radius.circular(12),
                              ),
                            ),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                // 图片附件
                                if (widget.message.images != null && widget.message.images!.isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 8),
                                    child: Wrap(
                                      spacing: 8,
                                      runSpacing: 8,
                                      children: widget.message.images!
                                          .map((img) => _buildImageThumbnail(img, colorScheme))
                                          .toList(),
                                    ),
                                  ),

                                // 文件附件
                                if (widget.message.attachments != null && widget.message.attachments!.isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 8),
                                    child: Wrap(
                                      spacing: 6,
                                      runSpacing: 6,
                                      children: widget.message.attachments!
                                          .map((asset) => _buildAssetChip(asset, colorScheme))
                                          .toList(),
                                    ),
                                  ),

                                // Markdown 内容
                                _buildContent(isUser, colorScheme),

                                // 流式指示器
                                // 判断条件：
                                // 1. 有 activePlan（正在执行计划）
                                // 2. agentSteps 中有 running/calling/confirm 状态的步骤（且任务未完成）
                                if (_isMessageProcessing(widget.message))
                                  Padding(
                                    padding: const EdgeInsets.only(top: 6),
                                    child: SizedBox(
                                      width: 14,
                                      height: 14,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    )
                  : ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: double.infinity),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        decoration: BoxDecoration(
                          color: colorScheme.surfaceContainerHighest,
                          borderRadius: const BorderRadius.only(
                            topLeft: Radius.circular(12),
                            topRight: Radius.circular(12),
                            bottomRight: Radius.circular(12),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            // 图片附件
                            if (widget.message.images != null && widget.message.images!.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Wrap(
                                  spacing: 8,
                                  runSpacing: 8,
                                  children: widget.message.images!
                                      .map((img) => _buildImageThumbnail(img, colorScheme))
                                      .toList(),
                                ),
                              ),

                            // 文件附件
                            if (widget.message.attachments != null && widget.message.attachments!.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: widget.message.attachments!
                                      .map((asset) => _buildAssetChip(asset, colorScheme))
                                      .toList(),
                                ),
                              ),

                            // Agent 步骤（仅 assistant 消息，且至少有一个步骤包含工具调用或系统通知才显示）
                            // 过滤掉只有 thinking 的步骤（普通聊天模式下模型可能生成 thinking 但无工具调用）
                            if (_hasToolCallSteps(widget.message))
                              AgentStepWidget(
                                steps: widget.message.agentSteps!,
                                colorScheme: colorScheme,
                              ),

                            // 执行计划（仅 assistant 消息）
                            if (widget.message.activePlan != null)
                              ActivePlanWidget(
                                plan: widget.message.activePlan!,
                                colorScheme: colorScheme,
                              ),

                            // Markdown 内容
                            _buildContent(isUser, colorScheme),

                            // 流式指示器
                            if (widget.message.activePlan != null ||
                                (widget.message.agentSteps?.isNotEmpty == true &&
                                 widget.message.agentSteps!.last.status == 'running'))
                              Padding(
                                padding: const EdgeInsets.only(top: 6),
                                child: SizedBox(
                                  width: 14,
                                  height: 14,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: colorScheme.primary,
                                  ),
                                ),
                              ),

                            // 任务耗时
                            if (!isUser && widget.message.taskTiming != null)
                              TaskTimingWidget(
                                timing: widget.message.taskTiming!,
                                colorScheme: colorScheme,
                              ),
                          ],
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  void _showCopyMenu(BuildContext context, String content) {
    final RenderBox? box = context.findRenderObject() as RenderBox?;
    if (box == null) return;

    final Offset position = box.localToGlobal(Offset.zero);
    final Size size = box.size;

    showMenu(
      context: context,
      position: RelativeRect.fromLTRB(
        position.dx + size.width / 2,
        position.dy + size.height / 2,
        position.dx + size.width / 2,
        position.dy + size.height / 2,
      ),
      items: [
        PopupMenuItem(
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.copy, size: 18),
              SizedBox(width: 8),
              Text('复制'),
            ],
          ),
          onTap: () {
            Clipboard.setData(ClipboardData(text: content));
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('已复制到剪贴板'),
                duration: Duration(seconds: 1),
                behavior: SnackBarBehavior.floating,
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _buildAvatar(bool isUser, ColorScheme colorScheme) {
    return CircleAvatar(
      radius: 16,
      backgroundColor: isUser
          ? colorScheme.primary
          : colorScheme.secondaryContainer,
      child: Icon(
        isUser ? Icons.person : Icons.smart_toy,
        size: 18,
        color: isUser ? Colors.white : colorScheme.onSecondaryContainer,
      ),
    );
  }

  /// 构建图片缩略图
  Widget _buildImageThumbnail(BridgeAttachedImage img, ColorScheme colorScheme) {
    // 优先使用 dataUrl（本地预览），回退到 cloudUrl（云端URL）
    String? imageSrc;
    if (img.dataUrl.isNotEmpty) {
      imageSrc = img.dataUrl;
    } else if (img.cloudUrl.isNotEmpty) {
      imageSrc = img.cloudUrl;
    }
    
    if (imageSrc == null || imageSrc.isEmpty) return const SizedBox.shrink();

    return GestureDetector(
      onTap: () {
        // TODO: 可以后续添加图片预览功能
      },
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: _buildImageWidget(imageSrc, colorScheme),
      ),
    );
  }

  /// 构建图片 Widget（支持 dataUrl 和网络 URL）
  Widget _buildImageWidget(String src, ColorScheme colorScheme) {
    // 判断是否为 dataUrl
    if (src.startsWith('data:')) {
      // 提取 base64 数据
      final match = RegExp(r'data:image/[^;]+;base64,(.+)').firstMatch(src);
      if (match == null) {
        return _buildImageErrorWidget(colorScheme);
      }
      
      final base64Data = match.group(1)!;
      final bytes = base64Decode(base64Data);
      
      return Image.memory(
        bytes,
        width: 150,
        height: 150,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stackTrace) {
          return _buildImageErrorWidget(colorScheme);
        },
      );
    } else {
      // 网络 URL
      return Image.network(
        src,
        width: 150,
        height: 150,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stackTrace) {
          return _buildImageErrorWidget(colorScheme);
        },
        loadingBuilder: (context, child, loadingProgress) {
          if (loadingProgress == null) return child;
          return Container(
            width: 150,
            height: 150,
            color: colorScheme.surfaceContainerHighest,
            child: Center(
              child: CircularProgressIndicator(
                strokeWidth: 2,
                value: loadingProgress.expectedTotalBytes != null
                    ? loadingProgress.cumulativeBytesLoaded / loadingProgress.expectedTotalBytes!
                    : null,
                color: colorScheme.primary,
              ),
            ),
          );
        },
      );
    }
  }

  /// 构建图片错误提示
  Widget _buildImageErrorWidget(ColorScheme colorScheme) {
    return Container(
      width: 150,
      height: 150,
      color: colorScheme.surfaceContainerHighest,
      child: Icon(Icons.broken_image, size: 40, color: colorScheme.onSurfaceVariant),
    );
  }

  /// 构建文件附件卡片
  Widget _buildAssetChip(BridgeAttachedAsset asset, ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: colorScheme.outline.withValues(alpha: 0.2),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.attach_file, size: 14, color: colorScheme.onSurfaceVariant),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: 120,
            ),
            child: Text(
              asset.name,
              style: TextStyle(
                fontSize: 12,
                color: colorScheme.onSurface,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(bool isUser, ColorScheme colorScheme) {
    var content = widget.message.content.trim();
    if (content.isEmpty) return const SizedBox.shrink();

    // 过滤 [DONE] 标记（某些模型会在文本末尾生成 [DONE]，属于 SSE 终止符误入内容）
    content = content.replaceAll(RegExp(r'\[DONE\]\s*$'), '').trim();

    if (isUser) {
      return Text(
        content,
        style: TextStyle(
          color: Colors.white,
          fontSize: 14,
          height: 1.5,
        ),
      );
    }

    // 构建样式表（使用局部变量避免 const 求值问题）
    final styleSheet = MarkdownStyleSheet(
      p: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 14,
        height: 1.6,
      ),
      code: TextStyle(
        fontFamily: 'monospace',
        fontSize: 13,
        backgroundColor: colorScheme.surfaceContainerHighest,
        color: colorScheme.onSurface,
      ),
      codeblockDecoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: colorScheme.outline.withValues(alpha: 0.15),
          width: 1,
        ),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      blockquote: TextStyle(
        color: colorScheme.onSurface.withValues(alpha: 0.7),
        fontStyle: FontStyle.italic,
      ),
      blockquoteDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: colorScheme.outline.withValues(alpha: 0.3),
            width: 3,
          ),
        ),
      ),
      h1: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 20,
        fontWeight: FontWeight.bold,
      ),
      h2: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 18,
        fontWeight: FontWeight.bold,
      ),
      h3: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 16,
        fontWeight: FontWeight.bold,
      ),
      listBullet: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 14,
      ),
      tableHead: TextStyle(
        color: colorScheme.onSurface,
        fontWeight: FontWeight.bold,
        fontSize: 13,
      ),
      tableBody: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 13,
      ),
      tableBorder: TableBorder.all(
        color: colorScheme.outline.withValues(alpha: 0.2),
        width: 1,
      ),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    );

    return MarkdownBody(
      data: content,
      syntaxHighlighter: _CodeHighlighter(textColor: colorScheme.onSurface),
      styleSheet: styleSheet,
      selectable: true,
      onTapLink: (text, href, title) {
        // 可以后续添加链接跳转
      },
    );
  }
}
