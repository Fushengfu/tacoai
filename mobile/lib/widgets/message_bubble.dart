import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../models/bridge_models.dart';

typedef StepConfirmHandler = Future<void> Function(
    String confirmId, bool approved);

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
    this.onConfirmStep,
    this.confirmStates = const <String, bool>{},
  });

  final String role;
  final String content;
  final List<DesktopBridgeAgentStep> agentSteps;
  final DesktopBridgeActivePlan? activePlan;
  final List<String> screenshotUrls;
  final bool streaming;
  final bool showRoleLabel;
  final ValueChanged<String>? onOpenImage;
  final StepConfirmHandler? onConfirmStep;
  final Map<String, bool> confirmStates;

  @override
  Widget build(BuildContext context) {
    final isUser = role == 'user';
    final hasPlan = activePlan != null && activePlan!.steps.isNotEmpty;
    final hasSteps = agentSteps.isNotEmpty;
    final showSummaryLast = !isUser && (hasPlan || hasSteps);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      child: Align(
        alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          constraints: const BoxConstraints(maxWidth: 420),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: isUser
                ? Theme.of(context)
                    .colorScheme
                    .primaryContainer
                    .withValues(alpha: 0.6)
                : Theme.of(context)
                    .colorScheme
                    .surfaceContainerHighest
                    .withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (showRoleLabel) ...[
                Text(
                  streaming ? 'assistant (streaming)' : role,
                  style: const TextStyle(
                      fontSize: 11, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
              ],
              if (!showSummaryLast) _MarkdownText(content: content),
              if (hasPlan) ...[
                const SizedBox(height: 10),
                _PlanPanel(plan: activePlan!),
              ],
              if (hasSteps) ...[
                const SizedBox(height: 10),
                _StepGroupPanel(
                  steps: agentSteps,
                  onConfirmStep: onConfirmStep,
                  confirmStates: confirmStates,
                ),
              ],
              if (showSummaryLast && content.trim().isNotEmpty) ...[
                const SizedBox(height: 10),
                _SummaryPanel(content: content),
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

class _StepGroupPanel extends StatefulWidget {
  const _StepGroupPanel({
    required this.steps,
    this.onConfirmStep,
    this.confirmStates = const <String, bool>{},
  });

  final List<DesktopBridgeAgentStep> steps;
  final StepConfirmHandler? onConfirmStep;
  final Map<String, bool> confirmStates;

  @override
  State<_StepGroupPanel> createState() => _StepGroupPanelState();
}

class _StepGroupPanelState extends State<_StepGroupPanel> {
  late bool _expanded;

  bool get _hasActiveSteps => widget.steps.any((s) =>
      s.status == 'running' || s.status == 'calling' || s.status == 'confirm');

  bool _defaultExpanded(List<DesktopBridgeAgentStep> steps) {
    if (steps.length <= 4) return true;
    return steps.any((s) =>
        s.status == 'running' ||
        s.status == 'calling' ||
        s.status == 'confirm');
  }

  @override
  void initState() {
    super.initState();
    _expanded = _defaultExpanded(widget.steps);
  }

  @override
  void didUpdateWidget(covariant _StepGroupPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_hasActiveSteps && !_expanded) {
      setState(() => _expanded = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.steps.length;
    final active = widget.steps
        .where((s) =>
            s.status == 'running' ||
            s.status == 'calling' ||
            s.status == 'confirm')
        .length;
    final done = widget.steps.where((s) => s.status == 'done').length;
    final failed = widget.steps
        .where(
            (s) => s.status == 'done' && s.toolResults.any((r) => !r.success))
        .length;
    final summary = active > 0
        ? '$active 个执行中'
        : '$done/$total 已完成${failed > 0 ? ' · $failed 异常' : ''}';
    final currentOp = _groupCurrentOperation(widget.steps);
    final currentOpText = currentOp.detail.isNotEmpty
        ? '${currentOp.label} · ${currentOp.detail}'
        : currentOp.label;

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.38),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: _hasActiveSteps
              ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.28)
              : Theme.of(context)
                  .colorScheme
                  .outlineVariant
                  .withValues(alpha: 0.45),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                '执行步骤 · $currentOpText',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w700,
                                  color: Theme.of(context).colorScheme.onSurface,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 7, vertical: 1),
                              decoration: BoxDecoration(
                                color: Theme.of(context)
                                    .colorScheme
                                    .surfaceContainerHighest
                                    .withValues(alpha: 0.45),
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                '$total 条',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          summary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            color: Theme.of(context).colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Icon(
                    _expanded ? Icons.expand_more : Icons.chevron_right,
                    size: 18,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 360),
              padding: const EdgeInsets.fromLTRB(6, 0, 6, 6),
              child: Scrollbar(
                child: SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  child: Column(
                    children: widget.steps.asMap().entries.map((entry) {
                      final index = entry.key;
                      final step = entry.value;
                      return _StepPanel(
                        key: ValueKey('step-${step.round}-$index'),
                        step: step,
                        onConfirmStep: widget.onConfirmStep,
                        confirmStates: widget.confirmStates,
                      );
                    }).toList(),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  _ToolSummary _groupCurrentOperation(List<DesktopBridgeAgentStep> steps) {
    if (steps.isEmpty) return const _ToolSummary(label: '暂无操作', detail: '');
    DesktopBridgeAgentStep? target;
    for (int i = steps.length - 1; i >= 0; i--) {
      final step = steps[i];
      if (step.status == 'running' ||
          step.status == 'calling' ||
          step.status == 'confirm') {
        target = step;
        break;
      }
    }
    target ??= steps.lastWhere(
      (step) => step.toolCalls.isNotEmpty || step.toolResults.isNotEmpty,
      orElse: () => steps.last,
    );
    return _stepHeaderSummary(target);
  }
}

class _PlanPanel extends StatelessWidget {
  const _PlanPanel({required this.plan});

  final DesktopBridgeActivePlan plan;

  @override
  Widget build(BuildContext context) {
    final total = plan.steps.length;
    final done = plan.steps.where((s) => s.status == 'done').length;
    final inProgress = plan.steps.where((s) => s.status == 'in_progress').length;
    final failed = plan.steps.where((s) => s.status == 'failed').length;
    final progress = total > 0 ? done / total : 0.0;
    final summary = inProgress > 0
        ? '$inProgress 个执行中'
        : '$done/$total 已完成${failed > 0 ? ' · $failed 异常' : ''}';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '执行计划',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: Theme.of(context).colorScheme.onSurface,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '$done/$total',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          if (plan.summary.isNotEmpty) ...[
            Text(
              plan.summary,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 8),
          ],
          Text(
            summary,
            style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              value: progress.clamp(0, 1),
              minHeight: 3,
              backgroundColor: Colors.white.withValues(alpha: 0.08),
              valueColor: AlwaysStoppedAnimation<Color>(
                done >= total && total > 0 ? const Color(0xFF48BB78) : const Color(0xFF4C7BFF),
              ),
            ),
          ),
          const SizedBox(height: 10),
          ...plan.steps.map((step) => Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 4),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                decoration: BoxDecoration(
                  color: step.status == 'in_progress'
                      ? const Color(0xFF4C7BFF).withValues(alpha: 0.10)
                      : step.status == 'failed'
                          ? Colors.red.withValues(alpha: 0.10)
                          : Colors.transparent,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 16,
                      child: Text(
                        _planStatusIcon(step.status),
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: _planStatusColor(step.status),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: SelectableText(
                        step.text,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.45,
                          color: step.status == 'in_progress'
                              ? Theme.of(context).colorScheme.onSurface
                              : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.8),
                          decoration: step.status == 'done' ? TextDecoration.lineThrough : TextDecoration.none,
                          decorationColor: Colors.white.withValues(alpha: 0.25),
                        ),
                      ),
                    ),
                    if (step.note.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          step.note,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11,
                            color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.45),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              )),
        ],
      ),
    );
  }
}

