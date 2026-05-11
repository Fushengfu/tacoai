import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/bridge_protocol.dart';
import 'agent_step_widget.dart';

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
                                // Markdown 内容
                                _buildContent(isUser, colorScheme),

                                // 流式指示器
                                if (widget.message.streaming)
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
                            // Agent 步骤（仅 assistant 消息）
                            if (widget.message.agentSteps != null &&
                                widget.message.agentSteps!.isNotEmpty)
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
                            if (widget.message.streaming)
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

  Widget _buildContent(bool isUser, ColorScheme colorScheme) {
    final content = widget.message.content.trim();
    if (content.isEmpty) return const SizedBox.shrink();

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

    return MarkdownBody(
      data: content,
      styleSheet: MarkdownStyleSheet(
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
        ),
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
      ),
      selectable: true,
      onTapLink: (text, href, title) {
        // 可以后续添加链接跳转
      },
    );
  }
}
