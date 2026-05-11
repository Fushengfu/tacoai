import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/bridge_client.dart';
import 'mobile_chat_page.dart';
import 'file_browser_page.dart';
import 'project_drawer.dart';
import 'bridge_connect_page.dart';

/// 移动端主页面 — 连接桌面端后的导航中心
///
/// 顶部 TabBar 切换两大功能：
/// - 聊天（Chat）：与桌面端当前对话同步（默认主页）
/// - 文件（Files）：浏览项目目录结构与文件内容
///
/// AppBar 右侧项目按钮点击后弹出侧边项目列表（ProjectDrawer）
class HubPage extends StatefulWidget {
  final BridgeClient client;

  const HubPage({super.key, required this.client});

  @override
  State<HubPage> createState() => _HubPageState();
}

class _HubPageState extends State<HubPage> with SingleTickerProviderStateMixin {
  int _selectedIndex = 0;
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  bool _hostOnline = true;

  @override
  void initState() {
    super.initState();

    // 设置状态栏样式
    SystemChrome.setSystemUIOverlayStyle(
      const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.dark,
      ),
    );

    // 监听 Host 在线/离线状态
    widget.client.onMessage((data) {
      final type = data['type'] as String?;
      if (type == 'host_connected') {
        if (mounted) setState(() => _hostOnline = true);
      } else if (type == 'host_disconnected') {
        if (mounted) setState(() => _hostOnline = false);
      }
    });
  }

  @override
  void dispose() {
    super.dispose();
  }

  void _openProjectDrawer() {
    _scaffoldKey.currentState?.openDrawer();
  }

  void _handleExit() {
    showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('断开连接'),
        content: const Text('确定要断开与桌面端的连接并返回扫码页面吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
            ),
            child: const Text('断开'),
          ),
        ],
      ),
    ).then((confirmed) async {
      if (confirmed == true) {
        await widget.client.disconnect(clearCache: true);
        if (!mounted) return;
        Navigator.pushAndRemoveUntil(
          context,
          MaterialPageRoute(builder: (_) => const BridgeConnectPage()),
          (_) => false,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Scaffold(
      key: _scaffoldKey,
      appBar: AppBar(
        title: Text(
          'Taco',
          style: TextStyle(
            fontWeight: FontWeight.w700,
            fontSize: 20,
            color: colorScheme.primary,
          ),
        ),
        elevation: 0,
        backgroundColor: colorScheme.surface,
        leading: IconButton(
          icon: Icon(Icons.menu, color: colorScheme.onSurface),
          onPressed: _openProjectDrawer,
          tooltip: '项目列表',
        ),
        actions: [
          // 卡片式功能切换按钮
          Container(
            margin: const EdgeInsets.only(right: 8),
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
            decoration: BoxDecoration(
              color: colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _buildNavButton(Icons.chat_bubble_outline, 0),
                _buildNavButton(Icons.folder_open, 1),
              ],
            ),
          ),
          // Host 在线状态指示器
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: _hostOnline ? Colors.green : Colors.orange,
                  ),
                ),
                const SizedBox(width: 4),
                Text(
                  _hostOnline ? '在线' : '离线',
                  style: TextStyle(
                    fontSize: 12,
                    color: _hostOnline ? Colors.green : Colors.orange,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            icon: Icon(Icons.logout, color: colorScheme.error),
            onPressed: _handleExit,
            tooltip: '断开连接',
          ),
        ],
      ),
      drawer: ProjectDrawer(client: widget.client),
      body: Container(
        color: colorScheme.surface,
        child: IndexedStack(
          index: _selectedIndex,
          children: [
            // 聊天页面（主窗口）
            MobileChatPage(client: widget.client, showAppBar: false),
            // 文件浏览页面
            FileBrowserPage(client: widget.client),
          ],
        ),
      ),
    );
  }

  Widget _buildNavButton(IconData icon, int index) {
    final colorScheme = Theme.of(context).colorScheme;
    final isSelected = _selectedIndex == index;
    return Material(
      color: isSelected ? colorScheme.primaryContainer : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: () => setState(() => _selectedIndex = index),
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Icon(
            icon,
            size: 20,
            color: isSelected ? colorScheme.primary : colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}