class _StepPanel extends StatefulWidget {
  const _StepPanel({
    super.key,
    required this.step,
    this.onConfirmStep,
    this.confirmStates = const <String, bool>{},
  });

  final DesktopBridgeAgentStep step;
  final StepConfirmHandler? onConfirmStep;
  final Map<String, bool> confirmStates;

  @override
  State<_StepPanel> createState() => _StepPanelState();
}

class _StepPanelState extends State<_StepPanel> {
  late bool _expanded;
  bool _confirming = false;

  @override
  void initState() {
    super.initState();
    _expanded = _defaultExpanded(widget.step.status);
  }

  @override
  void didUpdateWidget(covariant _StepPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_defaultExpanded(widget.step.status)) {
      _expanded = true;
    }
  }

  bool _defaultExpanded(String status) {
    return status == 'running' || status == 'calling' || status == 'confirm';
  }

  String _resolveConfirmStatus(DesktopBridgeAgentStep step) {
    final confirmId = step.confirmId;
    if (confirmId != null && widget.confirmStates.containsKey(confirmId)) {
      return widget.confirmStates[confirmId] == true ? 'approved' : 'denied';
    }
    if (step.status != 'confirm') return 'approved';
    return 'pending';
  }

  Future<void> _handleConfirm(bool approved) async {
    final confirmId = widget.step.confirmId;
    final handler = widget.onConfirmStep;
    if (confirmId == null ||
        confirmId.isEmpty ||
        handler == null ||
        _confirming) {
      return;
    }
    setState(() => _confirming = true);
    try {
      await handler(confirmId, approved);
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final step = widget.step;
    final hasThinking = step.thinking.trim().isNotEmpty;
    final hasToolCalls = step.toolCalls.isNotEmpty;
    final hasToolResults = step.toolResults.isNotEmpty;
    final summary = _stepHeaderSummary(step);
    final statusColor = _stepStatusColor(context, step);

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
              child: Row(
                children: [
                  Icon(
                    _expanded ? Icons.expand_more : Icons.chevron_right,
                    size: 18,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  Icon(
                    _stepStatusIcon(step),
                    size: 16,
                    color: statusColor,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          summary.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w700),
                        ),
                        if (summary.detail.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            summary.detail,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            if (hasThinking) ...[
              const SizedBox(height: 4),
              _ScrollableBlock(
                  child: _MarkdownText(content: step.thinking, compact: true)),
            ],
            if (step.confirmId != null &&
                step.confirmId!.isNotEmpty &&
                step.risks.isNotEmpty) ...[
              const SizedBox(height: 6),
              _ConfirmPanel(
                step: step,
                enabled: widget.onConfirmStep != null,
                confirming: _confirming,
                onConfirm: _handleConfirm,
                confirmStatus: _resolveConfirmStatus(step),
                isStepRunning:
                    step.status == 'running' || step.status == 'calling',
              ),
            ],
            if (hasToolCalls) ...[
              const SizedBox(height: 4),
              ...step.toolCalls.map((call) => Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: _ToolCallBlock(call: call),
                  )),
            ],
            if (hasToolResults) ...[
              const SizedBox(height: 4),
              ...step.toolResults.map((result) => Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: _ToolResultBlock(result: result),
                  )),
            ],
          ],
        ],
      ),
    );
  }
}

