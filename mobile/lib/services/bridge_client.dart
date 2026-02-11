import 'dart:convert';
import 'dart:io';

import '../models/bridge_models.dart';

class BridgeClient {
  const BridgeClient({required this.config});

  final BridgeConfig config;

  Uri _uri(String path) => Uri.parse('http://${config.host}:${config.port}$path');
  Uri _wsUri(String path) => Uri(
        scheme: 'ws',
        host: config.host,
        port: config.port,
        path: path,
        queryParameters: config.token.isEmpty ? null : <String, String>{'token': config.token},
      );

  Map<String, String> _authHeaders() {
    if (config.token.isEmpty) return const <String, String>{};
    return <String, String>{'X-Taco-Token': config.token};
  }

  Future<BridgeHttpResponse> _request({
    required String method,
    required String path,
    Map<String, String>? headers,
    Object? body,
  }) async {
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 5);
    try {
      final req = await client.openUrl(method, _uri(path));
      headers?.forEach(req.headers.set);
      if (body != null) {
        final content = utf8.encode(jsonEncode(body));
        req.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
        req.headers.set(HttpHeaders.contentLengthHeader, content.length);
        req.add(content);
      }
      final resp = await req.close();
      final text = await utf8.decodeStream(resp);
      return BridgeHttpResponse(statusCode: resp.statusCode, body: text);
    } finally {
      client.close(force: true);
    }
  }

  Future<BridgeHttpResponse> health() {
    return _request(method: 'GET', path: '/health');
  }

  Future<WebSocket> connectContextSocket() {
    return WebSocket.connect(
      _wsUri('/ws').toString(),
      headers: _authHeaders(),
    );
  }

  Future<DesktopBridgeContext> context() async {
    final resp = await _request(
      method: 'GET',
      path: '/context',
      headers: _authHeaders(),
    );
    if (resp.statusCode != 200) {
      throw Exception('读取上下文失败: ${resp.statusCode}');
    }
    final decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception('读取上下文失败: 响应格式错误');
    }
    final rawContext = decoded['context'];
    if (rawContext is! Map<String, dynamic>) {
      throw Exception('读取上下文失败: context 缺失');
    }
    return DesktopBridgeContext.fromJson(rawContext);
  }

  Future<BridgeHttpResponse> sendCommand(QueuedMobileCommand cmd) {
    return _request(
      method: 'POST',
      path: '/command',
      headers: _authHeaders(),
      body: {
        'text': cmd.text,
        if (cmd.threadId != null && cmd.threadId!.isNotEmpty) 'threadId': cmd.threadId,
        if (cmd.sessionId != null && cmd.sessionId!.isNotEmpty) 'sessionId': cmd.sessionId,
        if (cmd.provider != null && cmd.provider!.isNotEmpty) 'provider': cmd.provider,
      },
    );
  }

  Future<BridgeHttpResponse> syncSelection({
    String? threadId,
    String? sessionId,
    String? provider,
  }) {
    return _request(
      method: 'POST',
      path: '/select',
      headers: _authHeaders(),
      body: {
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
        if (provider != null && provider.isNotEmpty) 'provider': provider,
      },
    );
  }

  Future<BridgeHttpResponse> abort({
    String? threadId,
    String? sessionId,
  }) {
    return _request(
      method: 'POST',
      path: '/abort',
      headers: _authHeaders(),
      body: {
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
      },
    );
  }
}
