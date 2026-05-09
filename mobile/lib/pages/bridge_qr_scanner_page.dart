import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// 二维码扫描页面 - 扫描桌面端配对码
class BridgeQrScannerPage extends StatefulWidget {
  const BridgeQrScannerPage({super.key});

  @override
  State<BridgeQrScannerPage> createState() => _BridgeQrScannerPageState();
}

class _BridgeQrScannerPageState extends State<BridgeQrScannerPage> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );

  bool _hasScanned = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleBarcode(BarcodeCapture capture) {
    if (_hasScanned) return;
    final barcode = capture.barcodes.firstOrNull;
    if (barcode == null || barcode.rawValue == null) return;

    _hasScanned = true;
    _controller.stop();

    if (!mounted) return;
    // 直接返回原始二维码字符串，由 BridgeConnectPage 的 _ScanResult.parse 解析
    Navigator.pop(context, barcode.rawValue!);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('扫描二维码'),
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _handleBarcode,
          ),
          // 扫描框覆盖层
          Center(
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white, width: 3),
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
          // 底部提示
          Positioned(
            bottom: 40,
            left: 0,
            right: 0,
            child: Center(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                decoration: BoxDecoration(
                  color: Colors.black54,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: const Text(
                  '将二维码放入框内即可自动扫描',
                  style: TextStyle(color: Colors.white, fontSize: 14),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