class _ConfirmPanel extends StatelessWidget {
  const _ConfirmPanel({
    required this.step,
    required this.enabled,
    required this.confirming,
    required this.onConfirm,
    required this.confirmStatus,
    required this.isStepRunning,
  });

  final DesktopBridgeAgentStep step;
  final bool enabled;
  final bool confirming;
  final ValueChanged<bool> onConfirm;
  final String confirmStatus;
  final bool isStepRunning;

  @override
  Widget build(BuildContext context) {
    final risks = step.risks;
    final isPlanConfirm = risks.any((r) => r.toolName == 'propose_plan');
    final plan = isPlanConfirm
        ? _parsePlanConfirmPayload(risks.isNotEmpty ? risks.first.detail : '')
        : null;
    final title = isPlanConfirm
        ? (confirmStatus == 'pending' ? '执行计划 - 需要你的确认' : '执行计划')
        : (confirmStatus == 'pending' ? '需要你的授权' : '授权信息');
    final borderColor = isPlanConfirm
        ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.35)
        : Colors.orange.withValues(alpha: 0.35);
    final bgColor = isPlanConfirm
        ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.12)
        : Colors.orange.withValues(alpha: 0.08);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: isPlanConfirm
                        ? Theme.of(context).colorScheme.primary
                        : Colors.orange.shade300,
                  ),
                ),
              ),
            ],
          ),
          if (isPlanConfirm && plan != null) ...[
            if (plan.summary.isNotEmpty) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: Theme.of(context)
                      .colorScheme
                      .primary
                      .withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(8),
                  border: Border(
                    left: BorderSide(
                      color: Theme.of(context)
                          .colorScheme
                          .primary
                          .withValues(alpha: 0.55),
                      width: 3,
                    ),
                  ),
                ),
                child: SelectableText(
                  plan.summary,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.4,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.9),
                  ),
                ),
              ),
            ],
            if (plan.steps.isNotEmpty) ...[
              const SizedBox(height: 8),
              ...plan.steps.asMap().entries.map((entry) => Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Text(
                      '${entry.key + 1}. ${entry.value}',
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.45,
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.78),
                      ),
                    ),
                  )),
            ],
            if (plan.reasoning.isNotEmpty) ...[
              const SizedBox(height: 4),
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: SelectableText(
                  '理由：${plan.reasoning}',
                  style: TextStyle(
                    fontSize: 11,
                    height: 1.35,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.58),
                  ),
                ),
              ),
            ],
          ] else if (risks.isNotEmpty) ...[
            const SizedBox(height: 8),
            ...risks.map((risk) => Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(bottom: 6),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: risk.level == 'danger'
                          ? Colors.red.withValues(alpha: 0.35)
                          : Colors.orange.withValues(alpha: 0.25),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: risk.level == 'danger'
                                  ? Colors.red.withValues(alpha: 0.2)
                                  : Colors.orange.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              risk.level == 'danger' ? '危险' : '注意',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                                color: risk.level == 'danger'
                                    ? Colors.red.shade300
                                    : Colors.orange.shade300,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              risk.reason,
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurface
                                    .withValues(alpha: 0.85),
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (risk.detail.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 8, vertical: 6),
                          decoration: BoxDecoration(
                            color: Colors.black.withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: SelectableText(
                            risk.detail,
                            style: TextStyle(
                              fontSize: 11,
                              height: 1.35,
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: 0.65),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                )),
          ],
          const SizedBox(height: 8),
          _ConfirmStatusSection(
            isPlanConfirm: isPlanConfirm,
            confirmStatus: confirmStatus,
            isStepRunning: isStepRunning,
            enabled: enabled,
            confirming: confirming,
            onConfirm: onConfirm,
          ),
          if (!enabled) ...[
            const SizedBox(height: 6),
            Text(
              '当前端不支持确认操作',
              style: TextStyle(
                  fontSize: 11,
                  color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}

class _ConfirmStatusSection extends StatelessWidget {
  const _ConfirmStatusSection({
    required this.isPlanConfirm,
    required this.confirmStatus,
    required this.isStepRunning,
    required this.enabled,
    required this.confirming,
    required this.onConfirm,
  });

  final bool isPlanConfirm;
  final String confirmStatus;
  final bool isStepRunning;
  final bool enabled;
  final bool confirming;
  final ValueChanged<bool> onConfirm;

  @override
  Widget build(BuildContext context) {
    if (confirmStatus == 'approved') {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.green.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.green.withValues(alpha: 0.3)),
        ),
        child: Row(
          children: [
            Icon(
              isStepRunning ? Icons.hourglass_top : Icons.check,
              size: 14,
              color: Colors.green.shade300,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                isPlanConfirm
                    ? (isStepRunning ? '已确认，正在执行中...' : '已确认执行')
                    : (isStepRunning ? '已授权，正在执行中...' : '已授权执行'),
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Colors.green.shade300,
                ),
              ),
            ),
          ],
        ),
      );
    }

    if (confirmStatus == 'denied') {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.orange.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.orange.withValues(alpha: 0.3)),
        ),
        child: Row(
          children: [
            Icon(
              isStepRunning ? Icons.hourglass_top : Icons.close,
              size: 14,
              color: Colors.orange.shade300,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                isPlanConfirm
                    ? (isStepRunning ? '已要求调整，等待 AI 响应...' : '已要求调整')
                    : (isStepRunning ? '已拒绝，等待 AI 响应...' : '已拒绝'),
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Colors.orange.shade300,
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Row(
      children: [
        FilledButton.tonal(
          onPressed: (!enabled || confirming) ? null : () => onConfirm(true),
          child:
              Text(confirming ? '处理中...' : (isPlanConfirm ? '确认执行' : '允许执行')),
        ),
        const SizedBox(width: 8),
        FilledButton.tonal(
          style: FilledButton.styleFrom(
            foregroundColor: Theme.of(context).colorScheme.error,
          ),
          onPressed: (!enabled || confirming) ? null : () => onConfirm(false),
          child: Text(isPlanConfirm ? '需要调整' : '拒绝'),
        ),
      ],
    );
  }
}

class _ToolCallBlock extends StatelessWidget {
  const _ToolCallBlock({required this.call});

  final DesktopBridgeToolCall call;

  @override
  Widget build(BuildContext context) {
    final summary = _toolCallSummary(call);
    final args = call.arguments.trim();
    final head = summary.detail.isNotEmpty
        ? '${summary.label} · ${summary.detail}'
        : summary.label;
    final body = args.isEmpty ? head : '$head\n\n```json\n$args\n```';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context)
            .colorScheme
            .surfaceContainerHighest
            .withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(8),
      ),
      child: _ScrollableBlock(
        child: _MarkdownText(content: body, compact: true),
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
    final summary = _toolResultSummaryByName(result.name);
    final title = summary.detail.isNotEmpty
        ? '${summary.label} · ${summary.detail}'
        : summary.label;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: result.success
            ? Theme.of(context)
                .colorScheme
                .primaryContainer
                .withValues(alpha: 0.25)
            : Theme.of(context)
                .colorScheme
                .errorContainer
                .withValues(alpha: 0.25),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(
            '${result.success ? '成功' : '失败'} · $title',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 4),
            _ScrollableBlock(
              child: _MarkdownText(content: body, compact: true),
            ),
          ],
          if (result.fileChange != null) ...[
            const SizedBox(height: 8),
            _FileDiffPanel(
              key: ValueKey(
                  '${result.toolCallId}-${result.fileChange!.filePath}'),
              change: result.fileChange!,
            ),
          ],
        ],
      ),
    );
  }
}

