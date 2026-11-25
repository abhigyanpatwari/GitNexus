package single;
class Use { void go() { Api.run(value -> { value.save(); value.audit(); }); } }