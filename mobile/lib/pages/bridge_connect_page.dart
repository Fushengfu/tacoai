import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'dart:async';
import 'dart:convert';
import '../services/bridge_client.dart';
import '../services/bridge_protocol.dart';
import 'hub_page.dart';
import 'bridge_qr_scanner_page.dart';

const String _kCachedRelayUrlKey = 'bridge_cached_relay_url';
const String _kDefaultRelayUrl = 'wss://aisocket.bjctykj.com';
const String _kDefaultHttpUrl = 'https://agent.bjctykj.com';

/// 扫码返回的连接信息（新版：仅包含 Token）
class _ScanResult {
  final String token;
  final String? relayUrl;

  _ScanResult({required this.token, this.relayUrl});

  /// 解析 taco-login://base64json 格式（新版扫码登录）
  /// 兼容旧版 taco-bridge:// 格式
  static _ScanResult? parse(String raw) {
    String payload = raw;
    String? scheme;

    if (raw.startsWith('taco-login://')) {
      scheme = 'login';
      payload = raw.substring('taco-login://'.length);
    } else if (raw.startsWith('taco-bridge://')) {
      scheme = 'bridge';
      payload = raw.substring('taco-bridge://'.length);
    }

    // 尝试 base64 解码 JSON
    try {
      final bytes = base64Decode(payload);
      final json = jsonDecode(utf8.decode(bytes));

      if (scheme == 'login') {
        // 新版扫码登录：{"token":"...","url":"..."}
        return _ScanResult(
          token: json['token'] as String? ?? '',
          relayUrl: json['url'] as String?,
        );
      } else {
        // 旧版配对码：{"token":"...","code":"...","url":"..."}
        // 兼容处理：如果有 token 就直接用，忽略 code
        return _ScanResult(
          token: json['token'] as String? ?? '',
          relayUrl: json['url'] as String?,
        );
      }
    } catch (_) {
      // 降级：纯文本 token 格式
      if (payload.isNotEmpty && !payload.contains('{')) {
        return _ScanResult(token: payload);
      }
    }
    return null;
  }
}