class _FileDiffPanel extends StatefulWidget {
  const _FileDiffPanel({super.key, required this.change});

  final DesktopBridgeFileChange change;

  @override
  State<_FileDiffPanel> createState() => _FileDiffPanelState();
}

class _FileDiffPanelState extends State<_FileDiffPanel> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final fileName = widget.change.filePath.split('/').isNotEmpty
        ? widget.change.filePath.split('/').last
        : widget.change.filePath;
    final diffLines = _buildSimpleDiffLines(
        widget.change.oldContent, widget.change.newContent);

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              child: Row(
                children: [
                  Icon(
                    _expanded ? Icons.expand_more : Icons.chevron_right,
                    size: 18,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 4),
                  const Icon(Icons.compare_arrows, size: 15),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '文件差异 $fileName',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12, fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 260),
              margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Scrollbar(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minWidth: 520),
                    child: SingleChildScrollView(
                      physics: const BouncingScrollPhysics(),
                      child: Padding(
                        padding: const EdgeInsets.all(8),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: diffLines
                              .map((line) => _DiffLineWidget(line: line))
                              .toList(),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DiffLineWidget extends StatelessWidget {
  const _DiffLineWidget({required this.line});

  final _DiffLine line;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Color bg;
    Color fg;
    String prefix;
    switch (line.type) {
      case _DiffLineType.added:
        bg = Colors.green.withValues(alpha: 0.12);
        fg = Colors.green.shade200;
        prefix = '+';
        break;
      case _DiffLineType.removed:
        bg = Colors.red.withValues(alpha: 0.14);
        fg = Colors.red.shade200;
        prefix = '-';
        break;
      default:
        bg = Colors.transparent;
        fg = theme.colorScheme.onSurfaceVariant;
        prefix = ' ';
        break;
    }

    return Container(
      color: bg,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      child: Text(
        '$prefix ${line.text}',
        style: TextStyle(
          fontSize: 12,
          height: 1.3,
          fontFamily: 'monospace',
          color: fg,
        ),
        softWrap: false,
      ),
    );
  }
}

class _SummaryPanel extends StatelessWidget {
  const _SummaryPanel({required this.content});

  final String content;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context)
            .colorScheme
            .primaryContainer
            .withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(10),
      ),
      child: _MarkdownText(content: content),
    );
  }
}

