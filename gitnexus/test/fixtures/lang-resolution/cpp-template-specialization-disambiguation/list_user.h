#pragma once

struct User {};

template <typename T>
class List;

template <>
class List<User> {
public:
  void callSave() { save(); }
  void save() { persistUser(); }
  void persistUser() {}
};
