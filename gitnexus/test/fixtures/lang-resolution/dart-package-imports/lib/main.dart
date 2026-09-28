import 'package:app/models.dart';
import 'package:data/models.dart';
import 'package:http/http.dart' as http;
import 'package:app/tool/run.dart' as tool;
import 'dart:io';
import './relative.dart';

void main() {
  loadOwn();
  loadData();
  loadRelative();
}