class _ScrollableBlock extends StatelessWidget {
  const _ScrollableBlock({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxHeight = constraints.maxWidth < 360 ? 220.0 : 280.0;
        return ConstrainedBox(
          constraints: BoxConstraints(maxHeight: maxHeight),
          child: Scrollbar(
            child: SingleChildScrollView(
              physics: const BouncingScrollPhysics(),
              child: child,
            ),
          ),
        );
      },
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
            child:
                const Text('图片加载失败', style: TextStyle(fontSize: 11)),
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
        h1: textStyle.copyWith(
            fontWeight: FontWeight.w700, fontSize: compact ? 14 : 16),
        h2: textStyle.copyWith(
            fontWeight: FontWeight.w700, fontSize: compact ? 13 : 15),
        h3: textStyle.copyWith(
            fontWeight: FontWeight.w700, fontSize: compact ? 12 : 14),
        code: textStyle.copyWith(
          fontFamily: 'monospace',
          backgroundColor: theme.colorScheme.surfaceContainerHighest,
        ),
        codeblockPadding: const EdgeInsets.all(8),
        codeblockDecoration: BoxDecoration(
          color:
              theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.8),
          borderRadius: BorderRadius.circular(8),
        ),
      ),
    );
  }
}

class _PlanConfirmPayload {
  const _PlanConfirmPayload({
    required this.summary,
    required this.reasoning,
    required this.steps,
  });

