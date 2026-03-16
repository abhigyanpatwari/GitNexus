class User {
public:
    bool save() { return true; }
    void process() {
        this->save();
    }
};
