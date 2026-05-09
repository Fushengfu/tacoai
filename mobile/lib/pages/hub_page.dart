import 'package:flutter/material.dart';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import 'mobile_chat_page.dart';
import 'project_list_page.dart';
import 'file_browser_page.dart';

/// 移动端主页面 — 连接桌面端后的导航中心
///
/// 底部标签栏切换三大功能：
/// - 聊天（Chat）：与桌面端当前对话同步
/// - 项目（Projects）：查看/切换桌面端所有项目与会话
/// - 文件（Files）：浏览项目目录结构与文件内容
class HubPage extends StatefulWidget {
  final BridgeClient client;

  const HubPage({super.key, required this.client});

  @override
  State<HubPage> createState() => _HubPageState();
}

class _HubPageState extends State<HubPage> {
  int _currentIndex = 0;

  @override
  Widget build(BuildContext context) {
    final pages = <Widget>[
      MobileChatPage(client: widget.client),
      ProjectListPage(client: widget.client),
      FileBrowserPage(client: widget.client),
    ];

    return Scaffold(
      body: IndexedStack(
        index: _currentIndex,
        children: pages,
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (index) {
          setState(() => _currentIndex = index);
        },
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.chat_bubble_outline),
            selectedIcon: Icon(Icons.chat_bubble),
            label: '聊天',
          ),
          NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder),
            label: '项目',
          ),
          NavigationDestination(
            icon: Icon(Icons.description_outlined),
            selectedIcon: Icon(Icons.description),
            label: '文件',
          ),
        ],
      ),
    );
  }
}