  final String summary;
  final String reasoning;
  final List<String> steps;
}

class _ToolSummary {
  const _ToolSummary({
    required this.label,
    required this.detail,
  });

  final String label;
  final String detail;
}

enum _DiffLineType { context, added, removed }

class _DiffLine {
  const _DiffLine({required this.type, required this.text});

  final _DiffLineType type;
  final String text;
}

_PlanConfirmPayload? _parsePlanConfirmPayload(String detail) {
  final raw = detail.trim();
  if (raw.isEmpty) return null;
  try {
    final parsed = jsonDecode(raw);
    if (parsed is! Map) return null;
    final map = Map<String, dynamic>.from(parsed);
    final rawSteps = map['steps'];
    final steps = <String>[];
    if (rawSteps is List) {
      for (final item in rawSteps) {
        final text = item?.toString().trim() ?? '';
        if (text.isNotEmpty) steps.add(text);
      }
    }
    return _PlanConfirmPayload(
      summary: map['summary']?.toString().trim() ?? '',
      reasoning: map['reasoning']?.toString().trim() ?? '',
      steps: steps,
    );
  } catch (_) {
    return null;
  }
}

Map<String, dynamic> _parseArgs(String argsStr) {
  try {
    final parsed = jsonDecode(argsStr);
    if (parsed is Map<String, dynamic>) return parsed;
    if (parsed is Map) return Map<String, dynamic>.from(parsed);
    return <String, dynamic>{};
  } catch (_) {
    return <String, dynamic>{};
  }
}

