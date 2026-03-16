#include <string>

class UserManager {
public:
    void addUser(const std::string& name) {
        users_.push_back(name);
    }

    int getCount() const {
        return static_cast<int>(users_.size());
    }

private:
    std::vector<std::string> users_;
};

int helperFunction(int x) {
    return x * 2;
}
