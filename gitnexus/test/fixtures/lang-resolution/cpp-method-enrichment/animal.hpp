class Animal {
public:
    virtual std::string speak() = 0;
    static std::string classify(const std::string& name);
    bool breathe();
};

class Dog : public Animal {
public:
    std::string speak() override;
};