String _shortText(String text, int maxLen) {
  final normalized = text.trim();
  if (normalized.length <= maxLen) return normalized;
  return '${normalized.substring(0, maxLen - 3)}...';
}

_ToolSummary _toolCallSummary(DesktopBridgeToolCall call) {
  final args = _parseArgs(call.arguments);
  switch (call.name) {
    case 'read_file':
      return _ToolSummary(
          label: '读取文件', detail: _shortText('${args['path'] ?? ''}', 120));
    case 'write_file':
      return _ToolSummary(
          label: '写入文件', detail: _shortText('${args['path'] ?? ''}', 120));
    case 'list_dir':
    case 'list_directory':
      return _ToolSummary(
          label: '列出目录', detail: _shortText('${args['path'] ?? '.'}', 120));
    case 'run_command':
      return _ToolSummary(
          label: '执行命令', detail: _shortText('${args['command'] ?? ''}', 120));
    case 'find_file':
      return _ToolSummary(
          label: '查找文件', detail: _shortText('${args['pattern'] ?? ''}', 120));
    case 'codebase_search':
      return _ToolSummary(
        label: '搜索文件',
        detail: _shortText(
            '"${args['query'] ?? args['pattern'] ?? ''}" in ${args['path'] ?? args['directory'] ?? '.'}', 120),
      );
    case 'browser_navigate':
      return _ToolSummary(
          label: '打开网页', detail: _shortText('${args['url'] ?? ''}', 120));
    case 'browser_click':
      return _ToolSummary(
          label: '点击页面元素',
          detail: _shortText('${args['selector'] ?? ''}', 120));
    case 'browser_type':
      return _ToolSummary(
          label: '输入页面文本',
          detail: _shortText('${args['selector'] ?? ''}', 120));
    case 'desktop_action':
      return _ToolSummary(
          label: '桌面操作', detail: _shortText('${args['action'] ?? ''}', 120));
    case 'propose_plan':
      return const _ToolSummary(label: '执行计划确认', detail: '等待确认后继续');
    case 'update_plan_progress':
      return const _ToolSummary(label: '更新计划进度', detail: '');
    default:
      return _ToolSummary(label: call.name, detail: '');
  }
}

_ToolSummary _toolResultSummaryByName(String name) {
  switch (name) {
    case 'read_file':
      return const _ToolSummary(label: '读取文件', detail: '');
    case 'write_file':
      return const _ToolSummary(label: '写入文件', detail: '');
    case 'list_dir':
    case 'list_directory':
      return const _ToolSummary(label: '列出目录', detail: '');
    case 'run_command':
      return const _ToolSummary(label: '执行命令', detail: '');
    case 'find_file':
      return const _ToolSummary(label: '查找文件', detail: '');
    case 'codebase_search':
      return const _ToolSummary(label: '搜索文件', detail: '');
    case 'browser_navigate':
      return const _ToolSummary(label: '打开网页', detail: '');
    case 'browser_click':
      return const _ToolSummary(label: '点击页面元素', detail: '');
    case 'browser_type':
      return const _ToolSummary(label: '输入页面文本', detail: '');
    case 'desktop_action':
      return const _ToolSummary(label: '桌面操作', detail: '');
    case 'propose_plan':
      return const _ToolSummary(label: '执行计划确认', detail: '');
    default:
      return _ToolSummary(label: name, detail: '');
  }
}

