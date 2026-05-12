import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/bridge_protocol.dart';

/// Diff 行类型
class DiffLine {
  final String type; // 'same' | 'add' | 'remove'
  final String content;
  final int? oldLineNo;
  final int? newLineNo;

  DiffLine({
    required this.type,
    required this.content,
    this.oldLineNo,
    this.newLineNo,
  });
}

/// Agent 执行步骤列表组件（可折叠展开）
class AgentStepWidget extends StatefulWidget {
  final List<BridgeAgentStep> steps;
  final ColorScheme colorScheme;
  final String workspace;
  final void Function(String filePath)? onOpenFile;

  const AgentStepWidget({
    super.key,
    required this.steps,
    required this.colorScheme,
    this.workspace = '',
    this.onOpenFile,
  });

  @override
  State<AgentStepWidget> createState() => _AgentStepWidgetState();
}

class _AgentStepWidgetState extends State<AgentStepWidget> {
  bool _expanded = false;
  final Map<String, bool> _stepExpandedMap = {};
  final Map<String, bool> _toolBlockExpandedMap = {};
  final Map<String, bool> _thinkExpandedMap = {};
  final Map<String, bool> _respondedConfirms = {};

  @override
  Widget build(BuildContext context) {
    final steps = widget.steps;
    final colorScheme = widget.colorScheme;
    final activeCount = steps.where((s) =>
        s.status == 'running' || s.status == 'calling' || s.status == 'confirm').length;
    final doneCount = steps.where((s) => s.status == 'done').length;
    final failedCount = steps.where((s) => s.status == 'done' && s.toolResults.any((r) => !r.success)).length;
    final hasActive = activeCount > 0;
    final isExpanded = hasActive || _expanded;

    final groupOperation = _stepGroupOperationSummary(steps);
    final groupSummary = hasActive
        ? '$activeCount 个执行中'
        : '$doneCount/${steps.length} 已完成${failedCount > 0 ? ' · $failedCount 异常' : ''}';

    // 找到计划确认步骤的位置，分割 beforePlan 和 afterPlan
    final planStepIdx = steps.indexWhere((s) =>
        s.risks != null && s.risks!.any((r) => r.toolName == 'propose_plan'));
    final hasPlanSplit = planStepIdx >= 0;
    final beforePlan = hasPlanSplit ? steps.sublist(0, planStepIdx + 1) : <BridgeAgentStep>[];
    final afterPlan = hasPlanSplit ? steps.sublist(planStepIdx + 1) : steps;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: colorScheme.surface.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: colorScheme.outline.withValues(alpha: 0.15),
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !isExpanded),
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Icon(
                    Icons.build_rounded,
                    size: 16,
                    color: hasActive ? colorScheme.primary : colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '执行步骤',
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                      color: colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      groupOperation,
                      style: TextStyle(
                        fontSize: 12,
                        color: colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: hasActive
                          ? colorScheme.primaryContainer
                          : colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      groupSummary,
                      style: TextStyle(
                        fontSize: 11,
                        color: hasActive
                            ? colorScheme.onPrimaryContainer
                            : colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '${steps.length} 条',
                    style: TextStyle(
                      fontSize: 11,
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const Spacer(),
                  Icon(
                    Icons.expand_more,
                    size: 18,
                    color: colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (isExpanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Column(
                children: [
                  ...beforePlan.map((step) => _buildStepItem(step)),
                  ...afterPlan.map((step) => _buildStepItem(step)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildStepItem(BridgeAgentStep step) {
    final stepKey = 'step-${step.round}';
    final isStepRunning = step.status == 'running' || step.status == 'calling';
    final isStepConfirm = step.status == 'confirm';
    final isExpanded = isStepRunning || isStepConfirm || (_stepExpandedMap[stepKey] ?? false);
    final summary = _stepHeaderSummary(step);
    // 步骤标记为 done 但工具结果中有失败时，视为失败状态
    final hasFailedResults = step.status == 'done' && step.toolResults.any((r) => !r.success);
    final effectiveStatus = hasFailedResults ? 'failed' : step.status;

    return Container(
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: widget.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _stepExpandedMap[stepKey] = !isExpanded),
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Row(
                children: [
                  _buildStepIcon(effectiveStatus, widget.colorScheme, isStepRunning),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      summary.label,
                      style: const TextStyle(fontSize: 12),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (summary.detail.isNotEmpty)
                    Flexible(
                      child: GestureDetector(
                        onTap: summary.filePath != null && widget.onOpenFile != null
                            ? () => widget.onOpenFile!(summary.filePath!)
                            : null,
                        child: Text(
                          summary.detail,
                          style: TextStyle(
                            fontSize: 11,
                            color: summary.filePath != null
                                ? widget.colorScheme.primary
                                : widget.colorScheme.onSurfaceVariant,
                            decoration: summary.filePath != null
                                ? TextDecoration.underline
                                : null,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                  Icon(
                    isExpanded ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: widget.colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (isExpanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildStepThinking(step, isStepRunning, isAutoExpanded: isExpanded),
                  _buildStepConfirmStatus(step, isStepRunning),
                  _buildStepToolResults(step, isStepRunning),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildStepThinking(BridgeAgentStep step, bool isStepRunning, {bool isAutoExpanded = false}) {
    if (step.thinking.isEmpty) return const SizedBox.shrink();
    final thinkKey = 'think-${step.round}';
    final isThinkOpen = _thinkExpandedMap[thinkKey] ?? false;
    final cleaned = step.thinking
        .replaceAll(RegExp(r'<think>', caseSensitive: false), '')
        .replaceAll(RegExp(r'</think>', caseSensitive: false), '')
        .trim();
    if (cleaned.isEmpty) return const SizedBox.shrink();

    final preview = cleaned.length > 80
        ? cleaned.substring(0, 80).replaceAll('\n', ' ') + '...'
        : cleaned.replaceAll('\n', ' ');

    // 只有当前运行中的步骤（自动展开）才显示完整思考文本
    // 已完成步骤默认只显示摘要预览，需用户手动点击才能展开
    final showFullThinking = isStepRunning && isAutoExpanded;

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _thinkExpandedMap[thinkKey] = !isThinkOpen),
            child: Row(
              children: [
                Icon(
                  isThinkOpen ? Icons.expand_less : Icons.expand_more,
                  size: 14,
                  color: widget.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 4),
                Text(
                  '💭 思考',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: widget.colorScheme.onSurfaceVariant,
                  ),
                ),
                if (isStepRunning) ...[
                  const SizedBox(width: 4),
                  SizedBox(
                    width: 10,
                    height: 10,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: widget.colorScheme.primary,
                    ),
                  ),
                ],
                if (!isThinkOpen) ...[
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      preview,
                      style: TextStyle(
                        fontSize: 11,
                        color: widget.colorScheme.onSurface.withValues(alpha: 0.6),
                        fontStyle: FontStyle.italic,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (isThinkOpen || showFullThinking)
            Padding(
              padding: const EdgeInsets.only(top: 4, left: 18),
              child: MarkdownBody(
                data: cleaned,
                styleSheet: MarkdownStyleSheet(
                  p: TextStyle(
                    fontSize: 12,
                    color: widget.colorScheme.onSurface.withValues(alpha: 0.8),
                    height: 1.5,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildStepConfirmStatus(BridgeAgentStep step, bool isStepRunning) {
    // 确认UI已移至顶部 ConfirmBanner，此处仅保留状态提示
    if (step.confirmId == null) return const SizedBox.shrink();
    
    final responded = _respondedConfirms[step.confirmId!];
    final isStepConfirm = step.status == 'confirm';
    final confirmStatus = responded == true
        ? 'approved'
        : responded == false
            ? 'denied'
            : (!isStepConfirm ? 'approved' : 'pending');
    
    if (confirmStatus == 'pending') {
      return Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: widget.colorScheme.primaryContainer.withValues(alpha: 0.2),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 12,
              height: 12,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: widget.colorScheme.primary,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '等待确认中...',
              style: TextStyle(
                fontSize: 12,
                color: widget.colorScheme.primary,
              ),
            ),
          ],
        ),
      );
    }
    
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: confirmStatus == 'approved'
            ? Colors.green.withValues(alpha: 0.1)
            : Colors.red.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          Icon(
            confirmStatus == 'approved' ? Icons.check_circle : Icons.cancel,
            size: 14,
            color: confirmStatus == 'approved' ? Colors.green : Colors.red,
          ),
          const SizedBox(width: 6),
          Text(
            confirmStatus == 'approved' ? '已确认执行' : '已拒绝',
            style: TextStyle(
              fontSize: 12,
              color: confirmStatus == 'approved' ? Colors.green : Colors.red,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStepToolResults(BridgeAgentStep step, bool isStepRunning) {
    if (step.toolCalls.isEmpty) {
      if (isStepRunning) {
        return Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(
            children: [
              SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(strokeWidth: 2, color: widget.colorScheme.primary),
              ),
              const SizedBox(width: 6),
              Text('执行中...', style: TextStyle(fontSize: 12, color: widget.colorScheme.onSurfaceVariant)),
            ],
          ),
        );
      }
      return const SizedBox.shrink();
    }

    if (step.toolCalls.length == 1) {
      final tc = step.toolCalls[0];
      final result = step.toolResults.where((r) => r.toolCallId == tc.id).firstOrNull;
      final isToolRunning = result == null && isStepRunning;

      if (result != null) {
        return _buildToolResultBlock(tc, result, widget.colorScheme);
      }
      if (isToolRunning) {
        return Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(
            children: [
              SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(strokeWidth: 2, color: widget.colorScheme.primary),
              ),
              const SizedBox(width: 6),
              Text('执行中...', style: TextStyle(fontSize: 12, color: widget.colorScheme.onSurfaceVariant)),
            ],
          ),
        );
      }
      return const SizedBox.shrink();
    }

    // 多工具：每个工具独立折叠块
    return Column(
      children: step.toolCalls.asMap().entries.map((entry) {
        final index = entry.key;
        final tc = entry.value;
        final sm = _toolCallSummary(tc);
        final result = step.toolResults.where((r) => r.toolCallId == tc.id).firstOrNull;
        final tbKey = 'tb-${step.round}-${tc.id}';
        final isToolRunning = result == null && isStepRunning;
        final isToolBlockOpen = isToolRunning || (_toolBlockExpandedMap[tbKey] ?? false);
        final actionLabel = sm.label.isNotEmpty ? sm.label : '执行操作';
        final actionDetail = sm.detail.isNotEmpty ? sm.detail : '无附加信息';

        return Container(
          margin: const EdgeInsets.only(top: 4),
          decoration: BoxDecoration(
            color: widget.colorScheme.surface.withValues(alpha: 0.3),
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: isToolRunning
                  ? widget.colorScheme.primary.withValues(alpha: 0.3)
                  : widget.colorScheme.outline.withValues(alpha: 0.1),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              InkWell(
                onTap: () => setState(() => _toolBlockExpandedMap[tbKey] = !isToolBlockOpen),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  child: Row(
                    children: [
                      Text(
                        actionLabel,
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        '${index + 1}/${step.toolCalls.length}',
                        style: TextStyle(
                          fontSize: 10,
                          color: widget.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const Spacer(),
                      if (sm.filePath != null && widget.onOpenFile != null)
                        GestureDetector(
                          onTap: () => widget.onOpenFile!(sm.filePath!),
                          child: Text(
                            actionDetail,
                            style: TextStyle(
                              fontSize: 11,
                              color: widget.colorScheme.primary,
                              decoration: TextDecoration.underline,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        )
                      else
                        Flexible(
                          child: Text(
                            actionDetail,
                            style: TextStyle(
                              fontSize: 11,
                              color: widget.colorScheme.onSurfaceVariant,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      const SizedBox(width: 4),
                      Icon(
                        isToolBlockOpen ? Icons.expand_less : Icons.expand_more,
                        size: 14,
                        color: widget.colorScheme.onSurfaceVariant,
                      ),
                    ],
                  ),
                ),
              ),
              if (isToolBlockOpen)
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
                  child: result != null
                      ? _buildToolResultBlock(tc, result, widget.colorScheme)
                      : isToolRunning
                          ? Row(
                              children: [
                                SizedBox(
                                  width: 10,
                                  height: 10,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: widget.colorScheme.primary,
                                  ),
                                ),
                                const SizedBox(width: 4),
                                Text('执行中...',
                                    style: TextStyle(
                                        fontSize: 11,
                                        color: widget.colorScheme.onSurfaceVariant)),
                              ],
                            )
                          : const SizedBox.shrink(),
                ),
            ],
          ),
        );
      }).toList(),
    );
  }

  Widget _buildToolResultBlock(
      BridgeToolCall tc, BridgeToolResult result, ColorScheme colorScheme) {
    // 文件变更：显示 diff 而非纯文本
    if (result.fileChange != null) {
      return _buildFileChangeDiff(result.fileChange!, result, colorScheme);
    }

    final resultKey = 'result-${tc.id}';
    final isResultExpanded = _toolBlockExpandedMap[resultKey] ?? false;
    final content = result.content;
    final isLongContent = content.length > 300;
    final preview = isLongContent ? content.substring(0, 300) : content;

    return Container(
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: result.success
            ? colorScheme.primaryContainer.withValues(alpha: 0.15)
            : Colors.red.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: isLongContent
                ? () => setState(() => _toolBlockExpandedMap[resultKey] = !isResultExpanded)
                : null,
            child: Row(
              children: [
                Icon(
                  result.success ? Icons.check_circle : Icons.error,
                  size: 12,
                  color: result.success ? Colors.green : Colors.red,
                ),
                const SizedBox(width: 4),
                Text(
                  result.success ? '成功' : '失败',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: result.success ? Colors.green : Colors.red,
                  ),
                ),
                if (isLongContent) ...[
                  const Spacer(),
                  Text(
                    isResultExpanded ? '收起' : '展开 (${content.length} 字符)',
                    style: TextStyle(
                      fontSize: 10,
                      color: colorScheme.primary,
                    ),
                  ),
                  Icon(
                    isResultExpanded ? Icons.expand_less : Icons.expand_more,
                    size: 14,
                    color: colorScheme.primary,
                  ),
                ],
              ],
            ),
          ),
          if (content.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: isLongContent && !isResultExpanded
                  ? Text(
                      '$preview...',
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: colorScheme.onSurface.withValues(alpha: 0.7),
                      ),
                      maxLines: 5,
                      overflow: TextOverflow.ellipsis,
                    )
                  : Container(
                      constraints: BoxConstraints(
                        maxHeight: isLongContent ? 300 : double.infinity,
                      ),
                      decoration: BoxDecoration(
                        color: colorScheme.surface.withValues(alpha: 0.5),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      padding: const EdgeInsets.all(6),
                      child: SingleChildScrollView(
                        child: SelectableText(
                          content,
                          style: TextStyle(
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: colorScheme.onSurface.withValues(alpha: 0.8),
                            height: 1.4,
                          ),
                        ),
                      ),
                    ),
            ),
        ],
      ),
    );
  }

  /// 文件变更 diff 显示（编辑/新建/删除）
  Widget _buildFileChangeDiff(
      BridgeFileChange change, BridgeToolResult result, ColorScheme colorScheme) {
    final diffLines = _computeDiff(change.oldContent, change.newContent);
    final hunks = _groupDiffHunks(diffLines);
    final added = diffLines.where((l) => l.type == 'add').length;
    final removed = diffLines.where((l) => l.type == 'remove').length;
    final isNew = change.oldContent == null;
    final isDelete = change.newContent == null;

    return Container(
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: result.success
            ? colorScheme.primaryContainer.withValues(alpha: 0.1)
            : Colors.red.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(
          color: colorScheme.outline.withValues(alpha: 0.1),
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 文件路径 + 统计
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                Icon(
                  isNew ? Icons.note_add : isDelete ? Icons.delete : Icons.edit,
                  size: 14,
                  color: isNew ? Colors.green : isDelete ? Colors.red : Colors.blue,
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    change.filePath,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: colorScheme.onSurface,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Text(
                  isNew
                      ? '新建文件'
                      : isDelete
                          ? '删除文件'
                          : '+${added} -${removed}',
                  style: TextStyle(
                    fontSize: 10,
                    color: isNew ? Colors.green : isDelete ? Colors.red : colorScheme.onSurfaceVariant,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          // Diff 内容
          Container(
            constraints: const BoxConstraints(maxHeight: 400),
            decoration: BoxDecoration(
              color: colorScheme.surface.withValues(alpha: 0.5),
              borderRadius: const BorderRadius.only(
                bottomLeft: Radius.circular(4),
                bottomRight: Radius.circular(4),
              ),
            ),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: hunks.asMap().entries.map((entry) {
                  final hi = entry.key;
                  final hunk = entry.value;
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (hi > 0)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.3),
                          child: const Text(
                            '···',
                            style: TextStyle(fontSize: 10, color: Colors.grey),
                          ),
                        ),
                      ...hunk.map((line) => _buildDiffLine(line, colorScheme)),
                    ],
                  );
                }).toList(),
              ),
            ),
          ),
          // 错误提示
          if (!result.success && result.content.isNotEmpty)
            Padding(
              padding: const EdgeInsets.all(6),
              child: Text(
                result.content,
                style: const TextStyle(fontSize: 10, color: Colors.red),
              ),
            ),
        ],
      ),
    );
  }

  /// 单行 diff 渲染
  Widget _buildDiffLine(DiffLine line, ColorScheme colorScheme) {
    Color bgColor;
    Color textColor;
    String prefix;

    switch (line.type) {
      case 'add':
        bgColor = Colors.green.withValues(alpha: 0.1);
        textColor = Colors.green.shade700;
        prefix = '+';
        break;
      case 'remove':
        bgColor = Colors.red.withValues(alpha: 0.1);
        textColor = Colors.red.shade700;
        prefix = '-';
        break;
      default:
        bgColor = Colors.transparent;
        textColor = colorScheme.onSurface.withValues(alpha: 0.6);
        prefix = ' ';
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      color: bgColor,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 24,
            child: Text(
              '${line.oldLineNo ?? line.newLineNo ?? ''}',
              style: TextStyle(
                fontSize: 9,
                color: colorScheme.onSurface.withValues(alpha: 0.4),
                fontFamily: 'monospace',
              ),
              textAlign: TextAlign.right,
            ),
          ),
          Text(
            prefix,
            style: TextStyle(
              fontSize: 11,
              fontFamily: 'monospace',
              color: textColor,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: SelectableText(
              line.content.isEmpty ? '\u00A0' : line.content,
              style: TextStyle(
                fontSize: 11,
                fontFamily: 'monospace',
                color: textColor,
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 计算行级 diff
  List<DiffLine> _computeDiff(String? oldText, String? newText) {
    final oldLines = oldText?.split('\n') ?? [];
    final newLines = newText?.split('\n') ?? [];

    if (newLines.isEmpty && oldLines.isNotEmpty) {
      return oldLines.asMap().entries.map((e) => DiffLine(
        type: 'remove',
        content: e.value,
        oldLineNo: e.key + 1,
      )).toList();
    }

    if (oldLines.isEmpty) {
      return newLines.asMap().entries.map((e) => DiffLine(
        type: 'add',
        content: e.value,
        newLineNo: e.key + 1,
      )).toList();
    }

    final lcs = _computeLCS(oldLines, newLines);
    final result = <DiffLine>[];
    int oi = 0, ni = 0, li = 0, oldNo = 1, newNo = 1;

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length &&
          oi < oldLines.length &&
          ni < newLines.length &&
          oldLines[oi] == lcs[li] &&
          newLines[ni] == lcs[li]) {
        result.add(DiffLine(type: 'same', content: oldLines[oi], oldLineNo: oldNo, newLineNo: newNo));
        oi++; ni++; li++; oldNo++; newNo++;
      } else if (li < lcs.length && oi < oldLines.length && oldLines[oi] != lcs[li]) {
        result.add(DiffLine(type: 'remove', content: oldLines[oi], oldLineNo: oldNo));
        oi++; oldNo++;
      } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] != lcs[li])) {
        result.add(DiffLine(type: 'add', content: newLines[ni], newLineNo: newNo));
        ni++; newNo++;
      } else if (oi < oldLines.length) {
        result.add(DiffLine(type: 'remove', content: oldLines[oi], oldLineNo: oldNo));
        oi++; oldNo++;
      } else if (ni < newLines.length) {
        result.add(DiffLine(type: 'add', content: newLines[ni], newLineNo: newNo));
        ni++; newNo++;
      } else {
        break;
      }
    }

    return result;
  }

  /// 最长公共子序列
  List<String> _computeLCS(List<String> a, List<String> b) {
    if (a.length * b.length > 2000000) {
      return _simpleLCS(a, b);
    }

    final dp = List.generate(a.length + 1, (_) => List.filled(b.length + 1, 0));
    for (int i = 1; i <= a.length; i++) {
      for (int j = 1; j <= b.length; j++) {
        if (a[i - 1] == b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
        }
      }
    }

    final result = <String>[];
    int i = a.length, j = b.length;
    while (i > 0 && j > 0) {
      if (a[i - 1] == b[j - 1]) {
        result.insert(0, a[i - 1]);
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }

  /// 大文件简化 LCS
  List<String> _simpleLCS(List<String> a, List<String> b) {
    final bMap = <String, List<int>>{};
    for (int i = 0; i < b.length; i++) {
      bMap.putIfAbsent(b[i], () => []).add(i);
    }

    final result = <String>[];
    int lastJ = -1;
    for (final line in a) {
      final positions = bMap[line];
      if (positions == null) continue;
      final next = positions.where((p) => p > lastJ).firstOrNull;
      if (next != null) {
        result.add(line);
        lastJ = next;
      }
    }
    return result;
  }

  /// 将 diff 行按变更区域分组，保留上下文
  List<List<DiffLine>> _groupDiffHunks(List<DiffLine> lines, [int context = 3]) {
    if (lines.length <= 60) return [lines];

    final changed = lines.map((l) => l.type != 'same').toList();
    final hunks = <List<DiffLine>>[];
    var curr = <DiffLine>[];
    var lastIdx = -999;

    for (int i = 0; i < lines.length; i++) {
      if (changed[i]) {
        if (i - lastIdx > context * 2 + 1 && curr.isNotEmpty) {
          hunks.add(curr);
          curr = [];
          for (int j = (i - context).clamp(0, i - 1); j < i; j++) {
            curr.add(lines[j]);
          }
        } else if (curr.isEmpty) {
          for (int j = (i - context).clamp(0, i - 1); j < i; j++) {
            curr.add(lines[j]);
          }
        }
        curr.add(lines[i]);
        lastIdx = i;
      } else if (i - lastIdx <= context) {
        curr.add(lines[i]);
      }
    }

    if (curr.isNotEmpty) hunks.add(curr);
    return hunks.isNotEmpty ? hunks : [lines.take(40).toList()];
  }

  Widget _buildStepIcon(String status, ColorScheme colorScheme, bool isRunning) {
    IconData icon;
    Color color;
    switch (status) {
      case 'running':
      case 'calling':
        icon = Icons.sync;
        color = colorScheme.primary;
        break;
      case 'confirm':
        icon = Icons.warning_amber;
        color = Colors.amber;
        break;
      case 'done':
        icon = Icons.check_circle;
        color = Colors.green;
        break;
      case 'failed':
        icon = Icons.error;
        color = Colors.red;
        break;
      default:
        icon = Icons.circle;
        color = colorScheme.onSurfaceVariant;
    }
    return Stack(
      alignment: Alignment.center,
      children: [
        Icon(icon, size: 14, color: color),
        if (isRunning)
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: color.withValues(alpha: 0.5),
            ),
          ),
      ],
    );
  }

  /// 生成每个工具调用的富摘要 + 可悬停路径
  ({String label, String detail, String? filePath}) _toolCallSummary(BridgeToolCall tc) {
    Map<String, dynamic> args = {};
    try {
      args = jsonDecode(tc.function.arguments) as Map<String, dynamic>;
    } catch (_) {}

    switch (tc.function.name) {
      case 'read_file':
        final p = args['path']?.toString() ?? '';
        return (label: '查看文件', detail: p, filePath: p);
      case 'write_file':
        final p = args['path']?.toString() ?? '';
        return (label: '写入文件', detail: p, filePath: p);
      case 'edit_file':
        final p = args['path']?.toString() ?? '';
        return (label: '编辑文件', detail: p, filePath: p);
      case 'delete_file':
        final p = args['path']?.toString() ?? '';
        return (label: '删除文件', detail: p, filePath: p);
      case 'list_dir':
      case 'list_directory':
        final p = args['path']?.toString() ?? '.';
        return (label: '查看目录', detail: p, filePath: p);
      case 'run_command':
        final cmd = args['command']?.toString() ?? '';
        return (label: '执行命令', detail: _summarizeRunCommand(cmd), filePath: null);
      case 'codebase_search':
        final query = args['query']?.toString() ?? args['pattern']?.toString() ?? '';
        final dir = args['path']?.toString() ?? args['directory']?.toString() ?? '.';
        final glob = args['glob']?.toString() ?? args['filePattern']?.toString() ?? '';
        final isRegex = (args['regex'] as bool?) ?? RegExp(r'[|()\[\]{}.*+?\\]').hasMatch(query);
        final compactQuery = query.length > 80 ? '${query.substring(0, 77)}...' : query;
        final scope = glob.isNotEmpty ? '$dir ($glob)' : dir;
        return (
          label: isRegex ? '正则搜索' : '搜索代码',
          detail: '${compactQuery.isNotEmpty ? compactQuery : '(空查询)'} @ $scope',
          filePath: null,
        );
      case 'browser_navigate':
        final url = args['url']?.toString() ?? '';
        return (label: '浏览器操作', detail: url, filePath: null);
      case 'browser_screenshot':
        final goal = args['goal']?.toString() ?? '';
        return (label: '浏览器操作', detail: goal.isNotEmpty ? '目标：$goal' : '状态确认', filePath: null);
      case 'browser_wait':
        final selector = args['selector']?.toString() ?? '';
        return (label: '浏览器操作', detail: selector.isNotEmpty ? selector : '等待页面加载完成', filePath: null);
      case 'browser_get_content':
        final selector = args['selector']?.toString() ?? '';
        return (label: '浏览器操作', detail: selector.isNotEmpty ? selector : '读取页面主体内容', filePath: null);
      case 'browser_get_console_logs':
        return (label: '浏览器操作', detail: '检查控制台日志', filePath: null);
      case 'browser_click':
        final selector = args['selector']?.toString() ?? '';
        final x = double.tryParse(args['x']?.toString() ?? '');
        final y = double.tryParse(args['y']?.toString() ?? '');
        final clickCount = int.tryParse(args['clickCount']?.toString() ?? '1') ?? 1;
        if (selector.isNotEmpty) {
          return (label: '浏览器操作', detail: clickCount >= 2 ? '双击 $selector' : '点击 $selector', filePath: null);
        }
        if (x != null && y != null) {
          return (label: '浏览器操作', detail: '${clickCount >= 2 ? '双击' : '点击'} (${x.round()}, ${y.round()})', filePath: null);
        }
        return (label: '浏览器操作', detail: clickCount >= 2 ? '双击页面' : '点击页面', filePath: null);
      case 'browser_type':
        final selector = args['selector']?.toString() ?? '';
        final text = args['text']?.toString() ?? '';
        final displayText = text.length > 18 ? '${text.substring(0, 18)}...' : text;
        return (label: '浏览器操作', detail: '${selector.isNotEmpty ? selector : ''}${displayText.isNotEmpty ? ' ← $displayText' : ''}'.trim(), filePath: null);
      case 'browser_scroll':
        final direction = args['direction']?.toString() ?? 'down';
        return (label: '浏览器操作', detail: '滚动($direction)', filePath: null);
      case 'browser_hover':
        final selector = args['selector']?.toString() ?? '';
        return (label: '浏览器操作', detail: selector.isNotEmpty ? selector : '悬停指定位置', filePath: null);
      case 'browser_keypress':
        final key = args['key']?.toString() ?? '';
        return (label: '浏览器操作', detail: '按键 $key', filePath: null);
      case 'browser_drag':
        return (label: '浏览器操作', detail: '拖拽操作', filePath: null);
      case 'browser_select':
        final selector = args['selector']?.toString() ?? '';
        final value = args['value']?.toString() ?? args['label']?.toString() ?? '';
        return (label: '浏览器操作', detail: '${selector.isNotEmpty ? selector : ''}${value.isNotEmpty ? ' → $value' : ''}'.trim(), filePath: null);
      default:
        return (label: '执行操作', detail: '', filePath: null);
    }
  }

  String _summarizeRunCommand(String command) {
    final masked = command.trim();
    if (masked.isEmpty) return '';

    final curlRegex = RegExp(r'\bcurl\b[\s\S]*?(?:-X\s+([A-Z]+))?[\s\S]*?(https?://\S+)', caseSensitive: false);
    final curlMatch = curlRegex.firstMatch(masked);
    if (curlMatch != null) {
      final method = (curlMatch.group(1) ?? 'GET').toUpperCase();
      final urlText = curlMatch.group(2) ?? '';
      try {
        final uri = Uri.parse(urlText);
        return '请求接口 $method ${uri.path}';
      } catch (_) {
        return '请求接口 $method $urlText';
      }
    }

    if (RegExp(r'npm\s+run\s+dev', caseSensitive: false).hasMatch(masked)) return '启动前端开发服务';
    if (RegExp(r'npm\s+(run\s+)?build', caseSensitive: false).hasMatch(masked)) return '构建项目';
    if (RegExp(r'go\s+test|npm\s+test|pnpm\s+test|yarn\s+test', caseSensitive: false).hasMatch(masked)) return '执行测试';

    return masked.length > 60 ? '${masked.substring(0, 57)}...' : masked;
  }

  /// 步骤折叠标题（多个工具时合并显示）
  ({String label, String detail, String? filePath}) _stepHeaderSummary(BridgeAgentStep step) {
    if (step.systemTitle != null && step.systemTitle!.isNotEmpty) {
      return (label: step.systemTitle!, detail: step.systemDetail ?? '', filePath: null);
    }
    if (step.toolCalls.isEmpty) {
      return (label: '思考中', detail: '...', filePath: null);
    }
    if (step.toolCalls.length == 1) {
      final tc = step.toolCalls[0];
      final base = _toolCallSummary(tc);
      return base;
    }
    // 多工具：显示数量
    final names = step.toolCalls.map((tc) => _toolCallSummary(tc).label).toSet().join(' + ');
    return (label: names, detail: '(${step.toolCalls.length} 个操作)', filePath: null);
  }

  /// 步骤总卡片标题：显示当前（或最近）正在执行的操作
  String _stepGroupOperationSummary(List<BridgeAgentStep> steps) {
    if (steps.isEmpty) return '暂无操作';
    final active = steps.reversed.firstWhere(
      (s) => s.status == 'running' || s.status == 'calling' || s.status == 'confirm',
      orElse: () => steps.reversed.firstWhere(
        (s) => s.toolCalls.isNotEmpty || s.toolResults.isNotEmpty,
        orElse: () => steps.last,
      ),
    );
    final summary = _stepHeaderSummary(active);
    if (summary.detail.isNotEmpty) return '${summary.label} · ${summary.detail}';
    return summary.label;
  }
}

/// 执行计划进度条组件
class ActivePlanWidget extends StatelessWidget {
  final BridgeActivePlan plan;
  final ColorScheme colorScheme;

  const ActivePlanWidget({
    super.key,
    required this.plan,
    required this.colorScheme,
  });

  @override
  Widget build(BuildContext context) {
    final doneCount = plan.steps.where((s) => s.status == 'done' || s.status == 'failed').length;
    final totalCount = plan.steps.length;
    final progress = totalCount > 0 ? (doneCount / totalCount * 100).round() : 0;
    final allDone = doneCount == totalCount && totalCount > 0;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: colorScheme.surface.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: colorScheme.outline.withValues(alpha: 0.15),
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.task_alt,
                size: 16,
                color: allDone ? Colors.green : colorScheme.primary,
              ),
              const SizedBox(width: 6),
              Text(
                '执行计划',
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                  color: colorScheme.onSurface,
                ),
              ),
              const Spacer(),
              Text(
                '$doneCount/$totalCount',
                style: TextStyle(
                  fontSize: 11,
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          if (plan.summary.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              plan.summary,
              style: TextStyle(
                fontSize: 12,
                color: colorScheme.onSurface.withValues(alpha: 0.8),
              ),
            ),
          ],
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: progress / 100,
              minHeight: 4,
              backgroundColor: colorScheme.surfaceContainerHighest,
              valueColor: AlwaysStoppedAnimation<Color>(
                allDone ? Colors.green : colorScheme.primary,
              ),
            ),
          ),
          const SizedBox(height: 6),
          ...plan.steps.map((s) => Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Row(
              children: [
                _buildPlanStepIcon(s.status, colorScheme),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    s.text,
                    style: TextStyle(
                      fontSize: 12,
                      color: s.status == 'failed'
                          ? Colors.red
                          : colorScheme.onSurface,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (s.note != null && s.note!.isNotEmpty)
                  Flexible(
                    child: Text(
                      s.note!,
                      style: TextStyle(
                        fontSize: 10,
                        color: colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
            ),
          )),
        ],
      ),
    );
  }

  Widget _buildPlanStepIcon(String status, ColorScheme colorScheme) {
    IconData icon;
    Color color;
    switch (status) {
      case 'in_progress':
        icon = Icons.radio_button_checked;
        color = colorScheme.primary;
        break;
      case 'done':
        icon = Icons.check_circle;
        color = Colors.green;
        break;
      case 'failed':
        icon = Icons.cancel;
        color = Colors.red;
        break;
      default:
        icon = Icons.radio_button_unchecked;
        color = colorScheme.onSurfaceVariant;
    }
    return Icon(icon, size: 14, color: color);
  }
}

/// 任务耗时显示组件
class TaskTimingWidget extends StatelessWidget {
  final BridgeTaskTiming timing;
  final ColorScheme colorScheme;

  const TaskTimingWidget({
    super.key,
    required this.timing,
    required this.colorScheme,
  });

  @override
  Widget build(BuildContext context) {
    final durationMs = timing.durationMs ??
        (timing.endedAt != null ? timing.endedAt! - timing.startedAt : 0);
    if (durationMs <= 0) return const SizedBox.shrink();

    final seconds = (durationMs / 1000).round();
    String label;
    if (seconds < 60) {
      label = '${seconds}s';
    } else if (seconds < 3600) {
      label = '${(seconds / 60).floor()}m ${seconds % 60}s';
    } else {
      label = '${(seconds / 3600).floor()}h ${(seconds % 3600 ~/ 60)}m';
    }

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(
        '本轮耗时 $label',
        style: TextStyle(
          fontSize: 11,
          color: colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
