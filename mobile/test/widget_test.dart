// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'dart:ui' show Size;

import 'package:flutter_test/flutter_test.dart';

import 'package:mobile/main.dart';

void main() {
  testWidgets('renders mobile bridge screen', (WidgetTester tester) async {
    await tester.pumpWidget(const MobileBridgeApp());
    expect(find.text('Taco Mobile Bridge'), findsOneWidget);
    expect(find.text('发送'), findsOneWidget);
    expect(find.text('停止'), findsNothing);
  });

  testWidgets('no overflow on narrow screen', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(const MobileBridgeApp());
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.takeException(), isNull);
  });
}
