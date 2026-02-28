import 'dart:convert';
import 'dart:io';

import '../models/bridge_models.dart';

class BridgeClient {
  const BridgeClient({required this.config});

  final BridgeConfig config;

  Uri _uri(String path, {Map<String, String>? queryParameters}) {
    final endpoint = _resolveEndpoint(config.host, config.port);
    return Uri(
      scheme: endpoint.scheme,
      host: endpoint.host,
      port: endpoint.port,
      path: _joinPath(endpoint.basePath, path),
      queryParameters:
          queryParameters == null || queryParameters.isEmpty ? null : queryParameters,
    );
  }

  Uri _wsUri(String path) {
    final endpoint = _resolveEndpoint(config.host, config.port);
    final wsScheme = endpoint.scheme == 'https' ? 'wss' : 'ws';
    return Uri(
      scheme: wsScheme,
      host: endpoint.host,
      port: endpoint.port,
      path: _joinPath(endpoint.basePath, path),
      queryParameters:
          config.token.isEmpty ? null : <String, String>{'token': config.token},
    );
  }

  Map<String, String> _authHeaders() {
    if (config.token.isEmpty) return const <String, String>{};
    return <String, String>{'X-Taco-Token': config.token};
  }

  Future<BridgeHttpResponse> _request({
    required String method,
    required String path,
    Map<String, String>? queryParameters,
    Map<String, String>? headers,
    Object? body,
  }) async {
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 5);
    try {
      final req = await client.openUrl(
        method,
        _uri(path, queryParameters: queryParameters),
      );
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
        if (cmd.threadId != null && cmd.threadId!.isNotEmpty)
          'threadId': cmd.threadId,
        if (cmd.sessionId != null && cmd.sessionId!.isNotEmpty)
          'sessionId': cmd.sessionId,
        if (cmd.provider != null && cmd.provider!.isNotEmpty)
          'provider': cmd.provider,
        if (cmd.mode != null &&
            (cmd.mode == 'chat' || cmd.mode == 'agent'))
          'mode': cmd.mode,
      },
    );
  }

  Future<BridgeHttpResponse> syncSelection({
    String? threadId,
    String? sessionId,
    String? provider,
    String? mode,
  }) {
    return _request(
      method: 'POST',
      path: '/select',
      headers: _authHeaders(),
      body: {
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
        if (provider != null && provider.isNotEmpty) 'provider': provider,
        if (mode == 'chat' || mode == 'agent') 'mode': mode,
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

  Future<BridgeHttpResponse> confirm({
    required String confirmId,
    required bool approved,
    String? threadId,
    String? sessionId,
  }) {
    return _request(
      method: 'POST',
      path: '/confirm',
      headers: _authHeaders(),
      body: {
        'confirmId': confirmId,
        'approved': approved,
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
      },
    );
  }

  Future<BridgeHttpResponse> createSession({String? threadId}) {
    return _request(
      method: 'POST',
      path: '/session/new',
      headers: _authHeaders(),
      body: {
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
      },
    );
  }

  Future<BridgeHttpResponse> clearSession({
    String? threadId,
    String? sessionId,
  }) {
    return _request(
      method: 'POST',
      path: '/session/clear',
      headers: _authHeaders(),
      body: {
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
      },
    );
  }

  Future<BridgeWorkspaceTreeResponse> workspaceTree({
    String? threadId,
    String? sessionId,
  }) async {
    final resp = await _request(
      method: 'GET',
      path: '/workspace/tree',
      queryParameters: {
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
      },
      headers: _authHeaders(),
    );
    if (resp.statusCode != 200) {
      throw Exception('读取目录结构失败: ${resp.statusCode}');
    }
    final decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception('读取目录结构失败: 响应格式错误');
    }
    return BridgeWorkspaceTreeResponse.fromJson(decoded);
  }

  Future<BridgeWorkspaceFileContent> readWorkspaceFile({
    required String path,
    String? threadId,
    String? sessionId,
  }) async {
    final resp = await _request(
      method: 'POST',
      path: '/workspace/file/read',
      headers: _authHeaders(),
      body: {
        'path': path,
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
      },
    );
    if (resp.statusCode != 200) {
      throw Exception('读取文件失败: ${resp.statusCode}');
    }
    final decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception('读取文件失败: 响应格式错误');
    }
    return BridgeWorkspaceFileContent.fromJson(decoded);
  }

  Future<BridgeHttpResponse> writeWorkspaceFile({
    required String path,
    required String content,
    String? threadId,
    String? sessionId,
  }) {
    return _request(
      method: 'POST',
      path: '/workspace/file/write',
      headers: _authHeaders(),
      body: {
        'path': path,
        'content': content,
        if (threadId != null && threadId.isNotEmpty) 'threadId': threadId,
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
      },
    );
  }

  String screenshotUrl(String screenshotPath) {
    final raw = screenshotPath.trim();
    if (raw.isEmpty) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    final uri = _uri(
      '/screenshot',
      queryParameters: <String, String>{
        'path': raw,
        if (config.token.isNotEmpty) 'token': config.token,
      },
    );
    return uri.toString();
  }
}

class _BridgeEndpoint {
  const _BridgeEndpoint({
    required this.scheme,
    required this.host,
    required this.port,
    required this.basePath,
  });

  final String scheme;
  final String host;
  final int? port;
  final String basePath;
}

_BridgeEndpoint _resolveEndpoint(String hostInput, int fallbackPort) {
  final raw = hostInput.trim().isEmpty ? '127.0.0.1' : hostInput.trim();
  final hasScheme = raw.contains('://');
  final candidate = hasScheme ? raw : 'http://$raw';
  final uri = Uri.parse(candidate);
  final host = uri.host.trim();
  if (host.isEmpty) {
    throw FormatException('无效连接地址: $hostInput');
  }

  int? port;
  if (uri.hasPort) {
    port = uri.port;
  } else if (!hasScheme) {
    port = fallbackPort;
  } else {
    port = null;
  }

  final normalizedPath = _normalizeBasePath(uri.path);
  return _BridgeEndpoint(
    scheme: uri.scheme.isEmpty ? 'http' : uri.scheme,
    host: host,
    port: port,
    basePath: normalizedPath,
  );
}

String _normalizeBasePath(String rawPath) {
  if (rawPath.isEmpty || rawPath == '/') return '';
  var path = rawPath.trim();
  if (!path.startsWith('/')) path = '/$path';
  while (path.endsWith('/') && path.length > 1) {
    path = path.substring(0, path.length - 1);
  }
  return path;
}

String _joinPath(String basePath, String requestPath) {
  var path = requestPath.trim();
  if (path.isEmpty) path = '/';
  if (!path.startsWith('/')) path = '/$path';
  if (basePath.isEmpty || basePath == '/') return path;
  return '$basePath$path';
}
