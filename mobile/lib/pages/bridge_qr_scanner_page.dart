import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../models/bridge_models.dart';

class BridgeQrScannerPage extends StatefulWidget {
  const BridgeQrScannerPage({super.key, required this.fallbackConfig});

  final BridgeConfig fallbackConfig;

  @override
  State<BridgeQrScannerPage> createState() => _BridgeQrScannerPageState();
}

class _BridgeQrScannerPageState extends State<BridgeQrScannerPage> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _handled = false;
  String _hint = '请扫描桌面端设置中的连接二维码';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final barcode = capture.barcodes.isNotEmpty ? capture.barcodes.first : null;
    final raw = barcode?.rawValue?.trim() ?? '';
    if (raw.isEmpty) return;
    final parsed = _parseBridgeConfig(raw, widget.fallbackConfig);
    if (parsed == null) {
      setState(() {
        _hint = '二维码内容无效，请重新扫描';
      });
      return;
    }
    _handled = true;
    Navigator.of(context).pop(parsed);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('扫码导入配置')),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
          ),
          Positioned(
            left: 16,
            right: 16,
            bottom: 24,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                _hint,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 13),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

BridgeConfig? _parseBridgeConfig(String raw, BridgeConfig fallback) {
  final value = raw.trim();
  if (value.isEmpty) return null;

  try {
    final uri = Uri.parse(value);
    final host = uri.queryParameters['host']?.trim() ?? '';
    if (uri.scheme == 'taco-mobile' && host.isNotEmpty) {
      final port =
          int.tryParse(uri.queryParameters['port'] ?? '') ?? fallback.port;
      final token = (uri.queryParameters['token'] ?? fallback.token).trim();
      return BridgeConfig(
        host: host,
        port: _safePort(port, fallback.port),
        token: token.isEmpty ? fallback.token : token,
      );
    }
  } catch (_) {
    // ignore and try legacy format
  }

  // 兼容旧格式: taco-mobile://connect?...
  if (value.startsWith('taco-mobile://')) {
    final queryIndex = value.indexOf('?');
    if (queryIndex > 0 && queryIndex < value.length - 1) {
      final query = value.substring(queryIndex + 1);
      final pairs = query.split('&');
      final map = <String, String>{};
      for (final pair in pairs) {
        final eq = pair.indexOf('=');
        if (eq <= 0) continue;
        final k = Uri.decodeComponent(pair.substring(0, eq));
        final v = Uri.decodeComponent(pair.substring(eq + 1));
        map[k] = v;
      }
      final host = (map['host'] ?? '').trim();
      if (host.isNotEmpty) {
        final port = int.tryParse(map['port'] ?? '') ?? fallback.port;
        final token = (map['token'] ?? fallback.token).trim();
        return BridgeConfig(
          host: host,
          port: _safePort(port, fallback.port),
          token: token.isEmpty ? fallback.token : token,
        );
      }
    }
  }

  return null;
}

int _safePort(int value, int fallback) {
  if (value < 1 || value > 65535) return fallback;
  return value;
}
