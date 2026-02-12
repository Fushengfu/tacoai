import 'dart:async';

import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../services/bridge_client.dart';
import 'bridge_qr_scanner_page.dart';

class BridgeSettingsPage extends StatefulWidget {
  const BridgeSettingsPage({super.key, required this.initialConfig});

  final BridgeConfig initialConfig;

  @override
  State<BridgeSettingsPage> createState() => _BridgeSettingsPageState();
}

class _BridgeSettingsPageState extends State<BridgeSettingsPage> {
  late final TextEditingController _hostController;
  late final TextEditingController _portController;
  late final TextEditingController _tokenController;

  bool _checking = false;
  String _healthResult = '';

  @override
  void initState() {
    super.initState();
    _hostController = TextEditingController(text: widget.initialConfig.host);
    _portController =
        TextEditingController(text: widget.initialConfig.port.toString());
    _tokenController = TextEditingController(text: widget.initialConfig.token);
  }

  @override
  void dispose() {
    _hostController.dispose();
    _portController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  BridgeConfig _buildConfig() {
    final port = int.tryParse(_portController.text.trim()) ?? 18400;
    final safePort = (port < 1 || port > 65535) ? 18400 : port;
    return BridgeConfig(
      host: _hostController.text.trim(),
      port: safePort,
      token: _tokenController.text.trim(),
    );
  }

  Future<void> _scanQrImport() async {
    final scanned = await Navigator.of(context).push<BridgeConfig>(
      MaterialPageRoute(
        builder: (_) => BridgeQrScannerPage(fallbackConfig: _buildConfig()),
      ),
    );
    if (scanned == null) return;
    setState(() {
      _hostController.text = scanned.host;
      _portController.text = scanned.port.toString();
      _tokenController.text = scanned.token;
      _healthResult = '已从二维码导入配置';
    });
  }

  Future<void> _checkHealth() async {
    if (_checking) return;
    setState(() {
      _checking = true;
      _healthResult = '';
    });

    try {
      final client = BridgeClient(config: _buildConfig());
      final resp = await client.health();
      setState(() {
        _healthResult =
            resp.statusCode == 200 ? '连接成功' : '连接失败: ${resp.statusCode}';
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('健康检查: ${resp.body}')),
      );
    } catch (err) {
      setState(() {
        _healthResult = '连接异常: $err';
      });
    } finally {
      if (mounted) {
        setState(() {
          _checking = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('连接配置'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: ListView(
          children: [
            TextField(
              controller: _hostController,
              decoration: const InputDecoration(
                labelText: '桌面端地址 / 域名',
                hintText: '例如 192.168.1.10 或 https://xxx.ngrok.app',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '支持局域网 IP、域名、穿透地址（可带 http/https）。',
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _portController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: '端口',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _tokenController,
              decoration: const InputDecoration(
                labelText: 'Token',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.tonal(
                    onPressed: () => unawaited(_scanQrImport()),
                    child: const Text('扫码导入'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.tonal(
                    onPressed:
                        _checking ? null : () => unawaited(_checkHealth()),
                    child: Text(_checking ? '检查中...' : '健康检查'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.of(context).pop(_buildConfig()),
                    child: const Text('保存并返回'),
                  ),
                ),
              ],
            ),
            if (_healthResult.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_healthResult, style: const TextStyle(fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }
}