/// 桥接连接页面 - 账号密码登录 + 扫码登录
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
  
  // 账号密码登录
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isPasswordLogin = true; // 默认显示账号密码登录
  bool _obscurePassword = true;

  @override
  void initState() {
    super.initState();
    _tryAutoConnect();
  }

  /// 尝试使用缓存的连接信息自动连接
  Future<void> _tryAutoConnect() async {
    if (!mounted) return;
    final cached = await BridgeClient.tryRestoreConnection();
    if (cached == null || !mounted) return;

    setState(() {
      _connecting = true;
      _error = null;
    });

    _client = BridgeClient(relayUrl: cached.relayUrl);
    // 使用 Completer 等待连接结果或超时
    final completer = Completer<bool>();
    _client!.onStatusChange((status) {
      if (status.status == BridgeConnectionStatus.connected) {
        if (!completer.isCompleted) completer.complete(true);
      } else if (status.status == BridgeConnectionStatus.disconnected &&
          status.error != null &&
          !completer.isCompleted) {
        completer.complete(false);
      }
    });
    _client!.connect(token: cached.token);

    // 8 秒超时
    final result = await completer.future.timeout(
      const Duration(seconds: 8),
      onTimeout: () => false,
    );

    if (!mounted) return;
    if (result) {
      // 自动连接成功 → 直接导航
      _navigated = true;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (context) => HubPage(client: _client!),
        ),
      );
    } else {
      // 自动连接失败 → 清除缓存，展示手动扫码界面
      await _client?.disconnect(clearCache: true);
      _client = null;
      setState(() {
        _connecting = false;
        _error = '自动连接失败，请重新扫码';
      });
    }
  }

  @override
  void dispose() {
    // 如果已经导航到 HubPage，不要断开连接（client 被新页面接管）
    if (!_navigated) {
      _client?.disconnect();
    }
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  /// 账号密码登录
  Future<void> _handlePasswordLogin() async {
    final username = _usernameController.text.trim();
    final password = _passwordController.text.trim();
    
    if (username.isEmpty) {
      setState(() => _error = '请输入账号');
      return;
    }
    if (password.isEmpty) {
      setState(() => _error = '请输入密码');
      return;
    }

    setState(() {
      _error = null;
      _connecting = true;
    });

    try {
      // 调用后端登录接口获取 Token
      final response = await _loginApi(username, password);
      if (!mounted) return;

      if (response['token'] == null || response['token'].isEmpty) {
        setState(() {
          _error = response['message'] ?? '登录失败，请检查账号密码';
          _connecting = false;
        });
        return;
      }

      // 使用获取的 Token 连接
      _client = BridgeClient(relayUrl: response['relayUrl'] as String?);
      _client!.onStatusChange(_onStatusChange);
      _client!.connect(token: response['token'] as String);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '登录请求失败: $e';
        _connecting = false;
      });
    }
  }

  /// 调用后端登录接口
  Future<Map<String, dynamic>> _loginApi(String username, String password) async {
    final response = await http.post(
      Uri.parse('$_kDefaultHttpUrl/api/member/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': username, 'password': password}),
    );

    if (response.statusCode != 200) {
      try {
        final errorBody = jsonDecode(response.body);
        return {'message': errorBody['message'] ?? '登录失败'};
      } catch (_) {
        return {'message': '登录请求失败 (${response.statusCode})'};
      }
    }

    final data = jsonDecode(response.body);
    final token = data['data']?['token'] as String?;
    if (token == null || token.isEmpty) {
      return {'message': '登录失败，未获取到 Token'};
    }

    return {
      'token': token,
      'relayUrl': _kDefaultRelayUrl,
    };
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

    setState(() {
      _error = null;
      _connecting = true;
    });

    _client = BridgeClient(relayUrl: _scanResult!.relayUrl);
    _client!.onStatusChange(_onStatusChange);
    _client!.connect(token: _scanResult!.token);
  }

  Future<void> _handleScan() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const BridgeQrScannerPage()),
    );

    if (result != null && mounted) {
      final parsed = _ScanResult.parse(result);
      if (parsed != null) {
        // 缓存连接信息
        try {
          final prefs = await SharedPreferences.getInstance();
          if (parsed.relayUrl != null && parsed.relayUrl!.isNotEmpty) {
            await prefs.setString(_kCachedRelayUrlKey, parsed.relayUrl!);
          }
          if (parsed.token.isNotEmpty) {
            await prefs.setString('bridge_cached_token', parsed.token);
          }
        } catch (_) {}
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
        title: const Text('连接桌面端'),
        actions: [
          // 切换登录方式按钮
          IconButton(
            icon: Icon(_isPasswordLogin ? Icons.qr_code_scanner : Icons.person),
            onPressed: () {
              setState(() {
                _isPasswordLogin = !_isPasswordLogin;
                _error = null;
              });
            },
            tooltip: _isPasswordLogin ? '切换到扫码登录' : '切换到账号密码登录',
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 20),
            Text(
              _isPasswordLogin ? '账号密码登录' : '扫码连接桌面端',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              _isPasswordLogin
                  ? '输入会员账号密码直接登录'
                  : '1. 在桌面端 Taco AI 登录会员账号\n2. 打开跨端桥接面板显示二维码\n3. 扫码后自动登录并连接',
              style: const TextStyle(fontSize: 14, color: Colors.grey),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 30),
            
            if (_isPasswordLogin) ...[
              // 账号密码登录表单
              TextField(
                controller: _usernameController,
                decoration: const InputDecoration(
                  labelText: '账号',
                  hintText: '请输入会员账号',
                  prefixIcon: Icon(Icons.person),
                  border: OutlineInputBorder(),
                ),
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _passwordController,
                decoration: InputDecoration(
                  labelText: '密码',
                  hintText: '请输入密码',
                  prefixIcon: const Icon(Icons.lock),
                  border: const OutlineInputBorder(),
                  suffixIcon: IconButton(
                    icon: Icon(_obscurePassword ? Icons.visibility : Icons.visibility_off),
                    onPressed: () {
                      setState(() => _obscurePassword = !_obscurePassword);
                    },
                  ),
                ),
                obscureText: _obscurePassword,
              ),
              const SizedBox(height: 30),
              FilledButton.icon(
                onPressed: _connecting ? null : _handlePasswordLogin,
                icon: const Icon(Icons.login),
                label: Text(_connecting ? '登录中...' : '登录'),
              ),
            ] else ...[
              // 扫码登录界面
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
                      const Text(
                        '已获取登录凭证，点击下方按钮连接',
                        style: TextStyle(fontSize: 14, color: Colors.grey),
                      ),
                      if (_scanResult!.relayUrl != null) ...[
                        const SizedBox(height: 8),
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
            ],
            
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
