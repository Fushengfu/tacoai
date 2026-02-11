import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../models/bridge_models.dart';

class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.role,
    required this.content,
    this.agentSteps = const <DesktopBridgeAgentStep>[],
    this.activePlan,
    this.screenshotUrls = const <String>[],
    this.streaming = false,
    this.showRoleLabel = false,
    this.onOpenImage,
  });

  final String role;
  final String content;
  final List<DesktopBridgeAgentStep> agentSteps;
  final DesktopBridgeActivePlan? activePlan;
  final List<String> screenshotUrls;
  final bool streaming;
  final bool showRoleLabel;
  final ValueChanged<String>? onOpenImage;

  @override
  Widget build(BuildContext context) {
    final isUser = role == 'user';
    final hasPlan = activePlan != null && activePlan!.steps.isNotEmpty;
    final hasSteps = agentSteps.isNotEmpty;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Align(
        alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          constraints: const BoxConstraints(maxWidth: 420),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: isUser
                ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.6)
                : Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (showRoleLabel) ...[
                Text(
                  streaming ? 'assistant (streaming)' : role,
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
              ],
              _MarkdownText(content: content),
              if (hasPlan) ...[
                const SizedBox(height: 10),
                _PlanPanel(plan: activePlan!),
              ],
              if (hasSteps) ...[
                const SizedBox(height: 10),
                ...agentSteps.map((step) => _StepPanel(step: step)),
              ],
              if (screenshotUrls.isNotEmpty) ...[
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: screenshotUrls
                      .map((url) => _ScreenshotThumb(
                            imageUrl: url,
                            onOpen: () => onOpenImage?.call(url),
                          ))
                      .toList(),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanPanel extends StatelessWidget {
  const _PlanPanel({required this.plan});

  final DesktopBridgeActivePlan plan;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            plan.summary.isEmpty ? 'Plan' : plan.summary,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          ...plan.steps.map((step) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: SelectableText(
                  '${_planStatusIcon(step.status)} ${step.text}',
                  style: const TextStyle(fontSize: 12, height: 1.35),
                ),
              )),
        ],
      ),
    );
  }
}

class _StepPanel extends StatelessWidget {
  const _StepPanel({required this.step});

  final DesktopBridgeAgentStep step;

  @override
  Widget build(BuildContext context) {
    final hasThinking = step.thinking.trim().isNotEmpty;
    final hasToolCalls = step.toolCalls.isNotEmpty;
    final hasToolResults = step.toolResults.isNotEmpty;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${_stepStatusLabel(step.status)} Step ${step.round}',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
          if (hasThinking) ...[
            const SizedBox(height: 6),
            _MarkdownText(content: step.thinking, compact: true),
          ],
          if (hasToolCalls) ...[
            const SizedBox(height: 6),
            ...step.toolCalls.map((call) => Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: SelectableText(
                    'Call ${call.name}${call.arguments.isEmpty ? '' : ': ${call.arguments}'}',
                    style: const TextStyle(fontSize: 12, height: 1.35),
                  ),
                )),
          ],
          if (hasToolResults) ...[
            const SizedBox(height: 6),
            ...step.toolResults.map((result) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: _ToolResultBlock(result: result),
                )),
          ],
        ],
      ),
    );
  }
}

class _ToolResultBlock extends StatelessWidget {
  const _ToolResultBlock({required this.result});

  final DesktopBridgeToolResult result;

  @override
  Widget build(BuildContext context) {
    final body = _formatToolResultBody(result.content);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: result.success
            ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.25)
            : Theme.of(context).colorScheme.errorContainer.withValues(alpha: 0.25),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(
            '${result.success ? 'OK' : 'FAIL'} ${result.name}',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 4),
            _MarkdownText(content: body, compact: true),
          ],
        ],
      ),
    );
  }
}

class _ScreenshotThumb extends StatelessWidget {
  const _ScreenshotThumb({
    required this.imageUrl,
    required this.onOpen,
  });

  final String imageUrl;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(10),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Image.network(
          imageUrl,
          width: 120,
          height: 84,
          fit: BoxFit.cover,
          errorBuilder: (context, error, stackTrace) => Container(
            width: 120,
            height: 84,
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            alignment: Alignment.center,
            child: const Text('Image unavailable', style: TextStyle(fontSize: 11)),
          ),
        ),
      ),
    );
  }
}

class _MarkdownText extends StatelessWidget {
  const _MarkdownText({
    required this.content,
    this.compact = false,
  });

  final String content;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final text = content.trim();
    if (text.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final base = MarkdownStyleSheet.fromTheme(theme);
    final textStyle = TextStyle(
      fontSize: compact ? 12 : 13,
      height: compact ? 1.35 : 1.45,
      color: theme.colorScheme.onSurface,
    );

    return MarkdownBody(
      data: text,
      selectable: true,
      shrinkWrap: true,
      softLineBreak: true,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      styleSheet: base.copyWith(
        p: textStyle,
        pPadding: EdgeInsets.zero,
        blockSpacing: compact ? 6 : 8,
        listBullet: textStyle,
        h1: textStyle.copyWith(fontWeight: FontWeight.w700, fontSize: compact ? 14 : 16),
        h2: textStyle.copyWith(fontWeight: FontWeight.w700, fontSize: compact ? 13 : 15),
        h3: textStyle.copyWith(fontWeight: FontWeight.w700, fontSize: compact ? 12 : 14),
        code: textStyle.copyWith(
          fontFamily: 'monospace',
          backgroundColor: theme.colorScheme.surfaceContainerHighest,
        ),
        codeblockPadding: const EdgeInsets.all(8),
        codeblockDecoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.8),
          borderRadius: BorderRadius.circular(8),
        ),
      ),
    );
  }
}

String _formatToolResultBody(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return '';
  final looksLikeJson = (text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('[') && text.endsWith(']'));
  if (looksLikeJson) {
    return '```json\n$text\n```';
  }
  if (text.contains('\n') && text.length > 180) {
    return '```\n$text\n```';
  }
  return text;
}

String _stepStatusLabel(String status) {
  switch (status) {
    case 'calling':
      return 'CALLING';
    case 'running':
      return 'RUNNING';
    case 'confirm':
      return 'CONFIRM';
    default:
      return 'DONE';
  }
}

String _planStatusIcon(String status) {
  switch (status) {
    case 'in_progress':
      return '[~]';
    case 'done':
      return '[v]';
    case 'failed':
      return '[x]';
    default:
      return '[ ]';
  }
}
