import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;

import '../models/bridge_models.dart';
import '../services/bridge_client.dart';
import '../widgets/message_bubble.dart';
import 'bridge_settings_page.dart';
import 'mobile_workspace_page.dart';

class MobileBridgePage extends StatefulWidget {
  const MobileBridgePage({super.key});

  @override
  State<MobileBridgePage> createState() => _MobileBridgePageState();
}

class _MobileBridgePageState extends State<MobileBridgePage> {
  final TextEditingController _commandController = TextEditingController();
  final ScrollController _historyScrollController = ScrollController();
  final stt.SpeechToText _speech = stt.SpeechToText();

  BridgeConfig _config = const BridgeConfig(
    host: '192.168.1.100',
    port: 18400,
    token: 'taco-mobile',
  );

  bool _sendingQueue = false;
  bool _syncing = false;
  bool _stickToLatest = true;
  bool _speechReady = false;
  bool _listening = false;
  String _voiceBaseText = '';
  String? _speechLocaleId;
  String _status = '未连接';
  Timer? _syncTimer;
  WebSocket? _contextSocket;
  StreamSubscription<dynamic>? _contextSocketSub;
  bool _socketConnected = false;
  bool _socketConnecting = false;
  bool _drainingSocketContext = false;
  Map<String, dynamic>? _pendingSocketContext;

  DesktopBridgeContext? _context;
  String? _selectedThreadId;
  String? _selectedSessionId;
  String? _selectedProviderId;
  String? _selectedMode;
  List<QueuedMobileCommand> _outgoingQueue = const <QueuedMobileCommand>[];
  final Map<String, bool> _respondedConfirms = <String, bool>{};

  BridgeClient get _client => BridgeClient(config: _config);

