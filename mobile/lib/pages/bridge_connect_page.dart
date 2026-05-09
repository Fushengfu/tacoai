import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import 'hub_page.dart';
import 'bridge_qr_scanner_page.dart';

const String _kCachedRelayUrlKey = 'bridge_cached_relay_url';

/// 扫码返回的连接信息
class _ScanResult {
  final String token;
  final String pairingCode;
  final String? relayUrl;

  _ScanResult({required this.token, required this.pairingCode, this.relayUrl});

  /// 解析 taco-bridge://base64json 格式
  static _ScanResult? parse(String raw) {
    String payload = raw;
    if (raw.startsWith('taco-bridge://')) {
      payload = raw.substring('taco-bridge://'.length);
    }

    // 尝试 base64 解码 JSON: {"token":"...","code":"...","url":"..."}
    try {
      final bytes = base64Decode(payload);
      final json = jsonDecode(utf8.decode(bytes));
      return _ScanResult(
        token: json['token'] as String? ?? '',
        pairingCode: json['code'] as String? ?? json['pairingCode'] as String? ?? '',
        relayUrl: json['url'] as String?,
      );
    } catch (_) {
      // 降级：纯配对码格式（仅 code）
      if (payload.isNotEmpty && !payload.contains('{')) {
        return _ScanResult(token: '', pairingCode: payload);
      }
    }
    return null;
  }
}

/// 桥接连接页面 - 扫码连接桌面端
class BridgeConnectPage extends StatefulWidget {
  const BridgeConnectPage({super.key});

  @override
  State<BridgeConnectPage> createState() => _BridgeConnectPageState();
}

class _BridgeConnectPageState extends State<BridgeConnectPage> {
  BridgeClient? _client;
  _ScanResult? _scanResult;
  bool _connecting = false;
  String? _error;
  bool _navigated = false; // 标记是否已导航到其他页面

  @override
  void initState() {
    super.initState();
    // Client is created in _handleConnect
  }

  @override
  void dispose() {
    // 如果已经导航到 BridgeViewPage，不要断开连接（client 被新页面接管）
    if (!_navigated) {
      _client?.disconnect();
    }
    super.dispose();
  }

  void _onStatusChange(BridgeStatus status) {
    if (!mounted || _navigated) return;

    if (status.status == BridgeConnectionStatus.connected) {
      // 立即标记已导航，防止 dispose 时断开连接
      _navigated = true;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (context) => HubPage(client: _client!),
        ),
      );
      return;
    }

    setState(() {
      _connecting = status.status == BridgeConnectionStatus.connecting ||
          status.status == BridgeConnectionStatus.reconnecting;
      _error = status.error;
    });
  }

  void _handleConnect() {
    if (_scanResult == null) {
      setState(() => _error = '请先扫码');
      return;
    }
    if (_scanResult!.token.isEmpty) {
      setState(() => _error = '二维码中缺少 Token 信息');
      return;
    }
    if (_scanResult!.pairingCode.isEmpty) {
      setState(() => _error = '二维码中缺少配对码');
      return;
    }

    setState(() {
      _error = null;
      _connecting = true;
    });

    _client = BridgeClient(relayUrl: _scanResult!.relayUrl);
    _client!.onStatusChange(_onStatusChange);
    _client!.connect(
      token: _scanResult!.token,
      pairingCode: _scanResult!.pairingCode,
    );
  }

  Future<void> _handleScan() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const BridgeQrScannerPage()),
    );

    if (result != null && mounted) {
      final parsed = _ScanResult.parse(result);
      if (parsed != null) {
        // 缓存 relayUrl
        if (parsed.relayUrl != null && parsed.relayUrl!.isNotEmpty) {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString(_kCachedRelayUrlKey, parsed.relayUrl!);
        }
        setState(() {
          _scanResult = parsed;
          _error = null;
        });
      } else {
        setState(() => _error = '二维码格式无效');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('扫码连接'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 20),
            const Text(
              '扫码连接桌面端',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            const Text(
              '1. 在桌面端 Taco AI 登录会员账号\n2. 点击"扫码连接"生成二维码\n3. 扫码后自动填充信息，点击连接',
              style: TextStyle(fontSize: 14, color: Colors.grey),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 30),
            if (_scanResult != null) ...[
              // 扫码成功后的信息展示
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.green.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.green.withOpacity(0.3)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.check_circle, color: Colors.green, size: 20),
                        const SizedBox(width: 8),
                        const Text(
                          '扫码成功',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: Colors.green,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Text(
                      '配对码: ${_scanResult!.pairingCode}',
                      style: const TextStyle(fontSize: 14, color: Colors.grey),
                    ),
                    if (_scanResult!.relayUrl != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        '服务器: ${_scanResult!.relayUrl!}',
                        style: const TextStyle(fontSize: 12, color: Colors.grey),
                      ),
                    ],
                  ],
                ),
              ),
            ] else ...[
              // 未扫码时的扫码按钮
              Center(
                child: Column(
                  children: [
                    Icon(
                      Icons.qr_code_2,
                      size: 80,
                      color: Colors.grey.withOpacity(0.4),
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      '点击下方按钮扫描二维码',
                      style: TextStyle(fontSize: 14, color: Colors.grey),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 30),
            FilledButton.icon(
              onPressed: _connecting ? null : _handleScan,
              icon: const Icon(Icons.qr_code_scanner),
              label: Text(_scanResult != null ? '重新扫码' : '扫码'),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: (_connecting || _scanResult == null) ? null : _handleConnect,
              child: Text(_connecting ? '连接中...' : '连接'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                style: const TextStyle(color: Colors.red),
                textAlign: TextAlign.center,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
