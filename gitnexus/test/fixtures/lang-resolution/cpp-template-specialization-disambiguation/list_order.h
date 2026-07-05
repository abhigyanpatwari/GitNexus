#pragma once

struct Order {};

template <typename T>
class List;

template <>
class List<Order> {
public:
  void callSave() { save(); }
  void save() { persistOrder(); }
  void persistOrder() {}
};
