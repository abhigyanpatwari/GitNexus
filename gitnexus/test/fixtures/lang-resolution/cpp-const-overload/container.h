#pragma once

class Container {
public:
    int* begin() {
        return data_;
    }

    const int* begin() const {
        return data_;
    }

    int* end() {
        return data_ + size_;
    }

    const int* end() const {
        return data_ + size_;
    }

    int size() const {
        return size_;
    }

    void callNonConst() {
        begin();
    }

    void callConst() const {
        begin();
    }

private:
    int data_[10];
    int size_ = 0;
};