_ToolSummary _stepHeaderSummary(DesktopBridgeAgentStep step) {
  if (step.toolCalls.length == 1) {
    return _toolCallSummary(step.toolCalls.first);
  }
  if (step.toolCalls.length > 1) {
    final labels = <String>{};
    for (final call in step.toolCalls) {
      labels.add(_toolCallSummary(call).label);
    }
    return _ToolSummary(
      label: labels.join(' + '),
      detail: '(${step.toolCalls.length} 个操作)',
    );
  }
  if (step.toolResults.isNotEmpty) {
    if (step.toolResults.length == 1) {
      return _toolResultSummaryByName(step.toolResults.first.name);
    }
    final labels = <String>{};
    for (final result in step.toolResults) {
      labels.add(_toolResultSummaryByName(result.name).label);
    }
    return _ToolSummary(
      label: labels.join(' + '),
      detail: '(${step.toolResults.length} 个结果)',
    );
  }
  return _ToolSummary(
      label: step.status == 'done' ? '执行步骤' : '思考中', detail: '');
}

IconData _stepStatusIcon(DesktopBridgeAgentStep step) {
  if (step.status == 'calling') return Icons.schedule;
  if (step.status == 'running') return Icons.bolt;
  if (step.status == 'confirm') return Icons.lock;
  final hasFailure = step.toolResults.any((r) => !r.success);
  return hasFailure ? Icons.warning_amber_rounded : Icons.check;
}

Color _stepStatusColor(BuildContext context, DesktopBridgeAgentStep step) {
  if (step.status == 'confirm') return Colors.orange.shade300;
  if (step.status == 'running' || step.status == 'calling') {
    return Theme.of(context).colorScheme.primary;
  }
  final hasFailure = step.toolResults.any((r) => !r.success);
  return hasFailure ? Colors.orange.shade300 : Colors.green.shade300;
}

List<_DiffLine> _buildSimpleDiffLines(String? oldText, String? newText) {
  if ((oldText == null || oldText.isEmpty) &&
      (newText == null || newText.isEmpty)) {
    return const <_DiffLine>[
      _DiffLine(type: _DiffLineType.context, text: '[no textual diff]')
    ];
  }
  final oldLines = (oldText ?? '').split('\n');
  final newLines = (newText ?? '').split('\n');
  final lines = <_DiffLine>[];
  int i = 0;
  int j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length &&
        j < newLines.length &&
        oldLines[i] == newLines[j]) {
      lines.add(_DiffLine(type: _DiffLineType.context, text: oldLines[i]));
      i++;
      j++;
      continue;
    }

    final canRemove = i < oldLines.length;
    final canAdd = j < newLines.length;

    if (canRemove &&
        canAdd &&
        i + 1 < oldLines.length &&
        oldLines[i + 1] == newLines[j]) {
      lines.add(_DiffLine(type: _DiffLineType.removed, text: oldLines[i]));
      i++;
      continue;
    }

    if (canRemove &&
        canAdd &&
        j + 1 < newLines.length &&
        oldLines[i] == newLines[j + 1]) {
      lines.add(_DiffLine(type: _DiffLineType.added, text: newLines[j]));
      j++;
      continue;
    }

    if (canRemove) {
      lines.add(_DiffLine(type: _DiffLineType.removed, text: oldLines[i]));
      i++;
    }
    if (canAdd) {
      lines.add(_DiffLine(type: _DiffLineType.added, text: newLines[j]));
      j++;
    }
  }

  if (lines.length <= 400) return lines;
  final kept = <_DiffLine>[];
  kept.addAll(lines.take(220));
  kept.add(const _DiffLine(
      type: _DiffLineType.context, text: '... (diff lines truncated) ...'));
  kept.addAll(lines.skip(lines.length - 180));
  return kept;
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

String _planStatusIcon(String status) {
  switch (status) {
    case 'in_progress':
      return '•';
    case 'done':
      return '✓';
    case 'failed':
      return '✕';
    default:
      return '○';
  }
}

Color _planStatusColor(String status) {
  switch (status) {
    case 'in_progress':
      return const Color(0xFF4C7BFF);
    case 'done':
      return const Color(0xFF48BB78);
    case 'failed':
      return const Color(0xFFF56565);
    default:
      return Colors.white.withValues(alpha: 0.35);
  }
}