  @override
  void initState() {
    super.initState();
    _syncTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (!_socketConnected) {
        unawaited(_fetchContext(silent: true));
      }
    });
    _historyScrollController.addListener(() {
      if (!_historyScrollController.hasClients) return;
      _stickToLatest = _historyScrollController.offset <= 80;
    });
    unawaited(_checkHealth(notify: false));
    unawaited(_connectContextSocket());
    unawaited(_initSpeech());
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    unawaited(_closeContextSocket());
    if (_speech.isListening) {
      unawaited(_speech.stop());
    }
    _commandController.dispose();
    _historyScrollController.dispose();
    super.dispose();
  }

  void _showNotice(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text(text), duration: const Duration(seconds: 2)),
      );
  }

  Future<void> _checkHealth({bool notify = true}) async {
    try {
      final resp = await _client.health();
      if (!mounted) return;
      if (resp.statusCode == 200) {
        setState(() {
          _status = _socketConnected ? '已连接(实时)' : '已连接';
        });
        if (notify) _showNotice('健康检查成功');
        await _fetchContext(silent: true);
        if (!_socketConnected) {
          unawaited(_connectContextSocket());
        }
      } else {
        setState(() {
          _status = '检查失败(${resp.statusCode})';
        });
        if (notify) _showNotice('健康检查失败: ${resp.statusCode}');
      }
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _status = '连接失败';
      });
      if (notify) _showNotice('连接失败: $err');
    }
  }

  Future<void> _closeContextSocket() async {
    await _contextSocketSub?.cancel();
    _contextSocketSub = null;
    if (_contextSocket != null) {
      try {
        await _contextSocket!.close();
      } catch (_) {
        // ignore close errors
      }
    }
    _contextSocket = null;
    _socketConnected = false;
    _socketConnecting = false;
  }

  void _scheduleSocketReconnect() {
    Future<void>.delayed(const Duration(seconds: 2), () {
      if (!mounted || _socketConnected || _socketConnecting) return;
      unawaited(_connectContextSocket());
    });
  }

  void _applyContext(DesktopBridgeContext nextContext) {
    if (!mounted) return;
    setState(() {
      _context = nextContext;
      _status = _socketConnected ? '已连接(实时)' : '已连接';
    });
    _reconcileSelection(nextContext);

    if (_stickToLatest && _currentSession()?.messages.isNotEmpty == true) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_historyScrollController.hasClients) {
          _historyScrollController.jumpTo(0);
        }
      });
    }
  }

  void _enqueueSocketContext(Map<String, dynamic> rawContext) {
    _pendingSocketContext = rawContext;
    if (_drainingSocketContext) return;
    _drainingSocketContext = true;
    Future<void>(() async {
      while (_pendingSocketContext != null) {
        final latest = _pendingSocketContext;
        _pendingSocketContext = null;
        if (latest == null) continue;
        _applyContext(DesktopBridgeContext.fromJson(latest));
        // 让出事件循环，避免大量上下文更新阻塞 UI。
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      _drainingSocketContext = false;
    });
  }

  Future<void> _connectContextSocket({bool forceReconnect = false}) async {
    if (_socketConnecting) return;
    if (forceReconnect) {
      await _closeContextSocket();
    }
    _socketConnecting = true;
    try {
      final socket = await _client.connectContextSocket();
      if (!mounted) {
        await socket.close();
        return;
      }
      _contextSocket = socket;
      _socketConnected = true;
      setState(() {
        _status = '已连接(实时)';
      });
      _contextSocketSub = socket.listen(
        (dynamic raw) {
          if (raw is! String || raw.isEmpty) return;
          try {
            final decoded = jsonDecode(raw);
            if (decoded is! Map<String, dynamic>) return;
            final type = decoded['type']?.toString() ?? '';
            if (type != 'context') return;
            final rawContext = decoded['context'];
            if (rawContext is! Map<String, dynamic>) return;
            _enqueueSocketContext(rawContext);
          } catch (_) {
            // ignore malformed payload
          }
        },
        onError: (_) {
          _socketConnected = false;
          if (mounted) {
            setState(() {
              _status = '已连接(轮询)';
            });
          }
          _scheduleSocketReconnect();
        },
        onDone: () {
          _socketConnected = false;
          if (mounted) {
            setState(() {
              _status = '已连接(轮询)';
            });
          }
          _scheduleSocketReconnect();
        },
        cancelOnError: true,
      );
    } catch (_) {
      _socketConnected = false;
      if (mounted) {
        setState(() {
          _status = '已连接(轮询)';
        });
      }
      _scheduleSocketReconnect();
    } finally {
      _socketConnecting = false;
    }
  }

  Future<void> _fetchContext({required bool silent}) async {
    if (_syncing) return;
    _syncing = true;
    try {
      final nextContext = await _client.context();
      _applyContext(nextContext);

      if (!silent) {
        _showNotice('已同步 ${nextContext.threads.length} 个项目');
      }
    } catch (err) {
      if (!silent) _showNotice('同步上下文异常: $err');
    } finally {
      _syncing = false;
    }
  }

  String? _pickSpeechLocale(List<stt.LocaleName> locales) {
    if (locales.isEmpty) return null;
    const preferred = <String>[
      'zh_CN',
      'zh-CN',
      'cmn-Hans-CN',
      'cmn-Hans',
      'zh',
      'en_US',
      'en-US',
    ];
    final index = <String, String>{};
    for (final locale in locales) {
      index[locale.localeId.toLowerCase()] = locale.localeId;
    }
    for (final id in preferred) {
      final found = index[id.toLowerCase()];
      if (found != null) return found;
    }
    return locales.first.localeId;
  }

  Future<void> _initSpeech() async {
    try {
      final available = await _speech.initialize(
        onStatus: (status) {
          if (!mounted) return;
          final normalized = status.toLowerCase();
          final listening = normalized == 'listening';
          if (_listening != listening) {
            setState(() {
              _listening = listening;
            });
          }
        },
        onError: (error) {
          if (!mounted) return;
          setState(() {
            _listening = false;
          });
          _showNotice('语音识别异常: ${error.errorMsg}');
        },
      );
      if (!mounted) return;
      if (!available) {
        setState(() {
          _speechReady = false;
          _listening = false;
          _speechLocaleId = null;
        });
        return;
      }
      final locales = await _speech.locales();
      if (!mounted) return;
      setState(() {
        _speechReady = true;
        _speechLocaleId = _pickSpeechLocale(locales);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _speechReady = false;
        _listening = false;
        _speechLocaleId = null;
      });
    }
  }

  Future<void> _startVoiceInput() async {
    if (_listening || _speech.isListening) {
      return;
    }
    if (!_speechReady) {
      await _initSpeech();
      if (!_speechReady) {
        _showNotice('当前设备不支持语音输入');
        return;
      }
    }

    _voiceBaseText = _commandController.text.trim();
    try {
      await _speech.listen(
        localeId: _speechLocaleId,
        listenOptions: stt.SpeechListenOptions(
          listenMode: stt.ListenMode.dictation,
          partialResults: true,
          cancelOnError: true,
        ),
        onResult: (result) {
          final words = result.recognizedWords.trim();
          final suffix = words.isEmpty
              ? ''
              : (_voiceBaseText.isEmpty ? words : ' $words');
          final next = '${_voiceBaseText.trim()}$suffix'.trim();
          _commandController.value = _commandController.value.copyWith(
            text: next,
            selection: TextSelection.collapsed(offset: next.length),
            composing: TextRange.empty,
          );
        },
      );
      if (!mounted) return;
      setState(() {
        _listening = _speech.isListening;
      });
      if (!_speech.isListening) {
        _showNotice('语音识别启动失败');
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _listening = false;
      });
      _showNotice('语音识别启动失败');
    }
  }

  Future<void> _stopVoiceInput() async {
    if (!(_listening || _speech.isListening)) {
      return;
    }
    await _speech.stop();
    if (!mounted) return;
    setState(() {
      _listening = false;
    });
  }

  Future<void> _openSettingsPage() async {
    final next = await Navigator.of(context).push<BridgeConfig>(
      MaterialPageRoute(
        builder: (_) => BridgeSettingsPage(initialConfig: _config),
      ),
    );
    if (next == null || next == _config) return;
    setState(() {
      _config = next;
      _status = '配置已更新';
    });
    _showNotice('连接配置已更新');
    await _connectContextSocket(forceReconnect: true);
    await _checkHealth(notify: false);
  }

  Future<void> _openWorkspacePage() async {
    final thread = _currentThread();
    if (thread == null) {
      _showNotice('请先选择项目');
      return;
    }
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => MobileWorkspacePage(
          config: _config,
          threadId: thread.threadId,
          sessionId: _selectedSessionId,
          threadTitle: thread.title,
        ),
      ),
    );
  }

  List<DesktopBridgeProvider> _providerOptions() {
    final context = _context;
    if (context == null) return const <DesktopBridgeProvider>[];
    if (context.providers.isNotEmpty) return context.providers;
    final map = <String, DesktopBridgeProvider>{};
    for (final t in context.threads) {
      if (t.provider.isEmpty) continue;
      map[t.provider] = DesktopBridgeProvider(
        id: t.provider,
        label: t.provider,
      );
    }
    return map.values.toList();
  }

  String _resolveProviderLabel(String? providerId) {
    final id = providerId?.trim() ?? '';
    if (id.isEmpty) return '-';
    for (final option in _providerOptions()) {
      if (option.id == id) return option.label;
    }
    return id;
  }

  String _buildScreenshotUrl(String screenshotPath) {
    return _client.screenshotUrl(screenshotPath);
  }

  List<String> _extractScreenshotUrls(DesktopBridgeMessage msg) {
    final paths = <String>{...msg.screenshotPaths};
    for (final step in msg.agentSteps) {
      for (final result in step.toolResults) {
        final text = result.content;
        if (text.isEmpty) continue;
        try {
          final decoded = jsonDecode(text);
          if (decoded is Map<String, dynamic>) {
            final single = decoded['screenshotPath']?.toString() ?? '';
            if (single.isNotEmpty) paths.add(single);
            final multiple = decoded['screenshotPaths'];
            if (multiple is List) {
              for (final item in multiple) {
                final p = item.toString();
                if (p.isNotEmpty) paths.add(p);
              }
            }
          }
        } catch (_) {
          final regex = RegExp(r'"screenshotPath"\s*:\s*"([^"]+)"');
          for (final m in regex.allMatches(text)) {
            final p = m.group(1) ?? '';
            if (p.isNotEmpty) paths.add(p);
          }
        }
      }
    }
    return paths
        .map(_buildScreenshotUrl)
        .where((url) => url.isNotEmpty)
        .toList();
  }

  Future<void> _openImagePreview(String imageUrl) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: true,
      builder: (ctx) => Dialog(
        insetPadding: const EdgeInsets.all(12),
        backgroundColor: Colors.black.withValues(alpha: 0.9),
        child: Stack(
          children: [
            Positioned.fill(
              child: InteractiveViewer(
                minScale: 0.8,
                maxScale: 4.0,
                child: Center(
                  child: Image.network(imageUrl, fit: BoxFit.contain),
                ),
              ),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.of(ctx).pop(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _syncSelectionToDesktop({
    String? threadId,
    String? sessionId,
    String? provider,
    String? mode,
  }) async {
    if (threadId == null &&
        sessionId == null &&
        provider == null &&
        mode == null) {
      return;
    }
    try {
      await _client.syncSelection(
        threadId: threadId,
        sessionId: sessionId,
        provider: provider,
        mode: mode,
      );
      Future<void>.delayed(const Duration(milliseconds: 180), () {
        if (!mounted) return;
        unawaited(_fetchContext(silent: true));
      });
    } catch (_) {
      // ignore silent selection sync failures
    }
  }

  void _reconcileSelection(DesktopBridgeContext context) {
    final threadIds = context.threads.map((t) => t.threadId).toSet();
    final fallbackThreadId =
        context.activeThreadId ??
        (context.threads.isNotEmpty ? context.threads.first.threadId : null);
    final selectedThreadId = threadIds.contains(_selectedThreadId)
        ? _selectedThreadId
        : fallbackThreadId;

    DesktopBridgeThread? selectedThread;
    if (selectedThreadId != null) {
      for (final t in context.threads) {
        if (t.threadId == selectedThreadId) {
          selectedThread = t;
          break;
        }
      }
    }

    String? selectedSessionId;
    String? selectedProviderId = _selectedProviderId;
    String? selectedMode = _selectedMode;
    if (selectedThread != null) {
      final sessionIds = selectedThread.sessions
          .map((s) => s.sessionId)
          .toSet();
      final fallbackSessionId = selectedThread.activeSessionId.isNotEmpty
          ? selectedThread.activeSessionId
          : (selectedThread.sessions.isNotEmpty
                ? selectedThread.sessions.first.sessionId
                : null);
      selectedSessionId = sessionIds.contains(_selectedSessionId)
          ? _selectedSessionId
          : fallbackSessionId;

      if ((selectedProviderId ?? '').isEmpty) {
        selectedProviderId = selectedThread.provider.isNotEmpty
            ? selectedThread.provider
            : context.activeProvider;
      }
      if (selectedThread.mode == 'chat' || selectedThread.mode == 'agent') {
        selectedMode = selectedThread.mode;
      }
    }

    final providerIds = context.providers.isNotEmpty
        ? context.providers.map((p) => p.id).toSet()
        : context.threads
              .where((t) => t.provider.isNotEmpty)
              .map((t) => t.provider)
              .toSet();
    if (selectedProviderId != null &&
        !providerIds.contains(selectedProviderId)) {
      selectedProviderId = providerIds.isNotEmpty ? providerIds.first : null;
    }

    setState(() {
      _selectedThreadId = selectedThreadId;
      _selectedSessionId = selectedSessionId;
      _selectedProviderId = selectedProviderId;
      _selectedMode = selectedMode;
    });
  }

  Future<void> _enqueueCommand() async {
    await _stopVoiceInput();

    final text = _commandController.text.trim();
    if (text.isEmpty) {
      _showNotice('请输入指令');
      return;
    }

    final cmd = QueuedMobileCommand(
      id: 'm-${DateTime.now().millisecondsSinceEpoch}-${_outgoingQueue.length}',
      text: text,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      threadId: _selectedThreadId,
      sessionId: _selectedSessionId,
      provider: _selectedProviderId,
      mode: _selectedMode,
    );

    setState(() {
      _outgoingQueue = [..._outgoingQueue, cmd];
    });
    _commandController.clear();
    unawaited(_drainOutgoingQueue());
  }

  Future<void> _drainOutgoingQueue() async {
    if (_sendingQueue) return;
    _sendingQueue = true;
    while (_outgoingQueue.isNotEmpty) {
      final current = _outgoingQueue.first;
      try {
        final resp = await _client.sendCommand(current);
        if (resp.statusCode == 200) {
          if (!mounted) break;
          setState(() {
            _outgoingQueue = _outgoingQueue.sublist(1);
          });
          continue;
        }
        _showNotice('发送失败: ${resp.statusCode}');
        break;
      } catch (err) {
        _showNotice('发送异常: $err');
        break;
      }
    }
    _sendingQueue = false;
    await _fetchContext(silent: true);
  }

  void _removeFromOutgoingQueue(String id) {
    setState(() {
      _outgoingQueue = _outgoingQueue.where((q) => q.id != id).toList();
    });
  }

  Future<void> _abortTask() async {
    final session = _currentSession();
    if (session == null) {
      _showNotice('请先选择会话');
      return;
    }
    try {
      final resp = await _client.abort(
        threadId: _selectedThreadId,
        sessionId: session.sessionId,
      );
      if (resp.statusCode == 200) {
        _showNotice('已发送停止请求');
        await Future<void>.delayed(const Duration(milliseconds: 300));
        await _fetchContext(silent: true);
      } else {
        _showNotice('停止失败: ${resp.statusCode}');
      }
    } catch (err) {
      _showNotice('停止异常: $err');
    }
  }

  Future<void> _createSession() async {
    final thread = _currentThread();
    if (thread == null) {
      _showNotice('请先选择项目');
      return;
    }
    try {
      final resp = await _client.createSession(threadId: thread.threadId);
      if (resp.statusCode == 200) {
        _showNotice('已请求新建会话');
        await Future<void>.delayed(const Duration(milliseconds: 250));
        await _fetchContext(silent: true);
      } else {
        _showNotice('新建会话失败: ${resp.statusCode}');
      }
    } catch (err) {
      _showNotice('新建会话异常: $err');
    }
  }

  Future<void> _clearCurrentSession() async {
    final thread = _currentThread();
    final session = _currentSession();
    if (thread == null || session == null) {
      _showNotice('请先选择会话');
      return;
    }
    try {
      final resp = await _client.clearSession(
        threadId: thread.threadId,
        sessionId: session.sessionId,
      );
      if (resp.statusCode == 200) {
        _showNotice('已清空会话记录');
        await Future<void>.delayed(const Duration(milliseconds: 200));
        await _fetchContext(silent: true);
      } else {
        _showNotice('清空失败: ${resp.statusCode}');
      }
    } catch (err) {
      _showNotice('清空异常: $err');
    }
  }

  Future<void> _confirmStep(String confirmId, bool approved) async {
    final session = _currentSession();
    if (session == null) {
      _showNotice('请先选择会话');
      return;
    }
    setState(() {
      _respondedConfirms[confirmId] = approved;
    });
    try {
      final resp = await _client.confirm(
        confirmId: confirmId,
        approved: approved,
        threadId: _selectedThreadId,
        sessionId: session.sessionId,
      );
      if (resp.statusCode == 200) {
        _showNotice(approved ? '已确认执行' : '已要求调整');
        await Future<void>.delayed(const Duration(milliseconds: 250));
        await _fetchContext(silent: true);
      } else {
        setState(() {
          _respondedConfirms.remove(confirmId);
        });
        _showNotice('确认失败: ${resp.statusCode}');
      }
    } catch (err) {
      setState(() {
        _respondedConfirms.remove(confirmId);
      });
      _showNotice('确认异常: $err');
    }
  }

  DesktopBridgeThread? _currentThread() {
    final context = _context;
    final id = _selectedThreadId;
    if (context == null || id == null) return null;
    for (final thread in context.threads) {
      if (thread.threadId == id) return thread;
    }
    return null;
  }

  DesktopBridgeSession? _currentSession() {
    final thread = _currentThread();
    final id = _selectedSessionId;
    if (thread == null || id == null) return null;
    for (final session in thread.sessions) {
      if (session.sessionId == id) return session;
    }
    return null;
  }

  PopupMenuButton<String> _buildThreadMenu() {
    final bridgeContext = _context;

    return PopupMenuButton<String>(
      tooltip: '选择项目',
      onSelected: (value) {
        if (bridgeContext == null) return;
        DesktopBridgeThread? selected;
        for (final t in bridgeContext.threads) {
          if (t.threadId == value) {
            selected = t;
            break;
          }
        }
        final nextProvider = (selected?.provider ?? '').isNotEmpty
            ? selected!.provider
            : _selectedProviderId;
        final nextMode = (selected?.mode ?? '').isNotEmpty
            ? selected!.mode
            : _selectedMode;
        setState(() {
          _selectedThreadId = value;
          _selectedSessionId = selected?.activeSessionId;
          _selectedProviderId = nextProvider;
          _selectedMode = nextMode == 'chat' || nextMode == 'agent'
              ? nextMode
              : _selectedMode;
        });
        unawaited(
          _syncSelectionToDesktop(
            threadId: value,
            sessionId: selected?.activeSessionId,
            provider: nextProvider,
            mode: nextMode,
          ),
        );
      },
      itemBuilder: (ctx) {
        final threads = bridgeContext?.threads ?? <DesktopBridgeThread>[];
        if (threads.isEmpty) {
          return [
            const PopupMenuItem<String>(
              enabled: false,
              value: '__empty__',
              child: Text('暂无项目'),
            ),
          ];
        }
        return threads
            .map(
              (t) => PopupMenuItem<String>(
                value: t.threadId,
                child: Text(t.title),
              ),
            )
            .toList();
      },
      child: _MenuIcon(
        icon: Icons.folder_outlined,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
    );
  }

  PopupMenuButton<String> _buildSessionMenu() {
    final currentThread = _currentThread();
    const actionNew = '__action_new_session__';
    const actionClear = '__action_clear_session__';

    return PopupMenuButton<String>(
      tooltip: '选择会话',
      onSelected: (value) {
        if (value == actionNew) {
          unawaited(_createSession());
          return;
        }
        if (value == actionClear) {
          unawaited(_clearCurrentSession());
          return;
        }
        setState(() {
          _selectedSessionId = value;
        });
        unawaited(
          _syncSelectionToDesktop(
            threadId: _selectedThreadId,
            sessionId: value,
            provider: _selectedProviderId,
            mode: _selectedMode,
          ),
        );
      },
      itemBuilder: (ctx) {
        final sessions = currentThread?.sessions ?? <DesktopBridgeSession>[];
        if (sessions.isEmpty) {
          return [
            const PopupMenuItem<String>(value: actionNew, child: Text('新建会话')),
            const PopupMenuItem<String>(
              value: actionClear,
              child: Text('清空当前会话'),
            ),
            const PopupMenuDivider(),
            const PopupMenuItem<String>(
              enabled: false,
              value: '__empty__',
              child: Text('暂无会话'),
            ),
          ];
        }
        return [
          const PopupMenuItem<String>(value: actionNew, child: Text('新建会话')),
          PopupMenuItem<String>(
            value: actionClear,
            enabled: sessions.isNotEmpty,
            child: const Text('清空当前会话'),
          ),
          const PopupMenuDivider(),
          ...sessions.map(
            (s) =>
                PopupMenuItem<String>(value: s.sessionId, child: Text(s.title)),
          ),
        ];
      },
      child: _MenuIcon(
        icon: Icons.forum_outlined,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
    );
  }

  PopupMenuButton<String> _buildProviderMenu() {
    final options = _providerOptions();

    return PopupMenuButton<String>(
      tooltip: '选择模型',
      onSelected: (value) {
        setState(() {
          _selectedProviderId = value;
        });
        unawaited(
          _syncSelectionToDesktop(
            threadId: _selectedThreadId,
            sessionId: _selectedSessionId,
            provider: value,
            mode: _selectedMode,
          ),
        );
      },
      itemBuilder: (ctx) {
        if (options.isEmpty) {
          return [
            const PopupMenuItem<String>(
              enabled: false,
              value: '__empty__',
              child: Text('无可用模型'),
            ),
          ];
        }
        return options
            .map(
              (p) => PopupMenuItem<String>(value: p.id, child: Text(p.label)),
            )
            .toList();
      },
      child: _MenuIcon(
        icon: Icons.smart_toy_outlined,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
    );
  }

  PopupMenuButton<String> _buildModeMenu() {
    return PopupMenuButton<String>(
      tooltip: '选择模式',
      onSelected: (value) {
        if (value != 'chat' && value != 'agent') return;
        setState(() {
          _selectedMode = value;
        });
        unawaited(
          _syncSelectionToDesktop(
            threadId: _selectedThreadId,
            sessionId: _selectedSessionId,
            provider: _selectedProviderId,
            mode: value,
          ),
        );
      },
      itemBuilder: (ctx) => [
        const PopupMenuItem<String>(value: 'chat', child: Text('聊天模式')),
        const PopupMenuItem<String>(value: 'agent', child: Text('代理模式')),
      ],
      child: _MenuIcon(
        icon: _selectedMode == 'agent'
            ? Icons.auto_awesome
            : Icons.chat_bubble_outline,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
    );
  }

  Widget _buildHistoryPane() {
    final currentSession = _currentSession();
    if (_context == null) {
      return const Center(child: Text('请先打开右上角设置，配置连接后同步上下文'));
    }
    if ((_context?.threads.length ?? 0) == 0) {
      return const Center(child: Text('桌面端暂无会话历史'));
    }
    if (currentSession == null) {
      return const Center(child: Text('请选择项目和会话'));
    }

    final messages = currentSession.messages;
    if (currentSession.detailLevel == 'meta' && currentSession.messageCount > 0) {
      return const Center(child: Text('会话内容同步中，请稍候...'));
    }
    return RefreshIndicator(
      onRefresh: () => _fetchContext(silent: true),
      child: ListView.builder(
        controller: _historyScrollController,
        reverse: true,
        addRepaintBoundaries: true,
        itemCount:
            messages.length +
            (currentSession.streamingContent.isNotEmpty ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == 0 && currentSession.streamingContent.isNotEmpty) {
            return RepaintBoundary(
              key: const ValueKey('streaming-bubble'),
              child: MessageBubble(
                role: 'assistant',
                content: currentSession.streamingContent,
                streaming: true,
              ),
            );
          }
          final offset = currentSession.streamingContent.isNotEmpty ? 1 : 0;
          final msg = messages[messages.length - 1 - (index - offset)];
          final screenshotUrls = _extractScreenshotUrls(msg);
          return RepaintBoundary(
            key: ValueKey('msg-${msg.id}'),
            child: MessageBubble(
              role: msg.role,
              content: msg.content,
              agentSteps: msg.agentSteps,
              activePlan: msg.activePlan,
              screenshotUrls: screenshotUrls,
              onOpenImage: (url) => unawaited(_openImagePreview(url)),
              onConfirmStep: (confirmId, approved) =>
                  _confirmStep(confirmId, approved),
              confirmStates: _respondedConfirms,
            ),
          );
        },
      ),
    );
  }

  Widget _buildOutgoingQueueBar() {
    if (_outgoingQueue.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      color: Theme.of(
        context,
      ).colorScheme.tertiaryContainer.withValues(alpha: 0.7),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            Text(
              '移动端待发 ${_outgoingQueue.length} 条',
              style: const TextStyle(fontSize: 12),
            ),
            const SizedBox(width: 8),
            ..._outgoingQueue.map(
              (q) => Padding(
                padding: const EdgeInsets.only(right: 6),
                child: InputChip(
                  label: SizedBox(
                    width: 120,
                    child: Text(
                      q.text,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11),
                    ),
                  ),
                  onDeleted: () => _removeFromOutgoingQueue(q.id),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final currentThread = _currentThread();
    final currentSession = _currentSession();
    final queueCount = currentSession?.queue.length ?? 0;
    final canAbort = currentSession?.sending ?? false;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Taco Mobile Bridge'),
        actions: [
          _buildThreadMenu(),
          const SizedBox(width: 6),
          _buildSessionMenu(),
          const SizedBox(width: 6),
          _buildProviderMenu(),
          const SizedBox(width: 6),
          _buildModeMenu(),
          IconButton(
            tooltip: '同步上下文',
            onPressed: _syncing
                ? null
                : () => unawaited(_fetchContext(silent: false)),
            icon: const Icon(Icons.sync),
          ),
          IconButton(
            tooltip: '连接配置',
            onPressed: _openSettingsPage,
            icon: const Icon(Icons.settings),
          ),
          IconButton(
            tooltip: '代码工作区',
            onPressed: _openWorkspacePage,
            icon: const Icon(Icons.code),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              color: Theme.of(context).colorScheme.surfaceContainer,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '桌面会话历史 | 状态: $_status',
                    style: const TextStyle(fontSize: 12),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '项目: ${currentThread?.title ?? "-"} | 会话: ${currentSession?.title ?? "-"} | 模型: ${_resolveProviderLabel(_selectedProviderId ?? currentThread?.provider)} | 模式: ${_selectedMode == "agent" ? "代理" : "聊天"}',
                    style: const TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
            Expanded(child: _buildHistoryPane()),
            if (queueCount > 0)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                child: Text(
                  '桌面端会话队列: $queueCount 条',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            _buildOutgoingQueueBar(),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                border: Border(
                  top: BorderSide(
                    color: Theme.of(context).colorScheme.outlineVariant,
                  ),
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _commandController,
                      minLines: 1,
                      maxLines: 4,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => unawaited(_enqueueCommand()),
                      decoration: const InputDecoration(
                        hintText: '输入指令，发送到桌面端执行...',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Tooltip(
                    message: _listening ? '松开结束语音输入' : '长按说话',
                    child: GestureDetector(
                      onTap: _sendingQueue
                          ? null
                          : () => _showNotice('请长按麦克风说话，松开结束'),
                      onLongPressStart: _sendingQueue
                          ? null
                          : (_) => unawaited(_startVoiceInput()),
                      onLongPressEnd: _sendingQueue
                          ? null
                          : (_) => unawaited(_stopVoiceInput()),
                      onLongPressCancel: _sendingQueue
                          ? null
                          : () => unawaited(_stopVoiceInput()),
                      child: Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: _listening
                              ? Theme.of(context).colorScheme.errorContainer
                              : Theme.of(context).colorScheme.primaryContainer,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        alignment: Alignment.center,
                        child: Icon(
                          _listening ? Icons.keyboard_voice : Icons.mic,
                          color: _listening
                              ? Theme.of(context).colorScheme.onErrorContainer
                              : Theme.of(
                                  context,
                                ).colorScheme.onPrimaryContainer,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (canAbort)
                    FilledButton.tonal(
                      onPressed: () => unawaited(_abortTask()),
                      child: const Text('停止'),
                    )
                  else
                    FilledButton(
                      onPressed: _sendingQueue
                          ? null
                          : () => unawaited(_enqueueCommand()),
                      child: Text(_sendingQueue ? '排队发送' : '发送'),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MenuIcon extends StatelessWidget {
  const _MenuIcon({required this.icon, required this.color});

  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: Icon(icon, size: 18),
    );
  }
}
