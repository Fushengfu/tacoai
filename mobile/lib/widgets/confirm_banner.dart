import 'package:flutter/material.dart';
import '../services/bridge_protocol.dart';

/// 顶部确认弹窗组件
/// 用于展示 Agent 的授权确认和执行计划确认，悬浮在聊天页面顶部
class ConfirmBanner extends StatefulWidget {
  final List<BridgePendingConfirm> confirms;
  final void Function(String confirmId, bool approved) onConfirm;

  const ConfirmBanner({
    super.key,
    required this.confirms,
    required this.onConfirm,
  });

  @override
  State<ConfirmBanner> createState() => _ConfirmBannerState();
}

class _ConfirmBannerState extends State<ConfirmBanner>
    with SingleTickerProviderStateMixin {
  late AnimationController _animationController;
  late Animation<Offset> _slideAnimation;

  @override
  void initState() {
    super.initState();
    _animationController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    _slideAnimation = Tween<Offset>(
      begin: const Offset(0, -1),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _animationController,
      curve: Curves.easeOutCubic,
    ));

    // 有待确认项时自动滑入
    if (widget.confirms.isNotEmpty) {
      _animationController.forward();
    }
  }

  @override
  void didUpdateWidget(ConfirmBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 从空变为非空时滑入
    if (oldWidget.confirms.isEmpty && widget.confirms.isNotEmpty) {
      _animationController.forward(from: 0);
    }
    // 从非空变为空时滑出
    else if (oldWidget.confirms.isNotEmpty && widget.confirms.isEmpty) {
      _animationController.reverse();
    }
  }

  @override
  void dispose() {
    _animationController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.confirms.isEmpty) return const SizedBox.shrink();

    final colorScheme = Theme.of(context).colorScheme;

    return SlideTransition(
      position: _slideAnimation,
      child: Material(
        elevation: 8,
        color: colorScheme.surface,
        child: SafeArea(
          bottom: false,
          child: Container(
            constraints: const BoxConstraints(maxHeight: 300),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // 标题栏
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  decoration: BoxDecoration(
                    color: colorScheme.primaryContainer.withValues(alpha: 0.3),
                    border: Border(
                      bottom: BorderSide(
                        color: colorScheme.outline.withValues(alpha: 0.2),
                      ),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.warning_amber_rounded,
                        size: 20,
                        color: colorScheme.primary,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '需要你的确认',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: colorScheme.onSurface,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        '${widget.confirms.length} 个待确认',
                        style: TextStyle(
                          fontSize: 12,
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                // 确认列表
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: widget.confirms.length,
                    itemBuilder: (context, index) {
                      final confirm = widget.confirms[index];
                      return _ConfirmCard(
                        confirm: confirm,
                        colorScheme: colorScheme,
                        onConfirm: widget.onConfirm,
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 单个确认卡片
class _ConfirmCard extends StatefulWidget {
  final BridgePendingConfirm confirm;
  final ColorScheme colorScheme;
  final void Function(String confirmId, bool approved) onConfirm;

  const _ConfirmCard({
    required this.confirm,
    required this.colorScheme,
    required this.onConfirm,
  });

  @override
  State<_ConfirmCard> createState() => _ConfirmCardState();
}

class _ConfirmCardState extends State<_ConfirmCard> {
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    // 高危权限确认默认自动展开，让用户立即看到确认按钮
    final hasDangerRisks = widget.confirm.risks.any((r) => r.level == 'danger');
    if (hasDangerRisks && !widget.confirm.isPlanConfirm) {
      _expanded = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    final confirm = widget.confirm;
    final colorScheme = widget.colorScheme;

    return Container(
      margin: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: confirm.isPlanConfirm
            ? colorScheme.primaryContainer.withValues(alpha: 0.2)
            : colorScheme.errorContainer.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: confirm.isPlanConfirm
              ? colorScheme.primary.withValues(alpha: 0.3)
              : colorScheme.error.withValues(alpha: 0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 卡片头部
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Icon(
                    confirm.isPlanConfirm
                        ? Icons.task_alt
                        : Icons.security,
                    size: 20,
                    color: confirm.isPlanConfirm
                        ? colorScheme.primary
                        : colorScheme.error,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          confirm.isPlanConfirm ? '执行计划' : '操作授权',
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                            color: colorScheme.onSurface,
                          ),
                        ),
                        if (confirm.summary.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              confirm.summary.length > 50
                                  ? '${confirm.summary.substring(0, 50)}...'
                                  : confirm.summary,
                              style: TextStyle(
                                fontSize: 12,
                                color: colorScheme.onSurfaceVariant,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                    ),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 20,
                    color: colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          // 展开详情
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // 风险列表
                  if (confirm.risks.isNotEmpty) ...[
                    ...confirm.risks.map((risk) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: risk.level == 'danger'
                              ? Colors.red.withValues(alpha: 0.1)
                              : Colors.amber.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(
                            color: risk.level == 'danger'
                                ? Colors.red.withValues(alpha: 0.3)
                                : Colors.amber.withValues(alpha: 0.3),
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 2,
                                  ),
                                  decoration: BoxDecoration(
                                    color: risk.level == 'danger'
                                        ? Colors.red
                                        : Colors.amber,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(
                                    risk.level == 'danger' ? '危险' : '注意',
                                    style: const TextStyle(
                                      fontSize: 10,
                                      color: Colors.white,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    risk.reason,
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                ),
                              ],
                            ),
                            if (risk.detail.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Text(
                                  risk.detail,
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    color: colorScheme.onSurface.withValues(alpha: 0.7),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    )),
                  ],
                  // 工具调用列表
                  if (confirm.toolCalls.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      '即将执行 ${confirm.toolCalls.length} 个操作：',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 4),
                    ...confirm.toolCalls.map((tc) => Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(
                        children: [
                          Icon(Icons.circle, size: 6, color: colorScheme.onSurfaceVariant),
                          const SizedBox(width: 6),
                          Text(
                            tc.function.name,
                            style: TextStyle(
                              fontSize: 12,
                              fontFamily: 'monospace',
                              color: colorScheme.onSurface,
                            ),
                          ),
                        ],
                      ),
                    )),
                  ],
                  // 思考内容
                  if (confirm.thinking != null && confirm.thinking!.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        confirm.thinking!,
                        style: TextStyle(
                          fontSize: 12,
                          color: colorScheme.onSurfaceVariant,
                          fontStyle: FontStyle.italic,
                        ),
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  // 操作按钮
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () {
                            widget.onConfirm(confirm.confirmId, true);
                          },
                          icon: const Icon(Icons.check, size: 18),
                          label: Text(confirm.isPlanConfirm ? '确认执行' : '允许执行'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.green,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 10),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () {
                            widget.onConfirm(confirm.confirmId, false);
                          },
                          icon: const Icon(Icons.close, size: 18),
                          label: Text(confirm.isPlanConfirm ? '需要调整' : '拒绝'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.red,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 10),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
