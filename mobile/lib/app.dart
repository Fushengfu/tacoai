import 'package:flutter/material.dart';

import 'pages/mobile_bridge_page.dart';

class MobileBridgeApp extends StatelessWidget {
  const MobileBridgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Taco Ai',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2E6EEB)),
        useMaterial3: true,
      ),
      home: const MobileBridgePage(),
    );
  }
}
